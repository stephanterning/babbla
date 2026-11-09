// babbla — full-duplex audio room (WebRTC mesh) with optional camera grid
// and screen share.
//
// Topology: full mesh. One RTCPeerConnection per peer; Opus audio plus optional
// camera and screen-video tracks flow directly between browsers. The server
// relays SDP/ICE, presence, sharer state, camera presence (max 6), and
// per-client video opt-out — no media through the server.
//
// Negotiation: "perfect negotiation" per peer (a deterministic polite/impolite
// role) so connections survive both the initial setup and mid-call
// renegotiation (adding/removing tracks) without glare.
//
// Video track kind (camera vs screen): WebRTC carries no semantic label for a
// track — `label` and `contentHint` are local-only and never reach the peer.
// So each side sends a `{ <mid>: "camera" | "screen" }` map alongside *the same*
// signaling message as its SDP description (built in the mesh from per-peer
// sender identity — see `localVideoRoles` there). Because the map rides in-band
// with the offer/answer, the receiver always has the role ready by the time the
// `track` event fires (the transceiver mid is symmetric across the connection)
// — no out-of-band race, no resolution/label guessing.
//
// Audio priority: the audio sender is marked high priority; camera and screen
// video are bitrate-capped + low priority so video can never steal the audio's
// low latency.

import { createStageDirector } from "./stage.js";
import { createRoomController } from "./room-controller.js";
import { createMicPipeline as baseCreateMicPipeline } from "./mic-pipeline.js";
import { createDeviceMenu } from "./device-menu.js";
import { activeIceErrorsToShow } from "./mesh.js";
import { sanitizeRoomName, DEFAULT_ROOM } from "./room-name.js";
import {
  clearSessionRestore,
  readPendingRestore,
  snapshotMatchesRoom,
} from "./session-restore.js";
import { readRoomHistory, recordRoomVisit } from "./room-history.js";

const LAST_NAME_KEY = "babbla:lastName";
const UPGRADE_TOAST_MS = 5_000;

// Tooltip for the relay (TURN) indicator — a peer whose media reaches us via a
// TURN/coturn relay instead of direct P2P. NB: it's the dedicated TURN relay, not
// the babbla app server, and the media stays end-to-end encrypted (DTLS-SRTP).
// The color legend is also in the info modal.
const RELAY_TITLE =
  "Ansluten via TURN-relä (coturn), inte direkt P2P — fortfarande end-to-end-krypterad";

// Resizable sidebar (stage layout). Baseline is the old fixed 320px; the user
// can drag (or arrow-key) the handle between half and double that, and the pick
// is persisted. The applied width is additionally clamped so the stage never
// collapses below STAGE_MIN_WIDTH on narrow windows (the persisted *intent* is
// kept, so it expands back out again on a wider window).
const SIDEBAR_WIDTH_KEY = "babbla:sidebarWidth";
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_MIN_WIDTH = 162;
const SIDEBAR_MAX_WIDTH = 640;
const SIDEBAR_RESIZER_COL = 24;
const SIDEBAR_KEY_STEP = 16;
const STAGE_MIN_WIDTH = 360;

const els = {
  joinView: document.getElementById("join-view"),
  roomView: document.getElementById("room-view"),
  joinForm: document.getElementById("join-form"),
  nameInput: document.getElementById("name-input"),
  roomChooser: document.getElementById("room-chooser"),
  roomSelect: document.getElementById("room-select"),
  roomInput: document.getElementById("room-input"),
  joinBtn: document.getElementById("join-btn"),
  joinError: document.getElementById("join-error"),
  status: document.getElementById("status"),
  roomNameRow: document.getElementById("room-name-row"),
  roomName: document.getElementById("room-name"),
  copyLinkBtn: document.getElementById("copy-link-btn"),
  shareOnboarding: document.getElementById("share-onboarding"),
  bandwidth: document.getElementById("bandwidth"),
  bwUp: document.getElementById("bw-up"),
  bwDown: document.getElementById("bw-down"),
  diagnostics: document.getElementById("diagnostics"),
  iceHealth: document.getElementById("ice-health"),
  quickControls: document.getElementById("quick-controls"),
  muteSplit: document.getElementById("mute-split"),
  muteMenuBtn: document.getElementById("mute-menu-btn"),
  muteBtn: document.getElementById("mute-btn"),
  micPicker: document.getElementById("mic-picker"),
  micSelect: document.getElementById("mic-select"),
  noiseSelect: document.getElementById("noise-select"),
  speakerPicker: document.getElementById("speaker-picker"),
  speakerSelect: document.getElementById("speaker-select"),
  cameraSplit: document.getElementById("camera-split"),
  cameraMenuBtn: document.getElementById("camera-menu-btn"),
  cameraBtn: document.getElementById("camera-btn"),
  cameraPicker: document.getElementById("camera-picker"),
  cameraSelect: document.getElementById("camera-select"),
  shareBtn: document.getElementById("share-btn"),
  videoOffBtn: document.getElementById("video-off-btn"),
  dndBtn: document.getElementById("dnd-btn"),
  dndHint: document.getElementById("dnd-hint"),
  leaveBtn: document.getElementById("leave-btn"),
  audioSink: document.getElementById("audio-sink"),
  enableAudioBtn: document.getElementById("enable-audio-btn"),
  screenWrap: document.getElementById("screen-wrap"),
  screenVideo: document.getElementById("screen-video"),
  screenLabel: document.getElementById("screen-label"),
  screenMute: document.getElementById("screen-mute"),
  screenDnd: document.getElementById("screen-dnd"),
  pipBtn: document.getElementById("pip-btn"),
  fullscreenBtn: document.getElementById("fullscreen-btn"),
  fsControls: document.getElementById("fs-controls"),
  fsGrip: document.getElementById("fs-grip"),
  fsMuteMenuBtn: document.getElementById("fs-mute-menu-btn"),
  fsCameraSplit: document.getElementById("fs-camera-split"),
  fsCameraMenuBtn: document.getElementById("fs-camera-menu-btn"),
  fsDeviceMenu: document.getElementById("fs-device-menu"),
  fsMute: document.getElementById("fs-mute"),
  fsCamera: document.getElementById("fs-camera"),
  fsShare: document.getElementById("fs-share"),
  fsLeave: document.getElementById("fs-leave"),
  fsExit: document.getElementById("fs-exit"),
  sidebarResizer: document.getElementById("sidebar-resizer"),
  videoGrid: document.getElementById("video-grid"),
  cameraLimitBanner: document.getElementById("camera-limit-banner"),
  upgradeToast: document.getElementById("upgrade-toast"),
  cameraLimitDismiss: document.getElementById("camera-limit-dismiss"),
  infoButtons: document.querySelectorAll(".info-btn"),
  infoDialog: document.getElementById("info-dialog"),
  closeInfoBtn: document.getElementById("close-info-btn"),
  macosVoiceIsolation: document.getElementById("macos-voice-isolation"),
  iosStandaloneBg: document.getElementById("ios-standalone-bg"),
};

// Owns the "what is on the stage" decision: local focus intent + a mirror of
// server presence (sharer / cameras / roster) folded into one StageView. The
// controller mutates it; the view layer paints view() and reads isFullscreen()
// for the auto-hidden fullscreen controls.
const stage = createStageDirector();

/** @type {Map<string, HTMLAudioElement>} */
const peerAudios = new Map();
const pendingPeerAudio = new WeakMap();

// Chosen audio output (speaker). "" = system default. The view is the single,
// idempotent authority: every existing peer <audio>, each newly created one, and
// the chime AudioContext are routed to this sink. Order doesn't matter — whichever
// is created first, the later step reconciles. Output routing (setSinkId) is
// Chromium-only; on browsers without it the speaker picker stays hidden.
let currentSinkId = "";
// Include newly arriving voices in the same order as speaker changes. The
// controller serializes user picks, but cannot see view-owned audio creation.
let audioOutputQueue = Promise.resolve();
/** Hidden <audio> so setSinkId can be probed with no peer in the room. */
let sinkProbeEl = null;
const supportsAudioSink =
  typeof HTMLMediaElement !== "undefined" &&
  typeof HTMLMediaElement.prototype.setSinkId === "function";
const supportsCtxSink =
  typeof AudioContext !== "undefined" &&
  typeof AudioContext.prototype.setSinkId === "function";

/** @type {Map<string, VolumeMeter>} */
const peerMeters = new Map();

/** @type {Map<string, HTMLDivElement>} */
const tiles = new Map();
// Names + self id, mirrored into the view layer so it can resolve focus labels
// and the "I am the sharer" tooltip without reaching into the mesh / orchestration.
/** @type {Map<string, string>} */
const peerNames = new Map();
let uiSelfId = null;
// Callbacks the view-owned, dynamically created elements (tile focus clicks, the
// fullscreen Esc key) fire back into the controller. Wired once the controller
// exists below; no-ops until then (those elements only exist while in a room).
const actions = {
  focusTile: (_peerId, _type) => {},
  exitFullscreen: () => {},
};

let localMeter = null;
let selfTile = null;
// Own "Stör ej" state + the inputs to the single control-disabled reconciler
// (applyControlsDisabled): the live socket/mesh gate and the video-opt-out
// preference. Declared EARLY (not with the other tile view-state lower down)
// because the deploy-restore path calls ui.setRoomControlsEnabled(false)
// synchronously during module init — before a lower `let` would be initialized
// (TDZ). See tryAutoRestoreAfterDeploy.
let selfDnd = false;
let controlsEnabled = false;
let selfVideoOptOut = false;

// Live bandwidth readout: the mesh's own stats sampler pushes per-peer samples
// here once a second (ui.pushPeerStats); we diff the cumulative byte counters
// into kbit/s up (sent) and down (received) so the user has a rough sense of how
// much bandwidth the call is using right now. The view no longer owns the poll
// — the mesh does (one sample drives both this meter and relay detection).
let meterActive = false;
// Per-peerId last sample of the cumulative counters, so each link is diffed on
// its own. Peers that left the roster are pruned each tick (their counters
// reset when the connection drops, which would otherwise look like negative
// deltas — clamped anyway, but pruning keeps the map bounded).
/** @type {Map<string, { t: number, bytesSent: number, bytesReceived: number, packetsLost: number, packetsReceived: number }>} */
const lastPeerSamples = new Map();

// Per-peer inbound video streams (kept stable so <video> doesn't flash on
// reclassify). Presence facts (sharer / who has a camera) live in the stage
// director; these are just the resolved media handles the renderer paints.
/** @type {Map<string, MediaStream>} */
const peerScreen = new Map();
/** @type {Map<string, MediaStream>} */
const peerCamera = new Map();
// Local media as the UI sees it for *rendering* (self-tile + focused stage).
// Pushed by the orchestration via ui.setLocalVideo whenever the real handles
// change; kept separate from the lifecycle-owned streams so the view layer
// never reaches into the controller's media state (and survives the controller
// move to room-controller.js).
let uiLocalCamera = null;
let uiLocalScreen = null;
let cameraLimitTimer = null;
// Remembered module position within this page load (RAM only, not persisted).
/** @type {{ x: number, y: number } | null} */
let fsControlsPos = null;
let fsHideTimer = null;
/** @type {{ id: number, dx: number, dy: number } | null} */
let fsDrag = null;
/** Device/picker state mirrored for the fullscreen context menu. */
let deviceModel = {
  mics: [],
  cams: [],
  speakers: [],
  micOptions: [],
  cameraOptions: [],
  speakerOptions: [],
  micId: "",
  camId: "",
  speakerId: "",
  noiseLevel: "lite",
  isIOS: false,
  supportsAudioSink,
};
let fsDeviceMenu = {
  open: () => false,
  close: () => false,
  isOpen: () => false,
  refresh: () => {},
  reposition: () => {},
  getOpenKind: () => null,
  destroy: () => {},
};
// Persisted *intent* for the stage sidebar width (clamped to [MIN, MAX]); the
// applied width is derived from this via clampSidebarWidth (viewport-aware).
let sidebarWidthPref = readSidebarWidthPref();
/** @type {number | null} Active resize pointer id, null when not dragging. */
let sidebarResizePointer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let sidebarSettleTimer = null;
/** @type {Map<string, HTMLDivElement>} */
const screenTiles = new Map();

const blockedAudio = new Set();
const audioContexts = new Set();

// iOS/iPadOS (all browsers there are WebKit). iPadOS 13+ masquerades as a Mac, so
// fall back to the touch-points heuristic. On iOS the mic/speaker are best chosen
// in the system (Control Center / Settings), not in-app — Safari gives little
// control and setSinkId isn't supported — so we hide those pickers entirely.
const platform = navigator.userAgentData?.platform || navigator.platform || "";
const isIOS =
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (/mac/i.test(platform) && (navigator.maxTouchPoints || 0) > 1);
const isMacOS = /mac/i.test(platform) && !isIOS;
els.macosVoiceIsolation.hidden = !isMacOS;

// Home-screen ("standalone") web apps on iOS get the microphone MUTED by the OS
// in the background — a WebKit/iOS limitation (a Safari *tab* keeps it alive, an
// Add-to-Home-Screen app does not). As of iOS 26 every site added to the Home
// Screen defaults to this standalone mode, so users hit it without opting in.
// We can't lift the OS restriction; surface the caveat + the Safari workaround.
// navigator.standalone is the iOS-only signal (true only from the home screen).
const isIOSStandalone = isIOS && navigator.standalone === true;
els.iosStandaloneBg.hidden = !isIOSStandalone;

// First-visit info modal. We auto-open it once, the moment the mic goes live on
// the first join (see onJoinSubmit), so newcomers see the browser + macOS Voice
// Isolation guidance. A localStorage flag — set on ANY open, manual or auto —
// suppresses it forever after, so it never re-pops (incl. on reconnect).
const INFO_SEEN_KEY = "babbla:infoSeen";

