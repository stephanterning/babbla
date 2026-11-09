// AudioWorklet shell for the noise expander. This is the thin, browser-only
// real-time wrapper; all the DSP lives in the imported pure core (also unit-
// tested in Node). Loaded via `audioWorklet.addModule("/js/noise-expander-worklet.js")`.
//
// Static `import` in an AudioWorklet module works in Chromium (babbla's client
// target). On a browser where it doesn't, addModule() rejects and mic-pipeline.js
// falls back to an HPF-only graph — never silence. Dynamic import() is NOT allowed
// in AudioWorkletGlobalScope, so the import below is intentionally static.
import { NoiseExpander } from "./noise-expander-core.js";

class NoiseExpanderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const level = options?.processorOptions?.level ?? "lite";
    // `sampleRate` is a global in AudioWorkletGlobalScope.
    this.expander = new NoiseExpander(sampleRate, level);
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.level !== undefined) this.expander.setLevel(msg.level);
      if (msg.muted !== undefined) this.expander.setMuted(msg.muted);
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    // No input connected this quantum: emit silence (don't drop the node).
    if (!input || input.length === 0) {
      for (const ch of output) ch.fill(0);
      return true;
    }
    // Drive the detector/gain off channel 0 (the mic is mono in practice) and
    // apply the same per-sample gain to any additional channels.
    const in0 = input[0];
    const out0 = output[0];
    this.expander.processInto(in0, out0);
    const gains = this.expander.gains;
    for (let ch = 1; ch < output.length; ch++) {
      const inCh = input[ch] || in0;
      const outCh = output[ch];
      for (let i = 0; i < outCh.length; i++) outCh[i] = inCh[i] * (gains ? gains[i] : 1);
    }
    return true;
  }
}

registerProcessor("noise-expander", NoiseExpanderProcessor);
