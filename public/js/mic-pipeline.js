// MicPipeline — the always-on sender-side audio graph that sits between
// getUserMedia and the mesh. It applies an 80 Hz high-pass (for everyone,
// unconditionally) and an opt-in soft expander ("Brusreducering": off/lite/full).
// See docs/noise-reduction.md.
//
// Ownership contract (critical — see the doc's "Rå vs processad ström" table):
// the controller keeps the RAW getUserMedia stream as `localStream` (deviceId,
// mute truth via track.enabled, deploy-restore all read it); ONLY the mesh and
// the self-meter consume `getStream()` (the processed output). So this module is
// a black box: raw MediaStream in, processed MediaStream out.
//
// Fail-open is the core invariant: this graph is the outbound audio path for
// EVERYONE, so a failure must never produce silence. If Web Audio is missing
// (Node tests), the context can't run, or the graph can't be built, getStream()
// returns the raw stream and `onFallback` fires so the controller re-attaches it.
// If only the worklet fails to load, we stay HPF-only (still audio, just no
// expander). Graph: source -> BiquadFilter(highpass 80Hz) -> [worklet] -> dest.

const HPF_HZ = 80;
const WORKLET_NAME = "noise-expander";

function resolveAudioContextCtor() {
  if (typeof AudioContext !== "undefined") return AudioContext;
  if (typeof globalThis !== "undefined" && globalThis.webkitAudioContext) {
    return globalThis.webkitAudioContext;
  }
  return null;
}

// A no-op pipeline that just hands back the raw stream. Used when Web Audio is
// unavailable (Node) or the graph can't be built — the fail-open path.
function passthrough(rawStream) {
  let stream = rawStream;
  return {
    getStream: () => stream,
    setConfig() {},
    setMuted() {},
    rebuild(next) {
      stream = next;
    },
    close() {},
    // Test/introspection: did we degrade to raw pass-through?
    isPassthrough: true,
  };
}

/**
 * @param {MediaStream} rawStream the getUserMedia mic stream
 * @param {object} [opts]
 * @param {"off"|"lite"|"full"} [opts.level]
 * @param {string} [opts.workletUrl]
 * @param {(stream: MediaStream, reason: string) => void} [opts.onFallback]
 * @param {(ctx: AudioContext) => void} [opts.registerContext] register for the
 *   "aktivera ljud" resume button (and best-effort resume)
 * @param {() => AudioContext} [opts.audioContextFactory] test seam
 * @param {(ctx: AudioContext, name: string, opts: object) => AudioWorkletNode} [opts.workletNodeFactory] test seam
 */
export function createMicPipeline(rawStream, opts = {}) {
  const {
    level = "lite",
    workletUrl = "/js/noise-expander-worklet.js",
    onFallback,
    registerContext,
    audioContextFactory,
    workletNodeFactory,
  } = opts;

  const Ctx = resolveAudioContextCtor();
  if ((!Ctx && !audioContextFactory) || !rawStream || !rawStream.getAudioTracks) {
    return passthrough(rawStream);
  }

  let ctx;
  let hpf;
  let dest;
  let source;
  let workletNode = null;
  let currentLevel = level;
  let muted = false;
  let failed = false;
  let output;
  // The mic currently feeding the graph. rebuild() moves this to a new device;
  // fail-open must hand back THIS stream, not the original (which the controller
  // stops on a mic switch) — else a post-switch failure would ship a dead track.
  let currentRaw = rawStream;

  try {
    ctx = audioContextFactory
      ? audioContextFactory()
      : new Ctx({ latencyHint: "interactive" });
    registerContext?.(ctx);
    dest = ctx.createMediaStreamDestination();
    hpf = ctx.createBiquadFilter();
    hpf.type = "highpass";
    hpf.frequency.value = HPF_HZ;
    if (hpf.Q) hpf.Q.value = 0.707;
    source = ctx.createMediaStreamSource(rawStream);
    source.connect(hpf);
    hpf.connect(dest); // HPF-only until (and unless) the worklet splices in
    output = dest.stream;
  } catch {
    try {
      ctx?.close?.();
    } catch {}
    return passthrough(rawStream);
  }

  function failOpen(reason) {
    if (failed) return;
    failed = true;
    output = currentRaw;
    try {
      source?.disconnect();
    } catch {}
    try {
      ctx?.close?.();
    } catch {}
    onFallback?.(currentRaw, reason);
  }

  function postToWorklet() {
    if (workletNode) workletNode.port.postMessage({ level: currentLevel, muted });
  }

  // Async: resume the context (it may start suspended) and load the expander
  // worklet. A context that won't run = silence -> fail open to raw. A worklet
  // that won't load = stay HPF-only (still audio), no fallback needed.
  (async () => {
    try {
      await ctx.resume?.();
    } catch {}
    if (ctx.state && ctx.state !== "running") {
      failOpen("context-suspended");
      return;
    }
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      if (failed) return;
      workletNode = workletNodeFactory
        ? workletNodeFactory(ctx, WORKLET_NAME, { processorOptions: { level: currentLevel } })
        : new AudioWorkletNode(ctx, WORKLET_NAME, {
            processorOptions: { level: currentLevel },
          });
      // Splice the worklet between the HPF and the destination.
      hpf.disconnect();
      hpf.connect(workletNode);
      workletNode.connect(dest);
      postToWorklet();
    } catch {
      // HPF-only. Expander unavailable on this browser; not silent, so no fallback.
      workletNode = null;
    }
  })();

  return {
    getStream: () => output,
    setConfig(lvl) {
      currentLevel = lvl;
      postToWorklet();
    },
    setMuted(m) {
      muted = !!m;
      postToWorklet();
    },
    // Swap the source mic (device switch / reconnect). In the happy path the
    // output stream identity is stable (same destination), so the mesh sender's
    // track doesn't churn; after a fail-open we just hand back the new raw stream.
    rebuild(next) {
      currentRaw = next;
      if (failed || !ctx) {
        output = next;
        return;
      }
      try {
        source?.disconnect();
      } catch {}
      try {
        source = ctx.createMediaStreamSource(next);
        source.connect(hpf);
      } catch {
        // failOpen now hands back `next` (currentRaw), not the stopped original.
        failOpen("rebuild-failed");
      }
    },
    close() {
      try {
        ctx?.close?.();
      } catch {}
    },
    get isPassthrough() {
      return failed;
    },
  };
}