function infoSeen() {
  try {
    return localStorage.getItem(INFO_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markInfoSeen() {
  try {
    localStorage.setItem(INFO_SEEN_KEY, "1");
  } catch {}
}

function openInfoModal() {
  markInfoSeen();
  if (!els.infoDialog.open) els.infoDialog.showModal();
  // The modal covers the share-onboarding arrow — hold its auto-hide countdown
  // while it's open (re-armed on the dialog's `close`). No-op when no arrow.
  pauseShareOnboardingHide();
}

function maybeAutoShowInfoModal() {
  // Skip the onboarding auto-show under automation (e2e), where a modal dialog
  // would make the page inert and block control interactions. Real users never
  // set navigator.webdriver; the dedicated info-modal e2e spoofs it false to
  // still exercise this path. The manual info button is unaffected.
  if (navigator.webdriver) return;
  if (!infoSeen()) openInfoModal();
}

for (const button of els.infoButtons) {
  button.addEventListener("click", openInfoModal);
}
els.closeInfoBtn.addEventListener("click", () => els.infoDialog.close());
els.infoDialog.addEventListener("click", (e) => {
  if (e.target === els.infoDialog) els.infoDialog.close();
});

const canShareScreen =
  typeof navigator.mediaDevices?.getDisplayMedia === "function";

if (!canShareScreen) {
  els.shareBtn.disabled = true;
  els.shareBtn.title =
    "Den här webbläsaren eller enheten kan inte starta skärmdelning.";
  els.shareBtn.setAttribute(
    "aria-label",
    "Dela skärm – inte tillgängligt på den här enheten"
  );
  els.fsShare.hidden = true;
}

// --- Media adapter ---------------------------------------------------------
// The capture port: getUserMedia / getDisplayMedia / enumerateDevices behind a
// tiny seam so the room orchestration never touches `navigator.mediaDevices`
// directly (and can run against a fake in tests). `canShareScreen` is a static
// platform fact the orchestration reads to gate the share control.
const media = {
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  getDisplayMedia: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
  enumerateDevices: () =>
    navigator.mediaDevices?.enumerateDevices
      ? navigator.mediaDevices.enumerateDevices()
      : Promise.resolve([]),
  canShareScreen,
};

// --- UI adapter ------------------------------------------------------------
// The single port the room orchestration uses to touch the DOM. Everything it
// needs to paint — tiles, the stage render, control buttons, chimes, the
// bandwidth meter, device dropdowns — goes through here. The adapter owns the
// display streams (peerScreen/peerCamera + the local handles) and resolves view
// ids -> streams/names internally, so the orchestration deals only in ids/roles/
// booleans (mirrors the stage director). Defined as a thin object over the DOM
// helpers below; the orchestration moves to public/js/room-controller.js next,
// receiving this object unchanged.
const ui = {
  // status / errors
  setStatus,
  setError,
  setRestoreFailed,
  showUpgradeRestoredToast,
  // room presence (drives history recording + the "share the link" onboarding)
  onPresence,
  // stage paint (StageView -> DOM, resolving streams/names internally)
  render: renderStage,
  // control buttons
  setRoomControlsEnabled,
  setCameraButton,
  setShareButton,
  setVideoOffButton,
  setVideoOptOutUi,
  setMuteUi,
  setDndUi,
  setPeerDnd,
  showCameraLimitBanner,
  // participant tiles + per-peer media
  addSelfTile: addSelfTileFor,
  removeSelfTile,
  addTile: ensureTile,
  removePeerMedia,
  setPeerUncertain,
  setPeerConnecting,
  setPeerRelayed,
  setPeerMuted,
  setPeerAudio,
  setSelfMicMeter,
  // display streams (already gated by the orchestration)
  setPeerVideo,
  setLocalVideo,
  clearPeerCamera,
  clearIncomingCameras,
  clearAllVideo,
  // notification chimes
  playJoinSound,
  playLeaveSound,
  // live bandwidth readout (mesh pushes samples via pushPeerStats)
  startBandwidthMeter,
  stopBandwidthMeter,
  pushPeerStats,
  // relay/ICE health (why a link won't come up)
  setRelayAvailable,
  setIceServerError,
  // device dropdowns
  populateDevices,
  syncDeviceSelects,
  syncActiveSelection,
  setAudioOutput,
  // fullscreen overlay teardown (reconnect)
  teardownFullscreen: teardownFullscreenDom,
  // misc
  clearBlockedAudio,
};

// --- Join flow -------------------------------------------------------------
function loadLastName() {
  try {
    const name = localStorage.getItem(LAST_NAME_KEY);
    if (name) els.nameInput.value = name;
  } catch {}
}

function saveLastName(name) {
  try {
    localStorage.setItem(LAST_NAME_KEY, name);
  } catch {}
}

loadLastName();

// Make the URL canonical first (so the room name, the tab title, and the
// signaling room all read the same lowercased value), then reflect a named room
// in the tab title and the sidebar header. The default `/` keeps the plain title
// and shows no subtitle.
canonicalizeRoomUrl();
renderRoomName();
if (isNamedRoom()) document.title = `babbla — ${canonicalRoom()}`;

// --- Compose the room controller -------------------------------------------
// The orchestration (presence/focus handlers, inbound dispatch, mesh + media
// lifecycle, reconcilers) lives in room-controller.js; SPA navigation means the
// room is dynamic, so we hand it *builders* (URL + path from a canonical room
// name) rather than a fixed URL. View-owned dynamic elements (tile focus clicks,
// the fullscreen Esc key) fire back through `actions`, wired to the controller
// below.

// The WS signaling URL for a canonical room name. The default room ("main" /
// the landing root) connects with no `?room=` (the server defaults to "main").
function wsUrlForRoom(room) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const named = !!room && room !== DEFAULT_ROOM;
  const query = named ? `?room=${encodeURIComponent(room)}` : "";
  return `${proto}://${location.host}/ws${query}`;
}

// The page path for a canonical room name (used for the deploy-restore snapshot
// + pushState navigation). Default room lives at bare `/`, not `/room/main`.
function roomPathForRoom(room) {
  const named = !!room && room !== DEFAULT_ROOM;
  return named ? `/room/${encodeURIComponent(room)}` : "/";
}

// Wrap the mic-pipeline factory so its AudioContext joins the "aktivera ljud"
// resume set (and gets a best-effort resume) — the pipeline is everyone's
// outbound path, so it must wake with the page's other audio contexts.
const createMicPipeline = (rawStream, opts = {}) =>
  baseCreateMicPipeline(rawStream, {
    ...opts,
    workletUrl: "/js/noise-expander-worklet.js",
    registerContext: (ctx) => {
      audioContexts.add(ctx);
      ctx.resume?.().catch?.(() => {});
    },
  });

const controller = createRoomController({
  stage,
  ui,
  media,
  signalingUrlFor: wsUrlForRoom,
  roomPathFor: roomPathForRoom,
  room: canonicalRoom(),
  createMicPipeline,
});
actions.focusTile = controller.focusTile;
actions.exitFullscreen = controller.exitFullscreen;

// Initialise the "Brusreducering" select from the persisted level and route
// changes into the controller (which applies to the pipeline + persists).
if (els.noiseSelect) {
  els.noiseSelect.value = controller.getNoiseLevel();
  els.noiseSelect.addEventListener("change", (e) =>
    controller.setNoiseReduction(e.target.value),
  );
}

fsDeviceMenu = createDeviceMenu({
  menuEl: els.fsDeviceMenu,
  getModel: () => deviceModel,
  actions: {
    switchMicrophone: controller.switchMicrophone,
    switchSpeaker: controller.switchSpeaker,
    switchCamera: controller.switchCamera,
    setNoiseReduction: controller.setNoiseReduction,
  },
  onOpenChange: () => {
    if (stage.isFullscreen()) showFsControls();
  },
});

// --- Room chooser (join screen) --------------------------------------------
// The chooser sits on the join screen for BOTH the landing root `/` and a
// `/room/<name>` URL — only the preselection differs:
//   - `/`         → preselect the most recently visited room (history).
//   - `/room/x`   → preselect the room from the address bar (force-included in
//                   the list even if it isn't in history yet), so a wrong
//                   bookmark can be corrected before joining.
// A trailing "Anslut till ett annat rum…" sentinel reveals a free-text field.
// Empty history on the bare landing root → free text only (no dropdown).
const ROOM_SELECT_OTHER = "__other__";

// The raw room string from whichever control is active: free text wins when the
// dropdown is hidden (nothing to pick) or the "another room" sentinel is chosen.
function selectedRoomRaw() {
  if (els.roomSelect.hidden || els.roomSelect.value === ROOM_SELECT_OTHER) {
    return els.roomInput.value;
  }
  return els.roomSelect.value;
}

// The chosen room as a joinable canonical name, or null when it's blank or
// folds to the reserved default ("main") — which is never a valid target.
function chosenRoomOrNull() {
  const raw = selectedRoomRaw().trim();
  if (!raw) return null;
  const room = sanitizeRoomName(raw);
  return room === DEFAULT_ROOM ? null : room;
}

function syncRoomInputVisibility() {
  els.roomInput.hidden = !(
    els.roomSelect.hidden || els.roomSelect.value === ROOM_SELECT_OTHER
  );
}

// Keep the join button disabled until there's both a name and a valid room, so
// a blank free-text room never silently routes anywhere (no error text needed).
function updateJoinValidity() {
  els.joinBtn.disabled = !(els.nameInput.value.trim() && chosenRoomOrNull());
}

// (Re)build the chooser options for the current URL. Called whenever the join
// screen is (re)shown (initial load, leave, popstate), so the preselection
// always tracks the address bar. Listeners are attached once (below).
function rebuildRoomChooser() {
  els.roomChooser.hidden = false;
  const urlRoom = isNamedRoom() ? canonicalRoom() : null;
  // URL room first (force-included), then history (deduped). Nothing is written
  // to history until an actual successful join.
  const rooms = [];
  if (urlRoom) rooms.push(urlRoom);
  for (const r of readRoomHistory()) if (!rooms.includes(r)) rooms.push(r);

  els.roomSelect.innerHTML = "";
  if (rooms.length === 0) {
    // Bare landing root with no history: skip the empty dropdown, use free text.
    els.roomSelect.hidden = true;
    document.getElementById("room-select-label")?.setAttribute("for", "room-input");
  } else {
    els.roomSelect.hidden = false;
    document.getElementById("room-select-label")?.setAttribute("for", "room-select");
    for (const room of rooms) {
      const opt = document.createElement("option");
      opt.value = room;
      opt.textContent = room;
      els.roomSelect.appendChild(opt);
    }
    const other = document.createElement("option");
    other.value = ROOM_SELECT_OTHER;
    other.textContent = "Anslut till ett annat rum…";
    els.roomSelect.appendChild(other);
    // Preselect the URL room on /room/x, else the most recent (first) room.
    els.roomSelect.value = urlRoom ?? rooms[0];
  }
  els.roomInput.value = "";
  syncRoomInputVisibility();
  updateJoinValidity();
}

els.roomSelect.addEventListener("change", () => {
  syncRoomInputVisibility();
  if (els.roomSelect.value === ROOM_SELECT_OTHER) els.roomInput.focus();
  updateJoinValidity();
});
els.roomInput.addEventListener("input", updateJoinValidity);
els.nameInput.addEventListener("input", updateJoinValidity);

rebuildRoomChooser();

// --- Room presence: history + "share the link" onboarding ------------------
// The controller calls onPresence on welcome (joined:true) and on every peer
// join/leave. On a fresh join we record the room in history; if we land alone
// in a named room we surface a one-time arrow nudging the user to copy + share
// the link. Anyone joining (or copying the link) dismisses it.
const SHARE_ONBOARDING_MS = 5_000;
// The onboarding decision is made once per *room session* (SPA: one page load
// can span several). On the FIRST join of a session we either show the arrow (if
// alone) or not, but mark it handled either way so a reconnect — which
// re-welcomes, possibly with a briefly-empty roster while peers reconnect — can
// never re-pop it. The flag is reset when we tear down to the landing/join
// screen (showJoinView), so the next room session re-evaluates.
let shareOnboardingHandled = false;
let shareOnboardingTimer = null;
// Whether we currently have an active room session (room view shown). Drives the
// popstate reconcile: navigating away from an active room tears it down.
let inRoom = false;

function onPresence(peerCount, { joined = false } = {}) {
  if (joined && isNamedRoom()) {
    recordRoomVisit(canonicalRoom());
    // First join only: show iff alone, but mark handled regardless so reconnects
    // don't re-pop it.
    if (!shareOnboardingHandled) {
      shareOnboardingHandled = true;
      if (peerCount === 0) showShareOnboarding();
    }
  }
  if (peerCount > 0) hideShareOnboarding();
}

function showShareOnboarding() {
  if (!isNamedRoom() || els.roomNameRow?.hidden) return;
  if (!els.shareOnboarding || !els.copyLinkBtn) return;
  els.shareOnboarding.hidden = false;
  els.copyLinkBtn.classList.add("is-onboarding");
  positionShareArrow();
  armShareOnboardingHide();
}

// Point the bubble's arrow at the copy-link button. The button sits just after
// the room name, whose width varies, so the arrow x can't be a CSS constant —
// measure the button's centre relative to the (left-anchored) bubble and clamp
// it inside the bubble. Re-run on resize while the bubble is showing.
function positionShareArrow() {
  const bubble = els.shareOnboarding;
  const btn = els.copyLinkBtn;
  if (!bubble || !btn || bubble.hidden) return;
  const btnRect = btn.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  if (!bubbleRect.width) return;
  const inset = 10; // keep the arrow off the rounded corners
  const x = Math.max(
    inset,
    Math.min(bubbleRect.width - inset, btnRect.left + btnRect.width / 2 - bubbleRect.left),
  );
  bubble.style.setProperty("--share-arrow-left", `${Math.round(x)}px`);
}

// (Re)start the auto-hide countdown — but never while the "Bästa möjliga ljud"
// info modal is open, since it covers the arrow. The timer is cleared on modal
// open and re-armed on close (below), so the user always gets the full 5s with
// the arrow actually visible.
function armShareOnboardingHide() {
  clearTimeout(shareOnboardingTimer);
  shareOnboardingTimer = null;
  if (els.infoDialog?.open) return;
  shareOnboardingTimer = setTimeout(hideShareOnboarding, SHARE_ONBOARDING_MS);
}

// Pause the countdown (info modal opening over the arrow). Idempotent.
function pauseShareOnboardingHide() {
  clearTimeout(shareOnboardingTimer);
  shareOnboardingTimer = null;
}

function shareOnboardingVisible() {
  return !!els.shareOnboarding && !els.shareOnboarding.hidden;
}

function hideShareOnboarding() {
  clearTimeout(shareOnboardingTimer);
  shareOnboardingTimer = null;
  if (els.shareOnboarding) els.shareOnboarding.hidden = true;
  els.copyLinkBtn?.classList.remove("is-onboarding");
}

els.shareOnboarding?.addEventListener("click", hideShareOnboarding);

// While the info modal covers the arrow, hold the countdown; resume with a fresh
// full 5s once it closes (only if the arrow is still showing).
els.infoDialog?.addEventListener("close", () => {
  if (shareOnboardingVisible()) armShareOnboardingHide();
});

els.joinForm.addEventListener("submit", onJoinSubmit);

// Reflect a room into the address bar + tab title without reloading. `push`
// adds a history entry (navigation); the initial canonicalization replaces.
function reflectRoomUrl(room, { push = true } = {}) {
  const target = roomPathForRoom(room);
  if (location.pathname !== target) {
    try {
      if (push) history.pushState({ room }, "", target);
      else history.replaceState(history.state, "", target);
    } catch {}
  }
  renderRoomName();
  document.title = isNamedRoom() ? `babbla — ${canonicalRoom()}` : "babbla";
}

// Show the in-room view (after a successful join).
function showRoomView() {
  inRoom = true;
  els.joinView.hidden = true;
  els.roomView.hidden = false;
  ui.setRoomControlsEnabled(false);
  scheduleEnvBannerCollapse();
  // Mic is live now (join resolved): show the audio-setup guidance once.
  maybeAutoShowInfoModal();
}

// Show the join screen (landing `/` or a `/room/x` join screen). Rebuilds the
// chooser for the current URL and resets the per-room onboarding decision so the
// next room session re-evaluates.
function showJoinView() {
  inRoom = false;
  els.roomView.hidden = true;
  els.joinView.hidden = false;
  hideShareOnboarding();
  shareOnboardingHandled = false;
  if (els.infoDialog?.open) els.infoDialog.close();
  rebuildRoomChooser();
}

async function onJoinSubmit(e) {
  e.preventDefault();
  const name = els.nameInput.value.trim();
  if (!name) return;
  const room = chosenRoomOrNull();
  if (!room) {
    // No valid room (blank free text) — reveal/focus the field instead of
    // silently routing to the default room.
    els.roomInput.hidden = false;
    els.roomInput.focus();
    return;
  }
  saveLastName(name);
  ui.setError("");

  // SPA navigate: update the URL to the chosen room (no reload) then connect.
  // Joining the room we're already on (a direct /room/x visit) is in-place, so
  // it doesn't push a duplicate history entry.
  reflectRoomUrl(room, { push: location.pathname !== roomPathForRoom(room) });

  const targetPath = roomPathForRoom(room);
  els.joinBtn.disabled = true;
  const ok = await controller.join(name, { room });
  els.joinBtn.disabled = false;
  // If the user navigated away during the mic prompt (popstate → cancel), the
  // URL no longer points at the room we tried to join: the join was aborted and
  // the view already reset, so don't proceed or show a (misleading) mic error.
  if (location.pathname !== targetPath) return;
  if (!ok) {
    ui.setError("Kunde inte komma åt mikrofonen. Tillåt mick-access och försök igen.");
    return;
  }
  showRoomView();
}

// Deploy-restore (a controlled reload on a new server build): re-join the same
// room automatically. Returns whether it took over. Only ever restores into an
// actual named room (a legacy `roomPath='/'` snapshot must not drop a landing
// visitor into the default room under the SPA model).
async function tryAutoRestoreAfterDeploy() {
  const snap = readPendingRestore();
  if (!snap || !snapshotMatchesRoom(snap)) {
    if (snap && !snapshotMatchesRoom(snap)) clearSessionRestore();
    return false;
  }
  if (!isNamedRoom()) {
    clearSessionRestore();
    return false;
  }

  // A restored session was already in the room — don't pop the "share the link"
  // onboarding just because peers are mid-reconnect and the roster is briefly
  // empty.
  shareOnboardingHandled = true;
  els.nameInput.value = snap.name;
  saveLastName(snap.name);
  els.joinView.hidden = true;
  els.roomView.hidden = false;
  ui.setStatus("Återansluter efter uppdatering…");
  ui.setRoomControlsEnabled(false);

  const ok = await controller.join(snap.name, { room: canonicalRoom(), restore: snap });
  if (!ok) {
    clearSessionRestore();
    els.joinView.hidden = false;
    els.roomView.hidden = true;
    ui.setRestoreFailed("Kunde inte återställa efter uppdatering — gå med igen");
    return true;
  }
  inRoom = true;
  scheduleEnvBannerCollapse();
  return true;
}

// Browser back/forward: reconcile the connection to the URL. Leaving an active
// room tears it down (releasing the mic); landing on a room URL shows its join
// screen (preselected) rather than auto-joining (see the plan, decision B).
// A join whose mic prompt is still open (inRoom not yet true) must also be
// cancelled — otherwise it would resolve and open the room behind the now-shown
// landing/join screen.
window.addEventListener("popstate", () => {
  if (inRoom) controller.leaveToLanding();
  else controller.cancelPendingJoin();
  canonicalizeRoomUrl();
  showJoinView();
});

tryAutoRestoreAfterDeploy();

// Staging/dev env banner: once the user has been in the room a moment, fold the
// ribbon up (animated) into a thin colored strip so it stops eating vertical
// space while still hinting you're on a non-prod deployment. No-op on prod,
// where the server injects no banner. Scheduled once on first join (the dataset
// guard keeps a reconnect from re-arming it).
function scheduleEnvBannerCollapse() {
  const banner = document.querySelector(".env-banner");
  if (!banner || banner.dataset.collapseScheduled) return;
  banner.dataset.collapseScheduled = "1";
  setTimeout(() => banner.classList.add("is-collapsed"), 10_000);
}

// Leave the room back to the landing chooser — in-app (no reload), releasing the
// mic and resetting the per-room session. Pushes `/` so Back behaves naturally.
function leaveToLanding() {
  controller.leaveToLanding();
  if (location.pathname !== "/") {
    try {
      history.pushState({}, "", "/");
    } catch {}
  }
  canonicalizeRoomUrl();
  showJoinView();
}

els.leaveBtn.addEventListener("click", leaveToLanding);

window.addEventListener("pagehide", () => {
  fsDeviceMenu.destroy();
  controller.pagehideLeave();
});

// Mute label flip (view); the controller does the track/mesh toggle and calls
// back into this via ui.setMuteUi.
function setMuteUi(muted) {
  selfMuted = muted;
  const label = muted ? "Slå på min mick" : "Stäng av min mick";
  // aria-pressed="true" means the mic is ON (active/blue), matching the
  // camera/share buttons — NOT "mute is engaged". Keep this inverted from
  // `muted` so a future reader doesn't flip it back to "pressed = muted".
  els.muteBtn.setAttribute("aria-pressed", String(!muted));
  els.muteBtn.title = label;
  els.muteBtn.setAttribute("aria-label", label);
  els.fsMute.setAttribute("aria-pressed", String(!muted));
  els.fsMute.title = label;
  els.fsMute.setAttribute("aria-label", label);
  // Mirror onto our own tile (created later on join, so addSelfTileFor re-applies
  // this) and the stage if we're the focused participant.
  selfTile?.classList.toggle("is-muted", muted);
  updateStageMute();
}

els.muteBtn.addEventListener("click", () => controller.toggleMute());
els.cameraBtn.addEventListener("click", () => controller.toggleCamera());
els.fsMute.addEventListener("click", () => controller.toggleMute());
els.fsCamera.addEventListener("click", () => controller.toggleCamera());
els.fsShare.addEventListener("click", () => controller.toggleShare());
function openDeviceMenu(anchorEl, kind) {
  const wasOpenForAnchor =
    anchorEl.classList.contains("is-open") &&
    fsDeviceMenu.isOpen() &&
    fsDeviceMenu.getOpenKind() === kind;
  const opened = fsDeviceMenu.open(anchorEl, kind);
  Promise.resolve(refreshDeviceListsIfInRoom())
    .then(() => {
      if (fsDeviceMenu.isOpen() && fsDeviceMenu.getOpenKind() === kind) {
        fsDeviceMenu.refresh();
        return;
      }
      // If the initial open failed because the cached model was stale, retry once
      // after enumerateDevices completed. Do not reopen when this click meant
      // "close the already-open menu" on the same anchor.
      if (!opened && !wasOpenForAnchor) fsDeviceMenu.open(anchorEl, kind);
    })
    .catch(() => {});
}

els.muteMenuBtn.addEventListener("click", () => openDeviceMenu(els.muteMenuBtn, "audio"));
els.cameraMenuBtn.addEventListener("click", () =>
  openDeviceMenu(els.cameraMenuBtn, "camera"),
);
els.fsMuteMenuBtn.addEventListener("click", () =>
  openDeviceMenu(els.fsMuteMenuBtn, "audio"),
);
els.fsCameraMenuBtn.addEventListener("click", () =>
  openDeviceMenu(els.fsCameraMenuBtn, "camera"),
);
els.fsLeave.addEventListener("click", leaveToLanding);
els.fsExit.addEventListener("click", () => controller.exitFullscreen());
els.fullscreenBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  controller.enterFullscreen();
});

