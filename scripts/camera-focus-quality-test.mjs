// Verifies the automatic, focus-driven camera quality (no user picker):
//
//   - Baseline (nobody focusing): camera is sent to every peer at STANDARD
//     (640x360, 250 kbps).
//   - When a peer enlarges our camera on their stage, that peer's stream
//     ratchets up to HIGH (1080p capability-fallback, 2.5 Mbps) — per-peer.
//   - After the viewer unfocuses, the boost is held briefly
//     (CAMERA_FOCUS_HOLD_MS) and then settles back to STANDARD.
//
// Two participants (A viewer, B camera owner). We read B's outbound camera
// sender (the only video sender, no screen share): its encodings[0].maxBitrate
// is the per-peer send cap and track.getSettings() is the capture resolution.
import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-${Math.random().toString(36).slice(2, 10)}`;
const W = 1280;
const H = 800;
const LAUNCH = {
  executablePath: "/usr/bin/google-chrome-stable",
  headless: false,
  args: [
    "--no-sandbox",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--window-size=${W},${H}`,
  ],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOOK = `
  window.__pcs = [];
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new OrigPC(...args);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;
`;

async function newClient(name) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(HOOK);
  await page.setViewport({ width: W, height: H });
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 15000 });
  return { browser, page };
}

// Read the outbound camera sender's per-peer bitrate cap + capture resolution.
function cameraSenderInfo(page) {
  return page.evaluate(() => {
    for (const pc of window.__pcs) {
      for (const s of pc.getSenders()) {
        if (!s.track || s.track.kind !== "video") continue;
        const enc = s.getParameters().encodings?.[0] || {};
        const st = s.track.getSettings();
        return {
          maxBitrate: enc.maxBitrate ?? null,
          width: st.width ?? null,
          height: st.height ?? null,
          frameRate: st.frameRate ?? null,
        };
      }
    }
    return null;
  });
}

function clickTileByName(page, name) {
  return page.evaluate((n) => {
    const tiles = [...document.querySelectorAll(".video-tile")];
    const tile = tiles.find(
      (el) =>
        !el.classList.contains("screen-tile") &&
        !el.classList.contains("self") &&
        el.querySelector(".video-tile-name")?.textContent?.trim() === n,
    );
    if (!tile) return false;
    tile.click();
    return true;
  }, name);
}

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS ${label}`);
  } else {
    fail++;
    console.log(`FAIL ${label} -> ${JSON.stringify(detail)}`);
  }
}

(async () => {
  const a = await newClient("Alice");
  const b = await newClient("Bob");
  try {
    await sleep(3000);

    // Both cameras on.
    await a.page.click("#camera-btn");
    await b.page.click("#camera-btn");
    await sleep(7000);

    // Baseline: B sends camera to A at STANDARD (no one focusing). The explicit
    // 250 kbps cap only sticks once negotiation has settled, so before any focus
    // the sender may still report null (unconstrained) — what matters is that it
    // is NOT boosted and the capture is gated to 360p.
    let info = await cameraSenderInfo(b.page);
    check(
      "baseline not boosted (null or 250000)",
      info?.maxBitrate === null || info?.maxBitrate === 250_000,
      info,
    );
    check("baseline height == 360", info?.height === 360, info);

    // A enlarges B's camera on the stage -> B should boost to HIGH for A.
    const focused = await clickTileByName(a.page, "Bob");
    check("A focused Bob", focused, { focused });
    await sleep(3000);

    info = await cameraSenderInfo(b.page);
    check("focused maxBitrate == 2500000", info?.maxBitrate === 2_500_000, info);
    check("focused capture >= 720p", (info?.height ?? 0) >= 720, info);

    // Unfocus: within the post-unfocus hold, the boost should still be applied.
    await clickTileByName(a.page, "Bob");
    await sleep(900);
    info = await cameraSenderInfo(b.page);
    check("during hold still boosted (2500000)", info?.maxBitrate === 2_500_000, info);

    // After the hold (CAMERA_FOCUS_HOLD_MS = 2s) it settles back to STANDARD.
    // The bitrate cap is back to standard (250000, or null if a setParameters
    // hasn't landed yet on a slow run) and — the real guarantee — capture has
    // dropped back to 360p.
    await sleep(2600);
    info = await cameraSenderInfo(b.page);
    check(
      "after hold no longer boosted (null or 250000)",
      info?.maxBitrate === null || info?.maxBitrate === 250_000,
      info,
    );
    check("after hold height back to 360", info?.height === 360, info);
  } finally {
    await a.browser.close();
    await b.browser.close();
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})();
