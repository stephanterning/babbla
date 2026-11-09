import test from "node:test";
import assert from "node:assert/strict";

import {
  STACK_CAP,
  entryFromValue,
  entryKey,
  isSystemEntry,
  kindHasSystemEntry,
  matchEntry,
  parseStack,
  pushPick,
  resolveStack,
  sameEntry,
  serializeStack,
  systemDefaultDrifted,
  systemDefaultGroupId,
  valueFromEntry,
} from "../public/js/device-stack.js";

const dev = (deviceId, label, groupId = "") => ({ deviceId, label, groupId });

// --- Entry shape -----------------------------------------------------------

test("entryFromValue: the kind's sentinel value becomes the system entry", () => {
  assert.deepEqual(entryFromValue("mic", "default"), { system: true });
  assert.deepEqual(entryFromValue("speaker", ""), { system: true });
  // Cameras have no OS-level default, so "" is just an empty concrete id.
  assert.deepEqual(entryFromValue("camera", ""), { deviceId: "", label: "" });
  assert.equal(kindHasSystemEntry("camera"), false);
});

test("entryFromValue: a concrete pick captures the live label", () => {
  assert.deepEqual(entryFromValue("mic", "m1", dev("m1", "  Studio Mic  ")), {
    deviceId: "m1",
    label: "Studio Mic",
  });
});

test("valueFromEntry round-trips per kind", () => {
  assert.equal(valueFromEntry("mic", { system: true }), "default");
  assert.equal(valueFromEntry("speaker", { system: true }), "");
  assert.equal(valueFromEntry("mic", { deviceId: "m1", label: "x" }), "m1");
});

test("sameEntry: system matches only system; concrete matches by deviceId", () => {
  assert.equal(sameEntry({ system: true }, { system: true }), true);
  assert.equal(sameEntry({ system: true }, { deviceId: "m1" }), false);
  assert.equal(sameEntry({ deviceId: "m1", label: "a" }, { deviceId: "m1", label: "b" }), true);
  assert.equal(sameEntry({ deviceId: "m1" }, { deviceId: "m2" }), false);
});

test("entryKey distinguishes kinds and the sentinel", () => {
  assert.equal(entryKey("mic", { system: true }), "mic:@system");
  assert.equal(entryKey("mic", { deviceId: "m1" }), "mic:m1");
  assert.notEqual(entryKey("mic", { deviceId: "m1" }), entryKey("camera", { deviceId: "m1" }));
});

// --- Storage --------------------------------------------------------------

test("parseStack: garbage folds to an empty stack", () => {
  assert.deepEqual(parseStack(null), []);
  assert.deepEqual(parseStack(""), []);
  assert.deepEqual(parseStack("not json"), []);
  assert.deepEqual(parseStack('{"deviceId":"m1"}'), []);
  assert.deepEqual(parseStack("[1,2,null,true]"), []);
});

test("parseStack: drops id-less entries, dedupes, and keeps order", () => {
  const raw = JSON.stringify([
    { deviceId: "m1", label: "One" },
    { deviceId: "", label: "junk" },
    { label: "no id" },
    { deviceId: "m1", label: "dupe" },
    { deviceId: "m2", label: 7 },
  ]);
  assert.deepEqual(parseStack(raw), [
    { deviceId: "m1", label: "One" },
    { deviceId: "m2", label: "" },
  ]);
});

test("parseStack: re-asserts the sentinel-is-last invariant on read", () => {
  const raw = JSON.stringify([
    { deviceId: "m1", label: "One" },
    { system: true },
    { deviceId: "m2", label: "Dead" },
  ]);
  assert.deepEqual(parseStack(raw), [{ deviceId: "m1", label: "One" }, { system: true }]);
});

test("serializeStack -> parseStack round-trip", () => {
  const stack = [{ deviceId: "m1", label: "One" }, { system: true }];
  assert.deepEqual(parseStack(serializeStack(stack)), stack);
});

// --- Push -----------------------------------------------------------------

