// Room — the server's single fixed room as a pure presence state machine. It
// owns who is in the room (id -> name), who is sharing their screen, whose
// camera is on, who has muted their mic, and who has opted out of inbound video,
// plus the rules for each (latest-sharer-wins, the camera cap, departure
// cleanup, the join guard).
//
// It deals only in peer ids and messages: every method returns an array of
// EFFECTS — `{ to: string[], msg }` — describing what to send to which peers,
// and never touches a socket. server.js is the thin adapter that maps ids to
// live WebSockets and flushes the effects. That split keeps the room's rules
// testable without a server (the interface is the test surface) and keeps the
// transport (sockets, heartbeat) out of the rules.

import { MSG } from "./public/js/protocol.js";
// The room name canonicalization is shared with the browser client (display +
// URL rewrite) so the routing key and the shown name can't drift. See
// public/js/room-name.js for the rule.
import { DEFAULT_ROOM, sanitizeRoomName } from "./public/js/room-name.js";

const DEFAULT_MAX_CAMERAS = 6;

export { DEFAULT_ROOM, sanitizeRoomName };

export function createRoom({
  maxCameras = DEFAULT_MAX_CAMERAS,
  buildVersion = "",
  // Injected by the server adapter: returns `{ iceServers, refreshMs }` (fresh
  // ephemeral TURN creds) or null when TURN is unconfigured. The Room only
  // *carries* the value into welcome/ice-refresh — it never does crypto/clock,
  // so it stays a pure, testable state machine. See docs/turn-coturn.md.
  getIceServers = () => null,
} = {}) {
  /** @type {Map<string, { name: string }>} */
  const peers = new Map();
  let currentSharer = null;
  /** @type {Set<string>} */
  const camerasOn = new Set();
  /** @type {Set<string>} Peers who've muted their mic (cooperative presence). */
  const mutedPeers = new Set();
  /** @type {Set<string>} Peers in "Stör ej" (Do Not Disturb): no media in/out. */
  const dndPeers = new Set();
  /** @type {Set<string>} */
  const videoOptOuts = new Set();

  const all = () => [...peers.keys()];
  const others = (exceptId) => all().filter((id) => id !== exceptId);
  const roster = () =>
    [...peers.entries()].map(([id, p]) => ({ id, name: p.name }));

  // Add a peer and welcome it. The welcome carries the *current* presence
  // (roster excludes the joiner, who isn't added yet) so the newcomer can mirror
  // it; existing peers get a peer-joined. A duplicate join for a known id is a
  // no-op (the membership replaces the old per-connection `joined` flag).
  function join(id, rawName, turn) {
    if (peers.has(id)) return [];
    if (turn === undefined) turn = getIceServers();
    const name = String(rawName || "").trim().slice(0, 40) || "Anon";
    const sharerPeer = currentSharer ? peers.get(currentSharer) : null;
    const welcome = {
      type: MSG.WELCOME,
      id,
      peers: roster(),
      sharer: sharerPeer ? { id: currentSharer, name: sharerPeer.name } : null,
      cameras: [...camerasOn],
      muted: [...mutedPeers],
      dnd: [...dndPeers],
      videoOptOuts: [...videoOptOuts],
      buildVersion,
      // Server-contributed TURN servers (ephemeral creds) + refresh cadence.
      // Omitted when TURN is unconfigured (client then stays STUN-only).
      iceServers: turn?.iceServers,
      iceRefreshMs: turn?.refreshMs,
    };
    peers.set(id, { name });
    return [
      { to: [id], msg: welcome },
      { to: others(id), msg: { type: MSG.PEER_JOINED, id, name } },
    ];
  }

  // Remove a peer (departure or dropped connection) and clean up the presence
  // they held: relinquish the sharer slot and camera, then announce the leave.
  function remove(id) {
    if (!peers.delete(id)) return [];
    const effects = [];
    if (currentSharer === id) {
      currentSharer = null;
      effects.push({ to: all(), msg: { type: MSG.SHARER, id: null } });
    }
    if (camerasOn.delete(id)) {
      effects.push({ to: all(), msg: { type: MSG.CAMERA, id, on: false } });
    }
    // Mute is a per-peer hint with no shared state; the peer-left below clears
    // the tile, so just drop the flag without a separate "unmute" broadcast.
    mutedPeers.delete(id);
    // DND is likewise a cooperative hint; peer-left removes the tile, so no
    // separate "dnd off" broadcast is needed.
    dndPeers.delete(id);
    videoOptOuts.delete(id);
    effects.push({ to: all(), msg: { type: MSG.PEER_LEFT, id } });
    return effects;
  }

  // Relay an SDP offer/answer or ICE candidate to one peer.
  function signal(fromId, to, data) {
    if (!peers.has(fromId) || !to || !peers.has(to)) return [];
    return [{ to: [to], msg: { type: MSG.SIGNAL, from: fromId, data } }];
  }

  // Screen-share presence. Latest wins: a new sharer overwrites the slot and the
  // previous holder learns it lost via the broadcast. A "share off" only counts
  // from the current holder.
  function share(fromId, on) {
    if (!peers.has(fromId)) return [];
    if (on) {
      currentSharer = fromId;
      const name = peers.get(fromId)?.name ?? "";
      return [{ to: others(fromId), msg: { type: MSG.SHARER, id: fromId, name } }];
    }
    if (currentSharer === fromId) {
      currentSharer = null;
      return [{ to: others(fromId), msg: { type: MSG.SHARER, id: null } }];
    }
    return [];
  }

  // Camera presence with a hard cap. The (maxCameras+1)-th camera turns *all*
  // cameras off with an explanation instead of letting the mesh degrade.
  function camera(fromId, on) {
    if (!peers.has(fromId)) return [];
    if (on) {
      if (camerasOn.has(fromId)) return [];
      if (camerasOn.size >= maxCameras) {
        camerasOn.clear();
        return [{ to: all(), msg: { type: MSG.CAMERA_LIMIT, reason: "max_cameras" } }];
      }
      camerasOn.add(fromId);
      return [{ to: all(), msg: { type: MSG.CAMERA, id: fromId, on: true } }];
    }
    if (!camerasOn.delete(fromId)) return [];
    return [{ to: all(), msg: { type: MSG.CAMERA, id: fromId, on: false } }];
  }

  // Mic-mute presence — a cooperative awareness hint so others can see a peer
  // has deliberately turned their mic off (the audio is already gone via the
  // mesh's replaceTrack(null)). Broadcast to others only; the sender flips its
  // own UI locally and never needs the echo. No-op gated so a re-mute / re-unmute
  // doesn't spam the room.
  function mute(fromId, on) {
    if (!peers.has(fromId)) return [];
    if (on) {
      if (mutedPeers.has(fromId)) return [];
      mutedPeers.add(fromId);
    } else if (!mutedPeers.delete(fromId)) {
      return [];
    }
    return [{ to: others(fromId), msg: { type: MSG.MUTE, id: fromId, on: !!on } }];
  }

  // "Stör ej" (Do Not Disturb) presence — a cooperative hint like mute. When on,
  // the peer stays in the room but sends/receives no media; others show a moon
  // badge and stop sending audio/camera/screen to them. Broadcast to others only
  // (the sender flips its own UI locally); no-op gated so a re-toggle doesn't
  // spam. Newcomers learn the current DND set from the welcome roster.
  function dnd(fromId, on) {
    if (!peers.has(fromId)) return [];
    if (on) {
      if (dndPeers.has(fromId)) return [];
      dndPeers.add(fromId);
    } else if (!dndPeers.delete(fromId)) {
      return [];
    }
    return [{ to: others(fromId), msg: { type: MSG.DND, id: fromId, on: !!on } }];
  }

  // Per-client opt-out from *receiving* video (peers stop sending them camera).
  function videoOptOut(fromId, on) {
    if (!peers.has(fromId)) return [];
    if (on) videoOptOuts.add(fromId);
    else videoOptOuts.delete(fromId);
    return [{ to: all(), msg: { type: MSG.VIDEO_OPT_OUT, id: fromId, on: !!on } }];
  }

  // Relay a "I'm viewing your camera enlarged" hint to the camera owner.
  function cameraFocus(fromId, targetId, on) {
    if (!peers.has(fromId) || !targetId || !peers.has(targetId)) return [];
    return [{ to: [targetId], msg: { type: MSG.CAMERA_FOCUS, id: fromId, on: !!on } }];
  }

  // Relay a "pause the video you send me" hint to a sender.
  function videoSuppress(fromId, targetId, on) {
    if (!peers.has(fromId) || !targetId || !peers.has(targetId)) return [];
    return [{ to: [targetId], msg: { type: MSG.VIDEO_SUPPRESS, id: fromId, on: !!on } }];
  }

  // Hand a known peer a fresh set of TURN credentials (the rolling renewal that
  // keeps long sessions' relay valid). No-op when the peer is unknown or TURN is
  // unconfigured (the provider returns null).
  function iceRefresh(fromId, turn) {
    if (!peers.has(fromId)) return [];
    if (turn === undefined) turn = getIceServers();
    if (!turn) return [];
    return [
      {
        to: [fromId],
        msg: {
          type: MSG.ICE_REFRESH,
          iceServers: turn.iceServers,
          iceRefreshMs: turn.refreshMs,
        },
      },
    ];
  }

  return {
    join,
    remove,
    signal,
    share,
    camera,
    mute,
    dnd,
    videoOptOut,
    cameraFocus,
    videoSuppress,
    iceRefresh,
    // Read-only peek for diagnostics/tests.
    size: () => peers.size,
    hasPeer: (id) => peers.has(id),
  };
}

