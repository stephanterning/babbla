// Relay (coturn) fallback e2e. Proves the selective-TURN behavior end-to-end:
//
//   - With TURN configured (server hands ephemeral HMAC creds in `welcome`),
//     two clients FORCED onto the relay path (iceTransportPolicy: "relay")
//     still connect and exchange media — i.e. the relay fallback works.
//   - The relayed peer is flagged in the UI (purple "connection-relayed" tile).
//   - Focusing a *relayed* peer's camera does NOT boost it: the per-peer send
//     stays at standard (250 kbps), so the high-bitrate stream never flows
//     through the relay. (Contrast: camera-focus-quality-test.mjs shows a
//     *direct* focuser DOES get boosted to 2.5 Mbps.)
//
// Self-contained: boots its own coturn (turnserver) + a babbla server wired to
// it via TURN_SECRET/TURN_URLS, then two separate Chrome instances (two tabs in
// one browser crash the renderer in this VM — see AGENTS.md). coturn here allows
// loopback peers so relay works on a single host; production denies them (that
// hardening belongs to the TURN operator, not app behavior).
import { spawn, spawnSync } from "node:child_process";
import puppeteer from "puppeteer-core";

// coturn (turnserver) is required for this suite. Skip gracefully where it
// isn't installed so `npm run e2e` stays green on a vanilla box (install with
// `apt-get install coturn`).
if (spawnSync("turnserver", ["-h"]).error) {
  console.log("SKIP relay-fallback-test: turnserver (coturn) not installed");
  process.exit(0);
}

const SECRET = "relay-e2e-secret";
// Overridable so a host that already has something on 3478 (a local coturn, a
// parallel run, a shared CI box) can run the suite without a port clash.
const TURN_PORT = Number(process.env.RELAY_E2E_TURN_PORT) || 3478;
const TURN_MIN = Number(process.env.RELAY_E2E_TURN_MIN) || 49200;
const TURN_MAX = Number(process.env.RELAY_E2E_TURN_MAX) || 49260;
const APP_PORT = Number(process.env.RELAY_E2E_PORT) || 8092;
const ROOM = `relay-${Math.random().toString(36).slice(2, 8)}`;
const URL = `http://localhost:${APP_PORT}/room/${ROOM}`;
const W = 1100;
const H = 760;

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

// Force every RTCPeerConnection onto the relay path so the only way to connect
// is via coturn — and collect the PCs so we can read the camera sender + stats.
const HOOK = `
  window.__pcs = [];
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (cfg, ...rest) {
    const merged = Object.assign({}, cfg || {}, { iceTransportPolicy: "relay" });
    const pc = new OrigPC(merged, ...rest);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;
`;

// Same relay-forcing hook, but strip candidateType from getStats() reports so
// transportFromPair returns "unknown" (pair_unresolved) instead of "relay".
// Proves HD boost stays blocked on a relay link even when classification fails.
const HOOK_STRIP_CANDIDATES = `
  window.__pcs = [];
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (cfg, ...rest) {
    const merged = Object.assign({}, cfg || {}, { iceTransportPolicy: "relay" });
    const pc = new OrigPC(merged, ...rest);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;
  const origGetStats = RTCPeerConnection.prototype.getStats;
  RTCPeerConnection.prototype.getStats = async function (...args) {
    const stats = await origGetStats.apply(this, args);
    const out = new Map();
    for (const [k, r] of stats.entries()) {
      const copy = Object.assign({}, r);
      if (copy.type === "local-candidate" || copy.type === "remote-candidate") {
        delete copy.candidateType;
      }
      out.set(k, copy);
    }
    return out;
  };
`;

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

async function newClient(name, hook = HOOK) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(hook);
  await page.setViewport({ width: W, height: H });
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 15000 });
  return { browser, page };
}

function cameraSenderInfo(page) {
  return page.evaluate(() => {
    for (const pc of window.__pcs) {
      for (const s of pc.getSenders()) {
        if (!s.track || s.track.kind !== "video") continue;
        const enc = s.getParameters().encodings?.[0] || {};
        const st = s.track.getSettings();
        return { maxBitrate: enc.maxBitrate ?? null, height: st.height ?? null };
      }
    }
    return null;
  });
}

// Read the selected candidate pair's candidate types (to confirm the path is
// actually relayed, not just that we asked for it).
function pcTransport(page) {
  return page.evaluate(async () => {
    for (const pc of window.__pcs) {
      const stats = await pc.getStats();
      let pairId = null;
      for (const r of stats.values()) {
        if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      }
      let pair = pairId ? stats.get(pairId) : null;
      if (!pair) {
        for (const r of stats.values()) {
          if (r.type === "candidate-pair" && (r.nominated || r.selected) && r.state === "succeeded") {
            pair = r;
            break;
          }
        }
      }
      if (!pair) continue;
      const lc = pair.localCandidateId ? stats.get(pair.localCandidateId) : null;
      const rc = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : null;
      return { local: lc?.candidateType ?? null, remote: rc?.candidateType ?? null };
    }
    return null;
  });
}

function tileState(page, name) {
  return page.evaluate((n) => {
    const tiles = [...document.querySelectorAll(".video-tile")];
    const t = tiles.find(
      (el) =>
        !el.classList.contains("screen-tile") &&
        !el.classList.contains("self") &&
        el.querySelector(".video-tile-name")?.textContent?.trim() === n,
    );
    if (!t) return { found: false };
    return {
      found: true,
      relayed: t.classList.contains("connection-relayed"),
      hasVideo: t.classList.contains("has-video"),
    };
  }, name);
}

