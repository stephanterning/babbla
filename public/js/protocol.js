// Shared signaling vocabulary — the one place the WebSocket message `type`
// strings are defined. Imported by both runtimes: the browser client
// (`./protocol.js` from main.js) and the Node server (`./public/js/protocol.js`
// from server.js), since both are ESM and there is no build step. Keying every
// switch case and every send off these constants kills the "renamed/typo'd type
// silently falls through `default`" footgun the two hand-kept switches had.
//
// Only the `type` field is shared. Message *shapes* stay where they're built —
// notably the relayed messages are asymmetric (a client sends `targetId`, the
// server forwards it as `id`/`from`), so there is no single shared builder.

export const MSG = {
  // Client -> server.
  JOIN: "join",
  LEAVE: "leave",
  SHARE: "share",
  // Bidirectional (relayed point-to-point, or broadcast presence).
  SIGNAL: "signal",
  MUTE: "mute",
  // Do Not Disturb: a peer stays in the room but exchanges NO media in either
  // direction. Broadcast like mute (cooperative presence): others show a moon
  // badge and stop sending audio/camera/screen to the DND peer. See
  // .cursor/plans/dnd-do-not-disturb.md.
  DND: "dnd",
  CAMERA: "camera",
  VIDEO_OPT_OUT: "video-opt-out",
  CAMERA_FOCUS: "camera-focus",
  VIDEO_SUPPRESS: "video-suppress",
  // Client -> server, stats-only (never relayed): each peer reports the
  // transport classification (direct/relay/unknown) of a pair when it changes,
  // so the server can log who needed a relay. See .cursor/plans/stats-poc.md.
  TRANSPORT: "transport",
  // Client -> server, stats-only (never relayed): a STUN/TURN server refused or
  // never answered an ICE request (browser `icecandidateerror`). Logged so a
  // broken relay — the thing that leaves a peer stuck on "ansluter" — is visible
  // to the operator instead of only in one reporter's devtools console.
  ICE_ERROR: "ice-error",
  // Client asks for fresh TURN credentials; the server replies with the same
  // type carrying a new `iceServers` (ephemeral HMAC creds) + `iceRefreshMs`.
  // Keeps long sessions' relay credentials valid without ever reloading.
  ICE_REFRESH: "ice-refresh",
  // Server -> client.
  WELCOME: "welcome",
  PEER_JOINED: "peer-joined",
  PEER_LEFT: "peer-left",
  SHARER: "sharer",
  CAMERA_LIMIT: "camera-limit",
};
