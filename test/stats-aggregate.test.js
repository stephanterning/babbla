// Unit tests for the pure dashboard aggregations (stats/aggregate.js). Drive
// each with a tiny synthetic event log and assert the derived metric. Run with
// `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  concurrencyOverTime,
  relayStats,
  sessionTimeline,
} from "../stats/aggregate.js";

// s1 in room rA: c1 present [0,20), c2 present [10,30).
const baseEvents = [
  { type: "room-session-start", ts: 0, room_hash: "rA", room_session_id: "s1" },
  { type: "join", ts: 0, room_hash: "rA", room_session_id: "s1", actor_client_id: "c1", asn: 100, asn_org: "ACME" },
  { type: "join", ts: 10, room_hash: "rA", room_session_id: "s1", actor_client_id: "c2", asn: 200, asn_org: "TELCO" },
  { type: "leave", ts: 20, room_hash: "rA", room_session_id: "s1", actor_client_id: "c1" },
  { type: "leave", ts: 30, room_hash: "rA", room_session_id: "s1", actor_client_id: "c2" },
  { type: "room-session-end", ts: 30, room_hash: "rA", room_session_id: "s1" },
];

test("concurrencyOverTime samples participants + active rooms", () => {
  const s = concurrencyOverTime(baseEvents, { from: 0, to: 30, buckets: 30 });
  const at = (t) => s.find((p) => p.t === t);
  assert.equal(at(5).participants, 1);
  assert.equal(at(5).rooms, 1);
  assert.equal(at(15).participants, 2);
  assert.equal(at(25).participants, 1);
  assert.equal(at(30).participants, 0); // ends exclusive
  assert.equal(at(15).relayPairs, 0); // no transport events -> no relaying pairs
});

test("concurrencyOverTime samples relaying pairs over time", () => {
  // c1<->c2 relay from ts=10; c1 leaves at 20 so the pair can't relay past then.
  const events = [
    { type: "room-session-start", ts: 0, room_session_id: "s1" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "c1" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "c2" },
    {
      type: "transport", ts: 10, room_session_id: "s1",
      actor_client_id: "c1", target_client_id: "c2",
      payload: JSON.stringify({ classification: "relay" }),
    },
    { type: "leave", ts: 20, room_session_id: "s1", actor_client_id: "c1" },
    { type: "leave", ts: 30, room_session_id: "s1", actor_client_id: "c2" },
    { type: "room-session-end", ts: 30, room_session_id: "s1" },
  ];
  const s = concurrencyOverTime(events, { from: 0, to: 30, buckets: 30 });
  const at = (t) => s.find((p) => p.t === t);
  assert.equal(at(5).relayPairs, 0); // before the relay classification
  assert.equal(at(15).relayPairs, 1); // relaying, both present
  assert.equal(at(25).relayPairs, 0); // c1 left at 20 -> bounded, no longer relaying
});

test("relayStats: per-participant relay need + per-ASN + max concurrent pairs", () => {
  const events = [
    ...baseEvents,
    {
      type: "transport",
      ts: 15,
      room_hash: "rA",
      room_session_id: "s1",
      actor_client_id: "c1",
      target_client_id: "c2",
      payload: JSON.stringify({ classification: "relay" }),
    },
  ];
  const r = relayStats(events);
  assert.equal(r.totalParticipants, 2);
  assert.equal(r.participantsWithRelay, 2); // both endpoints of the relayed pair
  assert.equal(r.pctWithRelay, 100);
  assert.equal(r.maxConcurrentRelayPairs, 1);
  const asns = Object.fromEntries(r.perAsn.map((a) => [a.asn, a]));
  assert.equal(asns[100].relayed, 1);
  assert.equal(asns[200].relayed, 1);
});

test("relayStats: a 'direct' classification is not a relay need", () => {
  const events = [
    ...baseEvents,
    {
      type: "transport",
      ts: 15,
      room_hash: "rA",
      room_session_id: "s1",
      actor_client_id: "c1",
      target_client_id: "c2",
      payload: JSON.stringify({ classification: "direct" }),
    },
  ];
  const r = relayStats(events);
  assert.equal(r.participantsWithRelay, 0);
  assert.equal(r.maxConcurrentRelayPairs, 0);
});

