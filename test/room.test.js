// Unit tests for the Room presence state machine (room.js). Pure — drive it
// with method calls and assert on the returned effects (`{ to: [...], msg }`),
// no sockets. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRoom,
  createRoomRegistry,
  sanitizeRoomName,
  DEFAULT_ROOM,
} from "../room.js";

/** Find the effect whose msg.type matches, else undefined. */
const effect = (effects, type) => effects.find((e) => e.msg.type === type);

test("join welcomes the newcomer and announces to existing peers", () => {
  const room = createRoom();
  room.join("a", "Alice");
  const effects = room.join("b", "Bob");

  const welcome = effect(effects, "welcome");
  assert.deepEqual(welcome.to, ["b"]); // only the joiner
  assert.equal(welcome.msg.id, "b");
  assert.deepEqual(welcome.msg.peers, [{ id: "a", name: "Alice" }]); // excludes self
  assert.equal(welcome.msg.sharer, null);
  assert.equal(welcome.msg.buildVersion, "");

  const joined = effect(effects, "peer-joined");
  assert.deepEqual(joined.to, ["a"]); // existing peers only
  assert.deepEqual(joined.msg, { type: "peer-joined", id: "b", name: "Bob" });
});

test("welcome carries the room buildVersion stamp", () => {
  const room = createRoom({ buildVersion: "2026-06-24 deadbeef" });
  const effects = room.join("a", "Alice");
  assert.equal(effect(effects, "welcome").msg.buildVersion, "2026-06-24 deadbeef");
});

test("a blank name becomes Anon and a long name is clamped to 40 chars", () => {
  const room = createRoom();
  room.join("a", "Alice");
  const blank = room.join("b", "   ");
  assert.equal(effect(blank, "peer-joined").msg.name, "Anon");
  const long = room.join("c", "x".repeat(99));
  assert.equal(effect(long, "peer-joined").msg.name.length, 40);
});

test("a duplicate join for a known id is ignored", () => {
  const room = createRoom();
  room.join("a", "Alice");
  assert.deepEqual(room.join("a", "Alice again"), []);
});

test("messages from an unknown id produce no effects (join guard)", () => {
  const room = createRoom();
  assert.deepEqual(room.signal("ghost", "a", {}), []);
  assert.deepEqual(room.share("ghost", true), []);
  assert.deepEqual(room.camera("ghost", true), []);
  assert.deepEqual(room.cameraFocus("ghost", "a", true), []);
});

test("signal relays only to the target peer", () => {
  const room = createRoom();
  room.join("a", "A");
  room.join("b", "B");
  const eff = room.signal("a", "b", { sdp: 1 });
  assert.deepEqual(eff, [
    { to: ["b"], msg: { type: "signal", from: "a", data: { sdp: 1 } } },
  ]);
  // Unknown target → dropped.
  assert.deepEqual(room.signal("a", "nobody", {}), []);
});

test("share is latest-wins and broadcasts to others", () => {
  const room = createRoom();
  room.join("a", "A");
  room.join("b", "B");

  let eff = room.share("a", true);
  assert.deepEqual(eff[0].to, ["b"]);
  assert.deepEqual(eff[0].msg, { type: "sharer", id: "a", name: "A" });

  // b takes over.
  eff = room.share("b", true);
  assert.deepEqual(eff[0].msg, { type: "sharer", id: "b", name: "B" });

  // a is no longer the holder → its "off" is a no-op.
  assert.deepEqual(room.share("a", false), []);

  // b turns off → sharer null.
  eff = room.share("b", false);
  assert.deepEqual(eff[0].msg, { type: "sharer", id: null });
});

test("camera presence broadcasts to all (including sender)", () => {
  const room = createRoom();
  room.join("a", "A");
  room.join("b", "B");
  const eff = room.camera("a", true);
  assert.deepEqual(eff[0].to.sort(), ["a", "b"]); // includes sender
  assert.deepEqual(eff[0].msg, { type: "camera", id: "a", on: true });
  // Idempotent on: already on → no effect.
  assert.deepEqual(room.camera("a", true), []);
});

