// Pure aggregation over raw event rows — every dashboard metric is derived here
// at read time (event-sourcing: no rollup tables). Functions take an array of
// event rows (ascending ts) and return plain JSON-able objects. Kept pure (no
// DB, no clock) so they unit-test directly against synthetic logs.
//
// Span/interval semantics (the subtle, review-flagged bits):
//   - presence: join/reconnect opens, leave closes; room-session-end closes all.
//   - camera: camera-on/off per client; `camera-limit` closes ALL open camera
//     spans (the server cap clears every camera with one broadcast, no per-peer
//     camera-off — see room.js); session end closes all.
//   - screen: latest-sharer-wins — a new share-on closes any other open screen
//     span (the superseded sharer never sends share-off); session end closes all.
//   - transport: a per-pair classification that holds from its event until the
//     next change for that pair (or session end).

const PRESENCE_START = new Set(["join", "reconnect"]);

// ---- small helpers --------------------------------------------------------

// Last ts seen per session — used to close spans that never got an explicit end
// (the session was cut off, e.g. by a deploy, before a leave/off arrived).
function sessionEndTs(events) {
  const end = new Map();
  for (const e of events) {
    if (!e.room_session_id) continue;
    const cur = end.get(e.room_session_id);
    if (cur == null || e.ts > cur) end.set(e.room_session_id, e.ts);
  }
  return end;
}

