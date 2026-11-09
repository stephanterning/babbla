// Unit tests for the Signaling module (public/js/signaling.js). The transport
// is injected (a fake WebSocket), so reconnect/backoff/open-guard/dispatch are
// all testable without a real server. Reconnect timing uses node:test's mock
// timers. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSignaling } from "../public/js/signaling.js";

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.handlers = { open: [], message: [], close: [], error: [] };
  }
  addEventListener(type, fn) {
    (this.handlers[type] ||= []).push(fn);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.#emit("close");
  }
  #emit(type, ev) {
    for (const fn of this.handlers[type] || []) fn(ev);
  }
  // --- test helpers ---
  fireOpen() {
    this.readyState = 1; // OPEN
    this.#emit("open");
  }
  fireMessage(obj) {
    this.#emit("message", { data: JSON.stringify(obj) });
  }
  fireClose() {
    this.readyState = 3;
    this.#emit("close");
  }
  lastSent() {
    return this.sent.length ? JSON.parse(this.sent.at(-1)) : null;
  }
}

function setup(opts = {}) {
  const sockets = [];
  const messages = [];
  const events = { open: 0, recon: 0 };
  const sig = createSignaling({
    url: "ws://test/ws",
    connect: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onOpen: () => events.open++,
    onMessage: (m) => messages.push(m),
    onReconnecting: () => events.recon++,
    minReconnectMs: 1000,
    maxReconnectMs: 8000,
    ...opts,
  });
  return { sockets, messages, events, sig };
}

test("connects immediately and reports open", () => {
  const { sockets, events } = setup();
  assert.equal(sockets.length, 1);
  sockets[0].fireOpen();
  assert.equal(events.open, 1);
});

test("typed send builds the right wire message once open", () => {
  const { sockets, sig } = setup();
  sockets[0].fireOpen();
  sig.join("Alice");
  // clientIp defaults to null when the caller doesn't supply one (no STUN probe
  // result yet); clientId is undefined here so JSON drops it.
  assert.deepEqual(sockets[0].lastSent(), { type: "join", name: "Alice", clientIp: null });
  sig.join("Bob", "cid-7", "203.0.113.9");
  assert.deepEqual(sockets[0].lastSent(), {
    type: "join",
    name: "Bob",
    clientId: "cid-7",
    clientIp: "203.0.113.9",
  });
  sig.cameraFocus("peer-1", true);
  assert.deepEqual(sockets[0].lastSent(), {
    type: "camera-focus",
    targetId: "peer-1",
    on: true,
  });
});

test("open-guard drops sends while the socket is not open", () => {
  const { sockets, sig } = setup();
  // Still CONNECTING.
  assert.equal(sig.camera(true), false);
  assert.equal(sockets[0].sent.length, 0);
  sockets[0].fireOpen();
  assert.equal(sig.camera(true), true);
  assert.equal(sockets[0].sent.length, 1);
});

test("inbound messages are parsed and delivered", () => {
  const { sockets, messages } = setup();
  sockets[0].fireOpen();
  sockets[0].fireMessage({ type: "welcome", id: "x" });
  assert.deepEqual(messages.at(-1), { type: "welcome", id: "x" });
});

test("malformed inbound JSON is ignored", () => {
  const { sockets, messages } = setup();
  sockets[0].fireOpen();
  sockets[0].handlers.message.forEach((fn) => fn({ data: "{not json" }));
  assert.equal(messages.length, 0);
});

test("onReconnecting can request an immediate reconnect after a healthy session", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sockets } = setup({
    onReconnecting: () => ({ immediate: true }),
  });
  sockets[0].fireOpen();
  sockets[0].fireMessage({ type: "welcome" });
  sockets[0].fireClose();
  t.mock.timers.tick(0);
  assert.equal(sockets.length, 2);
});

test("immediate reconnect is ignored before the first inbound message", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sockets } = setup({
    onReconnecting: () => ({ immediate: true }),
  });
  sockets[0].fireOpen();
  sockets[0].fireClose();
  assert.equal(sockets.length, 1);
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2);
});

test("unexpected close triggers onReconnecting and reconnects after backoff", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sockets, events } = setup();
  sockets[0].fireOpen();
  sockets[0].fireClose();
  assert.equal(events.recon, 1);
  assert.equal(sockets.length, 1); // not reconnected yet
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2); // a fresh transport was created
});

test("backoff grows on repeated pre-handshake failures", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sockets } = setup();
  sockets[0].fireClose(); // schedule at 1000
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2);
  sockets[1].fireClose(); // no message seen → schedule at 2000
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2); // not enough time
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 3); // 2000 elapsed
});

test("a received message resets the backoff", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sockets } = setup();
  sockets[0].fireClose();
  t.mock.timers.tick(1000); // -> sockets[1]
  sockets[1].fireOpen();
  sockets[1].fireMessage({ type: "welcome" }); // healthy → reset
  sockets[1].fireClose();
  t.mock.timers.tick(1000); // back to min delay
  assert.equal(sockets.length, 3);
});

test("close() is intentional: no onReconnecting, no reconnect", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sockets, events, sig } = setup();
  sockets[0].fireOpen();
  sig.close();
  assert.equal(events.recon, 0);
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 1);
});

test("late events from a superseded socket are ignored (no flapping)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sockets, events } = setup();
  sockets[0].fireClose(); // drop -> reconnecting
  t.mock.timers.tick(1000); // -> sockets[1] is now the live socket
  assert.equal(sockets.length, 2);
  assert.equal(events.recon, 1);

  // A late close from the dead first socket must not queue another reconnect.
  sockets[0].fireClose();
  assert.equal(events.recon, 1);

  // A late error from the dead first socket must not close the live one.
  sockets[0].handlers.error.forEach((fn) => fn());
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 2); // no extra socket spawned
  assert.notEqual(sockets[1].readyState, 3); // live socket untouched
});

test("isOpen reflects the socket readyState", () => {
  const { sockets, sig } = setup();
  assert.equal(sig.isOpen(), false);
  sockets[0].fireOpen();
  assert.equal(sig.isOpen(), true);
  sockets[0].fireClose();
  assert.equal(sig.isOpen(), false);
});
