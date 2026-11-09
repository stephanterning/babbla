// End-to-end smoke test of the stats facade against a real (temp-file) SQLite
// DB: join/event/transport/leave taps -> batched write -> read API. Also asserts
// the transport dedup (only logs on a classification change) and the live
// snapshot. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStats } from "../stats/index.js";
import { openStatsDb } from "../stats/db.js";

test("facade records, dedups transport, and serves the read API", () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-"));
  const dbPath = join(dir, "stats.db");
  let t = 1_000_000;
  const stats = createStats({
    dbPath,
    hmacSecret: "k",
    now: () => t,
    graceMs: 1_000,
    resumeWindowMs: 5_000,
  });

  try {
    stats.join({ connId: "conn1", clientId: "c1", roomName: "team", ip: "8.8.8.8", userAgent: "Chrome/124" });
    t += 100;
    stats.join({ connId: "conn2", clientId: "c2", roomName: "team", ip: "1.1.1.1", userAgent: "Firefox/120" });
    t += 100;
    stats.event({ connId: "conn1", type: "camera-on" });
    t += 50;
    // Transport dedup: relay logged, duplicate relay ignored, direct logged.
    stats.transport({ connId: "conn1", targetConnId: "conn2", classification: "relay" });
    stats.transport({ connId: "conn1", targetConnId: "conn2", classification: "relay" }); // dup -> ignored
    t += 50;
    stats.transport({ connId: "conn1", targetConnId: "conn2", classification: "direct" });
    t += 100;
    stats.event({ connId: "conn1", type: "camera-off" });
    stats.leave({ connId: "conn1", reason: "explicit" });
    stats.leave({ connId: "conn2", reason: "ws-close" });

    stats._recorder.flush();

    // Inspect raw rows via a second read-only handle to assert dedup precisely.
    const reader = openStatsDb(dbPath);
    const transportRows = reader.all("SELECT * FROM events WHERE type = 'transport' ORDER BY ts, id");
    assert.equal(transportRows.length, 2, "duplicate relay report must be deduped");
    assert.equal(JSON.parse(transportRows[0].payload).classification, "relay");
    assert.equal(JSON.parse(transportRows[1].payload).classification, "direct");

    const joinRows = reader.all("SELECT * FROM events WHERE type = 'join'");
    assert.equal(joinRows.length, 2);
    // Room name is never stored in clear text.
    for (const r of reader.all("SELECT DISTINCT room_hash FROM events")) {
      assert.doesNotMatch(String(r.room_hash), /team/);
    }
    reader.close();

    // Read API.
    const q = stats.query();
    assert.ok(q.totalEvents >= 6);
    assert.equal(q.relay.participantsWithRelay, 2); // both endpoints of the relay pair
    assert.equal(q.relay.maxConcurrentRelayPairs, 1);
    assert.ok(q.concurrency.length > 0);
    assert.ok(q.concurrency.every((p) => "relayPairs" in p)); // relay-pairs line is populated

    // Session timeline for the one session.
    assert.ok(q.sessions.length >= 1);
    const tl = stats.timeline(q.sessions[0].roomSessionId);
    assert.ok(tl.participants.length >= 1);

    // Live snapshot from the in-memory registry view.
    const live = stats.live([{ name: "team", peerCount: 2 }]);
    assert.equal(live.participantsNow, 2);
    assert.equal(live.roomsNow, 1);
  } finally {
    stats.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("query window INSIDE a live session shows presence + relay (bracketing events outside it)", () => {
  const t0 = 2_000_000;
  let t = t0;
  const stats = createStats({ dbPath: ":memory:", hmacSecret: "k", now: () => t, graceMs: 1_000 });
  try {
    // A call: both join + a relay link at t0, both leave 10 min later. Nothing
    // happens in between — the kind of gap a deep zoom lands in.
    stats.join({ connId: "a1", clientId: "a", roomName: "r", ip: "", userAgent: "" });
    stats.join({ connId: "b1", clientId: "b", roomName: "r", ip: "", userAgent: "" });
    stats.transport({ connId: "a1", targetConnId: "b1", classification: "relay" });
    t = t0 + 600_000;
    stats.leave({ connId: "a1", reason: "explicit" });
    stats.leave({ connId: "b1", reason: "explicit" });
    stats._recorder.flush();

    // Window from +2min to +5min: no events of its own, but the call was live.
    const q = stats.query({ fromMs: t0 + 120_000, toMs: t0 + 300_000 });
    assert.equal(q.totalEvents, 0, "no events literally inside the window");
    assert.equal(Math.max(...q.concurrency.map((p) => p.participants)), 2, "both present across the window");
    assert.equal(Math.max(...q.concurrency.map((p) => p.relayPairs)), 1);
    assert.equal(q.relay.maxConcurrentRelayPairs, 1);
    assert.equal(q.relay.participantsWithRelay, 2);
  } finally {
    stats.close();
  }
});

test("sessionsInRange lists sessions in a window with a hadRelay flag", () => {
  let t = 5_000_000;
  const stats = createStats({ dbPath: ":memory:", hmacSecret: "k", now: () => t, graceMs: 1000 });
  try {
    // Session 1 (room r1): a relayed pair.
    stats.join({ connId: "a1", clientId: "a", roomName: "r1", ip: "", userAgent: "" });
    stats.join({ connId: "b1", clientId: "b", roomName: "r1", ip: "", userAgent: "" });
    stats.transport({ connId: "a1", targetConnId: "b1", classification: "relay" });
    stats.leave({ connId: "a1", reason: "explicit" });
    stats.leave({ connId: "b1", reason: "explicit" });
    t += 5000;
    // Session 2 (room r2): direct only.
    stats.join({ connId: "c1", clientId: "c", roomName: "r2", ip: "", userAgent: "" });
    stats.join({ connId: "d1", clientId: "d", roomName: "r2", ip: "", userAgent: "" });
    stats.transport({ connId: "c1", targetConnId: "d1", classification: "direct" });
    stats._recorder.flush();

    const { sessions } = stats.sessionsInRange({ fromMs: 0, toMs: t + 1000 });
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((s) => s.participants === 2));
    assert.deepEqual(sessions.map((s) => s.hadRelay).sort(), [false, true]);

    // A window before any events yields nothing.
    assert.equal(stats.sessionsInRange({ fromMs: 0, toMs: 1000 }).sessions.length, 0);
  } finally {
    stats.close();
  }
});

test("createStats fails open on an unwritable DB path (never throws into startup)", () => {
  // A path under a non-existent directory makes openStatsDb throw; createStats
  // must fall back (in-memory / no-op) rather than crash babbla.
  let stats;
  assert.doesNotThrow(() => {
    stats = createStats({ dbPath: "/no/such/dir/xyz/stats.db", hmacSecret: "k", now: () => 1 });
  });
  try {
    // Taps are safe and reads work (live needs no DB).
    stats.join({ connId: "c1", clientId: "ca", roomName: "r", ip: "", userAgent: "" });
    stats._recorder.flush?.();
    const q = stats.query();
    assert.equal(typeof q.totalEvents, "number");
    assert.equal(stats.live([{ name: "r", peerCount: 2 }]).participantsNow, 2);
  } finally {
    stats.close();
  }
});

test("reconnect after a brief drop reuses the session id (not a new session)", () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-"));
  const dbPath = join(dir, "stats.db");
  let t = 2_000_000;
  const stats = createStats({ dbPath, hmacSecret: "k", now: () => t, graceMs: 10_000 });
  try {
    stats.join({ connId: "a1", clientId: "cX", roomName: "r", ip: "", userAgent: "" });
    stats.leave({ connId: "a1", reason: "ws-close" });
    t += 2_000; // within grace
    stats.join({ connId: "a2", clientId: "cX", roomName: "r", ip: "", userAgent: "" });
    stats._recorder.flush();

    const reader = openStatsDb(dbPath);
    const starts = reader.all("SELECT * FROM events WHERE type = 'room-session-start'");
    const reconnects = reader.all("SELECT * FROM events WHERE type = 'reconnect'");
    reader.close();
    assert.equal(starts.length, 1, "only one session should be started");
    assert.equal(reconnects.length, 1, "the return is a reconnect, not a new join");
  } finally {
    stats.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
