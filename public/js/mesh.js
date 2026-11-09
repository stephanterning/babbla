// Mesh module — full P2P WebRTC mesh: perfect negotiation, ICE buffering,
// local track sync, and inbound track dispatch. No DOM; callers wire callbacks.

const SCREEN_MAX_BITRATE = 1_500_000;
const DEFAULT_CAMERA_MAX_BITRATE = 250_000;

// ICE-restart recovery. A connection that drops to "failed" (or sits in
// "disconnected") is NOT torn down — we attempt an ICE restart with capped
// exponential backoff while the peer is still in the room. The WebSocket
// signaling path is independent of the P2P media path, so the restart
// offer/answer gets relayed even when media has died; this heals a transient
// blip (ICE consent loss, network handover, NAT rebinding) that would
// otherwise sit "failed" forever. Authoritative removal is left to the server
// (a real departure arrives as `peer-left`), so a recoverable hiccup never
// permanently severs a pair. The polite peer waits one extra base interval so
// the common case has a single restart offerer (no glare); if the impolite
// side is the one that vanished, the polite side still escalates next cycle.
const ICE_RESTART_BASE_MS = 2_000;
const ICE_RESTART_MAX_MS = 10_000;

// Offer-retransmit watchdog. The ICE-restart recovery above only fires once a
// connection has *been* established and later drops (connectionState
// "failed"/"disconnected"). It can't heal a pair that wedges during the very
// first negotiation: if the impolite peer's initial offer (or the polite peer's
// answer) is lost on the wire, the offerer sits in "have-local-offer" forever
// and the polite peer — which deliberately suppresses its own initial offer —
// waits for one that never arrives. ICE never starts, so connectionState stays
// "new" and nothing triggers a retry. We arm a timer whenever we enter
// "have-local-offer"; if no answer returns in time we re-send the *same* offer
// (and role map) over the independent, still-live WebSocket. Re-sending the
// existing local description (rather than an ICE restart) keeps the ICE ufrag
// stable so candidates already delivered/buffered at the peer still match, and
// the answerer is sitting in "stable" so it simply answers — no glare. Backs
// off, capped, and keeps retrying until the answer lands (back to "stable") or
// the peer is removed. Also covers a lost *renegotiation* offer (e.g. a camera
// added after connect), since that too leaves the offerer in "have-local-offer".
const OFFER_RETRANSMIT_BASE_MS = 4_000;
const OFFER_RETRANSMIT_MAX_MS = 12_000;

// Initial-connect watchdog. Both recovery mechanisms above are armed from a
// *state transition*: the ICE-restart backoff from connectionState
// "failed"/"disconnected", the offer retransmit from signalingState
// "have-local-offer". A pair that needs the TURN relay can reach neither.
// Measured in Chrome (scripts/relay-stuck-recovery-test.mjs reproduces it):
// when the only viable path is the relay and coturn rejects the allocation
// (401 because TURN_SECRET doesn't match its static-auth-secret) or never
// answers (701, UDP port not forwarded), ICE gathering finishes with *no
// usable candidate*, so checking never starts. connectionState sits at "new"
// for as long as you care to watch — no "failed", no "disconnected", nothing
// retried, and the tile shows "ansluter" forever. So arm a wall-clock watchdog
// from peer creation instead of from a transition: if the pair hasn't reached
// "connected" in time, treat it exactly like "failed" — hand it to the same
// ICE-restart backoff (which re-runs gathering, and so recovers once the relay
// works again) and report it as "uncertain" rather than "connecting".
//
// 15 s is ~5x the worst observed healthy relay setup time, so a slow-but-working
// path is never cut short; an ICE restart is non-destructive anyway.
const INITIAL_CONNECT_TIMEOUT_MS = 15_000;

// How often the mesh samples getStats() to keep per-peer transport (direct vs
// relay) and the live bandwidth readout current. The mesh owns this poll — not
// the UI meter — so the transport-critical relay policy never depends on a view
// component running (the same sample also feeds the meter via onStats).
const STATS_SAMPLE_INTERVAL_MS = 1_000;

// After refreshed TURN credentials are applied, proactively restart ICE on
// relayed/unknown peers so a new relay allocation is established while the old
// credentials are still valid. Staggered so a long session doesn't restart
// every relay pair at once (a simultaneous audible blip). See docs/turn-coturn.md.
const PROACTIVE_RELAY_RESTART_STAGGER_MS = 300;

// Resolve a peer's received video transceivers to role -> track, using the
// in-band mid->role map the sender shipped with its SDP. Pure and presence-
// agnostic: it returns whatever the wire says, leaving the "should we show it?"
// gating (is this peer the sharer / is their camera on) to the caller. Skips
// non-video and ended tracks. Exported so the classification — the bit the
// "blank video" races hinge on — is unit-testable without a real connection.
/**
 * @param {Iterable<RTCRtpTransceiver>} transceivers
 * @param {Record<string, "camera" | "screen"> | undefined} [roleMap] in-band
 *   mid->role map; an empty/undefined map simply leaves everything unclassified.
 * @returns {{ cameraTrack: MediaStreamTrack | null, screenTrack: MediaStreamTrack | null }}
 */
export function classifyVideoTracks(transceivers, roleMap) {
  let cameraTrack = null;
  let screenTrack = null;
  for (const t of transceivers) {
    const track = t.receiver?.track;
    if (!track || track.kind !== "video" || track.readyState === "ended") continue;
    const role = t.mid != null ? roleMap?.[t.mid] : null;
    if (role === "screen") screenTrack = track;
    else if (role === "camera") cameraTrack = track;
  }
  return { cameraTrack, screenTrack };
}

// Classify a connection's transport from its selected ICE candidate pair:
// "relay" if either endpoint's candidate is a TURN relay, "direct" for any other
// resolved pair (host/srflx/prflx), "unknown" when there's no pair yet. Pure so
// the relay-detection decision — the bit the camera-boost gate and the relay UI
// indicator hinge on — is unit-testable with a fabricated getStats() map.
/**
 * @param {RTCStats | null | undefined} pair the selected/nominated candidate-pair report
 * @param {{ get(id: string): any }} stats the full getStats() result (for candidate lookup)
 * @returns {"direct" | "relay" | "unknown"}
 */
export function transportFromPair(pair, stats) {
  if (!pair) return "unknown";
  const lc = pair.localCandidateId ? stats.get(pair.localCandidateId) : null;
  const rc = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : null;
  const lt = lc?.candidateType ?? null;
  const rt = rc?.candidateType ?? null;
  if (lt === "relay" || rt === "relay") return "relay";
  // Require both candidate types before calling a pair "direct". A report that
  // exists but lacks candidateType (or a missing lookup) stays unknown — it
  // could be an unclassified relay (see transport-from-pair.test.js).
  if (lt && rt) return "direct";
  return "unknown";
}

/** @typedef {"no_pair" | "pair_unresolved"} TransportUnknownReason */

/**
 * Why transport is still "unknown" after inspecting the selected pair.
 * @param {RTCStats | null | undefined} pair
 * @param {{ get(id: string): any }} stats
 * @returns {TransportUnknownReason | null} null when transport is direct/relay
 */
export function transportUnknownReason(pair, stats) {
  if (!pair) return "no_pair";
  return transportFromPair(pair, stats) === "unknown" ? "pair_unresolved" : null;
}

/**
 * Sum cumulative byte counters from one getStats() report. Prefers transport-
 * level totals (Chrome); falls back to per-RTP-stream counters when transport
 * stats omit bytes (Firefox).
 * @param {{ values(): Iterable<RTCStats> }} stats
 * @returns {{ bytesSent: number, bytesReceived: number }}
 */
