import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-${Math.random().toString(36).slice(2, 10)}`;
const LAUNCH = {
  executablePath: "/usr/bin/google-chrome-stable",
  headless: false,
  args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newClient(name) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 800 });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  return { browser, page };
}

(async () => {
  const a = await newClient("Alice");
  const b = await newClient("Bob");
  const c = await newClient("Carol");
  try {
    await sleep(8000);
    await a.page.screenshot({ path: "/opt/cursor/artifacts/peer_diagnostics_rail.png" });
    console.log("saved");
  } finally {
    await a.browser.close();
    await b.browser.close();
    await c.browser.close();
  }
})();
