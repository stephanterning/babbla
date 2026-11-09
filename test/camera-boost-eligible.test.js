// Unit tests for the camera HD-boost transport gate (mesh.js).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isCameraBoostEligibleTransport,
  turnUrlsConfigured,
  transportUnknownReason,
  transportFromPair,
} from "../public/js/mesh.js";

test("turnUrlsConfigured detects turn:/turns: URLs", () => {
  assert.equal(turnUrlsConfigured([{ urls: "stun:stun.l.google.com:19302" }]), false);
  assert.equal(
    turnUrlsConfigured([
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "turn:turn.example.com:3478?transport=udp" },
    ]),
    true,
  );
});

test("pair_unresolved unknown is never boost-eligible (even when connected)", () => {
  assert.equal(
    isCameraBoostEligibleTransport({
      transport: "unknown",
      unknownReason: "pair_unresolved",
      connected: true,
      turnConfigured: false,
    }),
    false,
  );
  assert.equal(
    isCameraBoostEligibleTransport({
      transport: "unknown",
      unknownReason: "pair_unresolved",
      connected: true,
      turnConfigured: true,
    }),
    false,
  );
});

test("no_pair unknown boosts only on STUN-only connected links", () => {
  assert.equal(
    isCameraBoostEligibleTransport({
      transport: "unknown",
      unknownReason: "no_pair",
      connected: true,
      turnConfigured: false,
    }),
    true,
  );
  assert.equal(
    isCameraBoostEligibleTransport({
      transport: "unknown",
      unknownReason: "no_pair",
      connected: true,
      turnConfigured: true,
    }),
    false,
  );
});

test("relay and not-connected never boost", () => {
  assert.equal(
    isCameraBoostEligibleTransport({
      transport: "relay",
      unknownReason: null,
      connected: true,
      turnConfigured: true,
    }),
    false,
  );
  assert.equal(
    isCameraBoostEligibleTransport({
      transport: "direct",
      unknownReason: null,
      connected: false,
      turnConfigured: false,
    }),
    false,
  );
  assert.equal(
    isCameraBoostEligibleTransport({
      transport: "direct",
      unknownReason: null,
      connected: true,
      turnConfigured: true,
    }),
    true,
  );
});

test("transportUnknownReason matches transportFromPair edge cases", () => {
  const pair = {
    type: "candidate-pair",
    localCandidateId: "X",
    remoteCandidateId: "Y",
  };
  assert.equal(transportUnknownReason(null, new Map()), "no_pair");
  assert.equal(transportUnknownReason(pair, new Map()), "pair_unresolved");
  const stats = new Map([
    ["L", { type: "local-candidate", candidateType: "host" }],
    ["R", { type: "remote-candidate", candidateType: "srflx" }],
  ]);
  const resolved = {
    type: "candidate-pair",
    localCandidateId: "L",
    remoteCandidateId: "R",
  };
  assert.equal(transportUnknownReason(resolved, stats), null);
  assert.equal(transportFromPair(resolved, stats), "direct");
});