els.micSelect.addEventListener("change", (e) => controller.switchMicrophone(e.target.value));
els.cameraSelect.addEventListener("change", (e) => controller.switchCamera(e.target.value));
els.speakerSelect.addEventListener("change", (e) => controller.switchSpeaker(e.target.value));

function refreshDeviceListsIfInRoom() {
  if (els.roomView.hidden) return undefined;
  return controller.refreshDevices();
}

// Best-effort self-heal: if a browser misses a pure "default device changed"
// event, opening/focusing the picker refreshes the resolved "Systemstandard (X)"
// label from the latest enumerateDevices() snapshot.
els.micSelect.addEventListener("mousedown", refreshDeviceListsIfInRoom);
els.micSelect.addEventListener("focus", refreshDeviceListsIfInRoom);
els.speakerSelect.addEventListener("mousedown", refreshDeviceListsIfInRoom);
els.speakerSelect.addEventListener("focus", refreshDeviceListsIfInRoom);

// Hardware plugged in / removed, or the OS default moved, while in the room.
// Chrome fires one event per device *kind*, so pairing AirPods emits two (input
// and output) within milliseconds; coalesce them so the controller reconciles
// once against a settled device list instead of once per partial snapshot.
let deviceChangeTimer = null;
const DEVICE_CHANGE_DEBOUNCE_MS = 500;
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  if (deviceChangeTimer) clearTimeout(deviceChangeTimer);
  deviceChangeTimer = setTimeout(() => {
    deviceChangeTimer = null;
    refreshDeviceListsIfInRoom();
  }, DEVICE_CHANGE_DEBOUNCE_MS);
});

els.videoOffBtn.addEventListener("click", () => controller.toggleVideoOptOut());
els.dndBtn?.addEventListener("click", () => controller.toggleDnd());

els.shareBtn.addEventListener("click", () => controller.toggleShare());

els.cameraLimitDismiss.addEventListener("click", () => hideCameraLimitBanner());

els.screenWrap.addEventListener("click", (e) => {
  // The device menu is a body-level popover (not nested here), so it can't reach
  // this handler — only the in-stage controls need guarding.
  if (e.target.closest(".fullscreen-btn, .fs-controls")) return;
  controller.stageClick();
});

// Wake the auto-hidden module/label on any pointer activity over the stage.
els.screenWrap.addEventListener("pointermove", () => {
  if (stage.isFullscreen()) showFsControls();
});
els.screenWrap.addEventListener("pointerdown", () => {
  if (stage.isFullscreen()) showFsControls();
});

els.fsGrip.addEventListener("pointerdown", onGripPointerDown);
els.fsGrip.addEventListener("pointermove", onGripPointerMove);
els.fsGrip.addEventListener("pointerup", onGripPointerUp);
els.fsGrip.addEventListener("pointercancel", onGripPointerUp);

els.sidebarResizer.addEventListener("pointerdown", onSidebarResizePointerDown);
els.sidebarResizer.addEventListener("pointermove", onSidebarResizePointerMove);
els.sidebarResizer.addEventListener("pointerup", onSidebarResizePointerUp);
els.sidebarResizer.addEventListener("pointercancel", onSidebarResizePointerUp);
els.sidebarResizer.addEventListener("keydown", onSidebarResizeKeyDown);
els.sidebarResizer.addEventListener("dblclick", () =>
  setSidebarWidthPref(SIDEBAR_DEFAULT_WIDTH),
);

window.addEventListener("resize", () => {
  if (stage.isFullscreen()) applyFsControlsPosition();
  fsDeviceMenu.reposition();
  if (els.roomView.classList.contains("layout-expanded")) applySidebarWidth();
  if (shareOnboardingVisible()) positionShareArrow();
});

// The `.app` shell animates its width when entering the stage; re-apply the
// viewport-aware clamp the moment that transition lands.
document.querySelector(".app")?.addEventListener("transitionend", (e) => {
  if (e.propertyName !== "width") return;
  if (els.roomView.classList.contains("layout-expanded")) applySidebarWidth();
});

els.enableAudioBtn.addEventListener("click", () => {
  for (const audio of blockedAudio) audio.play().catch(() => {});
  blockedAudio.clear();
  for (const ctx of audioContexts) ctx.resume?.().catch?.(() => {});
  els.enableAudioBtn.hidden = true;
});

function tryPlayAudio(audio) {
  const p = audio.play();
  if (p && typeof p.catch === "function") {
    p.catch(() => {
      blockedAudio.add(audio);
      els.enableAudioBtn.hidden = false;
    });
  }
}

// --- Join/leave notification chimes ----------------------------------------
// Short tones synthesized with Web Audio so no binary assets are needed and the
// server stays minimal. A rising chime when someone joins, a falling one when
// someone leaves (or drops out so they disappear from the room). The context is
// registered in `audioContexts` so the "aktivera ljud"-button can resume it if
// the browser's autoplay policy starts it suspended.
let notifyCtx = null;

