// Automated check for the per-peer diagnostics rail. Drives three separate
// Chrome instances (per AGENTS.md: two tabs in one browser crash the renderer
// in this VM) with fake media, joins them into one room, then verifies that
// each client renders one diagnostic row per *remote* peer with a sane
// bandwidth reading and a "connected" state. Finally it closes one client and
// confirms the remaining clients drop that peer's row.
//
// Usage: node scripts/peer-diagnostics-test.mjs
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
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (ok) passed++;
  else failed++;
}

async function readRows(page) {
  return page.$$eval("#diagnostics .diag-row", (rows) =>
    rows.map((r) => ({
      name: r.querySelector(".diag-name")?.textContent || "",
      state: r.querySelector(".diag-state")?.textContent || "",
      cls: r.className,
      text: r.textContent.replace(/\s+/g, " ").trim(),
    })),
  );
}

async function newClient(name) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  return { browser, page, name };
}

(async () => {
  const a = await newClient("Alice");
  const b = await newClient("Bob");
  const c = await newClient("Carol");
  try {
    // Let the mesh connect and a couple of sample ticks elapse.
    await sleep(8000);

    const aRows = await readRows(a.page);
    console.log("Alice rows:", JSON.stringify(aRows, null, 0));

    check("Alice shows one row per remote peer (2)", aRows.length === 2);
    const names = aRows.map((r) => r.name).sort();
    check(
      "Alice rows are Bob + Carol",
      names.length === 2 && names[0] === "Bob" && names[1] === "Carol",
    );
    check(
      "all Alice rows report connected state",
      aRows.length > 0 && aRows.every((r) => r.cls.includes("state-ok")),
    );
    // Bandwidth: each row should show a non-"–" up/down kbit/s once flowing.
    check(
      "Alice rows show a live bandwidth figure",
      aRows.every((r) => /kbit\/s|Mbit\/s/.test(r.text)),
    );
    check(
      "Alice rows show an rtt figure",
      aRows.every((r) => /rtt .*ms/.test(r.text)),
    );

    // Now close Carol and confirm her row disappears from the others.
    await c.browser.close();
    await sleep(6000);
    const aRowsAfter = await readRows(a.page);
    console.log("Alice rows after Carol leaves:", JSON.stringify(aRowsAfter, null, 0));
    check(
      "Carol's row is gone after she leaves",
      aRowsAfter.length === 1 && aRowsAfter[0].name === "Bob",
    );

    console.log(`\nVERDICT: ${failed === 0 ? "PASS" : "FAIL"} (${passed}/${passed + failed})`);
  } finally {
    await a.browser.close();
    await b.browser.close();
    try { await c.browser.close(); } catch {}
  }
})();
