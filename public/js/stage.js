// Stage — the client-derived "what is on the stage" decision, isolated from the
// DOM, WebRTC, and the WebSocket. It owns local focus intent (which peer/role is
// enlarged, whether we're in fullscreen) plus a mirror of server `Presence`
// (who shares screen, whose camera is on, who is in the room) and folds them
// into a single `StageView` value. The renderer reads `view()` and paints; a
// thin signaling adapter reads the intent fields (`cameraFocusTarget`,
// `suppressPeers`) and reconciles them onto the wire.
//
// Why a module: the focus/presence decision used to live as ~6 mutable globals
// and ~9 helpers in main.js, with the same "is this focus still valid?"
// invalidation re-implemented at 5+ call sites and ordering scars
// ("set the sharer first…"). Centralising it here makes the rule live in one
// place (locality) and testable without a browser (the interface is the test
// surface).
//
// Shape mirrors `createMesh`: a factory with private state and small mutators
// that each self-heal invalidation via `reconcile()`, plus a side-effect-free
// `view()` selector. Streams and names are intentionally absent — the director
// deals in ids + roles + booleans, and the renderer resolves id→stream/name so
// there is no second roster to drift.

/**
 * @typedef {{ peerId: string, type: "screen" | "camera" }} Focus
 * @typedef {{
 *   focus: { peerId: string, type: "screen" | "camera", isSelf: boolean } | null,
 *   fullscreen: boolean,
 *   fullscreenButtonVisible: boolean,
 *   layoutMode: "expanded" | "gallery" | "compact-wide" | "compact",
 *   localSmallShare: boolean,
 *   gridSharerTile: string | null,
 *   selfCameraEnlarged: boolean,
 *   cameraFocusTarget: string | null,
 *   suppressPeers: Set<string>,
 *   hasUserFocus: boolean,
 *   participantCount: number,
 *   sharerId: string | null,
 * }} StageView
 */