function getNotifyCtx() {
  if (notifyCtx) return notifyCtx;
  try {
    notifyCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioContexts.add(notifyCtx);
    applySinkToCtx(notifyCtx);
  } catch {
    return null;
  }
  return notifyCtx;
}

function scheduleChime(ctx, freqs) {
  const now = ctx.currentTime;
  const step = 0.12;
  const noteDur = 0.16;
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = now + i * step;
    const end = start + noteDur;
    // Soft attack + exponential decay so it reads as a gentle chime, not a beep.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(ctx.destination);
    // Release the nodes once the note finishes so the audio graph doesn't grow
    // unbounded over a long call (each chime adds two nodes).
    osc.addEventListener("ended", () => {
      try { osc.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
    });
    osc.start(start);
    osc.stop(end + 0.02);
  });
}

function playChime(freqs) {
  // "Stör ej": suppress all audible presence pings (join/leave). Centralized here
  // so every chime path is covered; visual presence updates still happen.
  if (selfDnd) return;
  const ctx = getNotifyCtx();
  if (!ctx) return;
  if (ctx.state === "running") {
    scheduleChime(ctx, freqs);
    return;
  }
  // The autoplay policy hasn't been satisfied yet, so scheduling now would emit
  // nothing. Try to resume and play once that resolves; if it stays suspended,
  // surface the same "aktivera ljud"-button used for blocked <audio> so the user
  // can unlock audio for future chimes.
  Promise.resolve(ctx.resume?.()).then(
    () => {
      if (ctx.state === "running") scheduleChime(ctx, freqs);
      else els.enableAudioBtn.hidden = false;
    },
    () => {
      els.enableAudioBtn.hidden = false;
    },
  );
}

function playJoinSound() {
  playChime([523.25, 783.99]); // C5 → G5 (rising)
}

function playLeaveSound() {
  playChime([783.99, 523.25]); // G5 → C5 (falling)
}

// Raw room name from the URL: the FIRST path segment after `/room/` (the regex
// stops at the next `/`, so `/room/x/anything` -> `x`). Empty for `/` and any
// non-room path. The canonical name (what room you're actually in + what we show)
// comes from running this through the shared `sanitizeRoomName`.
function currentRoom() {
  const m = location.pathname.match(/^\/room\/([^/]+)/);
  if (!m) return "";
  // Malformed percent-encoding (e.g. a literal `%` in the name, or `/room/%E0`)
  // makes decodeURIComponent throw; since this runs during page init, an uncaught
  // throw would break canonicalization + the WS connect. Fall back to the raw
  // segment so the name stays usable (sanitizeRoomName cleans it up downstream).
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

// The room you are actually in: the canonical (lowercased, capped) name shared
// with the server's routing key. `DEFAULT_ROOM` ("main") for the bare `/` and for
// any name that folds to the default.
function canonicalRoom() {
  const raw = currentRoom();
  return raw ? sanitizeRoomName(raw) : DEFAULT_ROOM;
}

// A named room is anything that isn't the shared default. Only named rooms get a
// subtitle / a `/room/<name>` URL; the default lives at bare `/`.
function isNamedRoom() {
  return canonicalRoom() !== DEFAULT_ROOM;
}

// Make the address bar agree with the room you're actually in: rewrite to the
// bare canonical path so URL == displayed name == room key. `/room/SmartTV/x` ->
// `/room/smarttv`; anything that folds to the default -> `/`. No reload, no new
// history entry.
function canonicalizeRoomUrl() {
  const named = isNamedRoom();
  const target = named ? `/room/${encodeURIComponent(canonicalRoom())}` : "/";
  // Only touch the path when we came in via a room URL (or already differ), so we
  // never rewrite unrelated paths. Bare `/room` (no name) counts as a room path so
  // it collapses to `/` like `/room/` does, instead of lingering as an odd URL.
  const onRoomPath =
    location.pathname === "/room" || location.pathname.startsWith("/room/");
  if (!onRoomPath && !named) return;
  if (location.pathname === target) return;
  try {
    history.replaceState(history.state, "", target + location.search + location.hash);
  } catch {}
}

// Show the canonical room name (+ a copy-link button) under the `babbla` wordmark
// in the sidebar; hidden for the default room. Plain text (no markup injection) +
// a tooltip carrying the full name in case it's truncated in the layout.
function renderRoomName() {
  if (!els.roomNameRow || !els.roomName) return;
  if (isNamedRoom()) {
    const name = canonicalRoom();
    els.roomName.textContent = name;
    els.roomName.title = name;
    els.roomNameRow.hidden = false;
  } else {
    els.roomName.textContent = "";
    els.roomName.removeAttribute("title");
    els.roomNameRow.hidden = true;
  }
}

// The clean, shareable link to the current room: always the canonical path on
// this origin (no query/hash), so a copied link drops anyone straight into the
// same room. The default room lives at bare `/`, not `/room/main`.
function roomLink() {
  if (!isNamedRoom()) return `${location.origin}/`;
  return `${location.origin}/room/${encodeURIComponent(canonicalRoom())}`;
}

// Copy text via the async Clipboard API, falling back to a hidden-textarea
// execCommand for older/insecure contexts. Resolves to whether it succeeded.
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Copy-link button: copy the room link, then swap the copy icon to a check for a
// few seconds to confirm. Rapid clicks just restart the timer.
const COPY_CONFIRM_MS = 3000;
let copyLinkResetTimer = null;
els.copyLinkBtn?.addEventListener("click", async () => {
  // Copying is the action the onboarding arrow points at — dismiss it on click
  // even if the clipboard write ends up failing.
  hideShareOnboarding();
  const ok = await copyToClipboard(roomLink());
  if (!ok) return;
  els.copyLinkBtn.classList.add("is-copied");
  els.copyLinkBtn.title = "Länk kopierad";
  els.copyLinkBtn.setAttribute("aria-label", "Länk kopierad");
  clearTimeout(copyLinkResetTimer);
  copyLinkResetTimer = setTimeout(() => {
    els.copyLinkBtn.classList.remove("is-copied");
    els.copyLinkBtn.title = "Kopiera länk till rummet";
    els.copyLinkBtn.setAttribute("aria-label", "Kopiera länk till rummet");
  }, COPY_CONFIRM_MS);
});

// Controls that depend on a live socket/mesh are disabled while reconnecting and
// re-enabled on `welcome`. Mute stays available (it only flips a local track) and
// leave stays available. Mirrors the startup gating: share needs getDisplayMedia
// support, camera is blocked while the user has opted out of video.
function setRoomControlsEnabled(enabled, { videoOptOut = false } = {}) {
  controlsEnabled = enabled;
  selfVideoOptOut = videoOptOut;
  applyControlsDisabled();
}

// Single source of truth for which control buttons are disabled, folding in the
// three independent inputs: the live socket/mesh gate (reconnect), video opt-out,
// and DND. Camera needs all three; share needs the gate + getDisplayMedia; the
// video-off + DND toggles need the gate. Mute is normally always available — only
// DND disables it (the mic capture is stopped while "away", nothing to mute).
function applyControlsDisabled() {
  const camBlocked = !controlsEnabled || selfVideoOptOut || selfDnd;
  els.cameraBtn.disabled = camBlocked;
  els.cameraMenuBtn.disabled = camBlocked;
  els.fsCamera.disabled = camBlocked;
  els.fsCameraMenuBtn.disabled = camBlocked;
  if (camBlocked && fsDeviceMenu.getOpenKind() === "camera") {
    fsDeviceMenu.close({ restoreFocus: false });
  }
  els.muteBtn.disabled = selfDnd;
  els.muteMenuBtn.disabled = selfDnd;
  els.fsMute.disabled = selfDnd;
  els.fsMuteMenuBtn.disabled = selfDnd;
  if (selfDnd && fsDeviceMenu.getOpenKind() === "audio") {
    fsDeviceMenu.close({ restoreFocus: false });
  }
  els.videoOffBtn.disabled = !controlsEnabled || selfDnd;
  if (els.dndBtn) els.dndBtn.disabled = !controlsEnabled;
  const shareBlocked = !controlsEnabled || !canShareScreen || selfDnd;
  els.shareBtn.disabled = shareBlocked;
  els.fsShare.disabled = shareBlocked;
}

// Keep one stable MediaStream per (map, peer): build a new one only when the
// underlying track actually changes. reclassify runs several times per share/
// camera event, and reassigning a <video>'s srcObject each time makes the
// element flash black while it waits for a fresh keyframe — the intermittent
// "black screen on share start". Returning the *same* object lets the callers
// skip the srcObject reset entirely.
function setStableStream(map, peerId, track) {
  if (!track) {
    map.delete(peerId);
    return null;
  }
  const existing = map.get(peerId);
  if (existing && existing.getVideoTracks()[0] === track) return existing;
  const stream = new MediaStream([track]);
  map.set(peerId, stream);
  return stream;
}

// --- Device dropdowns (view) -----------------------------------------------
// The controller enumerates devices and computes the active/preferred ids; these
// helpers just paint the <select>s. Programmatic <select> changes (innerHTML /
// "change" event, so rebuilding or re-pointing a dropdown can't re-trigger a
// device switch — no re-entrancy guard needed.
function selectHasSameOptions(select, options) {
  if (select.options.length !== options.length) return false;
  for (let i = 0; i < options.length; i += 1) {
    const cur = select.options[i];
    const next = options[i];
    if (!cur || cur.value !== next.value || cur.textContent !== next.text) return false;
  }
  return true;
}

function applySelectOptions(select, options) {
  if (selectHasSameOptions(select, options)) return;
  select.replaceChildren(
    ...options.map(({ value, text }) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      return opt;
    }),
  );
}

function populateDeviceSelect(select, devices, fallbackLabel, currentId) {
  const previous = select.value;
  const options = devices.map((device, i) => ({
    value: device.deviceId,
    text: device.label || `${fallbackLabel} ${i + 1}`,
  }));
  const has = (id) => options.some((o) => o.value === id);
  const target = has(currentId)
    ? currentId
    : has(previous)
      ? previous
      : devices[0]?.deviceId || "";
  applySelectOptions(select, options);
  select.value = target;
}

// Resolve the focused peer+role to a concrete media stream for the stage. The
// director decides *what* is focused (ids + roles + isSelf); this maps that to
// the actual stream the renderer paints from the view layer's own display
// handles (no media in the pure director, no reach into the orchestration).
function getFocusStream(peerId, type, isSelf) {
  if (isSelf) return type === "screen" ? uiLocalScreen : uiLocalCamera;
  return type === "screen" ? peerScreen.get(peerId) : peerCamera.get(peerId);
}

function getFocusLabel(peerId, type, isSelf) {
  const name = peerNames.get(peerId) || "";
  if (type === "screen") {
    return isSelf ? "Du delar din skärm" : `${name} delar sin skärm`;
  }
  return isSelf ? "Din kamera" : name;
}

// --- Fullscreen ("teater") -------------------------------------------------
// A viewport-covering overlay pinned to one remote focus. Entering pins the
// current active focus so incoming shares are hidden instead of auto-switched;
// leaving (button / Esc / the pinned target disappearing) returns to normal.
// The director owns the pin and auto-clears it when the target leaves the
// stage; these functions are the imperative DOM side. renderStage drives them
// from view.fullscreen so an auto-cleared pin tears the overlay down on the
// next render — no separate "is the pin still valid?" check lives here.
function enterFullscreenDom() {
  document.body.classList.add("fullscreen-stage");
  els.roomView.classList.add("fs-active");
  els.fsControls.hidden = false;
  applyFsControlsPosition();
  showFsControls();
  window.addEventListener("keydown", onFsKeydown, true);
}

function teardownFullscreenDom() {
  fsDeviceMenu.close({ restoreFocus: false });
  document.body.classList.remove("fullscreen-stage");
  els.roomView.classList.remove("fs-active");
  els.screenWrap.classList.remove("fs-idle");
  els.fsControls.hidden = true;
  clearTimeout(fsHideTimer);
  fsHideTimer = null;
  fsDrag = null;
  window.removeEventListener("keydown", onFsKeydown, true);
}

// Idempotent: bring the fullscreen overlay in line with the director's pin.
function syncFullscreenDom(on) {
  const domOn = document.body.classList.contains("fullscreen-stage");
  if (on && !domOn) enterFullscreenDom();
  else if (!on && domOn) teardownFullscreenDom();
}

function onFsKeydown(e) {
  if (e.key === "Escape" && fsDeviceMenu.isOpen()) {
    e.preventDefault();
    e.stopPropagation();
    fsDeviceMenu.close();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    actions.exitFullscreen();
  }
}

function clampFsPos(x, y) {
  const m = els.fsControls;
  const w = m.offsetWidth || 0;
  const h = m.offsetHeight || 0;
  const maxX = Math.max(8, window.innerWidth - w - 8);
  const maxY = Math.max(8, window.innerHeight - h - 8);
  return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
}

// Apply the remembered drag position (clamped), or fall back to the CSS default
// (bottom-right) when the module hasn't been moved this page load.
function applyFsControlsPosition() {
  const m = els.fsControls;
  if (!fsControlsPos) {
    m.style.left = m.style.top = m.style.right = m.style.bottom = "";
    return;
  }
  const { x, y } = clampFsPos(fsControlsPos.x, fsControlsPos.y);
  fsControlsPos = { x, y };
  m.style.left = `${x}px`;
  m.style.top = `${y}px`;
  m.style.right = "auto";
  m.style.bottom = "auto";
}

function showFsControls() {
  els.screenWrap.classList.remove("fs-idle");
  clearTimeout(fsHideTimer);
  fsHideTimer = setTimeout(() => {
    if (stage.isFullscreen() && !fsDrag && !fsDeviceMenu.isOpen()) {
      els.screenWrap.classList.add("fs-idle");
    }
  }, 3_000);
}

