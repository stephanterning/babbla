// Unit tests for the session registry (room_session_id lifecycle, grace, and
// deploy-resilient resume) and the open-session derivation. Fake clock + timers
// so we control grace/resume firing. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSessionRegistry } from "../stats/sessions.js";
import { deriveOpenSessions } from "../stats/derive.js";

// A controllable clock + timer harness.
function harness() {
  let t = 1000;
  const timers = new Set();
  const recorded = [];
  let idSeq = 0;
  const reg = createSessionRegistry({
    record: (e) => recorded.push(e),
    now: () => t,
    newId: () => `sess-${++idSeq}`,
    graceMs: 15_000,
    resumeWindowMs: 300_000,
    setTimeoutFn: (fn, ms) => {
      const id = { fn, at: t + ms, cleared: false };
      timers.add(id);
      return id;
    },
    clearTimeoutFn: (id) => id && timers.delete(id),
  });
  const advance = (ms) => {
    t += ms;
    for (const id of [...timers]) {
      if (id.at <= t) {
        timers.delete(id);
        id.fn();
      }
    }
  };
  return { reg, recorded, advance, at: (v) => (t = v), now: () => t };
}

const types = (recorded) => recorded.map((e) => e.type);

test("first join mints a session + records room-session-start", () => {
  const { reg, recorded } = harness();
  const r = reg.onJoin("roomX", "c1", "conn1");
  assert.equal(r.reconnect, false);
  assert.equal(r.roomSessionId, "sess-1");
  assert.deepEqual(types(recorded), ["room-session-start"]);
  assert.equal(recorded[0].room_hash, "roomX");
});

test("second distinct client does not re-start and is not a reconnect", () => {
  const { reg, recorded } = harness();
  reg.onJoin("roomX", "c1", "conn1");
  const r = reg.onJoin("roomX", "c2", "conn2");
  assert.equal(r.reconnect, false);
  assert.equal(r.roomSessionId, "sess-1");
  assert.deepEqual(types(recorded), ["room-session-start"]); // no second start
});

test("a returning client within the same open session is a reconnect", () => {
  const { reg, advance } = harness();
  reg.onJoin("roomX", "c1", "conn1");
  reg.onLeave("roomX", "c1", "conn1"); // room now empty -> grace armed
  advance(5_000); // still within grace
  const r = reg.onJoin("roomX", "c1", "conn2");
  assert.equal(r.reconnect, true);
  assert.equal(r.roomSessionId, "sess-1");
});

test("empty room ends after grace; end ts is last activity, not grace expiry", () => {
  const { reg, recorded, advance, now } = harness();
  reg.onJoin("roomX", "c1", "conn1");
  advance(2_000);
  const leaveAt = now();
  reg.onLeave("roomX", "c1", "conn1");
  advance(15_000); // grace fires
  assert.deepEqual(types(recorded), ["room-session-start", "room-session-end"]);
  assert.equal(recorded[1].ts, leaveAt); // last activity, not now
  assert.equal(reg.activeCount(), 0);
});

test("reconnect before grace cancels the end; no room-session-end fires", () => {
  const { reg, recorded, advance } = harness();
  reg.onJoin("roomX", "c1", "conn1");
  reg.onLeave("roomX", "c1", "conn1");
  advance(10_000);
  reg.onJoin("roomX", "c1", "conn2"); // cancels grace
  advance(60_000);
  assert.deepEqual(types(recorded), ["room-session-start"]); // never ended
});

test("hydrate resumes an open session; a returning client is a reconnect", () => {
  const { reg, recorded, now } = harness();
  reg.hydrate([
    { roomSessionId: "old-1", roomHash: "roomX", lastActivityTs: now(), members: ["c1"] },
  ]);
  assert.deepEqual(types(recorded), []); // hydrate emits nothing yet
  const r = reg.onJoin("roomX", "c1", "conn9");
  assert.equal(r.roomSessionId, "old-1"); // same id resumed
  assert.equal(r.reconnect, true); // c1 was a member
  assert.deepEqual(types(recorded), []); // no new start for a resumed session
});

test("hydrate of a stale session ends it immediately (synthetic end)", () => {
  const h = harness();
  const staleTs = h.now() - 400_000; // older than the 300s resume window
  h.reg.hydrate([
    { roomSessionId: "old-2", roomHash: "roomY", lastActivityTs: staleTs, members: ["c1"] },
  ]);
  // scheduleEnd with delay <= 0 ends synchronously during hydrate.
  assert.deepEqual(types(h.recorded), ["room-session-end"]);
  assert.equal(h.recorded[0].ts, staleTs);
  assert.equal(h.reg.activeCount(), 0);
});

test("deriveOpenSessions: open vs ended, with membership", () => {
  const events = [
    { type: "room-session-start", ts: 1, room_hash: "rA", room_session_id: "s1" },
    { type: "join", ts: 2, room_hash: "rA", room_session_id: "s1", actor_client_id: "c1" },
    { type: "join", ts: 3, room_hash: "rA", room_session_id: "s1", actor_client_id: "c2" },
    // s2 is fully closed.
    { type: "room-session-start", ts: 5, room_hash: "rB", room_session_id: "s2" },
    { type: "join", ts: 6, room_hash: "rB", room_session_id: "s2", actor_client_id: "c3" },
    { type: "leave", ts: 7, room_hash: "rB", room_session_id: "s2", actor_client_id: "c3" },
    { type: "room-session-end", ts: 8, room_hash: "rB", room_session_id: "s2" },
  ];
  const open = deriveOpenSessions(events);
  assert.equal(open.length, 1);
  assert.equal(open[0].roomSessionId, "s1");
  assert.equal(open[0].roomHash, "rA");
  assert.equal(open[0].lastActivityTs, 3);
  assert.deepEqual(open[0].members.sort(), ["c1", "c2"]);
});
