// Verifies the staging env banner folds to a thin (~2px) yellow strip ~10s after
// joining (instead of disappearing). Measures the collapsed banner's box and
// captures a zoomed crop of the top strip. Requires APP_ENV=staging on :8080.
import puppeteer from "puppeteer-core";

const URL = process.env.BABBLA_URL || "http://localhost:8080/";
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

const measure = (page) =>
  page.evaluate(() => {
    const b = document.querySelector(".env-banner");
    if (!b) return { present: false };
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return {
      present: true,
      collapsed: b.classList.contains("is-collapsed"),
      height: Math.round(r.height * 100) / 100,
      width: Math.round(r.width),
      top: Math.round(r.top),
      display: cs.display,
      visibility: cs.visibility,
      fontSize: cs.fontSize,
      hasGradient: cs.backgroundImage.includes("gradient"),
    };
  });

const browser = await puppeteer.launch(LAUNCH);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#name-input");
  await page.type("#name-input", "Mätare");
  await page.click("#join-btn");
  await page.waitForSelector("#room-view:not([hidden])");

  const before = await measure(page);
  console.log("BEFORE (just joined):", JSON.stringify(before));
  if (before.height < 10) throw new Error("banner should be full height before collapse");

  await sleep(11_000); // collapse timer is 10s
  const after = await measure(page);
  console.log("AFTER (~11s):       ", JSON.stringify(after));

  await page.screenshot({
    path: "/opt/cursor/artifacts/env_banner_collapsed_strip.png",
    clip: { x: 0, y: 0, width: 900, height: 14 },
  });
  console.log("saved zoomed top-strip crop -> /opt/cursor/artifacts/env_banner_collapsed_strip.png");

  const ok =
    after.present &&
    after.collapsed &&
    after.display !== "none" &&
    after.visibility !== "hidden" &&
    after.height > 0 &&
    after.height <= 4 &&
    after.width === before.width &&
    after.hasGradient;
  console.log(ok ? "PASS: folded to a thin full-width yellow strip" : "FAIL: not a thin visible strip");
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