function onGripPointerDown(e) {
  if (!stage.isFullscreen()) return;
  e.preventDefault();
  fsDeviceMenu.close({ restoreFocus: false });
  const rect = els.fsControls.getBoundingClientRect();
  fsDrag = { id: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
  try {
    els.fsGrip.setPointerCapture(e.pointerId);
  } catch {}
  showFsControls();
}

function onGripPointerMove(e) {
  if (!fsDrag || e.pointerId !== fsDrag.id) return;
  const pos = clampFsPos(e.clientX - fsDrag.dx, e.clientY - fsDrag.dy);
  fsControlsPos = pos;
  const m = els.fsControls;
  m.style.left = `${pos.x}px`;
  m.style.top = `${pos.y}px`;
  m.style.right = "auto";
  m.style.bottom = "auto";
}

function onGripPointerUp(e) {
  if (!fsDrag || e.pointerId !== fsDrag.id) return;
  try {
    els.fsGrip.releasePointerCapture(e.pointerId);
  } catch {}
  fsDrag = null;
  showFsControls();
}

// --- Picture-in-Picture ("bild-i-bild") ------------------------------------
// Pop the focused stage video into a floating, always-on-top window so the user
// can keep watching whoever is in focus while the browser is in the background.
//
// Platform reality (see also AGENTS.md): fully *automatic* PiP on backgrounding
// is not available to a web page in Safari. `requestPictureInPicture()` from a
// `visibilitychange` listener throws "not triggered by user activation", and the
// prefixed `webkitSetPresentationMode('picture-in-picture')` is accepted
// silently but renders nothing. So the reliable, cross-browser path is a
// user-gesture button: once the user taps it the floating window persists when
// Safari is backgrounded — which is the goal, minus the automation. On Chromium
// we additionally wire the Media Session `enterpictureinpicture` action (and a
// best-effort visibility fallback), which *does* give real auto-PiP on tab/app
// switch and harmlessly no-ops elsewhere.
const stageVideo = els.screenVideo;

// Did the *current* PiP window open automatically (backgrounding) rather than by
// the user clicking the PiP button? An automatic PiP is undone when the tab
// comes back to the foreground so the user is never left looking at a black
// inline stage; a manual PiP is left floating until they close it themselves.
let pipAutoEntered = false;

function pipSupported() {
  if (document.pictureInPictureEnabled && !stageVideo.disablePictureInPicture) {
    return true;
  }
  // Older Safari: prefixed presentation-mode API.
  return (
    typeof stageVideo.webkitSupportsPresentationMode === "function" &&
    stageVideo.webkitSupportsPresentationMode("picture-in-picture")
  );
}

function isInPip() {
  return (
    document.pictureInPictureElement === stageVideo ||
    stageVideo.webkitPresentationMode === "picture-in-picture"
  );
}

async function enterPip(auto = false) {
  if (!stageVideo.srcObject || isInPip() || !pipSupported()) return;
  try {
    if (
      document.pictureInPictureEnabled &&
      typeof stageVideo.requestPictureInPicture === "function"
    ) {
      await stageVideo.requestPictureInPicture();
    } else if (typeof stageVideo.webkitSetPresentationMode === "function") {
      stageVideo.webkitSetPresentationMode("picture-in-picture");
    }
    // Only remember the "automatic" origin once PiP actually opened, so a
    // declined automatic attempt doesn't later trip the foreground auto-exit.
    if (isInPip()) pipAutoEntered = auto;
  } catch {
    // No transient activation (e.g. an automatic attempt), or the platform
    // declined. The manual button remains the reliable path.
  }
  updatePipButton();
}

async function exitPip() {
  pipAutoEntered = false;
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (stageVideo.webkitPresentationMode === "picture-in-picture") {
      stageVideo.webkitSetPresentationMode("inline");
    }
  } catch {}
  updatePipButton();
}

function togglePip() {
  if (isInPip()) exitPip();
  else enterPip();
}

// The button is only meaningful when a stream is actually on the stage and the
// platform supports PiP at all. Reconciled from applyFocusView / renderStage.
function updatePipButton() {
  const hasStream = !!stageVideo.srcObject;
  els.pipBtn.hidden = !pipSupported() || !hasStream;
  const active = isInPip();
  els.pipBtn.setAttribute("aria-pressed", String(active));
  // The label/tooltip must describe what a click does *now*: a click while
  // already floating closes PiP, otherwise it opens it.
  const label = active ? "Stäng bild-i-bild" : "Visa i bild-i-bild";
  els.pipBtn.title = active ? "Stäng bild-i-bild" : "Bild-i-bild (flytande fönster)";
  els.pipBtn.setAttribute("aria-label", label);
}

els.pipBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  togglePip();
});

// The OS PiP chrome (or returning to the tab) can close PiP without going
// through our button; mirror that back into the button state and forget the
// automatic-origin flag once the window is gone.
stageVideo.addEventListener("enterpictureinpicture", updatePipButton);
stageVideo.addEventListener("leavepictureinpicture", () => {
  pipAutoEntered = false;
  updatePipButton();
});
stageVideo.addEventListener("webkitpresentationmodechanged", updatePipButton);

// Best-effort automatic PiP on backgrounding. On Chromium the Media Session
// action fires on tab/app switch and is allowed to enter PiP without a fresh
// gesture; the visibility fallback covers other Chromium paths. Both are fully
// guarded — in Safari they no-op (per the platform note above), leaving the
// manual button as the working path there.
if ("mediaSession" in navigator) {
  try {
    navigator.mediaSession.setActionHandler("enterpictureinpicture", () => {
      enterPip(/*auto*/ true);
    });
  } catch {}
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (!stageVideo.srcObject || isInPip()) return;
    enterPip(/*auto*/ true);
    return;
  }
  // Back in the foreground: undo an automatic PiP so the inline stage isn't left
  // black ("video is playing in picture-in-picture"). A PiP the user opened by
  // hand is theirs to keep — leave it floating.
  if (pipAutoEntered && isInPip()) exitPip();
});

// --- Resizable stage sidebar -----------------------------------------------
function readSidebarWidthPref() {
  let stored = null;
  // localStorage access can throw (SecurityError) when storage is blocked;
  // fall back to the default instead of crashing at load (cf. loadLastName).
  try {
    stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  } catch {}
  const raw = Number.parseInt(stored ?? "", 10);
  if (!Number.isFinite(raw)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, raw));
}

// Map an intended width to an applied width: clamped to [MIN, MAX] and, when the
// room is laid out, further capped so the stage keeps at least STAGE_MIN_WIDTH.
function clampSidebarWidth(desired) {
  let w = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, desired));
  const rv = els.roomView;
  if (rv && rv.classList.contains("layout-expanded")) {
    const styles = getComputedStyle(rv);
    const padX =
      parseFloat(styles.paddingLeft || "0") + parseFloat(styles.paddingRight || "0");
    const avail = rv.clientWidth - padX - SIDEBAR_RESIZER_COL;
    const viewportMax = avail - STAGE_MIN_WIDTH;
    if (viewportMax >= SIDEBAR_MIN_WIDTH) w = Math.min(w, viewportMax);
    else w = SIDEBAR_MIN_WIDTH;
  }
  return Math.round(w);
}

// Apply the current preference to the grid + accessibility state. Called when
// entering the stage layout and on window resize. Never persists (that happens
// on the user gesture) so a resize can't overwrite the saved intent.
function applySidebarWidth() {
  const applied = clampSidebarWidth(sidebarWidthPref);
  els.roomView.style.setProperty("--sidebar-width", `${applied}px`);
  els.sidebarResizer.setAttribute("aria-valuenow", String(applied));
}

function setSidebarWidthPref(desired, { persist = true } = {}) {
  sidebarWidthPref = Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(desired)),
  );
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthPref));
    } catch {}
  }
  applySidebarWidth();
}

function onSidebarResizePointerDown(e) {
  if (!els.roomView.classList.contains("layout-expanded")) return;
  e.preventDefault();
  sidebarResizePointer = e.pointerId;
  els.sidebarResizer.classList.add("dragging");
  try {
    els.sidebarResizer.setPointerCapture(e.pointerId);
  } catch {}
}

function onSidebarResizePointerMove(e) {
  if (sidebarResizePointer === null || e.pointerId !== sidebarResizePointer) return;
  // If the button was released outside the viewport/window the pointerup can be
  // lost, leaving the drag "stuck" so it keeps resizing when the cursor returns.
  // A move with no buttons held means the release was missed — end the drag.
  if (e.buttons === 0) {
    endSidebarResize(e.pointerId);
    return;
  }
  const rect = els.roomView.getBoundingClientRect();
  const padR = parseFloat(getComputedStyle(els.roomView).paddingRight || "0");
  const rightEdge = rect.right - padR;
  // Width = distance from the pointer (handle centre) to the sidebar's right edge.
  // Pass the raw width: setSidebarWidthPref clamps it to [MIN, MAX] (the stored
  // intent), and the single applySidebarWidth call inside does the viewport-aware
  // clamp for the applied width — so dragging past the viewport cap preserves the
  // intent for wider windows instead of pinning it to the cap.
  const width = rightEdge - e.clientX - SIDEBAR_RESIZER_COL / 2;
  setSidebarWidthPref(width, { persist: false });
}

function onSidebarResizePointerUp(e) {
  if (sidebarResizePointer === null || e.pointerId !== sidebarResizePointer) return;
  endSidebarResize(e.pointerId);
}

// End the active resize drag: release capture, clear state, and persist the
// final pick (intent clamped to [MIN, MAX], viewport cap dropped so a wider
// window restores it). Shared by pointerup/pointercancel and the "missed
// release" recovery in pointermove.
function endSidebarResize(pointerId) {
  if (sidebarResizePointer === null) return;
  try {
    els.sidebarResizer.releasePointerCapture(pointerId);
  } catch {}
  sidebarResizePointer = null;
  els.sidebarResizer.classList.remove("dragging");
  setSidebarWidthPref(sidebarWidthPref);
}

function onSidebarResizeKeyDown(e) {
  let next = sidebarWidthPref;
  switch (e.key) {
    case "ArrowLeft":
    case "ArrowDown":
      next += SIDEBAR_KEY_STEP;
      break;
    case "ArrowRight":
    case "ArrowUp":
      next -= SIDEBAR_KEY_STEP;
      break;
    case "Home":
      next = SIDEBAR_MAX_WIDTH;
      break;
    case "End":
      next = SIDEBAR_MIN_WIDTH;
      break;
    default:
      return;
  }
  e.preventDefault();
  setSidebarWidthPref(next);
}

function renderStage(view) {
  // An auto-cleared pin (target left the stage) shows up as view.fullscreen
  // false here, which tears the overlay down.
  syncFullscreenDom(view.fullscreen);
  renderScreenTile(view.gridSharerTile);

  currentStageFocus = view.focus;
  updateStageMute();
  updateStageDnd();

  if (!view.focus) {
    // Nothing in focus — close any floating window before the source goes.
    if (isInPip()) exitPip();
    els.screenVideo.srcObject = null;
    els.screenWrap.hidden = true;
    els.fullscreenBtn.hidden = true;
    applyLayout(view);
    updatePipButton();
    updateFocusIndicators(view);
    syncParticipantLayout(view.participantCount);
    return;
  }

  els.fullscreenBtn.hidden = !view.fullscreenButtonVisible;

  const { peerId, type, isSelf } = view.focus;
  const stream = getFocusStream(peerId, type, isSelf);
  const label = getFocusLabel(peerId, type, isSelf);

  if (els.screenVideo.srcObject !== (stream || null)) {
    els.screenVideo.srcObject = stream || null;
  }
  els.screenLabel.textContent = stream ? label : `${label}…`;
  els.screenWrap.hidden = false;
  if (stream && els.screenVideo.paused) els.screenVideo.play?.().catch(() => {});

  applyLayout(view);
  updatePipButton();
  updateFocusIndicators(view);
  syncParticipantLayout(view.participantCount);
}

// Map the director's layoutMode (+ localSmallShare) to the room CSS classes.
function applyLayout(view) {
  document.body.classList.remove(
    "room-compact",
    "room-compact-wide",
    "room-expanded",
    "room-gallery",
  );
  els.roomView.classList.remove(
    "layout-compact",
    "layout-compact-wide",
    "layout-expanded",
    "local-share-stage",
    "gallery",
  );

  switch (view.layoutMode) {
    case "expanded":
      els.roomView.classList.add("layout-expanded");
      document.body.classList.add("room-expanded");
      if (view.localSmallShare) els.roomView.classList.add("local-share-stage");
      applySidebarWidth();
      // `.app` width animates (180ms) when entering the stage, so the first
      // measurement above sees the pre-transition width. Re-apply once it
      // settles so the viewport-aware clamp uses the final width.
      requestAnimationFrame(applySidebarWidth);
      clearTimeout(sidebarSettleTimer);
      sidebarSettleTimer = setTimeout(() => {
        if (els.roomView.classList.contains("layout-expanded")) applySidebarWidth();
      }, 220);
      break;
    case "gallery":
      els.roomView.classList.add("layout-compact", "gallery");
      document.body.classList.add("room-gallery");
      break;
    case "compact-wide":
      els.roomView.classList.add("layout-compact", "layout-compact-wide");
      document.body.classList.add("room-compact-wide");
      break;
    default:
      els.roomView.classList.add("layout-compact");
      document.body.classList.add("room-compact");
  }
}

function setShareButton(on) {
  const label = on ? "Sluta dela skärm" : "Dela skärm";
  els.shareBtn.setAttribute("aria-pressed", String(on));
  if (canShareScreen) {
    els.shareBtn.title = label;
    els.shareBtn.setAttribute("aria-label", label);
  } else {
    els.shareBtn.title = "Den här webbläsaren eller enheten kan inte starta skärmdelning.";
    els.shareBtn.setAttribute("aria-label", "Dela skärm – inte tillgängligt på den här enheten");
  }
  els.fsShare.setAttribute("aria-pressed", String(on));
  els.fsShare.title = label;
  els.fsShare.setAttribute("aria-label", label);
}

function setCameraButton(on) {
  const label = on ? "Stäng av kamera" : "Slå på kamera";
  els.cameraBtn.classList.toggle("off", !on);
  els.cameraBtn.setAttribute("aria-pressed", String(on));
  els.cameraBtn.title = label;
  els.cameraBtn.setAttribute("aria-label", label);
  els.fsCamera.classList.toggle("off", !on);
  els.fsCamera.setAttribute("aria-pressed", String(on));
  els.fsCamera.title = label;
  els.fsCamera.setAttribute("aria-label", label);
}

function setVideoOffButton(on) {
  els.videoOffBtn.textContent = on ? "Slå på video" : "Stäng av video för mig";
  els.videoOffBtn.setAttribute("aria-pressed", String(on));
}

