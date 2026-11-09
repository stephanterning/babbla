// Seed a demo stats DB with realistic synthetic usage so you can SEE how the
// /stats dashboard looks fully populated before deploying anywhere.
//
//   node scripts/stats-seed-demo.mjs [dbPath] [days] [sessions]
//   STATS_DB_PATH=./stats-demo.db STATS_HMAC_SECRET=demo node server.js
//   # open http://localhost:8080/stats
//
// It writes well-formed events straight into the SQLite store (the same schema
// server.js reads), spread over the past `days`, so the time-series, dwell,
// per-ASN relay, room and media charts and the session timeline all have content.
// Defaults: ./stats-demo.db, 7 days, 24 sessions. The DB is a throwaway demo file
// (gitignored); delete it to start over.

import { openStatsDb } from "../stats/db.js";
import { createRoomHasher } from "../stats/hash.js";
import { randomUUID } from "node:crypto";

const dbPath = process.argv[2] || "./stats-demo.db";
const DAYS = Number(process.argv[3]) || 7;
const SESSIONS = Number(process.argv[4]) || 24;

const hashRoom = createRoomHasher(process.env.STATS_HMAC_SECRET || "demo", () => {});
const ROOMS = ["standup", "lunchrum", "parprogrammering", "fika", "retro"];
// Realistic-ish networks; the mobile/CGNAT one is relay-prone so the per-ASN
// relay chart has signal.
const NETWORKS = [
  { asn: 3301, org: "Telia Company", country: "SE", relayProne: false },
  { asn: 2119, org: "Telenor Norge", country: "NO", relayProne: false },
  { asn: 39651, org: "Com Hem", country: "SE", relayProne: false },
  { asn: 8473, org: "Bahnhof", country: "SE", relayProne: false },
  { asn: 1257, org: "Tele2 Mobile", country: "SE", relayProne: true },
  { asn: null, org: null, country: null, relayProne: false }, // XFF off / unknown
];
const UAS = [
  { ua_browser: "Chrome", ua_version_major: "124", ua_os: "macOS", is_ios: 0, is_chromium: 1 },
  { ua_browser: "Chrome", ua_version_major: "124", ua_os: "Windows", is_ios: 0, is_chromium: 1 },
  { ua_browser: "Safari", ua_version_major: "17", ua_os: "iOS", is_ios: 1, is_chromium: 0 },
  { ua_browser: "Firefox", ua_version_major: "120", ua_os: "Linux", is_ios: 0, is_chromium: 0 },
  { ua_browser: "Edge", ua_version_major: "124", ua_os: "Windows", is_ios: 0, is_chromium: 1 },
];

const MIN = 60_000;
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[randInt(0, arr.length - 1)];
const chance = (p) => Math.random() < p;

const store = openStatsDb(dbPath);
const rows = [];
const now = Date.now();
const BUILD = "2026-06-28 21:00:00 demo";
const ENV = process.env.APP_ENV || "demo";

function emit(ts, type, extra = {}) {
  rows.push({ ts: Math.round(ts), type, build_version: BUILD, env: ENV, ...extra });
}

function meta(p) {
  return {
    asn: p.net.asn,
    asn_org: p.net.org,
    country: p.net.country,
    ua_browser: p.ua.ua_browser,
    ua_version_major: p.ua.ua_version_major,
    ua_os: p.ua.ua_os,
    is_ios: p.ua.is_ios,
    is_chromium: p.ua.is_chromium,
  };
}

function seedSession() {
  const room = pick(ROOMS);
  const roomHash = hashRoom(room);
  const sid = randomUUID();
  const start = now - rand(0, DAYS * 24 * MIN * 60);
  const durationMin = rand(3, 50);
  const end0 = start + durationMin * MIN;
  const n = randInt(2, 5);

  const participants = Array.from({ length: n }, () => ({
    clientId: randomUUID().slice(0, 8),
    net: pick(NETWORKS),
    ua: pick(UAS),
    joinAt: start + rand(0, durationMin * 0.3 * MIN),
    leaveAt: end0 - rand(0, durationMin * 0.3 * MIN),
  }));
  participants[0].joinAt = start; // first joiner opens the room

  emit(start, "room-session-start", { room_hash: roomHash, room_session_id: sid });

  let lastTs = start;
  const base = (p) => ({ room_hash: roomHash, room_session_id: sid, actor_client_id: p.clientId, actor_conn_id: randomUUID(), ...meta(p) });

  for (const p of participants) {
    emit(p.joinAt, "join", base(p));
    lastTs = Math.max(lastTs, p.joinAt);
    // Occasional reconnect mid-session (same client_id, new conn).
    if (chance(0.25)) {
      const dropAt = rand(p.joinAt, p.leaveAt);
      emit(dropAt, "leave", { ...base(p), payload: JSON.stringify({ reason: "ws-close" }) });
      const backAt = Math.min(dropAt + rand(2_000, 20_000), p.leaveAt);
      emit(backAt, "reconnect", base(p));
    }
    // Camera usage.
    if (chance(0.6)) {
      const on = rand(p.joinAt, (p.joinAt + p.leaveAt) / 2);
      const off = rand(on, p.leaveAt);
      emit(on, "camera-on", base(p));
      if (chance(0.8)) emit(off, "camera-off", base(p)); // else closed at leave
    }
    // Mute toggles.
    if (chance(0.5)) {
      const m = rand(p.joinAt, p.leaveAt);
      emit(m, "mute", base(p));
      if (chance(0.7)) emit(rand(m, p.leaveAt), "unmute", base(p));
    }
  }

  // One screen sharer for part of the session.
  if (chance(0.5)) {
    const sharer = pick(participants);
    const on = rand(sharer.joinAt, (sharer.joinAt + sharer.leaveAt) / 2);
    emit(on, "share-on", base(sharer));
    if (chance(0.7)) emit(rand(on, sharer.leaveAt), "share-off", base(sharer));
  }

  // Transport per pair, reported a bit after both joined. Relay if either side
  // is on a relay-prone network (with some probability), else direct.
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      const a = participants[i];
      const b = participants[j];
      const t = Math.max(a.joinAt, b.joinAt) + rand(500, 4000);
      if (t >= Math.min(a.leaveAt, b.leaveAt)) continue;
      const relay = (a.net.relayProne || b.net.relayProne) && chance(0.7);
      // Attribute the relay candidate to the restrictive (relay-prone) side(s),
      // so the detail timeline marks the failing party — not both.
      emit(t, "transport", {
        ...base(a),
        target_client_id: b.clientId,
        payload: JSON.stringify({
          classification: relay ? "relay" : "direct",
          localCandidateType: relay && a.net.relayProne ? "relay" : "srflx",
          remoteCandidateType: relay && b.net.relayProne ? "relay" : "srflx",
        }),
      });
    }
  }

  for (const p of participants) emit(p.leaveAt, "leave", { ...base(p), payload: JSON.stringify({ reason: "explicit" }) });
  const end = Math.max(...participants.map((p) => p.leaveAt));
  emit(end, "room-session-end", { room_hash: roomHash, room_session_id: sid });
}

for (let i = 0; i < SESSIONS; i++) seedSession();
rows.sort((a, b) => a.ts - b.ts);
store.insert(rows);
store.close();

console.log(`Seedade ${SESSIONS} sessioner (${rows.length} events) över ${DAYS} dagar -> ${dbPath}`);
console.log("Kör sedan:");
console.log(`  STATS_DB_PATH=${dbPath} STATS_HMAC_SECRET=${process.env.STATS_HMAC_SECRET || "demo"} node server.js`);
console.log("  öppna http://localhost:8080/stats");
