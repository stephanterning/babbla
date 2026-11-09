// Usage-stats e2e (no browser): boots its own babbla server with an isolated
// temp SQLite DB, drives two WebSocket clients through join/camera/share/
// transport, then asserts the /stats read API reflects it — including transport
// dedup, relay need, the relay-pairs concurrency line, and the session timeline.
// This is the only coverage of the server-side stats taps (server.js), which the
// in-process unit tests can't reach. Self-contained so `npm run e2e` stays green.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const APP_PORT = Number(process.env.STATS_E2E_PORT) || 8094;
const ROOM = `stats-${Math.random().toString(36).slice(2, 8)}`;
const BASE = `http://localhost:${APP_PORT}`;
const WS_URL = `ws://localhost:${APP_PORT}/ws?room=${ROOM}`;
const dir = mkdtempSync(join(tmpdir(), "stats-e2e-"));
const DB = join(dir, "stats.db");
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

function client(name, clientId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const st = { ws, id: null, peers: [] };
    const to = setTimeout(() => reject(new Error(`join timeout for ${name}`)), 5000);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "welcome") {
        clearTimeout(to);
        st.id = m.id;
        st.peers = m.peers.map((p) => p.id);
        resolve(st);
      } else if (m.type === "peer-joined") st.peers.push(m.id);
    });
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", name, clientId })));
  });
}

function startServer() {
  return spawn("node", ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      STATS_DB_PATH: DB,
      STATS_HMAC_SECRET: "stats-e2e-secret",
      STATS_RETENTION_DAYS: "0",
      TURN_SECRET: "",
      TURN_URLS: "",
    },
    stdio: "ignore",
  });
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/`)).ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

const getJson = (path) => fetch(`${BASE}${path}`).then((r) => r.json());

(async () => {
  const server = startServer();
  let a, b;
  try {
    if (!(await waitForServer())) {
      console.error("stats-smoke: server never came up");
      process.exit(1);
    }

    a = await client("Alice", "ca");
    b = await client("Bob", "cb");
    await sleep(300);

    // Live snapshot while both are connected.
    const live = await getJson("/stats/api/live");
    check("live participantsNow = 2", live.participantsNow === 2, live);
    check("live roomsNow = 1", live.roomsNow === 1, live);

    // Drive media + transport (with a duplicate relay report to test dedup).
    a.ws.send(JSON.stringify({ type: "camera", on: true }));
    a.ws.send(JSON.stringify({ type: "share", on: true }));
    const target = b.peers[0] || a.id;
    b.ws.send(JSON.stringify({ type: "transport", targetId: target, classification: "relay" }));
    b.ws.send(JSON.stringify({ type: "transport", targetId: target, classification: "relay" }));
    await sleep(300);
    a.ws.send(JSON.stringify({ type: "camera", on: false }));
    await sleep(1600); // let the recorder flush (1s interval)

    const sum = await getJson("/stats/api/summary?range=all");
    check("events recorded", sum.totalEvents >= 6, { total: sum.totalEvents });
    check("relay need = both participants", sum.relay.participantsWithRelay === 2, sum.relay);
    check("max concurrent relay pairs = 1", sum.relay.maxConcurrentRelayPairs === 1, sum.relay);
    check(
      "concurrency series carries a relay-pairs line",
      Array.isArray(sum.concurrency) && sum.concurrency.every((p) => "relayPairs" in p),
      sum.concurrency?.[0],
    );
    check("session listed", sum.sessions.length >= 1, sum.sessions);

    // Summary honors an explicit [from,to] window (drives drag-zoom on the chart).
    const sumWin = await getJson(`/stats/api/summary?from=${Date.now() - 3600_000}&to=${Date.now() + 3600_000}`);
    check("summary from/to window returns the events", sumWin.totalEvents === sum.totalEvents, {
      windowed: sumWin.totalEvents,
      all: sum.totalEvents,
    });
    const sumPast = await getJson(`/stats/api/summary?from=${Date.now() - 7 * 86400_000}&to=${Date.now() - 6 * 86400_000}`);
    check("summary window in the far past is empty", sumPast.totalEvents === 0, { past: sumPast.totalEvents });
    check(
      "room name is not stored in clear text (HMAC)",
      sum.sessions.every((s) => !String(s.roomHash).includes(ROOM)),
      sum.sessions.map((s) => s.roomHash),
    );

    const sid = sum.sessions[0]?.roomSessionId;
    const tl = await getJson(`/stats/api/timeline?session=${encodeURIComponent(sid)}`);
    check("timeline has both participants", tl.participants?.length === 2, {
      n: tl.participants?.length,
    });
    const withCamera = (tl.participants || []).some((p) => p.camera.length >= 1);
    check("timeline shows a camera span", withCamera, tl.participants?.map((p) => p.camera.length));

    // Sessions explorer endpoint: an arbitrary window around now (the day model).
    const win = await getJson(`/stats/api/sessions?from=${Date.now() - 3600_000}&to=${Date.now() + 3600_000}`);
    check("sessions endpoint returns the session", win.sessions.length >= 1, { n: win.sessions.length });
    check("session carries hadRelay flag", win.sessions.some((s) => s.hadRelay === true), win.sessions);
    check("session has 2 participants", win.sessions.some((s) => s.participants === 2), win.sessions);
  } catch (err) {
    console.error("stats-smoke: error", err);
    fail++;
  } finally {
    try { a?.ws.close(); } catch {}
    try { b?.ws.close(); } catch {}
    try { server.kill("SIGTERM"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})();
