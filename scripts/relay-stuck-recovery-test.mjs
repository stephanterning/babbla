// Regression test for "peers on networks that need the relay get stuck on
// 'ansluter'". Boots its own coturn + babbla so the relay can be broken and
// then repaired mid-test.
//
// The bug: both of the mesh's recovery mechanisms are armed from a *state
// transition* — the ICE-restart backoff from connectionState "failed"/
// "disconnected", the offer retransmit from signalingState "have-local-offer".
// A pair whose only viable path is the relay reaches neither. When coturn
// refuses the allocation (401: TURN_SECRET != static-auth-secret) ICE gathering
// finishes with no usable candidate, so checking never starts: connectionState
// sits at "new" indefinitely, nothing retries, and the tile reads "ansluter"
// for the whole session. Measured before the fix: 2+ minutes at "new", zero
// state changes, nothing logged.
//
// After the fix:
//   1. The browser's `icecandidateerror` is captured, so the 401 is surfaced in
//      the UI (#ice-health) instead of being thrown away.
//   2. An initial-connect watchdog trips at 15 s: the pair is reported
//      "uncertain" (an honest badge, not a hopeful "ansluter") and handed to the
//      ICE-restart backoff.
//   3. Because the backoff re-runs gathering, the pair HEALS once the relay
//      works again — here by restarting coturn with the matching secret. On the
//      old code that pair stayed dead for the rest of the session.
//   4. A deployment with no TURN at all says so (#ice-health), so "stuck on
//      ansluter" can be told apart from "this server is STUN-only" without
//      shell access.
//
// A fourth case covers the failure mode that was found in production: a relay
// whose UDP port never answers at all. There the browser is no help in time —
// Chrome only declares "701 TURN allocate request timed out" after ~40 s of
// retransmits, while the watchdog starts restarting ICE at 15 s and every
// restart begins a fresh gathering. Measured against the real deployment:
// 3 minutes, 14 restarts, zero `icecandidateerror` events, empty health box.
// So the explanation must be derived from the candidates that were gathered.
import dgram from "node:dgram";
import { spawn, spawnSync } from "node:child_process";
import puppeteer from "puppeteer-core";

// coturn is required. Skip gracefully where it isn't installed so `npm run e2e`
// stays green on a vanilla box (install with `apt-get install coturn`).
if (spawnSync("turnserver", ["-h"]).error) {
  console.log("SKIP relay-stuck-recovery-test: turnserver (coturn) not installed");
  process.exit(0);
}

// The app's secret. coturn is started with a DIFFERENT one first (so every
// allocation is rejected 401), then restarted with this one (so the relay works).
const APP_SECRET = "stuck-recovery-app-secret";
const WRONG_SECRET = "stuck-recovery-coturn-secret";

const TURN_PORT = Number(process.env.STUCK_E2E_TURN_PORT) || 3479;
const TURN_MIN = Number(process.env.STUCK_E2E_TURN_MIN) || 49400;
const TURN_MAX = Number(process.env.STUCK_E2E_TURN_MAX) || 49460;
const APP_PORT = Number(process.env.STUCK_E2E_PORT) || 8097;
const NO_TURN_PORT = Number(process.env.STUCK_E2E_NO_TURN_PORT) || 8098;
// A TURN URL pointing at a socket that swallows every datagram — a hermetic
// stand-in for "the UDP port isn't forwarded to coturn".
const SILENT_TURN_APP_PORT = Number(process.env.STUCK_E2E_SILENT_APP_PORT) || 8099;
const SILENT_TURN_PORT = Number(process.env.STUCK_E2E_SILENT_TURN_PORT) || 3489;
const ROOM = `stuck-${Math.random().toString(36).slice(2, 8)}`;
const URL = `http://localhost:${APP_PORT}/room/${ROOM}`;
const NO_TURN_URL = `http://localhost:${NO_TURN_PORT}/room/${ROOM}`;
const SILENT_TURN_URL = `http://localhost:${SILENT_TURN_APP_PORT}/room/${ROOM}`;
const W = 1000;
const H = 760;

