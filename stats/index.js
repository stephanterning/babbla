// Stats facade — the single object server.js talks to. Wires the SQLite store,
// the buffered recorder, the session registry, and the ASN/UA/room-hash
// decorators into a small set of tap methods (join/leave/event/transport),
// plus the read API for the /stats dashboard. Owns the conn->context map so
// every event is decorated with the connection's frozen metadata snapshot
// (resolved once at join; the raw IP is used for ASN here and never stored).
//
// All of this is best-effort and isolated: any throw is swallowed so a stats
// problem can never break signaling. See .cursor/plans/stats-poc.md.

import { randomUUID } from "node:crypto";
import { openStatsDb } from "./db.js";
import { createRecorder } from "./recorder.js";
import { createSessionRegistry } from "./sessions.js";
import { createRoomHasher } from "./hash.js";
import { createAsnResolver } from "./asn.js";
import { parseUserAgent } from "./ua.js";
import { deriveOpenSessions } from "./derive.js";
import * as aggregate from "./aggregate.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function canonicalPairKey(sid, a, b) {
  const [x, y] = [a, b].sort();
  return `${sid}\u0000${x}\u0000${y}`;
}

/**
 * @param {object} opts
 * @param {string} opts.dbPath SQLite path or ":memory:"
 * @param {string} [opts.hmacSecret]
 * @param {string} [opts.asnTsvPath]
 * @param {string} [opts.buildVersion]
 * @param {string} [opts.env]
 * @param {number} [opts.retentionDays] 0 = keep forever
 * @param {number} [opts.graceMs]
 * @param {number} [opts.resumeWindowMs]
 * @param {() => number} [opts.now]
 */