export function byteCountsFromStats(stats) {
  let bytesSent = 0;
  let bytesReceived = 0;
  let hasTransportBytes = false;
  for (const report of stats.values()) {
    if (report.type !== "transport") continue;
    if (typeof report.bytesSent === "number") {
      bytesSent += report.bytesSent;
      hasTransportBytes = true;
    }
    if (typeof report.bytesReceived === "number") {
      bytesReceived += report.bytesReceived;
      hasTransportBytes = true;
    }
  }
  if (hasTransportBytes) return { bytesSent, bytesReceived };

  // Firefox often omits bytes on transport; RTP stream counters still advance.
  for (const report of stats.values()) {
    if (report.type === "outbound-rtp") {
      bytesSent += (report.bytesSent || 0) + (report.headerBytesSent || 0);
    } else if (report.type === "inbound-rtp") {
      bytesReceived += (report.bytesReceived || 0) + (report.headerBytesReceived || 0);
    }
  }
  return { bytesSent, bytesReceived };
}

/**
 * Turn one `icecandidateerror` event into a diagnosable fact.
 *
 * Browsers report the exact reason a STUN/TURN server refused or never answered
 * a request, and it is the single piece of evidence that explains a pair which
 * never connects. The codes that matter for a coturn relay:
 *   401 — the credential was rejected: the app's TURN_SECRET doesn't match
 *         coturn's static-auth-secret, or the clocks differ enough that the
 *         ephemeral username is already expired.
 *   403 — coturn refused the allocation/permission (quota, denied-peer-ip).
 *   437 — the allocation is gone (coturn restarted mid-session).
 *   701 — no answer at all: the UDP port is blocked or not forwarded to the
 *         container, or the host/IP the client was handed is wrong.
 * Also covers plain STUN failures, which say "this network drops UDP" — the
 * situation where the relay is required in the first place.
 *
 * @param {{ url?: string, errorCode?: number, errorText?: string }} [event]
 * @returns {{ url: string, errorCode: number, errorText: string, relay: boolean, hint: string }}
 */
export function describeIceServerError(event = {}) {
  const url = String(event.url || "");
  const errorCode = Number(event.errorCode) || 0;
  const errorText = String(event.errorText || "");
  const scheme = url.toLowerCase();
  const relay = scheme.startsWith("turn:") || scheme.startsWith("turns:");
  let hint;
  if (relay) {
    if (errorCode === 401) {
      hint =
        "TURN-servern avvisade våra uppgifter (401) — TURN_SECRET matchar inte " +
        "coturns static-auth-secret, eller så skiljer klockorna för mycket.";
    } else if (errorCode === 403) {
      hint =
        "TURN-servern nekade reläet (403) — kolla coturns kvoter och " +
        "denied-peer-ip.";
    } else if (errorCode === 437) {
      hint =
        "TURN-allokeringen finns inte längre (437) — coturn startades troligen om.";
    } else if (errorCode === 701) {
      hint =
        "Ingen kontakt med TURN-servern (701) — UDP-porten är blockerad eller " +
        "inte vidarebefordrad till coturn.";
    } else {
      hint = `TURN-servern svarade med fel ${errorCode}.`;
    }
  } else if (errorCode === 701) {
    hint =
      "Ingen kontakt med STUN-servern (701) — nätet blockerar troligen UDP, " +
      "så ett TURN-relä krävs.";
  } else {
    hint = `STUN-servern svarade med fel ${errorCode}.`;
  }
  return { url, errorCode, errorText, relay, hint };
}

/**
 * Explain a pair that never connected, from what ICE gathering produced.
 *
 * `icecandidateerror` is the precise explanation, but it does not always arrive
 * in time to be one. Chrome only declares a TURN allocate dead after ~40 s of
 * retransmits, while the initial-connect watchdog hands the pair to the
 * ICE-restart backoff at 15 s and every restart begins a fresh gathering — so
 * the 40 s is never served. Measured against a deployment whose relay UDP port
 * was firewalled off: 3 minutes, 14 restarts, zero `icecandidateerror` events,
 * and a health box that stayed empty. That is the exact failure this diagnosis
 * exists for, so it cannot depend on that event alone.
 *
 * The gathered candidates are observable immediately and say enough: a relay
 * that answers yields a `relay` candidate. Configured TURN plus no relay
 * candidate means the allocation never came back, whatever the eventual code.
 *
 * @param {{ turnConfigured?: boolean, candidateTypes?: Iterable<string>, turnUrl?: string }} args
 * @returns {{ url: string, errorCode: number, errorText: string, relay: boolean, hint: string } | null}
 */
export function describeGatheringFailure({
  turnConfigured = false,
  candidateTypes = [],
  turnUrl = "",
} = {}) {
  // No relay on offer: the "Relä (TURN): ej konfigurerat" line already says the
  // useful thing, and inventing a server failure on top would be wrong.
  if (!turnConfigured) return null;
  // The relay answered — this pair is failing for some other reason, and
  // guessing at it would only bury the real cause.
  if ([...candidateTypes].includes("relay")) return null;
  return {
    url: turnUrl,
    errorCode: 0,
    errorText: "no relay candidate gathered",
    relay: true,
    hint:
      "Ingen relä-kandidat kunde hämtas från TURN-servern — den svarar inte. " +
      "UDP-porten (3478 + relä-portintervallet) är troligen inte öppen eller " +
      "inte vidarebefordrad till coturn.",
  };
}

/**
 * Which per-peer ICE-server errors belong in the health box *right now*.
 *
 * The box is not session history. Each peer keeps only its latest error, and
 * that line is painted only while that peer is currently `osäker`. A healed
 * pair drops its error; a newer error on the same pair replaces the old one
 * (a 401 from minutes ago must not sit next to a fresh 701). Identical hints
 * across peers collapse to one line.
 *
 * 701 gathering-timeouts that fire after a pair is already `connected` never
 * reach this list (the mesh does not attach them), so a later blip does not
 * inherit leftover STUN/TURN noise from a healthy first gather.
 *
 * @param {Array<{ peerId?: string, hint?: string }>} peerErrors
 * @param {{ uncertainIds?: Iterable<string> }} [opts]
 */
export function activeIceErrorsToShow(peerErrors, { uncertainIds = [] } = {}) {
  const want = new Set(uncertainIds);
  const out = [];
  const seen = new Set();
  for (const err of peerErrors || []) {
    if (!want.has(err.peerId)) continue;
    const hint = err.hint || "";
    if (!hint || seen.has(hint)) continue;
    seen.add(hint);
    out.push(err);
  }
  return out;
}

/**
 * What to report to the caller for a peer's connection state.
 *
 * A pair that has *never* connected and has blown the initial-connect watchdog
 * keeps reading "uncertain": every ICE restart bounces the raw state back to
 * "connecting", which would otherwise repaint an indefinitely broken link as a
 * hopeful "ansluter" every couple of seconds — the exact reason a dead relay
 * looked like "it's still trying" instead of "this link is broken".
 * A pair that *has* connected keeps the raw state, so a normal recovery blip
 * still reads "ansluter" while it heals.
 *
 * @param {{ raw: string, everConnected: boolean, stalled: boolean }} args
 */
export function reportedConnectionState({ raw, everConnected, stalled }) {
  if (stalled && !everConnected && (raw === "connecting" || raw === "new")) {
    return "uncertain";
  }
  return raw;
}

/** True when the ICE config includes TURN/TURNS URLs (coturn fallback available). */
export function turnUrlsConfigured(iceServers) {
  return firstTurnUrl(iceServers) !== "";
}

/** The first TURN/TURNS URL in an ICE config, or "" when there is none. */
export function firstTurnUrl(iceServers) {
  for (const server of iceServers || []) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      const u = String(url);
      const scheme = u.toLowerCase();
      if (scheme.startsWith("turn:") || scheme.startsWith("turns:")) return u;
    }
  }
  return "";
}

/**
 * Pure boost gate: may we send HD camera to this peer?
 * @param {object} args
 * @param {"direct" | "relay" | "unknown"} args.transport
 * @param {TransportUnknownReason | null} args.unknownReason
 * @param {boolean} args.connected
 * @param {boolean} args.turnConfigured
 */