// Max concurrency over a set of [start,end) intervals (sweep line).
function maxConcurrent(intervals) {
  const pts = [];
  for (const { start, end } of intervals) {
    if (end <= start) continue;
    pts.push([start, 1], [end, -1]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of pts) {
    cur += d;
    if (cur > max) max = cur;
  }
  return max;
}

// Sweep [start,end) intervals into the disjoint, contiguous segments of constant
// concurrency, e.g. [{start,end,value}] with value = #intervals overlapping.
function concurrencySegments(intervals) {
  const pts = [];
  for (const { start, end } of intervals) {
    if (end <= start) continue;
    pts.push([start, 1], [end, -1]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const segs = [];
  let cur = 0;
  let prevT = null;
  for (const [t, d] of pts) {
    if (prevT != null && t > prevT && cur > 0) segs.push({ start: prevT, end: t, value: cur });
    cur += d;
    prevT = t;
  }
  return segs;
}

// Per-bucket MAX concurrency: for each of buckets+1 sample points i (covering the
// window [lo+i*step, lo+(i+1)*step)) return the highest concurrency reached
// anywhere in that window. Unlike an instantaneous point sample this never drops
// a short-lived span between two sample points — so a brief relay never reads 0
// while it was in fact relaying, and each line's peak equals its true max.
function maxConcurrentPerBucket(intervals, lo, step, buckets) {
  const out = new Array(buckets + 1).fill(0);
  for (const seg of concurrencySegments(intervals)) {
    const firstI = Math.max(0, Math.floor((seg.start - lo) / step));
    const lastI = Math.min(buckets, Math.ceil((seg.end - lo) / step) - 1);
    for (let i = firstI; i <= lastI; i++) {
      const ws = lo + i * step;
      if (seg.start < ws + step && ws < seg.end && seg.value > out[i]) out[i] = seg.value;
    }
  }
  return out;
}

// ---- presence -------------------------------------------------------------

// Map<sessionId, Map<clientId, {start,end}[]>>
function presenceIntervals(events) {
  const ends = sessionEndTs(events);
  const bySession = new Map();
  const open = new Map(); // sessionId -> Map<clientId, startTs>

  const ensure = (sid) => {
    if (!bySession.has(sid)) bySession.set(sid, new Map());
    if (!open.has(sid)) open.set(sid, new Map());
  };
  const close = (sid, client, end) => {
    const o = open.get(sid);
    if (!o || !o.has(client)) return;
    const start = o.get(client);
    o.delete(client);
    const list = bySession.get(sid).get(client) || [];
    list.push({ start, end });
    bySession.get(sid).set(client, list);
  };

  for (const e of events) {
    const sid = e.room_session_id;
    if (!sid) continue;
    ensure(sid);
    if (PRESENCE_START.has(e.type) && e.actor_client_id) {
      // A reconnect after a leave starts a fresh interval; a stray double-open
      // keeps the earliest start.
      if (!open.get(sid).has(e.actor_client_id)) {
        open.get(sid).set(e.actor_client_id, e.ts);
      }
    } else if (e.type === "leave" && e.actor_client_id) {
      close(sid, e.actor_client_id, e.ts);
    } else if (e.type === "room-session-end") {
      for (const client of [...open.get(sid).keys()]) close(sid, client, e.ts);
    }
  }
  // Close anything still open at the session's last seen ts.
  for (const [sid, o] of open) {
    for (const client of [...o.keys()]) close(sid, client, ends.get(sid) ?? o.get(client));
  }
  return bySession;
}

// ---- generic single-resource spans (camera / screen) ----------------------

// camera: per-client on/off, camera-limit closes all. screen: single sharer.
function cameraSpans(events) {
  const ends = sessionEndTs(events);
  const out = []; // {sessionId, clientId, start, end}
  const open = new Map(); // sessionId -> Map<clientId, startTs>
  const ensure = (sid) => open.has(sid) || open.set(sid, new Map());
  const close = (sid, client, end) => {
    const o = open.get(sid);
    if (!o?.has(client)) return;
    out.push({ sessionId: sid, clientId: client, start: o.get(client), end });
    o.delete(client);
  };
  for (const e of events) {
    const sid = e.room_session_id;
    if (!sid) continue;
    ensure(sid);
    if (e.type === "camera-on" && e.actor_client_id) {
      if (!open.get(sid).has(e.actor_client_id)) open.get(sid).set(e.actor_client_id, e.ts);
    } else if (e.type === "camera-off" && e.actor_client_id) {
      close(sid, e.actor_client_id, e.ts);
    } else if (e.type === "leave" && e.actor_client_id) {
      // A leaving peer's camera presence is cleaned up server-side (room.remove)
      // but not logged as camera-off, so close their span here.
      close(sid, e.actor_client_id, e.ts);
    } else if (e.type === "camera-limit") {
      for (const c of [...open.get(sid).keys()]) close(sid, c, e.ts);
    } else if (e.type === "room-session-end") {
      for (const c of [...open.get(sid).keys()]) close(sid, c, e.ts);
    }
  }
  for (const [sid, o] of open) for (const c of [...o.keys()]) close(sid, c, ends.get(sid) ?? o.get(c));
  return out;
}

function screenSpans(events) {
  const ends = sessionEndTs(events);
  const out = [];
  const open = new Map(); // sessionId -> { client, start }
  const close = (sid, end) => {
    const cur = open.get(sid);
    if (!cur) return;
    out.push({ sessionId: sid, clientId: cur.client, start: cur.start, end });
    open.delete(sid);
  };
  for (const e of events) {
    const sid = e.room_session_id;
    if (!sid) continue;
    if (e.type === "share-on" && e.actor_client_id) {
      close(sid, e.ts); // latest-wins: supersede whoever was sharing
      open.set(sid, { client: e.actor_client_id, start: e.ts });
    } else if (e.type === "share-off") {
      if (open.get(sid)?.client === e.actor_client_id) close(sid, e.ts);
    } else if (e.type === "leave") {
      // The sharer left: room.remove relinquishes the sharer slot (broadcasts
      // SHARER null) but logs only `leave`, so close their screen span here.
      if (open.get(sid)?.client === e.actor_client_id) close(sid, e.ts);
    } else if (e.type === "room-session-end") {
      close(sid, e.ts);
    }
  }
  for (const sid of [...open.keys()]) close(sid, ends.get(sid));
  return out;
}

// ---- transport (per pair) -------------------------------------------------

function pairKey(sid, a, b) {
  const [x, y] = [a, b].sort();
  return `${sid}\u0000${x}\u0000${y}`;
}

// Earliest leave ts of `client` in `sid` strictly after `start` (or Infinity).
// A relayed pair can't still be relaying once either endpoint has left.
function earliestLeaveAfter(leaves, sid, client, start) {
  const list = leaves.get(sid)?.get(client);
  if (!list) return Infinity;
  for (const t of list) if (t > start) return t; // list is in ascending ts order
  return Infinity;
}

function leavesByClient(events) {
  const map = new Map(); // sid -> Map<client, number[]>
  for (const e of events) {
    if (e.type !== "leave" || !e.room_session_id || !e.actor_client_id) continue;
    if (!map.has(e.room_session_id)) map.set(e.room_session_id, new Map());
    const m = map.get(e.room_session_id);
    if (!m.has(e.actor_client_id)) m.set(e.actor_client_id, []);
    m.get(e.actor_client_id).push(e.ts);
  }
  return map;
}

// Relay intervals per pair, each tagged with its session + endpoints: a 'relay'
// classification holds until the pair's next transport event, the session end,
// OR the moment either endpoint leaves (whichever is first) — a departed peer
// can't still be relaying.
function relayPairIntervals(events) {
  const ends = sessionEndTs(events);
  const leaves = leavesByClient(events);
  const last = new Map(); // pairKey -> { classification, ts, sid, a, b }
  const intervals = [];
  const push = (cur, hardEnd) => {
    if (cur.classification !== "relay") return;
    const end = Math.min(
      hardEnd,
      earliestLeaveAfter(leaves, cur.sid, cur.a, cur.ts),
      earliestLeaveAfter(leaves, cur.sid, cur.b, cur.ts),
    );
    if (end > cur.ts) intervals.push({ sid: cur.sid, a: cur.a, b: cur.b, start: cur.ts, end });
  };
  for (const e of events) {
    if (e.type !== "transport") continue;
    const sid = e.room_session_id;
    if (!sid || !e.actor_client_id || !e.target_client_id) continue;
    const cls = parsePayload(e.payload).classification || "unknown";
    const key = pairKey(sid, e.actor_client_id, e.target_client_id);
    const prev = last.get(key);
    if (prev) push(prev, e.ts); // close the previous classification span
    last.set(key, { classification: cls, ts: e.ts, sid, a: e.actor_client_id, b: e.target_client_id });
  }
  for (const cur of last.values()) push(cur, ends.get(cur.sid) ?? cur.ts);
  return intervals;
}

// Just the [start,end) spans (drops the pair identity) — for concurrency counts.
function relayIntervals(events) {
  return relayPairIntervals(events).map(({ start, end }) => ({ start, end }));
}

// Intersect [start,end) intervals with [from,to), dropping empties.
function clipIntervals(intervals, from, to) {
  const out = [];
  for (const iv of intervals) {
    const start = Math.max(iv.start, from);
    const end = Math.min(iv.end, to);
    if (end > start) out.push({ start, end });
  }
  return out;
}

function parsePayload(payload) {
  if (!payload) return {};
  if (typeof payload === "object") return payload;
  try {
    return JSON.parse(payload) || {};
  } catch {
    return {};
  }
}

// ---- public aggregations --------------------------------------------------

// Time series of concurrent participants, active rooms, and relaying pairs
// across [from,to]. Each line is the MAX concurrency within its bucket (see
// maxConcurrentPerBucket): relay spans are short and would otherwise fall
// between point samples, so the relay line is sampled from the very same
// intervals as relayStats().maxConcurrentRelayPairs and its peak equals that
// card. A room_session_id is continuous (it ends at the 1→0 transition), so a
// session's active span is simply [firstStart, lastEnd) — counting overlapping
// session spans gives the active-rooms line.
export function concurrencyOverTime(events, { from, to, buckets = 60 } = {}) {
  const presence = presenceIntervals(events);
  const flat = []; // {start, end} per participant presence interval
  const roomSpan = new Map(); // sessionId -> {start, end}
  for (const [sid, byClient] of presence) {
    for (const intervals of byClient.values()) {
      for (const iv of intervals) {
        flat.push(iv);
        const rs = roomSpan.get(sid);
        if (!rs) roomSpan.set(sid, { start: iv.start, end: iv.end });
        else {
          rs.start = Math.min(rs.start, iv.start);
          rs.end = Math.max(rs.end, iv.end);
        }
      }
    }
  }
  const relays = relayIntervals(events); // [{start,end}] per relaying pair
  const lo = from ?? Math.min(...flat.map((i) => i.start), Date.now());
  const hi = to ?? Math.max(...flat.map((i) => i.end), lo + 1);
  const step = Math.max(1, (hi - lo) / buckets);
  const participants = maxConcurrentPerBucket(flat, lo, step, buckets);
  const rooms = maxConcurrentPerBucket([...roomSpan.values()], lo, step, buckets);
  const relayPairs = maxConcurrentPerBucket(relays, lo, step, buckets);
  const series = [];
  for (let i = 0; i <= buckets; i++) {
    series.push({
      t: Math.round(lo + i * step),
      participants: participants[i],
      rooms: rooms[i],
      relayPairs: relayPairs[i],
    });
  }
  return series;
}

// Relay need: share of participants with >=1 relayed link, max concurrent relay
// pairs, and per-ASN relay frequency. Scoped to [from,to): only participants
// PRESENT during the window count, and a participant is "relayed" only if one of
// their relay links was active in the window. The window defaults to all time,
// so an unwindowed call is unchanged. Callers must pass the FULL history of any
// session overlapping the window (events that bracket it) so a session straddling
// the window edge isn't truncated.
export function relayStats(events, { from = -Infinity, to = Infinity } = {}) {
  const presence = presenceIntervals(events);
  const pkey = (sid, c) => `${sid}\u0000${c}`;
  const overlapsWindow = (intervals) =>
    !!intervals && intervals.some((iv) => iv.start < to && iv.end > from);

  // participant = (session, client) whose presence overlaps the window; asn from
  // their join meta.
  const participants = new Map(); // sid\u0000client -> { asn, asn_org, relayed }
  for (const e of events) {
    if (!e.room_session_id) continue;
    if (PRESENCE_START.has(e.type) && e.actor_client_id) {
      const k = pkey(e.room_session_id, e.actor_client_id);
      if (!participants.has(k) && overlapsWindow(presence.get(e.room_session_id)?.get(e.actor_client_id))) {
        participants.set(k, { asn: e.asn ?? null, asn_org: e.asn_org ?? null, relayed: false });
      }
    }
  }
  // A participant relayed (for this window) if one of their relay links was
  // active during it.
  const pairs = relayPairIntervals(events);
  for (const r of pairs) {
    if (r.start >= to || r.end <= from) continue;
    for (const c of [r.a, r.b]) {
      const p = participants.get(pkey(r.sid, c));
      if (p) p.relayed = true;
    }
  }
  const all = [...participants.values()];
  const withRelay = all.filter((p) => p.relayed).length;
  const perAsnMap = new Map();
  for (const p of all) {
    const asnKey = p.asn == null ? "unknown" : String(p.asn);
    let row = perAsnMap.get(asnKey);
    if (!row) {
      row = { asn: p.asn ?? null, asn_org: p.asn_org ?? null, total: 0, relayed: 0 };
      perAsnMap.set(asnKey, row);
    }
    row.total++;
    if (p.relayed) row.relayed++;
  }
  return {
    totalParticipants: all.length,
    participantsWithRelay: withRelay,
    pctWithRelay: all.length ? Math.round((withRelay / all.length) * 100) : 0,
    // Clip to the window so this matches the concurrency chart's relay-pairs line
    // (which only samples buckets inside [from,to]).
    maxConcurrentRelayPairs: maxConcurrent(clipIntervals(pairs, from, to)),
    perAsn: [...perAsnMap.values()].sort((a, b) => b.total - a.total),
  };
}

// Everything the SVG swimlane needs for one session: presence + camera/screen/
// mute spans per participant, plus discrete + pair markers.
export function sessionTimeline(events, roomSessionId) {
  const evs = events.filter((e) => e.room_session_id === roomSessionId);
  if (!evs.length) return null;
  const start = Math.min(...evs.map((e) => e.ts));
  const end = Math.max(...evs.map((e) => e.ts));

  const presence = presenceIntervals(evs).get(roomSessionId) || new Map();
  const cam = cameraSpans(evs);
  const scr = screenSpans(evs);

  // mute spans per client (mute -> unmute), close at session end.
  const muteByClient = spanByClient(evs, "mute", "unmute", end);

  const meta = new Map(); // client -> { asn, asn_org, country, ua_browser, ua_os }
  for (const e of evs) {
    if (e.actor_client_id && !meta.has(e.actor_client_id)) {
      meta.set(e.actor_client_id, {
        asn: e.asn ?? null,
        asn_org: e.asn_org ?? null,
        country: e.country ?? null,
        ua_browser: e.ua_browser ?? null,
        ua_os: e.ua_os ?? null,
        is_ios: e.is_ios ?? null,
      });
    }
  }

  const clients = new Set([
    ...presence.keys(),
    ...cam.map((s) => s.clientId),
    ...meta.keys(),
  ]);

  // Per-participant transport timeline: relay is attributed to the RESTRICTIVE
  // party — the peer whose OWN candidate was the relay (their network couldn't
  // be reached directly). So a peer is "relay" only on links where their own
  // side relayed; being the non-restrictive end of a relayed link reads as
  // "direct". See .cursor/plans/stats-poc.md / the relay-attribution discussion.
  const transportByClient = participantTransport(evs);
  const markersByClient = new Map(); // client -> [{t, type, target}]
  const pushTo = (map, client, item) => {
    if (!client) return;
    if (!map.has(client)) map.set(client, []);
    map.get(client).push(item);
  };
  for (const e of evs) {
    if (
      e.type === "camera-focus-on" ||
      e.type === "camera-focus-off" ||
      e.type === "video-suppress-on" ||
      e.type === "video-suppress-off" ||
      e.type === "camera-limit"
    ) {
      pushTo(markersByClient, e.actor_client_id || "_room", {
        t: e.ts,
        type: e.type,
        target: e.target_client_id || null,
      });
    }
  }

  const participants = [...clients].map((client) => ({
    clientId: client,
    meta: meta.get(client) || {},
    presence: presence.get(client) || [],
    camera: cam.filter((s) => s.clientId === client).map((s) => ({ start: s.start, end: s.end })),
    screen: scr.filter((s) => s.clientId === client).map((s) => ({ start: s.start, end: s.end })),
    mute: muteByClient.get(client) || [],
    transport: transportByClient.get(client) || [],
    markers: markersByClient.get(client) || [],
  }));

  return { roomSessionId, start, end, participants };
}

// Build each participant's transport timeline with relay attributed to the
// RESTRICTIVE party. Returns Map<clientId, [{t, classification, relayPeers}]>
// (change-points only; classification = the participant's overall status at t).
function participantTransport(events) {
  const tev = events
    .filter((e) => e.type === "transport" && e.actor_client_id && e.target_client_id)
    .map((e) => ({ t: e.ts, a: e.actor_client_id, b: e.target_client_id, p: parsePayload(e.payload) }))
    .sort((x, y) => x.t - y.t);

  const pairStatus = new Map(); // client -> Map<peer, "relay"|"direct"|"unknown">
  const out = new Map(); // client -> [{t, classification, relayPeers}]
  const ensureMap = (k) => {
    if (!pairStatus.has(k)) pairStatus.set(k, new Map());
    return pairStatus.get(k);
  };
  // A participant's overall status = relay if their own side relayed on ANY
  // current link (they're the restrictive party there), else direct if they have
  // any connected link, else unknown.
  const overall = (client) => {
    const pairs = pairStatus.get(client);
    const relayPeers = [];
    let any = false;
    if (pairs) {
      for (const [peer, st] of pairs) {
        if (st === "relay") relayPeers.push(peer);
        if (st === "relay" || st === "direct") any = true;
      }
    }
    return {
      classification: relayPeers.length ? "relay" : any ? "direct" : "unknown",
      relayPeers: relayPeers.sort(),
    };
  };
  const record = (client, t) => {
    const o = overall(client);
    if (!out.has(client)) out.set(client, []);
    const list = out.get(client);
    const last = list[list.length - 1];
    if (last && last.classification === o.classification && last.relayPeers.join() === o.relayPeers.join()) return;
    list.push({ t, classification: o.classification, relayPeers: o.relayPeers });
  };

  for (const e of tev) {
    const cls = e.p.classification || "unknown";
    ensureMap(e.a).set(e.b, sideStatus(e.p.localCandidateType, e.p.remoteCandidateType, cls));
    ensureMap(e.b).set(e.a, sideStatus(e.p.remoteCandidateType, e.p.localCandidateType, cls));
    record(e.a, e.t);
    record(e.b, e.t);
  }
  return out;
}

// One participant's status on a single pair, from THEIR side. Relay only if
// their own candidate relayed; if the link relayed but their side is direct, the
// OTHER peer is the restrictive one (this side reads "direct"). When the relay
// can't be attributed (classification=relay but no candidate types), both sides
// fall back to relay — we can't single out the culprit.
function sideStatus(myCand, otherCand, cls) {
  if (cls !== "relay") return cls === "direct" ? "direct" : "unknown";
  if (myCand === "relay") return "relay";
  if (otherCand === "relay") return "direct";
  return "relay";
}

function spanByClient(events, onType, offType, fallbackEnd) {
  const out = new Map();
  const open = new Map();
  const closeSpan = (client, end) => {
    const start = open.get(client);
    if (start == null) return;
    open.delete(client);
    if (!out.has(client)) out.set(client, []);
    out.get(client).push({ start, end });
  };
  for (const e of events) {
    if (e.type === onType && e.actor_client_id) {
      if (!open.has(e.actor_client_id)) open.set(e.actor_client_id, e.ts);
    } else if (e.type === offType && e.actor_client_id) {
      closeSpan(e.actor_client_id, e.ts);
    } else if (e.type === "leave" && e.actor_client_id) {
      // A leaving peer's mute presence is dropped server-side without an explicit
      // unmute broadcast, so close their span at the leave.
      closeSpan(e.actor_client_id, e.ts);
    }
  }
  for (const [client, start] of open) {
    if (!out.has(client)) out.set(client, []);
    out.get(client).push({ start, end: fallbackEnd });
  }
  return out;
}