function clickTileByName(page, name) {
  return page.evaluate((n) => {
    const t = [...document.querySelectorAll(".video-tile")].find(
      (el) =>
        !el.classList.contains("screen-tile") &&
        !el.classList.contains("self") &&
        el.querySelector(".video-tile-name")?.textContent?.trim() === n,
    );
    if (!t) return false;
    t.click();
    return true;
  }, name);
}

function startCoturn() {
  const args = [
    "-n",
    "--no-tls",
    "--no-dtls",
    "--no-cli",
    `--listening-port=${TURN_PORT}`,
    "--listening-ip=127.0.0.1",
    "--relay-ip=127.0.0.1",
    `--min-port=${TURN_MIN}`,
    `--max-port=${TURN_MAX}`,
    "--use-auth-secret",
    `--static-auth-secret=${SECRET}`,
    "--realm=babbla.test",
    // Single-host test: the relayed peer's address IS loopback, so loopback
    // relaying must be allowed (coturn denies it by default; production keeps
    // that denial — the hardening belongs to the TURN operator, not app behavior).
    "--allow-loopback-peers",
    "--simple-log",
    "--log-file=/tmp/coturn-e2e.log",
  ];
  const proc = spawn("turnserver", args, { stdio: "ignore" });
  return proc;
}

function startServer() {
  return spawn("node", ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      TURN_SECRET: SECRET,
      TURN_URLS: `turn:127.0.0.1:${TURN_PORT}?transport=udp`,
    },
    stdio: "ignore",
  });
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${APP_PORT}/`);
      if (res.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

(async () => {
  const coturn = startCoturn();
  const server = startServer();
  let a, b;
  try {
    if (!(await waitForServer())) {
      console.error("relay-fallback: server never came up");
      process.exit(1);
    }
    await sleep(500); // let coturn finish binding

    a = await newClient("Alice");
    b = await newClient("Bob");
    await sleep(2000);

    // Both cameras on, then wait for the relayed link to come up + media flow.
    await a.page.click("#camera-btn");
    await b.page.click("#camera-btn");

    let aSeesBob = { found: false };
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      aSeesBob = await tileState(a.page, "Bob");
      if (aSeesBob.found && aSeesBob.hasVideo && aSeesBob.relayed) break;
    }

    // The forced relay path actually connected and carries media.
    check("Alice sees Bob's tile", aSeesBob.found, aSeesBob);
    check("Bob's camera media flows over the relay", aSeesBob.hasVideo, aSeesBob);

    const transport = await pcTransport(a.page);
    check(
      "selected candidate pair is a relay pair",
      transport && (transport.local === "relay" || transport.remote === "relay"),
      transport,
    );

    // The relay UI indicator (purple border) shows on the relayed peer's tile.
    check("Bob's tile is flagged relayed (UI indicator)", aSeesBob.relayed, aSeesBob);
    const bSeesAlice = await tileState(b.page, "Alice");
    check("Alice's tile is flagged relayed on Bob's side", bSeesAlice.relayed, bSeesAlice);

    // The crux: Alice focuses Bob's camera. Because the A<->B link is RELAYED,
    // Bob must NOT boost — the send stays at standard (250 kbps), capture 360p.
    const focused = await clickTileByName(a.page, "Bob");
    check("Alice focused Bob", focused, { focused });
    await sleep(4000);

    const info = await cameraSenderInfo(b.page);
    // Not boosted: the send cap is standard (null until a post-negotiation
    // setParameters sticks, or 250 kbps) — crucially never the 2.5 Mbps boost a
    // *direct* focuser gets (see camera-focus-quality-test.mjs). The capture
    // staying 360p is the real guarantee that no 1080p stream is produced.
    check(
      "relayed focuser is NOT boosted (never 2.5 Mbps)",
      info && info.maxBitrate !== 2_500_000,
      info,
    );
    check("relayed camera capture stays 360p (no 1080p bump)", info?.height === 360, info);

    // --- Relay link with unclassified transport (missing candidate reports) ----
    // Must still block HD boost — the TURN policy can't rely on "connected".
    await a.browser.close();
    await b.browser.close();
    a = await newClient("Alice", HOOK_STRIP_CANDIDATES);
    b = await newClient("Bob", HOOK_STRIP_CANDIDATES);
    await sleep(2000);
    await a.page.click("#camera-btn");
    await b.page.click("#camera-btn");
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      aSeesBob = await tileState(a.page, "Bob");
      if (aSeesBob.found && aSeesBob.hasVideo) break;
    }
    check("unknown-transport relay: Alice sees Bob's camera", aSeesBob.found && aSeesBob.hasVideo, aSeesBob);
    const focusedStrip = await clickTileByName(a.page, "Bob");
    check("unknown-transport relay: Alice focused Bob", focusedStrip, { focusedStrip });
    await sleep(4000);
    const infoStrip = await cameraSenderInfo(b.page);
    check(
      "unknown-transport relay: NOT boosted (never 2.5 Mbps)",
      infoStrip && infoStrip.maxBitrate !== 2_500_000,
      infoStrip,
    );
    check(
      "unknown-transport relay: capture stays 360p",
      infoStrip?.height === 360,
      infoStrip,
    );
  } catch (err) {
    console.error("relay-fallback: error", err);
    fail++;
  } finally {
    try { await a?.browser.close(); } catch {}
    try { await b?.browser.close(); } catch {}
    try { server.kill("SIGTERM"); } catch {}
    try { coturn.kill("SIGTERM"); } catch {}
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})();
