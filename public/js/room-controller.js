// RoomController — the orchestration that wires server messages and user actions
// to the stage director, the WebRTC mesh, the signaling transport, and the view.
//
// This is the "glue" that used to live as ~40 interleaved functions in main.js.
// It owns the room session lifecycle (join/connect/teardown), the mesh + local
// media (mic/camera/screen) handles, the presence/focus handlers, the inbound
// dispatch, the reclassify gating, and the camera-focus / video-suppress
// reconcilers. It deals only in ids/roles/booleans: every DOM touch goes through
// the injected `ui` port, every capture through `media`, and the transport/mesh
// are created via injected factories — so the whole controller runs (and is
// asserted) in Node with fakes, no browser. The stage director is injected too
// (a pure, separately tested module) and is the single source of presence/focus
// truth; the controller mirrors server presence into it and renders its view.
//
// Shape mirrors createMesh / createStageDirector: a factory with private state
// and a small set of event-in methods (join, the inbound dispatch wired onto the
// signaling, and the user-action methods the composition root binds to DOM
// events). The only "render" is `ui.render(view)`, called from applyFocusView
// after every presence/focus mutation.

import { MSG } from "./protocol.js";
import { createMesh as defaultCreateMesh } from "./mesh.js";
import { createMicPipeline as defaultCreateMicPipeline } from "./mic-pipeline.js";
import { createSignaling as defaultCreateSignaling } from "./signaling.js";
import { discoverPublicIp } from "./public-ip.js";
import {
  clearSessionRestore,
  getClientBuildVersion,
  roomPathFromLocation,
  writeDeployRestoreSnapshot,
} from "./session-restore.js";
import {
  SYSTEM_VALUE,
  entryFromValue,
  entryKey,
  isSystemEntry,
  isSystemValue,
  parseStack,
  pushPick,
  resolveStack,
  serializeStack,
  systemDefaultDrifted,
} from "./device-stack.js";

// The STUN base every client always has. The server may additionally hand us
// TURN servers (ephemeral creds) in `welcome`/`ice-refresh`; we merge those on
// top so STUN srflx is always available alongside any relay. STUN-only when the
// server contributes nothing (TURN unconfigured / local dev).
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

function mergeIceServers(serverContributed) {
  return Array.isArray(serverContributed) && serverContributed.length
    ? [...ICE_SERVERS, ...serverContributed]
    : ICE_SERVERS;
}

const AUDIO_PROCESSING = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** Capture/encode presets. `standard` is what every peer receives; `high` (with
 *  the `high720` capability fallback) is delivered only to peers focusing our
 *  camera. There is no user-facing picker — the boost is driven purely by focus. */
const CAMERA_QUALITY = {
  standard: {
    capture: {
      width: { ideal: 640, max: 640 },
      height: { ideal: 360, max: 360 },
      frameRate: { ideal: 15, max: 15 },
    },
    maxBitrate: 250_000,
    contentHint: "motion",
  },
  high: {
    capture: {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 50, max: 50 },
    },
    maxBitrate: 2_500_000,
    contentHint: "motion",
  },
  // Capability fallback for `high`: a webcam that can't reach 1080p@50 drops to
  // 720p@25 at the same send bitrate before giving up to standard entirely.
  high720: {
    capture: {
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 25, max: 25 },
    },
    maxBitrate: 2_500_000,
    contentHint: "motion",
  },
};

// Boost capture levels in descending preference. A failed applyConstraints
// ratchets to the next entry; exhausting the chain falls through to standard.
const CAMERA_BOOST_CHAIN = ["high", "high720"];

const SCREEN_CONSTRAINTS = {
  video: { frameRate: { ideal: 10, max: 15 } },
  audio: false,
};

// Keep a viewer on the boosted (focus) camera quality this long after they
// unfocus, so quick focus toggles don't thrash the encoder / drop a keyframe.
const CAMERA_FOCUS_HOLD_MS = 2_000;

// After an unexpected WS drop, keep local media + mesh alive briefly while we
// reconnect and compare build versions. See docs/session-restore.md.
const RECONNECT_HOLD_MS = 5_000;

// Remembered device picks (mic/camera). Persisted so the next visit reuses the
// same hardware; applied as `ideal` at join so a since-removed device falls back
// gracefully to the system default.
// Superseded single-pick keys, still read once by migrateLegacyDevicePrefs.
const MIC_ID_KEY = "babbla:micId";
const CAMERA_ID_KEY = "babbla:cameraId";
const SPEAKER_ID_KEY = "babbla:speakerId";
const MIC_STACK_KEY = "babbla:micStack";
const CAMERA_STACK_KEY = "babbla:cameraStack";
const SPEAKER_STACK_KEY = "babbla:speakerStack";
// Remembered "Brusreducering" level (off | lite | full). Default lite — see
// docs/noise-reduction.md: the reduction is default-on so it reaches the noisy
// sender, who doesn't hear their own noise and wouldn't opt in.
const NOISE_KEY = "babbla:noiseReduction";
const NOISE_LEVELS = new Set(["off", "lite", "full"]);
const DEFAULT_NOISE_LEVEL = "lite";
// Video opt-out ("stäng av video för mig") is a *persistent preference*, not a
// per-room state: in the SPA model a single page load can span several room
// sessions, and the product decision is that opting out of video sticks across
// rooms (and reloads). So it lives in localStorage and is re-applied on each
// join. (Mute, by contrast, resets to unmuted on a fresh room session.)
const VIDEO_OPT_OUT_KEY = "babbla:videoOptOut";

function readNoisePref() {
  const stored = readDevicePref(NOISE_KEY);
  return stored && NOISE_LEVELS.has(stored) ? stored : DEFAULT_NOISE_LEVEL;
}

function readVideoOptOutPref() {
  return readDevicePref(VIDEO_OPT_OUT_KEY) === "1";
}

function saveVideoOptOutPref(on) {
  saveDevicePref(VIDEO_OPT_OUT_KEY, on ? "1" : null);
}

// Log-only sanity check (docs/echo-cancellation-step2.md §2a): some virtual /
// aggregate devices silently disable the capture processing we rely on. Warn so
// it's diagnosable; no UI. No-op where getSettings is unavailable (Node tests).
function warnIfAudioProcessingDisabled(stream) {
  try {
    const s = stream?.getAudioTracks?.()[0]?.getSettings?.() || {};
    const off = [];
    if (s.echoCancellation === false) off.push("echoCancellation");
    if (s.noiseSuppression === false) off.push("noiseSuppression");
    if (s.autoGainControl === false) off.push("autoGainControl");
    if (off.length) {
      console.warn(
        `[babbla] mikrofonens capture-processing är av: ${off.join(", ")} — ` +
          "eko/brus kan bli sämre.",
      );
    }
  } catch {}
}

function getCameraQualityPreset(level = "standard") {
  return CAMERA_QUALITY[level] || CAMERA_QUALITY.standard;
}

function getCameraMaxBitrate(level = "standard") {
  return getCameraQualityPreset(level).maxBitrate;
}

// Build mic constraints, optionally pinned to a chosen device. `exact` throws if
// the device is gone (used when the user explicitly picks one, so we can revert
// the dropdown); `ideal` falls back to the default mic instead (used at join /
// reconnect so a since-removed remembered device never blocks getting audio).
// The synthetic "default" sentinel is represented in app state, but for capture
// we deliberately leave deviceId unconstrained for cross-browser compatibility.
function buildAudioConstraints(deviceId, exact = true) {
  const audio = { ...AUDIO_PROCESSING };
  if (deviceId && deviceId !== "default") {
    audio.deviceId = exact ? { exact: deviceId } : { ideal: deviceId };
  }
  return { audio, video: false };
}

// Build camera constraints for a capture level, optionally pinned to a device.
// See buildAudioConstraints for the exact/ideal distinction.
function buildCameraConstraints(level, deviceId, exact = true) {
  const video = { ...getCameraQualityPreset(level).capture };
  if (deviceId) video.deviceId = exact ? { exact: deviceId } : { ideal: deviceId };
  return { video, audio: false };
}

// Real, selectable device ids only. Chrome also reports virtual "default" /
// "communications" aggregate entries whose id isn't stable across sessions; we
// drop them from the concrete lists so the dropdown maps 1:1 to physical
// devices. The explicit "follow system default" choice is modeled separately
// as the stable sentinel string "default" (not as a concrete persisted id).
function isSelectableDevice(device) {
  return (
    !!device.deviceId &&
    device.deviceId !== "default" &&
    device.deviceId !== "communications"
  );
}

function hasSystemDefaultDevice(devices, kind) {
  return devices.some((d) => d.kind === kind && d.deviceId === "default");
}

function stripDefaultPrefix(label) {
  if (typeof label !== "string") return "";
  return label.replace(/^default\s*[—–-]\s*/i, "").trim();
}

function resolveSystemDefaultName(devices, kind) {
  const sys = devices.find((d) => d.kind === kind && d.deviceId === "default");
  if (!sys) return null;
  if (sys.groupId) {
    const concrete = devices.find(
      (d) =>
        d.kind === kind &&
        d.groupId === sys.groupId &&
        !!d.deviceId &&
        d.deviceId !== "default" &&
        d.deviceId !== "communications",
    );
    if (concrete?.label) return concrete.label;
  }
  const stripped = stripDefaultPrefix(sys.label);
  if (stripped) return stripped;
  return typeof sys.label === "string" && sys.label ? sys.label : null;
}

