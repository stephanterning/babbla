// NoiseExpander — the pure DSP core of "Brusreducering".
//
// A soft *downward expander*: while the signal sits near the noise floor (you're
// not speaking) it pulls the gain down by a bounded amount; while you're talking
// (signal above an adaptive threshold) it passes audio at unity. It NEVER gates
// to true silence — the deepest attenuation is `rangeGain` — so room tone stays
// present and the "alla pratar samtidigt" feel survives. See docs/noise-reduction.md.
//
// This module is intentionally free of any Web Audio / DOM / worklet globals: it
// is plain math over Float32 sample blocks. The AudioWorklet processor imports it
// (browser, real-time thread) and so do the Node unit tests (deterministic, fast).
// Keeping the algorithm here — not in the worklet shell — is what makes the DSP
// testable without a browser (mirrors room-name.js / stage.js).
//
// Key design points (all decided in the grilling session):
//   - Envelope-only detection (no separate VAD): a fast-attack / slow-release
//     follower of |x|. A sharp keyboard transient can briefly open the gate; that
//     is accepted (steady noise + between-words is the target, not click removal).
//   - Adaptive, floor-tracking threshold: a slow minimum-follower estimates the
//     noise floor and the open threshold rides a fixed ratio above it. This makes
//     it work per-mic/room AND defeats Chrome's AGC (which raises the floor while
//     you're quiet) — the threshold rises with the floor instead of being a fixed
//     dBFS line the AGC walks past.
//   - Cold-start = pass-through: until the floor estimate has warmed up we apply
//     unity gain, so the first words after joining are never clipped.
//   - Mute freezes the floor: while muted the source is silent (track.enabled =
//     false), so we must NOT let the floor estimate collapse toward zero; it is
//     held and resumes on unmute.

// Per-level tuning. `lite` (default) is fail-open: shallow attenuation, threshold
// close to the floor, never clip a speaker. `full` is mildly fail-closed: deeper
// attenuation and a higher threshold for users who explicitly want more quiet and
// accept that the very softest speech may occasionally be clipped. All are start
// values — tune against real media (the mätsticka), not synthetic tests.
export const NOISE_LEVELS = {
  off: { bypass: true },
  lite: {
    thresholdMult: 2.0, // open threshold ~+6 dB over the tracked floor
    ratio: 2.0,
    rangeGain: 0.3, // ~-10.5 dB max attenuation (never silence)
    gainAttackMs: 5, // open fast (don't clip onsets)
    gainReleaseMs: 200, // close slow (no pumping)
  },
  full: {
    thresholdMult: 3.0, // ~+9.5 dB over the floor
    ratio: 4.0,
    rangeGain: 0.08, // ~-22 dB max attenuation (still not silence)
    gainAttackMs: 5,
    gainReleaseMs: 200,
  },
};

const DEFAULT_LEVEL = "lite";

// Envelope + floor smoothing time constants (ms). The envelope follows the
// signal (fast up, medium down). The floor tracks the *minimum* envelope: down
// quickly to catch quiet gaps, up slowly so speech can't drag it up fast.
const ENV_ATTACK_MS = 1;
const ENV_RELEASE_MS = 50;
const FLOOR_DOWN_MS = 120;
const FLOOR_UP_MS = 1200;
const WARMUP_MS = 250; // pass-through until the floor estimate settles
const MIN_THRESHOLD = 1e-4; // absolute floor for the threshold (avoid 0)

// One-pole smoothing coefficient for a given time constant at a sample rate.
function coef(ms, sampleRate) {
  const n = Math.max(1, (ms / 1000) * sampleRate);
  return 1 - Math.exp(-1 / n);
}