test("the camera cap turns all cameras off on the over-limit attempt", () => {
  const room = createRoom({ maxCameras: 2 });
  room.join("a", "A");
  room.join("b", "B");
  room.join("c", "C");
  assert.equal(room.camera("a", true)[0].msg.type, "camera");
  assert.equal(room.camera("b", true)[0].msg.type, "camera");
  // 3rd camera exceeds the cap of 2 → camera-limit broadcast, no camera-on.
  const eff = room.camera("c", true);
  assert.deepEqual(eff, [
    { to: ["a", "b", "c"], msg: { type: "camera-limit", reason: "max_cameras" } },
  ]);
  // All cameras were cleared, so a fresh camera-on is allowed again.
  assert.equal(room.camera("c", true)[0].msg.type, "camera");
});

test("mute presence broadcasts to others only and is idempotent", () => {
  const room = createRoom();
  room.join("a", "A");
  room.join("b", "B");
  const eff = room.mute("a", true);
  assert.deepEqual(eff, [{ to: ["b"], msg: { type: "mute", id: "a", on: true } }]);
  // Already muted -> no-op (no re-broadcast spam).
  assert.deepEqual(room.mute("a", true), []);
  // Unmute broadcasts the off, also to others only.
  assert.deepEqual(room.mute("a", false), [
    { to: ["b"], msg: { type: "mute", id: "a", on: false } },
  ]);
  // Already unmuted -> no-op.
  assert.deepEqual(room.mute("a", false), []);
  // Unknown sender -> dropped (join guard).
  assert.deepEqual(room.mute("ghost", true), []);
});

test("welcome carries the current muted roster to a newcomer", () => {
  const room = createRoom();
  room.join("a", "A");
  room.mute("a", true);
  const eff = room.join("b", "B");
  assert.deepEqual(effect(eff, "welcome").msg.muted, ["a"]);
});

test("remove clears the muted flag without an extra unmute broadcast", () => {
  const room = createRoom();
  room.join("a", "A");
  room.join("b", "B");
  room.mute("a", true);
  const eff = room.remove("a");
  // Only sharer/camera (held presence) + peer-left fire; no standalone "mute".
  assert.deepEqual(eff.map((e) => e.msg.type), ["peer-left"]);
  // A fresh peer reusing the id is not pre-flagged as muted.
  const re = room.join("a", "A2");
  assert.deepEqual(effect(re, "welcome").msg.muted, []);
});

test("dnd presence broadcasts to others only and is idempotent", () => {
  const room = createRoom();
  room.join("a", "A");
  room.join("b", "B");
  const eff = room.dnd("a", true);
  assert.deepEqual(eff, [{ to: ["b"], msg: { type: "dnd", id: "a", on: true } }]);
  // Already in DND -> no-op (no re-broadcast spam).
  assert.deepEqual(room.dnd("a", true), []);
  // Leaving DND broadcasts the off, also to others only.
  assert.deepEqual(room.dnd("a", false), [
    { to: ["b"], msg: { type: "dnd", id: "a", on: false } },
  ]);
  // Already out -> no-op.
  assert.deepEqual(room.dnd("a", false), []);
  // Unknown sender -> dropped (join guard).
  assert.deepEqual(room.dnd("ghost", true), []);
});

test("welcome carries the current dnd roster to a newcomer", () => {
  const room = createRoom();
  room.join("a", "A");
  room.dnd("a", true);
  const eff = room.join("b", "B");
  assert.deepEqual(effect(eff, "welcome").msg.dnd, ["a"]);
});

test("remove clears the dnd flag without an extra broadcast", () => {
  const room = createRoom();
  room.join("a", "A");
  room.join("b", "B");
  room.dnd("a", true);
  const eff = room.remove("a");
  assert.deepEqual(eff.map((e) => e.msg.type), ["peer-left"]);
  // A fresh peer reusing the id is not pre-flagged as DND.
  const re = room.join("a", "A2");
  assert.deepEqual(effect(re, "welcome").msg.dnd, []);
});

