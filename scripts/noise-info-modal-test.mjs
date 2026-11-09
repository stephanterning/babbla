// e2e for the first-visit info modal (docs/noise-reduction.md, step 1):
//   - it auto-opens once, the moment the mic goes live on the first join;
//   - a localStorage "seen" flag suppresses it on later joins (incl. reload);
//   - the macOS Voice Isolation section is the 2nd section in the dialog.
//
// Usage: node scripts/noise-info-modal-test.mjs   (BABBLA_URL from the e2e harness)
import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-${Math.random().toString(36).slice(2, 10)}`;
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome-stable";

const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? ` — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function join(page) {
  await page.waitForSelector("#name-input", { timeout: 10000 });
  await page.type("#name-input", "Tester");
  await page.click("#join-btn");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 10000 });
  await sleep(400);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

try {
  const page = await browser.newPage();
  // The app suppresses the onboarding auto-show under automation (navigator.
  // webdriver). Spoof it false so this test exercises the real first-visit path.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      configurable: true,
      get: () => false,
    });
  });
  await page.goto(URL, { waitUntil: "networkidle2" });

  // The modal must NOT be open before joining.
  const openBeforeJoin = await page.evaluate(() => document.getElementById("info-dialog").open);
  check("modal closed before join", openBeforeJoin === false);

  // DOM order: macOS Voice Isolation is the 2nd <section> regardless of platform.
  const viOrder = await page.evaluate(() => {
    const secs = [...document.querySelectorAll("#info-dialog .dialog-content section")];
    return { index: secs.findIndex((s) => s.id === "macos-voice-isolation"), count: secs.length };
  });
  check("VI section is 2nd in the dialog", viOrder.index === 1, `index=${viOrder.index}/${viOrder.count}`);

  await join(page);

  const afterFirstJoin = await page.evaluate(() => ({
    open: document.getElementById("info-dialog").open,
    seen: localStorage.getItem("babbla:infoSeen"),
  }));
  check("modal auto-opens on first join", afterFirstJoin.open === true);
  check("'seen' flag is set on open", afterFirstJoin.seen === "1");

  // Reload (storage persists) and rejoin: the modal must NOT auto-open again.
  await page.reload({ waitUntil: "networkidle2" });
  await join(page);
  const afterSecondJoin = await page.evaluate(() => document.getElementById("info-dialog").open);
  check("modal does NOT auto-open once seen", afterSecondJoin === false);

  const passed = results.every(Boolean);
  console.log(`VERDICT: ${passed ? "PASS" : "FAIL"} (${results.filter(Boolean).length}/${results.length})`);
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