export class NoiseExpander {
  /**
   * @param {number} sampleRate
   * @param {"off"|"lite"|"full"} [level]
   */
  constructor(sampleRate, level = DEFAULT_LEVEL) {
    this.sr = sampleRate > 0 ? sampleRate : 48000;
    this.envAtk = coef(ENV_ATTACK_MS, this.sr);
    this.envRel = coef(ENV_RELEASE_MS, this.sr);
    this.floorDown = coef(FLOOR_DOWN_MS, this.sr);
    this.floorUp = coef(FLOOR_UP_MS, this.sr);
    this.warmupSamples = Math.round((WARMUP_MS / 1000) * this.sr);

    // Live state.
    this.env = 0;
    this.floor = 0;
    this.floorInit = false;
    this.gain = 1;
    this.warmed = 0;
    this.muted = false;
    /** @type {Float32Array | null} Per-sample gains of the last block (for >1 ch). */
    this.gains = null;

    this.setLevel(level);
  }

  setLevel(level) {
    const params = NOISE_LEVELS[level] || NOISE_LEVELS[DEFAULT_LEVEL];
    this.level = NOISE_LEVELS[level] ? level : DEFAULT_LEVEL;
    this.bypass = !!params.bypass;
    if (!this.bypass) {
      this.thresholdMult = params.thresholdMult;
      this.ratio = params.ratio;
      this.rangeGain = params.rangeGain;
      this.rangeDb = 20 * Math.log10(params.rangeGain);
      this.gainAtk = coef(params.gainAttackMs, this.sr);
      this.gainRel = coef(params.gainReleaseMs, this.sr);
    }
  }

  // While muted the source is silent; freezing prevents the floor estimate from
  // collapsing toward zero (which would make the gate over-aggressive on unmute).
  setMuted(muted) {
    this.muted = !!muted;
  }

  get floorEstimate() {
    return this.floor;
  }

  get currentGain() {
    return this.gain;
  }

  // Compute the smoothed gain for one sample, advancing envelope + floor state.
  // Returns the gain to apply (callers multiply the sample). Kept as a method so
  // the worklet can drive multiple channels off channel 0's gain.
  _stepGain(x) {
    const a = x < 0 ? -x : x;
    // Envelope follower (fast up, slower down).
    this.env += (a - this.env) * (a > this.env ? this.envAtk : this.envRel);

    // Floor tracker — minimum-follower, only while live (frozen when muted).
    if (!this.muted) {
      if (!this.floorInit) {
        this.floor = this.env;
        this.floorInit = true;
      } else {
        this.floor +=
          (this.env - this.floor) *
          (this.env < this.floor ? this.floorDown : this.floorUp);
      }
    }
    if (this.warmed < this.warmupSamples) this.warmed++;

    let target;
    if (this.bypass || this.warmed < this.warmupSamples) {
      target = 1;
    } else {
      const thresh = Math.max(this.floor * this.thresholdMult, MIN_THRESHOLD);
      if (this.env >= thresh) {
        target = 1;
      } else {
        const envDb = 20 * Math.log10(Math.max(this.env, 1e-9));
        const threshDb = 20 * Math.log10(thresh);
        let gainDb = (envDb - threshDb) * (this.ratio - 1);
        if (gainDb < this.rangeDb) gainDb = this.rangeDb;
        target = Math.pow(10, gainDb / 20);
      }
    }

    this.gain += (target - this.gain) * (target > this.gain ? this.gainAtk : this.gainRel);
    return this.gain;
  }

  // Process one channel block in place into `output`, recording per-sample gains
  // so the worklet can apply the same gain to any additional channels.
  processInto(input, output) {
    const n = input.length;
    if (!this.gains || this.gains.length < n) this.gains = new Float32Array(n);
    if (this.bypass) {
      // Pure pass-through. Switching back to lite/full re-warms over WARMUP_MS
      // (during which we also pass through), so a cold restart is unnoticeable.
      for (let i = 0; i < n; i++) {
        this.gains[i] = 1;
        output[i] = input[i];
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      const g = this._stepGain(input[i]);
      this.gains[i] = g;
      output[i] = input[i] * g;
    }
  }
}