test("pushPick: move-to-front without duplicating", () => {
  let s = [];
  s = pushPick(s, { deviceId: "a", label: "A" });
  s = pushPick(s, { deviceId: "b", label: "B" });
  assert.deepEqual(s.map((e) => e.deviceId), ["b", "a"]);
  s = pushPick(s, { deviceId: "a", label: "A" });
  assert.deepEqual(s.map((e) => e.deviceId), ["a", "b"]);
});

test("pushPick: re-picking the top entry is idempotent", () => {
  const s = [{ deviceId: "a", label: "A" }, { deviceId: "b", label: "B" }];
  assert.deepEqual(pushPick(s, { deviceId: "a", label: "A" }), s);
});

test("pushPick: pushing the sentinel prunes the now-unreachable tail", () => {
  const s = [{ deviceId: "a", label: "A" }, { deviceId: "b", label: "B" }];
  assert.deepEqual(pushPick(s, { system: true }), [{ system: true }]);
});

test("pushPick: a concrete pick above an existing sentinel is kept", () => {
  const s = [{ deviceId: "a", label: "A" }, { system: true }];
  assert.deepEqual(pushPick(s, { deviceId: "b", label: "B" }), [
    { deviceId: "b", label: "B" },
    { deviceId: "a", label: "A" },
    { system: true },
  ]);
});

test("pushPick: caps the stack, dropping the least-recently-picked", () => {
  let s = [];
  for (let i = 0; i < STACK_CAP + 3; i++) s = pushPick(s, { deviceId: `d${i}`, label: `D${i}` });
  assert.equal(s.length, STACK_CAP);
  assert.equal(s[0].deviceId, `d${STACK_CAP + 2}`);
  assert.equal(s.some((e) => e.deviceId === "d0"), false);
});

// --- Matching -------------------------------------------------------------

test("matchEntry: exact deviceId wins over group and label", () => {
  const devices = [dev("new", "Studio Display", "g"), dev("old", "Other", "other")];
  assert.equal(
    matchEntry(devices, { deviceId: "old", label: "Studio Display" }, "g").deviceId,
    "old",
  );
});

test("matchEntry: session groupId covers a mid-session replug", () => {
  const devices = [dev("spk-new", "Studio Display", "display"), dev("spk-mbp", "MacBook", "mbp")];
  assert.equal(
    matchEntry(devices, { deviceId: "spk-old", label: "Studio Display" }, "display").deviceId,
    "spk-new",
  );
});

test("matchEntry: label is the last tier and is trim-stable", () => {
  const devices = [dev("cam-new", "  Studio Display Camera  ", "x")];
  assert.equal(
    matchEntry(devices, { deviceId: "cam-old", label: "Studio Display Camera" }).deviceId,
    "cam-new",
  );
});

test("matchEntry: an ambiguous label is NOT a match (twin devices)", () => {
  const devices = [dev("cam-a", "HD Webcam", "ga"), dev("cam-b", "HD Webcam", "gb")];
  assert.equal(matchEntry(devices, { deviceId: "cam-gone", label: "HD Webcam" }), null);
});

test("matchEntry: an ambiguous groupId is NOT a match", () => {
  const devices = [dev("a", "A", "shared"), dev("b", "B", "shared")];
  assert.equal(matchEntry(devices, { deviceId: "gone", label: "" }, "shared"), null);
});

test("matchEntry: no tiers available -> null; system entry never matches", () => {
  assert.equal(matchEntry([dev("a", "A", "g")], { deviceId: "gone", label: "Missing" }), null);
  assert.equal(matchEntry([dev("a", "A", "g")], { system: true }), null);
});

// --- Resolution -----------------------------------------------------------

test("resolveStack: returns the top-most present entry", () => {
  const stack = [
    { deviceId: "airpods", label: "AirPods" },
    { deviceId: "builtin", label: "Built-in" },
  ];
  const devices = [dev("builtin", "Built-in", "g2")];
  assert.equal(resolveStack(stack, devices).device.deviceId, "builtin");
  devices.push(dev("airpods", "AirPods", "g1"));
  assert.equal(resolveStack(stack, devices).device.deviceId, "airpods");
});