// A keyed collection of isolated rooms (one per name). Rooms are created on
// demand and dropped once empty so memory tracks live rooms only. Pure (no
// sockets) — the server adapter holds the id->socket map and flushes effects.
export function createRoomRegistry({ buildVersion = "", getIceServers } = {}) {
  /** @type {Map<string, ReturnType<typeof createRoom>>} */
  const rooms = new Map();

  function get(name) {
    let room = rooms.get(name);
    if (!room) {
      room = createRoom({ buildVersion, getIceServers });
      rooms.set(name, room);
    }
    return room;
  }

  // Garbage-collect a room once its last peer has left, so an empty named room
  // doesn't linger forever. Room state is ephemeral, so re-creating it on the
  // next join is free.
  function removeIfEmpty(name) {
    const room = rooms.get(name);
    if (room && room.size() === 0) rooms.delete(name);
  }

  // Read-only enumeration for the live stats cards ("aktiva rum nu" /
  // "deltagare inne nu"). Returns a plain snapshot (name + peer count) — no
  // sockets, so the registry stays pure; the server adapter owns id->socket.
  function listActiveRooms() {
    return [...rooms.entries()].map(([name, room]) => ({
      name,
      peerCount: room.size(),
    }));
  }

  return {
    get,
    removeIfEmpty,
    listActiveRooms,
    size: () => rooms.size,
    has: (name) => rooms.has(name),
  };
}
