// Verify the two responsive camera-grid changes:
//  1. Desktop focus mode: narrow sidebar (<200px) => one camera tile per row.
//  2. Mobile gallery (nothing focused): cameras render two-up (auto-fit 140px).
import puppeteer from "puppeteer-core";

const URL = "http://localhost:8080/";
const OUT = "/opt/cursor/artifacts";
const CHROME = "/usr/bin/google-chrome-stable";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launchArgs(w, h) {
  return {
    executablePath: CHROME,
    headless: false,
    args: [
      "--no-sandbox",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--window-size=${w},${h}`,
    ],
  };
}

async function newClient(name, w, h) {
  const browser = await puppeteer.launch(launchArgs(w, h));
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  return { browser, page };
}

const tileRects = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#video-grid .video-tile")].map((t) => {
      const r = t.getBoundingClientRect();
      return {
        name: t.querySelector(".video-tile-name")?.textContent,
        x: Math.round(r.x),
        w: Math.round(r.width),
        y: Math.round(r.y),
      };
    }),
  );

// Count distinct x positions = columns.
const colCount = (rects) => new Set(rects.map((r) => r.x)).size;

(async () => {
  let pass = true;

  // ---- Mobile gallery: phone viewport, 2 cameras, nothing focused ----
  const PW = 390, PH = 844;
  const m = [];
  for (const n of ["Mob-A", "Mob-B"]) {
    m.push(await newClient(n, PW, PH));
    await sleep(1200);
  }
  try {
    for (const c of m) await c.page.click("#camera-btn");
    await sleep(8000);
    const info = await m[0].page.evaluate(() => ({
      room: document.getElementById("room-view").className,
      grid: getComputedStyle(document.getElementById("video-grid")).gridTemplateColumns,
    }));
    const rects = await tileRects(m[0].page);
    const cols = colCount(rects);
    console.log("MOBILE gallery room:", info.room);
    console.log("MOBILE grid-template-columns:", info.grid);
    console.log("MOBILE tile rects:", JSON.stringify(rects));
    console.log("MOBILE columns:", cols);
    const okMobile = info.room.includes("gallery") && cols === 2;
    console.log("MOBILE 2-up:", okMobile ? "PASS" : "FAIL");
    pass &&= okMobile;
    await m[0].page.screenshot({ path: `${OUT}/mobile_gallery_2up.png` });
  } finally {
    for (const c of m) await c.browser.close();
  }

  await sleep(1500);

  // ---- Desktop focus: 2 cameras, focus a peer, narrow the sidebar ----
  const DW = 1600, DH = 900;
  const d = [];
  for (const n of ["Desk-A", "Desk-B"]) {
    d.push(await newClient(n, DW, DH));
    await sleep(1200);
  }
  try {
    for (const c of d) await c.page.click("#camera-btn");
    await sleep(8000);
    // Focus the remote camera tile to enter expanded/stage layout.
    await d[0].page.evaluate(() => {
      const t = [...document.querySelectorAll("#video-grid .video-tile.has-video")]
        .find((el) => !el.classList.contains("self"));
      t?.click();
    });
    await sleep(1500);

    // Wide sidebar first (control): expect 2 columns.
    await d[0].page.evaluate(() =>
      document.getElementById("room-view").style.setProperty("--sidebar-width", "360px"),
    );
    await sleep(600);
    const wideRects = await tileRects(d[0].page);
    const wideCols = colCount(wideRects);
    console.log("DESKTOP wide(360px) columns:", wideCols, JSON.stringify(wideRects));
    await d[0].page.screenshot({ path: `${OUT}/desktop_sidebar_wide.png` });

    // Narrow sidebar below 200px: expect 1 column.
    await d[0].page.evaluate(() =>
      document.getElementById("room-view").style.setProperty("--sidebar-width", "180px"),
    );
    await sleep(600);
    const narrowInfo = await d[0].page.evaluate(() => ({
      grid: getComputedStyle(document.getElementById("video-grid")).gridTemplateColumns,
      railW: Math.round(document.querySelector(".sidebar-rail").getBoundingClientRect().width),
    }));
    const narrowRects = await tileRects(d[0].page);
    const narrowCols = colCount(narrowRects);
    console.log("DESKTOP narrow(180px) rail width:", narrowInfo.railW);
    console.log("DESKTOP narrow grid-template-columns:", narrowInfo.grid);
    console.log("DESKTOP narrow columns:", narrowCols, JSON.stringify(narrowRects));
    const okDesktop = wideCols === 2 && narrowCols === 1;
    console.log("DESKTOP single-col-when-narrow:", okDesktop ? "PASS" : "FAIL");
    pass &&= okDesktop;
    await d[0].page.screenshot({ path: `${OUT}/desktop_sidebar_narrow.png` });
  } finally {
    for (const c of d) await c.browser.close();
  }

  console.log("\nRESULT:", pass ? "ALL PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
})();
