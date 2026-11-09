import { test } from "node:test";
import assert from "node:assert/strict";
import { srflxAddressFrom, discoverPublicIp } from "../public/js/public-ip.js";

test("srflxAddressFrom: reads the structured srflx address", () => {
  assert.equal(
    srflxAddressFrom({ type: "srflx", address: "203.0.113.7" }),
    "203.0.113.7",
  );
});

test("srflxAddressFrom: parses srflx out of the SDP candidate string", () => {
  const c = {
    candidate:
      "candidate:1 1 udp 16777215 203.0.113.7 54321 typ srflx raddr 0.0.0.0 rport 0",
  };
  assert.equal(srflxAddressFrom(c), "203.0.113.7");
});

test("srflxAddressFrom: ignores host/relay candidates and null", () => {
  assert.equal(srflxAddressFrom({ type: "host", address: "abc.local" }), null);
  assert.equal(
    srflxAddressFrom({ candidate: "candidate:1 1 udp 1 10.0.0.1 5 typ host" }),
    null,
  );
  assert.equal(
    srflxAddressFrom({ candidate: "candidate:2 1 udp 1 198.51.100.1 5 typ relay" }),
    null,
  );
  assert.equal(srflxAddressFrom(null), null);
});

// A minimal RTCPeerConnection fake: it replays a fixed candidate list (and a
// terminating null for end-of-gathering) on setLocalDescription.
function fakePeerConnection(candidates) {
  return class {
    constructor() {
      this.listeners = {};
      this.closed = false;
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    emit(type, ev) {
      for (const fn of this.listeners[type] || []) fn(ev);
    }
    createDataChannel() {}
    createOffer() {
      return Promise.resolve({ type: "offer", sdp: "" });
    }
    setLocalDescription() {
      queueMicrotask(() => {
        for (const c of candidates) this.emit("icecandidate", { candidate: c });
      });
      return Promise.resolve();
    }
    close() {
      this.closed = true;
    }
  };
}

test("discoverPublicIp: resolves the first srflx address seen", async () => {
  const ip = await discoverPublicIp({
    RTCPeerConnectionImpl: fakePeerConnection([
      { type: "host", address: "192.168.1.5" },
      { type: "srflx", address: "203.0.113.7" },
    ]),
  });
  assert.equal(ip, "203.0.113.7");
});

test("discoverPublicIp: resolves null when gathering ends with no srflx", async () => {
  const ip = await discoverPublicIp({
    RTCPeerConnectionImpl: fakePeerConnection([
      { type: "host", address: "192.168.1.5" },
      null, // end-of-gathering
    ]),
  });
  assert.equal(ip, null);
});

test("discoverPublicIp: resolves null when there is no RTCPeerConnection", async () => {
  assert.equal(await discoverPublicIp({ RTCPeerConnectionImpl: undefined }), null);
});

test("discoverPublicIp: resolves null on timeout (no candidates emitted)", async () => {
  const ip = await discoverPublicIp({
    RTCPeerConnectionImpl: fakePeerConnection([]),
    timeoutMs: 20,
  });
  assert.equal(ip, null);
});
