// Unit tests for transportFromPair (mesh.js) — the pure relay-detection
// decision the camera-boost gate and the relay UI indicator hinge on. Driven
// with a fabricated getStats()-style Map; no RTCPeerConnection needed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { transportFromPair } from "../public/js/mesh.js";

// Build a stats Map from candidate-type lookups, plus the pair referencing them.
function statsWith({ local, remote }) {
  const stats = new Map();
  if (local) stats.set("L", { type: "local-candidate", candidateType: local });
  if (remote) stats.set("R", { type: "remote-candidate", candidateType: remote });
  const pair = {
    type: "candidate-pair",
    localCandidateId: local ? "L" : undefined,
    remoteCandidateId: remote ? "R" : undefined,
  };
  return { pair, stats };
}

test("no selected pair -> unknown (conservative: not boostable, not flagged)", () => {
  assert.equal(transportFromPair(null, new Map()), "unknown");
  assert.equal(transportFromPair(undefined, new Map()), "unknown");
});

test("host/srflx pair -> direct", () => {
  const { pair, stats } = statsWith({ local: "host", remote: "srflx" });
  assert.equal(transportFromPair(pair, stats), "direct");
});

test("relay on the local candidate -> relay", () => {
  const { pair, stats } = statsWith({ local: "relay", remote: "srflx" });
  assert.equal(transportFromPair(pair, stats), "relay");
});

test("relay on the remote candidate -> relay", () => {
  const { pair, stats } = statsWith({ local: "host", remote: "relay" });
  assert.equal(transportFromPair(pair, stats), "relay");
});

test("relay on both ends -> relay", () => {
  const { pair, stats } = statsWith({ local: "relay", remote: "relay" });
  assert.equal(transportFromPair(pair, stats), "relay");
});

test("a pair whose candidates aren't in the stats map -> unknown", () => {
  // The pair references ids that don't resolve (candidate reports missing) — we
  // can't confirm direct, so stay conservative.
  const pair = { type: "candidate-pair", localCandidateId: "X", remoteCandidateId: "Y" };
  assert.equal(transportFromPair(pair, new Map()), "unknown");
});

test("a pair whose candidates exist but lack candidateType -> unknown", () => {
  const stats = new Map([
    ["L", { type: "local-candidate" }],
    ["R", { type: "remote-candidate" }],
  ]);
  const pair = {
    type: "candidate-pair",
    localCandidateId: "L",
    remoteCandidateId: "R",
  };
  assert.equal(transportFromPair(pair, stats), "unknown");
});

test("in-progress nominated pair -> direct when candidates resolve", () => {
  const { pair, stats } = statsWith({ local: "host", remote: "srflx" });
  pair.state = "in-progress";
  assert.equal(transportFromPair(pair, stats), "direct");
});