export function createStats({
  dbPath,
  hmacSecret = "",
  asnTsvPath = "",
  buildVersion = "",
  env = "",
  retentionDays = 90,
  graceMs = 15_000,
  resumeWindowMs = 300_000,
  now = Date.now,
} = {}) {
  // Fail-open: a misconfigured/unwritable STATS_DB_PATH (e.g. a missing volume
  // mount) must NOT stop babbla from starting — stats are best-effort. Fall back
  // to in-memory (stats just don't persist), and to a fully no-op facade only if
  // even that fails, so createStats never throws into server startup.
  let store;
  try {
    store = openStatsDb(dbPath);
  } catch (e) {
    console.warn(
      `[babbla:stats] kunde inte öppna DB '${dbPath}': ${e.message} — faller tillbaka till :memory: (statistik persisteras inte).`,
    );
    try {
      store = openStatsDb(":memory:");
    } catch (e2) {
      console.warn(`[babbla:stats] kunde inte öppna ens :memory: — statistik avstängd: ${e2.message}`);
      return createNoopStats(now);
    }
  }

  /** @type {Map<string, {clientId:string, roomHash:string, roomSessionId:string, meta:object}>} */
  const contexts = new Map();
  /** @type {Map<string, string>} canonical pair key -> last classification (dedup) */
  const pairState = new Map();

  // Drop a session's transport-dedup keys when it ends, so pairState can't grow
  // unboundedly on a long-running server (events are retention-pruned; this
  // in-memory map must be pruned too). Pair keys are `${sid}\u0000...`.
  function evictPairState(sid) {
    const prefix = `${sid}\u0000`;
    for (const k of [...pairState.keys()]) if (k.startsWith(prefix)) pairState.delete(k);
  }

  const recorder = createRecorder({ insert: store.insert, now });
  const sessions = createSessionRegistry({
    record: (e) => {
      if (e.type === "room-session-end" && e.room_session_id) evictPairState(e.room_session_id);
      recorder.record(e);
    },
    now,
    newId: randomUUID,
    graceMs,
    resumeWindowMs,
  });
  const hashRoom = createRoomHasher(hmacSecret);
  const asn = createAsnResolver({ tsvPath: asnTsvPath });

  // ---- startup reconciliation: resume open sessions from the log ----------
  try {
    const lookback = now() - Math.max(resumeWindowMs, SIX_HOURS_MS);
    const recent = store.all(
      "SELECT * FROM events WHERE ts >= ? ORDER BY ts, id",
      [lookback],
    );
    sessions.hydrate(deriveOpenSessions(recent));
    // Rebuild per-pair transport state so a flip isn't double-logged post-resume.
    for (const e of recent) {
      if (e.type !== "transport" || !e.actor_client_id || !e.target_client_id) continue;
      const cls = safeParse(e.payload).classification;
      if (cls) {
        pairState.set(
          canonicalPairKey(e.room_session_id, e.actor_client_id, e.target_client_id),
          cls,
        );
      }
    }
  } catch (e) {
    console.warn("[babbla:stats] startup-resume misslyckades:", e.message);
  }

  // ---- retention ----------------------------------------------------------
  let retentionTimer = null;
  function runRetention() {
    if (!retentionDays) return;
    try {
      store.deleteOlderThan(now() - retentionDays * DAY_MS);
    } catch (e) {
      console.warn("[babbla:stats] retention misslyckades:", e.message);
    }
  }
  if (retentionDays > 0) {
    runRetention();
    retentionTimer = setInterval(runRetention, DAY_MS);
    retentionTimer?.unref?.();
  }

  // ---- decoration ---------------------------------------------------------
  function buildMeta(ip, userAgent) {
    const a = (ip && asn.lookup(ip)) || null;
    const ua = parseUserAgent(userAgent);
    return {
      asn: a?.asn ?? null,
      asn_org: a?.asn_org ?? null,
      country: a?.country ?? null,
      ua_browser: ua.ua_browser,
      ua_version_major: ua.ua_version_major,
      ua_os: ua.ua_os,
      is_ios: ua.is_ios,
      is_chromium: ua.is_chromium,
      build_version: buildVersion,
      env,
    };
  }

  // ---- taps (all guarded; never throw into signaling) ---------------------

  function join({ connId, clientId, roomName, ip, userAgent }) {
    try {
      const roomHash = hashRoom(roomName);
      const meta = buildMeta(ip, userAgent);
      const { roomSessionId, reconnect } = sessions.onJoin(roomHash, clientId, connId);
      contexts.set(connId, { clientId, roomHash, roomSessionId, meta });
      recorder.record({
        type: reconnect ? "reconnect" : "join",
        room_hash: roomHash,
        room_session_id: roomSessionId,
        actor_client_id: clientId,
        actor_conn_id: connId,
        ...meta,
      });
    } catch (e) {
      warnOnce("join", e);
    }
  }

  function leave({ connId, reason = "ws-close" }) {
    try {
      const ctx = contexts.get(connId);
      if (!ctx) return;
      recorder.record({
        type: "leave",
        room_hash: ctx.roomHash,
        room_session_id: ctx.roomSessionId,
        actor_client_id: ctx.clientId,
        actor_conn_id: connId,
        payload: JSON.stringify({ reason }),
        ...ctx.meta,
      });
      sessions.onLeave(ctx.roomHash, ctx.clientId, connId);
      contexts.delete(connId);
    } catch (e) {
      warnOnce("leave", e);
    }
  }

  // Generic presence/media event. `type` is the final log type (e.g. "share-on").
  function event({ connId, type, payload = null, targetConnId = null }) {
    try {
      const ctx = contexts.get(connId);
      if (!ctx) return;
      sessions.noteActivity(ctx.roomHash);
      const target = targetConnId ? contexts.get(targetConnId) : null;
      recorder.record({
        type,
        room_hash: ctx.roomHash,
        room_session_id: ctx.roomSessionId,
        actor_client_id: ctx.clientId,
        actor_conn_id: connId,
        target_client_id: target?.clientId ?? null,
        payload: payload == null ? null : JSON.stringify(payload),
        ...ctx.meta,
      });
    } catch (e) {
      warnOnce("event", e);
    }
  }

  // camera-limit is a room-wide broadcast with no single actor.
  function roomEvent({ connId, type, payload = null }) {
    try {
      const ctx = contexts.get(connId);
      if (!ctx) return;
      sessions.noteActivity(ctx.roomHash);
      recorder.record({
        type,
        room_hash: ctx.roomHash,
        room_session_id: ctx.roomSessionId,
        payload: payload == null ? null : JSON.stringify(payload),
        build_version: ctx.meta.build_version,
        env: ctx.meta.env,
      });
    } catch (e) {
      warnOnce("roomEvent", e);
    }
  }

  // Per-pair transport report (both sides may send). Dedup: only log on an
  // actual classification change for the canonical pair (see plan).
  function transport({ connId, targetConnId, classification, localCandidateType = null, remoteCandidateType = null }) {
    try {
      const a = contexts.get(connId);
      const b = targetConnId ? contexts.get(targetConnId) : null;
      if (!a || !b || a.roomSessionId !== b.roomSessionId) return;
      const cls = classification === "relay" || classification === "direct" ? classification : "unknown";
      const key = canonicalPairKey(a.roomSessionId, a.clientId, b.clientId);
      if (pairState.get(key) === cls) return; // unchanged -> ignore
      pairState.set(key, cls);
      sessions.noteActivity(a.roomHash);
      recorder.record({
        type: "transport",
        room_hash: a.roomHash,
        room_session_id: a.roomSessionId,
        actor_client_id: a.clientId,
        target_client_id: b.clientId,
        payload: JSON.stringify({ classification: cls, localCandidateType, remoteCandidateType }),
        ...a.meta,
      });
    } catch (e) {
      warnOnce("transport", e);
    }
  }

  // ---- read API (dashboard) ----------------------------------------------

  function loadRange(fromMs, toMs) {
    const from = Number.isFinite(fromMs) ? fromMs : 0;
    const to = Number.isFinite(toMs) ? toMs : now();
    return store.all(
      "SELECT * FROM events WHERE ts >= ? AND ts <= ? ORDER BY ts, id",
      [from, to],
    );
  }

  // Events of every room session that OVERLAPS [from,to] — i.e. whose first event
  // is <= to and last event is >= from — loaded in FULL. A session's join/leave
  // can sit outside a narrow window (e.g. a deep zoom, or a session straddling a
  // preset's edge); loading only `ts BETWEEN from AND to` would then drop the
  // bracketing events and the window would render empty even though a call was
  // live. Sessions are continuous (they end at the 1→0 transition), so [minTs,
  // maxTs] is a session's active span. The aggregations clip back to [from,to].
  function loadOverlapping(fromMs, toMs) {
    const from = Number.isFinite(fromMs) ? fromMs : 0;
    const to = Number.isFinite(toMs) ? toMs : now();
    return store.all(
      `SELECT * FROM events
         WHERE room_session_id IN (
           SELECT room_session_id FROM events
            WHERE room_session_id IS NOT NULL
            GROUP BY room_session_id
           HAVING MIN(ts) <= ? AND MAX(ts) >= ?
         )
         ORDER BY ts, id`,
      [to, from],
    );
  }

  function query({ fromMs, toMs } = {}) {
    const to = Number.isFinite(toMs) ? toMs : now();
    const from = Number.isFinite(fromMs) ? fromMs : 0;
    const events = loadOverlapping(from, to);
    // For the concurrency x-axis, respect an explicit lower bound (e.g. last
    // 7d), but when unbounded ("all", from=0) start at the earliest event so the
    // series doesn't span from epoch 0.
    const concFrom = from > 0 ? from : events.length ? events[0].ts : to;
    // "Händelser" counts events that actually fall inside the window, not the
    // bracketing ones we pulled in from straddling sessions.
    const totalEvents = events.reduce((n, e) => (e.ts >= from && e.ts <= to ? n + 1 : n), 0);
    return {
      range: { from, to },
      totalEvents,
      concurrency: aggregate.concurrencyOverTime(events, { from: concFrom, to }),
      relay: aggregate.relayStats(events, { from, to }),
      sessions: sessionList(events),
    };
  }

  // Compact list of sessions in a set of events (the sessions overview + the
  // legacy summary picker). `hadRelay` = any pair in the session classified as
  // relay (drives the overview's relay indicator). Bounds are derived from the
  // events given, so a windowed query yields windowed (clamped) bounds.
  function sessionList(events) {
    const byId = new Map();
    for (const e of events) {
      if (!e.room_session_id) continue;
      let g = byId.get(e.room_session_id);
      if (!g) {
        g = {
          roomSessionId: e.room_session_id,
          roomHash: e.room_hash || null,
          start: e.ts,
          end: e.ts,
          participants: new Set(),
          hadRelay: false,
        };
        byId.set(e.room_session_id, g);
      }
      g.start = Math.min(g.start, e.ts);
      g.end = Math.max(g.end, e.ts);
      if (e.actor_client_id) g.participants.add(e.actor_client_id);
      if (e.type === "transport" && safeParse(e.payload).classification === "relay") {
        g.hadRelay = true;
      }
    }
    return [...byId.values()]
      .map((g) => ({
        roomSessionId: g.roomSessionId,
        roomHash: g.roomHash,
        start: g.start,
        end: g.end,
        participants: g.participants.size,
        hadRelay: g.hadRelay,
      }))
      .sort((a, b) => b.start - a.start);
  }

  // The sessions explorer's data: just the session list for an arbitrary window
  // (no heavy aggregates). The client passes the day's [from,to] in its own tz.
  function sessionsInRange({ fromMs, toMs } = {}) {
    const to = Number.isFinite(toMs) ? toMs : now();
    const from = Number.isFinite(fromMs) ? fromMs : 0;
    return { range: { from, to }, sessions: sessionList(loadRange(from, to)) };
  }

  function timeline(roomSessionId) {
    const events = store.all(
      "SELECT * FROM events WHERE room_session_id = ? ORDER BY ts, id",
      [roomSessionId],
    );
    return aggregate.sessionTimeline(events, roomSessionId);
  }

  // Live snapshot from the server's in-memory registry (not the DB). activeRooms
  // = [{ name, peerCount }]; we hash the names so the live view matches history.
  function live(activeRooms = []) {
    const rooms = activeRooms.map((r) => ({
      roomHash: hashRoom(r.name),
      peerCount: r.peerCount,
    }));
    return {
      participantsNow: rooms.reduce((a, r) => a + r.peerCount, 0),
      roomsNow: rooms.length,
      rooms: rooms.sort((a, b) => b.peerCount - a.peerCount),
    };
  }

  let warned = new Set();
  function warnOnce(where, e) {
    if (warned.has(where)) return;
    warned.add(where);
    console.warn(`[babbla:stats] ${where} fel (loggas en gång):`, e.message);
  }

  function close() {
    if (retentionTimer) clearInterval(retentionTimer);
    sessions.stop();
    recorder.close();
    store.close();
  }

  return { join, leave, event, roomEvent, transport, query, sessionsInRange, timeline, live, close, _recorder: recorder };
}

