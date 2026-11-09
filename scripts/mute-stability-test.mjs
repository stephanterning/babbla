// Stability check for replaceTrack(null) on mute: if BOTH peers mute (so almost
// no media flows on the bundled transport in either direction), does the
// PeerConnection survive on ICE consent keepalive alone, and does audio resume
// on unmute? Drives two separate Chrome instances with fake media.
import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-${Math.random().toString(36).slice(2, 10)}`;
const LAUNCH = {
  executablePath: "/usr/bin/google-chrome-stable",
  headless: false,
  args: [
    "--no-sandbox",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newClient(name) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
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

const states = (page) =>
  page.evaluate(() => (window.__pcs || []).map((pc) => pc.connectionState));

// What the suite actually asks: did the *live* connection survive the idle?
// The hook above records every RTCPeerConnection the page ever constructed, and
// the join flow leaves a closed one behind, so requiring every recorded state to
// be "connected" can never hold. Ignore closed PCs and require at least one that
// is connected.
const aliveOnly = (states) => {
  const live = states.filter((s) => s !== "closed");
  return live.length > 0 && live.every((s) => s === "connected");
};

async function inboundAudioRate(page, ms = 3000) {
  const read = () =>
    page.evaluate(async () => {
      let t = 0;
      for (const pc of window.__pcs || []) {
        const s = await pc.getStats();
        for (const r of s.values())
          if (r.type === "inbound-rtp" && r.kind === "audio") t += r.bytesReceived || 0;
      }
      return t;
    });
  const a = await read();
  await sleep(ms);
  const b = await read();
  return ((b - a) * 8) / 1000 / (ms / 1000);
}

let ok = false;

(async () => {
  const a = await newClient("Alice");
  const b = await newClient("Bob");
  try {
    await sleep(6000);
    console.log("connected:", await states(a.page), await states(b.page));

    // Both mute — minimal media on the transport in either direction.
    await a.page.click("#mute-btn");
    await b.page.click("#mute-btn");
    console.log("both muted; idling 45s...");

    for (let i = 0; i < 9; i++) {
      await sleep(5000);
      const sa = (await states(a.page)).join(",");
      const sb = (await states(b.page)).join(",");
      console.log(`  t+${(i + 1) * 5}s  alice=[${sa}] bob=[${sb}]`);
    }

    const aliveA = aliveOnly(await states(a.page));
    const aliveB = aliveOnly(await states(b.page));

    // Unmute Bob; Alice should start receiving audio again.
    await b.page.click("#mute-btn");
    const resumed = await inboundAudioRate(a.page);
    console.log(`alice inbound audio after Bob unmutes: ${resumed.toFixed(1)} kbit/s`);

    ok = aliveA && aliveB && resumed > 5;
    console.log(
      `VERDICT: ${
        ok
          ? "PASS (connection stayed connected through 45s idle; audio resumed)"
          : `FAIL (aliveA=${aliveA} aliveB=${aliveB} resumed=${resumed.toFixed(1)} kbit/s)`
      }`,
    );
  } finally {
    await a.browser.close();
    await b.browser.close();
  }
  // Exit non-zero on failure: without this the e2e runner (which keys off the
  // exit code) reports the suite green no matter what the verdict said.
  process.exit(ok ? 0 : 1);
})();