test("resolveStack: the sentinel always resolves and terminates the walk", () => {
  const stack = [{ deviceId: "gone", label: "Gone" }, { system: true }];
  const resolved = resolveStack(stack, [dev("builtin", "Built-in", "g")]);
  assert.equal(isSystemEntry(resolved.entry), true);
  assert.equal(resolved.device, null);
});

test("resolveStack: nothing resolves -> null (caller leaves capture unconstrained)", () => {
  const stack = [{ deviceId: "gone", label: "Gone" }];
  assert.equal(resolveStack(stack, [dev("builtin", "Built-in", "g")]), null);
  assert.equal(resolveStack([], [dev("builtin", "Built-in", "g")]), null);
});

test("resolveStack: an unusable device is skipped, not consumed", () => {
  const stack = [
    { deviceId: "busy", label: "Busy" },
    { deviceId: "free", label: "Free" },
  ];
  const devices = [dev("busy", "Busy", "g1"), dev("free", "Free", "g2")];
  const unusable = new Set(["busy"]);
  const resolved = resolveStack(stack, devices, {
    isUnusable: (d) => unusable.has(d.deviceId),
  });
  assert.equal(resolved.device.deviceId, "free");
  // Skipping is not a mutation: clearing the set restores the top pick.
  unusable.clear();
  assert.equal(
    resolveStack(stack, devices, { isUnusable: (d) => unusable.has(d.deviceId) }).device.deviceId,
    "busy",
  );
});

// Unusability is a verdict on hardware, so it is asked about the device the
// entry resolved to. Judging the entry instead would let a capture that failed
// on a since-churned deviceId bury the pick for the rest of the session —
// precisely the case the label tier exists to recover from.
test("resolveStack: a device that refused does not disqualify an entry that rematches", () => {
  const stack = [{ deviceId: "old", label: "Studio Display" }];
  const devices = [dev("new", "Studio Display", "g2"), dev("builtin", "FaceTime HD", "g1")];
  const unusable = new Set(["old"]);
  const resolved = resolveStack(stack, devices, {
    isUnusable: (d) => unusable.has(d.deviceId),
  });
  assert.equal(resolved.device.deviceId, "new");
  // The device it actually resolves to refusing is what disqualifies it.
  unusable.add("new");
  assert.equal(
    resolveStack(stack, devices, { isUnusable: (d) => unusable.has(d.deviceId) }),
    null,
  );
});

test("resolveStack: resolving never mutates the stack", () => {
  const stack = [{ deviceId: "old", label: "Studio Display" }];
  const snapshot = JSON.parse(JSON.stringify(stack));
  resolveStack(stack, [dev("new", "Studio Display", "g")]);
  assert.deepEqual(stack, snapshot);
});

// --- OS default drift ------------------------------------------------------

test("systemDefaultGroupId reads the virtual default entry", () => {
  const devices = [
    { kind: "audioinput", deviceId: "default", groupId: "g1", label: "Default - AirPods" },
    { kind: "audioinput", deviceId: "m1", groupId: "g1", label: "AirPods" },
  ];
  assert.equal(systemDefaultGroupId(devices, "audioinput"), "g1");
  assert.equal(systemDefaultGroupId(devices, "audiooutput"), "");
});

test("systemDefaultDrifted: true only when the live track is on another group", () => {
  const devices = [
    { kind: "audioinput", deviceId: "default", groupId: "airpods", label: "Default - AirPods" },
  ];
  assert.equal(systemDefaultDrifted({ groupId: "builtin" }, devices, "audioinput"), true);
  assert.equal(systemDefaultDrifted({ groupId: "airpods" }, devices, "audioinput"), false);
  // Unknowable rather than drifted: no default entry, or no groupId on the track.
  assert.equal(systemDefaultDrifted({ groupId: "builtin" }, [], "audioinput"), false);
  assert.equal(systemDefaultDrifted({}, devices, "audioinput"), false);
  assert.equal(systemDefaultDrifted(null, devices, "audioinput"), false);
});
