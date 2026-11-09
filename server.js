import http from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { MSG } from "./public/js/protocol.js";
import { createRoomRegistry, sanitizeRoomName } from "./room.js";
import { createStats } from "./stats/index.js";
import { createTurnProvider } from "./turn-credentials.js";
import { createIceErrorReportGate } from "./ice-error-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

// --- Build version ---------------------------------------------------------
// A human-readable build stamp shown in the UI: "<datum tid> <kort-hash>",
// e.g. "2026-06-21 23:15:55 c678a14". Computed once at startup and injected
// into index.html when it's served (the %BUILD_VERSION% placeholder).
//
// In the container the values are baked in at image-build time via the
// GIT_SHA and BUILD_TIME env vars (set from build args — see Dockerfile/CI),
// because the image carries no .git dir or git binary. Locally (npm start)
// there are no such env vars, so we fall back to reading the commit straight
// from git: short hash + the commit's own timestamp.
const BUILD_VERSION = computeBuildVersion();
const BUILD_VERSION_JS = JSON.stringify(BUILD_VERSION);

/** Format an instant as "YYYY-MM-DD HH:MM:SS" in Swedish wall-clock time. */
function formatStamp(date) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

function gitTry(args) {
  try {
    return execFileSync("git", args, {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function computeBuildVersion() {
  let sha = (process.env.GIT_SHA || "").trim();
  let stamp = "";

  const buildTime = (process.env.BUILD_TIME || "").trim();
  if (buildTime) {
    const parsed = new Date(buildTime);
    stamp = Number.isNaN(parsed.getTime()) ? buildTime : formatStamp(parsed);
  }

  // Local dev fallback: no baked-in env vars, so ask git directly.
  if (!sha) sha = gitTry(["rev-parse", "--short=7", "HEAD"]);
  if (!stamp) {
    const commitUnix = gitTry(["show", "-s", "--format=%ct", "HEAD"]);
    if (commitUnix) stamp = formatStamp(new Date(Number(commitUnix) * 1000));
  }

  sha = sha.slice(0, 7);
  return [stamp, sha].filter(Boolean).join(" ") || "okänd version";
}

// --- Environment banner ----------------------------------------------------
// A slim ribbon at the top of the page so testers always know which deployment
// they're on (e.g. staging vs production). Driven by the APP_ENV env var:
// set APP_ENV=staging on the stage container and the banner shows "STAGING".
// Unset (or "production"/"prod") = no banner, which is the prod default.
// Injected into index.html via the %ENV_BANNER% placeholder.
const ENV_BANNER_HTML = computeEnvBanner();

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function computeEnvBanner() {
  const env = (process.env.APP_ENV || "").trim();
  if (!env) return "";
  const normalized = env.toLowerCase();
  if (normalized === "production" || normalized === "prod") return "";
  const label = escapeHtml(env.toUpperCase());
  return `<div class="env-banner" role="status" aria-label="Miljö: ${label}">${label}</div>`;
}

const PORT = Number(process.env.PORT) || 8080;
const HEARTBEAT_INTERVAL_MS = 15_000;

// Credential I/O belongs to the adapter; Room receives only resolved values.
const createTurnSession = createTurnProvider();

// How many heartbeat rounds a connection may miss before we give up on it.
// With MAX_MISSED_PINGS = 2 and a 15 s interval, a silent socket is terminated
// on the 3rd tick without a pong — i.e. ~45 s after its last pong (the >= check
// happens before the increment). A live call auto-answers the protocol-level
// pong even when backgrounded; this slack keeps a brief background throttle or
// network handover from hard-dropping a healthy peer (the client also
// reconnects on its own — see public/js/main.js).
const MAX_MISSED_PINGS = 2;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

// --- Static file server (the frontend) -------------------------------------
const httpServer = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || "/", "http://localhost");
    const urlPath = decodeURIComponent(reqUrl.pathname);
    // Usage-stats dashboard API (read-only JSON). NOTE: /stats* is intentionally
    // UNAUTHENTICATED in this PoC — the leak-safe log profile is the only guard.
    // Add Caddy Basic Auth before keeping it. See .cursor/plans/stats-poc.md.
    if (urlPath.startsWith("/stats/api/")) {
      serveStatsApi(urlPath, reqUrl.searchParams, res);
      return;
    }
    // `/` and `/room/<name>` serve the SPA shell; `/stats` serves the dashboard
    // shell. JS/CSS load via absolute paths so they resolve under any subpath.
    // Bare `/room` (no name) also serves the shell so the client can
    // canonicalize it to `/` rather than 404 on a malformed URL.
    let rel;
    if (urlPath === "/stats/sessions" || urlPath === "/stats/sessions/") {
      rel = "/stats-sessions.html";
    } else if (urlPath === "/stats" || urlPath === "/stats/") {
      rel = "/stats.html";
    } else if (
      urlPath === "/" ||
      urlPath === "/room" ||
      urlPath.startsWith("/room/")
    ) {
      rel = "/index.html";
    } else {
      rel = urlPath;
    }
    // Prevent path traversal: resolve and ensure it stays under PUBLIC_DIR.
    const filePath = normalize(join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const ext = extname(filePath);
    if (ext === ".html") {
      const html = (await readFile(filePath, "utf8"))
        .replaceAll("%BUILD_VERSION%", BUILD_VERSION)
        .replaceAll("%BUILD_VERSION_JS%", BUILD_VERSION_JS)
        .replaceAll("%ENV_BANNER%", ENV_BANNER_HTML);
      res.writeHead(200, { "content-type": MIME[ext] });
      res.end(html);
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

// --- Signaling server -------------------------------------------------------
// A single fixed room. Everyone who connects lands in the same room.
// The server only relays SDP/ICE between peers and tracks presence (names).
// All audio is peer-to-peer (mesh); no media flows through this server.
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// Presence + the room's rules live in a pure Room module that returns effects
// (`{ to: ids, msg }`). This file is the transport adapter: it maps ids to live
// sockets and flushes those effects. No room state lives here anymore.
//
// Multiple rooms: each connection picks a room from its URL (`/ws?room=<name>`,
// default `/` -> the shared "main" room). The registry creates rooms on demand
// and drops them when empty. Ids are globally unique (randomUUID), so a single
// id->socket map serves every room.
const registry = createRoomRegistry({
  buildVersion: BUILD_VERSION,
});

// --- Usage stats (event-sourced; see .cursor/plans/stats-poc.md) -----------
// Best-effort and fully isolated: a stats failure never touches signaling. The
// DB defaults to in-memory (dev/tests leave no file); production sets
// STATS_DB_PATH to a mounted volume. Room names are HMAC'd (STATS_HMAC_SECRET,
// kept OUTSIDE the volume); client IPs are resolved to ASN (STATS_ASN_TSV) and
// then discarded — never stored.
const STATS_RETENTION_DAYS =
  process.env.STATS_RETENTION_DAYS != null &&
  process.env.STATS_RETENTION_DAYS !== ""
    ? Number(process.env.STATS_RETENTION_DAYS)
    : 90;
const stats = createStats({
  dbPath: process.env.STATS_DB_PATH || ":memory:",
  hmacSecret: process.env.STATS_HMAC_SECRET || "",
  asnTsvPath: process.env.STATS_ASN_TSV || "",
  buildVersion: BUILD_VERSION,
  env: (process.env.APP_ENV || "").trim().toLowerCase() || "dev",
  retentionDays: Number.isFinite(STATS_RETENTION_DAYS) ? STATS_RETENTION_DAYS : 90,
});

// A client-reported public IP (sent with `join`) — the only IP source for the
// ASN lookup. The server can't observe the real client IP here: this host runs
// behind a proxy/NAT that rewrites the source address before it reaches us
// (a proxy or NAT can hide the original source address), so
// X-Forwarded-For only ever carried that gateway and every ASN came back null.
// The browser learns its real IP via STUN and sends it here. Only a coarse shape
// check (an IPv4/IPv6 literal, length-capped) — the ASN lookup itself rejects
// anything non-routable, and the value is used solely for that offline lookup
// then discarded, never stored. Client-asserted, so trust it only for the open,
// low-stakes usage telemetry.
function clientReportedIp(value) {
  const s = String(value || "").trim();
  if (!s || s.length > 45) return null; // 45 = max IPv6 textual length
  return /^[0-9A-Fa-f:.]+$/.test(s) ? s : null;
}

function statsRange(searchParams) {
  const r = searchParams.get("range") || "7d";
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (r === "all") return { fromMs: 0, toMs: now };
  const spans = { today: day, "7d": 7 * day, "30d": 30 * day };
  return { fromMs: now - (spans[r] || spans["7d"]), toMs: now };
}

// Summary scope: an explicit [from,to] window in ms (drag-zoom on the concurrency
// chart) wins over the preset `range`. Only the dashboard's own zoom passes these;
// there is no separate range-picker UI.
function summaryWindow(searchParams) {
  if (searchParams.has("from") && searchParams.has("to")) {
    const fromMs = Number(searchParams.get("from"));
    const toMs = Number(searchParams.get("to"));
    if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
      return fromMs <= toMs ? { fromMs, toMs } : { fromMs: toMs, toMs: fromMs };
    }
  }
  return statsRange(searchParams);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function serveStatsApi(urlPath, searchParams, res) {
  try {
    if (urlPath === "/stats/api/live") {
      sendJson(res, 200, stats.live(registry.listActiveRooms()));
    } else if (urlPath === "/stats/api/summary") {
      sendJson(res, 200, stats.query(summaryWindow(searchParams)));
    } else if (urlPath === "/stats/api/sessions") {
      // Arbitrary window (ms) — the sessions explorer passes a day computed in
      // the viewer's local timezone. Just the session list, no heavy aggregates.
      const fromMs = Number(searchParams.get("from"));
      const toMs = Number(searchParams.get("to"));
      sendJson(res, 200, stats.sessionsInRange({ fromMs, toMs }));
    } else if (urlPath === "/stats/api/timeline") {
      const id = searchParams.get("session") || "";
      sendJson(res, 200, stats.timeline(id) || { error: "not_found" });
    } else {
      sendJson(res, 404, { error: "not_found" });
    }
  } catch (e) {
    sendJson(res, 500, { error: "stats_error", message: e.message });
  }
}

/** @type {Map<string, import("ws").WebSocket>} */
const sockets = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// Resolve each effect's recipient ids to live sockets and send. A recipient
// whose socket has gone is simply skipped.
function flush(effects) {
  for (const { to, msg } of effects) {
    for (const id of to) {
      const ws = sockets.get(id);
      if (ws) send(ws, msg);
    }
  }
}

wss.on("connection", (ws, req) => {
  const id = randomUUID();
  // Pick the room from the connection URL (?room=<name>); default to "main".
  const roomName = sanitizeRoomName(
    new URL(req.url, "http://localhost").searchParams.get("room"),
  );
  let room = registry.get(roomName);
  const getTurnCredentials = createTurnSession();
  let joining = false;
  let refreshing = false;
  // Register the socket up front so a `welcome` (addressed to this id) resolves
  // even though the peer only enters the Room on `join`.
  sockets.set(id, ws);
  ws.missedPings = 0;
  const acceptIceErrorReport = createIceErrorReportGate();
  // Snapshot the user-agent once for the stats metadata. The client IP for ASN
  // is no longer derived from the request — a proxy/NAT hides the real source IP
  // here (see clientReportedIp); it arrives on the `join` message instead.
  ws.userAgent = req.headers["user-agent"] || "";

  ws.on("pong", () => {
    ws.missedPings = 0;
  });

  // Thin adapter: parse, hand the event to the Room, flush whatever it decides.
  // The Room owns every rule (join guard, latest-sharer-wins, camera cap, relay
  // targeting, departure cleanup); this switch just routes by message type.
  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // The stats taps run AFTER flush so logging never delays the relay, and each
    // is gated on the Room actually acting (effects non-empty) so a no-op
    // (duplicate/ignored message) isn't logged. The Room stays pure — these taps
    // live only here in the adapter.
    switch (msg.type) {
      case MSG.JOIN: {
        if (joining || room.hasPeer(id)) break;
        joining = true;
        const turn = await getTurnCredentials();
        joining = false;
        // A close/leave during the HTTP request must never resurrect a peer.
        if (ws.readyState !== ws.OPEN || !sockets.has(id)) break;
        // The old empty room may have been collected while credentials loaded.
        room = registry.get(roomName);
        const effects = room.join(id, msg.name, turn);
        flush(effects);
        if (effects.length) {
          const clientId = String(msg.clientId || "").slice(0, 64) || id;
          // The client's STUN-discovered public IP (stats-only); resolved to an
          // ASN by the offline TSV then discarded. null when STUN was blocked.
          stats.join({
            connId: id,
            clientId,
            roomName,
            ip: clientReportedIp(msg.clientIp),
            userAgent: ws.userAgent,
          });
        }
        break;
      }
      case MSG.SIGNAL:
        flush(room.signal(id, msg.to, msg.data));
        break;
      case MSG.SHARE: {
        const effects = room.share(id, msg.on);
        flush(effects);
        if (effects.length)
          stats.event({ connId: id, type: msg.on ? "share-on" : "share-off" });
        break;
      }
      case MSG.MUTE: {
        const effects = room.mute(id, msg.on);
        flush(effects);
        if (effects.length)
          stats.event({ connId: id, type: msg.on ? "mute" : "unmute" });
        break;
      }
      case MSG.DND: {
        const effects = room.dnd(id, msg.on);
        flush(effects);
        if (effects.length)
          stats.event({ connId: id, type: msg.on ? "dnd" : "undnd" });
        break;
      }
      case MSG.CAMERA: {
        const effects = room.camera(id, msg.on);
        flush(effects);
        if (effects.some((e) => e.msg.type === MSG.CAMERA_LIMIT)) {
          stats.roomEvent({ connId: id, type: "camera-limit" });
        } else if (effects.length) {
          stats.event({ connId: id, type: msg.on ? "camera-on" : "camera-off" });
        }
        break;
      }
      case MSG.VIDEO_OPT_OUT: {
        const effects = room.videoOptOut(id, msg.on);
        flush(effects);
        if (effects.length)
          stats.event({
            connId: id,
            type: msg.on ? "video-opt-out-on" : "video-opt-out-off",
          });
        break;
      }
      case MSG.CAMERA_FOCUS: {
        const effects = room.cameraFocus(id, msg.targetId, msg.on);
        flush(effects);
        if (effects.length)
          stats.event({
            connId: id,
            type: msg.on ? "camera-focus-on" : "camera-focus-off",
            targetConnId: msg.targetId,
          });
        break;
      }
      case MSG.VIDEO_SUPPRESS: {
        const effects = room.videoSuppress(id, msg.targetId, msg.on);
        flush(effects);
        if (effects.length)
          stats.event({
            connId: id,
            type: msg.on ? "video-suppress-on" : "video-suppress-off",
            targetConnId: msg.targetId,
          });
        break;
      }
      case MSG.TRANSPORT:
        // Stats-only, never relayed: the reporting peer classifies a pair's
        // transport (direct/relay/unknown). The Room is not involved.
        stats.transport({
          connId: id,
          targetConnId: msg.targetId,
          classification: msg.classification,
          localCandidateType: msg.localCandidateType,
          remoteCandidateType: msg.remoteCandidateType,
        });
        break;
      case MSG.ICE_ERROR: {
        // Stats-only, never relayed: a client's STUN/TURN server refused or
        // never answered. Only joined peers may report it, and the server owns
        // dedupe/rate limiting: a modified client must not amplify persistent
        // stats or logs. Control characters are stripped before either sink.
        if (!room.hasPeer(id)) break;
        const iceError = acceptIceErrorReport(msg);
        if (!iceError) break;
        // Code 0 means the client derived the failure from gathering rather
        // than from a STUN/TURN response code — printing "0" would read like a
        // bug, so leave it out.
        console.warn(
          `ice-error:${iceError.errorCode ? ` ${iceError.errorCode}` : ""} ` +
            `${iceError.errorText} (${iceError.url})`,
        );
        stats.event({ connId: id, type: "ice-error", payload: iceError });
        break;
      }
      case MSG.ICE_REFRESH: {
        if (refreshing || !room.hasPeer(id)) break;
        refreshing = true;
        const turn = await getTurnCredentials();
        refreshing = false;
        if (ws.readyState === ws.OPEN && sockets.has(id)) flush(room.iceRefresh(id, turn));
        break;
      }
      case MSG.LEAVE:
        flush(room.remove(id));
        stats.leave({ connId: id, reason: "explicit" });
        sockets.delete(id);
        registry.removeIfEmpty(roomName);
        ws.close();
        break;
      default:
        break;
    }
  });

  ws.on("close", () => {
    flush(room.remove(id));
    // Distinguish a heartbeat kill from a normal socket close (the only place
    // these two paths differ for the log). See plan, granskningspunkt 5.
    stats.leave({
      connId: id,
      reason: ws.terminatedByHeartbeat ? "heartbeat-timeout" : "ws-close",
    });
    sockets.delete(id);
    registry.removeIfEmpty(roomName);
  });

  ws.on("error", () => ws.terminate());
});

// TCP can look connected long after a browser disappeared (sleep, lost wifi,
// mobile backgrounding). Ping every connection and terminate anything that
// stayed silent for MAX_MISSED_PINGS rounds, which then runs the normal
// cleanup. Each pong resets the miss counter (see above).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    // Skip sockets that aren't open: ping() throws on a CONNECTING socket and
    // errors on a CLOSING/CLOSED one (which would crash this interval). Such
    // sockets are mid-handshake or already going away and get cleaned up by
    // their own close handler.
    if (ws.readyState !== ws.OPEN) continue;
    // Defensive init: if a socket somehow reaches the loop before the connection
    // handler set this, `undefined++` would become NaN and `NaN >= MAX` is always
    // false — the socket would then never be terminated.
    ws.missedPings ??= 0;
    if (ws.missedPings >= MAX_MISSED_PINGS) {
      // Mark the cause so the close handler logs `heartbeat-timeout`, not `ws-close`.
      ws.terminatedByHeartbeat = true;
      ws.terminate();
      continue;
    }
    ws.missedPings++;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
  console.log(`babbla listening on http://0.0.0.0:${PORT}  (ws path: /ws)`);
});

// Flush buffered stats + close the DB cleanly on shutdown (e.g. a deploy's
// SIGTERM) so at most the last in-flight batch is lost. Any session still open
// is re-derived + resumed (or synthetically ended) from the log on next start.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      stats.close();
    } catch {}
    process.exit(0);
  });
}
