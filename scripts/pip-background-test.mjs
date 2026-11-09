// Regression test for the "black stage after tab switch" bug: automatic PiP
// (entered when the tab is backgrounded) must close again when the tab returns
// to the foreground, so the inline stage isn't left showing the black
// "playing in picture-in-picture" placeholder. A PiP the user opened by hand
// must instead survive a tab switch.
//
// visibilityState is overridden + a visibilitychange event dispatched to
// simulate backgrounding without an OS-level tab switch.
//
// Usage: node scripts/pip-background-test.mjs
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
const setVisibility = (page, state) =>
  page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);

const browser = await puppeteer.launch(LAUNCH);
try {
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", "BG Tester");
  await page.click("#join-btn");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 10000 });

  // Focus our own camera onto the stage.
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

  // Background -> automatic PiP.
  await setVisibility(page, "hidden");
  await sleep(800);
  check(
    "backgrounding the tab auto-enters PiP",
    await page.evaluate(
      () => document.pictureInPictureElement === document.getElementById("screen-video"),
    ),
  );

  // Foreground -> the automatic PiP closes, inline stage restored (not black).
  await setVisibility(page, "visible");
  await sleep(800);
  check(
    "returning to the tab auto-closes the automatic PiP",
    await page.evaluate(() => !document.pictureInPictureElement),
  );

  // Manual PiP via the button must survive a tab switch.
  await page.click("#pip-btn");
  await sleep(700);
  check("button opens PiP", await page.evaluate(() => !!document.pictureInPictureElement));
  await setVisibility(page, "hidden");
  await sleep(300);
  await setVisibility(page, "visible");
  await sleep(700);
  check(
    "manual PiP survives a tab switch",
    await page.evaluate(() => !!document.pictureInPictureElement),
  );

  const passed = results.every(Boolean);
  console.log(`VERDICT: ${passed ? "PASS" : "FAIL"} (${results.filter(Boolean).length}/${results.length})`);
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
