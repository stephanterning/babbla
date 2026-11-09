// Screenshot helper for the relay (TURN) UI indicator. Boots its own coturn +
// a babbla server wired to it, joins two clients FORCED onto the relay path,
// turns cameras on, and captures: (1) the room with the relayed peer's purple
// border, and (2) the info-modal color legend. Saves to /opt/cursor/artifacts.
// Run: DISPLAY=:1 node scripts/relay-border-screenshot.mjs
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const SECRET = "relay-shot-secret";
const TURN_PORT = Number(process.env.RELAY_SHOT_TURN_PORT) || 3478;
const APP_PORT = Number(process.env.RELAY_SHOT_PORT) || 8093;
const ROOM = `relayshot-${Math.random().toString(36).slice(2, 8)}`;
const URL = `http://localhost:${APP_PORT}/room/${ROOM}`;
const OUT = "/opt/cursor/artifacts";
const W = 1200;
const H = 820;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const HOOK = `
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (cfg, ...rest) {
    return new OrigPC(Object.assign({}, cfg || {}, { iceTransportPolicy: "relay" }), ...rest);
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;
`;

async function newClient(name) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(HOOK);
  await page.setViewport({ width: W, height: H });
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 15000 });
  return { browser, page };
}

function tileRelayed(page, name) {
  return page.evaluate((n) => {
    const t = [...document.querySelectorAll(".video-tile")].find(
      (el) =>
        !el.classList.contains("screen-tile") &&
        !el.classList.contains("self") &&
        el.querySelector(".video-tile-name")?.textContent?.trim() === n,
    );
    return t ? t.classList.contains("connection-relayed") && t.classList.contains("has-video") : false;
  }, name);
}

function startCoturn() {
  return spawn(
    "turnserver",
    [
      "-n", "--no-tls", "--no-dtls", "--no-cli",
      `--listening-port=${TURN_PORT}`, "--listening-ip=127.0.0.1", "--relay-ip=127.0.0.1",
      "--min-port=49200", "--max-port=49260",
      "--use-auth-secret", `--static-auth-secret=${SECRET}`, "--realm=babbla.test",
      "--allow-loopback-peers", "--simple-log", "--log-file=/tmp/coturn-shot.log",
    ],
    { stdio: "ignore" },
  );
}
function startServer() {
  return spawn("node", ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(APP_PORT), TURN_SECRET: SECRET, TURN_URLS: `turn:127.0.0.1:${TURN_PORT}?transport=udp` },
    stdio: "ignore",
  });
}
async function waitForServer(t = 15000) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    try { if ((await fetch(`http://localhost:${APP_PORT}/`)).ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const coturn = startCoturn();
  const server = startServer();
  let a, b;
  try {
    if (!(await waitForServer())) throw new Error("server never came up");
    await sleep(500);
    a = await newClient("Alice");
    b = await newClient("Bob");
    await sleep(2000);
    await a.page.click("#camera-btn");
    await b.page.click("#camera-btn");

    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await sleep(1000);
      ready = await tileRelayed(a.page, "Bob");
    }
    console.log("relay border visible on Alice's view:", ready);
    await sleep(800);
    await a.page.screenshot({ path: `${OUT}/relay_border_tiles.png` });

    // Info-modal color legend.
    await a.page.click(".sidebar-rail .info-btn");
    await sleep(500);
    await a.page.screenshot({ path: `${OUT}/relay_legend.png` });
    console.log("screenshots saved to", OUT);
  } catch (err) {
    console.error("screenshot error", err);
  } finally {
    try { await a?.browser.close(); } catch {}
    try { await b?.browser.close(); } catch {}
    try { server.kill("SIGTERM"); } catch {}
    try { coturn.kill("SIGTERM"); } catch {}
  }
  process.exit(0);
})();
