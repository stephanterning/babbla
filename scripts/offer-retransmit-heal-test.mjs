// Regression test for the offer-retransmit watchdog (mesh.js).
//
// Root cause it guards: a lost FIRST offer used to wedge a mesh pair forever —
// the impolite offerer sat in "have-local-offer", the polite peer suppressed its
// own initial offer and waited for one that never arrived, ICE never started, so
// the failed/disconnected ICE-restart recovery never fired. Symptom: a late
// joiner sees one camera-on peer but never another ("presence but no media").
//
// Here PeerA + PeerB have cameras on; PeerA drops ALL its outbound SDP
// descriptions while PeerC joins (forcing the lost offer). With the watchdog,
// PeerA re-sends the offer after the drop window and PeerC's view of PeerA's
// camera heals on its own — no counter-renegotiation, no page reload.
import puppeteer from "puppeteer-core";

const ROOM = `heal-${Math.random().toString(36).slice(2, 8)}`;
const URL =
  process.env.BABBLA_URL || `http://localhost:8080/room/${ROOM}`;
const W = 1000, H = 720;
const INJECT = `
window.__ws = { dropActive:false, dropped:0 };
(() => {
  const OrigSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      if (typeof data === "string") {
        const msg = JSON.parse(data);
        const isDesc = msg && msg.type === "signal" && msg.data && msg.data.description;
        if (window.__ws.dropActive && isDesc) { window.__ws.dropped++; return; }
      }
    } catch {}
    return OrigSend.call(this, data);
  };
})();
`;
const LAUNCH = {
  executablePath: "/usr/bin/google-chrome-stable",
  headless: false,
  args: ["--no-sandbox", "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream", `--window-size=${W},${H}`],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newClient(name) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(INJECT);
  await page.setViewport({ width: W, height: H });
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 15000 });
  return { browser, page, name };
}
function tileHasVideo(page, name) {
  return page.evaluate((n) => {
    const tile = [...document.querySelectorAll(".video-tile")].find((el) =>
      !el.classList.contains("screen-tile") && !el.classList.contains("self") &&
      el.querySelector(".video-tile-name")?.textContent?.trim() === n);
    return tile ? tile.classList.contains("has-video") : false;
  }, name);
}
// Poll until `name`'s camera tile shows video, or timeout.
async function waitForVideo(page, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tileHasVideo(page, name)) return true;
    await sleep(1500);
  }
  return false;
}

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`PASS ${label}`); }
  else { fail++; console.log(`FAIL ${label} -> ${JSON.stringify(detail)}`); }
};

(async () => {
  console.log(`room: ${URL}`);
  const a = await newClient("PeerA");
  const b = await newClient("PeerB");
  let c;
  try {
    await sleep(2500);
    await a.page.click("#camera-btn");
    await b.page.click("#camera-btn");
    await sleep(6000);
    // Force PeerA's offer to the late joiner to be lost.
    await a.page.evaluate(() => { window.__ws.dropActive = true; window.__ws.dropped = 0; });
    c = await newClient("PeerC");
    await sleep(7000);
    await a.page.evaluate(() => { window.__ws.dropActive = false; });
    const dropped = await a.page.evaluate(() => window.__ws.dropped);

    check("forced a lost offer (PeerA dropped >=1 description)", dropped >= 1, { dropped });
    check("mesh works: PeerC sees PeerB camera", await tileHasVideo(c.page, "PeerB"));
    const wedgedAtFirst = !(await tileHasVideo(c.page, "PeerA"));
    console.log(`(info) PeerC wedged on PeerA right after drop window: ${wedgedAtFirst}`);

    // The watchdog must heal PeerC's view of PeerA's camera on its own.
    const healed = await waitForVideo(c.page, "PeerA", 25000);
    check("watchdog heals: PeerC eventually sees PeerA camera", healed);
    check("PeerC still sees PeerB camera after heal", await tileHasVideo(c.page, "PeerB"));
  } finally {
    await a.browser.close();
    await b.browser.close();
    if (c) await c.browser.close();
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})();
