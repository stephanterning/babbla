// Signaling module — the client's WebSocket transport behind a small interface.
// Owns the socket lifecycle (connect, reconnect with capped backoff, the
// open-socket send guard, JSON framing) and exposes typed send methods plus a
// few lifecycle callbacks. No DOM, no room/UI knowledge — the renderer wires
// callbacks and calls send methods, exactly the way it wires `createMesh`.
//
// Two adapters justify the seam: the real `WebSocket` in production and an
// in-memory fake in tests, both supplied through the injectable `connect`
// factory (it must be a factory, not a single socket, because reconnect
// re-creates the transport).

import { MSG } from "./protocol.js";

const OPEN = 1; // WebSocket.OPEN readyState, per the WHATWG spec.

/**
 * @param {object} options
 * @param {string} options.url
 * @param {(url: string) => WebSocket} [options.connect] transport factory
 * @param {() => void} [options.onOpen] socket opened (initial or reconnect)
 * @param {(msg: object) => void} [options.onMessage] parsed inbound message
 * @param {() => void} [options.onReconnecting] unexpected drop; a retry is queued
 * @param {number} [options.minReconnectMs]
 * @param {number} [options.maxReconnectMs]
 */
export function createSignaling({
  url,
  connect = (u) => new WebSocket(u),
  onOpen,
  onMessage,
  onReconnecting,
  minReconnectMs = 1_000,
  maxReconnectMs = 15_000,
}) {
  let ws = null;
  let intentional = false;
  let reconnectTimer = null;
  let reconnectDelay = 0;
  // Reset backoff on the first inbound message of a connection (the server's
  // `welcome`), not merely on open — so a socket that connects but never
  // completes the handshake keeps backing off instead of hot-looping.
  let gotMessageThisConnection = false;

  function open() {
    // Capture this connection: a late close/error from a *superseded* socket
    // must never act on the current one (closing it or queuing another
    // reconnect would cause flapping). Every handler bails when it's no longer
    // the live socket, and the error handler force-closes its own socket only.
    const socket = connect(url);
    ws = socket;
    gotMessageThisConnection = false;

    socket.addEventListener("open", () => {
      if (socket !== ws) return;
      onOpen?.();
    });

    socket.addEventListener("message", (ev) => {
      if (socket !== ws) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!gotMessageThisConnection) {
        gotMessageThisConnection = true;
        reconnectDelay = 0;
      }
      onMessage?.(msg);
    });

    socket.addEventListener("close", () => {
      if (socket !== ws || intentional) return;
      const hadHandshake = gotMessageThisConnection;
      const opts = onReconnecting?.() ?? {};
      scheduleReconnect(!!opts.immediate && hadHandshake);
    });

    // A socket error is followed by close in browsers; force-close *this* socket
    // so the reconnect path runs from its own close handler.
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {}
    });
  }

  function scheduleReconnect(immediate = false) {
    if (immediate) {
      reconnectDelay = 0;
    } else {
      reconnectDelay = reconnectDelay
        ? Math.min(reconnectDelay * 2, maxReconnectMs)
        : minReconnectMs;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (!intentional) open();
    }, reconnectDelay);
  }

  // Drop a message when the socket isn't open (a click during reconnect) instead
  // of throwing InvalidStateError. Returns whether it was actually sent.
  function send(msg) {
    if (ws?.readyState !== OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function close() {
    intentional = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    try {
      ws?.close();
    } catch {}
  }

  open();

  return {
    // Typed outbound (each is open-guarded; returns whether it was sent).
    // `clientId` is the stable per-tab id for usage stats (see room-controller).
    // `clientIp` is this client's STUN-discovered public IP (stats-only, may be
    // null); the server resolves it to an ASN when the proxy hid the real IP.
    join: (name, clientId, clientIp) =>
      send({ type: MSG.JOIN, name, clientId, clientIp: clientIp || null }),
    leave: () => send({ type: MSG.LEAVE }),
    signal: (to, data) => send({ type: MSG.SIGNAL, to, data }),
    mute: (on) => send({ type: MSG.MUTE, on }),
    dnd: (on) => send({ type: MSG.DND, on }),
    share: (on) => send({ type: MSG.SHARE, on }),
    camera: (on) => send({ type: MSG.CAMERA, on }),
    videoOptOut: (on) => send({ type: MSG.VIDEO_OPT_OUT, on }),
    cameraFocus: (targetId, on) =>
      send({ type: MSG.CAMERA_FOCUS, targetId, on }),
    videoSuppress: (targetId, on) =>
      send({ type: MSG.VIDEO_SUPPRESS, targetId, on }),
    // Stats-only: report this pair's transport classification when it changes.
    transport: (targetId, classification, localCandidateType, remoteCandidateType) =>
      send({
        type: MSG.TRANSPORT,
        targetId,
        classification,
        localCandidateType,
        remoteCandidateType,
      }),
    // Stats-only: a STUN/TURN server refused or never answered an ICE request.
    iceError: ({ url, errorCode, errorText } = {}) =>
      send({ type: MSG.ICE_ERROR, url, errorCode, errorText }),
    // Ask the server for fresh TURN credentials (rolling renewal for long
    // sessions). The reply comes back as an MSG.ICE_REFRESH inbound message.
    iceRefresh: () => send({ type: MSG.ICE_REFRESH }),
    // Is the socket currently open? Used by "emit only on change" reconcilers
    // that must not advance their sent-state when they couldn't actually send.
    isOpen: () => ws?.readyState === OPEN,
    close,
  };
}
