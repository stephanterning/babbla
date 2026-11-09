// Manual/automated check: does muting the mic actually stop outbound audio RTP?
// Drives two separate Chrome instances (per AGENTS.md: two tabs in one browser
// crash the renderer in this VM) with fake media, joins both, then measures
// peer A's outbound audio bytes/s before vs. after pressing the mute button.
//
// Usage: node scripts/mute-bandwidth-test.mjs
import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-${Math.random().toString(36).slice(2, 10)}`;
const CHROME = "/usr/bin/google-chrome-stable";
const LAUNCH = {
  executablePath: CHROME,
  headless: false,
  args: [
    "--no-sandbox",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sum audio bytes across every RTCPeerConnection on the page for one direction.
async function audioBytes(page, dir) {
  return page.evaluate(async (dir) => {
    const type = dir === "out" ? "outbound-rtp" : "inbound-rtp";
    const field = dir === "out" ? "bytesSent" : "bytesReceived";
    let total = 0;
    for (const pc of window.__pcs || []) {
      const stats = await pc.getStats();
      for (const r of stats.values()) {
        if (r.type === type && r.kind === "audio") total += r[field] || 0;
      }
    }
    return total;
  }, dir);
}

// Measure audio bitrate (kbit/s) for a direction over `windowMs`.
async function audioRate(page, dir = "out", windowMs = 3000) {
  const a = await audioBytes(page, dir);
  const t0 = Date.now();
  await sleep(windowMs);
  const b = await audioBytes(page, dir);
  const dt = (Date.now() - t0) / 1000;
  return ((b - a) * 8) / 1000 / dt;
}

async function newClient(name) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  // Collect every PeerConnection so we can read its stats later.
  await page.evaluateOnNewDocument(() => {
    window.__pcs = [];
    const Orig = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...a) {
      const pc = new Orig(...a);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Orig.prototype;
  });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  return { browser, page };
}

(async () => {
  const a = await newClient("Alice");
  const b = await newClient("Bob");
  try {
    // Let the mesh connect and audio start flowing.
    await sleep(6000);

    const before = await audioRate(a.page, "out");
    const bobBefore = await audioRate(b.page, "in");
    console.log(`Alice outbound audio BEFORE mute: ${before.toFixed(1)} kbit/s`);
    console.log(`Bob inbound audio   BEFORE mute: ${bobBefore.toFixed(1)} kbit/s`);

    // Press Alice's mute button.
    await a.page.click("#mute-btn");
    const pressed = await a.page.$eval("#mute-btn", (el) => el.getAttribute("aria-pressed"));
    console.log(`Alice mute aria-pressed = ${pressed}`);

    // Give the encoder a moment to wind down, then measure both sides.
    await sleep(2000);
    const after = await audioRate(a.page, "out");
    const bobAfter = await audioRate(b.page, "in");
    console.log(`Alice outbound audio AFTER mute:  ${after.toFixed(1)} kbit/s`);
    console.log(`Bob inbound audio   AFTER mute:  ${bobAfter.toFixed(1)} kbit/s`);

    // Unmute and confirm audio resumes (no regression).
    await a.page.click("#mute-btn");
    await sleep(3000);
    const resumed = await audioRate(a.page, "out");
    console.log(`Alice outbound audio AFTER unmute: ${resumed.toFixed(1)} kbit/s`);

    const stopped = after < before * 0.25 && bobAfter < bobBefore * 0.25;
    const cameBack = resumed > before * 0.5;
    const verdict = stopped && cameBack
      ? "PASS (audio stops on mute, resumes on unmute)"
      : "FAIL";
    console.log(`VERDICT: ${verdict}`);
  } finally {
    await a.browser.close();
    await b.browser.close();
  }
})();