test("video-opt-out broadcasts the flag to all", () => {
  const room = createRoom();
  room.join("a", "A");
  room.join("b", "B");
  const eff = room.videoOptOut("a", true);
  assert.deepEqual(eff[0].msg, { type: "video-opt-out", id: "a", on: true });
  assert.deepEqual(eff[0].to.sort(), ["a", "b"]);
});

test("camera-focus and video-suppress relay to the target only", () => {
  const room = createRoom();
  room.join("a", "A");
  room.join("b", "B");
  assert.deepEqual(room.cameraFocus("a", "b", true), [
    { to: ["b"], msg: { type: "camera-focus", id: "a", on: true } },
  ]);
  assert.deepEqual(room.videoSuppress("a", "b", true), [
    { to: ["b"], msg: { type: "video-suppress", id: "a", on: true } },
  ]);
  // Missing/unknown target → dropped.
  assert.deepEqual(room.cameraFocus("a", "", true), []);
  assert.deepEqual(room.videoSuppress("a", "ghost", true), []);
});

test("remove relinquishes sharer + camera and announces the leave", () => {
  const room = createRoom();
  room.join("a", "A");
  room.join("b", "B");
  room.share("a", true);
  room.camera("a", true);

  const eff = room.remove("a");
  const types = eff.map((e) => e.msg.type);
  assert.deepEqual(types, ["sharer", "camera", "peer-left"]);
  assert.equal(effect(eff, "sharer").msg.id, null);
  assert.deepEqual(effect(eff, "camera").msg, { type: "camera", id: "a", on: false });
  assert.deepEqual(effect(eff, "peer-left").msg, { type: "peer-left", id: "a" });
  // Everything goes to the remaining peer.
  for (const e of eff) assert.deepEqual(e.to, ["b"]);
  assert.equal(room.hasPeer("a"), false);
});

test("removing a peer with no presence held only announces the leave", () => {
  const room = createRoom();
  room.join("a", "A");
  room.join("b", "B");
  const eff = room.remove("b");
  assert.deepEqual(eff.map((e) => e.msg.type), ["peer-left"]);
  // Removing an unknown id is a no-op.
  assert.deepEqual(room.remove("ghost"), []);
});

test("welcome omits iceServers when no provider is given (STUN-only client)", () => {
  const room = createRoom();
  const welcome = effect(room.join("a", "A"), "welcome").msg;
  assert.equal(welcome.iceServers, undefined);
  assert.equal(welcome.iceRefreshMs, undefined);
});

test("welcome carries the injected TURN iceServers + refresh cadence", () => {
  const turn = {
    iceServers: [{ urls: ["turn:t.example:3478"], username: "u", credential: "c" }],
    refreshMs: 1800_000,
  };
  const room = createRoom({ getIceServers: () => turn });
  const welcome = effect(room.join("a", "A"), "welcome").msg;
  assert.deepEqual(welcome.iceServers, turn.iceServers);
  assert.equal(welcome.iceRefreshMs, 1800_000);
});

test("iceRefresh hands a known peer fresh creds, and is a no-op otherwise", () => {
  let n = 0;
  // A provider that returns a *fresh* username each call, modelling the rolling
  // ephemeral credential the server actually computes per request.
  const provider = () => ({
    iceServers: [{ urls: ["turn:t:3478"], username: `u${++n}`, credential: "c" }],
    refreshMs: 1800_000,
  });
  const room = createRoom({ getIceServers: provider });
  room.join("a", "A");
  const eff = room.iceRefresh("a");
  assert.deepEqual(eff[0].to, ["a"]);
  assert.equal(eff[0].msg.type, "ice-refresh");
  assert.equal(eff[0].msg.iceServers[0].username, "u2"); // u1 was the welcome
  assert.equal(eff[0].msg.iceRefreshMs, 1800_000);
  // Unknown sender -> dropped (join guard).
  assert.deepEqual(room.iceRefresh("ghost"), []);
});