// Reflect the local video opt-out: update the toggle label and block the camera
// controls (you can't turn the camera on while opted out of video entirely).
function setVideoOptOutUi(on) {
  selfVideoOptOut = on;
  setVideoOffButton(on);
  applyControlsDisabled();
}

function showCameraLimitBanner() {
  els.cameraLimitBanner.hidden = false;
  clearTimeout(cameraLimitTimer);
  cameraLimitTimer = setTimeout(hideCameraLimitBanner, 10_000);
}

function hideCameraLimitBanner() {
  els.cameraLimitBanner.hidden = true;
  clearTimeout(cameraLimitTimer);
  cameraLimitTimer = null;
}

// --- Video grid ------------------------------------------------------------
function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Mic-off glyph (a muted microphone with a slash), shared by the tile and stage
// badges. Inline SVG so there are no binary assets (matches the rest of the UI).
// Injected into both surfaces from here (the tile via createTile, the stage's
// `#screen-mute` below) so the markup lives in exactly one place.
const MIC_OFF_SVG =
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
  `<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z" />` +
  `<path d="M5 11a7 7 0 0 0 14 0M12 18v3" />` +
  `<line x1="4" y1="3" x2="20" y2="21" />` +
  `</svg>`;

// The stage badge element ships empty in index.html; fill it from the shared
// glyph so the tile and stage never drift apart.
if (els.screenMute) els.screenMute.innerHTML = MIC_OFF_SVG;

// "Stör ej" (Do Not Disturb) glyph — a crescent moon, the universal DND symbol.
// Inline SVG (no binary assets), shared by the tile badge and the stage badge.
// This participant hears/sees no one (and sends nothing); the moon subsumes the
// mic-off badge (a DND peer is necessarily silent too).
const MOON_SVG =
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
  `<path d="M20 14.5A8 8 0 0 1 9.5 4 6.5 6.5 0 1 0 20 14.5z" />` +
  `</svg>`;

if (els.screenDnd) els.screenDnd.innerHTML = MOON_SVG;

function createTile(id, name, isSelf = false) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "video-tile" + (isSelf ? " self" : "");
  tile.dataset.id = id;
  tile.dataset.focusType = "camera";
  tile.setAttribute("aria-label", isSelf ? "Fokusera din kamera" : `Fokusera ${name}`);
  tile.innerHTML =
    `<span class="video-tile-media">` +
    `<video autoplay playsinline muted></video>` +
    `<div class="video-tile-placeholder"></div>` +
    `<span class="dot"></span>` +
    `<span class="tile-mute" title="Mick avstängd" aria-label="Mick avstängd">${MIC_OFF_SVG}</span>` +
    `<span class="tile-dnd" title="Stör ej" aria-label="Stör ej — hör och ser inte andra">${MOON_SVG}</span>` +
    `<span class="connection-warning connection-warning--uncertain">osäker</span>` +
    `<span class="connection-warning connection-warning--connecting">ansluter</span>` +
    `</span>` +
    `<span class="video-tile-name"></span>`;
  tile.querySelector(".video-tile-placeholder").textContent = initials(name);
  tile.querySelector(".video-tile-name").textContent = isSelf ? `${name} (du)` : name;
  tile.addEventListener("click", onTileFocusClick);
  return tile;
}

function onTileFocusClick(e) {
  const tile = e.currentTarget;
  const peerId = tile.dataset.peerId || tile.dataset.id;
  const type = tile.dataset.focusType === "screen" ? "screen" : "camera";
  if (type === "camera" && !tile.classList.contains("has-video")) return;
  actions.focusTile(peerId, type);
}

function ensureScreenTile(peerId, name) {
  if (screenTiles.has(peerId)) return screenTiles.get(peerId);
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "video-tile screen-tile";
  tile.dataset.peerId = peerId;
  tile.dataset.focusType = "screen";
  tile.setAttribute("aria-label", `Fokusera skärmdelning från ${name}`);
  tile.innerHTML =
    `<span class="video-tile-media">` +
    `<video autoplay playsinline muted></video>` +
    `<div class="video-tile-placeholder">🖥</div>` +
    `</span>` +
    `<span class="video-tile-name"></span>`;
  tile.querySelector(".video-tile-name").textContent = `${name} – skärm`;
  tile.addEventListener("click", onTileFocusClick);
  screenTiles.set(peerId, tile);
  els.videoGrid.appendChild(tile);
  return tile;
}

function removeScreenTile(peerId) {
  const tile = screenTiles.get(peerId);
  if (!tile) return;
  tile.remove();
  screenTiles.delete(peerId);
}

function updateScreenTile(peerId, stream) {
  const tile = screenTiles.get(peerId);
  if (!tile) return;
  const video = tile.querySelector("video");
  if (video.srcObject !== (stream || null)) video.srcObject = stream || null;
  tile.classList.toggle("has-video", !!stream);
  if (stream && video.paused) video.play?.().catch(() => {});
}

// The director decides whether (and which) sharer shows as a grid thumbnail;
// this just reconciles the tile DOM to that single id, resolving name/stream.
function renderScreenTile(gridSharerTile) {
  for (const pid of [...screenTiles.keys()]) {
    if (pid !== gridSharerTile) removeScreenTile(pid);
  }
  if (!gridSharerTile) return;
  const stream = peerScreen.get(gridSharerTile);
  const name = peerNames.get(gridSharerTile) || "Deltagare";
  ensureScreenTile(gridSharerTile, name);
  updateScreenTile(gridSharerTile, stream || null);
}

function updateFocusIndicators(view) {
  const f = view.focus;
  for (const [id, tile] of tiles) {
    const focused = f?.peerId === id && f?.type === "camera";
    tile.classList.toggle("is-focused", focused);
    tile.setAttribute("aria-pressed", String(focused));
  }
  for (const [pid, tile] of screenTiles) {
    const focused = f?.peerId === pid && f?.type === "screen";
    tile.classList.toggle("is-focused", focused);
    tile.setAttribute("aria-pressed", String(focused));
  }
  els.screenWrap.classList.toggle("is-focused", f?.type === "screen");
  els.screenWrap.classList.toggle("can-reset-focus", view.hasUserFocus);
  currentStageBaseTitle = view.hasUserFocus
    ? "Klicka för att återgå till skärmdelning som standard"
    : view.sharerId === uiSelfId && uiLocalScreen
      ? "Klicka för att förstora förhandsvisningen"
      : "";
  // Mirror the focused peer's relay state (purple ring + tooltip) on top of the
  // base title; this also runs out-of-band from setPeerRelayed.
  applyStageRelay();
}

function ensureTile(id, name) {
  peerNames.set(id, name);
  if (tiles.has(id)) return tiles.get(id);
  const tile = createTile(id, name);
  tiles.set(id, tile);
  els.videoGrid.appendChild(tile);
  // A fresh peer starts out connecting (the mesh hasn't reported a live link
  // yet), so paint the "ansluter" badge right away — it clears once the
  // connectionState callback reports "connected".
  setPeerConnecting(id, true);
  return tile;
}

function removeTile(id) {
  peerNames.delete(id);
  // Drop any stale "uncertain"/"connecting" overlay so a peer that left while
  // glitching doesn't linger in the sets (and can't paint a stale row if an id
  // is reused).
  uncertainPeers.delete(id);
  connectingPeers.delete(id);
  relayedPeers.delete(id);
  mutedPeers.delete(id);
  dndPeers.delete(id);
  peerIceErrors.delete(id);
  renderIceHealth();
  const tile = tiles.get(id);
  if (!tile) return;
  tile.remove();
  tiles.delete(id);
}

function updateTileVideo(id, stream) {
  const tile = tiles.get(id);
  if (!tile) return;
  const video = tile.querySelector("video");
  if (video.srcObject !== (stream || null)) video.srcObject = stream || null;
  tile.classList.toggle("has-video", !!stream);
  if (stream && video.paused) video.play?.().catch(() => {});
}

function updateSelfTileVideo(stream) {
  if (!selfTile) return;
  const video = selfTile.querySelector("video");
  if (video.srcObject !== (stream || null)) video.srcObject = stream || null;
  selfTile.classList.toggle("has-video", !!stream);
  if (stream && video.paused) video.play?.().catch(() => {});
}

// Reveal the grid and flag the "many participants" layout from the participant
// count the stage already derives (1 self + roster), so this never reaches into
// the mesh. Driven by render(view).
function syncParticipantLayout(participantCount) {
  els.videoGrid.hidden = false;
  els.roomView.classList.toggle("participants-many", (participantCount ?? 0) >= 5);
}

// --- Participant tiles -----------------------------------------------------
// Mirror of which peers the orchestration currently considers "uncertain"
// (1.5 s in `disconnected`). The diagnostics rail overlays this on top of the
// raw mesh connectionState so a glitching link shows yellow before it fails.
/** @type {Set<string>} */
const uncertainPeers = new Set();

// Mirror of which peers are still negotiating their WebRTC link ("connecting"/
// "new"). Surfaced on the tile as an "ansluter" badge, mirroring how
// `uncertainPeers` drives the "osäker" badge. Cleared once the link connects.
/** @type {Set<string>} */
const connectingPeers = new Set();

// Mirror of which peers we currently reach via the TURN relay (per-peer, from
// *our* side). Surfaced as a distinct purple tile/stage border so the user sees
// the link is relayed (working, but a different path) rather than direct P2P.
// Lower precedence than the transient "connecting"/"uncertain" border states.
/** @type {Set<string>} */
const relayedPeers = new Set();

// Mirror of which peers have muted their mic (cooperative presence relayed by
// the server), surfaced as a persistent mic-off badge on the tile / stage so
// others see the mic was deliberately turned off (vs. merely silent). Self mute
// is tracked separately (`selfMuted`) since it's driven by the local toggle.
/** @type {Set<string>} */
const mutedPeers = new Set();
let selfMuted = false;
// Mirror of which peers are in "Stör ej" (Do Not Disturb), surfaced as a moon
// badge on the tile / stage. Our own DND lives in `selfDnd` (declared early, up
// top, to avoid a deploy-restore TDZ) and drives the local presentation gate
// (dim tiles, hide incoming video, mute incoming audio, silence chimes). The
// moon subsumes the mic-off badge for a DND participant.
/** @type {Set<string>} */
const dndPeers = new Set();
// The focus the stage is currently painting (set by renderStage), so the mute
// badge / relay ring can be refreshed out-of-band when a (un)mute or relay change
// lands without a re-render.
let currentStageFocus = null;
// The stage tooltip without the relay note (set each render), so applyStageRelay
// can recompose the full title when relay status flips between renders.
let currentStageBaseTitle = "";

function setPeerUncertain(id, uncertain) {
  tiles.get(id)?.classList.toggle("connection-uncertain", uncertain);
  if (uncertain) uncertainPeers.add(id);
  else uncertainPeers.delete(id);
  // The health box only lists errors on currently-stuck peers; drop this
  // peer's line the moment it is healthy again, and repaint so a leftover
  // 401 does not sit there after the last osäker tile recovers.
  clearPeerIceErrorIfHealthy(id);
  renderIceHealth();
}

function setPeerConnecting(id, connecting) {
  tiles.get(id)?.classList.toggle("connection-connecting", connecting);
  if (connecting) connectingPeers.add(id);
  else connectingPeers.delete(id);
  clearPeerIceErrorIfHealthy(id);
}

// A peer's link is (no longer) relayed via the server: toggle the purple relay
// border on their camera tile + screen tile, set the explanatory tooltip, and —
// if they're the focused participant — mirror the ring on the stage right away
// (the title catches up on the next render via updateFocusIndicators).
function setPeerRelayed(id, relayed) {
  if (relayed) relayedPeers.add(id);
  else relayedPeers.delete(id);
  const tile = tiles.get(id);
  if (tile) {
    tile.classList.toggle("connection-relayed", relayed);
    tile.title = relayed ? RELAY_TITLE : "";
  }
  screenTiles.get(id)?.classList.toggle("connection-relayed", relayed);
  // Mirror it on the peer's diagnostics row right away (the rail re-renders once
  // per stats sample, but relay can flip between samples — keep it in sync).
  const diagRow = els.diagnostics
    ? [...els.diagnostics.querySelectorAll(".diag-row")].find(
        (row) => row.dataset.peerId === id,
      )
    : null;
  if (diagRow) {
    diagRow.classList.toggle("is-relayed", relayed);
    if (relayed) diagRow.title = RELAY_TITLE;
    else diagRow.removeAttribute("title");
  }
  // Refresh the stage ring AND tooltip if this peer is the focused one (relay
  // status can flip without a re-render, so onRelayChanged must update both).
  applyStageRelay();
}

// Mirror the focused peer's relay state onto the stage: purple ring + a tooltip
// composed on top of the base title. Called from updateFocusIndicators (each
// render) and setPeerRelayed (out-of-band). Self is never relayed.
function applyStageRelay() {
  const f = currentStageFocus;
  const relayedFocus = !!f && !f.isSelf && relayedPeers.has(f.peerId);
  els.screenWrap.classList.toggle("is-relayed", relayedFocus);
  els.screenWrap.title = relayedFocus
    ? currentStageBaseTitle
      ? `${currentStageBaseTitle} · ${RELAY_TITLE}`
      : RELAY_TITLE
    : currentStageBaseTitle;
}

function setSpeaking(id, active) {
  tiles.get(id)?.querySelector(".dot")?.classList.toggle("speaking", active);
}

// A peer (un)muted their mic: toggle the persistent mic-off badge on their tile
// and refresh the stage badge in case they're the focused participant.
function setPeerMuted(id, muted) {
  if (muted) mutedPeers.add(id);
  else mutedPeers.delete(id);
  tiles.get(id)?.classList.toggle("is-muted", muted);
  updateStageMute();
}

// A peer entered/left DND: toggle the moon badge on their tile (CSS subsumes the
// mic-off badge under `.is-dnd`) and refresh the stage badge if focused.
function setPeerDnd(id, dnd) {
  if (dnd) dndPeers.add(id);
  else dndPeers.delete(id);
  tiles.get(id)?.classList.toggle("is-dnd", dnd);
  updateStageMute();
  updateStageDnd();
}

