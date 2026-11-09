// Manual/automated check: does the focused stage video pop into a real
// picture-in-picture window via the on-stage PiP button, and does the button
// stay in sync (shown only with a focused stream, aria-pressed reflecting PiP,
// auto-exit when the stage clears)?
//
// One Chrome instance is enough here (no peer needed): we focus our own fake
// camera onto the stage and drive the #pip-btn. Picture-in-Picture works in the
// non-headless Chrome on this VM's Xvfb display; the real Safari behaviour (and
// the best-effort auto-PiP on backgrounding) still needs a manual browser test.
//
// Usage: node scripts/pip-test.mjs
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
    "--disable-dev-shm-usage",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
};

const browser = await puppeteer.launch(LAUNCH);
try {
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "networkidle2" });

  check("document.pictureInPictureEnabled", await page.evaluate(() => document.pictureInPictureEnabled));

  await page.type("#name-input", "Pip Tester");
  await page.click("#join-btn");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 10000 });

  // Button hidden while nothing is focused on the stage.
  check("PiP button hidden with empty stage", await page.$eval("#pip-btn", (b) => b.hidden));

  // Camera on, then focus it onto the stage.
  await page.click("#camera-btn");
  await page.waitForFunction(
    () => document.querySelector(".video-tile.self")?.classList.contains("has-video"),
    { timeout: 10000 },
  );
  await page.click(".video-tile.self");
  await page.waitForFunction(
    () => {
      const v = document.getElementById("screen-video");
      return v && v.readyState >= 1 && v.videoWidth > 0 && !v.paused;
    },
    { timeout: 10000 },
  );

  check("PiP button shown with focused video", !(await page.$eval("#pip-btn", (b) => b.hidden)));

  // Gesture: click to enter PiP.
  await page.click("#pip-btn");
  await sleep(700);
  check(
    "button click enters PiP",
    await page.evaluate(
      () =>
        document.pictureInPictureElement === document.getElementById("screen-video") &&
        document.getElementById("pip-btn").getAttribute("aria-pressed") === "true",
    ),
  );
  check(
    "aria-label/title reflect 'close' while in PiP",
    await page.evaluate(() => {
      const b = document.getElementById("pip-btn");
      return b.getAttribute("aria-label") === "Stäng bild-i-bild" && /Stäng/.test(b.title);
    }),
  );

  // Gesture: click again to exit PiP.
  await page.click("#pip-btn");
  await sleep(700);
  check(
    "button click exits PiP",
    await page.evaluate(
      () =>
        !document.pictureInPictureElement &&
        document.getElementById("pip-btn").getAttribute("aria-pressed") === "false",
    ),
  );
  check(
    "aria-label reflects 'open' when not in PiP",
    await page.evaluate(
      () => document.getElementById("pip-btn").getAttribute("aria-label") === "Visa i bild-i-bild",
    ),
  );

  // Re-enter, then clear the stage focus: PiP should auto-close and the button hide.
  await page.click("#pip-btn");
  await sleep(500);
  await page.evaluate(() => document.querySelector(".screen-wrap")?.click());
  await sleep(500);
  check(
    "clearing focus auto-closes PiP and hides button",
    await page.evaluate(
      () => !document.pictureInPictureElement && document.getElementById("pip-btn").hidden,
    ),
  );

  const passed = results.every(Boolean);
  console.log(`VERDICT: ${passed ? "PASS" : "FAIL"} (${results.filter(Boolean).length}/${results.length})`);
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
