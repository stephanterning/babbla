// Unit tests for byteCountsFromStats (mesh.js) — cross-browser byte counter
// extraction for the live bandwidth meter.

import { test } from "node:test";
import assert from "node:assert/strict";

import { byteCountsFromStats } from "../public/js/mesh.js";

test("transport stats are preferred when bytes are present (Chrome)", () => {
  const stats = new Map([
    ["t1", { type: "transport", bytesSent: 12_000, bytesReceived: 8_000 }],
    ["o1", { type: "outbound-rtp", bytesSent: 99_000 }],
    ["i1", { type: "inbound-rtp", bytesReceived: 88_000 }],
  ]);
  assert.deepEqual(byteCountsFromStats(stats), {
    bytesSent: 12_000,
    bytesReceived: 8_000,
  });
});

test("falls back to RTP counters when transport omits bytes (Firefox)", () => {
  const stats = new Map([
    ["t1", { type: "transport", selectedCandidatePairId: "p1" }],
    ["o1", { type: "outbound-rtp", bytesSent: 40_000, headerBytesSent: 2_000 }],
    ["o2", { type: "outbound-rtp", bytesSent: 10_000, headerBytesSent: 500 }],
    ["i1", { type: "inbound-rtp", bytesReceived: 35_000, headerBytesReceived: 1_500 }],
  ]);
  assert.deepEqual(byteCountsFromStats(stats), {
    bytesSent: 52_500,
    bytesReceived: 36_500,
  });
});

test("empty stats -> zero", () => {
  assert.deepEqual(byteCountsFromStats(new Map()), {
    bytesSent: 0,
    bytesReceived: 0,
  });
});
