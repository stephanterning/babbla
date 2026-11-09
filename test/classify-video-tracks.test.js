// Unit tests for classifyVideoTracks (public/js/mesh.js) — the pure mid->role
// ->track resolver. Run with `npm test` (node --test). Fake transceiver objects
// stand in for RTCRtpTransceiver: the function only reads `.mid` and
// `.receiver.track.{kind,readyState}`, so no real connection is needed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyVideoTracks } from "../public/js/mesh.js";

/** Build a fake transceiver. Pass kind=null to simulate a sender-only (no track). */
function tx(mid, { kind = "video", readyState = "live" } = {}) {
  return { mid, receiver: { track: kind ? { kind, readyState, _mid: mid } : null } };
}

test("empty transceivers → nothing", () => {
  assert.deepEqual(classifyVideoTracks([], {}), {
    cameraTrack: null,
    screenTrack: null,
  });
});

test("a camera-mapped transceiver resolves to cameraTrack", () => {
  const t = tx("0");
  const { cameraTrack, screenTrack } = classifyVideoTracks([t], { 0: "camera" });
  assert.equal(cameraTrack, t.receiver.track);
  assert.equal(screenTrack, null);
});

test("a screen-mapped transceiver resolves to screenTrack", () => {
  const t = tx("1");
  const { cameraTrack, screenTrack } = classifyVideoTracks([t], { 1: "screen" });
  assert.equal(screenTrack, t.receiver.track);
  assert.equal(cameraTrack, null);
});

test("camera and screen are mapped independently by mid", () => {
  const cam = tx("0");
  const scr = tx("1");
  const out = classifyVideoTracks([cam, scr], { 0: "camera", 1: "screen" });
  assert.equal(out.cameraTrack, cam.receiver.track);
  assert.equal(out.screenTrack, scr.receiver.track);
});

test("ended tracks are skipped", () => {
  const t = tx("0", { readyState: "ended" });
  assert.deepEqual(classifyVideoTracks([t], { 0: "camera" }), {
    cameraTrack: null,
    screenTrack: null,
  });
});

test("non-video tracks are skipped even if the mid is mapped", () => {
  const t = tx("0", { kind: "audio" });
  assert.equal(classifyVideoTracks([t], { 0: "camera" }).cameraTrack, null);
});

test("a transceiver with no mid is skipped", () => {
  const t = tx(null);
  assert.deepEqual(classifyVideoTracks([t], { null: "camera" }), {
    cameraTrack: null,
    screenTrack: null,
  });
});

test("an unmapped mid is left unclassified (no guessing)", () => {
  const t = tx("7");
  assert.deepEqual(classifyVideoTracks([t], {}), {
    cameraTrack: null,
    screenTrack: null,
  });
});

test("a sender-only transceiver (no inbound track) is skipped", () => {
  const t = tx("0", { kind: null });
  assert.equal(classifyVideoTracks([t], { 0: "camera" }).cameraTrack, null);
});

test("a missing/undefined role map does not throw", () => {
  const t = tx("0");
  assert.deepEqual(classifyVideoTracks([t], undefined), {
    cameraTrack: null,
    screenTrack: null,
  });
});

test("paused-then-resumed camera (live again) classifies; mid is stable", () => {
  // Mirrors the suppress→resume path: the mid stays mapped, the track is live.
  const cam = tx("0");
  const scr = tx("1");
  const out = classifyVideoTracks([scr, cam], { 0: "camera", 1: "screen" });
  assert.equal(out.cameraTrack, cam.receiver.track);
  assert.equal(out.screenTrack, scr.receiver.track);
});