test("relayStats clips to a window (presence-overlap participants + window-bounded pairs)", () => {
  const events = [
    { type: "room-session-start", ts: 0, room_session_id: "s1" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "c1", asn: 100, asn_org: "ACME" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "c2", asn: 200, asn_org: "TELCO" },
    { type: "transport", ts: 5, room_session_id: "s1", actor_client_id: "c1", target_client_id: "c2", payload: JSON.stringify({ classification: "relay" }) },
    { type: "leave", ts: 40, room_session_id: "s1", actor_client_id: "c1" },
    { type: "leave", ts: 40, room_session_id: "s1", actor_client_id: "c2" },
    { type: "room-session-end", ts: 40, room_session_id: "s1" },
  ];
  // Window [10,20] holds NO events, but both are present and the relay ([5,40]) runs.
  const mid = relayStats(events, { from: 10, to: 20 });
  assert.equal(mid.totalParticipants, 2);
  assert.equal(mid.participantsWithRelay, 2);
  assert.equal(mid.maxConcurrentRelayPairs, 1);
  // Before the relay started: present, but no relay pair yet.
  const early = relayStats(events, { from: 1, to: 3 });
  assert.equal(early.totalParticipants, 2);
  assert.equal(early.participantsWithRelay, 0);
  assert.equal(early.maxConcurrentRelayPairs, 0);
  // After everyone left: nobody present.
  assert.equal(relayStats(events, { from: 50, to: 60 }).totalParticipants, 0);
});

// cameraSpans / screenSpans still ship (sessionTimeline uses them), so their
// edge cases are covered here through the timeline rather than the removed
// mediaUsage aggregate.
test("sessionTimeline camera spans: camera-limit closes all open cameras", () => {
  const events = [
    { type: "room-session-start", ts: 0, room_hash: "rA", room_session_id: "s1" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "c1" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "c2" },
    { type: "camera-on", ts: 2, room_session_id: "s1", actor_client_id: "c1" },
    { type: "camera-on", ts: 4, room_session_id: "s1", actor_client_id: "c2" },
    { type: "camera-limit", ts: 10, room_session_id: "s1" }, // closes both
    { type: "room-session-end", ts: 12, room_session_id: "s1" },
  ];
  const tl = sessionTimeline(events, "s1");
  const camMs = (id) =>
    tl.participants.find((p) => p.clientId === id).camera.reduce((a, c) => a + (c.end - c.start), 0);
  assert.equal(camMs("c1"), 8); // [2,10]
  assert.equal(camMs("c2"), 6); // [4,10]
});

test("sessionTimeline screen spans: latest-sharer-wins (supersede closes prior span)", () => {
  const events = [
    { type: "room-session-start", ts: 0, room_hash: "rA", room_session_id: "s1" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "c1" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "c2" },
    { type: "share-on", ts: 5, room_session_id: "s1", actor_client_id: "c1" },
    { type: "share-on", ts: 15, room_session_id: "s1", actor_client_id: "c2" }, // supersede c1
    { type: "share-off", ts: 25, room_session_id: "s1", actor_client_id: "c2" },
    { type: "room-session-end", ts: 25, room_session_id: "s1" },
  ];
  const tl = sessionTimeline(events, "s1");
  const scr = (id) => tl.participants.find((p) => p.clientId === id).screen;
  assert.deepEqual(scr("c1"), [{ start: 5, end: 15 }]);
  assert.deepEqual(scr("c2"), [{ start: 15, end: 25 }]);
});

test("sessionTimeline shapes per-participant spans + markers", () => {
  const events = [
    ...baseEvents,
    { type: "camera-on", ts: 5, room_session_id: "s1", actor_client_id: "c1" },
    { type: "camera-off", ts: 18, room_session_id: "s1", actor_client_id: "c1" },
    {
      type: "transport",
      ts: 12,
      room_session_id: "s1",
      actor_client_id: "c1",
      target_client_id: "c2",
      payload: JSON.stringify({ classification: "relay" }),
    },
  ];
  const tl = sessionTimeline(events, "s1");
  assert.equal(tl.roomSessionId, "s1");
  assert.equal(tl.start, 0);
  assert.equal(tl.end, 30);
  assert.equal(tl.participants.length, 2);
  const c1 = tl.participants.find((p) => p.clientId === "c1");
  assert.equal(c1.presence.length, 1);
  assert.deepEqual(c1.presence[0], { start: 0, end: 20 });
  assert.equal(c1.camera.length, 1);
  assert.equal(c1.transport.length, 1);
  assert.equal(c1.transport[0].classification, "relay");
});

