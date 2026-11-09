// The two pure helpers that turn "a peer is stuck on ansluter" into a
// diagnosis (see the initial-connect watchdog in public/js/mesh.js):
//
//   describeIceServerError   — the browser's `icecandidateerror` -> a fact an
//                              operator can act on (which knob is wrong).
//   reportedConnectionState  — what a link is *called* while it is stuck, so a
//                              never-connected pair stops advertising hope.

import test from "node:test";
import assert from "node:assert/strict";

import {
  describeIceServerError,
  describeGatheringFailure,
  firstTurnUrl,
  reportedConnectionState,
  activeIceErrorsToShow,
} from "../public/js/mesh.js";

const TURN = "turn:relay.example:3478?transport=udp";

test("401 on a TURN url points at the shared secret", () => {
  const d = describeIceServerError({ url: TURN, errorCode: 401, errorText: "Unauthorized." });
  assert.equal(d.relay, true);
  assert.equal(d.errorCode, 401);
  assert.match(d.hint, /401/);
  assert.match(d.hint, /TURN_SECRET/);
});

test("701 on a TURN url points at a blocked / unforwarded UDP port", () => {
  const d = describeIceServerError({
    url: TURN,
    errorCode: 701,
    errorText: "TURN allocate request timed out.",
  });
  assert.equal(d.relay, true);
  assert.match(d.hint, /701/);
  assert.match(d.hint, /vidarebefordrad|blockerad/);
});

test("403 and 437 are distinguished from each other", () => {
  const forbidden = describeIceServerError({ url: TURN, errorCode: 403 });
  const stale = describeIceServerError({ url: TURN, errorCode: 437 });
  assert.match(forbidden.hint, /403/);
  assert.match(stale.hint, /437/);
  assert.notEqual(forbidden.hint, stale.hint);
});

test("turns: (TLS) urls are also recognised as relay", () => {
  assert.equal(describeIceServerError({ url: "turns:relay.example:5349", errorCode: 401 }).relay, true);
});

test("a STUN 701 reads as 'this network drops UDP, so a relay is needed'", () => {
  const d = describeIceServerError({
    url: "stun:stun.l.google.com:19302",
    errorCode: 701,
    errorText: "STUN binding request timed out.",
  });
  assert.equal(d.relay, false);
  assert.match(d.hint, /STUN/);
  assert.match(d.hint, /relä/);
});

test("an unknown code still yields a usable hint rather than throwing", () => {
  const d = describeIceServerError({ url: TURN, errorCode: 600 });
  assert.match(d.hint, /600/);
  // A bare event (no fields at all) must not blow up the icecandidateerror handler.
  const empty = describeIceServerError();
  assert.equal(empty.url, "");
  assert.equal(empty.errorCode, 0);
  assert.equal(empty.relay, false);
  assert.equal(typeof empty.hint, "string");
});

// describeGatheringFailure — the diagnosis that does NOT wait for
// `icecandidateerror`. Measured against a deployment whose relay UDP port was
// firewalled: 3 minutes, 14 ICE restarts, zero events, empty health box. The
// restarts keep Chrome from ever reaching the ~40 s it needs to declare the
// allocate dead, so the explanation has to come from the candidates instead.

test("configured TURN plus no relay candidate names the unreachable UDP port", () => {
  const d = describeGatheringFailure({
    turnConfigured: true,
    candidateTypes: ["host", "srflx"],
    turnUrl: TURN,
  });
  assert.equal(d.relay, true);
  assert.equal(d.url, TURN);
  assert.match(d.hint, /relä-kandidat/);
  assert.match(d.hint, /UDP/);
});

test("gathering nothing at all is explained the same way", () => {
  // What `iceTransportPolicy: "relay"` against a dead relay looks like.
  const d = describeGatheringFailure({ turnConfigured: true, candidateTypes: [], turnUrl: TURN });
  assert.ok(d);
  assert.match(d.hint, /svarar inte/);
});

test("a relay candidate means the relay answered — say nothing", () => {
  // The pair may still be failing, but not for a reason this can name, and a
  // wrong explanation is worse than none.
  assert.equal(
    describeGatheringFailure({
      turnConfigured: true,
      candidateTypes: ["host", "relay"],
      turnUrl: TURN,
    }),
    null,
  );
});

test("a STUN-only deployment is left to the 'ej konfigurerat' line", () => {
  assert.equal(
    describeGatheringFailure({ turnConfigured: false, candidateTypes: ["host"] }),
    null,
  );
  assert.equal(describeGatheringFailure(), null);
});

