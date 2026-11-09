// Demonstrate the wide "gallery" compact layout: cameras on but nothing pinned
// to the stage. Captures the new full-width gallery and, for contrast, the old
// narrow single-column look (simulated by swapping the layout classes back).
import puppeteer from "puppeteer-core";

const URL = "http://localhost:8080/";
const OUT = "/opt/cursor/artifacts";
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

(async () => {
  const clients = [];
  for (const name of ["Alice", "Bob", "Carol"]) {
    clients.push(await newClient(name));
    await sleep(1200);
  }
  const a = clients[0];
  try {
    // Everyone turns the camera on; wait for media + reconcile.
    for (const c of clients) await c.page.click("#camera-btn");
    await sleep(9000);

    const info = await a.page.evaluate(() => ({
      bodyClass: document.body.className,
      roomClass: document.getElementById("room-view").className,
      appWidth: document.querySelector(".app").getBoundingClientRect().width,
      tiles: document.querySelectorAll(".video-tile").length,
      withVideo: document.querySelectorAll(".video-tile.has-video").length,
    }));
    console.log("AFTER (gallery):", JSON.stringify(info));
    const rects = await a.page.evaluate(() =>
      [...document.querySelectorAll(".video-tile")].map((t) => {
        const r = t.getBoundingClientRect();
        return {
          name: t.querySelector(".video-tile-name")?.textContent,
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      }),
    );
    console.log("TILE RECTS:", JSON.stringify(rects));

    await a.page.screenshot({ path: `${OUT}/gallery_wide_after.png` });

    // Simulate the OLD behaviour at the same viewport: narrow single column.
    await a.page.evaluate(() => {
      const rv = document.getElementById("room-view");
      document.body.classList.remove("room-gallery");
      document.body.classList.add("room-compact");
      rv.classList.remove("gallery");
    });
    await sleep(500);
    const before = await a.page.evaluate(
      () => document.querySelector(".app").getBoundingClientRect().width,
    );
    console.log("BEFORE (narrow) appWidth:", before);
    await a.page.screenshot({ path: `${OUT}/gallery_narrow_before.png` });
  } finally {
    for (const c of clients) await c.browser.close();
  }
})();