test("sessionTimeline closes camera/screen spans when the owner leaves (not at session end)", () => {
  const events = [
    { type: "room-session-start", ts: 0, room_session_id: "s1" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "c1" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "c2" },
    { type: "camera-on", ts: 2, room_session_id: "s1", actor_client_id: "c1" },
    { type: "share-on", ts: 2, room_session_id: "s1", actor_client_id: "c1" },
    { type: "leave", ts: 10, room_session_id: "s1", actor_client_id: "c1" }, // c1 leaves early
    { type: "leave", ts: 30, room_session_id: "s1", actor_client_id: "c2" },
    { type: "room-session-end", ts: 30, room_session_id: "s1" },
  ];
  const tl = sessionTimeline(events, "s1");
  const c1 = tl.participants.find((p) => p.clientId === "c1");
  // c1's camera/screen close at the leave (10), not at session end (30).
  assert.equal(c1.camera.reduce((a, c) => a + (c.end - c.start), 0), 8);
  assert.equal(c1.screen.reduce((a, s) => a + (s.end - s.start), 0), 8);
});

test("relay interval ends when an endpoint leaves (no max-concurrent overcount)", () => {
  const relay = (ts, a, b) => ({
    type: "transport",
    ts,
    room_session_id: "s1",
    actor_client_id: a,
    target_client_id: b,
    payload: JSON.stringify({ classification: "relay" }),
  });
  const events = [
    { type: "room-session-start", ts: 0, room_session_id: "s1" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "a" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "b" },
    relay(5, "a", "b"),
    { type: "leave", ts: 10, room_session_id: "s1", actor_client_id: "b" }, // a↔b relay ends here
    { type: "join", ts: 12, room_session_id: "s1", actor_client_id: "c" },
    { type: "join", ts: 12, room_session_id: "s1", actor_client_id: "d" },
    relay(15, "c", "d"),
    { type: "leave", ts: 20, room_session_id: "s1", actor_client_id: "c" },
    { type: "room-session-end", ts: 20, room_session_id: "s1" },
  ];
  // Without bounding, a↔b would run to session end (20) and overlap c↔d -> 2.
  assert.equal(relayStats(events).maxConcurrentRelayPairs, 1);
});

test("sessionTimeline attributes relay to the restrictive party (own candidate relayed)", () => {
  const tp = (ts, a, b, cls, la, lb) => ({
    type: "transport", ts, room_session_id: "s1",
    actor_client_id: a, target_client_id: b,
    payload: JSON.stringify({ classification: cls, localCandidateType: la, remoteCandidateType: lb }),
  });
  const events = [
    { type: "room-session-start", ts: 0, room_session_id: "s1" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "a" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "b" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "c" },
    tp(5, "a", "b", "relay", "relay", "srflx"), // A's own candidate relays -> A restrictive
    tp(6, "a", "c", "direct", "srflx", "srflx"),
    { type: "room-session-end", ts: 20, room_session_id: "s1" },
  ];
  const tl = sessionTimeline(events, "s1");
  const get = (id) => tl.participants.find((p) => p.clientId === id);
  assert.equal(get("a").transport.at(-1).classification, "relay"); // the failing party
  assert.deepEqual(get("a").transport.at(-1).relayPeers, ["b"]);
  assert.equal(get("b").transport.at(-1).classification, "direct"); // on a relayed link but not at fault
  assert.equal(get("c").transport.at(-1).classification, "direct");
});

test("sessionTimeline relay attribution falls back to both sides when undetermined", () => {
  const events = [
    { type: "room-session-start", ts: 0, room_session_id: "s1" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "a" },
    { type: "join", ts: 0, room_session_id: "s1", actor_client_id: "b" },
    // relay with no candidate types -> can't single out the culprit -> both relay.
    { type: "transport", ts: 5, room_session_id: "s1", actor_client_id: "a", target_client_id: "b", payload: JSON.stringify({ classification: "relay" }) },
    { type: "room-session-end", ts: 10, room_session_id: "s1" },
  ];
  const tl = sessionTimeline(events, "s1");
  assert.equal(tl.participants.find((p) => p.clientId === "a").transport.at(-1).classification, "relay");
  assert.equal(tl.participants.find((p) => p.clientId === "b").transport.at(-1).classification, "relay");
});

test("aggregations don't crash on an empty log", () => {
  assert.equal(concurrencyOverTime([], { from: 0, to: 10, buckets: 2 }).length, 3);
  assert.equal(relayStats([]).totalParticipants, 0);
  assert.equal(sessionTimeline([], "nope"), null);
});
