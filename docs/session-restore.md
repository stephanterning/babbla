# Deploy-restore (session snapshot across reload)

When the server deploys a new build, open WebSocket connections drop. Active
callers should return to the same room with the same media state (~1 s glitch)
and run the **same client JS** as the server.

Full design rationale: grill session 2026-06 (controlled reload, version trigger
B, 5 s reconnect hold, new server id per reload, direct join, device-id restore,
one reload budget, upgrade toast).

## Two reconnect paths

| Trigger | Detection | Client action |
| --- | --- | --- |
| **Deploy** (new build) | `welcome.buildVersion` ≠ `window.__BUILD_VERSION__` | Snapshot → `location.reload()` → auto-join + restore |
| **Network glitch** (same build) | Versions match on reconnect | Hold mesh/media up to 5 s, rebuild signaling session, re-attach streams |

Both paths share the **reconnect hold**: while `myId` is set and the socket drops,
`teardownRoom` is deferred for up to 5 s (timer is **not** re-armed on WS flap).

## Deploy path (step by step)

1. User is in a room; deploy kills the WebSocket.
2. `onReconnecting`: start reconnect hold, show *"återansluter…"*, **disable room
   controls** (clicks would be dropped by the signaling open-guard).
3. Reconnect **immediately** only if the previous socket had completed handshake
   (`gotMessageThisConnection`); otherwise normal backoff applies.
4. New server sends `welcome` with a new `buildVersion`.
5. Version mismatch → `captureDeployRestoreState()` →
   `writeDeployRestoreSnapshot()` → `location.reload()`.
6. On load → `readPendingRestore()` → skip lobby → `controller.join(name, { restore })`.
   - `videoOptOut` mirrored into stage + UI before connect.
   - `muted` applied on the mic track **before** `connect()` (no brief audio leak).
7. After matching `welcome` → `applyPendingRestore()` (camera/screen) →
   `reattachKeptLocalMedia()` (no-op on fresh reload) → toast
   *"babbla har uppdaterats — du är tillbaka i samtalet"* (~5 s).

## Same-build reconnect path

1. WS drops → reconnect hold (steps 2–3 above).
2. `welcome` with **matching** `buildVersion`.
3. `teardownSessionKeepMedia()` — drop mesh/presence, **keep** mic/camera/screen
   capture streams.
4. `processWelcome()` — new mesh + peers.
5. `reattachKeptLocalMedia()` — re-attach kept camera/screen to mesh, re-send
   `camera(true)` / `share(true)` to server.
6. No reload, no toast.

## Version stamps

| Stamp | Where | Purpose |
| --- | --- | --- |
| `window.__BUILD_VERSION__` | Injected in `index.html` by `server.js` | Client-side compare + diagnostics |
| `welcome.buildVersion` | `room.js` join effect | Server-side compare on every (re)join |
| UI `%BUILD_VERSION%` | Footer in lobby/room | Human-readable build label |

All three use the same `BUILD_VERSION` string (`YYYY-MM-DD HH:MM:SS <short-sha>`).

## Snapshot schema (v1)

Stored in `sessionStorage` under key `babbla:deploy-restore`. TTL **60 s**.
**One reload budget** per snapshot cycle.

| Field | Type | When applied |
| --- | --- | --- |
| `reason` | `"deploy-restore"` | Gate only |
| `buildVersion` | string | Diagnostics |
| `roomPath` | string | Must match `location.pathname` to auto-join |
| `name` | string | Auto-join |
| `muted` | boolean | **`join()`** — track disabled before `connect()`; idempotent in `applyPendingRestore()` |
| `videoOptOut` | boolean | **`join()`** — stage + UI before connect |
| `dnd` | boolean | `applyPendingRestore()` after `welcome` — re-enters "Stör ej" last (stops all capture again). When DND was active at snapshot time `cameraOn`/`screenOn` were false, so those blocks no-op. Tolerated-absent for older snapshots (defaults false). |
| `cameraOn` | boolean | `applyPendingRestore()` after `welcome` |
| `screenOn` | boolean | `applyPendingRestore()` after `welcome` |
| `micDeviceId` | string \| null | **Always written as `null`.** Kept in the schema so older snapshots still validate; device picks live in the `localStorage` stacks (see `device-stack.js`), which survive the deploy reload, so the restored session resolves them exactly as a cold load does. Snapshotting a device could only pin a temporary fallback as if it were a choice. |
| `cameraDeviceId` | string \| null | Same — always `null`. |
| `expiresAt` | number (epoch ms) | Enforced on read/write |
| `restoreAttempts` | `0` \| `1` | `0` = pending restore; `1` = tombstone (no reload) |

