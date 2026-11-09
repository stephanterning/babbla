// Capture the in-app bandwidth meter (the thing the user looks at) before and
// after muting, cropped to the meter element, so the ↑ send rate visibly drops.
import puppeteer from "puppeteer-core";

const URL = "http://localhost:8080/";
const OUT = "/opt/cursor/artifacts";
const LAUNCH = {
  executablePath: "/usr/bin/google-chrome-stable",
  headless: false,
  args: [
    "--no-sandbox",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--window-size=900,700",
  ],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newClient(name) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  return { browser, page };
}

async function shotMeter(page, file) {
  const el = await page.$("#bandwidth");
  await el.screenshot({ path: `${OUT}/${file}` });
  const up = await page.$eval("#bw-up", (e) => e.textContent);
  const down = await page.$eval("#bw-down", (e) => e.textContent);
  console.log(`${file}: ↑ ${up}  ↓ ${down}`);
}

(async () => {
  const a = await newClient("Alice");
  const b = await newClient("Bob");
  try {
    // Connect + let the meter settle on real send/receive rates.
    await sleep(8000);
    await shotMeter(a.page, "bandwidth_meter_before_mute.png");

    await a.page.click("#mute-btn");
    // Meter samples once a second; wait for a couple of clean post-mute ticks.
    await sleep(4000);
    await shotMeter(a.page, "bandwidth_meter_after_mute.png");
  } finally {
    await a.browser.close();
    await b.browser.close();
  }
})();
