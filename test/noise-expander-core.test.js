// Tier-1 unit tests for the pure noise-expander DSP core (docs/noise-reduction.md).
// Deterministic, no browser: feed constant-amplitude sample blocks and assert the
// gain / floor behavior. Constant amplitude makes the envelope settle to a known
// value so the gain is predictable.

import test from "node:test";
import assert from "node:assert/strict";

import { NoiseExpander, NOISE_LEVELS } from "../public/js/noise-expander-core.js";

const SR = 48000;
const BLOCK = 128;

// Feed `seconds` of a constant |amplitude| signal through the expander.
function feed(exp, amp, seconds) {
  const input = new Float32Array(BLOCK).fill(amp);
  const output = new Float32Array(BLOCK);
  const total = Math.round(seconds * SR);
  for (let done = 0; done < total; done += BLOCK) exp.processInto(input, output);
}

test("off: pure pass-through (gain 1, no attenuation)", () => {
  const exp = new NoiseExpander(SR, "off");
  feed(exp, 0.01, 2);
  assert.ok(exp.currentGain > 0.999, `gain ${exp.currentGain} should stay ~1`);
});

test("lite: steady near-floor signal is attenuated (but never silenced)", () => {
  const exp = new NoiseExpander(SR, "lite");
  feed(exp, 0.01, 2);
  // A steady signal sits at its own floor -> a few dB below threshold -> reduced.
  assert.ok(exp.currentGain < 0.8, `lite gain ${exp.currentGain} should attenuate`);
  // Never to true silence: the deepest attenuation is rangeGain.
  assert.ok(
    exp.currentGain >= NOISE_LEVELS.lite.rangeGain - 1e-3,
    `lite gain ${exp.currentGain} must not go below rangeGain`,
  );
});

test("full attenuates more aggressively than lite at the same input", () => {
  const lite = new NoiseExpander(SR, "lite");
  const full = new NoiseExpander(SR, "full");
  feed(lite, 0.01, 2);
  feed(full, 0.01, 2);
  assert.ok(
    full.currentGain < lite.currentGain,
    `full ${full.currentGain} should attenuate more than lite ${lite.currentGain}`,
  );
});

test("loud speech above the learned floor passes at ~unity", () => {
  const exp = new NoiseExpander(SR, "lite");
  feed(exp, 0.004, 1.5); // quiet gap -> floor learns low
  feed(exp, 0.3, 0.3); // a loud burst well above threshold
  assert.ok(exp.currentGain > 0.95, `gain ${exp.currentGain} should open for speech`);
});

test("cold-start is pass-through (first words after join aren't clipped)", () => {
  const exp = new NoiseExpander(SR, "lite");
  // Less than WARMUP_MS (250ms) of quiet audio: still unity.
  feed(exp, 0.005, 0.1);
  assert.ok(exp.currentGain > 0.95, `warmup gain ${exp.currentGain} should be ~1`);
});

test("floor tracker rides a rising floor (defeats AGC) and keeps noise attenuated", () => {
  const exp = new NoiseExpander(SR, "lite");
  feed(exp, 0.01, 2); // settle on a low floor
  const floorLow = exp.floorEstimate;
  feed(exp, 0.05, 5); // AGC raises the noise floor 5x; give the slow tracker time
  // The floor followed the input up...
  assert.ok(
    exp.floorEstimate > floorLow * 2,
    `floor ${exp.floorEstimate} should rise from ${floorLow}`,
  );
  // ...so the raised steady noise is STILL attenuated rather than passing as if
  // it were speech (the whole point of an adaptive threshold vs a fixed dBFS one).
  assert.ok(
    exp.currentGain < 0.8,
    `gain ${exp.currentGain} should still attenuate the risen floor`,
  );
});

test("mute freezes the floor estimate (no collapse toward zero on silence)", () => {
  const exp = new NoiseExpander(SR, "lite");
  feed(exp, 0.05, 2);
  const floorBefore = exp.floorEstimate;
  assert.ok(floorBefore > 0.02, "floor learned the 0.05 signal");
  exp.setMuted(true);
  feed(exp, 0, 2); // muted -> source is silent
  assert.ok(
    Math.abs(exp.floorEstimate - floorBefore) < floorBefore * 0.05,
    `floor ${exp.floorEstimate} should stay ~${floorBefore} while muted`,
  );
  // Unmuting resumes adaptation.
  exp.setMuted(false);
  feed(exp, 0, 1);
  assert.ok(exp.floorEstimate < floorBefore, "floor tracks down again after unmute");
});

test("setLevel switches behavior off<->lite at runtime", () => {
  const exp = new NoiseExpander(SR, "off");
  feed(exp, 0.01, 1);
  assert.ok(exp.currentGain > 0.999, "off: unity");
  exp.setLevel("lite");
  feed(exp, 0.01, 2);
  assert.ok(exp.currentGain < 0.8, "lite after switch: attenuates");
});

test("multichannel: same gain applied to extra channels via the gains buffer", () => {
  const exp = new NoiseExpander(SR, "lite");
  const inA = new Float32Array(BLOCK).fill(0.01);
  const outA = new Float32Array(BLOCK);
  // Settle well past the cold-start window so a real gain is being applied.
  feed(exp, 0.01, 2);
  exp.processInto(inA, outA);
  const g = exp.gains[0];
  assert.ok(g < 0.85 && g > 0, `a real attenuating gain was recorded (got ${g})`);
  // The worklet applies exp.gains[i] to channel >0; verify it matches output/in.
  assert.ok(Math.abs(outA[0] - 0.01 * g) < 1e-6, "gains buffer matches output");
});