export function isCameraBoostEligibleTransport({
  transport,
  unknownReason,
  connected,
  turnConfigured,
}) {
  if (transport === "relay") return false;
  if (transport === "direct") return connected;
  if (!connected) return false;
  // A selected pair exists but candidate reports are missing — could be relay
  // (transport-from-pair.test.js). Never boost; TURN policy must hold.
  if (unknownReason === "pair_unresolved") return false;
  // No selected pair yet: only safe on STUN-only links (relay path unavailable).
  if (!turnConfigured) return true;
  return false;
}

/**
 * @param {object} options
 * @param {string} options.myId
 * @param {RTCIceServer[]} options.iceServers
 * @param {(peerId: string, data: object) => void} options.sendSignal
 * @param {(peerId: string, stream: MediaStream) => void} options.onAudioTrack
 * @param {(peerId: string) => void} options.onPeerVideoChanged
 * @param {(peerId: string, state: RTCPeerConnectionState | "uncertain") => void} options.onConnectionState
 * @param {(peerId: string) => void} options.onPeerFailed
 * @param {() => void} [options.onRelayChanged] a peer's transport (direct/relay/
 *   unknown) changed; caller re-reads isRelayed/isDirect for UI + capture gating.
 * @param {(entries: object[]) => void} [options.onStats] per-tick getStats sample
 *   (the same one that drives relay detection) for the live bandwidth meter.
 * @param {(peerId: string, error: ReturnType<typeof describeIceServerError>) => void}
 *   [options.onIceServerError] a STUN/TURN server refused or never answered a
 *   request on this pair. Fired when this peer's latest error changes (or the
 *   first time a url+code is seen), not on every Chrome Allocate retry.
 */