test("the derived report carries no STUN code (it never got a response)", () => {
  // errorCode 0 keeps it honest: the server log prints the text, not a "0".
  const d = describeGatheringFailure({ turnConfigured: true, candidateTypes: [], turnUrl: TURN });
  assert.equal(d.errorCode, 0);
  assert.equal(typeof d.errorText, "string");
});

test("a Set of candidate types works as well as an array", () => {
  // The mesh accumulates types in a Set across ICE restarts.
  assert.equal(
    describeGatheringFailure({
      turnConfigured: true,
      candidateTypes: new Set(["relay"]),
      turnUrl: TURN,
    }),
    null,
  );
  assert.ok(
    describeGatheringFailure({
      turnConfigured: true,
      candidateTypes: new Set(["srflx"]),
      turnUrl: TURN,
    }),
  );
});

test("firstTurnUrl picks the TURN entry out of a mixed ICE config", () => {
  assert.equal(
    firstTurnUrl([{ urls: "stun:stun.l.google.com:19302" }, { urls: [TURN] }]),
    TURN,
  );
  assert.equal(firstTurnUrl([{ urls: "stun:stun.l.google.com:19302" }]), "");
  assert.equal(firstTurnUrl(), "");
});

test("a pair that never connected and stalled reads 'uncertain', not 'connecting'", () => {
  // This is the bug the watchdog fixes: each ICE restart bounces the raw state
  // back to "connecting", which repainted a dead relay link as "ansluter".
  for (const raw of ["new", "connecting"]) {
    assert.equal(
      reportedConnectionState({ raw, everConnected: false, stalled: true }),
      "uncertain",
    );
  }
});

test("before the watchdog trips, a first connect still reads 'connecting'", () => {
  assert.equal(
    reportedConnectionState({ raw: "connecting", everConnected: false, stalled: false }),
    "connecting",
  );
  assert.equal(
    reportedConnectionState({ raw: "new", everConnected: false, stalled: false }),
    "new",
  );
});

test("a previously connected pair keeps the raw state while it recovers", () => {
  assert.equal(
    reportedConnectionState({ raw: "connecting", everConnected: true, stalled: true }),
    "connecting",
  );
});

test("terminal and healthy states are never rewritten", () => {
  for (const raw of ["connected", "failed", "closed", "disconnected"]) {
    assert.equal(
      reportedConnectionState({ raw, everConnected: false, stalled: true }),
      raw,
    );
  }
});

const stun701 = {
  peerId: "alice",
  ...describeIceServerError({
    url: "stun:stun.l.google.com:19302",
    errorCode: 701,
  }),
};
const stun701b = {
  peerId: "alice",
  ...describeIceServerError({
    url: "stun:stun1.l.google.com:19302",
    errorCode: 701,
  }),
};
const turn701 = {
  peerId: "bob",
  ...describeIceServerError({ url: TURN, errorCode: 701 }),
};
const turn401 = {
  peerId: "bob",
  ...describeIceServerError({ url: TURN, errorCode: 401 }),
};

test("a healthy call hides every stored ICE error, including a 401", () => {
  // Behaviour change: the box is not session history. A minutes-old 401 on a
  // now-connected pair must not stay painted, and leftover 701s from the
  // first gather must not come back on a later blip unless that peer is
  // osäker *and* still carries that error.
  const shown = activeIceErrorsToShow([stun701, turn401], { uncertainIds: [] });
  assert.deepEqual(shown, []);
});

test("only the currently-stuck peers' latest errors are shown", () => {
  // Alice healed (701 leftover must not paint). Bob is osäker with a 401.
  const shown = activeIceErrorsToShow([stun701, turn401], {
    uncertainIds: ["bob"],
  });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].errorCode, 401);
  assert.equal(shown[0].peerId, "bob");
});

test("a newer error on the same peer replaces the older one", () => {
  // The view map holds one row per peer; passing only the latest models that.
  const shown = activeIceErrorsToShow([turn701], { uncertainIds: ["bob"] });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].errorCode, 701);
});

test("two stuck peers with different hints both show", () => {
  const shown = activeIceErrorsToShow([stun701, turn401], {
    uncertainIds: ["alice", "bob"],
  });
  assert.equal(shown.length, 2);
  assert.equal(shown[0].relay, false);
  assert.equal(shown[1].relay, true);
});

test("identical hints collapse to one line (two Google STUN hosts, one 701)", () => {
  const shown = activeIceErrorsToShow([stun701, stun701b], {
    uncertainIds: ["alice"],
  });
  assert.equal(shown.length, 1);
  assert.match(shown[0].hint, /STUN/);
});

test("empty / missing input is a no-op rather than a throw", () => {
  assert.deepEqual(activeIceErrorsToShow(), []);
  assert.deepEqual(activeIceErrorsToShow(null, { uncertainIds: ["x"] }), []);
});
