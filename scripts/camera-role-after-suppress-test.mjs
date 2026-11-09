// Regression test for the "camera disappears after fullscreen + self-camera
// toggle" bug.
//
// Repro (three peers A/B/C, all cameras on, mic off, no screen share):
//   1. On A, focus B's camera on the stage.
//   2. On A, enter fullscreen pinned to B. This tells every *other* peer (C) to
//      suppress (pause) the camera they send A — C does replaceTrack(null).
//   3. On A, toggle its own camera off and on again. That renegotiates A<->C
//      while C's camera to A is paused.
//   4. On A, exit fullscreen.
//
// Bug: when C built its mid->role map during the step-3 renegotiation, it keyed
// the role off the sender's *current track*, which was null (paused) — so C's
// camera mid was dropped from the map. Resuming on exit is a track swap (no
// renegotiation), so A never got a fresh map and C's camera stayed blank in the
// grid until some unrelated renegotiation (e.g. C starting a screen share).
//
// Fix: the role map is derived from the per-peer camera/screen *sender*
// identity, which is stable across a pause, so the mid is always present.
//
// Pass criteria: after the whole sequence, A's grid tile for C shows video.
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

async function newClient(name) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  // Wait deterministically for the room UI rather than relying on a fixed sleep:
  // join acquires the (fake) mic and opens the WebSocket before the room shows.
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 15000 });
  return { browser, page };
}

// Does the (non-screen, non-self) grid tile for `name` currently show video?
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

async function waitForTileVideo(page, name, timeout = 15_000) {
  return page.waitForFunction(
    (n) => {
      const tiles = [...document.querySelectorAll(".video-tile")];
      const tile = tiles.find(
        (el) =>
          !el.classList.contains("screen-tile") &&
          !el.classList.contains("self") &&
          el.querySelector(".video-tile-name")?.textContent?.trim() === n,
      );
      if (!tile) return false;
      const video = tile.querySelector("video");
      return tile.classList.contains("has-video") && !!video?.srcObject && (video.readyState ?? 0) >= 2;
    },
    { timeout },
    name,
  );
}

async function ensureCameraOn(page, timeout = 12_000) {
  await page.waitForFunction(
    () => {
      const btn = document.getElementById("camera-btn");
      return !!btn && !btn.disabled;
    },
    { timeout },
  );
  const isOn = await page.$eval(
    "#camera-btn",
    (btn) => btn.getAttribute("aria-pressed") === "true",
  );
  if (isOn) return;
  await page.click("#camera-btn");
  await page.waitForFunction(
    () => document.getElementById("camera-btn")?.getAttribute("aria-pressed") === "true",
    { timeout },
  );
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
  const c = await newClient("Carol");
  try {
    await sleep(4000);

    // All cameras on.
    await ensureCameraOn(a.page);
    await ensureCameraOn(b.page);
    await ensureCameraOn(c.page);
    await Promise.all([
      waitForTileVideo(a.page, "Bob"),
      waitForTileVideo(a.page, "Carol"),
    ]).catch(() => {});

    // Baseline: A sees both B and C cameras in the grid.
    let aSeesC = await tileHasVideo(a.page, "Carol");
    let aSeesB = await tileHasVideo(a.page, "Bob");
    check("baseline: A sees C camera", aSeesC.hasVideo, aSeesC);
    check("baseline: A sees B camera", aSeesB.hasVideo, aSeesB);

    // 1. A focuses B's camera on stage.
    const focused = await clickTileByName(a.page, "Bob");
    check("A focused Bob", focused, { focused });
    await sleep(1500);

    // 2. A enters fullscreen (pins B, suppresses C's outbound camera to A).
    await a.page.evaluate(() => document.getElementById("fullscreen-btn").click());
    await sleep(1500);
    const fsOn = await a.page.evaluate(() =>
      document.body.classList.contains("fullscreen-stage"),
    );
    check("A entered fullscreen", fsOn, { fsOn });
    // Let the suppress hint reach C and C pause its camera to A.
    await sleep(2500);

    // 3. A toggles its own camera off, waits, then on — renegotiating A<->C
    //    while C's camera to A is paused. Use the in-fullscreen camera control
    //    (#fs-camera); the sidebar #camera-btn is covered by the overlay.
    await a.page.evaluate(() => document.getElementById("fs-camera").click()); // off
    await sleep(1500);
    await a.page.evaluate(() => document.getElementById("fs-camera").click()); // on
    await sleep(6000);

    // 4. A exits fullscreen (resumes C; resume is a track swap, no renegotiation).
    await a.page.evaluate(() => document.getElementById("fs-exit").click());
    await sleep(4000);

    // The bug: C's camera tile is now blank on A even though C is still sending.
    aSeesC = await tileHasVideo(a.page, "Carol");
    check("after sequence: A still sees C camera", aSeesC.hasVideo, aSeesC);

    // Sanity: C really is still sending (B sees C's camera throughout).
    const bSeesC = await tileHasVideo(b.page, "Carol");
    check("sanity: B still sees C camera", bSeesC.hasVideo, bSeesC);

    // Optional artifact: screenshot of A's grid showing both peer cameras live.
    if (process.env.SHOT) {
      await a.page.screenshot({ path: process.env.SHOT });
      console.log(`screenshot saved -> ${process.env.SHOT}`);
    }
  } finally {
    await a.browser.close();
    await b.browser.close();
    await c.browser.close();
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})();
