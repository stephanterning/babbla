// e2e: the "share the link" onboarding arrow's auto-hide countdown must pause
// while the "Bästa möjliga ljud" info modal is open (which covers the arrow),
// and restart a full 5s window once the modal closes. Otherwise the 5s elapses
// behind the modal and the arrow is gone by the time the user reads + closes it.
//
// Flow: join a fresh room alone -> arrow shows -> open the info modal -> wait
// past the 5s window -> arrow still shown (paused) -> close modal -> arrow still
// shown -> wait past 5s -> arrow hidden (re-armed + elapsed).
//
// Usage: node scripts/onboarding-modal-pause-test.mjs   (BABBLA_URL from harness)
import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-onboarding-pause-${Math.random().toString(36).slice(2, 8)}`;
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome-stable";
// A touch over the 5s SHARE_ONBOARDING_MS window in main.js.
const PAST_WINDOW_MS = 6_000;

const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? ` — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arrowHidden = (page) =>
  page.evaluate(() => document.getElementById("share-onboarding").hidden);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});

try {
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", "Alice");
  await page.click("#join-form button");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 10_000 });

  // Arrow shows because we're alone in the room.
  await page.waitForFunction(
    () => !document.getElementById("share-onboarding").hidden,
    { timeout: 5_000 },
  );
  check("arrow shown when alone", true);

  // Open the info modal (it covers the arrow) and wait past the 5s window.
  // The room view has its own .info-btn (the join view's is hidden now).
  await page.click("#room-view .info-btn");
  await page.waitForFunction(() => document.getElementById("info-dialog").open, {
    timeout: 2_000,
  });
  await sleep(PAST_WINDOW_MS);
  check(
    "countdown paused while info modal open (arrow still shown past 5s)",
    (await arrowHidden(page)) === false,
  );

  // Close the modal; arrow should still be there, and now re-arm a fresh window.
  await page.click("#close-info-btn");
  await page.waitForFunction(() => !document.getElementById("info-dialog").open, {
    timeout: 2_000,
  });
  check("arrow still shown immediately after closing the modal", (await arrowHidden(page)) === false);

  await sleep(PAST_WINDOW_MS);
  check(
    "arrow auto-hides ~5s after the modal closes (countdown re-armed)",
    (await arrowHidden(page)) === true,
  );

  const passed = results.every(Boolean);
  console.log(
    `VERDICT: ${passed ? "PASS" : "FAIL"} (${results.filter(Boolean).length}/${results.length})`,
  );
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
