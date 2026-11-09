// Unit tests for the Stage director (public/js/stage.js). Pure module, no DOM —
// drive it with event method calls and assert on the StageView it returns. Run
// with `npm test` (node --test).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createStageDirector } from "../public/js/stage.js";

/** A director with self-id set, the common starting point. */
function director(selfId = "me") {
  const s = createStageDirector();
  s.setSelfId(selfId);
  return s;
}

test("no presence, no focus → compact, nothing on stage", () => {
  const s = director();
  const v = s.view();
  assert.equal(v.focus, null);
  assert.equal(v.layoutMode, "compact");
  assert.equal(v.fullscreenButtonVisible, false);
  assert.equal(v.gridSharerTile, null);
});

test("sharer starting/stopping drives the stage and layout", () => {
  const s = director();
  s.peerJoined("a");

  s.setSharer("a");
  let v = s.view();
  assert.deepEqual(v.focus, { peerId: "a", type: "screen", isSelf: false });
  assert.equal(v.layoutMode, "expanded");
  assert.equal(v.fullscreenButtonVisible, true); // remote focus, not fullscreen

  s.setSharer(null);
  v = s.view();
  assert.equal(v.focus, null);
  assert.equal(v.layoutMode, "compact");
});

test("a pinned peer leaving auto-exits fullscreen", () => {
  const s = director();
  s.peerJoined("a");
  s.setSharer("a");
  assert.equal(s.enterFullscreen(), true);
  assert.equal(s.view().fullscreen, true);

  s.peerLeft("a");
  const v = s.view();
  assert.equal(v.fullscreen, false);
  assert.equal(v.focus, null);
});

test("camera focus is invalidated when that peer drops their camera", () => {
  const s = director();
  s.peerJoined("a");
  s.setCamera("a", true);
  s.focusClick("a", "camera");
  assert.deepEqual(s.view().focus, { peerId: "a", type: "camera", isSelf: false });

  s.setCamera("a", false);
  assert.equal(s.view().focus, null); // the one invalidation rule, in one place
});

test("fullscreen suppresses every other peer and sets the focus target", () => {
  const s = director();
  s.peerJoined("a");
  s.peerJoined("b");
  s.peerJoined("c");
  s.setCamera("a", true);
  s.focusClick("a", "camera");
  s.enterFullscreen();

  const v = s.view();
  assert.equal(v.fullscreen, true);
  assert.deepEqual([...v.suppressPeers].sort(), ["b", "c"]);
  assert.equal(v.cameraFocusTarget, "a");

  s.exitFullscreen();
  const v2 = s.view();
  assert.equal(v2.suppressPeers.size, 0);
  assert.equal(v2.cameraFocusTarget, "a"); // still focused, just not fullscreen
});

test("cameraFocusTarget clears when focus moves off a remote camera", () => {
  const s = director();
  s.peerJoined("a");
  s.setCamera("a", true);
  s.focusClick("a", "camera");
  assert.equal(s.view().cameraFocusTarget, "a");

  s.focusClick("a", "camera"); // toggle off
  assert.equal(s.view().cameraFocusTarget, null);
});

test("gallery layout when cameras are on but nothing is focused", () => {
  const s = director();
  s.peerJoined("a");
  s.setCamera("a", true);
  assert.equal(s.view().layoutMode, "gallery");
});

test("compact-wide once 5+ participants with no cameras and no focus", () => {
  const s = director();
  s.peerJoined("a");
  s.peerJoined("b");
  s.peerJoined("c");
  let v = s.view();
  assert.equal(v.participantCount, 4);
  assert.equal(v.layoutMode, "compact");

  s.peerJoined("d");
  v = s.view();
  assert.equal(v.participantCount, 5);
  assert.equal(v.layoutMode, "compact-wide");
});

test("self camera focus marks selfCameraEnlarged and is not a fullscreen/grid case", () => {
  const s = director();
  s.setCamera("me", true);
  s.focusClick("me", "camera");
  const v = s.view();
  assert.equal(v.selfCameraEnlarged, true);
  assert.deepEqual(v.focus, { peerId: "me", type: "camera", isSelf: true });
  assert.equal(v.fullscreenButtonVisible, false); // self can't be fullscreened
  assert.equal(s.enterFullscreen(), false);
});

test("self default screen share is a localSmallShare; explicit focus is not", () => {
  const s = director();
  s.setSharer("me"); // I started sharing
  let v = s.view();
  assert.deepEqual(v.focus, { peerId: "me", type: "screen", isSelf: true });
  assert.equal(v.localSmallShare, true);
  assert.equal(v.hasUserFocus, false);

  s.focusClick("me", "screen"); // explicitly enlarge my own share
  v = s.view();
  assert.equal(v.localSmallShare, false);
  assert.equal(v.hasUserFocus, true);
});

test("opting out of video invalidates an existing camera focus", () => {
  const s = director();
  s.peerJoined("a");
  s.setCamera("a", true);
  s.focusClick("a", "camera");
  assert.ok(s.view().focus);

  s.setSelfVideoOptOut(true);
  assert.equal(s.view().focus, null);
});

test("grid sharer thumbnail shows only with a non-screen user focus", () => {
  const s = director();
  s.peerJoined("a"); // sharer
  s.peerJoined("b");
  s.setSharer("a");
  s.setCamera("b", true);

  // Default focus is the share → no grid thumbnail (it's on stage).
  assert.equal(s.view().gridSharerTile, null);

  // Focus b's camera → the share moves to a grid thumbnail.
  s.focusClick("b", "camera");
  assert.equal(s.view().gridSharerTile, "a");

  // Focus the share itself → no thumbnail.
  s.focusClick("a", "screen");
  assert.equal(s.view().gridSharerTile, null);
});

test("presence reads back for video classification gating", () => {
  const s = director();
  s.peerJoined("a");
  s.setSharer("a");
  s.setCamera("a", true);
  assert.equal(s.getSharerId(), "a");
  assert.equal(s.hasCamera("a"), true);
  assert.equal(s.hasCamera("b"), false);
});

test("reset clears all presence and intent", () => {
  const s = director();
  s.peerJoined("a");
  s.setSharer("a");
  s.setCamera("a", true);
  s.focusClick("a", "screen");

  s.reset();
  const v = s.view();
  assert.equal(v.focus, null);
  assert.equal(v.participantCount, 1);
  assert.equal(v.layoutMode, "compact");
  assert.equal(s.getSharerId(), null);
});
