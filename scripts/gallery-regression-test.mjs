// Regression checks around the new gallery layout:
//  1. Audio-only (no cameras) stays the narrow compact column.
//  2. Cameras on, nothing pinned -> wide gallery.
//  3. Clicking a camera -> expanded stage (full width, stage visible).
//  4. Resetting focus -> back to the gallery.
import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-${Math.random().toString(36).slice(2, 10)}`;
const W = 1600;
const H = 900;
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
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  return { browser, page };
}

const snap = (page) =>
  page.evaluate(() => ({
    body: document.body.className,
    room: document.getElementById("room-view").className,
    appW: Math.round(document.querySelector(".app").getBoundingClientRect().width),
    stageVisible: !document.getElementById("screen-wrap").hidden,
  }));

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

    // 1. Audio only.
    let s = await snap(a.page);
    check("audio-only is narrow compact", s.room.includes("layout-compact") && !s.room.includes("gallery") && s.appW <= 500, s);

    // 2. Cameras on -> gallery.
    await a.page.click("#camera-btn");
    await b.page.click("#camera-btn");
    await c.page.click("#camera-btn");
    await sleep(7000);
    s = await snap(a.page);
    check("cameras on -> wide gallery", s.room.includes("gallery") && s.appW > 1000 && !s.stageVisible, s);

    // 3. Focus a peer camera -> expanded stage.
    // Wait for a peer tile to actually carry video rather than assuming the fixed
    // sleep above was enough: under the parallel e2e pool three browsers negotiating
    // camera can take longer, and an unguarded click() crashes the suite instead of
    // reporting a check.
    const clicked = await a.page
      .waitForFunction(
        () => {
          const t = [...document.querySelectorAll(".video-tile")].find(
            (el) =>
              el.classList.contains("has-video") && !el.classList.contains("self"),
          );
          if (!t) return false;
          t.click();
          return true;
        },
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false);
    check("a peer camera tile became focusable", clicked, await snap(a.page));
    await sleep(1500);
    s = await snap(a.page);
    check("focus camera -> expanded stage", s.room.includes("layout-expanded") && s.stageVisible, s);

    // 4. Reset focus (click stage) -> back to gallery.
    await a.page.click("#screen-wrap");
    await sleep(1500);
    s = await snap(a.page);
    check("reset focus -> gallery again", s.room.includes("gallery") && !s.stageVisible && s.appW > 1000, s);
  } finally {
    await a.browser.close();
    await b.browser.close();
    await c.browser.close();
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})();
