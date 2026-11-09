# Babbla contributor instructions

## Product and architecture

Read README.md and CONTEXT.md. Babbla prioritizes low-latency, simultaneous
conversation in small groups using WebRTC mesh. Keep the signaling server small;
media is not forwarded through the application server. Do not introduce an SFU,
spatial audio, push-to-talk or automatic speaker gating without a product decision.

- `server.js` owns HTTP, WebSocket lifecycle, configuration and optional telemetry.
- `room.js` owns room/presence state; inject services instead of reading environment
  variables or doing network I/O inside the room state machine.
- `public/js/mesh.js` owns per-peer WebRTC negotiation, media and recovery.
- `public/js/signaling.js` owns the WebSocket transport.
- `public/js/stage.js` is a pure view-state model; keep DOM/WebRTC out of it.
- `public/js/room-controller.js` coordinates lifecycle through injected ports.
- `public/js/main.js` composes the application and owns browser/UI integration.
- `public/js/protocol.js` defines shared protocol messages.

## Behavioral invariants

Preserve audio priority over video. Classify camera/screen tracks from the
sender's per-connection MID role map, never from stream labels or resolution.
Treat server presence as authoritative. Make repeated stream attachment and
reconciliation idempotent. Guard asynchronous capture and credential issuance
against users leaving or changing rooms while an operation is in flight.

Device preference stacks represent explicit user choices. Automatic fallback
must not overwrite that intent. Preserve reconnect/session-restore behavior and
never claim a simulated device test establishes real audible routing.

Optional statistics failures must not interrupt calls. Never print secrets or
short-lived TURN credentials. Document the lack of built-in access control for
rooms and statistics without claiming telemetry cannot identify users.

## Verification

Node.js 24+, `npm ci`, `npm test`. `npm run e2e` runs browser suites against
throwaway rooms and servers. The full browser suite currently targets Linux
with Chrome and a display; coturn suites skip when its binary is unavailable.
Use focused browser suites for media/lifecycle changes and report skipped or
unverified real-device behavior accurately. Close browsers and temporary servers.

## Packaging and deployment boundary

This repository owns portable application code, tests, Docker packaging and
image publication. It does not know about any particular installation, deployment
repository, server, domain, private network or operator credentials.

Branch builds publish full-SHA image tags; releases tag existing digests.
Neither operation triggers deployment. Keep production/staging selection and
installation-specific configuration outside this repository. Generic examples
use localhost or reserved example domains. Live diagnostic commands require an
explicit target; never default to someone's running installation.

Write new technical documentation and comments in English. Preserve the existing
Swedish application UI unless the task explicitly changes product language.
