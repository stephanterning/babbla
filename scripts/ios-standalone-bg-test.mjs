// e2e for the iOS home-screen ("standalone") background-audio caveat in the info
// modal. Home-screen web apps on iOS get the mic MUTED by the OS in the
// background (a WebKit/iOS limitation; a Safari tab keeps it alive). As of iOS
// 26 every site added to the Home Screen defaults to standalone, so we surface
// the caveat + Safari workaround — but ONLY when actually running standalone on
// iOS (navigator.standalone === true). This guards that gating:
//   - iOS + standalone   -> section shown
//   - iOS + Safari tab   -> section hidden
//   - desktop            -> section hidden
//
// Usage: node scripts/ios-standalone-bg-test.mjs   (BABBLA_URL from the e2e harness)
import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-${Math.random().toString(36).slice(2, 10)}`;
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome-stable";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? ` — ${extra}` : ""}`);
};

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

// Load the lobby under a given UA + spoofed navigator.standalone and read whether
// the caveat section is hidden. No WebRTC, so a fresh page per case is cheap/safe.
async function sectionHidden({ ua, standalone }) {
  const page = await browser.newPage();
  try {
    if (ua) await page.setUserAgent(ua);
    await page.evaluateOnNewDocument((sa) => {
      if (sa !== undefined) {
        Object.defineProperty(navigator, "standalone", { configurable: true, get: () => sa });
      }
    }, standalone);
    await page.goto(URL, { waitUntil: "networkidle2" });
    return await page.evaluate(() => document.getElementById("ios-standalone-bg").hidden);
  } finally {
    await page.close();
  }
}

try {
  const standalone = await sectionHidden({ ua: IPHONE_UA, standalone: true });
  const safariTab = await sectionHidden({ ua: IPHONE_UA, standalone: false });
  const desktop = await sectionHidden({ ua: undefined, standalone: undefined });

  check("iOS home-screen (standalone): caveat shown", standalone === false, `hidden=${standalone}`);
  check("iOS Safari tab: caveat hidden", safariTab === true, `hidden=${safariTab}`);
  check("desktop: caveat hidden", desktop === true, `hidden=${desktop}`);

  const passed = results.every(Boolean);
  console.log(`VERDICT: ${passed ? "PASS" : "FAIL"} (${results.filter(Boolean).length}/${results.length})`);
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