// The initial-connect watchdog fires at 15 s (mesh.js INITIAL_CONNECT_TIMEOUT_MS).
const WATCHDOG_MS = 15_000;

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

// Force every RTCPeerConnection onto the relay path (so a broken relay means no
// path at all — what a restrictive network looks like) and count restartIce()
// calls so the test can see the recovery actually running.
const HOOK = `
  window.__pcs = [];
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (cfg, ...rest) {
    const merged = Object.assign({}, cfg || {}, { iceTransportPolicy: "relay" });
    const pc = new OrigPC(merged, ...rest);
    pc.__restartIceCalls = 0;
    const realRestart = pc.restartIce && pc.restartIce.bind(pc);
    pc.restartIce = function () {
      pc.__restartIceCalls++;
      return realRestart ? realRestart() : undefined;
    };
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;
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

function startCoturn(secret) {
  return spawn(
    "turnserver",
    [
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
      `--static-auth-secret=${secret}`,
      "--realm=babbla.test",
      // Single-host test: the relayed peer's address IS loopback.
      "--allow-loopback-peers",
      "--simple-log",
      "--log-file=/tmp/coturn-stuck-e2e.log",
    ],
    { stdio: "ignore" },
  );
}

// `turn` selects which relay the app advertises: "working" (the test's coturn),
// "silent" (a socket that never answers), or false (STUN-only).
function startServer(port, turn) {
  const env = { ...process.env, PORT: String(port) };
  if (turn) {
    env.TURN_SECRET = APP_SECRET;
    env.TURN_URLS =
      turn === "silent"
        ? `turn:127.0.0.1:${SILENT_TURN_PORT}?transport=udp`
        : `turn:127.0.0.1:${TURN_PORT}?transport=udp`;
  } else {
    delete env.TURN_SECRET;
    delete env.TURN_URLS;
  }
  return spawn("node", ["server.js"], { cwd: process.cwd(), env, stdio: "ignore" });
}

// Binds the "TURN" port and drops everything sent to it, so an Allocate is
// never answered and never refused — the production symptom.
function startSilentTurn() {
  const sock = dgram.createSocket("udp4");
  sock.bind(SILENT_TURN_PORT, "127.0.0.1");
  return sock;
}

async function waitForServer(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://localhost:${port}/`)).ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

async function newClient(name, url = URL) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(HOOK);
  await page.setViewport({ width: W, height: H });
  await page.goto(url, { waitUntil: "networkidle2" });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 15_000 });
  return { browser, page };
}

function tileState(page, name) {
  return page.evaluate((n) => {
    const t = [...document.querySelectorAll(".video-tile")].find(
      (el) =>
        !el.classList.contains("screen-tile") &&
        !el.classList.contains("self") &&
        el.querySelector(".video-tile-name")?.textContent?.trim() === n,
    );
    if (!t) return { found: false };
    return {
      found: true,
      connecting: t.classList.contains("connection-connecting"),
      uncertain: t.classList.contains("connection-uncertain"),
      relayed: t.classList.contains("connection-relayed"),
    };
  }, name);
}

// The relay/ICE health box under the diagnostics rail.
function iceHealth(page) {
  return page.evaluate(() => {
    const box = document.getElementById("ice-health");
    if (!box) return { present: false };
    return { present: true, hidden: box.hidden, text: box.textContent || "" };
  });
}

function diagStateFor(page, name) {
  return page.evaluate((n) => {
    const row = [...document.querySelectorAll(".diag-row")].find(
      (el) => el.querySelector(".diag-name")?.textContent?.trim() === n,
    );
    if (!row) return null;
    return {
      state: row.querySelector(".diag-state")?.textContent?.trim() || "",
      title: row.getAttribute("title") || "",
    };
  }, name);
}