export function createStageDirector() {
  let selfId = null;
  // Server-authoritative presence, mirrored locally.
  let sharerId = null;
  /** Peer ids (including self) whose camera is on. */
  const cameras = new Set();
  /** Other peers in the room (self is implicit, counted as +1). */
  const roster = new Set();
  // Local intent.
  let videoOptedOut = false;
  /** @type {Focus | null} */
  let userFocus = null;
  // Fullscreen pin: overrides the normal active-focus computation so incoming
  // shares are hidden rather than auto-switched to. Only ever a remote peer.
  /** @type {Focus | null} */
  let fullscreenPin = null;

  function defaultFocus() {
    return sharerId ? { peerId: sharerId, type: "screen" } : null;
  }

  // Pin first (fullscreen wins), then explicit user pick, then the sharer.
  function activeFocus() {
    return fullscreenPin || userFocus || defaultFocus();
  }

  function peerPresent(peerId) {
    return peerId === selfId || roster.has(peerId);
  }

  // A user focus is valid while its target is present and still showing the
  // thing focused: a screen focus needs that peer to be the current sharer, a
  // camera focus needs that peer's camera on (and us not opted out of video).
  function focusValid(f) {
    if (!f) return false;
    const { peerId, type } = f;
    if (!peerPresent(peerId)) return false;
    if (type === "camera" && videoOptedOut) return false;
    if (type === "screen") return sharerId === peerId;
    return cameras.has(peerId);
  }

  // A pin is valid only while its remote target still exists on the stage.
  // Mirrors focusValid but pins are remote-only and ignore our own video
  // opt-out (you cannot reach the opt-out control while pinned).
  function pinValid(f) {
    if (!f) return false;
    const { peerId, type } = f;
    if (peerId === selfId || !roster.has(peerId)) return false;
    if (type === "screen") return sharerId === peerId;
    return cameras.has(peerId);
  }

  // Drop intent that no longer points at something real. Run at the end of
  // every mutator so `view()` can stay a pure read of consistent state.
  function reconcile() {
    if (userFocus && !focusValid(userFocus)) userFocus = null;
    if (fullscreenPin && !pinValid(fullscreenPin)) fullscreenPin = null;
  }

  // --- mutators (events in) ------------------------------------------------

  function setSelfId(id) {
    selfId = id;
    reconcile();
  }

  function setSharer(id) {
    sharerId = id || null;
    reconcile();
  }

  function setCamera(id, on) {
    if (on) cameras.add(id);
    else cameras.delete(id);
    reconcile();
  }

  function clearAllCameras() {
    cameras.clear();
    reconcile();
  }

  function peerJoined(id) {
    if (id && id !== selfId) roster.add(id);
    reconcile();
  }

  function peerLeft(id) {
    roster.delete(id);
    cameras.delete(id);
    if (sharerId === id) sharerId = null;
    reconcile();
  }

  // Toggle: clicking the already-focused target clears the focus.
  function focusClick(peerId, type) {
    if (userFocus && userFocus.peerId === peerId && userFocus.type === type) {
      userFocus = null;
    } else {
      userFocus = { peerId, type };
    }
    reconcile();
  }

  function clearUserFocus() {
    userFocus = null;
    reconcile();
  }

  // Pin the current active focus. Returns whether it actually entered (only a
  // remote focus can be pinned), so the renderer knows whether to open the
  // overlay.
  function enterFullscreen() {
    if (fullscreenPin) return false;
    const focus = activeFocus();
    if (!focus || focus.peerId === selfId) return false;
    fullscreenPin = { peerId: focus.peerId, type: focus.type };
    return true;
  }

  function exitFullscreen() {
    if (!fullscreenPin) return false;
    fullscreenPin = null;
    return true;
  }

  function setSelfVideoOptOut(on) {
    videoOptedOut = !!on;
    reconcile();
  }

  // Tear the room state down (unexpected WS drop). A fresh `welcome` rebuilds
  // it via the mutators above; the renderer keeps the mic alive separately.
  function reset() {
    selfId = null;
    sharerId = null;
    cameras.clear();
    roster.clear();
    videoOptedOut = false;
    userFocus = null;
    fullscreenPin = null;
  }

  // --- selectors (state out) -----------------------------------------------

  /** @returns {StageView} */
  function view() {
    const focus = activeFocus();
    const focusObj = focus
      ? { peerId: focus.peerId, type: focus.type, isSelf: focus.peerId === selfId }
      : null;
    const fullscreen = fullscreenPin !== null;
    const hasUserFocus = userFocus !== null;
    const participantCount = 1 + roster.size;

    let layoutMode;
    if (focusObj) layoutMode = "expanded";
    else if (cameras.size > 0) layoutMode = "gallery";
    else if (participantCount >= 5) layoutMode = "compact-wide";
    else layoutMode = "compact";

    const localSmallShare =
      !!focusObj && focusObj.isSelf && focusObj.type === "screen" && !hasUserFocus;

    // Show the sharer as a grid thumbnail only when the user has picked a
    // non-screen focus (so they can click back), and the share isn't on stage.
    let gridSharerTile = null;
    if (sharerId && sharerId !== selfId && userFocus && userFocus.type !== "screen") {
      const screenOnStage =
        focus && focus.peerId === sharerId && focus.type === "screen";
      if (!screenOnStage) gridSharerTile = sharerId;
    }

    const selfCameraEnlarged =
      !!userFocus && userFocus.peerId === selfId && userFocus.type === "camera";

    const cameraFocusTarget =
      focus && focus.type === "camera" && focus.peerId !== selfId
        ? focus.peerId
        : null;

    const suppressPeers = new Set();
    if (fullscreenPin) {
      for (const id of roster) {
        if (id !== fullscreenPin.peerId) suppressPeers.add(id);
      }
    }

    return {
      focus: focusObj,
      fullscreen,
      fullscreenButtonVisible: !!focusObj && !fullscreen && !focusObj.isSelf,
      layoutMode,
      localSmallShare,
      gridSharerTile,
      selfCameraEnlarged,
      cameraFocusTarget,
      suppressPeers,
      hasUserFocus,
      participantCount,
      sharerId,
    };
  }

  return {
    setSelfId,
    setSharer,
    setCamera,
    clearAllCameras,
    peerJoined,
    peerLeft,
    focusClick,
    clearUserFocus,
    enterFullscreen,
    exitFullscreen,
    setSelfVideoOptOut,
    reset,
    view,
    // Presence reads for the renderer's video classification (mid→role gating).
    getSharerId: () => sharerId,
    hasCamera: (peerId) => cameras.has(peerId),
    isFullscreen: () => fullscreenPin !== null,
  };
}
