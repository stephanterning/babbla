// Unit tests for deploy-restore snapshot helpers (session-restore.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  RESTORE_REASON,
  STORAGE_KEY,
  SNAPSHOT_TTL_MS,
  clearSessionRestore,
  readPendingRestore,
  roomPathFromLocation,
  snapshotMatchesRoom,
  writeDeployRestoreSnapshot,
} from "../public/js/session-restore.js";

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

function baseState(overrides = {}) {
  return {
    buildVersion: "2026-06-24 abc1234",
    roomPath: "/room/demo",
    name: "Alice",
    muted: false,
    videoOptOut: false,
    cameraOn: true,
    screenOn: false,
    micDeviceId: "mic-a",
    cameraDeviceId: "cam-b",
    ...overrides,
  };
}

test("write + read round-trip a valid snapshot", () => {
  const storage = new MemoryStorage();
  const written = writeDeployRestoreSnapshot(baseState(), storage);
  assert.ok(written);
  assert.equal(written.reason, RESTORE_REASON);
  assert.equal(written.restoreAttempts, 0);

  const read = readPendingRestore(storage);
  assert.deepEqual(read?.name, "Alice");
  assert.equal(read?.cameraOn, true);
});

test("expired snapshot is cleared on read", () => {
  const storage = new MemoryStorage();
  writeDeployRestoreSnapshot(baseState(), storage);
  const raw = JSON.parse(storage.getItem(STORAGE_KEY));
  raw.expiresAt = Date.now() - 1;
  storage.setItem(STORAGE_KEY, JSON.stringify(raw));
  assert.equal(readPendingRestore(storage), null);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("second write while snapshot exists tombstones and blocks reload loop", () => {
  const storage = new MemoryStorage();
  assert.ok(writeDeployRestoreSnapshot(baseState(), storage));
  assert.equal(writeDeployRestoreSnapshot(baseState(), storage), null);
  const tomb = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(tomb.restoreAttempts, 1);
  assert.equal(readPendingRestore(storage), null);
  assert.ok(storage.getItem(STORAGE_KEY), "tombstone stays to block further writes");
});

test("expired tombstone is cleared so a later deploy can snapshot again", () => {
  const storage = new MemoryStorage();
  writeDeployRestoreSnapshot(baseState(), storage);
  const raw = JSON.parse(storage.getItem(STORAGE_KEY));
  raw.restoreAttempts = 1;
  raw.expiresAt = Date.now() - 1;
  storage.setItem(STORAGE_KEY, JSON.stringify(raw));
  assert.equal(readPendingRestore(storage), null);
  assert.ok(writeDeployRestoreSnapshot(baseState(), storage));
});

test("corrupt boolean fields are rejected and cleared", () => {
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    reason: RESTORE_REASON,
    buildVersion: "x",
    roomPath: "/",
    name: "A",
    muted: "false",
    videoOptOut: false,
    cameraOn: false,
    screenOn: false,
    micDeviceId: null,
    cameraDeviceId: null,
    expiresAt: Date.now() + 10_000,
    restoreAttempts: 0,
  }));
  assert.equal(readPendingRestore(storage), null);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("snapshotMatchesRoom compares pathname", () => {
  const snap = { roomPath: "/" };
  assert.equal(snapshotMatchesRoom(snap, "/"), true);
  assert.equal(snapshotMatchesRoom(snap, "/room/x"), false);
  assert.equal(roomPathFromLocation("/room/x"), "/room/x");
});

test("clearSessionRestore removes the key", () => {
  const storage = new MemoryStorage();
  writeDeployRestoreSnapshot(baseState(), storage);
  clearSessionRestore(storage);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("TTL is about 60 seconds", () => {
  const storage = new MemoryStorage();
  const t0 = Date.now();
  const written = writeDeployRestoreSnapshot(baseState(), storage);
  assert.ok(written);
  assert.ok(written.expiresAt >= t0 + SNAPSHOT_TTL_MS - 50);
  assert.ok(written.expiresAt <= t0 + SNAPSHOT_TTL_MS + 50);
});