test("iceRefresh is a no-op when TURN is unconfigured", () => {
  const room = createRoom();
  room.join("a", "A");
  assert.deepEqual(room.iceRefresh("a"), []);
});

test("the registry threads the TURN provider into each room", () => {
  const turn = {
    iceServers: [{ urls: ["turn:t:3478"], username: "u", credential: "c" }],
    refreshMs: 1800_000,
  };
  const reg = createRoomRegistry({ getIceServers: () => turn });
  const welcome = effect(reg.get("alpha").join("a", "A"), "welcome").msg;
  assert.deepEqual(welcome.iceServers, turn.iceServers);
});

test("sanitizeRoomName lowercases but otherwise keeps names verbatim", () => {
  assert.equal(sanitizeRoomName("myownroom232"), "myownroom232");
  // Case folds together: SmartTV and smarttv are the same room.
  assert.equal(sanitizeRoomName("SmartTV"), "smarttv");
  assert.equal(sanitizeRoomName("Team-A_1"), "team-a_1");
  // Punctuation/spaces are preserved verbatim (only lowercased), so distinct
  // names stay distinct: "smart-tv" != "smart tv" != "smart.tv".
  assert.equal(sanitizeRoomName("Smart-TV"), "smart-tv");
  assert.equal(sanitizeRoomName("Smart TV"), "smart tv");
  assert.equal(sanitizeRoomName("smart.tv"), "smart.tv");
  assert.notEqual(sanitizeRoomName("smart.tv"), sanitizeRoomName("smarttv"));
  // A digits-only name (e.g. /room/0) is a real, distinct room — not the default.
  assert.equal(sanitizeRoomName("0"), "0");
  // Valid falsy non-strings stay their value (?? not ||): 0 -> "0", not default.
  assert.equal(sanitizeRoomName(0), "0");
});

test("sanitizeRoomName folds empty/garbage to the default room", () => {
  assert.equal(sanitizeRoomName(""), DEFAULT_ROOM);
  assert.equal(sanitizeRoomName(null), DEFAULT_ROOM);
  assert.equal(sanitizeRoomName(undefined), DEFAULT_ROOM);
  assert.equal(sanitizeRoomName("   "), DEFAULT_ROOM); // trimmed to empty -> default
});

test("sanitizeRoomName strips the lone structural char and control chars", () => {
  // `/` is the segment separator, never part of a name.
  assert.equal(sanitizeRoomName("/../../etc"), "....etc");
  assert.equal(sanitizeRoomName("a/b/c"), "abc");
  // Non-printable control chars are dropped (can't be typed in a real link).
  assert.equal(sanitizeRoomName("smar\u0000t\u001ftv\u007f"), "smarttv");
});

test("sanitizeRoomName caps length at 64 (truncate, no error)", () => {
  assert.equal(sanitizeRoomName("x".repeat(200)).length, 64);
});

test("registry isolates rooms and creates them on demand", () => {
  const reg = createRoomRegistry();
  const alpha = reg.get("alpha");
  const beta = reg.get("beta");
  assert.notEqual(alpha, beta);
  assert.equal(reg.get("alpha"), alpha); // same instance on re-get
  assert.equal(reg.size(), 2);

  // A peer in alpha is invisible to beta: alpha's join announces to no one in beta.
  alpha.join("a", "Alice");
  beta.join("b", "Bob");
  // Alice's presence only lives in alpha.
  assert.equal(alpha.hasPeer("a"), true);
  assert.equal(beta.hasPeer("a"), false);
});

test("registry drops a room once its last peer leaves", () => {
  const reg = createRoomRegistry();
  const room = reg.get("alpha");
  room.join("a", "A");
  reg.removeIfEmpty("alpha");
  assert.equal(reg.has("alpha"), true); // still has a peer
  room.remove("a");
  reg.removeIfEmpty("alpha");
  assert.equal(reg.has("alpha"), false); // empty -> dropped
  assert.equal(reg.size(), 0);
});
