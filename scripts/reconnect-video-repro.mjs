// Repro: after a peer's WebSocket drops and auto-reconnects, does it get the
// camera video of peers whose camera was already on before the reconnect?
//
// Mirrors the reported symptom: "went back to the device that had been
// disconnected, but got no video from any of the others."
//
// Two peers (separate browsers, per AGENTS.md — two tabs crash the renderer):
//   1. Alice + Bob join, both turn camera on. Verify each sees the other.
//   2. Bob goes offline (CDP) long enough to drop the WS, then back online.
//      The client auto-reconnects with a new server id and rebuilds the room.
//   3. After reconnect, check: does Bob see Alice's camera? Does Alice see
//      Bob's (re-added) camera?
import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-${Math.random().toString(36).slice(2, 10)}`;
const W = 1100;
const H = 760;
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

async function newClient(name) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 15000 });
  return { browser, page };
}

function tileHasVideo(page, name) {
  return page.evaluate((n) => {
    const tiles = [...document.querySelectorAll(".video-tile")];
    const tile = tiles.find(
      (el) =>
        !el.classList.contains("screen-tile") &&
        !el.classList.contains("self") &&
        el.querySelector(".video-tile-name")?.textContent?.trim() === n,
    );
    if (!tile) return { found: false, hasVideo: false };
    const video = tile.querySelector("video");
    return {
      found: true,
      hasVideo: tile.classList.contains("has-video"),
      readyState: video?.readyState ?? -1,
      hasSrc: !!video?.srcObject,
    };
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
    await a.page.click("#camera-btn");
    await b.page.click("#camera-btn");
    await sleep(7000);

    let aSeesB = await tileHasVideo(a.page, "Bob");
    let bSeesA = await tileHasVideo(b.page, "Alice");
    check("baseline: Alice sees Bob camera", aSeesB.hasVideo, aSeesB);
    check("baseline: Bob sees Alice camera", bSeesA.hasVideo, bSeesA);

    // Drop Bob's connection: go offline long enough for the WS heartbeat / close
    // to fire, then come back. The client should auto-reconnect.
    const cdp = await b.page.target().createCDPSession();
    await cdp.send("Network.enable");
    console.log("-- Bob going offline --");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await sleep(6000);
    console.log("-- Bob back online --");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    // Wait for Bob to reconnect (status back to live) and the room to rebuild.
    await sleep(12000);

    // After reconnect Bob's camera is reset (per teardownRoom); turn it back on
    // the way a returning user would, so Alice has something to render.
    const bobCamOn = await b.page.evaluate(
      () => document.getElementById("camera-btn").getAttribute("aria-pressed") === "true",
    );
    if (!bobCamOn) {
      await b.page.click("#camera-btn");
      await sleep(6000);
    }

    aSeesB = await tileHasVideo(a.page, "Bob");
    bSeesA = await tileHasVideo(b.page, "Alice");
    check("after reconnect: Bob sees Alice camera", bSeesA.hasVideo, bSeesA);
    check("after reconnect: Alice sees Bob camera", aSeesB.hasVideo, aSeesB);

    // Also confirm audio path: each side should have a live inbound audio element.
    const bobHearsAlice = await b.page.evaluate(() => {
      const audios = [...document.querySelectorAll("#audio-sink audio")];
      return audios.some((au) => au.srcObject && au.readyState >= 0);
    });
    check("after reconnect: Bob has inbound audio element", bobHearsAlice, { bobHearsAlice });

    if (process.env.SHOT) {
      await a.page.screenshot({ path: process.env.SHOT });
      console.log(`screenshot -> ${process.env.SHOT}`);
    }
  } finally {
    await a.browser.close();
    await b.browser.close();
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})();