**Not persisted:** focus/pin, PiP, sidebar width, peer uncertainty, server peer id,
device picks (they live in `localStorage`, which outlives the reload).

`readPendingRestore()` validates the **full schema** (strict booleans, string
device ids). Invalid/corrupt entries are cleared.

`writeDeployRestoreSnapshot()`:
- No existing key → write fresh snapshot (`restoreAttempts: 0`).
- Expired/invalid existing → clear, then write.
- Valid pending existing → tombstone (`restoreAttempts: 1`), return null.
- Active tombstone → return null (fail closed).

## Code map

| Piece | Location |
| --- | --- |
| Snapshot read/write/validate | `public/js/session-restore.js` |
| Version compare, hold, capture, restore, re-attach | `public/js/room-controller.js` |
| Auto-join on load, toast, failure UI | `public/js/main.js` |
| Immediate reconnect guard | `public/js/signaling.js` (`gotMessageThisConnection`) |
| `buildVersion` in `welcome` | `room.js` |
| `BUILD_VERSION` + HTML injection | `server.js`, `public/index.html` |
| Upgrade toast CSS | `public/style.css` (`.upgrade-toast`; offset via `.env-banner + .upgrade-toast`) |

### Key functions (`room-controller.js`)

| Function | Role |
| --- | --- |
| `beginReconnectHold()` | Defer `teardownRoom` up to `RECONNECT_HOLD_MS` (5 s) |
| `captureDeployRestoreState()` | Build snapshot from live session state |
| `handleDeployVersionMismatch()` | Snapshot + reload, or close signaling + lobby error |
| `teardownSessionKeepMedia()` | Same-build path: drop session, keep capture |
| `reattachKeptLocalMedia()` | Re-wire kept camera/screen after same-build `welcome` |
| `applyPendingRestore()` | Post-reload restore after matching `welcome` |
| `join(name, { restore })` | Pre-connect restore for mute/videoOptOut/device prefs |

## UI contract

| Phase | User sees |
| --- | --- |
| WS drop (in room) | Status *"återansluter…"*; controls disabled |
| Reload pending | Brief white flash |
| Auto-restore join | Status *"Återansluter efter uppdatering…"* |
| Restore success | Toast *"babbla har uppdaterats — du är tillbaka i samtalet"* (~5 s) |
| Restore failure | Lobby + *"Kunde inte återställa efter uppdatering — gå med igen"* |

Chimes follow existing rules (no extra deploy-specific chime logic).

## Checklist — new state that should survive deploy

When adding a user-facing toggle or preference that must come back after reload:

1. Add a field to the schema table above.
2. Include it in `captureDeployRestoreState()`.
3. Apply it in the right phase:
   - **Before `connect()`** in `join()` if it must be correct before any audio/video
     ships (mute, videoOptOut, device prefs).
   - **After `welcome`** in `applyPendingRestore()` or `reattachKeptLocalMedia()`
     for media that needs mesh/signaling.
4. Mirror into stage/UI if the toggle has visible chrome.
5. Add a test in `test/session-restore.test.js` and/or `test/room-controller.test.js`.
6. Update this doc.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| Reconnect hold > 5 s | Full `teardownRoom` |
| Reconnect flap during hold | Timer **not** reset — max one 5 s window |
| WS down during hold | Room controls **disabled** |
| Snapshot expired (> 60 s) | Normal lobby |
| Wrong room URL vs snapshot | Snapshot cleared, normal lobby |
| Corrupt snapshot JSON/types | Cleared on read, normal lobby |
| Second reload (cached old JS) | Tombstone; signaling `leave`+`close`; lobby error |
| Expired tombstone in long-lived tab | Cleared on next deploy write |
| Snapshot write / storage failure | Signaling closed; lobby error |
| Mic denied on restore | Lobby + failure message |
| Camera restore fails | No `camera(true)` sent (presence stays honest) |
| Same-build reconnect | Media kept; streams re-attached after `welcome` |
| Pre-first-`welcome` disconnect | Normal backoff (no immediate reconnect) |

## Testing

```bash
npm test   # session-restore + room-controller deploy rails
```

Manual regression: two clients in a room with camera and/or screen → deploy
staging → confirm auto-restore, toast, and peer media without manual clicks.