// Is the focused participant in DND? Self DND lives in `selfDnd`; peers in
// `dndPeers`. Drives the moon badge over the enlarged stage video (and lets the
// mute badge step aside for it).
function focusDnd() {
  const f = currentStageFocus;
  return !!f && (f.isSelf ? selfDnd : dndPeers.has(f.peerId));
}

// Is the focused participant muted? Self mute lives in `selfMuted`; peers in
// `mutedPeers`. Drives the mic-off badge over the enlarged stage video — hidden
// when DND is shown (the moon subsumes it).
function updateStageMute() {
  const f = currentStageFocus;
  const muted = !!f && (f.isSelf ? selfMuted : mutedPeers.has(f.peerId));
  if (els.screenMute) els.screenMute.hidden = !(muted && !focusDnd());
}

function updateStageDnd() {
  if (els.screenDnd) els.screenDnd.hidden = !focusDnd();
}

// Reflect our own "Stör ej" state: flip the button, mark our self-tile, show the
// hint, and drive the local presentation gate. The gate is the view-layer half
// of DND (the mesh is the cooperative-signal half): while active we dim the
// participant tiles + hide incoming video (via a `dnd-self` class on the room
// view) and mute every incoming <audio> element, so we truly hear/see no one
// even in the brief window before peers honor the flag. Releasing re-attaches:
// audio unmutes and the next render/track re-shows video.
function setDndUi(dnd) {
  selfDnd = dnd;
  if (els.dndBtn) {
    els.dndBtn.textContent = dnd ? "Avsluta Stör ej" : "Stör ej";
    els.dndBtn.setAttribute("aria-pressed", String(dnd));
  }
  if (els.dndHint) els.dndHint.hidden = !dnd;
  selfTile?.classList.toggle("is-dnd", dnd);
  els.roomView?.classList.toggle("dnd-self", dnd);
  for (const audio of peerAudios.values()) audio.muted = dnd;
  // DND disables the other media controls (mic capture is stopped; you re-enable
  // mic/camera/screen by leaving DND) — mirrors "Stäng av video för mig".
  applyControlsDisabled();
  updateStageMute();
  updateStageDnd();
}

// Route a peer's inbound audio into a dedicated <audio> element (the mesh only
// hands us the MediaStream) and wire a speaking meter onto its tile dot.
function setPeerAudio(peerId, stream) {
  let audio = peerAudios.get(peerId);
  if (!audio) {
    audio = new Audio();
    audio.autoplay = true;
    els.audioSink.appendChild(audio);
    peerAudios.set(peerId, audio);
  }
  const request = { stream };
  pendingPeerAudio.set(audio, request);
  const isCurrent = () => peerAudios.get(peerId) === audio && pendingPeerAudio.get(audio) === request;
  enqueueAudioOutput(async () => {
    if (!isCurrent()) return;
    // Chromium can keep playing on the default device if srcObject is assigned
    // while setSinkId is pending, even though sinkId later reports the chosen
    // speaker (crbug.com/971947). Attach only once routing has actually settled,
    // inside the queue so a simultaneous speaker change cannot race it either.
    await applySinkToElement(audio);
    if (!isCurrent()) return;
    audio.srcObject = stream;
    // Read DND at completion: it may have changed while routing was pending.
    audio.muted = selfDnd;
    tryPlayAudio(audio);
    peerMeters.get(peerId)?.stop();
    peerMeters.set(
      peerId,
      new VolumeMeter(stream, (active) => setSpeaking(peerId, active)),
    );
  });
}

// Per-peer view teardown: stop the meter, drop the <audio> element (and clear it
// from the autoplay-blocked set), forget its display streams, and remove its
// tiles. The orchestration's removeParticipant pairs this with the presence/
// mesh/focus cleanup it owns.
function removePeerMedia(id) {
  peerMeters.get(id)?.stop();
  peerMeters.delete(id);
  const audio = peerAudios.get(id);
  if (audio) {
    audio.srcObject = null;
    audio.remove();
    blockedAudio.delete(audio);
    if (blockedAudio.size === 0) els.enableAudioBtn.hidden = true;
  }
  peerAudios.delete(id);
  peerScreen.delete(id);
  peerCamera.delete(id);
  removeTile(id);
  removeScreenTile(id);
}

// Self-tile teardown (reconnect): drop the speaking meter, the tile, and the
// mirrored self id/name.
function removeSelfTile() {
  localMeter?.stop();
  localMeter = null;
  if (uiSelfId) peerNames.delete(uiSelfId);
  uiSelfId = null;
  if (selfTile) {
    selfTile.remove();
    selfTile = null;
  }
}

// (Re)build the self speaking meter against a mic stream; the dot only lights
// while the track is live and unmuted. Closes over the passed stream so it never
// reaches into the orchestration's mic handle.
function setSelfMicMeter(stream) {
  localMeter?.stop();
  localMeter = stream
    ? new VolumeMeter(stream, (active) => {
        const track = stream.getAudioTracks()[0];
        const speaking = active && !!track && track.enabled;
        selfTile?.querySelector(".dot")?.classList.toggle("speaking", speaking);
      })
    : null;
}

// Push already-gated inbound tracks (camera/screen) into stable display streams
// and paint the peer's camera tile. The stage is painted by render() from the
// stored streams; see setStableStream for why the stream object is reused.
function setPeerVideo(id, { cameraTrack = null, screenTrack = null } = {}) {
  setStableStream(peerScreen, id, screenTrack);
  updateTileVideo(id, setStableStream(peerCamera, id, cameraTrack));
}

// Local media as the view should render it (self-tile camera + focused stage).
function setLocalVideo({ camera = null, screen = null } = {}) {
  uiLocalCamera = camera;
  uiLocalScreen = screen;
  updateSelfTileVideo(uiLocalCamera);
}

// Forget one peer's inbound camera (its screen, if any, is untouched).
function clearPeerCamera(id) {
  peerCamera.delete(id);
  updateTileVideo(id, null);
}

// Forget every inbound camera (e.g. when *we* opt out of video).
function clearIncomingCameras() {
  for (const id of [...peerCamera.keys()]) clearPeerCamera(id);
}

// Camera-limit hard reset: forget every inbound camera and screen tile.
function clearAllVideo() {
  peerCamera.clear();
  for (const id of tiles.keys()) updateTileVideo(id, null);
  for (const id of [...screenTiles.keys()]) removeScreenTile(id);
}

// Drop the autoplay-blocked audio set and hide the "enable audio" affordance.
function clearBlockedAudio() {
  blockedAudio.clear();
  els.enableAudioBtn.hidden = true;
}

// Build the self tile + speaking meter for the local participant, and mirror the
// self id/name into the view layer (focus labels + the sharer tooltip).
function addSelfTileFor(id, name, micStream) {
  uiSelfId = id;
  peerNames.set(id, name);
  selfTile = createTile(id, name, true);
  // Re-apply our mute state: setMuteUi may have run (deploy-restore mutes before
  // connect) before this tile existed.
  selfTile.classList.toggle("is-muted", selfMuted);
  // Same for DND, which survives a reconnect that rebuilt the self tile.
  selfTile.classList.toggle("is-dnd", selfDnd);
  els.videoGrid.appendChild(selfTile);
  setSelfMicMeter(micStream);
}

// Fill the mic/camera dropdowns from enumerated devices, pointing each at the
// device currently capturing (or the remembered pick), and hide a picker when
// there's no real choice.
function snapshotSelectOptions(select) {
  return [...select.options].map((option) => ({
    value: option.value,
    label: option.textContent || "",
  }));
}

function hasSelectOption(select, value) {
  return [...select.options].some((option) => option.value === value);
}

function setSelectValueIfPresent(select, value) {
  if (!hasSelectOption(select, value)) return false;
  select.value = value;
  return true;
}

function refreshFsDeviceMenuIfOpen() {
  if (fsDeviceMenu.isOpen()) fsDeviceMenu.refresh();
}

function syncCameraMenuAvailability() {
  const hasCameraMenu = (deviceModel.cameraOptions?.length || 0) > 0;
  els.cameraMenuBtn.hidden = !hasCameraMenu;
  els.cameraSplit.classList.toggle("no-menu", !hasCameraMenu);
  els.cameraMenuBtn.disabled = els.cameraBtn.disabled;
  els.fsCameraMenuBtn.hidden = !hasCameraMenu;
  els.fsCameraSplit.classList.toggle("no-menu", !hasCameraMenu);
  els.fsCameraMenuBtn.disabled = els.fsCamera.disabled;
  if (!hasCameraMenu && fsDeviceMenu.getOpenKind() === "camera") {
    fsDeviceMenu.close({ restoreFocus: false });
  }
}

function populateDevices({
  mics,
  cams,
  speakers = [],
  micId,
  camId,
  micDefaultName = null,
  speakerDefaultName = null,
  hasMicDefault = false,
}) {
  populateMicSelect(els.micSelect, mics, micId, micDefaultName, hasMicDefault);
  populateDeviceSelect(els.cameraSelect, cams, "Kamera", camId);
  // On iOS the mic/speaker belong in the system settings, not the app — hide them.
  // Keep this concrete-count gate: with one physical mic, "Systemstandard (X)"
  // vs "X" is the same device and the chooser would be noise.
  els.micPicker.hidden = isIOS || mics.length < 2;
  els.cameraPicker.hidden = cams.length < 2;
  // The speaker picker only makes sense where output routing is supported (never
  // on iOS/Safari), so this is doubly hidden there.
  if (supportsAudioSink && !isIOS) {
    // Paint from the sink that is actually routed. The controller owns *which*
    // output to use (it walks the speaker stack and calls setAudioOutput); the
    // view only reports what came of it, so the dropdown can never claim a
    // device that isn't carrying audio.
    populateSpeakerSelect(speakers, currentSinkId, speakerDefaultName);
    els.speakerPicker.hidden = speakers.length < 2;
  } else {
    els.speakerPicker.hidden = true;
  }

  deviceModel = {
    ...deviceModel,
    mics: [...mics],
    cams: [...cams],
    speakers: [...speakers],
    micOptions: snapshotSelectOptions(els.micSelect),
    cameraOptions: snapshotSelectOptions(els.cameraSelect),
    speakerOptions: snapshotSelectOptions(els.speakerSelect),
    micId: els.micSelect.value || "",
    camId: els.cameraSelect.value || "",
    speakerId: supportsAudioSink && !isIOS ? currentSinkId : "",
    noiseLevel: els.noiseSelect?.value || deviceModel.noiseLevel || "lite",
    isIOS,
    supportsAudioSink,
  };
  syncCameraMenuAvailability();
  refreshFsDeviceMenuIfOpen();
}

// The speaker select differs from mic/camera: an explicit "Systemstandard"
// sentinel (value "") sits first so "follow the OS default output" is a real,
// selectable, representable state. That keeps the dropdown and the routed sink
// in lockstep — there's always an option matching whatever sink is applied,
// including the fallback after a chosen device disappears.
function formatSystemDefaultLabel(name) {
  return name ? `Systemstandard (${name})` : "Systemstandard";
}

// Mic picker with an explicit "follow OS default" sentinel first, mirroring the
// speaker picker and keeping behavior consistent across browsers (some expose a
// concrete `audioinput:default`, some do not).
function populateMicSelect(select, devices, currentId, defaultName, hasSystemDefault) {
  const options = [
    {
      value: "default",
      text: formatSystemDefaultLabel(defaultName),
    },
  ];
  options.push(
    ...devices.map((device, i) => ({
      value: device.deviceId,
      text: device.label || `Mikrofon ${i + 1}`,
    })),
  );
  const has = (id) => options.some((o) => o.value === id);
  // Preferred missing from the live list → Systemstandard as the active
  // fallback. Never silently select devices[0] (that looked like a user pick).
  const target = has(currentId) ? currentId : "default";
  applySelectOptions(select, options);
  select.value = target;
}

function populateSpeakerSelect(devices, currentId, defaultName) {
  const select = els.speakerSelect;
  const previous = select.value;
  const options = [
    {
      value: "",
      text: formatSystemDefaultLabel(defaultName),
    },
    ...devices.map((device, i) => ({
      value: device.deviceId,
      text: device.label || `Högtalare ${i + 1}`,
    })),
  ];
  const has = (id) => options.some((o) => o.value === id);
  // Prefer the remembered/active pick, then keep the prior selection, else fall
  // back to "Systemstandard" ("").
  const target = has(currentId) ? currentId : has(previous) ? previous : "";
  applySelectOptions(select, options);
  select.value = target;
}

// Re-point the dropdowns at the given live device ids without rebuilding the
// option lists (used after a device switch succeeds or is reverted).
function syncDeviceSelects({ micId, camId }) {
  let changed = false;
  if (micId && [...els.micSelect.options].some((o) => o.value === micId)) {
    els.micSelect.value = micId;
    deviceModel.micId = micId;
    changed = true;
  }
  if (camId && [...els.cameraSelect.options].some((o) => o.value === camId)) {
    els.cameraSelect.value = camId;
    deviceModel.camId = camId;
    changed = true;
  }
  if (changed) {
    deviceModel.micOptions = snapshotSelectOptions(els.micSelect);
    deviceModel.cameraOptions = snapshotSelectOptions(els.cameraSelect);
    refreshFsDeviceMenuIfOpen();
  }
}

// Fast path for menu actions that only changed the active/preferred value, not
// the device inventory itself. Keeps the cached model + mirrored sidebar selects
// in sync without re-enumerating hardware.
function syncActiveSelection({ speakerId, camId, noiseLevel } = {}) {
  let changed = false;
  if (speakerId !== undefined) {
    const target = speakerId ?? "";
    setSelectValueIfPresent(els.speakerSelect, target);
    deviceModel.speakerId = els.speakerSelect.value || target;
    deviceModel.speakerOptions = snapshotSelectOptions(els.speakerSelect);
    changed = true;
  }
  if (camId !== undefined) {
    const target = camId || "";
    if (target) setSelectValueIfPresent(els.cameraSelect, target);
    deviceModel.camId = els.cameraSelect.value || target;
    deviceModel.cameraOptions = snapshotSelectOptions(els.cameraSelect);
    changed = true;
  }
  if (noiseLevel !== undefined && els.noiseSelect) {
    setSelectValueIfPresent(els.noiseSelect, noiseLevel);
    deviceModel.noiseLevel = els.noiseSelect.value || noiseLevel;
    changed = true;
  }
  if (changed) {
    syncCameraMenuAvailability();
    refreshFsDeviceMenuIfOpen();
  }
}