function restartIceCalls(page) {
  return page.evaluate(() =>
    window.__pcs.reduce((s, pc) => s + (pc.__restartIceCalls || 0), 0),
  );
}

// Screenshots of the diagnostic UI, for a walkthrough. Off unless a target
// directory is given (STUCK_E2E_SHOTS=/some/dir), so `npm run e2e` stays quiet.
const SHOT_DIR = process.env.STUCK_E2E_SHOTS || "";
async function shot(page, name) {
  if (!SHOT_DIR) return;
  // The share-onboarding bubble pops for whoever is alone in a named room and
  // sits right on top of the health box. Dismiss it so the shot shows the thing
  // it is meant to show. Capture-only: assertions read textContent, not pixels.
  await page.evaluate(() => {
    const bubble = document.getElementById("share-onboarding");
    if (bubble) bubble.hidden = true;
  });
  const path = `${SHOT_DIR}/${name}.png`;
  await page.screenshot({ path });
  console.log(`   shot: ${path}`);
}

// Poll until `predicate(state)` holds or the deadline passes; returns the last state.
async function waitFor(read, predicate, timeoutMs, stepMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(stepMs);
    last = await read();
  }
  return last;
}

(async () => {
  let coturn = startCoturn(WRONG_SECRET);
  const server = startServer(APP_PORT, "working");
  const noTurnServer = startServer(NO_TURN_PORT, false);
  const silentTurnServer = startServer(SILENT_TURN_APP_PORT, "silent");
  const silentTurn = startSilentTurn();
  let a, b, c, d, e;
  try {
    if (!(await waitForServer(APP_PORT))) throw new Error("server never came up");
    await sleep(500); // let coturn finish binding

    a = await newClient("Alice");
    b = await newClient("Bob");

    // --- 1. The refusal is surfaced, not swallowed -------------------------
    const health = await waitFor(
      () => iceHealth(a.page),
      (h) => h.present && !h.hidden && /401/.test(h.text),
      20_000,
    );
    check("the TURN 401 is reported in the UI", !health.hidden && /401/.test(health.text), health);
    check(
      "the hint names the mismatching knob (TURN_SECRET)",
      /TURN_SECRET/.test(health.text),
      health,
    );

    // --- 2. The watchdog stops the tile from lying "ansluter" -------------
    // Before the fix this stayed `connection-connecting` indefinitely.
    const stalled = await waitFor(
      () => tileState(a.page, "Bob"),
      (t) => t.found && t.uncertain,
      WATCHDOG_MS + 15_000,
    );
    check("a pair that never connects is flagged uncertain", stalled.uncertain, stalled);
    check("...and no longer reads 'ansluter'", stalled.found && !stalled.connecting, stalled);

    // The rail repaints on the mesh's 1 Hz stats tick, so give it a tick to catch up.
    const diag = await waitFor(
      () => diagStateFor(a.page, "Bob"),
      (d) => d?.state === "osäker",
      5_000,
    );
    check("the diagnostics row agrees (osäker)", diag?.state === "osäker", diag);
    check("the diagnostics row explains why (401 in its tooltip)", /401/.test(diag?.title || ""), diag);
    await shot(a.page, "relay_stuck_401_explained");

    // --- 3. The pair is handed to the ICE-restart backoff ------------------
    const restarts = await waitFor(
      () => restartIceCalls(a.page),
      (n) => n >= 1,
      15_000,
    );
    check("the stuck pair is retried (restartIce called)", restarts >= 1, { restarts });

    // --- 4. ...and therefore HEALS when the relay starts working -----------
    // Repair the relay by restarting coturn with the secret the app is using.
    console.log("-- restarting coturn with the matching secret --");
    coturn.kill("SIGTERM");
    await sleep(1500);
    coturn = startCoturn(APP_SECRET);
    await sleep(1000);

    const healed = await waitFor(
      () => tileState(a.page, "Bob"),
      (t) => t.found && !t.uncertain && t.relayed,
      45_000,
    );
    check("the stuck pair recovers once the relay works", healed.relayed && !healed.uncertain, healed);
    const healedDiag = await waitFor(
      () => diagStateFor(a.page, "Bob"),
      (d) => d?.state === "ansluten",
      5_000,
    );
    check("the diagnostics row reads connected again", healedDiag?.state === "ansluten", healedDiag);
    check(
      "the healed diagnostics row drops the stale TURN error tooltip",
      !/401|TURN_SECRET/.test(healedDiag?.title || ""),
      healedDiag,
    );
    const healedHealth = await iceHealth(a.page);
    check(
      "the healed health box drops the stale 401 (not session history)",
      !/401|TURN_SECRET|Fel från STUN\/TURN/.test(healedHealth.text),
      healedHealth,
    );
    const bSeesAlice = await waitFor(
      () => tileState(b.page, "Alice"),
      (t) => t.found && t.relayed && !t.uncertain,
      20_000,
    );
    check("recovery is symmetric (Bob sees Alice relayed)", bSeesAlice.relayed && !bSeesAlice.uncertain, bSeesAlice);
    await shot(a.page, "relay_healed_after_repair");

    // --- 5. A STUN-only deployment says so --------------------------------
    if (!(await waitForServer(NO_TURN_PORT))) throw new Error("no-TURN server never came up");
    c = await newClient("Cecilia", NO_TURN_URL);
    const noTurnHealth = await waitFor(
      () => iceHealth(c.page),
      (h) => h.present && !h.hidden,
      10_000,
    );
    check(
      "a deployment without TURN reports 'ej konfigurerat'",
      !noTurnHealth.hidden && /ej konfigurerat/.test(noTurnHealth.text),
      noTurnHealth,
    );
    await shot(c.page, "relay_not_configured");

    // --- 6. A relay that never answers explains itself anyway --------------
    // The production case. No `icecandidateerror` arrives in time here (Chrome
    // needs ~40 s of Allocate retransmits; the watchdog restarts gathering long
    // before that), so this passes only if the diagnosis is derived from the
    // absence of a relay candidate.
    if (!(await waitForServer(SILENT_TURN_APP_PORT))) {
      throw new Error("silent-TURN server never came up");
    }
    d = await newClient("Dagny", SILENT_TURN_URL);
    e = await newClient("Erik", SILENT_TURN_URL);
    const silentHealth = await waitFor(
      () => iceHealth(d.page),
      (h) => h.present && !h.hidden && /relä-kandidat/.test(h.text),
      WATCHDOG_MS + 20_000,
    );
    check(
      "an unanswering relay is explained without waiting for icecandidateerror",
      !silentHealth.hidden && /relä-kandidat/.test(silentHealth.text),
      silentHealth,
    );
    check(
      "...and the hint names the UDP port as the thing to check",
      /UDP-porten/.test(silentHealth.text),
      silentHealth,
    );
    const silentTile = await waitFor(
      () => tileState(d.page, "Erik"),
      (t) => t.found && t.uncertain,
      10_000,
    );
    check("...while the pair itself still reads osäker", silentTile.uncertain, silentTile);
    await shot(d.page, "relay_silent_explained");
  } catch (err) {
    console.error("relay-stuck-recovery: error", err);
    fail++;
  } finally {
    try { await a?.browser.close(); } catch {}
    try { await b?.browser.close(); } catch {}
    try { await c?.browser.close(); } catch {}
    try { await d?.browser.close(); } catch {}
    try { await e?.browser.close(); } catch {}
    try { server.kill("SIGTERM"); } catch {}
    try { noTurnServer.kill("SIGTERM"); } catch {}
    try { silentTurnServer.kill("SIGTERM"); } catch {}
    try { silentTurn.close(); } catch {}
    try { coturn.kill("SIGTERM"); } catch {}
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})();
