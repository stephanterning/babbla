// Tier-3 e2e for "Brusreducering" (docs/noise-reduction.md). Proves the real
// pipeline (getUserMedia -> HPF + expander worklet) end to end:
//   1) steady low-level noise is attenuated at Lätt/Stark vs Av;
//   2) fail-open: if the worklet can't load, audio still flows (HPF-only, not silence).
//
// The mic is a generated WAV fed via Chrome's --use-file-for-fake-audio-capture.
// We bypass Chrome's own NS/AGC in the test capture (constraints false) so we
// measure OUR expander's effect, not Chrome's. "Loud speech passes at unity" is
// covered deterministically by the Tier-1 DSP unit tests.
//
// Usage: node scripts/noise-reduction-test.mjs   (BABBLA_URL from the e2e harness)
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-${Math.random().toString(36).slice(2, 10)}`;
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome-stable";

const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? ` — ${extra}` : ""}`);
};

// Write a 16-bit PCM mono WAV of steady low-amplitude white noise (a stand-in for
// background room noise sitting near the floor — what the expander should pull down).
function writeNoiseWav(path, { seconds = 6, amp = 0.012, sampleRate = 48000 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const bytesPerSample = 2;
  const dataLen = n * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  let seed = 1234567;
  const rand = () => {
    // deterministic LCG -> [-1, 1)
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x40000000) - 1;
  };
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, rand() * amp));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * bytesPerSample);
  }
  writeFileSync(path, buf);
}

// In-page: build the pipeline at `level`, let it settle, then measure processed
// RMS over a window. `badWorklet` forces a worklet-load failure (fail-open path).
async function measureInPage(page, level, { badWorklet = false } = {}) {
  return page.evaluate(
    async (level, badWorklet) => {
      const { createMicPipeline } = await import("/js/mic-pipeline.js");
      const raw = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      const pipe = createMicPipeline(raw, {
        level,
        workletUrl: badWorklet ? "/js/does-not-exist.js" : "/js/noise-expander-worklet.js",
        registerContext: (ctx) => ctx.resume?.().catch?.(() => {}),
      });
      // Settle: worklet load + warmup + floor tracking.
      await new Promise((r) => setTimeout(r, 2600));
      const processed = pipe.getStream();
      const actx = new (window.AudioContext || window.webkitAudioContext)();
      await actx.resume();
      const src = actx.createMediaStreamSource(processed);
      const an = actx.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      // Pull the graph (muted) so the analyser actually runs.
      const mute = actx.createGain();
      mute.gain.value = 0;
      an.connect(mute);
      mute.connect(actx.destination);
      const buf = new Float32Array(an.fftSize);
      let sumSq = 0;
      let count = 0;
      let peak = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 2200) {
        an.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          sumSq += v * v;
          if (Math.abs(v) > peak) peak = Math.abs(v);
        }
        count += buf.length;
        await new Promise((r) => setTimeout(r, 30));
      }
      const isPassthrough = pipe.isPassthrough;
      try {
        pipe.close();
      } catch {}
      try {
        actx.close();
      } catch {}
      raw.getTracks().forEach((t) => t.stop());
      return { rms: Math.sqrt(sumSq / count), peak, isPassthrough };
    },
    level,
    badWorklet,
  );
}

const dir = mkdtempSync(join(tmpdir(), "babbla-noise-"));
const wav = join(dir, "noise.wav");
writeNoiseWav(wav);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});

try {
  const page = await browser.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (/error|fail/i.test(t)) console.log(`  [page] ${t}`);
  });
  await page.goto(URL, { waitUntil: "networkidle2" });

  const off = await measureInPage(page, "off");
  const lite = await measureInPage(page, "lite");
  const full = await measureInPage(page, "full");
  console.log(
    `  RMS  off=${off.rms.toFixed(5)} lite=${lite.rms.toFixed(5)} full=${full.rms.toFixed(5)}`,
  );

  check("off produces audio (HPF-only baseline)", off.rms > 1e-4, `rms=${off.rms.toFixed(5)}`);
  check(
    "Lätt attenuates steady noise vs Av",
    lite.rms < off.rms * 0.9,
    `lite/off=${(lite.rms / off.rms).toFixed(2)}`,
  );
  check(
    "Stark attenuates more than Lätt",
    full.rms < lite.rms,
    `full/lite=${(full.rms / lite.rms).toFixed(2)}`,
  );
  check(
    "Stark is meaningfully quieter than Av",
    full.rms < off.rms * 0.7,
    `full/off=${(full.rms / off.rms).toFixed(2)}`,
  );

  // Fail-open: a worklet that can't load must NOT yield silence (HPF-only).
  const failOpen = await measureInPage(page, "lite", { badWorklet: true });
  console.log(`  fail-open rms=${failOpen.rms.toFixed(5)}`);
  check(
    "worklet-load failure still produces audio (fail-open, not silence)",
    failOpen.rms > 1e-4,
    `rms=${failOpen.rms.toFixed(5)}`,
  );
  check(
    "fail-open audio ~= the HPF-only baseline (no expander applied)",
    failOpen.rms > off.rms * 0.7,
    `failOpen/off=${(failOpen.rms / off.rms).toFixed(2)}`,
  );

  const passed = results.every(Boolean);
  console.log(`VERDICT: ${passed ? "PASS" : "FAIL"} (${results.filter(Boolean).length}/${results.length})`);
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