// Stable per-tab id for usage stats: lets the server stitch a participant's
// reconnects / deploy-restores into one identity (correct dwell + distinct-
// participant counts) WITHOUT cross-visit tracking — sessionStorage clears when
// the tab closes. Sent with `join`. See .cursor/plans/stats-poc.md beslut 4.
const CLIENT_ID_KEY = "babbla:clientId";
function getStatsClientId() {
  const gen = () =>
    globalThis.crypto?.randomUUID?.() ||
    `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    let id = sessionStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = gen();
      sessionStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return gen();
  }
}

function readDevicePref(key) {
  try {
    return localStorage.getItem(key) || null;
  } catch {
    return null;
  }
}

function saveDevicePref(key, id) {
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {}
}

function readStack(key) {
  return parseStack(readDevicePref(key));
}

function saveStack(key, stack) {
  saveDevicePref(key, stack.length ? serializeStack(stack) : null);
}

/**
 * One-time upgrade of the single-pick keys (`babbla:micId` and friends) into a
 * one-element stack. The stored id is still good — deviceId is hashed with a
 * persistent per-origin salt, so it survives reloads. The legacy keys are left
 * in place rather than deleted, so rolling back to an older build doesn't lose
 * the user's pick; migration is skipped once a stack key exists.
 */
function migrateLegacyDevicePrefs() {
  for (const { kind, legacyKey, stackKey } of [
    { kind: "mic", legacyKey: MIC_ID_KEY, stackKey: MIC_STACK_KEY },
    { kind: "camera", legacyKey: CAMERA_ID_KEY, stackKey: CAMERA_STACK_KEY },
    { kind: "speaker", legacyKey: SPEAKER_ID_KEY, stackKey: SPEAKER_STACK_KEY },
  ]) {
    if (readDevicePref(stackKey)) continue;
    const id = readDevicePref(legacyKey);
    if (!id) continue;
    // Only the label is salvageable from the old `:meta` blob; its groupId was
    // written from a previous document and cannot match anything now.
    let label = "";
    try {
      const meta = JSON.parse(readDevicePref(`${legacyKey}:meta`) || "null");
      if (typeof meta?.label === "string") label = meta.label;
    } catch {}
    const entry = isSystemValue(kind, id) ? { system: true } : { deviceId: id, label };
    saveStack(stackKey, [entry]);
  }
}

/**
 * @param {object} deps
 * @param {ReturnType<import("./stage.js").createStageDirector>} deps.stage
 * @param {object} deps.ui view adapter (see main.js)
 * @param {object} deps.media capture adapter (getUserMedia/getDisplayMedia/enumerateDevices/canShareScreen)
 * @param {string} [deps.signalingUrl] fixed WebSocket URL (legacy/tests; a
 *   single-room controller). For the SPA, pass `signalingUrlFor` instead.
 * @param {(room: string) => string} [deps.signalingUrlFor] build the WS URL for
 *   a canonical room name (room changes per join in the SPA model).
 * @param {(room: string) => string} [deps.roomPathFor] build the path
 *   (`/` or `/room/x`) for the deploy-restore snapshot, from a room name.
 * @param {string} [deps.room] initial canonical room name.
 * @param {typeof defaultCreateMesh} [deps.createMesh]
 * @param {typeof defaultCreateSignaling} [deps.createSignaling]
 * @param {string} [deps.clientBuildVersion]
 * @param {string} [deps.roomPath]
 * @param {() => void} [deps.reload]
 * @param {Storage | null} [deps.restoreStorage] sessionStorage override (tests)
 * @param {number} [deps.reconnectHoldMs]
 */
export function createRoomController({
  stage,
  ui,
  media,
  signalingUrl,
  signalingUrlFor,
  roomPathFor,
  room = "",
  createMesh = defaultCreateMesh,
  createSignaling = defaultCreateSignaling,
  createMicPipeline = defaultCreateMicPipeline,
  clientBuildVersion = getClientBuildVersion(),
  roomPath = roomPathFromLocation(),
  reload = () => globalThis.location?.reload(),
  restoreStorage = undefined,
  reconnectHoldMs = RECONNECT_HOLD_MS,
  clientId = getStatsClientId(),
}) {
  // The room is dynamic in the SPA: `currentRoom` is updated by join({ room }),
  // and the signaling URL + snapshot path are derived from it. Fixed-string
  // deps (signalingUrl/roomPath) remain the fallback for the single-room tests.
  let currentRoom = room;
  const urlForRoom =
    signalingUrlFor || ((_room) => signalingUrl);
  const pathForRoom =
    roomPathFor || ((_room) => roomPath);
  /** @type {ReturnType<typeof createMesh> | null} */
  let mesh = null;
  /** @type {ReturnType<typeof createSignaling> | null} */
  let signaling = null;
  let myId = null;
  let myName = "";
  // `localStream` is always the RAW getUserMedia mic stream — deviceId
  // (activeMicId), mute truth (track.enabled), and deploy-restore all read it.
  // The processed output (HPF + expander) lives in `micPipeline`; ONLY the mesh
  // and the self-meter consume it. See docs/noise-reduction.md.
  let localStream = null;
  // The session generation that put the live mic there. An abandoned join uses
  // it to tell "this is still mine to release" from "a newer join owns the mic
  // now", so cleaning up after itself cannot cut off the session that replaced it.
  let localStreamGen = 0;
  /** @type {ReturnType<typeof createMicPipeline> | null} */
  let micPipeline = null;
  let noiseLevel = readNoisePref();
  let localCameraStream = null;
  let localScreenStream = null;

  // The user's explicit device picks, most-recent-first (see device-stack.js).
  // Written ONLY by switchMicrophone / switchCamera / switchSpeaker. Every other
  // path — join, fallback, unplug recovery, auto-selection — is a pure *read*,
  // so an auto-granted device can never masquerade as a choice.
  migrateLegacyDevicePrefs();
  /** @type {Record<"mic"|"camera"|"speaker", Array<object>>} */
  const stacks = {
    mic: readStack(MIC_STACK_KEY),
    camera: readStack(CAMERA_STACK_KEY),
    speaker: readStack(SPEAKER_STACK_KEY),
  };
  // Session-only side tables keyed by entryKey(kind, entry).
  //
  // `groupId` is salted per *document*, so it is regenerated on every page load
  // and can never be persisted usefully — but it does identify the same physical
  // device across a replug within one page load, which is the dock/undock case.
  // So we learn it from the live enumeration and keep it in memory only.
  /** @type {Map<string, string>} */
  const sessionGroupIds = new Map();
  // Devices that are listed but refused to open (held by another app). Keyed by
  // the *live* device that failed (`kind:deviceId`), never by the stack entry
  // that asked for it: an entry can resolve to a different device than it did
  // before, and a verdict on one piece of hardware must not disqualify the pick
  // itself. Treated as unavailable so the walk continues, and cleared when the
  // device leaves and re-enters the enumeration — "busy" is a fact about now,
  // not a preference, so it is never persisted.
  /** @type {Set<string>} */
  const unusableDevices = new Set();
  /** @type {Map<string, Set<string>>} kind -> deviceIds seen last enumeration */
  const lastSeenDeviceIds = new Map();
  /** Last enumerateDevices() snapshot — the label/groupId source for a new pick. */
  let lastRawDevices = [];
  // True while a reconcile is in flight, so the refreshDeviceList triggered by a
  // recapture only repaints instead of recursing into another reconcile.
  let reconcilingDevices = false;
  let micRecovering = false;
  // Was the live mic captured without a deviceId constraint? That is what makes
  // it the OS default rather than a pinned device, and it cannot be read back
  // from the track: Chrome reports `deviceId: "default"` for an unconstrained
  // capture but other engines report the concrete device.
  let micCaptureUnconstrained = false;
  /** Latest sink id requested from the view, so speaker reconcile can no-op. */
  let requestedSinkId = null;
  /** Serializes sink changes; see applyAudioOutput. */
  let sinkQueue = Promise.resolve();

  // Best boost capture level achievable on the current track ("high" -> "high720"
  // -> "standard"); ratchets down on a failed applyConstraints, resets on
  // (re)start / switch. `appliedCaptureLevel` is what's live; `captureGeneration`
  // bumps so a stale queued apply bails.
  let cameraBoostCapLevel = "high";
  let appliedCaptureLevel = "standard";
  let captureGeneration = 0;
  let captureQueue = Promise.resolve();

  /** Peers who've opted out of receiving video (we stop sending camera to them). */
  const peerVideoOptOut = new Set();
  // Last transport classification we reported to the server per peer, so we only
  // send a stats `transport` report when a pair's classification actually
  // changes (the server also dedups). See .cursor/plans/stats-poc.md.
  /** @type {Map<string, "direct"|"relay"|"unknown">} */
  const lastTransport = new Map();
  // Remote peers we've added to the room (mesh peer + tile + presence). The single
  // source of truth for "was this peer actually here?" so removeParticipant chimes
  // exactly once and teardown can sweep everyone.
  const participants = new Set();
  // Persistent preference (see VIDEO_OPT_OUT_KEY): survives room switches +
  // reloads, re-applied on each join.
  let myVideoOptOut = readVideoOptOutPref();

  // "Stör ej" (Do Not Disturb): we stay in the room but exchange no media in
  // either direction. A per-session state (like mute, NOT a persistent pref):
  // re-announced across a reconnect, restored across a deploy, reset on leave.
  let myDnd = false;
  // The mute state to return to when DND is lifted. DND fully stops the mic
  // capture (so no OS "recording" indicator lingers — the whole point of the
  // "I've stepped away" mode), so there's no live track to carry mute on; we
  // snapshot the pre-DND mute state and re-apply it when the mic is re-acquired.
  let dndReturnMuted = false;
  /** Peers who are themselves in DND — we send them nothing + show a moon badge. */
  const peerDnd = new Set();

  // Bumped on every lifecycle action that supersedes an in-flight join
  // (leaveToLanding, and each new join). `join()` captures it before awaiting
  // getUserMedia; if it changed while the mic prompt was open (the user pressed
  // Back / navigated away), the resolved join bails and stops the captured
  // stream instead of opening a live room/mic behind the now-visible landing.
  let sessionGen = 0;

  // Viewers I've told to pause the video they send me (I'm fullscreen on someone
  // else and hide them). Mirrors signaledCameraFocus's "only emit on change".
  let signaledSuppress = new Set();
  // Peers who asked *me* to pause my outbound video to them (owner side).
  const suppressViewers = new Set();
  /** Peers currently viewing *my* camera enlarged (boosted quality recipients). */
  const cameraFocusers = new Set();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} Post-unfocus hold timers. */
  const focusHoldTimers = new Map();
  // True from the moment we announce camera-on until startLocalCamera settles
  // (success or failure). Lets an early `camera-focus` survive the getUserMedia
  // gap — without this, a viewer who focuses as soon as presence lands can be
  // dropped and never boost until they toggle focus again.
  let cameraStarting = false;
  // True while recoverLostCamera is re-capturing after a device loss. Prevents a
  // second overlapping recapture (reentrancy guard mirroring cameraStarting).
  let cameraRecovering = false;
  /** The peer whose camera *I* am focusing, as last signaled (null = none). */
  let signaledCameraFocus = null;
  /** @type {import("./session-restore.js").DeployRestoreSnapshot | null} */
  let pendingRestore = null;
  let reconnectHoldTimer = null;

  // The effective ICE servers (STUN base + any server-contributed TURN). Set
  // from `welcome` and rolled by the `ice-refresh` timer below.
  let effectiveIceServers = ICE_SERVERS;
  /** @type {ReturnType<typeof setInterval> | null} */
  let iceRefreshTimer = null;

  function clearIceRefresh() {
    if (iceRefreshTimer) clearInterval(iceRefreshTimer);
    iceRefreshTimer = null;
  }

  // Roll TURN credentials before they expire: ask the server for a fresh set on
  // a fixed cadence (half the TTL — see server.js). No-op when the server sent
  // no cadence (TURN unconfigured). Re-armed from each welcome / refresh reply.
  function scheduleIceRefresh(refreshMs) {
    clearIceRefresh();
    const ms = Number(refreshMs) || 0;
    if (!ms) return;
    iceRefreshTimer = setInterval(() => signaling?.iceRefresh(), ms);
  }

  function clearReconnectHold() {
    if (reconnectHoldTimer) clearTimeout(reconnectHoldTimer);
    reconnectHoldTimer = null;
  }

  function beginReconnectHold() {
    if (reconnectHoldTimer) return;
    reconnectHoldTimer = setTimeout(() => {
      reconnectHoldTimer = null;
      teardownRoom();
    }, reconnectHoldMs);
  }

  function captureDeployRestoreState() {
    const track = localStream?.getAudioTracks()[0];
    return {
      buildVersion: clientBuildVersion,
      roomPath: pathForRoom(currentRoom),
      name: myName,
      muted: track ? !track.enabled : false,
      videoOptOut: myVideoOptOut,
      dnd: myDnd,
      cameraOn: !!localCameraStream,
      screenOn: !!localScreenStream,
      // No device ids here: the picks live in localStorage, which survives the
      // deploy reload, so the restored session resolves them the same way a cold
      // load does. Snapshotting a device would only risk pinning a temporary
      // fallback as if it were a choice. (The fields stay in the snapshot schema
      // as null so older snapshots still validate.)
    };
  }

  function handleDeployVersionMismatch() {
    clearReconnectHold();
    if (writeDeployRestoreSnapshot(captureDeployRestoreState(), restoreStorage)) {
      reload();
      return;
    }
    signaling?.leave();
    signaling?.close();
    teardownRoom();
    ui.setRestoreFailed?.(
      "Kunde inte återställa efter uppdatering — gå med igen",
    );
  }

  // Drop signaling session state but keep local capture streams (mic/camera/screen).
  // Used when the same build reconnects after a brief WS drop during deploy.
  function teardownSessionKeepMedia() {
    clearIceRefresh();
    ui.stopBandwidthMeter();
    ui.teardownFullscreen();
    lastTransport.clear();
    suppressViewers.clear();
    signaledSuppress.clear();
    // Who *else* is in DND is rebuilt from the next welcome roster; our own DND
    // (myDnd) is kept so it survives the reconnect.
    peerDnd.clear();
    for (const id of [...participants]) removeParticipant(id);
    mesh?.close();
    mesh = null;
    ui.removeSelfTile();
    cameraFocusers.clear();
    clearAllFocusHolds();
    signaledCameraFocus = null;
    myId = null;
    stage.reset();
    ui.clearBlockedAudio();
    ui.setRoomControlsEnabled(false);
    applyFocusView();
  }

  async function applyPendingRestore() {
    const snap = pendingRestore;
    pendingRestore = null;
    if (!snap) return;

    clearSessionRestore(restoreStorage);

    if (snap.muted) {
      const track = localStream?.getAudioTracks()[0];
      if (track?.enabled) toggleMute();
    }

    if (snap.videoOptOut && !myVideoOptOut) {
      toggleVideoOptOut();
    }

    if (snap.cameraOn && !myVideoOptOut) {
      await startLocalCamera();
      if (localCameraStream) signaling?.camera(true);
    }

    if (snap.screenOn && media.canShareScreen) {
      await startShare();
    }

    // Restore DND last: entering it stops all capture again. When DND was active
    // at snapshot time cameraOn/screenOn were false, so the blocks above no-op.
    if (snap.dnd && !myDnd) {
      enterDnd();
    }

    ui.setStatus("ansluten", true);
    ui.showUpgradeRestoredToast?.();
  }

  function processWelcome(msg) {
    myId = msg.id;
    stage.setSelfId(myId);
    stage.setSelfVideoOptOut(myVideoOptOut);
    // Adopt the server's TURN servers (if any) before the mesh is built, and
    // start rolling credential refresh so a long session never expires.
    effectiveIceServers = mergeIceServers(msg.iceServers);
    scheduleIceRefresh(msg.iceRefreshMs);
    createRoomMesh();
    // Self-meter taps post-processing so it mirrors what peers actually hear.
    ui.addSelfTile(myId, myName, processedAudioStream());
    ui.setRoomControlsEnabled(true, { videoOptOut: myVideoOptOut });
    // Reflect the persisted video-opt-out preference on the toggle label (the
    // pref can carry over from a previous room session / reload).
    ui.setVideoOptOutUi(myVideoOptOut);
    // Re-assert our own DND presentation (button + moon + local gate) — it
    // survives a reconnect within the same page session.
    ui.setDndUi(myDnd);
    for (const p of msg.peers) addParticipant(p.id, p.name);
    for (const id of msg.cameras || []) {
      handleCamera(id, true, /*skipStart*/ true);
    }
    for (const id of msg.muted || []) handleMute(id, true);
    for (const id of msg.dnd || []) handleDnd(id, true, { chime: false });
    for (const id of msg.videoOptOuts || []) handleVideoOptOut(id, true);
    if (msg.sharer) handleSharer(msg.sharer.id, msg.sharer.name);
    else applyFocusView();
    if (myVideoOptOut) signaling.videoOptOut(true);
    // Re-announce our own mute so it survives a reconnect / deploy-restore: the
    // mic track (and its mute state) is kept across reconnects, but the new
    // server session starts with no mute presence for us.
    const micTrack = localStream?.getAudioTracks()[0];
    if (micTrack && !micTrack.enabled) signaling.mute(true);
    // Same for DND: the mesh state is re-asserted in createRoomMesh, but the new
    // server session has no DND presence for us until we re-announce it.
    if (myDnd) signaling.dnd(true);
    // Tell the view we've (re)joined + how many others are here, so it can record
    // room history and decide the one-time "share the link" onboarding.
    ui.onPresence?.(participants.size, { joined: true });
  }

  // After a same-build reconnect we keep local capture streams alive but rebuild
  // mesh/signaling — re-attach and re-announce so camera/screen resume sending.
  function reattachKeptLocalMedia() {
    if (!mesh) return;
    if (localCameraStream && !myVideoOptOut) {
      mesh.setLocalCameraStream(localCameraStream, { sendTo: cameraSendToFilter });
      ui.setCameraButton(true);
      signaling?.camera(true);
      applyCameraDistribution();
    }
    if (localScreenStream) {
      mesh.setLocalScreenStream(localScreenStream);
      ui.setShareButton(true);
      signaling?.share(true);
      stage.setSharer(myId);
    }
    if (localCameraStream || localScreenStream) {
      ui.setLocalVideo({ camera: localCameraStream, screen: localScreenStream });
      applyFocusView();
    }
  }

  function activeMicId() {
    return localStream?.getAudioTracks()[0]?.getSettings().deviceId || null;
  }

  function activeCameraId() {
    return localCameraStream?.getVideoTracks()[0]?.getSettings().deviceId || null;
  }

  const STACK_KEYS = {
    mic: MIC_STACK_KEY,
    camera: CAMERA_STACK_KEY,
    speaker: SPEAKER_STACK_KEY,
  };

  /** Stack kind -> the `MediaDeviceInfo.kind` its entries describe. */
  const RAW_DEVICE_KIND = {
    mic: "audioinput",
    camera: "videoinput",
    speaker: "audiooutput",
  };

  /**
   * Record an explicit user pick. The ONLY write path into a stack — called from
   * switchMicrophone / switchCamera / switchSpeaker and nowhere else. Pushing is
   * unconditional: picking the device that is *already live* still has to become
   * the top pick, or the user has no way to overrule a higher entry that is
   * merely away (which is the whole point of separating intent from active).
   */
  function pushDevicePick(kind, uiValue) {
    const device = lastRawDevices.find((d) => d.deviceId === uiValue) || null;
    const entry = entryFromValue(kind, uiValue, device);
    if (!isSystemEntry(entry) && !entry.deviceId) return;
    if (device?.groupId) sessionGroupIds.set(entryKey(kind, entry), device.groupId);
    // A fresh pick is a fresh verdict on usability: retry it even if it failed
    // to open earlier in this session.
    if (!isSystemEntry(entry)) unusableDevices.delete(deviceKey(kind, entry.deviceId));
    stacks[kind] = pushPick(stacks[kind], entry);
    saveStack(STACK_KEYS[kind], stacks[kind]);
  }

  /** Pure read: which entry should be live, given what's plugged in right now. */
  function resolveDesired(kind, devices) {
    return resolveStack(stacks[kind], devices, {
      groupIdFor: (entry) => sessionGroupIds.get(entryKey(kind, entry)) || "",
      isUnusable: (device) => unusableDevices.has(deviceKey(kind, device.deviceId)),
    });
  }

  /**
   * The device id capture should pin to right now: the stack's winner against
   * the latest enumeration, so an absent or unopenable pick is skipped before we
   * ask for it rather than after a failed capture has already put a fallback on
   * the wire. Before the first enumeration (a cold join, where device ids aren't
   * exposed until a permission has been granted) there is nothing to resolve
   * against, so the raw top pick is still the best guess.
   */
  function pinnedIdFor(kind) {
    const devices = lastRawDevices.filter(
      (d) => d.kind === RAW_DEVICE_KIND[kind] && isSelectableDevice(d),
    );
    if (devices.length) {
      const desired = resolveDesired(kind, devices);
      return desired && !isSystemEntry(desired.entry) ? desired.device.deviceId : null;
    }
    const top = stacks[kind][0];
    return top && !isSystemEntry(top) ? top.deviceId : null;
  }

  function deviceKey(kind, deviceId) {
    return `${kind}:${deviceId}`;
  }

  function markUnusable(kind, deviceId) {
    if (deviceId) unusableDevices.add(deviceKey(kind, deviceId));
  }

  /**
   * A device that leaves and re-enters the enumeration gets a clean slate: it was
   * probably unplugged and replugged, so a previous "busy" verdict is stale.
   */
  function refreshUnusableEntries(kind, devices) {
    const seen = new Set(devices.map((d) => d.deviceId));
    const previous = lastSeenDeviceIds.get(kind);
    if (previous) {
      for (const id of seen) {
        if (!previous.has(id)) unusableDevices.delete(deviceKey(kind, id));
      }
    }
    lastSeenDeviceIds.set(kind, seen);
    // Learn groupIds for entries that are present, so a later replug in this
    // same page load can be matched after the deviceId churns.
    for (const entry of stacks[kind]) {
      if (isSystemEntry(entry)) continue;
      const live = devices.find((d) => d.deviceId === entry.deviceId);
      if (live?.groupId) sessionGroupIds.set(entryKey(kind, entry), live.groupId);
    }
  }

  /**
   * What the mic `<select>` should show. Systemstandard when that is the winning
   * entry (the OS hands us a concrete device, but the *intent* is "follow the
   * OS", and those are different picks), and otherwise the live device — falling
   * back to Systemstandard rather than naming a device that isn't live.
   */
  function micIdForPopulate(mics) {
    const desired = resolveDesired("mic", mics);
    if (!desired || isSystemEntry(desired.entry)) return SYSTEM_VALUE.mic;
    const active = activeMicId();
    return active && mics.some((d) => d.deviceId === active) ? active : SYSTEM_VALUE.mic;
  }

  // Camera off: show where the stack currently points, so the picker previews
  // what would come up. `populateDeviceSelect` snaps to the first camera if that
  // device isn't here.
  function camIdForPopulate(cams) {
    const active = activeCameraId();
    if (active) return active;
    const resolved = resolveDesired("camera", cams);
    return resolved?.device?.deviceId || "";
  }

  function currentMicMuted() {
    const track = localStream?.getAudioTracks()[0];
    return !!track && !track.enabled;
  }

  // The stream the mesh + self-meter consume: the pipeline's processed output, or
  // the raw mic if the pipeline degraded to pass-through (fail-open).
  function processedAudioStream() {
    return micPipeline?.getStream() || localStream;
  }

  // The pipeline gave up (suspended context / unbuildable graph) and is now
  // shipping the raw mic instead of silence. Re-point the mesh + self-meter at
  // the raw stream and re-apply the live mute state.
  function handleMicPipelineFallback(stream) {
    if (mesh) {
      mesh.setLocalAudioStream(stream);
      mesh.setLocalAudioMuted(currentMicMuted());
    }
    ui.setSelfMicMeter(stream);
  }

  // Build the mic pipeline once the raw stream exists (created at join, reused
  // across reconnects since the mic persists). Carries the current level + mute.
  function ensureMicPipeline() {
    if (micPipeline || !localStream) return;
    micPipeline = createMicPipeline(localStream, {
      level: noiseLevel,
      onFallback: handleMicPipelineFallback,
    });
    micPipeline.setMuted(currentMicMuted());
  }

  // --- Camera quality & focus-aware distribution ---------------------------
  // There is no user-facing quality setting: standard is sent to everyone, while
  // `high` (1080p, capability-fallback to 720p) is delivered only to peers who
  // have our camera enlarged on their stage. We also only capture above standard
  // while at least one viewer (or our own enlarged self-view) needs it.
  function currentBoostLevel() {
    return cameraBoostCapLevel;
  }

  function nextBoostLevel(level) {
    const i = CAMERA_BOOST_CHAIN.indexOf(level);
    if (i === -1) return null;
    return CAMERA_BOOST_CHAIN[i + 1] ?? "standard";
  }

  async function applyCameraCaptureSettingsForLevel(level) {
    const track = localCameraStream?.getVideoTracks()[0];
    if (!track) return false;
    const preset = getCameraQualityPreset(level);
    try {
      await track.applyConstraints(preset.capture);
      track.contentHint = preset.contentHint;
      return true;
    } catch {
      return false;
    }
  }

  // Peers that should currently receive the boosted (focus) quality: those
  // actively focusing our camera plus any still inside the post-unfocus hold.
  function boostedCameraPeers() {
    return new Set([...cameraFocusers, ...focusHoldTimers.keys()]);
  }

  // Single source of truth: recompute capture resolution and per-peer send
  // bitrate from the current focusers. Idempotent and safe to call on any focus /
  // peer / self-focus change.
  function applyCameraDistribution() {
    if (!localCameraStream || !mesh) return;
    const focusers = boostedCameraPeers();
    // Only a focuser on a direct P2P link (or STUN-only unknown fallback) may pull
    // HD capture; relayed / unclassified relay pairs are capped in the mesh.
    const eligibleFocusers = [...focusers].filter((id) =>
      mesh.isCameraBoostEligible(id),
    );
    const selfWantsHigh = stage.view().selfCameraEnlarged;
    const wantHigh = eligibleFocusers.length > 0 || selfWantsHigh;
    const captureLevel = wantHigh ? currentBoostLevel() : "standard";
    ensureCaptureLevel(captureLevel);
    // Bitrate: when we want HD but capture ratcheted to standard (webcam can't
    // reach 1080p/720p), still send the higher encode cap to eligible focusers.
    const bitrateLevel = !wantHigh
      ? "standard"
      : captureLevel !== "standard"
        ? captureLevel
        : "high720";
    const boosting = wantHigh && focusers.size > 0;
    mesh.setCameraBitratePolicy({
      boosted: boosting ? focusers : new Set(),
      boostedBitrate: getCameraMaxBitrate(bitrateLevel),
      defaultBitrate: getCameraMaxBitrate("standard"),
    });
  }

  // Apply a capture level to the local track, serialized + generation-guarded so
  // rapid focus toggles (or a camera stop) can't land a stale applyConstraints.
  function ensureCaptureLevel(level) {
    if (!localCameraStream || level === appliedCaptureLevel) return;
    const gen = ++captureGeneration;
    captureQueue = captureQueue
      .then(() => runCaptureApply(level, gen))
      .catch(() => runCaptureApply(level, gen));
  }

  async function runCaptureApply(level, gen) {
    if (gen !== captureGeneration || !localCameraStream) return;
    if (level === appliedCaptureLevel) return;
    const ok = await applyCameraCaptureSettingsForLevel(level);
    if (gen !== captureGeneration) return;
    if (ok) {
      appliedCaptureLevel = level;
      return;
    }
    // The track can't reach this capture level. Ratchet the boost cap down one
    // step (high -> high720 -> standard) and re-run distribution so we request the
    // next-best level (or settle to standard for everyone) instead of re-probing
    // the unattainable level on every later focus change.
    const next = nextBoostLevel(level);
    if (next && next !== cameraBoostCapLevel) {
      cameraBoostCapLevel = next;
      applyCameraDistribution();
    }
  }

  // --- Camera focus (incoming): who is viewing *my* camera enlarged --------
  function handleCameraFocus(id, on) {
    // Ignore focus hints while our camera is off and not starting: a `camera-focus`
    // can land just after stopLocalCamera() (or during reconnect) and would
    // otherwise recreate focuser/hold state that a later camera start wrongly
    // boosts. During `cameraStarting` we accept hints so a viewer who focuses
    // right when presence lands isn't lost in the getUserMedia gap.
    if (!localCameraStream && !cameraStarting) return;
    if (on) {
      clearFocusHold(id);
      cameraFocusers.add(id);
      // Retry the HD capture ladder when a new focuser arrives — a transient
      // applyConstraints failure can ratchet the cap to standard for the rest of
      // the session even though the camera can reach HD on a later attempt.
      cameraBoostCapLevel = "high";
    } else {
      cameraFocusers.delete(id);
      startFocusHold(id);
    }
    applyCameraDistribution();
    if (on && mesh?.refreshTransport) {
      void mesh.refreshTransport().then(() => applyCameraDistribution());
    }
  }

  function startFocusHold(id) {
    clearFocusHold(id);
    focusHoldTimers.set(
      id,
      setTimeout(() => {
        focusHoldTimers.delete(id);
        applyCameraDistribution();
      }, CAMERA_FOCUS_HOLD_MS),
    );
  }

  function clearFocusHold(id) {
    const t = focusHoldTimers.get(id);
    if (t) {
      clearTimeout(t);
      focusHoldTimers.delete(id);
    }
  }

  function clearAllFocusHolds() {
    for (const t of focusHoldTimers.values()) clearTimeout(t);
    focusHoldTimers.clear();
  }

  // --- Camera focus (outgoing): tell the owner I'm viewing their camera ----
  // Driven from applyFocusView so it stays in sync with the stage. Only camera
  // focus is signaled (screen focus needs no bitrate hint). The owner relies on
  // the on/off transitions, so we only emit when the target actually changes.
  function reconcileCameraFocusSignal(view) {
    const target = view.cameraFocusTarget;
    if (target === signaledCameraFocus) return;
    // Don't advance signaledCameraFocus unless we can actually send: otherwise a
    // toggle during a closed/reconnecting socket would be recorded as "sent" and
    // never retried, leaving the owner with stale focus state. applyFocusView runs
    // again on welcome/other events, which reconciles once the socket is open.
    if (!signaling?.isOpen()) return;
    if (signaledCameraFocus) signaling.cameraFocus(signaledCameraFocus, false);
    if (target) signaling.cameraFocus(target, true);
    signaledCameraFocus = target;
  }

  // --- Video suppression: pause inbound video hidden by fullscreen ---------
  // Viewer side: while pinned to one peer, tell every *other* sender to pause the
  // camera/screen they send me (I'm hiding them anyway) to save inbound
  // bandwidth. Reconciled from applyFocusView; only emits on change, and only
  // when the socket is open (re-runs on welcome/other events otherwise).
  function reconcileVideoSuppression(view) {
    const want = view.suppressPeers;
    if (!signaling?.isOpen()) return;
    for (const id of signaledSuppress) {
      if (!want.has(id)) signaling.videoSuppress(id, false);
    }
    for (const id of want) {
      if (!signaledSuppress.has(id)) signaling.videoSuppress(id, true);
    }
    // Clone: `want` is the StageView's own Set, but signaledSuppress is long-lived
    // controller state that gets mutated (removeParticipant / teardownRoom). Keep
    // the view's collection immutable from the controller's side.
    signaledSuppress = new Set(want);
  }

  // Owner side: a viewer asked me to pause / resume my outbound video to them.
  function handleVideoSuppress(id, on) {
    if (on) suppressViewers.add(id);
    else suppressViewers.delete(id);
    mesh?.setVideoPausedPeers(suppressViewers);
  }

  function cameraSendToFilter(peerId) {
    return !peerVideoOptOut.has(peerId);
  }

  // --- Mesh lifecycle ------------------------------------------------------
  function createRoomMesh() {
    mesh = createMesh({
      myId,
      iceServers: effectiveIceServers,
      sendSignal: (to, data) => signaling.signal(to, data),
      onAudioTrack: (peerId, stream) => ui.setPeerAudio(peerId, stream),
      onPeerVideoChanged: (peerId) => reclassifyPeerVideoTracks(peerId),
      onConnectionState: (peerId, state) => {
        ui.setPeerUncertain(peerId, state === "uncertain");
        ui.setPeerConnecting(peerId, state === "connecting" || state === "new");
      },
      onPeerFailed: (peerId) => {
        // The WebRTC link failed for good, so the peer disappears from the room.
        // This is the "tappar kontakten" path; chime once (deduped via the return
        // value, so a following server `peer-left` stays silent). A merely
        // "uncertain" peer never reaches here — that state is intentionally silent
        // until they actually leave.
        if (removeParticipant(peerId)) ui.playLeaveSound();
      },
      // A peer's transport (direct/relay/unknown) changed: repaint the relay
      // indicator and recompute camera distribution (capture-resolution boost is
      // gated on having a *direct* focuser — a focuser that just went relay must
      // stop forcing 1080p capture).
      onRelayChanged: () => {
        for (const id of participants) ui.setPeerRelayed(id, mesh.isRelayed(id));
        applyCameraDistribution();
      },
      // The mesh-owned stats sampler feeds the live bandwidth meter (same sample
      // that drives relay detection — one poll, two consumers) and the usage-stats
      // transport report (per-pair direct/relay classification on change).
      onStats: (entries) => {
        ui.pushPeerStats(entries);
        reportTransport(entries);
      },
      // A STUN/TURN server refused or never answered. This is the one fact that
      // explains a pair which never connects at all (see the initial-connect
      // watchdog in mesh.js), so make it impossible to miss: the browser
      // console for whoever is affected, the diagnostics rail in the UI, and
      // the server's usage log so an operator can see it without the reporter
      // having to open devtools.
      onIceServerError: (peerId, error) => {
        console.warn(`[babbla] ${error.hint} (${error.url})`);
        ui.setIceServerError?.(peerId, error);
        signaling?.iceError(error);
      },
    });
    // The mesh sends the PROCESSED stream (HPF + expander), never the raw mic.
    mesh.setLocalAudioStream(processedAudioStream());
    // Carry the mute state into a freshly (re)built mesh so peers added by the
    // following `welcome` don't start streaming audio while the user is muted.
    mesh.setLocalAudioMuted(currentMicMuted());
    micPipeline?.setMuted(currentMicMuted());
    // Carry our own DND across a reconnect: the mesh is rebuilt fresh, so re-assert
    // "send nothing to anyone" before `welcome` attaches peers. (peerDnd — who else
    // is in DND — is rebuilt from the welcome roster via handleDnd.)
    if (myDnd) mesh.setLocalDndActive(true);
    // Tell the view whether a relay is even on offer, so "peer stuck on
    // ansluter" can be told apart from "this deployment is STUN-only" without
    // shell access to the server.
    ui.setRelayAvailable?.(mesh.isTurnConfigured());
    ui.startBandwidthMeter();
    mesh.startStatsSampler();
  }

  // Report each pair's transport (direct/relay) to the server for usage stats,
  // but only when it changes (the server dedups too). The initial "unknown"
  // (a not-yet-connected pair) is skipped — we only report it later if a
  // connected pair drops back to unknown.
  function reportTransport(entries) {
    if (!signaling?.isOpen()) return;
    for (const e of entries) {
      const cls = e.transport || "unknown";
      const prev = lastTransport.get(e.peerId);
      if (cls === prev) continue;
      if (cls === "unknown" && prev === undefined) continue;
      lastTransport.set(e.peerId, cls);
      signaling.transport(
        e.peerId,
        cls,
        e.localCandidateType ?? null,
        e.remoteCandidateType ?? null,
      );
    }
  }

  function addParticipant(id, name) {
    participants.add(id);
    mesh.addPeer(id, name);
    stage.peerJoined(id);
    ui.addTile(id, name);
  }

  // Returns true only when a peer was actually present and got removed, so callers
  // can chime exactly once on a real departure (the same removal can be reached
  // from both the server's `peer-left` and a local `onPeerFailed`).
  function removeParticipant(id) {
    if (!participants.delete(id)) return false;
    // View-side teardown (audio element, meters, display streams, tiles).
    ui.removePeerMedia(id);
    mesh?.removePeer(id);
    peerVideoOptOut.delete(id);
    peerDnd.delete(id);
    lastTransport.delete(id);
    // A departing peer can't keep boosting our camera quality.
    cameraFocusers.delete(id);
    clearFocusHold(id);
    // Drop the gone peer from both sides of suppression: as a viewer (no need to
    // send an "off" to someone who left) and as an owner (stop pausing to them).
    signaledSuppress.delete(id);
    if (suppressViewers.delete(id)) mesh?.setVideoPausedPeers(suppressViewers);
    // Drops the peer from the roster + presence and self-heals any focus/pin that
    // pointed at them (sharer cleared too if they were sharing).
    stage.peerLeft(id);
    applyFocusView();
    return true;
  }

  // Re-derive which received video track to show as camera vs screen. The mesh
  // resolves role->track from its in-band mid->role map (getPeerVideo); here we
  // only gate that on the authoritative presence state (which sharer / who has a
  // camera on). Presence is updated *before* this runs (handleCamera/handleSharer),
  // so a "camera off" clears the tile at once instead of leaving the last decoded
  // frame frozen until renegotiation drops the track.
  function reclassifyPeerVideoTracks(peerId) {
    if (!mesh) return;
    const { cameraTrack, screenTrack } = mesh.getPeerVideo(peerId);
    const screen = stage.getSharerId() === peerId ? screenTrack : null;
    const camera = stage.hasCamera(peerId) ? cameraTrack : null;
    ui.setPeerVideo(peerId, { cameraTrack: camera, screenTrack: screen });
    applyFocusView();
  }

  // This client's own public IP, discovered via a STUN (srflx) probe and reported
  // to the server with `join` (stats-only) so it can resolve an ASN even when a
  // proxy/NAT hid the real source IP from the server — e.g. Docker Desktop for
  // macOS SNATs ingress to its VM gateway, so the server's X-Forwarded-For never
  // carries the real client IP. The probe is memoized per session: join() resets
  // it so every user-initiated join (new room / leave→rejoin / room switch)
  // re-probes the *current* network, while reconnects within a session reuse the
  // cached value (the session's ASN is fixed at its first join). join() awaits it
  // before connect(), so the join we send carries the resolved IP; it's null only
  // when no srflx was found (STUN blocked), and the server then logs asn: null.
  let publicIp = null;
  /** @type {Promise<string|null> | null} */
  let publicIpProbe = null;
  function probePublicIp() {
    if (!publicIpProbe) {
      publicIpProbe = discoverPublicIp({ iceServers: ICE_SERVERS })
        .then((ip) => (publicIp = ip))
        .catch(() => null);
    }
    return publicIpProbe;
  }

  // --- Signaling -----------------------------------------------------------
  // Create the transport and wire its lifecycle. The module owns socket +
  // reconnect/backoff; we just (re)join on every open, route inbound to the
  // dispatch switch, and tear the room down on an unexpected drop so a fresh
  // `welcome` rebuilds it. The mic/mute state is preserved across reconnects (the
  // page never reloads); camera/screen reset and can be re-enabled.
  function connect() {
    signaling = createSignaling({
      url: urlForRoom(currentRoom),
      onOpen() {
        ui.setStatus("ansluten", true);
        // `publicIp` was resolved before connect() (join() awaits the probe), so
        // the initial join carries it; on reconnect we reuse that same value (the
        // session's ASN is fixed at its first join). null only when STUN found no
        // srflx, in which case the server records asn: null.
        signaling.join(myName, clientId, publicIp);
      },
      onMessage: handleServerMessage,
      onReconnecting() {
        if (myId) {
          beginReconnectHold();
          ui.setStatus("återansluter…");
          ui.setRoomControlsEnabled(false, { videoOptOut: myVideoOptOut });
          return { immediate: true };
        }
        teardownRoom();
        ui.setStatus("återansluter…");
      },
    });
  }

  async function handleServerMessage(msg) {
    switch (msg.type) {
      case MSG.WELCOME:
        if (
          msg.buildVersion &&
          clientBuildVersion &&
          msg.buildVersion !== clientBuildVersion
        ) {
          handleDeployVersionMismatch();
          break;
        }
        clearReconnectHold();
        if (mesh) teardownSessionKeepMedia();
        processWelcome(msg);
        reattachKeptLocalMedia();
        await applyPendingRestore();
        break;
      case MSG.PEER_JOINED:
        addParticipant(msg.id, msg.name);
        applyFocusView();
        ui.playJoinSound();
        ui.onPresence?.(participants.size);
        break;
      case MSG.SIGNAL:
        if (!mesh) break;
        await mesh.handleSignal(msg.from, msg.data);
        break;
      case MSG.PEER_LEFT:
        // A real departure (manual leave or server heartbeat timeout) — chime
        // once. The guard inside removeParticipant means a peer already dropped
        // locally via onPeerFailed won't double-chime here.
        if (removeParticipant(msg.id)) ui.playLeaveSound();
        ui.onPresence?.(participants.size);
        break;
      case MSG.SHARER:
        handleSharer(msg.id, msg.name);
        break;
      case MSG.MUTE:
        handleMute(msg.id, msg.on);
        break;
      case MSG.DND:
        handleDnd(msg.id, msg.on);
        break;
      case MSG.CAMERA:
        handleCamera(msg.id, msg.on);
        break;
      case MSG.CAMERA_LIMIT:
        handleCameraLimit();
        break;
      case MSG.VIDEO_OPT_OUT:
        handleVideoOptOut(msg.id, msg.on);
        break;
      case MSG.CAMERA_FOCUS:
        handleCameraFocus(msg.id, msg.on);
        break;
      case MSG.VIDEO_SUPPRESS:
        handleVideoSuppress(msg.id, msg.on);
        break;
      case MSG.ICE_REFRESH:
        // Fresh TURN credentials: swap them onto every connection and, since an
        // established relay allocation keeps using the old creds, proactively
        // restart ICE on relayed/unknown peers while the old creds are still
        // valid (staggered in the mesh). Re-arm the refresh timer.
        if (!mesh) break;
        effectiveIceServers = mergeIceServers(msg.iceServers);
        mesh.setIceServers(effectiveIceServers, { restartRelayed: true });
        scheduleIceRefresh(msg.iceRefreshMs);
        break;
    }
  }

  // Drop all room state so a reconnect can rebuild from a clean `welcome`. The
  // mic stream (and its mute state) is kept alive — the page never reloaded, so
  // re-acquiring it is unnecessary. Camera/screen are stopped and must be
  // re-enabled by the user after a reconnect.
  function teardownRoom() {
    clearReconnectHold();
    clearIceRefresh();
    ui.stopBandwidthMeter();
    ui.teardownFullscreen();
    lastTransport.clear();
    suppressViewers.clear();
    signaledSuppress.clear();
    peerDnd.clear();
    for (const id of [...participants]) removeParticipant(id);
    // removeParticipant only reaches peers we added; sweep any extra connections
    // the mesh created from incoming signals so none leak across reconnects before
    // we drop the reference below.
    mesh?.close();

    ui.removeSelfTile();

    if (localScreenStream) {
      localScreenStream.getTracks().forEach((t) => t.stop());
      localScreenStream = null;
      ui.setShareButton(false);
    }
    if (localCameraStream) {
      localCameraStream.getTracks().forEach((t) => t.stop());
      localCameraStream = null;
      captureGeneration++;
      appliedCaptureLevel = "standard";
      cameraBoostCapLevel = "high";
      ui.setCameraButton(false);
    }
    ui.setLocalVideo({ camera: null, screen: null });
    cameraFocusers.clear();
    clearAllFocusHolds();
    signaledCameraFocus = null;

    mesh = null;
    myId = null;
    // Clears presence + focus + pin (and the roster) so a fresh `welcome`
    // rebuilds from clean state.
    stage.reset();
    ui.clearBlockedAudio();
    ui.setRoomControlsEnabled(false);
    applyFocusView();
  }

  // --- Device selection (mic / camera) -------------------------------------
  async function refreshDeviceList() {
    let devices;
    try {
      devices = await media.enumerateDevices();
    } catch {
      return;
    }
    lastRawDevices = devices;
    const mics = devices.filter((d) => d.kind === "audioinput" && isSelectableDevice(d));
    const cams = devices.filter((d) => d.kind === "videoinput" && isSelectableDevice(d));
    const speakers = devices.filter((d) => d.kind === "audiooutput" && isSelectableDevice(d));
    refreshUnusableEntries("mic", mics);
    refreshUnusableEntries("camera", cams);
    refreshUnusableEntries("speaker", speakers);
    if (!reconcilingDevices) {
      reconcilingDevices = true;
      try {
        await reconcileDevices(devices, mics, cams, speakers);
      } finally {
        reconcilingDevices = false;
      }
    }
    const activeMic = activeMicId();
    const firstMicLabel = mics.find((d) => d.label)?.label || mics[0]?.label || null;
    const activeMicLabel =
      mics.find((d) => d.deviceId === activeMic)?.label || null;
    const micDefaultName =
      resolveSystemDefaultName(devices, "audioinput") ||
      firstMicLabel ||
      activeMicLabel ||
      null;
    const speakerDefaultName =
      resolveSystemDefaultName(devices, "audiooutput") ||
      speakers.find((d) => d.label)?.label ||
      speakers[0]?.label ||
      null;
    ui.populateDevices({
      mics,
      cams,
      speakers,
      micId: micIdForPopulate(mics),
      camId: camIdForPopulate(cams),
      micDefaultName,
      speakerDefaultName,
      hasMicDefault: hasSystemDefaultDevice(devices, "audioinput"),
    });
  }

  /**
   * Bring the live devices in line with the stacks.
   *
   * Keyed on *the resolved winner differing from what is live*, never on "the
   * device list changed". That makes it idempotent, which is what lets it be
   * called from anywhere — the `devicechange` listener, a join, a lost track, or
   * merely opening a picker — without a taxonomy of trigger sites to get right.
   * When nothing moved, every branch below is a no-op.
   */
  async function reconcileDevices(rawDevices, mics, cams, speakers) {
    await reconcileMic(rawDevices, mics);
    await reconcileCamera(cams);
    await reconcileSpeaker(speakers);
  }

  async function reconcileMic(rawDevices, mics) {
    if (!localStream || myDnd) return;
    // Bounded: every failed attempt marks the device it tried unusable, shrinking
    // the candidate set, so the walk cannot revisit the same device.
    for (;;) {
      const desired = resolveDesired("mic", mics);
      if (!desired) return;
      if (isSystemEntry(desired.entry)) {
        await followSystemDefaultMic(rawDevices);
        return;
      }
      if (activeMicId() === desired.device.deviceId) return;
      // Only a real refusal disqualifies the device: an abandoned capture (DND,
      // leave, a newer capture) says nothing about the hardware.
      if ((await recaptureMic(desired.device.deviceId)) !== "failed") return;
      markUnusable("mic", desired.device.deviceId);
    }
  }

  /**
   * "Systemstandard" is the one entry that is a moving pointer rather than a
   * device, and a track opened on the virtual `default` device does NOT follow a
   * later OS default change — it keeps whatever it was granted. Worse, asking for
   * `default` again while the old track is still live hands back the *same* stale
   * device: the browser only re-resolves the mapping once the track is released.
   * So this is the single place that must stop before it captures.
   */
  async function followSystemDefaultMic(rawDevices) {
    if (!localStream || myDnd) return;
    const settings = localStream.getAudioTracks()[0]?.getSettings();
    // Two reasons to recapture: the live mic is pinned to a device (so it isn't
    // following anything), or it is unconstrained but the OS default moved out
    // from under it. Otherwise this is already the OS default — no-op.
    const drifted = systemDefaultDrifted(settings, rawDevices, "audioinput");
    if (micCaptureUnconstrained && !drifted) return;
    const myGen = sessionGen;
    const previous = localStream;
    const muted = currentMicMuted();
    previous.getAudioTracks().forEach((t) => t.stop());
    let stream = null;
    try {
      stream = await media.getUserMedia(buildAudioConstraints(null, false));
    } catch {
      stream = null;
    }
    if (!stream) {
      // Unconstrained capture failed, so there is no microphone to fall back to
      // and nothing below the sentinel to try. Keep the (now dead) stream as the
      // live one so mute state and the UI stay coherent.
      return;
    }
    if (myGen !== sessionGen || myDnd || localStream !== previous) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    adoptMicStream(stream, { muted, unconstrained: true, stopPrevious: false });
  }

  async function reconcileCamera(cams) {
    // Auto-selection never *starts* capture: a camera coming online must not
    // light someone's camera LED. The stack only decides which device comes up
    // the next time the user turns video on themselves.
    if (!localCameraStream || myVideoOptOut || !mesh) return;
    for (;;) {
      const desired = resolveDesired("camera", cams);
      if (!desired || isSystemEntry(desired.entry)) return;
      if (activeCameraId() === desired.device.deviceId) return;
      // Only a real refusal disqualifies the device: an abandoned capture (video
      // turned off, opt-out, teardown) says nothing about the hardware, and
      // treating it as one would burn every remaining pick on the way out.
      if ((await recaptureCameraExact(desired.device.deviceId)) !== "failed") return;
      markUnusable("camera", desired.device.deviceId);
    }
  }

  async function reconcileSpeaker(speakers) {
    for (;;) {
      const desired = resolveDesired("speaker", speakers);
      const concrete = desired && !isSystemEntry(desired.entry);
      const target = concrete ? desired.device.deviceId : "";
      // Same winner as last time -> nothing to do. Without this the sink would
      // be re-applied on every refresh, including a picker being opened.
      if (target === requestedSinkId) return;
      const ok = await applyAudioOutput(target);
      // `null` means a newer request superseded this one while it was queued —
      // that says nothing about the device, so it must not be disqualified.
      if (ok !== false || !concrete) return;
      markUnusable("speaker", desired.device.deviceId);
    }
  }

  /**
   * Route audio output, one request at a time.
   *
   * The view applies a sink across several `<audio>` elements plus the chime
   * context, so two overlapping requests interleave and the one that finishes
   * last wins the actual routing — which may be the *older* pick, leaving the
   * conversation coming out of the wrong device while the controller believes
   * the newer one took. Serializing makes last-requested equal last-applied, and
   * `requestedSinkId` (the latest intent, not the latest completion) is what the
   * reconcile's no-op gate compares against so a queued change isn't re-requested.
   *
   * @returns {Promise<boolean|null>} whether the sink took, or null if a newer
   *   request superseded this one before it ran.
   */
  function applyAudioOutput(target) {
    requestedSinkId = target;
    const applied = sinkQueue.then(() => {
      // Superseded while queued: the newer request is behind us in the queue and
      // will route instead, so skip rather than audibly flapping through devices.
      if (requestedSinkId !== target) return null;
      return ui.setAudioOutput(target);
    });
    sinkQueue = applied.then(
      () => {},
      () => {},
    );
    return applied;
  }

  function syncDeviceSelectsToActive() {
    ui.syncDeviceSelects({
      micId: micIdForPopulate(
        lastRawDevices.filter((d) => d.kind === "audioinput" && isSelectableDevice(d)),
      ),
      camId: camIdForPopulate(
        lastRawDevices.filter((d) => d.kind === "videoinput" && isSelectableDevice(d)),
      ),
    });
  }

  // Every device switch is the same two steps: record the pick, then let the
  // reconciler work out what that means for the live devices. The switch handlers
  // deliberately do NOT decide whether a recapture is needed — that comparison
  // lives in one place so a picker, a hotplug and a join all behave identically.
  async function switchMicrophone(deviceId) {
    if (!deviceId) return;
    pushDevicePick("mic", deviceId);
    if (isSystemValue("mic", deviceId)) {
      await followSystemDefaultMic(lastRawDevices);
    } else if (deviceId !== activeMicId()) {
      // The pick is listed but won't open (held by another app): remember that
      // for this session so refreshDeviceList's walk moves on instead of
      // hammering the same device on every hotplug.
      if ((await recaptureMic(deviceId)) === "failed") markUnusable("mic", deviceId);
    }
    await refreshDeviceList();
  }

  async function switchSpeaker(deviceId) {
    const value = deviceId || SYSTEM_VALUE.speaker;
    pushDevicePick("speaker", value);
    ui.syncActiveSelection?.({ speakerId: deviceId || "" });
    if ((await applyAudioOutput(deviceId || "")) === false && deviceId) {
      markUnusable("speaker", deviceId);
    }
    await refreshDeviceList();
  }

  /**
   * Open the microphone the stack points at, walking it top-down.
   *
   * Same shape as captureStackedCamera: exact pins (Chrome does not honor an
   * `ideal` deviceId reliably, and an `ideal` pin would silently grant the
   * default mic — two captures on every join), each refusal marks that device
   * unusable so the next round resolves past it, unconstrained as the terminal
   * fallback. Used by every path that opens the mic from scratch — join, DND
   * exit, unplug recovery — so they cannot drift apart on which device comes up.
   *
   * @returns {Promise<{stream: MediaStream, unconstrained: boolean}|null>} null
   *   when no microphone could be opened at all. `unconstrained` records whether
   *   the capture is pinned to a device, which is how the system-default follow
   *   later tells "pinned" from "following the OS".
   */
  async function captureStackedMic() {
    for (;;) {
      const pinned = pinnedIdFor("mic");
      if (!pinned) break;
      try {
        const stream = await media.getUserMedia(buildAudioConstraints(pinned, /*exact*/ true));
        return { stream, unconstrained: false };
      } catch {
        markUnusable("mic", pinned);
        // Without an enumeration the pin is the raw top pick, which marking
        // unusable cannot move — there is nothing further to walk.
        if (!lastRawDevices.length) break;
      }
    }
    try {
      const stream = await media.getUserMedia(buildAudioConstraints(null, false));
      return { stream, unconstrained: true };
    } catch {
      return null;
    }
  }

  /**
   * Capture one microphone and make it the live one.
   *
   * The capture is an async gap the user can act across: entering DND releases
   * the mic on purpose, leaving releases it and shows the landing page, and a
   * competing capture may have already replaced the stream. Adopting a stream
   * that arrives after any of those would re-open the device behind the user's
   * back — lighting the OS mic indicator with nothing on screen to explain it —
   * so a superseded capture is stopped instead.
   *
   * @returns {Promise<"ok"|"failed"|"aborted">} "aborted" is not a verdict on the
   *   device, so callers must not mark it unusable.
   */
  async function recaptureMic(deviceId) {
    const myGen = sessionGen;
    const previous = localStream;
    const superseded = () => myGen !== sessionGen || myDnd || localStream !== previous;
    let stream;
    try {
      stream = await media.getUserMedia(buildAudioConstraints(deviceId));
    } catch {
      return superseded() ? "aborted" : "failed";
    }
    if (superseded()) {
      stream.getTracks().forEach((t) => t.stop());
      return "aborted";
    }
    adoptMicStream(stream, { unconstrained: !deviceId || isSystemValue("mic", deviceId) });
    return "ok";
  }

  function adoptMicStream(
    stream,
    { muted: forcedMuted, unconstrained = false, stopPrevious = true } = {},
  ) {
    const newTrack = stream.getAudioTracks()[0];
    // Carry the mute state over to the new track: the mesh routes mute via
    // replaceTrack(null), and the self meter / toggle read track.enabled.
    // `forcedMuted` / `stopPrevious: false` are for callers that already released
    // the old track (the system-default follow), where the previous enabled state
    // can no longer be read back and stopping again would be a second no-op.
    const muted =
      forcedMuted ?? (!!localStream && localStream.getAudioTracks()[0]?.enabled === false);
    if (newTrack) newTrack.enabled = !muted;
    warnIfAudioProcessingDisabled(stream);

    if (stopPrevious) localStream?.getAudioTracks().forEach((t) => t.stop());
    localStream = stream;
    localStreamGen = sessionGen;
    micCaptureUnconstrained = unconstrained;
    attachMicLossRecovery(newTrack);

    micPipeline?.rebuild(localStream);
    micPipeline?.setMuted(muted);
    mesh?.setLocalAudioStream(processedAudioStream());
    ui.setSelfMicMeter(processedAudioStream());
  }

  function attachMicLossRecovery(track) {
    if (!track?.addEventListener) return;
    track.addEventListener("ended", () => {
      if (!localStream || localStream.getAudioTracks()[0] !== track) return;
      if (myDnd) return;
      recoverLostMic();
    });
  }

  // The active mic device vanished mid-session (unplugged). Get audio back on
  // whatever the stack points at now — the same walk join uses, since there is no
  // live track left to compare a desired device against.
  async function recoverLostMic() {
    if (micRecovering || myDnd || !mesh) return;
    micRecovering = true;
    const myGen = sessionGen;
    try {
      const captured = await captureStackedMic();
      // The captures above are async gaps: DND, a leave or a room switch can
      // land while they run, and adopting then would re-open a mic the user has
      // just released.
      if (!captured || myGen !== sessionGen || myDnd || !mesh) {
        captured?.stream.getTracks().forEach((t) => t.stop());
        return;
      }
      adoptMicStream(captured.stream, { unconstrained: captured.unconstrained });
      await refreshDeviceList();
    } finally {
      micRecovering = false;
    }
  }

  async function switchCamera(deviceId) {
    if (!deviceId) return;
    pushDevicePick("camera", deviceId);
    // Camera off: the pick is recorded for the next time video is switched on,
    // and reconcileCamera deliberately won't start capture on its own.
    if (!localCameraStream) {
      ui.syncActiveSelection?.({ camId: deviceId });
      await refreshDeviceList();
      return;
    }
    if (deviceId === activeCameraId()) return;
    let stream;
    try {
      stream = await media.getUserMedia(buildCameraConstraints("standard", deviceId));
    } catch {
      syncDeviceSelectsToActive();
      return;
    }
    // The getUserMedia await above is an async gap: a reconnect/teardown could have
    // stopped the camera (localCameraStream and mesh nulled) meanwhile. Bail and
    // release the freshly captured stream instead of dereferencing null / leaking.
    if (!localCameraStream || !mesh) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    await applyFreshCameraStream(stream);
  }

  // --- Camera --------------------------------------------------------------
  // Swap in a freshly captured camera stream: wire loss-recovery to the new
  // track, stop the old one, hand the track to the mesh + self tile, and reset
  // the capture/boost ratchet. Never touches the camera stack — the pick was
  // already recorded by switchCamera, and every other caller here is a fallback
  // or an auto-selection, which are not choices. Callers must have already run
  // the async-gap guard, so localCameraStream + mesh are still live here.
  async function applyFreshCameraStream(stream) {
    const track = stream.getVideoTracks()[0];
    track.contentHint = "motion";
    attachCameraLossRecovery(track);

    localCameraStream.getTracks().forEach((t) => t.stop());
    localCameraStream = stream;

    // The new track starts at standard capture; bump the generation so any queued
    // stale applyConstraints bails, then let distribution re-raise if focused.
    captureGeneration++;
    appliedCaptureLevel = "standard";
    cameraBoostCapLevel = "high";

    mesh.setLocalCameraTrack(localCameraStream);
    ui.setLocalVideo({ camera: localCameraStream, screen: localScreenStream });
    applyCameraDistribution();
    await refreshDeviceList();
  }

  /**
   * Capture one camera and make it the live one.
   *
   * Mirrors recaptureMic, including the three-state result and for the same
   * reason: the capture is an async gap the user can act across (turning video
   * off, opting out of video, a teardown), and adopting a stream that arrives
   * after that would put a camera back on the wire behind their back. An
   * abandoned capture says nothing about the hardware, so it must not disqualify
   * the pick — without that distinction, turning video off during a reconcile
   * walks the whole stack marking every camera unusable, and the next enable
   * falls back to an unconstrained capture even though the top pick is present.
   *
   * @returns {Promise<"ok"|"failed"|"aborted">}
   */
  async function recaptureCameraExact(deviceId) {
    if (!deviceId) return "failed";
    const superseded = () => !localCameraStream || !mesh || myVideoOptOut;
    if (superseded()) return "aborted";
    let stream;
    try {
      stream = await media.getUserMedia(
        buildCameraConstraints("standard", deviceId, /*exact*/ true),
      );
    } catch {
      return superseded() ? "aborted" : "failed";
    }
    if (superseded()) {
      stream.getTracks().forEach((t) => t.stop());
      return "aborted";
    }
    await applyFreshCameraStream(stream);
    return "ok";
  }

  // A camera video track can end on its own when the underlying device
  // disappears (e.g. an external webcam is unplugged) — unlike track.stop(),
  // which never fires "ended". When that happens the capture is dead (a black
  // frame) even though the device dropdown re-points at a still-present camera.
  // Attach a recovery handler that re-captures on an available camera.
  function attachCameraLossRecovery(track) {
    track.addEventListener("ended", () => {
      // No-op if this isn't the live camera track anymore (we swapped/stopped it;
      // stop() doesn't fire "ended", but a stale listener still shouldn't act).
      if (!localCameraStream || localCameraStream.getVideoTracks()[0] !== track) return;
      recoverLostCamera();
    });
  }

  // Re-capture the camera after the active device vanished mid-stream. Try the
  // remembered device first (it may just be a transient glitch), then fall back
  // to any camera (the common unplugged case → internal camera). If nothing can
  // be opened, stop cleanly and tell the room the camera is off, rather than
  // leaving a black tile that the dropdown wrongly claims is live.
  async function recoverLostCamera() {
    // In-flight guard: a track only ends once, but stay reentrancy-safe like
    // cameraStarting so a future second caller can't run two recaptures at once.
    if (cameraRecovering || !localCameraStream || myVideoOptOut || !mesh) return;
    cameraRecovering = true;
    try {
      const lost = localCameraStream;
      // Same walk startLocalCamera uses, for the same reason: this stream goes
      // straight to the mesh, so settling for an unconstrained fallback while a
      // lower pick is available would put an unintended camera on the wire.
      const stream = await captureStackedCamera();
      // Async gap: a teardown, opt-out, manual stop or switch could have landed
      // during the capture. Release the fresh stream instead of clobbering state.
      if (lost !== localCameraStream || !mesh || myVideoOptOut) {
        stream?.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!stream) {
        // No camera left to fall back to: stop cleanly and notify the room.
        stopLocalCamera(true);
        return;
      }
      await applyFreshCameraStream(stream);
    } finally {
      cameraRecovering = false;
    }
  }

  /**
   * Open the camera the stack points at, walking it top-down.
   *
   * Each device is pinned with an *exact* deviceId, because Chrome does not
   * honor an `ideal` one reliably — it falls back to the first/default camera,
   * which is the original "wrong camera on re-enable" bug. A device that refuses
   * is marked unusable so the next round resolves past it, and only when nothing
   * on the stack opens do we capture unconstrained. The walk belongs here rather
   * than in the reconcile that follows: this stream goes straight to the mesh, so
   * settling for a fallback while a lower pick is available would put an
   * unintended camera on the wire until the reconcile swapped it out.
   */
  async function captureStackedCamera() {
    for (;;) {
      const pinned = pinnedIdFor("camera");
      if (!pinned) break;
      try {
        return await media.getUserMedia(
          buildCameraConstraints("standard", pinned, /*exact*/ true),
        );
      } catch {
        markUnusable("camera", pinned);
        // Without an enumeration the pin is the raw top pick, which marking
        // unusable cannot move — there is nothing further to walk.
        if (!lastRawDevices.length) break;
      }
    }
    try {
      return await media.getUserMedia(buildCameraConstraints("standard", null));
    } catch {
      return null;
    }
  }

  async function startLocalCamera() {
    if (localCameraStream || myVideoOptOut) {
      cameraStarting = false;
      return;
    }
    cameraStarting = true;
    const stream = await captureStackedCamera();
    if (!stream) {
      signaling?.camera(false);
      cameraFocusers.clear();
      clearAllFocusHolds();
      cameraStarting = false;
      return;
    }
    // The getUserMedia await above is an async gap: a reconnect/teardown (mesh
    // nulled) or a video opt-out could have landed during the permission prompt.
    // Bail and release the captured stream instead of dereferencing null /
    // leaking (mirrors switchCamera's guard).
    if (!mesh || myVideoOptOut) {
      stream.getTracks().forEach((t) => t.stop());
      cameraStarting = false;
      return;
    }
    localCameraStream = stream;
    const track = stream.getVideoTracks()[0];
    track.contentHint = "motion";
    attachCameraLossRecovery(track);
    // Do not persist the granted device: a fallback after a vanished preferred
    // camera must not overwrite the user's pick (nor invent a pick on first use).
    appliedCaptureLevel = "standard";
    cameraBoostCapLevel = "high";
    mesh.setLocalCameraStream(localCameraStream, { sendTo: cameraSendToFilter });
    ui.setLocalVideo({ camera: localCameraStream, screen: localScreenStream });
    ui.setCameraButton(true);
    // Camera permission just landed: labels for video inputs are now readable.
    await refreshDeviceList();
    cameraStarting = false;
    applyFocusView();
  }

  function stopLocalCamera(sendServer) {
    if (!localCameraStream) return;
    // Optional chaining: an async-gap race can leave a live camera with a nulled
    // mesh; teardown must stay safe.
    mesh?.setLocalCameraStream(null);
    localCameraStream.getTracks().forEach((t) => t.stop());
    localCameraStream = null;
    captureGeneration++;
    appliedCaptureLevel = "standard";
    cameraBoostCapLevel = "high";
    cameraStarting = false;
    cameraFocusers.clear();
    clearAllFocusHolds();
    ui.setLocalVideo({ camera: null, screen: localScreenStream });
    ui.setCameraButton(false);
    if (sendServer) signaling?.camera(false);
  }

  function handleCamera(id, on, skipStart = false) {
    // Mirror presence into the director first: a camera-off reconciles away any
    // camera focus that pointed at this peer (the old scattered `userFocus = null`).
    stage.setCamera(id, on);
    if (on) {
      if (id === myId) {
        if (!skipStart) {
          if (!localCameraStream) cameraStarting = true;
          startLocalCamera();
        }
        else if (localCameraStream)
          ui.setLocalVideo({ camera: localCameraStream, screen: localScreenStream });
      } else {
        reclassifyPeerVideoTracks(id);
      }
    } else {
      if (id === myId) stopLocalCamera(false);
      else reclassifyPeerVideoTracks(id);
    }
    applyFocusView();
  }

  // A peer (un)muted their mic: a pure view overlay (mic-off badge), no presence
  // logic — the server only broadcasts mute to *others*, so self never lands
  // here, but guard anyway so a stray echo can't fight our local mute UI.
  function handleMute(id, on) {
    if (id === myId) return;
    ui.setPeerMuted(id, !!on);
  }

  // A peer entered/left "Stör ej". Track them, stop sending them any media (the
  // mesh unions this with the fullscreen video-suppress set), and show the moon
  // badge (which subsumes their mic-off badge in the view). The server broadcasts
  // to others only, so self never lands here, but guard anyway.
  //
  // For everyone else this is a soft leave/join: entering plays the falling
  // leave tone, leaving plays the rising join tone. Only on a real transition —
  // the welcome roster applies DND with `chime: false` (those peers were already
  // away when we arrived), and a stray/repeated flag stays silent.
  function handleDnd(id, on, { chime = true } = {}) {
    if (id === myId) return;
    const wasDnd = peerDnd.has(id);
    if (on) peerDnd.add(id);
    else peerDnd.delete(id);
    mesh?.setDndBlockedPeers(peerDnd);
    ui.setPeerDnd(id, !!on);
    applyFocusView();
    if (!chime) return;
    if (on && !wasDnd) ui.playLeaveSound();
    else if (!on && wasDnd) ui.playJoinSound();
  }

  function handleCameraLimit() {
    stage.clearAllCameras();
    stage.clearUserFocus();
    stopLocalCamera(false);
    ui.clearAllVideo();
    ui.showCameraLimitBanner();
    applyFocusView();
  }

  function handleVideoOptOut(id, on) {
    if (on) peerVideoOptOut.add(id);
    else peerVideoOptOut.delete(id);

    if (id !== myId && localCameraStream && !myVideoOptOut) {
      mesh.setLocalCameraStream(localCameraStream, { sendTo: cameraSendToFilter });
    }

    if (on && id !== myId) ui.clearPeerCamera(id);

    applyFocusView();
  }

  // --- Screen sharing ------------------------------------------------------
  async function startShare() {
    let stream;
    try {
      stream = await media.getDisplayMedia(SCREEN_CONSTRAINTS);
    } catch {
      return;
    }
    // The getDisplayMedia await above is an async gap: a reconnect/teardown
    // (mesh + myId nulled) could have landed during the picker. Bail and release
    // the captured stream instead of dereferencing null / leaking.
    if (!mesh) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    localScreenStream = stream;
    const track = stream.getVideoTracks()[0];
    track.contentHint = "detail";
    track.addEventListener("ended", () => stopShare());

    mesh.setLocalScreenStream(localScreenStream);
    ui.setLocalVideo({ camera: localCameraStream, screen: localScreenStream });
    signaling?.share(true);
    stage.setSharer(myId);
    stage.clearUserFocus();
    ui.setShareButton(true);
    applyFocusView();
  }

  function stopShare(superseded = false) {
    if (!localScreenStream) return;
    // Optional chaining: an async-gap race can leave a live share with a nulled
    // mesh; teardown must stay safe.
    mesh?.setLocalScreenStream(null);
    localScreenStream.getTracks().forEach((t) => t.stop());
    localScreenStream = null;
    ui.setLocalVideo({ camera: localCameraStream, screen: null });
    ui.setShareButton(false);

    if (!superseded) {
      signaling?.share(false);
      // setSharer(null) reconciles away any screen focus (self or remote).
      stage.setSharer(null);
      applyFocusView();
    }
  }

  function handleSharer(id, name) {
    if (localScreenStream && id !== myId) stopShare(/*superseded*/ true);

    // Set the sharer first: reclassify gates the screen on it (stage.getSharerId),
    // so the old sharer's screen is cleared rather than left frozen when sharing
    // moves/stops.
    const prevSharer = stage.getSharerId();
    stage.setSharer(id);
    stage.clearUserFocus();
    if (prevSharer && prevSharer !== id && prevSharer !== myId) {
      reclassifyPeerVideoTracks(prevSharer);
    }
    if (id && id !== myId) reclassifyPeerVideoTracks(id);
    applyFocusView();
  }

  // The single reconcile point: ask the director what the stage should be, push
  // its signaling intents onto the wire, then render. Everything that changes
  // focus or presence routes here.
  function applyFocusView() {
    const view = stage.view();
    reconcileCameraFocusSignal(view);
    applyCameraDistribution();
    reconcileVideoSuppression(view);
    ui.render(view);
  }

  // --- User actions (bound to DOM by the composition root) -----------------
  async function join(name, { room, restore = null } = {}) {
    // Supersede any in-flight join and capture this attempt's generation +
    // target room *before* the async mic prompt (see sessionGen).
    const myGen = ++sessionGen;
    // Re-probe this client's public IP fresh for every user-initiated join (new
    // room / leave→rejoin / room switch) so a network change since the last
    // session isn't reported with a stale IP/ASN. Starting it now runs the probe
    // during the mic-permission prompt; we await it below (before connect) so the
    // join we send carries the resolved IP.
    publicIp = null;
    publicIpProbe = null;
    const ipProbe = probePublicIp();
    if (room !== undefined) currentRoom = room;
    const targetRoom = currentRoom;
    myName = name;
    if (restore) {
      pendingRestore = restore;
      // Device picks are not carried in the snapshot: they live in localStorage,
      // which survives the deploy reload, so this session resolves them exactly
      // as a cold load would.
      if (restore.videoOptOut) {
        myVideoOptOut = true;
        stage.setSelfVideoOptOut(true);
        ui.setVideoOptOutUi(true);
      }
    }
    // A since-removed pick must never block getting audio, so this ends in an
    // unconstrained capture rather than failing; the reconcile below then paints
    // whatever is live and swaps in a higher pick once it reappears.
    const captured = await captureStackedMic();
    if (!captured) return false;
    const stream = captured.stream;
    micCaptureUnconstrained = captured.unconstrained;
    // Async-gap guard: if the user navigated away (Back/leave) or started a
    // different join while the mic prompt was open, abandon this one — stop the
    // captured stream so the mic is released, and never open the room.
    if (myGen !== sessionGen || targetRoom !== currentRoom) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    // Wait for the STUN probe to settle so the `join` we send carries the
    // resolved public IP — the stats ASN is locked to the first join event, so a
    // late IP would be lost. It started during the mic prompt (usually already
    // resolved → instant here); the wait is bounded by the probe's own timeout,
    // and on a STUN-blocked network it resolves null (asn: null, as before).
    await ipProbe;
    // Re-check the async-gap guard: awaiting the probe is another suspension
    // point where the user could navigate away or start a different join.
    if (myGen !== sessionGen || targetRoom !== currentRoom) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    localStream = stream;
    localStreamGen = myGen;
    warnIfAudioProcessingDisabled(localStream);
    attachMicLossRecovery(localStream.getAudioTracks()[0]);
    // The stack is untouched here: the live track may be a fallback, and a
    // fallback is not a choice. refreshDeviceList below paints whatever is
    // actually live and recaptures when a higher pick reappears.
    // Apply mute before connect so deploy-restore never briefly ships audio.
    if (restore?.muted) {
      const track = localStream.getAudioTracks()[0];
      if (track?.enabled) {
        track.enabled = false;
        ui.setMuteUi(true);
      }
    }
    // Build the always-on mic pipeline (HPF + expander) against the raw stream.
    // Created after the restore-mute above so it starts with the right mute state.
    ensureMicPipeline();
    await refreshDeviceList();
    // The device refresh enumerates and may recapture, so it is a suspension
    // point of its own — and the last one before the room opens. Without this
    // check a Back pressed during it would leave the landing page on screen with
    // a live microphone and a connected room behind it.
    if (myGen !== sessionGen || targetRoom !== currentRoom) {
      abandonJoinCapture(stream, myGen);
      return false;
    }
    connect();
    return true;
  }

  /**
   * Release what an abandoned join is still holding.
   *
   * The stream it captured is always stopped: the reconcile may have swapped it
   * for a higher stack pick, in which case it is already stopped and this is a
   * no-op. The *live* mic is only released if this join is still the one that
   * put it there — what superseded us may be a newer join that has already
   * opened its own, and cutting that off would be worse than the leak we are
   * cleaning up. (When it is a newer join, it stops our stream itself on adopt.)
   */
  function abandonJoinCapture(captured, myGen) {
    captured?.getTracks().forEach((t) => t.stop());
    if (localStreamGen !== myGen) return;
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    micPipeline?.close?.();
    micPipeline = null;
  }

  function leave() {
    signaling?.close();
  }

  // Abort an in-flight join whose mic prompt is still open (e.g. the user pressed
  // browser Back before the room came up, so leaveToLanding's heavier teardown
  // isn't warranted yet). Bumping the generation makes the pending join's
  // post-await guard stop the captured stream and bail. No-op when nothing is
  // pending.
  function cancelPendingJoin() {
    sessionGen++;
  }

  // Full teardown back to the landing page (SPA leave): unlike the reconnect
  // teardown, this also releases the mic + pipeline and resets the per-room
  // session state the old full-page reload used to clear. Bumps sessionGen so an
  // in-flight join (mic prompt still open) bails instead of reviving the room.
  function leaveToLanding() {
    sessionGen++;
    if (signaling) {
      signaling.leave();
      signaling.close();
      signaling = null;
    }
    teardownRoom();
    // Release the mic + its processing pipeline (teardownRoom keeps them for
    // reconnect; a deliberate leave should not hold the mic open).
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    micPipeline?.close?.();
    micPipeline = null;
    resetFreshSessionState();
    myName = "";
  }

  // The "fresh room session" reset surface (what the old reload used to clear):
  // mute returns to unmuted (a new mic track starts enabled), while video-opt-out
  // is a persistent preference that is *re-applied*, not reset. The view's
  // onboarding flag is reset by the composition root on the same leave path.
  function resetFreshSessionState() {
    ui.setMuteUi(false);
    // DND is a per-session state (not a persistent pref): a deliberate leave to
    // the landing page resets it, so the next room never starts silently dark.
    myDnd = false;
    dndReturnMuted = false;
    peerDnd.clear();
    ui.setDndUi(false);
    // Re-assert the persisted opt-out preference onto the stage + toggle so the
    // next room starts consistent with it (no stale enabled/disabled state).
    stage.setSelfVideoOptOut(myVideoOptOut);
    ui.setVideoOptOutUi(myVideoOptOut);
  }

  // pagehide: tell the server we're going (best-effort) and suppress reconnect.
  function pagehideLeave() {
    signaling?.leave();
    signaling?.close();
  }

  function toggleMute() {
    // Inert while DND (the button is also disabled): the mic capture is stopped,
    // so there's nothing to mute. The room returns to its pre-DND mute state.
    if (myDnd) return;
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const muted = !track.enabled;
    ui.setMuteUi(muted);
    // Stop actually shipping audio frames while muted (replaceTrack(null)), not
    // just silencing the track — otherwise the encoder keeps sending RTP and the
    // bandwidth meter still shows outgoing audio.
    mesh?.setLocalAudioMuted(muted);
    // Freeze the expander's floor estimate while muted: the raw track is disabled
    // (silent), so without this the floor would collapse toward zero and over-gate
    // on unmute. See docs/noise-reduction.md.
    micPipeline?.setMuted(muted);
    // Broadcast the mute as cooperative presence so peers can show a mic-off
    // badge. Server-relayed (not inferred from the dead media path), mirroring
    // camera presence. Re-announced after every (re)join in processWelcome.
    signaling?.mute(muted);
  }

  function toggleCamera() {
    // Inert while DND (button disabled + capture stopped): the camera is turned
    // back on manually after leaving DND, like "Stäng av video för mig".
    if (myVideoOptOut || myDnd) return;
    if (!localCameraStream) cameraStarting = true;
    signaling?.camera(!localCameraStream);
  }

  function toggleVideoOptOut() {
    myVideoOptOut = !myVideoOptOut;
    // Persist as a preference: it carries across room sessions + reloads.
    saveVideoOptOutPref(myVideoOptOut);
    ui.setVideoOptOutUi(myVideoOptOut);
    stage.setSelfVideoOptOut(myVideoOptOut);
    // Intent-only while DND: update the local preference + label, but don't
    // signal or touch media (nothing flows during DND). The final opt-out is
    // re-announced when DND lifts.
    if (myDnd) {
      applyFocusView();
      return;
    }
    signaling?.videoOptOut(myVideoOptOut);
    if (myVideoOptOut) {
      if (localCameraStream) signaling?.camera(false);
      stopLocalCamera(false);
      ui.clearIncomingCameras();
    }
    applyFocusView();
  }

  function toggleShare() {
    // Inert while DND (button disabled): re-share manually after leaving DND
    // (getDisplayMedia needs a live gesture and can't be auto-resumed anyway).
    if (!media.canShareScreen || myDnd) return;
    if (localScreenStream) stopShare();
    else startShare();
  }

  // --- "Stör ej" (Do Not Disturb) ------------------------------------------
  function toggleDnd() {
    if (myDnd) exitDnd();
    else enterDnd();
  }

  // Enter DND: stop ALL local capture so no OS/browser "recording" indicators
  // stay lit (the mic orange dot, the camera green dot) — the use case is "I've
  // stepped away (lunch) but I'm still in the room". Camera + screen are stopped
  // and de-announced; the mic *device* is released too (keeping the Web Audio
  // pipeline alive so audio m-lines survive — see stopLocalMicCapture). The
  // outbound senders are paused, the local presentation gate stops us rendering/
  // playing anything peers send before they honor the flag, and the pre-DND mute
  // state is snapshotted for restore. Underlying video-opt-out is left untouched.
  function enterDnd() {
    myDnd = true;
    signaling?.dnd(true);
    ui.setDndUi(true);
    dndReturnMuted = currentMicMuted();
    if (localCameraStream) {
      signaling?.camera(false);
      stopLocalCamera(false);
    }
    if (localScreenStream) stopShare();
    stopLocalMicCapture();
    mesh?.setLocalDndActive(true);
    applyFocusView();
  }

  // Leave DND: re-acquire the mic (the baseline of a voice room is restored
  // automatically, in the pre-DND mute state), un-pause outbound, lift the
  // presentation gate, and re-announce the presence the room missed while dark
  // (mute + video-opt-out). Camera + screen are NOT auto-restored — you turn
  // those back on manually, like "Stäng av video för mig".
  async function exitDnd() {
    myDnd = false;
    signaling?.dnd(false);
    ui.setDndUi(false);
    const gotMic = await restartLocalMic();
    // If we re-entered DND (or left the room) while the mic prompt was open, a
    // newer state owns the room now — don't stomp it by un-pausing here.
    if (myDnd || !mesh) return;
    mesh.setLocalDndActive(false);
    // If the mic couldn't be re-acquired (permission revoked between join and
    // exit — rare), there's no live capture, so the honest presence is *muted*.
    // Announcing "unmuted" here would tell peers we're talking when we can't.
    const muted = gotMic ? dndReturnMuted : true;
    if (!gotMic) {
      console.warn("[babbla] kunde inte återstarta mikrofonen efter Stör ej");
    }
    mesh.setLocalAudioMuted(muted);
    ui.setMuteUi(muted);
    signaling?.mute(muted);
    signaling?.videoOptOut(myVideoOptOut);
    applyFocusView();
  }

  // Release the microphone *device* (turns off the OS mic indicator) while
  // KEEPING the Web Audio pipeline alive: the mesh sends the pipeline's synthetic
  // destination track, so the audio m-lines/senders survive (a peer who joins
  // during DND still gets an idle audio sender) and resume on exit. Only the raw
  // getUserMedia capture is stopped; localStream's tracks end (we re-acquire on
  // exit). This deliberately forgoes the usual iOS "keep mic alive in background"
  // behavior — a DND user has intentionally gone quiet, so that doesn't apply.
  function stopLocalMicCapture() {
    localStream?.getAudioTracks().forEach((t) => t.stop());
  }

  // Re-acquire the mic device on DND exit and re-wire the pipeline. Mirrors the
  // switchMicrophone path (fresh getUserMedia -> rebuild pipeline -> re-point the
  // mesh + self-meter), then applies the remembered mute state. Async-gap guarded
  // like the other capture starters: bail + release if we left / re-entered DND /
  // lost the mesh during the permission prompt.
  async function restartLocalMic() {
    const myGen = sessionGen;
    const captured = await captureStackedMic();
    if (!captured) {
      // Mic denied/unavailable: leave audio off and report failure so exitDnd
      // presents us as muted rather than falsely "unmuted".
      return false;
    }
    const stream = captured.stream;
    micCaptureUnconstrained = captured.unconstrained;
    if (myGen !== sessionGen || myDnd || !mesh) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    const track = stream.getAudioTracks()[0];
    if (track) track.enabled = !dndReturnMuted;
    // Stop any lingering (already-ended) tracks from before DND, then adopt.
    localStream?.getAudioTracks().forEach((t) => t.stop());
    localStream = stream;
    localStreamGen = sessionGen;
    attachMicLossRecovery(track);
    warnIfAudioProcessingDisabled(localStream);
    // Reconnect the pipeline's source to the new mic (output identity is stable
    // in the happy path, so mesh senders don't churn); build it if it was absent.
    micPipeline?.rebuild(localStream);
    ensureMicPipeline();
    micPipeline?.setMuted(dndReturnMuted);
    mesh.setLocalAudioStream(processedAudioStream());
    ui.setSelfMicMeter(processedAudioStream());
    await refreshDeviceList();
    return true;
  }

  // "Brusreducering" select (off | lite | full). Applies to the pipeline and
  // persists; the 80 Hz HPF is unconditional, so "off" still keeps it.
  function setNoiseReduction(level) {
    noiseLevel = NOISE_LEVELS.has(level) ? level : DEFAULT_NOISE_LEVEL;
    saveDevicePref(NOISE_KEY, noiseLevel);
    micPipeline?.setConfig(noiseLevel);
    ui.syncActiveSelection?.({ noiseLevel });
  }

  function getNoiseLevel() {
    return noiseLevel;
  }

  // Clicking the stage: enlarge our own share preview, or clear an explicit focus.
  // In fullscreen the click only wakes the auto-hidden controls (no focus change).
  function handleStageClick() {
    const view = stage.view();
    if (view.fullscreen) return;
    if (stage.getSharerId() === myId && localScreenStream && !view.hasUserFocus) {
      stage.focusClick(myId, "screen");
      applyFocusView();
      return;
    }
    if (view.hasUserFocus) {
      stage.clearUserFocus();
      applyFocusView();
    }
  }

  // Tile focus click (view-owned tiles call this back through `actions`).
  function focusTile(peerId, type) {
    stage.focusClick(peerId, type);
    applyFocusView();
  }

  function enterFullscreen() {
    if (stage.enterFullscreen()) applyFocusView();
  }

  function exitFullscreen() {
    if (stage.exitFullscreen()) applyFocusView();
  }

  return {
    // session lifecycle
    join,
    leave,
    leaveToLanding,
    cancelPendingJoin,
    pagehideLeave,
    connect,
    // control-button actions
    toggleMute,
    toggleCamera,
    toggleVideoOptOut,
    toggleShare,
    toggleDnd,
    // focus / stage actions
    focusTile,
    stageClick: handleStageClick,
    enterFullscreen,
    exitFullscreen,
    // device selection
    switchMicrophone,
    switchCamera,
    switchSpeaker,
    refreshDevices: refreshDeviceList,
    // noise reduction ("Brusreducering")
    setNoiseReduction,
    getNoiseLevel,
  };
}
