// Stage fit: the whole shared frame must stay visible.
//
// The fullscreen overlay clips (`overflow: hidden`) and the stage video used to
// size itself from its own intrinsic aspect ratio at full width, so any source
// that was not exactly as wide-screen as the display overflowed the viewport
// and lost its bottom edge. A 16:9 share on a 16:9 display fit by coincidence,
// which is why this only bit "sometimes".
//
// Drives a real two-peer share (getDisplayMedia stubbed with a canvas of a
// chosen size, corner markers drawn so a screenshot shows any clipping) and
// asserts, for both the expanded stage and the fullscreen overlay, that the
// letterboxed frame lands entirely inside the viewport — and that it is
// actually scaled up to fill it, not shrunk to a thumbnail.
import puppeteer from "puppeteer-core";

const URL =
  process.env.BABBLA_URL ||
  `http://localhost:8080/room/test-${Math.random().toString(36).slice(2, 10)}`;
const W = Number(process.env.STAGE_FIT_W || 1600);
const H = Number(process.env.STAGE_FIT_H || 900);
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

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS ${label}`);
  } else {
    fail++;
    console.log(`FAIL ${label} -> ${JSON.stringify(detail)}`);
  }
}

async function newClient(name, { fakeShare } = {}) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  if (fakeShare) {
    await page.evaluateOnNewDocument(() => {
      window.__shareSize = { w: 1280, h: 1024 };
      navigator.mediaDevices.getDisplayMedia = async () => {
        const { w, h } = window.__shareSize;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        const marker = Math.round(Math.min(w, h) * 0.12);
        let tick = 0;
        const draw = () => {
          tick++;
          ctx.fillStyle = "#101828";
          ctx.fillRect(0, 0, w, h);
          // Corner markers: if any is missing from a screenshot, the frame is
          // being clipped rather than letterboxed.
          const corners = [
            ["#22c55e", 0, 0],
            ["#f59e0b", w - marker, 0],
            ["#ef4444", 0, h - marker],
            ["#3b82f6", w - marker, h - marker],
          ];
          for (const [color, x, y] of corners) {
            ctx.fillStyle = color;
            ctx.fillRect(x, y, marker, marker);
          }
          ctx.fillStyle = tick % 2 ? "#ffffff" : "#e2e8f0";
          ctx.font = `${Math.round(Math.min(w, h) / 8)}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(`${w}x${h}`, w / 2, h / 2);
        };
        draw();
        setInterval(draw, 100);
        return canvas.captureStream(15);
      };
    });
  }
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  return { browser, page };
}

// What the viewer actually sees: the element box, plus the letterboxed content
// rect derived from the frame's intrinsic size and `object-fit`.
const measure = (page) =>
  page.evaluate(() => {
    const v = document.getElementById("screen-video");
    const r = v.getBoundingClientRect();
    const iw = v.videoWidth;
    const ih = v.videoHeight;
    const fit = getComputedStyle(v).objectFit;
    const scale =
      fit === "contain"
        ? Math.min(r.width / iw, r.height / ih)
        : Math.max(r.width / iw, r.height / ih);
    const cw = iw * scale;
    const ch = ih * scale;
    return {
      intrinsic: [iw, ih],
      objectFit: fit,
      box: [Math.round(r.width), Math.round(r.height)],
      // The visible frame, in viewport coordinates.
      content: {
        left: Math.round(r.left + (r.width - cw) / 2),
        top: Math.round(r.top + (r.height - ch) / 2),
        right: Math.round(r.left + (r.width + cw) / 2),
        bottom: Math.round(r.top + (r.height + ch) / 2),
        width: Math.round(cw),
        height: Math.round(ch),
      },
      viewport: [innerWidth, innerHeight],
      pageScrollY: Math.max(
        0,
        document.documentElement.scrollHeight - innerHeight,
      ),
    };
  });

function assertFits(label, m, { fillsViewport }) {
  const eps = 2;
  const inside =
    m.content.left >= -eps &&
    m.content.top >= -eps &&
    m.content.right <= m.viewport[0] + eps &&
    m.content.bottom <= m.viewport[1] + eps;
  check(`${label}: whole frame inside the viewport`, inside, m);
  check(`${label}: aspect ratio preserved`, m.objectFit === "contain", m);
  if (fillsViewport) {
    // contain against the viewport means one axis is maxed out.
    const maxed =
      m.content.width >= m.viewport[0] - eps ||
      m.content.height >= m.viewport[1] - eps;
    check(`${label}: frame scaled up to fill the screen`, maxed, m);
    check(`${label}: no page scroll behind the overlay`, m.pageScrollY <= 1, m);
  }
}

(async () => {
  const viewer = await newClient("Viewer");
  const sharer = await newClient("Sharer", { fakeShare: true });
  try {
    await sleep(4000);

    for (const [w, h, name] of [
      [1280, 1024, "5:4 monitor"],
      [720, 1280, "portrait"],
      [1920, 1080, "16:9"],
    ]) {
      await sharer.page.evaluate(
        (size) => {
          window.__shareSize = size;
        },
        { w, h },
      );
      await sharer.page.click("#share-btn");
      await sleep(4000);

      await viewer.page.waitForFunction(
        () => {
          const v = document.getElementById("screen-video");
          return v && v.videoWidth > 0 && !document.getElementById("screen-wrap").hidden;
        },
        { timeout: 20000 },
      );
      await sleep(1000);

      const expanded = await measure(viewer.page);
      assertFits(`${name} expanded stage`, expanded, { fillsViewport: false });

      await viewer.page.click("#fullscreen-btn");
      await sleep(1200);
      const fs = await measure(viewer.page);
      assertFits(`${name} fullscreen`, fs, { fillsViewport: true });
      check(
        `${name} fullscreen: frame matches source aspect ratio`,
        Math.abs(fs.content.width / fs.content.height - w / h) < 0.02,
        fs,
      );

      // STAGE_FIT_SHOTS=<dir> also drops a screenshot per source ratio; the
      // corner markers make clipping obvious to the eye.
      if (process.env.STAGE_FIT_SHOTS) {
        await viewer.page.screenshot({
          path: `${process.env.STAGE_FIT_SHOTS}/stage-fit-${w}x${h}.png`,
        });
      }

      await viewer.page.keyboard.press("Escape");
      await sleep(600);
      await sharer.page.click("#share-btn");
      await sleep(2000);
    }
  } finally {
    await viewer.browser.close();
    await sharer.browser.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