export function createMesh(options) {
  const {
    myId,
    iceServers,
    sendSignal,
    onAudioTrack,
    onPeerVideoChanged,
    onConnectionState,
    onPeerFailed,
    onRelayChanged = () => {},
    onStats = () => {},
    onIceServerError = () => {},
  } = options;

  // The ICE servers handed to every (current and future) RTCPeerConnection.
  // Mutable: setIceServers swaps in fresh TURN credentials mid-session.
  let currentIceServers = iceServers;

  // Per-peer transport, derived from the selected candidate pair each sample:
  //   "direct"  — connected over a non-relay pair (host/srflx/prflx)
  //   "relay"   — the selected pair uses a TURN relay (either side `relay`)
  //   "unknown" — not connected yet / no selected pair (conservative default)
  // Drives the camera-boost gate and the relay UI indicator. See docs/turn-coturn.md.
  /** @type {Map<string, "direct" | "relay" | "unknown">} */
  const peerTransport = new Map();
  /** @type {Map<string, TransportUnknownReason>} */
  const peerTransportUnknownReason = new Map();

  // STUN/TURN server failures seen on this mesh, keyed "<url>|<code>" so a
  // retransmit storm (Chrome retries an Allocate several times per gathering,
  // once per PeerConnection) reports once. Client-level rather than per-peer:
  // the cause is the ICE config or the network, not one pair.
  /** @type {Map<string, ReturnType<typeof describeIceServerError>>} */
  const iceServerErrors = new Map();

  /** @type {Map<string, {
   *   pc: RTCPeerConnection,
   *   name: string,
   *   pending: RTCIceCandidateInit[],
   *   polite: boolean,
   *   makingOffer: boolean,
   *   ignoreOffer: boolean,
   *   remoteRoles: Record<string, "camera" | "screen">,
   *   didInitialNegotiation: boolean,
   *   disconnectTimer?: ReturnType<typeof setTimeout>,
   *   recoveryTimer: ReturnType<typeof setTimeout> | null,
   *   recoveryAttempts: number,
   *   offerTimer: ReturnType<typeof setTimeout> | null,
   *   offerRetransmits: number,
   *   everConnected: boolean,
   *   stalled: boolean,
   *   initialConnectTimer: ReturnType<typeof setTimeout> | null,
   *   iceServerError: ReturnType<typeof describeIceServerError> | null,
   *   candidateTypes: Set<string>,
   *   audioSender: RTCRtpSender | null,
   *   screenSender: RTCRtpSender | null,
   *   cameraSender: RTCRtpSender | null,
   * }>} */
  const peers = new Map();

  let localAudioStream = null;
  // Mic mute: `track.enabled = false` alone keeps the encoder running and still
  // ships RTP packets of silence (~visible on the bandwidth meter). When muted
  // we instead replaceTrack(null) on every audio sender so *no* audio frames go
  // out at all — no renegotiation needed, the m-line stays up. The real track
  // is restored on unmute.
  let localAudioMuted = false;
  let localScreenStream = null;
  let localCameraStream = null;
  /** @type {(peerId: string) => boolean} */
  let cameraSendTo = () => true;
  // Per-peer camera bitrate: peers in `cameraBoostedPeers` (those viewing this
  // camera enlarged) get `cameraBoostedBitrate`; everyone else gets
  // `cameraDefaultBitrate`. The owner (main.js) decides who is boosted from
  // focus signaling; the mesh just applies the policy per sender.
  let cameraDefaultBitrate = DEFAULT_CAMERA_MAX_BITRATE;
  let cameraBoostedBitrate = DEFAULT_CAMERA_MAX_BITRATE;
  /** @type {Set<string>} */
  let cameraBoostedPeers = new Set();
  // Per-peer video pause: peers in this set get *no* outbound camera or screen
  // frames (sender track replaced with null) while everyone else keeps flowing.
  // Used when a viewer is in full-screen on someone else and so hides this
  // sender's video — pausing it saves the viewer's inbound bandwidth without a
  // renegotiation (replaceTrack(null) keeps the transceiver, just stops media).
  // The viewer (main.js) decides who to pause from full-screen state; the mesh
  // just applies it per sender. Presence is unaffected: this is pure transport.
  /** @type {Set<string>} */
  let pausedVideoPeers = new Set();
  // "Stör ej" (Do Not Disturb) send-suppression, a SEPARATE source from the
  // fullscreen-driven pausedVideoPeers above (they must UNION, not overwrite —
  // see the plan). Two inputs:
  //   - dndBlockedPeers: specific peers who are themselves in DND, so we stop
  //     sending them ALL media (audio + camera + screen).
  //   - localDndActive: WE are in DND, so we stop sending EVERYONE all media.
  // Effective "send nothing to peer P" = localDndActive || dndBlockedPeers.has(P).
  // Unlike mute/video-suppress this also gates AUDIO — the one media type that
  // otherwise always flows to every peer. replaceTrack(null), no renegotiation.
  /** @type {Set<string>} */
  let dndBlockedPeers = new Set();
  let localDndActive = false;
  const blockedForDnd = (peerId) => localDndActive || dndBlockedPeers.has(peerId);
  // Policy application is serialized + generation-guarded: callers don't await
  // setCameraBitratePolicy and it can fire rapidly (focus toggles). Without
  // this, two interleaved loops could call getParameters/setParameters on the
  // same sender out of order. The queue runs one at a time; stale runs bail.
  let cameraPolicyQueue = Promise.resolve();
  let cameraPolicyGen = 0;
  // Signature of the last applied policy, so a no-op call (applyCameraDistribution
  // runs from applyFocusView on many unrelated UI updates) doesn't re-run
  // getParameters/setParameters on every sender for no reason.
  let cameraPolicyKey = "";

  // The boost only goes to a peer that BOTH wants it (focusing our camera) AND
  // passes the transport policy (confirmed direct, or STUN-only unknown fallback).
  // Relayed peers and unclassified relay pairs never get 2.5 Mbps. See
  // docs/turn-coturn.md (media-policy).
  function isCameraBoostEligible(peerId) {
    const peer = peers.get(peerId);
    return isCameraBoostEligibleTransport({
      transport: peerTransport.get(peerId) ?? "unknown",
      unknownReason: peerTransportUnknownReason.get(peerId) ?? "no_pair",
      connected: peer?.pc?.connectionState === "connected",
      turnConfigured: turnUrlsConfigured(currentIceServers),
    });
  }

  function cameraBitrateFor(peerId) {
    const boost =
      cameraBoostedPeers.has(peerId) && isCameraBoostEligible(peerId);
    return boost ? cameraBoostedBitrate : cameraDefaultBitrate;
  }

  // Desired outbound track per media type for a peer, folding in every pause
  // source (fullscreen video-suppress, DND, and — for audio — mute). null means
  // "send no frames" (replaceTrack(null)).
  function desiredCameraTrackFor(peerId) {
    if (pausedVideoPeers.has(peerId) || blockedForDnd(peerId)) return null;
    return localCameraStream?.getVideoTracks()[0] ?? null;
  }

  function desiredScreenTrackFor(peerId) {
    if (pausedVideoPeers.has(peerId) || blockedForDnd(peerId)) return null;
    return localScreenStream?.getVideoTracks()[0] ?? null;
  }

  function desiredAudioTrackFor(peerId) {
    if (localAudioMuted || blockedForDnd(peerId)) return null;
    return localAudioStream?.getAudioTracks()[0] ?? null;
  }

  // Reconcile ONE peer's camera + screen senders against the desired tracks.
  // replaceTrack(null) stops media without renegotiation; replaceTrack(track)
  // resumes. Only touches a sender when its track actually needs to change.
  async function applyVideoPauseForPeer(peerId, peer) {
    if (peer.cameraSender) {
      const want = desiredCameraTrackFor(peerId);
      if (peer.cameraSender.track !== want) {
        try {
          await peer.cameraSender.replaceTrack(want);
        } catch {}
      }
    }
    if (peer.screenSender) {
      const want = desiredScreenTrackFor(peerId);
      if (peer.screenSender.track !== want) {
        try {
          await peer.screenSender.replaceTrack(want);
        } catch {}
      }
    }
  }

  // Reconcile ONE peer's audio sender against the desired track (mute + DND).
  async function applyAudioForPeer(peerId, peer) {
    if (!peer.audioSender) return;
    const want = desiredAudioTrackFor(peerId);
    if (peer.audioSender.track !== want) {
      try {
        await peer.audioSender.replaceTrack(want);
      } catch {}
    }
  }

  // Reconcile ALL of a peer's outbound senders (audio + camera + screen). Used by
  // the DND setters, which affect every media type at once; idempotent, so it's
  // safe to route the single-media setters through the specific helpers above.
  async function applyOutboundForPeer(peerId, peer) {
    await applyAudioForPeer(peerId, peer);
    await applyVideoPauseForPeer(peerId, peer);
  }

  function setVideoPausedPeers(peerIds) {
    pausedVideoPeers = peerIds instanceof Set ? new Set(peerIds) : new Set(peerIds);
    // Fire-and-forget per peer; guard the floating promise so an unexpected
    // rejection can't surface as an unhandled rejection (the inner replaceTrack
    // is already try/caught, this matches the rest of the file's .catch style).
    for (const [peerId, peer] of peers) {
      applyVideoPauseForPeer(peerId, peer).catch(() => {});
    }
  }

  // "Stör ej": the set of peers who are themselves in DND — we stop sending them
  // all media. Unions with pausedVideoPeers via the desired*TrackFor helpers.
  function setDndBlockedPeers(peerIds) {
    dndBlockedPeers = peerIds instanceof Set ? new Set(peerIds) : new Set(peerIds);
    for (const [peerId, peer] of peers) {
      applyOutboundForPeer(peerId, peer).catch(() => {});
    }
  }

  // "Stör ej": WE are in DND — pause (or resume) all outbound media to everyone.
  // Keeps the mic *capture* running (iOS keep-alive / reconnect parity); only the
  // senders are paused. On release, desired*TrackFor re-derives the mute-aware
  // audio state and any live camera/screen, so nothing is lost.
  function setLocalDndActive(active) {
    localDndActive = !!active;
    for (const [peerId, peer] of peers) {
      applyOutboundForPeer(peerId, peer).catch(() => {});
    }
  }

  function cameraPolicySignature(boosted, boostedBitrate, defaultBitrate) {
    return [...boosted].sort().join(",") + "|" + boostedBitrate + "|" + defaultBitrate;
  }

  function attachLocalTracks(peerId, peer) {
    if (localAudioStream) {
      for (const track of localAudioStream.getTracks()) {
        const sender = peer.pc.addTrack(track, localAudioStream);
        peer.audioSender = sender;
        prioritizeAudio(sender);
        // Honor the current mute / DND state for a peer that joins while muted or
        // while we're in DND: negotiate the audio m-line but send no frames until
        // it clears.
        if (desiredAudioTrackFor(peerId) === null) {
          sender.replaceTrack(null).catch(() => {});
        }
      }
    }
    if (localScreenStream) {
      const track = localScreenStream.getVideoTracks()[0];
      if (track) addScreenTrack(peerId, peer, track);
    }
    if (localCameraStream && cameraSendTo(peerId)) {
      const track = localCameraStream.getVideoTracks()[0];
      if (track) addCameraTrack(peerId, peer, track);
    }
  }

  // Build the { <mid>: role } map for the video we send on this connection,
  // keyed by transceiver mid (symmetric across the connection, so the receiver
  // can map an incoming track back to its role). Derived from the tracked
  // camera/screen *sender* identity, NOT the sender's current track: a viewer
  // that suppressed us (full-screen on someone else) has our outbound video
  // paused via replaceTrack(null), so matching on the track would drop the mid
  // from the map. The receiver would then lose the classification on the next
  // renegotiation and the camera/screen would stay blank — even after the
  // viewer resumes us (resume is a track swap, not a renegotiation, so no fresh
  // role map is sent) — until some unrelated renegotiation happened to re-send
  // it. The sender reference stays stable across a pause, so the mid does too.
  function localVideoRoles(peer) {
    const roles = {};
    for (const t of peer.pc.getTransceivers()) {
      if (t.mid == null || !t.sender) continue;
      if (peer.screenSender && t.sender === peer.screenSender) roles[t.mid] = "screen";
      else if (peer.cameraSender && t.sender === peer.cameraSender) roles[t.mid] = "camera";
    }
    return roles;
  }

  function wirePeer(peerId, peer) {
    const { pc } = peer;

    pc.addEventListener("negotiationneeded", async () => {
      // Deterministic first offer: on a brand-new connection only the impolite
      // peer offers; the polite peer waits and answers. Both peers offering at
      // once (guaranteed on every mesh connection) forces a perfect-negotiation
      // rollback, and the rolled-back offer's ICE candidates can be orphaned —
      // leaving the pair stuck at signalingState "stable" but never reaching
      // "connected". At join every peer has audio only, so the impolite peer's
      // offer + the polite peer's answer fully negotiates the initial link.
      // Later renegotiations (camera/screen) fall through to perfect negotiation.
      if (!peer.didInitialNegotiation && peer.polite) return;
      try {
        peer.makingOffer = true;
        peer.didInitialNegotiation = true;
        await pc.setLocalDescription();
        sendSignal(peerId, {
          description: pc.localDescription,
          roles: localVideoRoles(peer),
        });
      } catch (err) {
        console.error("negotiationneeded", err);
      } finally {
        peer.makingOffer = false;
      }
    });

    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) {
        // Remember what gathering managed to produce. A pair that never
        // connects is explained mostly by what is *missing* here — see
        // describeGatheringFailure.
        if (e.candidate.type) peer.candidateTypes.add(e.candidate.type);
        sendSignal(peerId, { candidate: e.candidate });
      }
    });

    pc.addEventListener("icecandidateerror", (e) => {
      // A browser task queued before removePeer()/close() may run after a room
      // switch. Never let an obsolete PC repopulate the new session's UI/log.
      if (peers.get(peerId) !== peer || pc.signalingState === "closed") return;
      // A gathering timeout / refusal on a link that already selected a path
      // is not an explanation of this pair. Don't park it — a later blip
      // must not inherit a minutes-old 701 as its diagnosis.
      if (pc.connectionState === "connected") return;
      reportIceServerError(peerId, peer, describeIceServerError(e));
    });

    pc.addEventListener("track", (e) => {
      if (e.track.kind === "video") {
        const refresh = () => onPeerVideoChanged(peerId);
        refresh();
        e.track.addEventListener("unmute", refresh);
        return;
      }
      onAudioTrack(peerId, e.streams[0]);
    });

    pc.addEventListener("connectionstatechange", () => {
      const state = pc.connectionState;

      // "disconnected" can self-heal. Flag the peer as uncertain after a short
      // grace, and start nudging an ICE restart in case it slides toward
      // "failed" (Chrome otherwise waits ~15 s before declaring failure).
      if (state === "disconnected") {
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = setTimeout(() => {
          if (pc.connectionState === "disconnected") {
            markStalled(peer);
            onConnectionState(peerId, "uncertain");
            scheduleRecovery(peerId, peer);
          }
        }, 1_500);
        return;
      }

      clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = undefined;

      // A failed media path is recoverable: keep the peer, mark it uncertain,
      // and drive ICE restarts. Don't remove on "failed" — that used to sever a
      // pair permanently on a transient blip (no rebuild, since the server
      // never re-broadcasts join for an already-joined peer). Removal now comes
      // only from the server's presence (peer-left) or a locally closed PC.
      if (state === "failed") {
        markStalled(peer);
        onConnectionState(peerId, "uncertain");
        scheduleRecovery(peerId, peer);
        return;
      }

      // The PC was closed (teardown / removePeer) — unrecoverable, so drop it.
      if (state === "closed") {
        clearRecovery(peer);
        clearInitialConnectWatchdog(peer);
        onPeerFailed(peerId);
        return;
      }

      if (state === "connected") {
        peer.everConnected = true;
        peer.stalled = false;
        // icecandidateerror describes one failed server request, not the
        // selected path. Once this pair connects, the old per-peer explanation
        // is no longer true (the session-level history remains available).
        peer.iceServerError = null;
        clearInitialConnectWatchdog(peer);
        clearRecovery(peer);
        peer.recoveryAttempts = 0;
      }
      onConnectionState(
        peerId,
        reportedConnectionState({
          raw: state,
          everConnected: peer.everConnected,
          stalled: peer.stalled,
        }),
      );
    });

    // Watchdog the offer/answer handshake itself (independent of ICE). Entering
    // "have-local-offer" means we sent an offer and are waiting for an answer;
    // arm the retransmit timer. Any other state ("stable" once answered/rolled
    // back, "closed" on teardown) means the offer is no longer outstanding, so
    // stop watchdogging it and reset the backoff once we settle in "stable".
    pc.addEventListener("signalingstatechange", () => {
      if (pc.signalingState === "have-local-offer") {
        scheduleOfferRetransmit(peerId, peer);
      } else {
        clearOfferRetransmit(peer);
        if (pc.signalingState === "stable") {
          peer.offerRetransmits = 0;
          // Re-assert the camera send cap now that negotiation has settled.
          // addCameraTrack applies the cap with getParameters()+await
          // setParameters(); when two peers turn their camera on at once, the
          // other side's renegotiation lands in that await gap and re-numbers
          // this sender's parameters, so setParameters rejects the now-stale
          // object ("Read-only field modified") — caught, so the cap is silently
          // dropped and that camera streams UNCAPPED (a ~250 kbps standard cam
          // free to spike to Mbit/s). On "stable" no renegotiation is in flight,
          // so a fresh getParameters()+setParameters() applies cleanly. Idempotent
          // and cheap (one sender), and self-heals any path that drops the cap.
          // No-op when there's no camera sender.
          reapplyCameraBitrateForPeer(peer);
        }
      }
    });
  }

  // This link is not working (failed, stuck in disconnected, or it blew the
  // initial-connect watchdog). Latched so a never-connected pair keeps reading
  // "uncertain" through the restart cycles instead of flapping back to
  // "ansluter"; cleared only by an actual "connected".
  function markStalled(peer) {
    peer.stalled = true;
  }

  // Publish one explanation for a pair, deduped so Chrome's Allocate retry
  // storms report once: the same url+code on the same pair is swallowed, a
  // newer code on that pair (or the first sighting of a code anywhere) is not.
  function reportIceServerError(peerId, peer, error) {
    if (!error) return;
    const prev = peer.iceServerError;
    peer.iceServerError = error;
    const key = `${error.url}|${error.errorCode}`;
    const firstGlobal = !iceServerErrors.has(key);
    if (firstGlobal) iceServerErrors.set(key, error);
    const changedOnPeer =
      !prev || prev.url !== error.url || prev.errorCode !== error.errorCode;
    if (!changedOnPeer && !firstGlobal) return;
    onIceServerError(peerId, error);
  }

  function clearInitialConnectWatchdog(peer) {
    if (peer.initialConnectTimer) {
      clearTimeout(peer.initialConnectTimer);
      peer.initialConnectTimer = null;
    }
  }

  // Arm the wall-clock watchdog for a pair's *first* connect. See
  // INITIAL_CONNECT_TIMEOUT_MS: when the relay is the only viable path and it's
  // broken, ICE never starts checking, so no state transition ever arms the
  // other recovery paths and the pair would sit at "new" for the whole session.
  function armInitialConnectWatchdog(peerId, peer) {
    clearInitialConnectWatchdog(peer);
    peer.initialConnectTimer = setTimeout(() => {
      peer.initialConnectTimer = null;
      if (peer.pc.signalingState === "closed") return;
      if (peer.pc.connectionState === "connected") return;
      markStalled(peer);
      onConnectionState(peerId, "uncertain");
      // Say why while we still can. From here on the backoff restarts gathering
      // every few seconds, which keeps Chrome from ever reaching the ~40 s it
      // needs to raise `icecandidateerror` — so if nothing has explained this
      // pair yet, derive the explanation from the candidates we did gather.
      if (!peer.iceServerError) {
        reportIceServerError(
          peerId,
          peer,
          describeGatheringFailure({
            turnConfigured: turnUrlsConfigured(currentIceServers),
            candidateTypes: peer.candidateTypes,
            turnUrl: firstTurnUrl(currentIceServers),
          }),
        );
      }
      scheduleRecovery(peerId, peer);
    }, INITIAL_CONNECT_TIMEOUT_MS);
  }

  // Queue one ICE-restart attempt (debounced: at most one pending timer per
  // peer). Backoff grows with the attempt count; the polite side is biased one
  // base interval later so a single offerer drives the restart in the common
  // case. Reschedules itself from attemptIceRestart until the peer reconnects
  // or is removed, so a connection stuck "failed" keeps being nudged.
  function scheduleRecovery(peerId, peer) {
    if (peer.recoveryTimer) return;
    const backoff = Math.min(
      ICE_RESTART_MAX_MS,
      ICE_RESTART_BASE_MS * 2 ** peer.recoveryAttempts,
    );
    const politeBias = peer.polite ? ICE_RESTART_BASE_MS : 0;
    peer.recoveryTimer = setTimeout(() => {
      peer.recoveryTimer = null;
      attemptIceRestart(peerId, peer);
    }, backoff + politeBias);
  }

  function clearRecovery(peer) {
    if (peer.recoveryTimer) {
      clearTimeout(peer.recoveryTimer);
      peer.recoveryTimer = null;
    }
  }

  // Trigger an ICE restart. restartIce() refreshes the local ICE credentials
  // and (when signalingState is stable) fires negotiationneeded, which sends a
  // fresh offer + role map over the still-live WebSocket. If the attempt
  // doesn't reconnect, reschedule with longer backoff.
  function attemptIceRestart(peerId, peer) {
    const pc = peer.pc;
    if (pc.signalingState === "closed") return;
    if (pc.connectionState === "connected") {
      peer.recoveryAttempts = 0;
      return;
    }
    peer.recoveryAttempts++;
    try {
      pc.restartIce();
    } catch {}
    scheduleRecovery(peerId, peer);
  }

  // Queue one offer-retransmit attempt (debounced: at most one pending timer per
  // peer). Backoff grows with the retransmit count, capped, so a pair stuck mid-
  // handshake keeps being nudged without flooding the socket.
  function scheduleOfferRetransmit(peerId, peer) {
    if (peer.offerTimer) return;
    const backoff = Math.min(
      OFFER_RETRANSMIT_MAX_MS,
      OFFER_RETRANSMIT_BASE_MS * 2 ** peer.offerRetransmits,
    );
    peer.offerTimer = setTimeout(() => {
      peer.offerTimer = null;
      retransmitOffer(peerId, peer);
    }, backoff);
  }

  function clearOfferRetransmit(peer) {
    if (peer.offerTimer) {
      clearTimeout(peer.offerTimer);
      peer.offerTimer = null;
    }
  }

  // Re-send the outstanding local offer (its SDP unchanged, so the ICE ufrag and
  // already-sent candidates still match) plus the in-band role map. Only acts
  // while still in "have-local-offer": if the answer has since landed we're back
  // in "stable" and the signalingstatechange handler has already cleared us.
  // The answerer is sitting in "stable" and just answers — no glare. Reschedule
  // until the answer lands or the peer is removed.
  function retransmitOffer(peerId, peer) {
    const pc = peer.pc;
    if (pc.signalingState !== "have-local-offer" || !pc.localDescription) return;
    peer.offerRetransmits++;
    sendSignal(peerId, {
      description: pc.localDescription,
      roles: localVideoRoles(peer),
    });
    scheduleOfferRetransmit(peerId, peer);
  }

  function ensurePeerForSignal(peerId) {
    if (!peers.has(peerId)) addPeer(peerId, "…");
    return peers.get(peerId);
  }

  function addPeer(peerId, name) {
    const existing = peers.get(peerId);
    if (existing) {
      existing.name = name;
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: currentIceServers });
    const peer = {
      pc,
      name,
      pending: [],
      polite: myId > peerId,
      makingOffer: false,
      ignoreOffer: false,
      remoteRoles: {},
      didInitialNegotiation: false,
      recoveryTimer: null,
      recoveryAttempts: 0,
      offerTimer: null,
      offerRetransmits: 0,
      everConnected: false,
      stalled: false,
      initialConnectTimer: null,
      iceServerError: null,
      candidateTypes: new Set(),
      audioSender: null,
      screenSender: null,
      cameraSender: null,
    };
    peers.set(peerId, peer);
    attachLocalTracks(peerId, peer);
    wirePeer(peerId, peer);
    armInitialConnectWatchdog(peerId, peer);
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    clearTimeout(peer.disconnectTimer);
    clearRecovery(peer);
    clearOfferRetransmit(peer);
    clearInitialConnectWatchdog(peer);
    try {
      peer.pc.close();
    } catch {}
    peers.delete(peerId);
    peerTransport.delete(peerId);
    peerTransportUnknownReason.delete(peerId);
  }

  // Close *every* connection, including peers created internally by an incoming
  // signal (ensurePeerForSignal) that the caller never got a tile for. Callers
  // tear down by their own UI maps and would otherwise orphan those PCs.
  function close() {
    stopStatsSampler();
    for (const peer of peers.values()) {
      clearTimeout(peer.disconnectTimer);
      clearRecovery(peer);
      clearOfferRetransmit(peer);
      clearInitialConnectWatchdog(peer);
      try {
        peer.pc.close();
      } catch {}
    }
    peers.clear();
    peerTransport.clear();
    peerTransportUnknownReason.clear();
    iceServerErrors.clear();
  }

  async function handleSignal(from, data) {
    const peer = ensurePeerForSignal(from);
    const pc = peer.pc;
    try {
      if (data.description) {
        const offerCollision =
          data.description.type === "offer" &&
          (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        peer.remoteRoles = data.roles || {};

        await pc.setRemoteDescription(data.description);
        peer.didInitialNegotiation = true;
        for (const c of peer.pending.splice(0)) {
          try {
            await pc.addIceCandidate(c);
          } catch {}
        }
        if (data.description.type === "offer") {
          await pc.setLocalDescription();
          sendSignal(from, {
            description: pc.localDescription,
            roles: localVideoRoles(peer),
          });
        }
        onPeerVideoChanged(from);
      } else if (data.candidate) {
        if (pc.remoteDescription?.type) {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch (err) {
            if (!peer.ignoreOffer) throw err;
          }
        } else {
          peer.pending.push(data.candidate);
        }
      }
    } catch (err) {
      console.error("handleSignal", err);
    }
  }

  async function prioritizeAudio(sender) {
    try {
      const p = sender.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].priority = "high";
      p.encodings[0].networkPriority = "high";
      await sender.setParameters(p);
    } catch {}
  }

  async function addScreenTrack(peerId, peer, track) {
    if (peer.screenSender) return;
    const sender = peer.pc.addTrack(track, localScreenStream);
    peer.screenSender = sender;
    // Start paused if this viewer has suppressed our video (full-screen on
    // someone else) or is DND-blocked. The m-line is still negotiated; no frames.
    if (desiredScreenTrackFor(peerId) === null) {
      try {
        await sender.replaceTrack(null);
      } catch {}
    }
    try {
      const p = sender.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = SCREEN_MAX_BITRATE;
      p.encodings[0].priority = "low";
      p.encodings[0].networkPriority = "low";
      await sender.setParameters(p);
    } catch {}
  }

  async function setCameraSenderBitrate(sender, maxBitrate) {
    try {
      const p = sender.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = maxBitrate;
      p.encodings[0].priority = "low";
      p.encodings[0].networkPriority = "low";
      await sender.setParameters(p);
    } catch {}
  }

  async function addCameraTrack(peerId, peer, track) {
    if (peer.cameraSender) return;
    const sender = peer.pc.addTrack(track, localCameraStream);
    peer.cameraSender = sender;
    if (desiredCameraTrackFor(peerId) === null) {
      try {
        await sender.replaceTrack(null);
      } catch {}
    }
    await setCameraSenderBitrate(sender, cameraBitrateFor(peerId));
  }

  function removeCameraFromPeer(peer) {
    if (!peer.cameraSender) return;
    try {
      peer.pc.removeTrack(peer.cameraSender);
    } catch {}
    peer.cameraSender = null;
  }

  function removeScreenFromPeer(peer) {
    if (!peer.screenSender) return;
    try {
      peer.pc.removeTrack(peer.screenSender);
    } catch {}
    peer.screenSender = null;
  }

  // Set (or swap) the local mic stream. On a fresh mesh this just records the
  // stream before any peers exist; when the user picks a different microphone
  // mid-call it also reconciles every existing audio sender via replaceTrack —
  // no renegotiation, and the mute state is honored (a muted sender stays null).
  function setLocalAudioStream(stream) {
    localAudioStream = stream;
    for (const [peerId, peer] of peers) {
      if (!peer.audioSender) continue;
      const want = desiredAudioTrackFor(peerId);
      if (peer.audioSender.track !== want) {
        peer.audioSender.replaceTrack(want).catch(() => {});
      }
    }
  }

  // Swap the local camera to a different device's track without renegotiation:
  // replaceTrack on every peer that already has a camera sender (honoring the
  // pause set). Per-sender encoding params (bitrate/priority) live on the sender
  // and survive replaceTrack, so the focus-aware bitrate policy stays intact.
  function setLocalCameraTrack(stream) {
    localCameraStream = stream;
    for (const [peerId, peer] of peers) {
      if (!peer.cameraSender) continue;
      const want = desiredCameraTrackFor(peerId);
      if (peer.cameraSender.track !== want) {
        peer.cameraSender.replaceTrack(want).catch(() => {});
      }
    }
  }

  // Mute/unmute the outgoing mic across all peers. Muting drops outbound audio
  // bandwidth to (near) zero instead of streaming silence. Reconciled through
  // applyAudioForPeer so mute and DND compose (either one pauses the sender).
  function setLocalAudioMuted(muted) {
    localAudioMuted = muted;
    for (const [peerId, peer] of peers) {
      applyAudioForPeer(peerId, peer).catch(() => {});
    }
  }

  function setLocalScreenStream(stream) {
    localScreenStream = stream;
    const track = stream?.getVideoTracks()[0] ?? null;
    for (const [peerId, peer] of peers) {
      if (track) addScreenTrack(peerId, peer, track);
      else removeScreenFromPeer(peer);
    }
  }

  function setLocalCameraStream(stream, { sendTo } = {}) {
    if (sendTo) cameraSendTo = sendTo;
    localCameraStream = stream;
    const track = stream?.getVideoTracks()[0] ?? null;
    for (const [peerId, peer] of peers) {
      if (track && cameraSendTo(peerId)) addCameraTrack(peerId, peer, track);
      else removeCameraFromPeer(peer);
    }
  }

  // Apply a per-peer camera bitrate policy: `boosted` peers (focusing our
  // camera) get `boostedBitrate`, the rest `defaultBitrate`. Each PeerConnection
  // encodes the shared camera track independently, so a high bitrate to a
  // focuser and a low one to everyone else costs only the focuser's bandwidth.
  // Serialized so concurrent calls can't interleave per-sender setParameters;
  // "last call wins" (older queued runs bail on the generation check).
  function setCameraBitratePolicy({ boosted, boostedBitrate, defaultBitrate }) {
    const set = boosted instanceof Set ? boosted : new Set(boosted);
    const key = cameraPolicySignature(set, boostedBitrate, defaultBitrate);
    if (key === cameraPolicyKey) return cameraPolicyQueue; // unchanged: skip churn
    cameraPolicyKey = key;
    cameraBoostedPeers = set;
    cameraBoostedBitrate = boostedBitrate;
    cameraDefaultBitrate = defaultBitrate;
    const gen = ++cameraPolicyGen;
    cameraPolicyQueue = cameraPolicyQueue
      .then(() => applyCameraBitratePolicy(gen))
      .catch(() => {});
    return cameraPolicyQueue;
  }

  async function applyCameraBitratePolicy(gen) {
    for (const [peerId, peer] of peers) {
      if (gen !== cameraPolicyGen) return; // superseded by a newer policy
      if (peer.cameraSender) {
        await setCameraSenderBitrate(peer.cameraSender, cameraBitrateFor(peerId));
      }
    }
  }

  // Re-apply the per-peer camera bitrate without changing the policy itself.
  // Needed when a peer's *transport* flips (direct<->relay): the policy key is
  // unchanged so setCameraBitratePolicy would no-op, but cameraBitrateFor now
  // returns a different value for that peer (boost gated on "direct"), so the
  // senders must be re-set. Goes through the same serialized queue/generation.
  function reapplyCameraBitrates() {
    const gen = ++cameraPolicyGen;
    cameraPolicyQueue = cameraPolicyQueue
      .then(() => applyCameraBitratePolicy(gen))
      .catch(() => {});
  }

  // Re-assert one peer's camera send cap (current policy value, boost-gated the
  // same as everywhere). Used after a negotiation settles to "stable", where the
  // cap applied at addCameraTrack may have been dropped: a concurrent
  // renegotiation can make that sender's getParameters()+setParameters() lose
  // the race ("Read-only field modified"), leaving the camera uncapped. Routed
  // through the shared serialized queue so it can't interleave a setParameters
  // with applyCameraBitratePolicy on the same sender; the queue bumps the
  // generation so this is the run that wins, then re-applies to every peer
  // (covers a settle that coincided with a policy change). Cheap + no-op when
  // there's no camera sender, so it's safe to fire on every settle.
  function reapplyCameraBitrateForPeer(peer) {
    if (!peer.cameraSender) return;
    reapplyCameraBitrates();
  }

  // --- TURN credential refresh --------------------------------------------
  // Swap in fresh ICE servers (rolling ephemeral TURN creds) on every existing
  // connection plus all future ones. setConfiguration only changes which creds
  // the *next* ICE gathering uses; an established relay allocation keeps running
  // on its old creds. So when asked (restartRelayed), proactively restart ICE on
  // relayed/unknown peers — while the old creds are still valid — so a fresh
  // relay allocation is negotiated ahead of expiry. Direct peers use no TURN
  // creds, so they're left untouched (a needless restart would only risk a blip).
  function setIceServers(servers, { restartRelayed = false } = {}) {
    currentIceServers = servers || [];
    for (const peer of peers.values()) {
      try {
        peer.pc.setConfiguration({ iceServers: currentIceServers });
      } catch {}
    }
    if (restartRelayed) scheduleProactiveRelayRestart();
  }

  function scheduleProactiveRelayRestart() {
    let i = 0;
    for (const [peerId, peer] of peers) {
      if (peerTransport.get(peerId) === "direct") continue;
      // A pair that has never connected is owned by the initial-connect
      // watchdog and its backoff. Restarting ICE from here as well would reset
      // an in-flight first gathering (and on a short TURN TTL it would do so
      // repeatedly), starving the very connect we're waiting for.
      if (!peer.everConnected) continue;
      const delay = i++ * PROACTIVE_RELAY_RESTART_STAGGER_MS;
      setTimeout(() => {
        if (!peers.has(peerId)) return;
        if (peer.pc.signalingState === "closed") return;
        try {
          peer.pc.restartIce();
        } catch {}
      }, delay);
    }
  }

  // --- Stats sampler (transport detection + bandwidth feed) ----------------
  let statsTimer = null;
  let statsSampling = false;

  function startStatsSampler(intervalMs = STATS_SAMPLE_INTERVAL_MS) {
    stopStatsSampler();
    statsTimer = setInterval(runStatsSample, intervalMs);
  }

  function stopStatsSampler() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
  }

  // One getStats() pass: refresh per-peer transport (direct/relay/unknown) and
  // hand the same sample to the bandwidth meter (onStats). When any transport
  // changed, re-apply the camera bitrate (the boost gate depends on it) and
  // notify the caller (UI indicator + capture-level recompute). The in-flight
  // guard mirrors the old UI meter: getStats across peers can exceed the tick.
  async function runStatsSample() {
    if (statsSampling) return false;
    statsSampling = true;
    let entries;
    try {
      entries = await getPeerStats();
    } catch {
      return false;
    } finally {
      statsSampling = false;
    }
    if (!statsTimer) return false; // stopped while in flight

    let changed = false;
    const seen = new Set();
    for (const e of entries) {
      seen.add(e.peerId);
      if (peerTransport.get(e.peerId) !== e.transport) {
        peerTransport.set(e.peerId, e.transport);
        changed = true;
      }
      const reason =
        e.transport === "unknown"
          ? e.transportUnknownReason ?? "no_pair"
          : null;
      const prevReason = peerTransportUnknownReason.get(e.peerId) ?? null;
      if (reason) {
        if (prevReason !== reason) {
          peerTransportUnknownReason.set(e.peerId, reason);
          changed = true;
        }
      } else if (peerTransportUnknownReason.delete(e.peerId)) {
        changed = true;
      }
    }
    for (const id of [...peerTransport.keys()]) {
      if (!seen.has(id)) {
        peerTransport.delete(id);
        peerTransportUnknownReason.delete(id);
        changed = true;
      }
    }

    onStats(entries);
    if (changed) {
      reapplyCameraBitrates();
      onRelayChanged();
    }
    return true;
  }

  // One immediate stats pass (e.g. right after a camera-focus hint) so
  // transport classification is fresh before applying the boost policy.
  async function refreshTransport() {
    while (statsSampling) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return runStatsSample();
  }

  // Sum total bytes sent/received across every peer connection right now, for a
  // live bandwidth readout. Prefers transport-level counters (Chrome); falls
  // back to per-RTP-stream totals when transport omits bytes (Firefox). The
  // caller diffs two samples over time to get a rate; these are raw monotonic
  // counters per live connection (they reset to 0 when a peer leaves and its
  // connection is dropped, which the caller clamps).
  async function getByteCounts() {
    let bytesSent = 0;
    let bytesReceived = 0;
    await Promise.all(
      [...peers.values()].map(async (peer) => {
        let stats;
        try {
          stats = await peer.pc.getStats();
        } catch {
          return;
        }
        const counts = byteCountsFromStats(stats);
        bytesSent += counts.bytesSent;
        bytesReceived += counts.bytesReceived;
      }),
    );
    return { bytesSent, bytesReceived };
  }

  // Per-peer diagnostic snapshot for the live diagnostics rail. For each peer
  // connection we read getStats() ONCE and pull out everything the UI needs:
  //   - transport byte counters -> bandwidth (caller diffs two samples for kbit/s)
  //   - candidate-pair (the nominated/in-use pair) -> currentRoundTripTime (RTT)
  //   - inbound-rtp -> cumulative packetsLost / packetsReceived so the caller
  //     can diff into a per-interval (inbound) loss rate. outbound-rtp
  //     packetsSent is also surfaced for future outbound-loss use, but the
  //     current UI only derives inbound loss.
  // Byte and packet counters are raw monotonic totals per live connection (they
  // reset when a peer's connection is dropped); the caller keeps a per-peerId
  // last sample and clamps negative deltas. RTT is an instantaneous gauge.
  // connectionState is the live mesh view of the link (the caller may overlay
  // its own "uncertain" state). Returns one entry per current peer connection;
  // peers with no live connection yet simply won't appear (the caller renders
  // an "ansluter…" row from the roster instead).
  async function getPeerStats() {
    const entries = await Promise.all(
      [...peers.entries()].map(async ([peerId, peer]) => {
        let bytesSent = 0;
        let bytesReceived = 0;
        let packetsLost = 0;
        let packetsReceived = 0;
        let packetsSent = 0;
        let rtt = null;
        let transport = "unknown";
        let localCandidateType = null;
        let remoteCandidateType = null;
        /** @type {RTCStats | null} */
        let pair = null;
        let stats;
        try {
          stats = await peer.pc.getStats();
        } catch {
          stats = null;
        }
        if (stats) {
          const counts = byteCountsFromStats(stats);
          bytesSent = counts.bytesSent;
          bytesReceived = counts.bytesReceived;
          let selectedPairId = null;
          for (const report of stats.values()) {
            if (report.type === "transport" && report.selectedCandidatePairId) {
              selectedPairId = report.selectedCandidatePairId;
            } else if (report.type === "inbound-rtp") {
              packetsLost += report.packetsLost || 0;
              packetsReceived += report.packetsReceived || 0;
            } else if (report.type === "outbound-rtp") {
              packetsSent += report.packetsSent || 0;
            }
          }
          // Prefer the transport's selected pair; fall back to any nominated/
          // in-use candidate-pair (Firefox doesn't always link via transport).
          pair = selectedPairId ? stats.get(selectedPairId) : null;
          if (!pair) {
            let fallback = null;
            for (const report of stats.values()) {
              if (report.type !== "candidate-pair") continue;
              if (!(report.nominated || report.selected)) continue;
              if (report.state === "failed") continue;
              if (report.state === "succeeded") {
                pair = report;
                break;
              }
              if (!fallback) fallback = report;
            }
            if (!pair) pair = fallback;
          }
          if (pair && typeof pair.currentRoundTripTime === "number") {
            rtt = pair.currentRoundTripTime;
          }
          // Resolve the selected pair's candidate types into a transport
          // (direct/relay/unknown) — the relay-detection fact the boost gate and
          // UI indicator use.
          transport = transportFromPair(pair, stats);
          // Surface the raw candidate types too, for the stats transport report
          // (host/srflx/prflx/relay per side) — see .cursor/plans/stats-poc.md.
          if (pair) {
            localCandidateType =
              (pair.localCandidateId && stats.get(pair.localCandidateId)?.candidateType) || null;
            remoteCandidateType =
              (pair.remoteCandidateId && stats.get(pair.remoteCandidateId)?.candidateType) || null;
          }
        }
        const unknownReason =
          transport === "unknown" ? transportUnknownReason(pair ?? null, stats ?? new Map()) : null;
        return {
          peerId,
          name: peer.name ?? "",
          // The same "never connected and stalled reads uncertain" rule the
          // connectionstatechange path applies, so the diagnostics rail and the
          // tile badge can't disagree about a link that is stuck retrying.
          state: reportedConnectionState({
            raw: peer.pc.connectionState,
            everConnected: peer.everConnected,
            stalled: peer.stalled,
          }),
          iceServerError: peer.iceServerError,
          bytesSent,
          bytesReceived,
          packetsLost,
          packetsReceived,
          packetsSent,
          rtt,
          // "direct" | "relay" | "unknown" (no confirmed selected pair yet).
          transport,
          transportUnknownReason: unknownReason,
          localCandidateType,
          remoteCandidateType,
        };
      }),
    );
    return entries;
  }

  return {
    addPeer,
    removePeer,
    close,
    handleSignal,
    hasPeer: (peerId) => peers.has(peerId),
    peerIds: () => [...peers.keys()],
    getName: (peerId) => peers.get(peerId)?.name ?? "",
    // Role-resolved (presence-agnostic) video for a peer. Replaces the old
    // getConnection/getRemoteRoles leak — callers no longer touch the raw
    // RTCPeerConnection or walk transceivers; the mesh owns mid->role->track.
    getPeerVideo: (peerId) => {
      const peer = peers.get(peerId);
      if (!peer) return { cameraTrack: null, screenTrack: null };
      return classifyVideoTracks(peer.pc.getTransceivers(), peer.remoteRoles);
    },
    peerCount: () => peers.size,
    setLocalAudioStream,
    setLocalAudioMuted,
    setLocalScreenStream,
    setLocalCameraStream,
    setLocalCameraTrack,
    setCameraBitratePolicy,
    setVideoPausedPeers,
    setDndBlockedPeers,
    setLocalDndActive,
    getByteCounts,
    getPeerStats,
    // Rolling TURN credentials + the stats sampler that drives relay detection.
    setIceServers,
    startStatsSampler,
    stopStatsSampler,
    // Per-peer transport facts (from the latest sample). "direct" gates the
    // camera boost; "relay" drives the UI relay indicator. Unknown until the
    // first connected sample (conservative: not boostable, not flagged relay).
    isRelayed: (peerId) => peerTransport.get(peerId) === "relay",
    isDirect: (peerId) => peerTransport.get(peerId) === "direct",
    isCameraBoostEligible,
    refreshTransport,
    // Is a TURN relay even on offer? Answers the first question a "peer stuck
    // on ansluter" report raises: did the deployment actually hand out
    // TURN_SECRET/TURN_URLS, or is this client STUN-only?
    isTurnConfigured: () => turnUrlsConfigured(currentIceServers),
    /** Distinct STUN/TURN server failures seen this session. */
    getIceServerErrors: () => [...iceServerErrors.values()],
  };
}
