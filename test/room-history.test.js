// Unit tests for the room history helpers (room-history.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  HISTORY_KEY,
  HISTORY_CAP,
  readRoomHistory,
  recordRoomVisit,
} from "../public/js/room-history.js";

/** @implements {Storage} */
class MemoryStorage {
  constructor() {
    /** @type {Map<string, string>} */
    this.map = new Map();
  }
  get length() {
    return this.map.size;
  }
  key() {
    return null;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

// A storage whose reads/writes throw, to exercise the best-effort guards.
class ThrowingStorage {
  getItem() {
    throw new Error("blocked");
  }
  setItem() {
    throw new Error("blocked");
  }
  removeItem() {
    throw new Error("blocked");
  }
}

test("empty / missing history reads as []", () => {
  const s = new MemoryStorage();
  assert.deepEqual(readRoomHistory(s), []);
});

test("recordRoomVisit prepends and persists", () => {
  const s = new MemoryStorage();
  recordRoomVisit("alpha", s);
  recordRoomVisit("beta", s);
  assert.deepEqual(readRoomHistory(s), ["beta", "alpha"]);
  // Round-trips through the raw key as JSON.
  assert.deepEqual(JSON.parse(s.getItem(HISTORY_KEY)), ["beta", "alpha"]);
});

test("revisiting moves a room to the front (dedup, no duplicates)", () => {
  const s = new MemoryStorage();
  recordRoomVisit("alpha", s);
  recordRoomVisit("beta", s);
  recordRoomVisit("alpha", s);
  assert.deepEqual(readRoomHistory(s), ["alpha", "beta"]);
});

test("history is capped at HISTORY_CAP, most-recent-first", () => {
  const s = new MemoryStorage();
  for (let i = 0; i < HISTORY_CAP + 5; i++) recordRoomVisit(`room${i}`, s);
  const list = readRoomHistory(s);
  assert.equal(list.length, HISTORY_CAP);
  // The most recent (highest i) is first; the oldest fell off.
  assert.equal(list[0], `room${HISTORY_CAP + 4}`);
  assert.ok(!list.includes("room0"));
});

test("recordRoomVisit ignores an empty name", () => {
  const s = new MemoryStorage();
  recordRoomVisit("alpha", s);
  recordRoomVisit("", s);
  assert.deepEqual(readRoomHistory(s), ["alpha"]);
});

test("garbage / non-array history folds to []", () => {
  const s = new MemoryStorage();
  s.setItem(HISTORY_KEY, "{not json");
  assert.deepEqual(readRoomHistory(s), []);
  s.setItem(HISTORY_KEY, JSON.stringify({ not: "an array" }));
  assert.deepEqual(readRoomHistory(s), []);
  // Non-string / empty entries are filtered out.
  s.setItem(HISTORY_KEY, JSON.stringify(["a", 1, "", null, "b"]));
  assert.deepEqual(readRoomHistory(s), ["a", "b"]);
});

test("readRoomHistory dedups + caps even when stored unclean", () => {
  const s = new MemoryStorage();
  const dirty = ["a", "a", "b", "a", "c"];
  s.setItem(HISTORY_KEY, JSON.stringify(dirty));
  assert.deepEqual(readRoomHistory(s), ["a", "b", "c"]);
});

test("history reads/writes are best-effort under a throwing storage", () => {
  const s = new ThrowingStorage();
  assert.deepEqual(readRoomHistory(s), []);
  // Does not throw; the persist fails silently but the computed (in-memory)
  // list is still returned to the caller.
  assert.deepEqual(recordRoomVisit("alpha", s), ["alpha"]);
});