function safeParse(s) {
  if (!s) return {};
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
}

function emptyQuery(now) {
  return {
    range: { from: 0, to: now },
    totalEvents: 0,
    concurrency: [],
    relay: { totalParticipants: 0, participantsWithRelay: 0, pctWithRelay: 0, maxConcurrentRelayPairs: 0, perAsn: [] },
    sessions: [],
  };
}

// Last-resort facade when even an in-memory DB can't be opened: every tap is a
// no-op and reads return empty, so the server runs normally with stats disabled.
// `live` still works (it only counts the in-memory registry, no DB needed).
function createNoopStats(now) {
  const noop = () => {};
  return {
    join: noop,
    leave: noop,
    event: noop,
    roomEvent: noop,
    transport: noop,
    query: () => emptyQuery(now()),
    sessionsInRange: ({ fromMs = 0, toMs = now() } = {}) => ({ range: { from: fromMs, to: toMs }, sessions: [] }),
    timeline: () => null,
    live: (activeRooms = []) => ({
      participantsNow: activeRooms.reduce((a, r) => a + (r.peerCount || 0), 0),
      roomsNow: activeRooms.length,
      rooms: [],
    }),
    close: noop,
    _recorder: { flush: noop, close: noop, record: noop, pending: () => 0 },
  };
}