// --- Audio output (speaker) routing ----------------------------------------
function enqueueAudioOutput(update) {
  const result = audioOutputQueue.then(update);
  // One failed update must not strand later voices or speaker selections.
  audioOutputQueue = result.catch(() => {});
  return result;
}

function ensureSinkProbe() {
  if (sinkProbeEl) return sinkProbeEl;
  if (typeof Audio === "undefined") return null;
  sinkProbeEl = new Audio();
  return sinkProbeEl;
}

function snapSinkToDefault() {
  currentSinkId = "";
  if (els.speakerSelect) els.speakerSelect.value = "";
  deviceModel.speakerId = "";
}

// Best-effort, independently guarded so one failing sink never blocks the rest.
function applySinkToElement(el) {
  if (!supportsAudioSink) return Promise.resolve();
  return el.setSinkId(currentSinkId).catch(() => {
    if (!currentSinkId) return undefined;
    snapSinkToDefault();
    return el.setSinkId("").catch(() => {});
  });
}

function applySinkToCtx(ctx) {
  if (!supportsCtxSink || !ctx?.setSinkId) return;
  try {
    Promise.resolve(ctx.setSinkId(currentSinkId)).catch(() => {});
  } catch {}
}

// Route every app sound (peer voices + chime context) to the chosen output. The
// idempotent authority: stores currentSinkId and retroactively applies it to all
// existing <audio> + the chime ctx. If the chosen device is gone, setSinkId
// rejects on the <audio> elements → fall back to the system default and re-point
// the dropdown so the UI never lies (the controller keeps the remembered pref).
function setAudioOutput(deviceId) {
  return enqueueAudioOutput(() => routeAudioOutput(deviceId));
}

async function routeAudioOutput(deviceId) {
  if (!supportsAudioSink) return true;
  const target = deviceId || "";
  let failed = false;
  const probe = ensureSinkProbe();
  if (probe && target) {
    try {
      await probe.setSinkId(target);
    } catch {
      failed = true;
    }
  }
  const applyTarget = failed ? "" : target;
  currentSinkId = applyTarget;
  const audios = [...peerAudios.values()];
  await Promise.all(
    audios.map((a) =>
      a.setSinkId(applyTarget).catch(() => {
        if (applyTarget) failed = true;
      }),
    ),
  );
  if (failed && applyTarget) {
    // Device vanished: drop back to the system default as the *active* sink.
    // Preferred stays in the controller — this must not look like the user
    // chose Systemstandard.
    snapSinkToDefault();
    await Promise.all([...peerAudios.values()].map((a) => a.setSinkId("").catch(() => {})));
    if (probe) probe.setSinkId("").catch(() => {});
  } else if (els.speakerSelect && [...els.speakerSelect.options].some((o) => o.value === currentSinkId)) {
    els.speakerSelect.value = currentSinkId;
  }
  deviceModel.speakerId = currentSinkId;
  deviceModel.speakerOptions = snapshotSelectOptions(els.speakerSelect);
  refreshFsDeviceMenuIfOpen();
  applySinkToCtx(notifyCtx);
  // Did the requested sink actually take? The controller uses this to fall
  // through to the next entry in the speaker stack.
  return currentSinkId === target;
}

function setStatus(text, live = false) {
  els.status.textContent = text;
  els.status.classList.toggle("live", live);
}

function setError(text) {
  els.joinError.textContent = text;
  els.joinError.hidden = !text;
}

function setRestoreFailed(text) {
  els.joinView.hidden = false;
  els.roomView.hidden = true;
  els.joinForm.querySelector("button").disabled = false;
  setError(text);
}

let upgradeToastTimer = null;

function showUpgradeRestoredToast() {
  if (!els.upgradeToast) return;
  clearTimeout(upgradeToastTimer);
  els.upgradeToast.textContent =
    "babbla har uppdaterats — du är tillbaka i samtalet";
  els.upgradeToast.hidden = false;
  upgradeToastTimer = setTimeout(() => {
    els.upgradeToast.hidden = true;
    upgradeToastTimer = null;
  }, UPGRADE_TOAST_MS);
}

// --- Live bandwidth meter + per-peer diagnostics ---------------------------
function startBandwidthMeter() {
  lastPeerSamples.clear();
  meterActive = true;
  els.bandwidth.hidden = false;
  setBandwidth(null);
  renderDiagnostics(null);
}

function stopBandwidthMeter() {
  meterActive = false;
  lastPeerSamples.clear();
  els.bandwidth.hidden = true;
  if (els.diagnostics) els.diagnostics.replaceChildren();
  peerIceErrors.clear();
  renderIceHealth();
}

// --- ICE / relay health ----------------------------------------------------
// The two facts that turn "someone is stuck on ansluter" into a diagnosis:
// whether a TURN relay is on offer at all (i.e. did this deployment actually
// set TURN_SECRET/TURN_URLS), and the exact reason a STUN/TURN server refused
// on a link that is stuck *right now*. Per-peer, latest-only — a healed pair
// drops its line, a newer error replaces the old one. Not session history.
let relayAvailable = null;
/** @type {Map<string, { peerId: string, hint: string, relay: boolean, errorCode: number }>} */
const peerIceErrors = new Map();

function peerLinkIsHealthy(id) {
  return tiles.has(id) && !connectingPeers.has(id) && !uncertainPeers.has(id);
}

function clearPeerIceErrorIfHealthy(id) {
  if (peerLinkIsHealthy(id)) peerIceErrors.delete(id);
}

function setRelayAvailable(available) {
  relayAvailable = !!available;
  renderIceHealth();
}

function setIceServerError(peerId, error) {
  if (!error || !peerId) return;
  // Don't park a gathering timeout on a healthy link — it would reappear
  // the next time this pair glitches.
  if (peerLinkIsHealthy(peerId)) return;
  peerIceErrors.set(peerId, {
    peerId,
    hint: error.hint,
    relay: !!error.relay,
    errorCode: Number(error.errorCode) || 0,
  });
  renderIceHealth();
}

function renderIceHealth() {
  const box = els.iceHealth;
  if (!box) return;
  const lines = [];
  // Only worth saying when there is no relay to fall back on: a STUN-only
  // deployment is exactly the case where a restrictive network can't connect.
  if (relayAvailable === false) {
    lines.push(
      '<span class="ice-health-line">Relä (TURN): ej konfigurerat — ' +
        "deltagare på nät som kräver relä kan inte ansluta.</span>",
    );
  }
  const visible = activeIceErrorsToShow([...peerIceErrors.values()], {
    uncertainIds: uncertainPeers,
  });
  if (visible.length) {
    lines.push('<span class="ice-health-heading">Fel från STUN/TURN:</span>');
    for (const err of visible) {
      lines.push(`<span class="ice-health-line">${escapeHtml(err.hint)}</span>`);
    }
  }
  box.innerHTML = lines.join("");
  box.hidden = lines.length === 0;
}

// Consume one per-peer stats sample pushed by the mesh sampler: diff the
// cumulative counters into rates and repaint the meter + diagnostics rail.
function pushPeerStats(peerStats) {
  if (!meterActive || !peerStats) return;
  const now = performance.now();

  let totalUp = 0;
  let totalDown = 0;
  // Per-peer derived view, keyed for fast lookup when rendering roster rows.
  /** @type {Map<string, { up: number, down: number, loss: number|null, rtt: number|null, state: string }>} */
  const derived = new Map();
  const seen = new Set();

  for (const s of peerStats) {
    seen.add(s.peerId);
    const prev = lastPeerSamples.get(s.peerId);
    lastPeerSamples.set(s.peerId, {
      t: now,
      bytesSent: s.bytesSent,
      bytesReceived: s.bytesReceived,
      packetsLost: s.packetsLost,
      packetsReceived: s.packetsReceived,
    });
    let up = 0;
    let down = 0;
    let loss = null;
    if (prev) {
      const dt = (now - prev.t) / 1000;
      if (dt > 0) {
        // Counters are cumulative per live connection; a reset (peer/link
        // dropped) yields a negative delta — clamp to 0 rather than show garbage.
        up = Math.max(0, ((s.bytesSent - prev.bytesSent) * 8) / 1000 / dt);
        down = Math.max(0, ((s.bytesReceived - prev.bytesReceived) * 8) / 1000 / dt);
        const lostDelta = Math.max(0, s.packetsLost - prev.packetsLost);
        const recvDelta = Math.max(0, s.packetsReceived - prev.packetsReceived);
        const denom = lostDelta + recvDelta;
        if (denom > 0) loss = (lostDelta / denom) * 100;
        else loss = 0;
      }
    }
    totalUp += up;
    totalDown += down;
    derived.set(s.peerId, {
      up,
      down,
      loss,
      rtt: s.rtt,
      state: s.state,
      iceServerError: s.iceServerError || null,
    });
  }

  // Prune samples for peers no longer reported by the mesh.
  for (const id of [...lastPeerSamples.keys()]) {
    if (!seen.has(id)) lastPeerSamples.delete(id);
  }

  setBandwidth({ up: totalUp, down: totalDown });
  renderDiagnostics(derived);
}

function setBandwidth(rates) {
  if (!rates) {
    els.bwUp.textContent = "– kbit/s";
    els.bwDown.textContent = "– kbit/s";
    return;
  }
  els.bwUp.textContent = formatBitrate(rates.up);
  els.bwDown.textContent = formatBitrate(rates.down);
}

// Render one diagnostic row per remote roster peer (matched on presence, not on
// live stats), so a peer whose connection is failing/restarting still shows a
// row — with connection state as the colour-coded primary signal — instead of
// silently dropping out. `derived` is the per-peer view from the latest sample
// (null before the first sample lands).
/** @param {Map<string, { up: number, down: number, loss: number|null, rtt: number|null, state: string }> | null} derived */
function renderDiagnostics(derived) {
  const container = els.diagnostics;
  if (!container) return;
  const rows = [];
  for (const [id, name] of peerNames) {
    if (id === uiSelfId) continue; // diagnostics describe *your* links to others
    const d = derived?.get(id) || null;
    // Overlay the orchestration's "uncertain" state on top of the raw mesh state.
    let state = d?.state || "connecting";
    if (uncertainPeers.has(id)) state = "uncertain";
    rows.push(diagnosticRowHtml(id, name, state, d, relayedPeers.has(id)));
  }
  container.innerHTML = rows.join("");
}

// State space is RTCPeerConnection.connectionState ("new" | "connecting" |
// "connected" | "disconnected" | "failed" | "closed") plus the orchestration's
// "uncertain" overlay — note "completed" is an ICE state, not a connection state.
function stateClass(state) {
  if (state === "connected") return "ok";
  if (state === "failed" || state === "closed") return "bad";
  if (state === "connecting" || state === "new") return "idle";
  return "warn"; // disconnected / uncertain
}

function stateLabel(state) {
  const map = {
    connected: "ansluten",
    connecting: "ansluter…",
    new: "ansluter…",
    disconnected: "glappar",
    uncertain: "osäker",
    failed: "trasig",
    closed: "stängd",
  };
  return map[state] || state;
}

function diagnosticRowHtml(id, name, state, d, relayed) {
  const cls = stateClass(state);
  const safeName = escapeHtml(name || "okänd");
  const up = d ? formatBitrate(d.up) : "–";
  const down = d ? formatBitrate(d.down) : "–";
  const loss = d && d.loss != null ? d.loss.toFixed(d.loss >= 10 ? 0 : 1) + "%" : "–";
  const rtt = d && d.rtt != null ? Math.round(d.rtt * 1000) + " ms" : "–";
  const lossWarn = d && d.loss != null && d.loss >= 3 ? " warn" : "";
  const relayCls = relayed ? " is-relayed" : "";
  // A link that never came up: the STUN/TURN error explains *why*, so put it in
  // the row's tooltip. A healed link must never retain that stale explanation;
  // mesh clears it on connect and this state gate is the defensive view seam.
  const iceHint = state === "connected" ? "" : (d?.iceServerError?.hint || "");
  const rowTitle = iceHint || (relayed ? RELAY_TITLE : "");
  return (
    `<div class="diag-row state-${cls}${relayCls}" data-peer-id="${escapeHtml(id)}"${rowTitle ? ` title="${escapeHtml(rowTitle)}"` : ""}>` +
    `<span class="diag-dot" aria-hidden="true"></span>` +
    `<span class="diag-name" title="${safeName}">${safeName}</span>` +
    `<span class="diag-state">${stateLabel(state)}</span>` +
    `<span class="diag-metric" title="upp / ner">↑ ${up} · ↓ ${down}</span>` +
    `<span class="diag-metric${lossWarn}" title="paketförlust">förlust ${loss}</span>` +
    `<span class="diag-metric" title="round-trip">rtt ${rtt}</span>` +
    `</div>`
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function formatBitrate(kbitPerSec) {
  if (kbitPerSec >= 1000) {
    return (kbitPerSec / 1000).toFixed(1) + " Mbit/s";
  }
  return Math.round(kbitPerSec) + " kbit/s";
}

// --- Lightweight speaking detector (Web Audio) -----------------------------
class VolumeMeter {
  constructor(stream, onChange) {
    this.onChange = onChange;
    this.active = false;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioContexts.add(this.ctx);
    if (this.ctx.state === "suspended") this.ctx.resume?.().catch?.(() => {});
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.data = new Uint8Array(this.analyser.frequencyBinCount);
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
    this.raf = requestAnimationFrame(() => this.tick());
  }
  tick() {
    this.analyser.getByteFrequencyData(this.data);
    let sum = 0;
    for (const v of this.data) sum += v;
    const avg = sum / this.data.length;
    const active = avg > 12;
    if (active !== this.active) {
      this.active = active;
      this.onChange(active);
    }
    this.raf = requestAnimationFrame(() => this.tick());
  }
  stop() {
    cancelAnimationFrame(this.raf);
    audioContexts.delete(this.ctx);
    try { this.source.disconnect(); } catch {}
    try { this.ctx.close(); } catch {}
  }
}
