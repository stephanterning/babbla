// Integration ("wiring-rail") tests for the RoomController.
//
// The point of extracting createRoomController was to make the *glue* —
// server message / user action -> stage mutation -> ui render + signaling — fast
// to test without a browser, so a smaller model editing a handler can't silently
// break the wiring ("forgot render", wrong order, mis-wired callback).
//
// Harness: a REAL stage (pure, already unit-tested) + fake signaling (records
// sends, delivers inbound, reports open/closed) + fake mesh (records calls,
// scriptable getPeerVideo, fires its callbacks) + fake media + a spy ui (logs
// every call in order). Inbound is driven through the fake signaling
// (server -> client); user actions via controller methods.
//
// These assert the wiring, not the decisions (stage.test.js covers those). The
// last test is the rail itself: render runs after every presence/focus mutation.

import test from "node:test";
import assert from "node:assert/strict";

import { createStageDirector } from "../public/js/stage.js";
import { createRoomController } from "../public/js/room-controller.js";
import { MSG } from "../public/js/protocol.js";
import { readPendingRestore, writeDeployRestoreSnapshot } from "../public/js/session-restore.js";

// --- Fakes -----------------------------------------------------------------

// Every method of the real ui port (see main.js), recording calls in order so a
// test can assert which ports fired and with what.
const UI_METHODS = [
  "setStatus", "setError", "setRestoreFailed", "showUpgradeRestoredToast", "render",
  "setRoomControlsEnabled", "setCameraButton", "setShareButton",
  "setVideoOffButton", "setVideoOptOutUi", "setMuteUi", "setDndUi", "setPeerDnd",
  "showCameraLimitBanner",
  "addSelfTile", "removeSelfTile", "addTile", "removePeerMedia",
  "setPeerUncertain", "setPeerConnecting", "setPeerRelayed", "setPeerMuted",
  "setPeerAudio", "setSelfMicMeter",
  "setPeerVideo", "setLocalVideo", "clearPeerCamera", "clearIncomingCameras",
  "clearAllVideo", "playJoinSound", "playLeaveSound",
  "startBandwidthMeter", "stopBandwidthMeter", "pushPeerStats",
  "setRelayAvailable", "setIceServerError",
  "populateDevices", "syncDeviceSelects", "syncActiveSelection", "setAudioOutput", "teardownFullscreen",
  "clearBlockedAudio",
];

function makeSpyUi(log) {
  const ui = {};
  for (const name of UI_METHODS) {
    ui[name] = (...args) => log.push([name, ...args]);
  }
  // The real view returns whether the requested sink actually took; the
  // controller uses that to walk to the next speaker stack entry.
  ui.setAudioOutput = (...args) => {
    log.push(["setAudioOutput", ...args]);
    return Promise.resolve(true);
  };
  return ui;
}

/** Stack entry ids as persisted ("@system" for the follow-the-OS sentinel). */
const stackIds = (store, key) =>
  JSON.parse(store.get(key) || "[]").map((e) => (e.system ? "@system" : e.deviceId));

const calledNames = (log) => log.map((e) => e[0]);
const callsTo = (log, name) => log.filter((e) => e[0] === name);
const lastCall = (log, name) => callsTo(log, name).at(-1);

function makeFakeMedia() {
  const track = (deviceId) => {
    const listeners = {};
    return {
      enabled: true,
      contentHint: "",
      getSettings: () => ({ deviceId }),
      applyConstraints: async () => {},
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      // Test hook: simulate the device vanishing (unplug). Note the real
      // track.stop() never fires "ended", so this only stands in for a lost
      // device, matching what the recovery path keys off.
      _emit(type) {
        (listeners[type] || []).forEach((fn) => fn());
      },
      _stopped: false,
      stop() {
        this._stopped = true;
      },
    };
  };
  const constraintDeviceId = (constraint) => {
    if (!constraint || constraint === true) return null;
    const id = constraint.deviceId;
    if (!id) return null;
    if (typeof id === "string") return id;
    return id.exact || id.ideal || null;
  };
  const stream = (kind, deviceId) => {
    // Stable track instances so mutations (e.g. track.enabled on mute) persist
    // across later getAudioTracks() reads — the controller flips enabled on mute
    // and reads it back on reconnect to decide whether to re-announce.
    const audio = kind === "audio" ? [track(deviceId || "mic1")] : [];
    const video = kind === "audio" ? [] : [track(deviceId || (kind === "screen" ? "scr1" : "cam1"))];
    return {
      _kind: kind,
      getAudioTracks: () => audio,
      getVideoTracks: () => video,
      getTracks: () => [...audio, ...video],
    };
  };
  const api = {
    // Test hook: when true, an audio getUserMedia rejects (mic denied), so the
    // DND-exit re-acquire path can be exercised.
    failAudioCapture: false,
    missingDeviceIds: new Set(),
    getUserMedia: async (c) => {
      const resolveKind = (constraint, fallback) => {
        const exact = constraint?.deviceId?.exact;
        if (exact && api.missingDeviceIds.has(exact)) throw new Error("OverconstrainedError");
        const id = constraintDeviceId(constraint);
        if (id && api.missingDeviceIds.has(id)) return fallback;
        return id || fallback;
      };
      if (c.audio) {
        if (api.failAudioCapture) throw new Error("mic denied");
        return stream("audio", resolveKind(c.audio, "mic1"));
      }
      return stream(c.video ? "video" : "audio", resolveKind(c.video, "cam1"));
    },
    getDisplayMedia: async () => stream("screen"),
    enumerateDevices: async () => [
      { kind: "audioinput", deviceId: "mic1", groupId: "g-mic1", label: "Mic 1" },
      { kind: "audioinput", deviceId: "mic2", groupId: "g-mic2", label: "Mic 2" },
      { kind: "videoinput", deviceId: "cam1", groupId: "g-cam1", label: "Cam 1" },
      { kind: "videoinput", deviceId: "cam2", groupId: "g-cam2", label: "Cam 2" },
      { kind: "audiooutput", deviceId: "spk1", groupId: "g-spk1", label: "Speaker 1" },
      { kind: "audiooutput", deviceId: "spk2", groupId: "g-spk2", label: "Speaker 2" },
    ],
    canShareScreen: true,
  };
  return api;
}

// Fake signaling: captures the lifecycle callbacks createSignaling was given so
// the test can fire open/reconnecting and deliver inbound, and records every
// typed send. `open` gates isOpen() like the real open-send guard.
function makeFakeSignalingFactory(captured) {
  return function createSignaling(opts) {
    captured.signalingOpts = opts;
    let open = false;
    const record = (type) => (...args) => {
      captured.sends.push([type, ...args]);
      return open;
    };
    const sig = {
      open() { open = true; opts.onOpen?.(); },
      setOpen(v) { open = v; },
      reconnecting() { opts.onReconnecting?.(); },
      deliver(msg) { return opts.onMessage?.(msg); },
      isOpen: () => open,
      join: record("join"),
      leave: record("leave"),
      signal: record("signal"),
      mute: record("mute"),
      dnd: record("dnd"),
      share: record("share"),
      camera: record("camera"),
      videoOptOut: record("videoOptOut"),
      cameraFocus: record("cameraFocus"),
      videoSuppress: record("videoSuppress"),
      transport: record("transport"),
      iceError: record("iceError"),
      iceRefresh: record("iceRefresh"),
      close: () => { open = false; captured.sends.push(["close"]); },
    };
    captured.signaling = sig;
    return sig;
  };
}

// Fake mesh: captures its callbacks (so the test can fire onPeerVideoChanged /
// onPeerFailed / onConnectionState / onAudioTrack), records method calls, and
// returns scripted per-peer video from getPeerVideo.
function makeFakeMeshFactory(captured) {
  return function createMesh(opts) {
    captured.meshOpts = opts;
    const calls = captured.meshCalls;
    const present = new Set();
    const mesh = {
      addPeer: (id, name) => { present.add(id); calls.push(["addPeer", id, name]); },
      removePeer: (id) => { present.delete(id); calls.push(["removePeer", id]); },
      close: () => { present.clear(); calls.push(["close"]); },
      handleSignal: async (from, data) => { calls.push(["handleSignal", from, data]); },
      hasPeer: (id) => present.has(id),
      peerIds: () => [...present],
      getName: (id) => captured.names.get(id) ?? "",
      getPeerVideo: (id) =>
        captured.peerVideo.get(id) ?? { cameraTrack: null, screenTrack: null },
      peerCount: () => present.size,
      setLocalAudioStream: (s) => {
        captured.lastAudioStream = s;
        calls.push(["setLocalAudioStream", !!s]);
      },
      setLocalAudioMuted: (m) => calls.push(["setLocalAudioMuted", m]),
      setLocalScreenStream: (s) => calls.push(["setLocalScreenStream", !!s]),
      setLocalCameraStream: (s) => calls.push(["setLocalCameraStream", !!s]),
      setLocalCameraTrack: (s) => calls.push(["setLocalCameraTrack", !!s]),
      setCameraBitratePolicy: (p) => calls.push(["setCameraBitratePolicy", p]),
      setVideoPausedPeers: (s) => calls.push(["setVideoPausedPeers", [...s]]),
      setDndBlockedPeers: (s) => calls.push(["setDndBlockedPeers", [...s]]),
      setLocalDndActive: (a) => calls.push(["setLocalDndActive", a]),
      getByteCounts: async () => ({ bytesSent: 0, bytesReceived: 0 }),
      getPeerStats: async () => [],
      // Relay/transport + credential-refresh surface. Tests can override
      // isRelayed/isDirect per peer via captured.transport if needed; default
      // "unknown" (neither) mirrors a peer with no confirmed selected pair yet.
      setIceServers: (servers, opts) => calls.push(["setIceServers", servers, opts]),
      startStatsSampler: () => calls.push(["startStatsSampler"]),
      stopStatsSampler: () => calls.push(["stopStatsSampler"]),
      isRelayed: (id) => captured.transport?.get(id) === "relay",
      isDirect: (id) => captured.transport?.get(id) === "direct",
      isCameraBoostEligible: (id) => {
        const transport = captured.transport?.get(id) ?? "unknown";
        if (transport === "relay") return false;
        if (transport === "direct") return true;
        const reason = captured.transportUnknownReason?.get(id) ?? "no_pair";
        if (reason === "pair_unresolved") return false;
        return !captured.turnConfigured;
      },
      refreshTransport: async () => {
        calls.push(["refreshTransport"]);
        return true;
      },
      isTurnConfigured: () => !!captured.turnConfigured,
      getIceServerErrors: () => [],
    };
    captured.mesh = mesh;
    return mesh;
  };
}

// Fake mic pipeline: records setConfig/setMuted/rebuild and hands back the raw
// stream from getStream() (pass-through), so the controller's processed-stream
// attaches still look truthy to the fake mesh.
function makeFakePipelineFactory(captured) {
  return function createMicPipeline(rawStream, opts) {
    captured.pipelineOpts = opts;
    captured.pipelineRawStream = rawStream;
    const calls = captured.pipelineCalls;
    // Return a DISTINCT processed handle (not the raw stream) so tests can assert
    // the mesh + self-meter receive the processed output, not raw localStream.
    let stream = { _processedFrom: rawStream };
    const pipe = {
      getStream: () => stream,
      setConfig: (l) => calls.push(["setConfig", l]),
      setMuted: (m) => calls.push(["setMuted", m]),
      rebuild: (s) => {
        stream = { _processedFrom: s };
        calls.push(["rebuild", !!s]);
      },
      close: () => calls.push(["close"]),
    };
    captured.pipeline = pipe;
    return pipe;
  };
}

function makeMemoryStorage() {
  /** @implements {Storage} */
  return {
    map: new Map(),
    get length() { return this.map.size; },
    key() { return null; },
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; },
    setItem(k, v) { this.map.set(k, String(v)); },
    removeItem(k) { this.map.delete(k); },
    clear() { this.map.clear(); },
  };
}

function makeHarness(opts = {}) {
  const captured = { sends: [], meshCalls: [], pipelineCalls: [], peerVideo: new Map(), names: new Map(), reloads: 0 };
  const log = [];
  const stage = createStageDirector();
  const ui = makeSpyUi(log);
  const media = makeFakeMedia();
  const restoreStorage = opts.restoreStorage ?? null;
  const controller = createRoomController({
    stage,
    ui,
    media,
    signalingUrl: "ws://test/ws",
    clientBuildVersion: opts.clientBuildVersion ?? "test-version",
    roomPath: opts.roomPath ?? "/",
    reload: () => {
      captured.reloads++;
    },
    restoreStorage,
    reconnectHoldMs: opts.reconnectHoldMs,
    clientId: opts.clientId ?? "test-client",
    createMesh: makeFakeMeshFactory(captured),
    createSignaling: makeFakeSignalingFactory(captured),
    createMicPipeline: makeFakePipelineFactory(captured),
    ...(opts.controllerDeps ?? {}),
  });
  return { captured, log, stage, ui, media, controller, restoreStorage };
}

// Join, open the socket, and deliver a `welcome` so the harness is "in a room".
async function joinRoom(h, welcome = {}) {
  const ok = await h.controller.join("Me");
  assert.equal(ok, true);
  h.captured.signaling.open();
  await h.captured.signaling.deliver({
    type: MSG.WELCOME,
    id: "self",
    peers: [],
    cameras: [],
    muted: [],
    dnd: [],
    videoOptOuts: [],
    sharer: null,
    buildVersion: "test-version",
    ...welcome,
  });
}

const reset = (h) => { h.log.length = 0; h.captured.sends.length = 0; h.captured.meshCalls.length = 0; h.captured.pipelineCalls.length = 0; };

// --- Tests -----------------------------------------------------------------

test("join: success acquires mic, connects, and sends join on open", async () => {
  const h = makeHarness();
  const ok = await h.controller.join("Me");
  assert.equal(ok, true);
  assert.ok(h.captured.signaling, "signaling created on connect()");
  // join is sent only once the socket opens (open-send guard).
  assert.deepEqual(callsTo(h.captured.sends, "join"), []);
  h.captured.signaling.open();
  // The 4th arg is the STUN-discovered public IP; null here because the Node
  // test environment has no RTCPeerConnection, so the probe resolves null.
  assert.deepEqual(lastCall(h.captured.sends, "join"), ["join", "Me", "test-client", null]);
});

// A minimal RTCPeerConnection that yields one srflx candidate on a *macrotask*
// (setTimeout), so the public-IP probe only resolves after a real tick. That
// makes the await load-bearing: a microtask-only fake could resolve before join()
// returns and hide a missing await.
function fakeRtcWithSrflx(address) {
  return class {
    constructor() {
      this.listeners = {};
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    createDataChannel() {}
    createOffer() {
      return Promise.resolve({ type: "offer", sdp: "" });
    }
    setLocalDescription() {
      setTimeout(() => {
        for (const fn of this.listeners.icecandidate || [])
          fn({ candidate: { type: "srflx", address } });
      }, 0);
      return Promise.resolve();
    }
    close() {}
  };
}

test("join: awaits the STUN probe so the join carries the resolved public IP", async () => {
  const h = makeHarness();
  const prev = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = fakeRtcWithSrflx("203.0.113.7");
  try {
    await h.controller.join("Me");
    h.captured.signaling.open();
    // The srflx resolves on a macrotask; if join() didn't await the probe the
    // send would carry null. It carries the address -> join waited for it.
    assert.deepEqual(
      lastCall(h.captured.sends, "join"),
      ["join", "Me", "test-client", "203.0.113.7"],
    );
  } finally {
    globalThis.RTCPeerConnection = prev;
  }
});

test("join: re-probes the public IP on each join (no stale cache across a network change)", async () => {
  const h = makeHarness();
  const prev = globalThis.RTCPeerConnection;
  try {
    globalThis.RTCPeerConnection = fakeRtcWithSrflx("203.0.113.7");
    await h.controller.join("Me");
    h.captured.signaling.open();
    assert.deepEqual(
      lastCall(h.captured.sends, "join"),
      ["join", "Me", "test-client", "203.0.113.7"],
    );
    // Simulate switching network (VPN/Wi-Fi/5G) before joining another room: the
    // next join must re-probe and report the NEW IP, not the cached one.
    globalThis.RTCPeerConnection = fakeRtcWithSrflx("198.51.100.9");
    await h.controller.join("Me", { room: "other" });
    h.captured.signaling.open();
    assert.deepEqual(
      lastCall(h.captured.sends, "join"),
      ["join", "Me", "test-client", "198.51.100.9"],
    );
  } finally {
    globalThis.RTCPeerConnection = prev;
  }
});

test("join: mic failure returns false and does not connect", async () => {
  const h = makeHarness();
  h.media.getUserMedia = async () => { throw new Error("no mic"); };
  const ok = await h.controller.join("Me");
  assert.equal(ok, false);
  assert.equal(h.captured.signaling, undefined);
});

test("stats: transport reports are sent on change, deduped, initial unknown skipped", async () => {
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  reset(h);
  const onStats = h.captured.meshOpts.onStats;

  // Initial "unknown" (not yet connected) is NOT reported.
  onStats([{ peerId: "b", transport: "unknown" }]);
  assert.deepEqual(callsTo(h.captured.sends, "transport"), []);

  // First real classification is reported with candidate types.
  onStats([{ peerId: "b", transport: "relay", localCandidateType: "relay", remoteCandidateType: "host" }]);
  assert.deepEqual(lastCall(h.captured.sends, "transport"), ["transport", "b", "relay", "relay", "host"]);

  // Unchanged -> not re-sent (dedup).
  reset(h);
  onStats([{ peerId: "b", transport: "relay" }]);
  assert.deepEqual(callsTo(h.captured.sends, "transport"), []);

  // A change IS sent again.
  onStats([{ peerId: "b", transport: "direct" }]);
  assert.deepEqual(lastCall(h.captured.sends, "transport"), ["transport", "b", "direct", null, null]);
});

test("welcome: builds the room (mesh, self tile, controls, render)", async () => {
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  assert.equal(h.stage.view().participantCount, 2);
  assert.ok(h.captured.mesh, "mesh created");
  assert.deepEqual(lastCall(h.log, "addSelfTile")?.slice(0, 2), ["addSelfTile", "self"]);
  assert.deepEqual(lastCall(h.log, "addTile"), ["addTile", "b", "Bob"]);
  assert.ok(callsTo(h.log, "render").length >= 1, "rendered");
  assert.ok(callsTo(h.log, "startBandwidthMeter").length === 1);
});

test("rail 1: peer-joined -> addTile + render + playJoinSound", async () => {
  const h = makeHarness();
  await joinRoom(h);
  reset(h);
  await h.captured.signaling.deliver({ type: MSG.PEER_JOINED, id: "b", name: "Bob" });
  assert.deepEqual(lastCall(h.log, "addTile"), ["addTile", "b", "Bob"]);
  assert.deepEqual(lastCall(h.captured.meshCalls, "addPeer"), ["addPeer", "b", "Bob"]);
  assert.equal(callsTo(h.log, "playJoinSound").length, 1);
  assert.ok(callsTo(h.log, "render").length >= 1);
  // render runs before the chime (presence painted, then the notification).
  const names = calledNames(h.log);
  assert.ok(names.indexOf("render") < names.indexOf("playJoinSound"));
});

test("rail 2: peer-left -> removePeerMedia + render + playLeaveSound once", async () => {
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  reset(h);
  await h.captured.signaling.deliver({ type: MSG.PEER_LEFT, id: "b" });
  assert.deepEqual(lastCall(h.log, "removePeerMedia"), ["removePeerMedia", "b"]);
  assert.deepEqual(lastCall(h.captured.meshCalls, "removePeer"), ["removePeer", "b"]);
  assert.equal(callsTo(h.log, "playLeaveSound").length, 1);
  assert.ok(callsTo(h.log, "render").length >= 1);
  // A second peer-left for the same id is a no-op (no double chime).
  reset(h);
  await h.captured.signaling.deliver({ type: MSG.PEER_LEFT, id: "b" });
  assert.equal(callsTo(h.log, "playLeaveSound").length, 0);
});

test("rail 3: sharer on/off mirrors into stage and render", async () => {
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  reset(h);
  await h.captured.signaling.deliver({ type: MSG.SHARER, id: "b", name: "Bob" });
  assert.equal(h.stage.getSharerId(), "b");
  assert.deepEqual(lastCall(h.log, "render")[1].focus, {
    peerId: "b", type: "screen", isSelf: false,
  });
  await h.captured.signaling.deliver({ type: MSG.SHARER, id: null });
  assert.equal(h.stage.getSharerId(), null);
  assert.equal(lastCall(h.log, "render")[1].focus, null);
});

test("rail 4: camera-off on a focused peer invalidates the focus + render", async () => {
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "b", on: true });
  h.controller.focusTile("b", "camera");
  assert.deepEqual(h.stage.view().focus, { peerId: "b", type: "camera", isSelf: false });
  reset(h);
  await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "b", on: false });
  assert.equal(h.stage.view().focus, null, "camera-off self-heals the focus");
  assert.ok(callsTo(h.log, "render").length >= 1);
});

test("rail 5: onPeerVideoChanged reclassifies, gates on presence, pushes to ui", async () => {
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  const camT = { id: "camT" };
  const scrT = { id: "scrT" };
  h.captured.peerVideo.set("b", { cameraTrack: camT, screenTrack: scrT });

  // Camera on but NOT the sharer: camera passes the gate, screen is gated out.
  await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "b", on: true });
  reset(h);
  h.captured.meshOpts.onPeerVideoChanged("b");
  assert.deepEqual(lastCall(h.log, "setPeerVideo"), [
    "setPeerVideo", "b", { cameraTrack: camT, screenTrack: null },
  ]);
  assert.ok(callsTo(h.log, "render").length >= 1);

  // Now also the sharer: both pass the gate.
  await h.captured.signaling.deliver({ type: MSG.SHARER, id: "b", name: "Bob" });
  reset(h);
  h.captured.meshOpts.onPeerVideoChanged("b");
  assert.deepEqual(lastCall(h.log, "setPeerVideo"), [
    "setPeerVideo", "b", { cameraTrack: camT, screenTrack: scrT },
  ]);

  // Camera off: presence gate drops the camera track even though the mesh still
  // resolves one.
  await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "b", on: false });
  reset(h);
  h.captured.meshOpts.onPeerVideoChanged("b");
  assert.equal(lastCall(h.log, "setPeerVideo")[2].cameraTrack, null);
});

test("rail 6: onPeerFailed removes the peer and chimes once (deduped vs peer-left)", async () => {
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  reset(h);
  h.captured.meshOpts.onPeerFailed("b");
  assert.deepEqual(lastCall(h.log, "removePeerMedia"), ["removePeerMedia", "b"]);
  assert.equal(callsTo(h.log, "playLeaveSound").length, 1);
  // Server confirms the departure afterwards: already gone -> no second chime.
  reset(h);
  await h.captured.signaling.deliver({ type: MSG.PEER_LEFT, id: "b" });
  assert.equal(callsTo(h.log, "playLeaveSound").length, 0);
});

test("rail 7a: camera focus reconciler emits on change + open-guard", async () => {
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }, { id: "c", name: "Cee" }] });
  await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "b", on: true });
  await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "c", on: true });
  reset(h);
  h.controller.focusTile("b", "camera");
  assert.deepEqual(lastCall(h.captured.sends, "cameraFocus"), ["cameraFocus", "b", true]);
  // Switching focus b -> c emits the off for b and the on for c (only on change).
  reset(h);
  h.controller.focusTile("c", "camera");
  assert.deepEqual(callsTo(h.captured.sends, "cameraFocus"), [
    ["cameraFocus", "b", false],
    ["cameraFocus", "c", true],
  ]);
  // Open-guard: with the socket dropped, a focus change must NOT send.
  h.captured.signaling.setOpen(false);
  reset(h);
  h.controller.focusTile("c", "camera"); // unfocus c
  assert.equal(callsTo(h.captured.sends, "cameraFocus").length, 0, "no send while closed");
});

test("rail 7c: camera-focus during getUserMedia start is kept and boosts on settle", async () => {
  let releaseCamera;
  const cameraGate = new Promise((r) => {
    releaseCamera = r;
  });
  const baseMedia = makeFakeMedia();
  const h = makeHarness({
    controllerDeps: {
      media: {
        ...baseMedia,
        getUserMedia: async (c) => {
          if (c.video) await cameraGate;
          return baseMedia.getUserMedia(c);
        },
      },
    },
  });
  h.captured.transport = new Map([["b", "direct"]]);
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  reset(h);
  h.controller.toggleCamera();
  await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
  // Viewer focuses while our getUserMedia prompt is still open.
  await h.captured.signaling.deliver({ type: MSG.CAMERA_FOCUS, id: "b", on: true });
  releaseCamera();
  // Let startLocalCamera's async chain finish.
  await new Promise((r) => setTimeout(r, 0));
  const policyCalls = callsTo(h.captured.meshCalls, "setCameraBitratePolicy");
  assert.ok(policyCalls.length >= 1, "bitrate policy applied after camera start");
  const lastPolicy = policyCalls.at(-1)[1];
  assert.ok(
    lastPolicy.boosted instanceof Set && lastPolicy.boosted.has("b"),
    "focuser kept through the getUserMedia gap",
  );
  assert.equal(lastPolicy.boostedBitrate, 2_500_000);
  assert.ok(
    callsTo(h.captured.meshCalls, "refreshTransport").length >= 1,
    "refresh transport after focus",
  );
});

test("rail 7d: camera-focus while camera is off (not starting) is ignored", async () => {
  const h = makeHarness();
  h.captured.transport = new Map([["b", "direct"]]);
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  reset(h);
  await h.captured.signaling.deliver({ type: MSG.CAMERA_FOCUS, id: "b", on: true });
  assert.equal(callsTo(h.captured.meshCalls, "setCameraBitratePolicy").length, 0);
});

test("camera re-enable pins the remembered device with an exact deviceId", async () => {
  const baseMedia = makeFakeMedia();
  const camConstraints = [];
  const h = makeHarness({
    controllerDeps: {
      media: {
        ...baseMedia,
        getUserMedia: async (c) => {
          if (c.video) camConstraints.push(c.video.deviceId);
          return baseMedia.getUserMedia(c);
        },
      },
    },
  });
  await joinRoom(h);
  // Pick a non-default camera while the camera is off: just remembers the choice.
  await h.controller.switchCamera("cam2");
  camConstraints.length = 0;
  // Turning the camera on must request the remembered device *exactly* (an
  // `ideal` deviceId lets Chrome fall back to the first/default camera).
  h.controller.toggleCamera();
  await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(camConstraints, [{ exact: "cam2" }]);
});

test("camera re-enable falls back to any camera when the remembered device is gone", async () => {
  await withLocalStorage(async (store) => {
    const baseMedia = makeFakeMedia();
    const camConstraints = [];
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...baseMedia,
          getUserMedia: async (c) => {
            if (c.video) {
              camConstraints.push(c.video.deviceId);
              // The remembered exact device is unavailable (unplugged / in use).
              if (c.video.deviceId?.exact) throw new Error("OverconstrainedError");
            }
            return baseMedia.getUserMedia(c);
          },
        },
      },
    });
    await joinRoom(h);
    await h.controller.switchCamera("cam2");
    assert.deepEqual(stackIds(store, "babbla:cameraStack"), ["cam2"], "pick recorded");
    camConstraints.length = 0;
    reset(h);
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
    await new Promise((r) => setTimeout(r, 0));
    // First the exact pin, then an unconstrained retry (any camera) so a stale id
    // never blocks turning video on.
    assert.deepEqual(camConstraints, [{ exact: "cam2" }, undefined]);
    // The camera actually came up (mesh received the fallback stream).
    assert.ok(callsTo(h.captured.meshCalls, "setLocalCameraStream").some((c) => c[1] === true));
    // Fallback is live, but the pick stays on the stack so the vanished camera
    // is restored when it comes back.
    assert.deepEqual(
      stackIds(store, "babbla:cameraStack"),
      ["cam2"],
      "fallback must not overwrite the pick",
    );
  });
});

// Regression: unplugging the active (external) camera fires "ended" on its track
// (track.stop() never does). Without recovery the dropdown re-points at the still
// present internal camera but the dead stream renders black. Recovery must
// re-capture on a fallback camera and hand the fresh stream to the mesh.
test("camera device unplugged mid-stream re-captures on a fallback camera", async () => {
  await withLocalStorage(async () => {
    const baseMedia = makeFakeMedia();
    let lastVideoStream = null;
    const camConstraints = [];
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...baseMedia,
          getUserMedia: async (c) => {
            const s = await baseMedia.getUserMedia(c);
            if (c.video) {
              camConstraints.push(c.video.deviceId);
              lastVideoStream = s;
            }
            return s;
          },
        },
      },
    });
    await joinRoom(h);
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
    await new Promise((r) => setTimeout(r, 0));
    const liveTrack = lastVideoStream.getVideoTracks()[0];
    reset(h);
    camConstraints.length = 0;
    // Unplug: the device-backed track ends on its own.
    liveTrack._emit("ended");
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(camConstraints.length > 0, "re-captured after device loss");
    assert.ok(
      callsTo(h.captured.meshCalls, "setLocalCameraTrack").some((c) => c[1] === true),
      "fresh camera track handed to the mesh",
    );
    // Never told the room the camera went off — the picture just recovered.
    assert.equal(
      callsTo(h.captured.sends, "camera").filter((c) => c[1] === false).length,
      0,
      "no spurious camera-off announcement",
    );
  });
});

// Stricter unplug: the remembered (external) device is gone, so the exact pin
// must fail and recovery must retry unconstrained (any camera). Locks the full
// recovery capture sequence, not just "something was re-captured".
test("camera unplug: exact pin fails then recovery falls back to any camera", async () => {
  await withLocalStorage(async () => {
    const baseMedia = makeFakeMedia();
    let lastVideoStream = null;
    let failExact = false;
    const camConstraints = [];
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...baseMedia,
          getUserMedia: async (c) => {
            if (c.video) {
              camConstraints.push(c.video.deviceId);
              // The remembered external device is unplugged: its exact pin fails.
              if (failExact && c.video.deviceId?.exact) throw new Error("OverconstrainedError");
            }
            const s = await baseMedia.getUserMedia(c);
            if (c.video) lastVideoStream = s;
            return s;
          },
        },
      },
    });
    await joinRoom(h);
    await h.controller.switchCamera("cam1");
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
    await new Promise((r) => setTimeout(r, 0));
    const liveTrack = lastVideoStream.getVideoTracks()[0];
    reset(h);
    camConstraints.length = 0;
    failExact = true;
    liveTrack._emit("ended");
    await new Promise((r) => setTimeout(r, 0));
    // Full sequence: exact pin on the remembered device, then unconstrained retry.
    assert.deepEqual(camConstraints, [{ exact: "cam1" }, undefined]);
    assert.ok(
      callsTo(h.captured.meshCalls, "setLocalCameraTrack").some((c) => c[1] === true),
      "fallback camera track handed to the mesh",
    );
  });
});

// If no camera can be opened after the loss (e.g. the only camera was unplugged),
// stop cleanly and tell the room instead of leaving a live-looking black tile.
test("camera loss with no fallback stops cleanly and announces camera off", async () => {
  await withLocalStorage(async () => {
    const baseMedia = makeFakeMedia();
    let lastVideoStream = null;
    let failCapture = false;
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...baseMedia,
          getUserMedia: async (c) => {
            if (c.video && failCapture) throw new Error("NotFoundError");
            const s = await baseMedia.getUserMedia(c);
            if (c.video) lastVideoStream = s;
            return s;
          },
        },
      },
    });
    await joinRoom(h);
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
    await new Promise((r) => setTimeout(r, 0));
    const liveTrack = lastVideoStream.getVideoTracks()[0];
    reset(h);
    failCapture = true;
    liveTrack._emit("ended");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(
      lastCall(h.captured.sends, "camera"),
      ["camera", false],
      "room told the camera is off",
    );
    assert.ok(
      callsTo(h.captured.meshCalls, "setLocalCameraStream").some((c) => c[1] === false),
      "camera stream cleared from the mesh",
    );
  });
});

test("rail 7b: fullscreen drives video-suppress on/off for hidden peers", async () => {
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }, { id: "c", name: "Cee" }] });
  await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "b", on: true });
  await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "c", on: true });
  h.controller.focusTile("b", "camera");
  reset(h);
  h.controller.enterFullscreen();
  // Pinned to b -> tell c to pause the video it sends us.
  assert.deepEqual(lastCall(h.captured.sends, "videoSuppress"), ["videoSuppress", "c", true]);
  reset(h);
  h.controller.exitFullscreen();
  assert.deepEqual(lastCall(h.captured.sends, "videoSuppress"), ["videoSuppress", "c", false]);
});

test("reconnect hold disables room controls while WS is down", async () => {
  const h = makeHarness();
  await joinRoom(h);
  reset(h);
  h.captured.signaling.reconnecting();
  assert.deepEqual(lastCall(h.log, "setRoomControlsEnabled"), [
    "setRoomControlsEnabled",
    false,
    { videoOptOut: false },
  ]);
});

test("deploy restore join mirrors videoOptOut into stage + ui before connect", async () => {
  const h = makeHarness();
  const ok = await h.controller.join("Me", {
    restore: {
      reason: "deploy-restore",
      buildVersion: "x",
      roomPath: "/",
      name: "Me",
      muted: false,
      videoOptOut: true,
      cameraOn: false,
      screenOn: false,
      micDeviceId: null,
      cameraDeviceId: null,
      expiresAt: Date.now() + 60_000,
      restoreAttempts: 0,
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(lastCall(h.log, "setVideoOptOutUi"), ["setVideoOptOutUi", true]);
});

test("deploy restore join applies mute before connect", async () => {
  const h = makeHarness();
  const ok = await h.controller.join("Me", {
    restore: {
      reason: "deploy-restore",
      buildVersion: "x",
      roomPath: "/",
      name: "Me",
      muted: true,
      videoOptOut: false,
      cameraOn: false,
      screenOn: false,
      micDeviceId: null,
      cameraDeviceId: null,
      expiresAt: Date.now() + 60_000,
      restoreAttempts: 0,
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(lastCall(h.log, "setMuteUi"), ["setMuteUi", true]);
});

test("deploy restore join keeps explicit default mic intent in picker state", async () => {
  const h = makeHarness();
  h.media.enumerateDevices = async () => [
    { kind: "audioinput", deviceId: "mic1", groupId: "g1", label: "AirPods" },
    { kind: "audioinput", deviceId: "mic2", groupId: "g2", label: "Built-in Mic" },
    { kind: "audioinput", deviceId: "default", groupId: "g1", label: "Default - AirPods" },
  ];
  const ok = await h.controller.join("Me", {
    restore: {
      reason: "deploy-restore",
      buildVersion: "x",
      roomPath: "/",
      name: "Me",
      muted: false,
      videoOptOut: false,
      cameraOn: false,
      screenOn: false,
      micDeviceId: "default",
      cameraDeviceId: null,
      expiresAt: Date.now() + 60_000,
      restoreAttempts: 0,
    },
  });
  assert.equal(ok, true);
  assert.equal(lastCall(h.log, "populateDevices")[1].micId, "default");
});

test("rail 8: reconnect hold does not extend on repeated WS drops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  reset(h);
  h.captured.signaling.reconnecting();
  t.mock.timers.tick(3000);
  h.captured.signaling.reconnecting();
  t.mock.timers.tick(3000);
  assert.deepEqual(lastCall(h.log, "removePeerMedia"), ["removePeerMedia", "b"]);
});

test("rail 8b: reconnect defers teardown then welcome rebuilds session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  const firstMesh = h.captured.mesh;
  reset(h);
  h.captured.signaling.reconnecting();
  assert.equal(callsTo(h.log, "removePeerMedia").length, 0, "teardown deferred");
  assert.deepEqual(lastCall(h.log, "setStatus"), ["setStatus", "återansluter…"]);
  t.mock.timers.tick(5000);
  assert.deepEqual(lastCall(h.log, "removePeerMedia"), ["removePeerMedia", "b"]);
  reset(h);
  h.captured.signaling.open();
  await h.captured.signaling.deliver({
    type: MSG.WELCOME, id: "self2", peers: [{ id: "b", name: "Bob" }],
    cameras: [], videoOptOuts: [], sharer: null, buildVersion: "test-version",
  });
  assert.notEqual(h.captured.mesh, firstMesh, "a fresh mesh was created");
  assert.deepEqual(lastCall(h.log, "addTile"), ["addTile", "b", "Bob"]);
  assert.ok(callsTo(h.log, "addSelfTile").length === 1);
  assert.ok(callsTo(h.log, "render").length >= 1);
});

test("same-build reconnect re-attaches kept camera to mesh", async () => {
  const h = makeHarness();
  await joinRoom(h);
  await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
  await Promise.resolve();
  reset(h);
  h.captured.signaling.reconnecting();
  reset(h);
  h.captured.signaling.open();
  await h.captured.signaling.deliver({
    type: MSG.WELCOME,
    id: "self2",
    peers: [],
    cameras: [],
    videoOptOuts: [],
    sharer: null,
    buildVersion: "test-version",
  });
  assert.ok(
    callsTo(h.captured.meshCalls, "setLocalCameraStream").some((c) => c[1] === true),
    "camera stream re-attached to new mesh",
  );
  assert.deepEqual(lastCall(h.captured.sends, "camera"), ["camera", true]);
});

test("deploy: version mismatch captures snapshot and reloads", async () => {
  const h = makeHarness({
    clientBuildVersion: "client-old",
    roomPath: "/room/x",
    restoreStorage: makeMemoryStorage(),
  });
  await joinRoom(h, { buildVersion: "client-old" });
  reset(h);
  await h.captured.signaling.deliver({
    type: MSG.WELCOME,
    id: "self3",
    peers: [],
    cameras: [],
    videoOptOuts: [],
    sharer: null,
    buildVersion: "server-new",
  });
  assert.equal(h.captured.reloads, 1);
});

test("deploy: the snapshot carries no device ids (the stacks outlive the reload)", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:micId", "default");
    const h = makeHarness({
      clientBuildVersion: "client-old",
      roomPath: "/room/x",
      restoreStorage: makeMemoryStorage(),
    });
    await joinRoom(h, { buildVersion: "client-old" });
    reset(h);
    await h.captured.signaling.deliver({
      type: MSG.WELCOME,
      id: "self3",
      peers: [],
      cameras: [],
      videoOptOuts: [],
      sharer: null,
      buildVersion: "server-new",
    });
    const snap = readPendingRestore(h.restoreStorage);
    assert.ok(snap, "a restore snapshot was written");
    // Device picks live in localStorage, which survives the deploy reload, so
    // snapshotting one could only pin a temporary fallback as a choice.
    assert.equal(snap.micDeviceId, null);
    assert.equal(snap.cameraDeviceId, null);
    assert.deepEqual(stackIds(store, "babbla:micStack"), ["@system"], "intent kept in the stack");
  });
});

test("deploy: blocked snapshot closes signaling instead of leaving WS open", async () => {
  const storage = makeMemoryStorage();
  writeDeployRestoreSnapshot({
    buildVersion: "client-old",
    roomPath: "/room/x",
    name: "Me",
    muted: false,
    videoOptOut: false,
    cameraOn: false,
    screenOn: false,
    micDeviceId: null,
    cameraDeviceId: null,
  }, storage);
  const h = makeHarness({
    clientBuildVersion: "client-old",
    roomPath: "/room/x",
    restoreStorage: storage,
  });
  await joinRoom(h, { buildVersion: "client-old" });
  reset(h);
  await h.captured.signaling.deliver({
    type: MSG.WELCOME,
    id: "self3",
    peers: [],
    cameras: [],
    videoOptOuts: [],
    sharer: null,
    buildVersion: "server-new",
  });
  assert.equal(h.captured.reloads, 0);
  assert.ok(callsTo(h.captured.sends, "leave").length >= 1);
  assert.ok(callsTo(h.captured.sends, "close").length >= 1);
  assert.deepEqual(lastCall(h.log, "setRestoreFailed"), [
    "setRestoreFailed",
    "Kunde inte återställa efter uppdatering — gå med igen",
  ]);
});

test("action: toggleShare wires media + mesh + signaling + stage + render", async () => {
  const h = makeHarness();
  await joinRoom(h);
  reset(h);
  await h.controller.toggleShare();
  await Promise.resolve(); // let getDisplayMedia resolve
  assert.deepEqual(lastCall(h.captured.meshCalls, "setLocalScreenStream"), ["setLocalScreenStream", true]);
  assert.deepEqual(lastCall(h.captured.sends, "share"), ["share", true]);
  assert.equal(h.stage.getSharerId(), "self");
  assert.deepEqual(lastCall(h.log, "setShareButton"), ["setShareButton", true]);
  assert.ok(callsTo(h.log, "render").length >= 1);
});

test("action: toggleVideoOptOut signals + mirrors into stage + render", async () => {
  const h = makeHarness();
  await joinRoom(h);
  reset(h);
  h.controller.toggleVideoOptOut();
  assert.deepEqual(lastCall(h.captured.sends, "videoOptOut"), ["videoOptOut", true]);
  assert.deepEqual(lastCall(h.log, "setVideoOptOutUi"), ["setVideoOptOutUi", true]);
  assert.ok(callsTo(h.log, "render").length >= 1);
});

test("action: toggleMute flips the track and routes through mesh + ui + signaling", async () => {
  const h = makeHarness();
  await joinRoom(h);
  reset(h);
  h.controller.toggleMute();
  assert.deepEqual(lastCall(h.log, "setMuteUi"), ["setMuteUi", true]);
  assert.deepEqual(lastCall(h.captured.meshCalls, "setLocalAudioMuted"), ["setLocalAudioMuted", true]);
  // Mute presence is broadcast so peers can show a mic-off badge.
  assert.deepEqual(lastCall(h.captured.sends, "mute"), ["mute", true]);
  // Unmute broadcasts the off.
  reset(h);
  h.controller.toggleMute();
  assert.deepEqual(lastCall(h.captured.sends, "mute"), ["mute", false]);
});

test("welcome: applies muted peers from the roster to their tiles", async () => {
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }, { id: "c", name: "Cee" }], muted: ["b"] });
  assert.deepEqual(lastCall(h.log, "setPeerMuted"), ["setPeerMuted", "b", true]);
  // Cee was not in the muted roster, so no mute badge was set for them.
  assert.ok(!callsTo(h.log, "setPeerMuted").some((c) => c[1] === "c"));
});

test("inbound mute: a peer (un)mute toggles its tile badge", async () => {
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  reset(h);
  await h.captured.signaling.deliver({ type: MSG.MUTE, id: "b", on: true });
  assert.deepEqual(lastCall(h.log, "setPeerMuted"), ["setPeerMuted", "b", true]);
  await h.captured.signaling.deliver({ type: MSG.MUTE, id: "b", on: false });
  assert.deepEqual(lastCall(h.log, "setPeerMuted"), ["setPeerMuted", "b", false]);
});

test("reconnect re-announces our own mute on the fresh welcome", async () => {
  const h = makeHarness();
  await joinRoom(h);
  h.controller.toggleMute(); // we are muted
  // Drop and rebuild the session via a fresh welcome.
  h.captured.signaling.reconnecting();
  reset(h);
  h.captured.signaling.open();
  await h.captured.signaling.deliver({
    type: MSG.WELCOME, id: "self2", peers: [], cameras: [], muted: [],
    videoOptOuts: [], sharer: null, buildVersion: "test-version",
  });
  // The mic track stayed muted across the reconnect, so re-announce mute.
  assert.deepEqual(lastCall(h.captured.sends, "mute"), ["mute", true]);
});

const flush = () => new Promise((r) => setTimeout(r, 0));

test("action: toggleDnd signals + drives the mesh + DND UI both ways", async () => {
  const h = makeHarness();
  await joinRoom(h);
  reset(h);
  h.controller.toggleDnd(); // enter
  assert.deepEqual(lastCall(h.captured.sends, "dnd"), ["dnd", true]);
  assert.deepEqual(lastCall(h.log, "setDndUi"), ["setDndUi", true]);
  assert.deepEqual(lastCall(h.captured.meshCalls, "setLocalDndActive"), [
    "setLocalDndActive",
    true,
  ]);
  reset(h);
  h.controller.toggleDnd(); // exit
  await flush();
  assert.deepEqual(lastCall(h.captured.sends, "dnd"), ["dnd", false]);
  assert.deepEqual(lastCall(h.log, "setDndUi"), ["setDndUi", false]);
  assert.deepEqual(lastCall(h.captured.meshCalls, "setLocalDndActive"), [
    "setLocalDndActive",
    false,
  ]);
  // On exit we reconcile the presence the room missed while dark: re-announce the
  // true mute + video-opt-out state.
  assert.deepEqual(lastCall(h.captured.sends, "mute"), ["mute", false]);
  assert.deepEqual(lastCall(h.captured.sends, "videoOptOut"), ["videoOptOut", false]);
});

test("welcome: applies dnd peers from the roster (moon badge + mesh block)", async () => {
  const h = makeHarness();
  await joinRoom(h, {
    peers: [{ id: "b", name: "Bob" }, { id: "c", name: "Cee" }],
    dnd: ["b"],
  });
  assert.deepEqual(lastCall(h.log, "setPeerDnd"), ["setPeerDnd", "b", true]);
  assert.ok(!callsTo(h.log, "setPeerDnd").some((c) => c[1] === "c" && c[2] === true));
  const blocked = lastCall(h.captured.meshCalls, "setDndBlockedPeers");
  assert.ok(blocked && blocked[1].includes("b"));
});

test("inbound dnd: a peer (un)dnd toggles its moon badge + mesh block", async () => {
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  reset(h);
  await h.captured.signaling.deliver({ type: MSG.DND, id: "b", on: true });
  assert.deepEqual(lastCall(h.log, "setPeerDnd"), ["setPeerDnd", "b", true]);
  assert.deepEqual(lastCall(h.captured.meshCalls, "setDndBlockedPeers"), [
    "setDndBlockedPeers",
    ["b"],
  ]);
  // Peer-DND must NOT touch the fullscreen video-suppress set — they union in the
  // mesh, so the controller drives them via separate setters (can't stomp).
  assert.ok(!callsTo(h.captured.meshCalls, "setVideoPausedPeers").length);
  await h.captured.signaling.deliver({ type: MSG.DND, id: "b", on: false });
  assert.deepEqual(lastCall(h.log, "setPeerDnd"), ["setPeerDnd", "b", false]);
  assert.deepEqual(lastCall(h.captured.meshCalls, "setDndBlockedPeers"), [
    "setDndBlockedPeers",
    [],
  ]);
});

test("a peer entering/leaving DND chimes like leave/join (once, after the render)", async () => {
  const h = makeHarness();
  await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
  reset(h);
  await h.captured.signaling.deliver({ type: MSG.DND, id: "b", on: true });
  assert.equal(callsTo(h.log, "playLeaveSound").length, 1);
  assert.equal(callsTo(h.log, "playJoinSound").length, 0);
  // Badge + render before the chime, same ordering as a real leave.
  let names = calledNames(h.log);
  assert.ok(names.indexOf("render") < names.indexOf("playLeaveSound"));
  // A repeated "on" for a peer who is already flagged must not chime again.
  reset(h);
  await h.captured.signaling.deliver({ type: MSG.DND, id: "b", on: true });
  assert.equal(callsTo(h.log, "playLeaveSound").length, 0);
  assert.equal(callsTo(h.log, "playJoinSound").length, 0);
  reset(h);
  await h.captured.signaling.deliver({ type: MSG.DND, id: "b", on: false });
  assert.equal(callsTo(h.log, "playJoinSound").length, 1);
  assert.equal(callsTo(h.log, "playLeaveSound").length, 0);
  names = calledNames(h.log);
  assert.ok(names.indexOf("render") < names.indexOf("playJoinSound"));
  // A repeated "off" for a peer who isn't flagged must not chime again.
  reset(h);
  await h.captured.signaling.deliver({ type: MSG.DND, id: "b", on: false });
  assert.equal(callsTo(h.log, "playJoinSound").length, 0);
  assert.equal(callsTo(h.log, "playLeaveSound").length, 0);
});

test("welcome roster with DND peers does not chime", async () => {
  const h = makeHarness();
  await joinRoom(h, {
    peers: [{ id: "b", name: "Bob" }, { id: "c", name: "Cee" }],
    dnd: ["b"],
  });
  assert.equal(callsTo(h.log, "playJoinSound").length, 0);
  assert.equal(callsTo(h.log, "playLeaveSound").length, 0);
});

test("reconnect re-announces our own dnd and re-asserts the mesh block", async () => {
  const h = makeHarness();
  await joinRoom(h);
  h.controller.toggleDnd(); // we are in DND
  h.captured.signaling.reconnecting();
  reset(h);
  h.captured.signaling.open();
  await h.captured.signaling.deliver({
    type: MSG.WELCOME, id: "self2", peers: [], cameras: [], muted: [], dnd: [],
    videoOptOuts: [], sharer: null, buildVersion: "test-version",
  });
  assert.deepEqual(lastCall(h.captured.sends, "dnd"), ["dnd", true]);
  // The rebuilt mesh must be re-told we're in DND (createRoomMesh).
  assert.deepEqual(lastCall(h.captured.meshCalls, "setLocalDndActive"), [
    "setLocalDndActive",
    true,
  ]);
});

test("DND stops the mic capture and re-acquires it on exit", async () => {
  const h = makeHarness();
  await joinRoom(h);
  const micTrack = () => h.captured.pipeline && h.captured.pipelineRawStream;
  reset(h);
  h.controller.toggleDnd(); // enter DND -> stops the raw mic capture
  // The raw mic track was stopped (device released -> OS indicator off).
  assert.ok(micTrack().getAudioTracks()[0]._stopped);
  reset(h);
  h.controller.toggleDnd(); // exit -> re-acquire mic + re-wire pipeline + mesh
  await flush();
  // A fresh mic stream is attached to the mesh + self meter.
  assert.ok(callsTo(h.captured.meshCalls, "setLocalAudioStream").length >= 1);
  assert.ok(callsTo(h.log, "setSelfMicMeter").length >= 1);
  // Mute presence is re-announced (pre-DND state: unmuted here).
  assert.deepEqual(lastCall(h.captured.sends, "mute"), ["mute", false]);
});

test("DND exit with a failed mic re-acquire presents as muted, not unmuted", async () => {
  const h = makeHarness();
  await joinRoom(h); // we're unmuted here
  h.controller.toggleDnd(); // enter DND -> mic released
  reset(h);
  h.media.failAudioCapture = true; // the re-acquire will be denied
  h.controller.toggleDnd(); // exit
  await flush();
  // Honest presence: we have no live mic, so we must NOT announce "unmuted".
  assert.deepEqual(lastCall(h.captured.sends, "mute"), ["mute", true]);
  assert.deepEqual(lastCall(h.log, "setMuteUi"), ["setMuteUi", true]);
  assert.deepEqual(lastCall(h.captured.meshCalls, "setLocalAudioMuted"), [
    "setLocalAudioMuted",
    true,
  ]);
});

test("during DND the mute/camera/share toggles are inert", async () => {
  const h = makeHarness();
  await joinRoom(h);
  h.controller.toggleDnd(); // enter DND
  reset(h);
  h.controller.toggleMute();
  h.controller.toggleCamera();
  h.controller.toggleShare();
  await flush();
  assert.equal(callsTo(h.captured.sends, "mute").length, 0);
  assert.equal(callsTo(h.captured.sends, "camera").length, 0);
  assert.equal(callsTo(h.captured.sends, "share").length, 0);
});

test("DND-on stops an active camera's presence; exit does NOT auto-restore it", async () => {
  const h = makeHarness();
  await joinRoom(h);
  // Turn the camera on the normal way first.
  h.controller.toggleCamera();
  await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
  await flush();
  reset(h);
  h.controller.toggleDnd(); // enter DND
  // Camera presence is de-announced so peers don't show a stream-less tile.
  assert.deepEqual(lastCall(h.captured.sends, "camera"), ["camera", false]);
  // Exiting DND does NOT auto-restore the camera — it's re-enabled manually.
  reset(h);
  h.controller.toggleDnd();
  await flush();
  assert.equal(callsTo(h.captured.sends, "camera").length, 0);
});

test("deploy restore re-enters DND after the welcome", async () => {
  const h = makeHarness();
  const ok = await h.controller.join("Me", {
    restore: {
      reason: "deploy-restore",
      buildVersion: "x",
      roomPath: "/",
      name: "Me",
      muted: false,
      videoOptOut: false,
      dnd: true,
      cameraOn: false,
      screenOn: false,
      micDeviceId: null,
      cameraDeviceId: null,
      expiresAt: Date.now() + 60_000,
      restoreAttempts: 0,
    },
  });
  assert.equal(ok, true);
  h.captured.signaling.open();
  await h.captured.signaling.deliver({
    type: MSG.WELCOME, id: "self", peers: [], cameras: [], muted: [], dnd: [],
    videoOptOuts: [], sharer: null, buildVersion: "test-version",
  });
  await flush();
  assert.deepEqual(lastCall(h.captured.sends, "dnd"), ["dnd", true]);
  assert.deepEqual(lastCall(h.log, "setDndUi"), ["setDndUi", true]);
});

test("leaveToLanding resets DND for the next room", async () => {
  const h = makeHarness();
  await joinRoom(h);
  h.controller.toggleDnd();
  h.controller.leaveToLanding();
  assert.deepEqual(lastCall(h.log, "setDndUi"), ["setDndUi", false]);
});

test("async-gap: startLocalCamera bails + releases the stream if torn down mid-prompt", async () => {
  const h = makeHarness({ reconnectHoldMs: 0 });
  await joinRoom(h);
  const stopped = [];
  const stream = {
    getTracks: () => [{ stop: () => stopped.push("cam") }],
    getVideoTracks: () => [{ contentHint: "", getSettings: () => ({}), applyConstraints: async () => {}, stop() {} }],
  };
  let resolve;
  h.media.getUserMedia = () => new Promise((r) => { resolve = () => r(stream); });
  await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
  h.captured.signaling.reconnecting();
  await flush();
  resolve();
  await flush();
  assert.deepEqual(stopped, ["cam"], "captured camera stream released, no throw");
  assert.equal(callsTo(h.captured.meshCalls, "setLocalCameraStream").length, 0);
});

test("async-gap: startShare bails + releases the stream if torn down mid-picker", async () => {
  const h = makeHarness({ reconnectHoldMs: 0 });
  await joinRoom(h);
  const stopped = [];
  const stream = {
    getTracks: () => [{ stop: () => stopped.push("scr") }],
    getVideoTracks: () => [{ contentHint: "", addEventListener() {}, stop() {} }],
  };
  let resolve;
  h.media.getDisplayMedia = () => new Promise((r) => { resolve = () => r(stream); });
  h.controller.toggleShare();
  await flush();
  h.captured.signaling.reconnecting();
  await flush();
  resolve();
  await flush();
  assert.deepEqual(stopped, ["scr"], "captured screen stream released, no throw");
  assert.equal(h.stage.getSharerId(), null, "no sharer set after the bail-out");
});

// The rail: render must run after *every* presence/focus mutation. This is the
// guardrail the whole extraction is for — a handler that mutates presence but
// forgets to render would fail here.
test("rail 9: every presence/focus message renders", async () => {
  const messages = [
    { type: MSG.PEER_JOINED, id: "c", name: "Cee" },
    { type: MSG.CAMERA, id: "b", on: true },
    { type: MSG.SHARER, id: "b", name: "Bob" },
    { type: MSG.VIDEO_OPT_OUT, id: "b", on: true },
    { type: MSG.CAMERA_LIMIT },
    { type: MSG.PEER_LEFT, id: "b" },
  ];
  for (const msg of messages) {
    const h = makeHarness();
    await joinRoom(h, { peers: [{ id: "b", name: "Bob" }] });
    reset(h);
    await h.captured.signaling.deliver(msg);
    assert.ok(
      callsTo(h.log, "render").length >= 1,
      `expected render after ${msg.type}`,
    );
  }
});

// --- Speaker (audio output) picker -----------------------------------------
// In-memory localStorage so the controller's device-pref read/write actually
// persists during a test (saveDevicePref/readDevicePref are try/catch-guarded
// and otherwise no-op in Node, where there is no localStorage).
function withLocalStorage(fn) {
  const store = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return Promise.resolve(fn(store)).finally(() => {
    if (prev === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prev;
  });
}

test("speaker: refreshDevices passes enumerated speakers + pref to populateDevices", async () => {
  const h = makeHarness();
  h.media.enumerateDevices = async () => [
    { kind: "audioinput", deviceId: "mic1", label: "Mic 1" },
    { kind: "audiooutput", deviceId: "spk1", groupId: "g1", label: "Speaker 1" },
    { kind: "audiooutput", deviceId: "spk2", groupId: "g2", label: "Speaker 2" },
    { kind: "audiooutput", deviceId: "default", groupId: "g2", label: "Default - Speaker 2" },
  ];
  await joinRoom(h);
  const call = lastCall(h.log, "populateDevices");
  assert.ok(call, "populateDevices was called");
  const arg = call[1];
  // Synthetic "default" is filtered out; both real speakers pass through.
  assert.deepEqual(arg.speakers.map((s) => s.deviceId), ["spk1", "spk2"]);
  assert.deepEqual(
    lastCall(h.log, "setAudioOutput"),
    ["setAudioOutput", ""],
    "no picks -> Systemstandard",
  );
  assert.equal(arg.speakerDefaultName, "Speaker 2");
  assert.equal(arg.hasMicDefault, false);
});

test("speaker: default name falls back to first concrete output when default device is hidden by the browser", async () => {
  const h = makeHarness();
  h.media.enumerateDevices = async () => [
    { kind: "audiooutput", deviceId: "spk1", label: "Firefox Speaker" },
    { kind: "audiooutput", deviceId: "spk2", label: "Conference Display" },
  ];
  await joinRoom(h);
  const arg = lastCall(h.log, "populateDevices")[1];
  assert.equal(arg.speakerDefaultName, "Firefox Speaker");
});

test("speaker: switchSpeaker pushes the pick and routes via ui.setAudioOutput", async () => {
  await withLocalStorage(async (store) => {
    const h = makeHarness();
    await joinRoom(h);
    reset(h);
    await h.controller.switchSpeaker("spk2");
    assert.deepEqual(
      lastCall(h.log, "syncActiveSelection"),
      ["syncActiveSelection", { speakerId: "spk2" }],
    );
    assert.deepEqual(lastCall(h.log, "setAudioOutput"), ["setAudioOutput", "spk2"]);
    assert.deepEqual(stackIds(store, "babbla:speakerStack"), ["spk2"]);
  });
});

test("speaker: re-picking the already-routed device still records the pick", async () => {
  await withLocalStorage(async (store) => {
    const h = makeHarness();
    await joinRoom(h);
    await h.controller.switchSpeaker("spk1");
    await h.controller.switchSpeaker("spk2");
    assert.deepEqual(stackIds(store, "babbla:speakerStack"), ["spk2", "spk1"]);
    // spk2 is already live; picking it again must still move it to the top
    // rather than being swallowed as a no-op.
    await h.controller.switchSpeaker("spk1");
    assert.deepEqual(stackIds(store, "babbla:speakerStack"), ["spk1", "spk2"]);
  });
});

test("speaker: a legacy single-pick key migrates to a one-entry stack and routes", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:speakerId", "spk2");
    const h = makeHarness();
    h.media.enumerateDevices = async () => [
      { kind: "audiooutput", deviceId: "spk1", label: "Speaker 1" },
      { kind: "audiooutput", deviceId: "spk2", label: "Speaker 2" },
    ];
    await joinRoom(h);
    assert.deepEqual(stackIds(store, "babbla:speakerStack"), ["spk2"]);
    assert.deepEqual(lastCall(h.log, "setAudioOutput"), ["setAudioOutput", "spk2"]);
    // The legacy key is left alone so rolling back to an older build still works.
    assert.equal(store.get("babbla:speakerId"), "spk2");
  });
});

test("speaker: picking Systemstandard pushes the sentinel and prunes below it", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:speakerId", "spk2");
    const h = makeHarness();
    await joinRoom(h);
    reset(h);
    await h.controller.switchSpeaker("");
    assert.deepEqual(
      lastCall(h.log, "syncActiveSelection"),
      ["syncActiveSelection", { speakerId: "" }],
    );
    assert.deepEqual(lastCall(h.log, "setAudioOutput"), ["setAudioOutput", ""]);
    // "Follow the OS" always resolves, so anything under it could never be
    // consulted again — it is dropped rather than kept as dead state.
    assert.deepEqual(stackIds(store, "babbla:speakerStack"), ["@system"]);
  });
});

test("camera: switchCamera while camera is off records the pick without starting capture", async () => {
  await withLocalStorage(async (store) => {
    const h = makeHarness();
    await joinRoom(h);
    reset(h);
    await h.controller.switchCamera("cam2");
    assert.deepEqual(
      lastCall(h.log, "syncActiveSelection"),
      ["syncActiveSelection", { camId: "cam2" }],
    );
    assert.deepEqual(stackIds(store, "babbla:cameraStack"), ["cam2"]);
    // Auto-selection must never light the camera LED on its own.
    assert.equal(callsTo(h.captured.meshCalls, "setLocalCameraStream").length, 0);
  });
});

test("mic: remembered 'default' intent surfaces in populateDevices + default metadata", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:micId", "default");
    const h = makeHarness();
    h.media.enumerateDevices = async () => [
      { kind: "audioinput", deviceId: "mic1", groupId: "g1", label: "AirPods" },
      { kind: "audioinput", deviceId: "mic2", groupId: "g2", label: "Built-in Mic" },
      { kind: "audioinput", deviceId: "default", groupId: "g1", label: "Default - AirPods" },
    ];
    await joinRoom(h);
    const arg = lastCall(h.log, "populateDevices")[1];
    assert.equal(arg.micId, "default");
    assert.equal(arg.hasMicDefault, true);
    assert.equal(arg.micDefaultName, "AirPods");
  });
});

test("mic: default label falls back to active mic when browser omits audioinput:default", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:micId", "default");
    const h = makeHarness();
    h.media.enumerateDevices = async () => [
      { kind: "audioinput", deviceId: "mic1", label: "Built-in Mic" },
      { kind: "audioinput", deviceId: "mic2", label: "USB Mic" },
    ];
    await joinRoom(h);
    const arg = lastCall(h.log, "populateDevices")[1];
    assert.equal(arg.micId, "default");
    assert.equal(arg.hasMicDefault, false);
    assert.equal(arg.micDefaultName, "Built-in Mic");
  });
});

test("mic: default label prefers first concrete device over an explicitly selected non-default mic", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:micId", "mic2");
    const h = makeHarness();
    h.media.getUserMedia = async () => {
      const track = {
        enabled: true,
        contentHint: "",
        getSettings: () => ({ deviceId: "mic2" }),
        applyConstraints: async () => {},
        addEventListener() {},
        stop() {},
      };
      return {
        getAudioTracks: () => [track],
        getVideoTracks: () => [],
        getTracks: () => [track],
      };
    };
    h.media.enumerateDevices = async () => [
      { kind: "audioinput", deviceId: "mic1", label: "MacBook Pro Microphone" },
      { kind: "audioinput", deviceId: "mic2", label: "BlackHole 64ch" },
    ];
    await joinRoom(h);
    const arg = lastCall(h.log, "populateDevices")[1];
    assert.equal(arg.micId, "mic2");
    assert.equal(arg.micDefaultName, "MacBook Pro Microphone");
  });
});

test("mic: switching to Systemstandard recaptures unconstrained, then no-ops", async () => {
  await withLocalStorage(async (store) => {
    const h = makeHarness();
    h.media.enumerateDevices = async () => [
      { kind: "audioinput", deviceId: "mic1", groupId: "g1", label: "AirPods" },
      { kind: "audioinput", deviceId: "mic2", groupId: "g2", label: "Built-in Mic" },
      { kind: "audioinput", deviceId: "default", groupId: "g1", label: "Default - AirPods" },
    ];
    await joinRoom(h);

    const seenConstraints = [];
    const track = {
      enabled: true,
      contentHint: "",
      getSettings: () => ({ deviceId: "mic1" }),
      applyConstraints: async () => {},
      addEventListener() {},
      stop() {},
    };
    const stream = {
      getAudioTracks: () => [track],
      getVideoTracks: () => [],
      getTracks: () => [track],
    };
    h.media.getUserMedia = async (constraints) => {
      seenConstraints.push(constraints);
      return stream;
    };

    // Start from an explicit concrete pick, so moving to Systemstandard is a
    // genuine change of intent rather than a restatement of the status quo.
    reset(h);
    await h.controller.switchMicrophone("mic2");
    assert.deepEqual(stackIds(store, "babbla:micStack"), ["mic2"]);
    seenConstraints.length = 0;

    reset(h);
    await h.controller.switchMicrophone("default");
    assert.equal(seenConstraints.length, 1, "captured once");
    assert.equal(seenConstraints[0]?.audio?.deviceId, undefined, "unconstrained capture");
    assert.deepEqual(
      stackIds(store, "babbla:micStack"),
      ["@system"],
      "the sentinel prunes the concrete pick below it",
    );
    assert.equal(lastCall(h.log, "populateDevices")[1].micId, "default");

    reset(h);
    await h.controller.switchMicrophone("default");
    assert.equal(seenConstraints.length, 1, "already on the OS default -> no dead air");
  });
});

test("mic: picking the device that is ALREADY live still records it as the top pick", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:micId", "studio-mic");
    const base = makeFakeMedia();
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...base,
          getUserMedia: async (c) => {
            const exact = c.audio?.deviceId?.exact;
            if (exact === "studio-mic") throw new Error("Overconstrained");
            return base.getUserMedia(c);
          },
          enumerateDevices: async () => [
            { kind: "audioinput", deviceId: "mic1", groupId: "g1", label: "Built-in Mic" },
          ],
        },
      },
    });
    await joinRoom(h);
    // The picked mic is gone, so mic1 is the live fallback and the picker shows
    // Systemstandard rather than pretending mic1 was chosen.
    assert.equal(lastCall(h.log, "populateDevices")[1].micId, "default");
    assert.deepEqual(stackIds(store, "babbla:micStack"), ["studio-mic"]);
    // Now the user explicitly picks the mic that already happens to be live.
    // Nothing about the capture changes, but the intent does — and if that were
    // swallowed, the absent studio mic would steal the mic back on reconnect.
    await h.controller.switchMicrophone("mic1");
    assert.deepEqual(stackIds(store, "babbla:micStack"), ["mic1", "studio-mic"]);
    assert.equal(lastCall(h.log, "populateDevices")[1].micId, "mic1");
  });
});

test("camera: first enable without a pick does not persist the granted device", async () => {
  await withLocalStorage(async (store) => {
    const h = makeHarness();
    await joinRoom(h);
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(store.has("babbla:cameraStack"), false, "no implicit pick on first enable");
  });
});

test("mic: join fallback does not overwrite a remembered pick", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:micId", "studio-mic");
    const h = makeHarness();
    h.media.missingDeviceIds.add("studio-mic");
    h.media.enumerateDevices = async () => [
      { kind: "audioinput", deviceId: "mic1", label: "Built-in Mic" },
    ];
    await joinRoom(h);
    assert.equal(store.get("babbla:micId"), "studio-mic", "localStorage unchanged");
    assert.equal(
      lastCall(h.log, "populateDevices")[1].micId,
      "default",
      "UI shows Systemstandard while the pick is gone",
    );
  });
});

test("camera: unplug fallback does not persist the replacement device", async () => {
  await withLocalStorage(async (store) => {
    const baseMedia = makeFakeMedia();
    let lastVideoStream = null;
    let cam2Gone = false;
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...baseMedia,
          getUserMedia: async (c) => {
            if (cam2Gone && c.video?.deviceId?.exact === "cam2") {
              throw new Error("OverconstrainedError");
            }
            const s = await baseMedia.getUserMedia(c);
            if (c.video) lastVideoStream = s;
            return s;
          },
        },
      },
    });
    await joinRoom(h);
    await h.controller.switchCamera("cam2");
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(stackIds(store, "babbla:cameraStack"), ["cam2"]);
    cam2Gone = true;
    lastVideoStream.getVideoTracks()[0]._emit("ended");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(
      stackIds(store, "babbla:cameraStack"),
      ["cam2"],
      "fallback is not saved as the pick",
    );
  });
});

test("camera: a churned deviceId is rematched by label WITHOUT rewriting the stack", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:cameraId", "cam-old");
    store.set("babbla:cameraId:meta", JSON.stringify({ groupId: "gone", label: "Studio Display" }));
    const seen = [];
    const baseMedia = makeFakeMedia();
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...baseMedia,
          getUserMedia: async (c) => {
            if (c.video) seen.push(c.video.deviceId);
            return baseMedia.getUserMedia(c);
          },
          enumerateDevices: async () => [
            { kind: "videoinput", deviceId: "cam-new", groupId: "g2", label: "Studio Display" },
            { kind: "videoinput", deviceId: "cam1", groupId: "g1", label: "FaceTime HD" },
          ],
        },
      },
    });
    await joinRoom(h);
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(
      seen.some((id) => id?.exact === "cam-new"),
      "capture follows the rematched device",
    );
    // Resolution is a pure read: the entry keeps its original description, so a
    // wrong label guess costs one session instead of destroying the pick.
    assert.deepEqual(stackIds(store, "babbla:cameraStack"), ["cam-old"]);
  });
});

test("camera: an ambiguous label is not guessed at", async () => {
  await withLocalStorage(async () => {
    const seen = [];
    const baseMedia = makeFakeMedia();
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...baseMedia,
          getUserMedia: async (c) => {
            if (c.video) seen.push(c.video.deviceId);
            return baseMedia.getUserMedia(c);
          },
          // Two cameras share the label the stack remembers, so matching by
          // label would be a coin flip between distinct physical devices.
          enumerateDevices: async () => [
            { kind: "videoinput", deviceId: "cam-a", groupId: "ga", label: "HD Webcam" },
            { kind: "videoinput", deviceId: "cam-b", groupId: "gb", label: "HD Webcam" },
          ],
        },
      },
    });
    await joinRoom(h);
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(
      seen.some((id) => id?.exact === "cam-a" || id?.exact === "cam-b"),
      false,
      "no device is pinned when the label is ambiguous",
    );
  });
});

test("camera: a higher pick appearing mid-call switches the live camera (dock a display)", async () => {
  await withLocalStorage(async (store) => {
    let displayConnected = false;
    const seen = [];
    const base = makeFakeMedia();
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...base,
          getUserMedia: async (c) => {
            if (c.video) seen.push(c.video.deviceId?.exact ?? null);
            return base.getUserMedia(c);
          },
          enumerateDevices: async () => [
            { kind: "videoinput", deviceId: "builtin", groupId: "gb", label: "FaceTime HD" },
            ...(displayConnected
              ? [{ kind: "videoinput", deviceId: "display", groupId: "gd", label: "Studio Display" }]
              : []),
          ],
        },
      },
    });
    await joinRoom(h);
    // The display camera is the most recent pick, but it isn't plugged in yet.
    await h.controller.switchCamera("display");
    await h.controller.switchCamera("builtin");
    await h.controller.switchCamera("display");
    assert.deepEqual(stackIds(store, "babbla:cameraStack"), ["display", "builtin"]);
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
    await new Promise((r) => setTimeout(r, 0));
    seen.length = 0;

    // Dock the laptop: the display camera appears and outranks what's live.
    displayConnected = true;
    await h.controller.refreshDevices();
    assert.ok(seen.includes("display"), "the top pick is captured once it appears");
    assert.deepEqual(stackIds(store, "babbla:cameraStack"), ["display", "builtin"], "read-only");

    // Idempotent: a second device event with nothing changed must not recapture.
    seen.length = 0;
    await h.controller.refreshDevices();
    assert.deepEqual(seen, [], "desired === active -> no-op");
  });
});

test("camera: auto-select never starts capture when video is off", async () => {
  await withLocalStorage(async () => {
    let displayConnected = false;
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...makeFakeMedia(),
          enumerateDevices: async () => [
            { kind: "videoinput", deviceId: "builtin", groupId: "gb", label: "FaceTime HD" },
            ...(displayConnected
              ? [{ kind: "videoinput", deviceId: "display", groupId: "gd", label: "Studio Display" }]
              : []),
          ],
        },
      },
    });
    await joinRoom(h);
    await h.controller.switchCamera("display");
    displayConnected = true;
    await h.controller.refreshDevices();
    assert.equal(
      callsTo(h.captured.meshCalls, "setLocalCameraStream").length,
      0,
      "a camera appearing must not light the LED on its own",
    );
  });
});

test("mic: a listed-but-unopenable pick is skipped, and retried after a replug", async () => {
  await withLocalStorage(async () => {
    let busy = true;
    let present = true;
    const attempts = [];
    const base = makeFakeMedia();
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...base,
          getUserMedia: async (c) => {
            const exact = c.audio?.deviceId?.exact;
            if (c.audio) attempts.push(exact ?? null);
            if (exact === "usb" && busy) throw new Error("NotReadableError");
            return base.getUserMedia(c);
          },
          enumerateDevices: async () => [
            ...(present
              ? [{ kind: "audioinput", deviceId: "usb", groupId: "gu", label: "USB Mic" }]
              : []),
            { kind: "audioinput", deviceId: "builtin", groupId: "gb", label: "Built-in" },
          ],
        },
      },
    });
    await joinRoom(h);
    await h.controller.switchMicrophone("builtin");
    await h.controller.switchMicrophone("usb");
    attempts.length = 0;

    // Listed but held by another app: fall through to the next entry, and stop
    // hammering it on every subsequent device event.
    await h.controller.refreshDevices();
    assert.equal(attempts.filter((a) => a === "usb").length, 0, "not retried while unusable");

    // Unplug and replug: "busy" was a fact about a moment, not a preference.
    busy = false;
    present = false;
    await h.controller.refreshDevices();
    present = true;
    attempts.length = 0;
    await h.controller.refreshDevices();
    assert.ok(attempts.includes("usb"), "the pick is retried after it re-appears");
  });
});

test("mic: Systemstandard releases the old track BEFORE re-acquiring on OS drift", async () => {
  await withLocalStorage(async () => {
    const events = [];
    let osDefaultGroup = "gb";
    const track = (groupId) => ({
      enabled: true,
      contentHint: "",
      getSettings: () => ({ deviceId: "default", groupId }),
      applyConstraints: async () => {},
      addEventListener() {},
      stop() {
        events.push("stop");
      },
    });
    let nextGroup = "gb";
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...makeFakeMedia(),
          getUserMedia: async (c) => {
            if (!c.audio) throw new Error("video not used here");
            events.push("capture");
            const t = track(nextGroup);
            return {
              getAudioTracks: () => [t],
              getVideoTracks: () => [],
              getTracks: () => [t],
            };
          },
          enumerateDevices: async () => [
            { kind: "audioinput", deviceId: "default", groupId: osDefaultGroup, label: "Default" },
            { kind: "audioinput", deviceId: "builtin", groupId: "gb", label: "Built-in" },
            { kind: "audioinput", deviceId: "airpods", groupId: "ga", label: "AirPods" },
          ],
        },
      },
    });
    await joinRoom(h);
    await h.controller.switchMicrophone("default");
    events.length = 0;

    // The user switches the OS input to AirPods. No device was added or removed,
    // so only the `default` entry's group moves.
    osDefaultGroup = "ga";
    nextGroup = "ga";
    await h.controller.refreshDevices();
    // Chrome only re-resolves the "default" mapping once the old track is
    // released, so asking for it again first would hand back the stale device.
    assert.deepEqual(events, ["stop", "capture"], "release, then re-acquire");

    // Settled: no further churn while the OS default and the live track agree.
    events.length = 0;
    await h.controller.refreshDevices();
    assert.deepEqual(events, [], "no repeat recapture once they agree");
  });
});

test("mic: unplugged track recaptures without persisting the fallback", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:micId", "studio-mic");
    const tracks = [];
    const baseMedia = makeFakeMedia();
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...baseMedia,
          missingDeviceIds: new Set(["studio-mic"]),
          getUserMedia: async (c) => {
            const s = await baseMedia.getUserMedia(c);
            if (c.audio) tracks.push(s.getAudioTracks()[0]);
            return s;
          },
          enumerateDevices: async () => [
            { kind: "audioinput", deviceId: "mic1", label: "Built-in Mic" },
          ],
        },
      },
    });
    await joinRoom(h);
    assert.ok(tracks[0], "joined with a live mic");
    tracks[0]._emit("ended");
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(tracks.length >= 2, "recaptured after device loss");
    assert.equal(store.get("babbla:micId"), "studio-mic", "fallback is not saved");
  });
});

test("speaker: a vanished pick stays on the stack and routing falls back to Systemstandard", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:speakerId", "spk-studio");
    store.set(
      "babbla:speakerId:meta",
      JSON.stringify({ groupId: "display", label: "Studio Display" }),
    );
    const h = makeHarness();
    h.media.enumerateDevices = async () => [
      { kind: "audiooutput", deviceId: "spk1", label: "MacBook Pro Speakers" },
    ];
    await joinRoom(h);
    assert.deepEqual(stackIds(store, "babbla:speakerStack"), ["spk-studio"]);
    assert.deepEqual(lastCall(h.log, "setAudioOutput"), ["setAudioOutput", ""]);
  });
});

test("speaker: a returned output is rematched by label and re-routed", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:speakerId", "spk-old");
    store.set(
      "babbla:speakerId:meta",
      JSON.stringify({ groupId: "display", label: "Studio Display" }),
    );
    const h = makeHarness();
    h.media.enumerateDevices = async () => [
      { kind: "audiooutput", deviceId: "spk-new", groupId: "display", label: "Studio Display" },
      { kind: "audiooutput", deviceId: "spk1", groupId: "mbp", label: "MacBook Pro Speakers" },
    ];
    await joinRoom(h);
    assert.deepEqual(stackIds(store, "babbla:speakerStack"), ["spk-old"], "stack not rewritten");
    assert.deepEqual(lastCall(h.log, "setAudioOutput"), ["setAudioOutput", "spk-new"]);
  });
});

// A stream whose track records stop(), so a test can tell "the capture was
// released" from "the capture is still holding the device open".
function makeMicStream(deviceId = "mic1") {
  const track = {
    enabled: true,
    contentHint: "",
    _stopped: false,
    getSettings: () => ({ deviceId }),
    applyConstraints: async () => {},
    addEventListener() {},
    stop() {
      this._stopped = true;
    },
  };
  return {
    track,
    stream: {
      getAudioTracks: () => [track],
      getVideoTracks: () => [],
      getTracks: () => [track],
    },
  };
}

// The device refresh at the end of join enumerates and can recapture, which
// makes it the last suspension point before the room opens. A Back landing
// there used to connect the room and keep the mic open behind the landing page.
test("async-gap guard: a join cancelled during the device refresh bails + releases the mic", async () => {
  const h = makeHarness();
  const { track, stream } = makeMicStream();
  h.media.getUserMedia = async () => stream;
  let reachedEnumerate;
  const atEnumerate = new Promise((res) => { reachedEnumerate = res; });
  let releaseEnumerate;
  h.media.enumerateDevices = () => {
    reachedEnumerate();
    return new Promise((res) => { releaseEnumerate = () => res([]); });
  };

  const joinPromise = h.controller.join("Me", { room: "alpha" });
  await atEnumerate;
  h.controller.cancelPendingJoin();
  releaseEnumerate();

  assert.equal(await joinPromise, false, "the cancelled join resolves to false");
  assert.equal(h.captured.signaling, undefined, "never connected");
  assert.ok(track._stopped, "the mic was released, not left open behind the landing page");
  assert.ok(callsTo(h.captured.pipelineCalls, "close").length >= 1, "the pipeline was closed too");
});

// Cleaning up after an abandoned join must not reach past what that join owns:
// what superseded it may be a newer join that has already opened its own mic.
test("async-gap guard: an abandoned join does not release a newer join's mic", async () => {
  const h = makeHarness();
  const first = makeMicStream("mic1");
  const second = makeMicStream("mic2");
  let captures = 0;
  h.media.getUserMedia = async () => (++captures === 1 ? first.stream : second.stream);
  let enumerations = 0;
  let reachedFirstEnumerate;
  const atFirstEnumerate = new Promise((res) => { reachedFirstEnumerate = res; });
  let releaseFirstEnumerate;
  h.media.enumerateDevices = () => {
    if (++enumerations > 1) return Promise.resolve([]);
    reachedFirstEnumerate();
    return new Promise((res) => { releaseFirstEnumerate = () => res([]); });
  };

  const abandoned = h.controller.join("Me", { room: "alpha" });
  await atFirstEnumerate;
  // A second join supersedes the first and gets all the way into the room.
  assert.equal(await h.controller.join("Me", { room: "alpha" }), true);
  releaseFirstEnumerate();

  assert.equal(await abandoned, false, "the superseded join bails");
  assert.ok(first.track._stopped, "it released the mic it captured");
  assert.ok(!second.track._stopped, "but not the mic the newer join is using");
  assert.equal(
    callsTo(h.captured.pipelineCalls, "close").length,
    0,
    "nor the pipeline the newer join is feeding",
  );
});

// Automatic reconciliation captures without the user asking, so its result can
// land after the user has deliberately silenced themselves. Adopting it then
// re-opens the device: the OS mic indicator lights with nothing on screen that
// explains why.
for (const { name, silence, describe } of [
  {
    name: "DND",
    silence: (h) => h.controller.toggleDnd(),
    describe: "re-open the mic the user just released",
  },
  {
    name: "leaving",
    silence: (h) => h.controller.leaveToLanding(),
    describe: "leave a live mic behind the landing page",
  },
]) {
  test(`mic: a reconcile capture completing after ${name} is released, not adopted`, async () => {
    await withLocalStorage(async (store) => {
      store.set("babbla:micId", "usb");
      let usbPresent = false;
      let holdUsb = false;
      const late = makeMicStream("usb");
      let releaseCapture;
      const base = makeFakeMedia();
      const h = makeHarness({
        controllerDeps: {
          media: {
            ...base,
            getUserMedia: async (c) => {
              const exact = c.audio?.deviceId?.exact;
              if (exact === "usb") {
                if (holdUsb) {
                  return new Promise((res) => { releaseCapture = () => res(late.stream); });
                }
                if (!usbPresent) throw new Error("OverconstrainedError");
              }
              return base.getUserMedia(c);
            },
            enumerateDevices: async () => [
              { kind: "audioinput", deviceId: "builtin", groupId: "gb", label: "Built-in" },
              ...(usbPresent
                ? [{ kind: "audioinput", deviceId: "usb", groupId: "gu", label: "USB Mic" }]
                : []),
            ],
          },
        },
      });
      // Join on the built-in: the pick is not plugged in yet.
      await joinRoom(h);

      // The pick reappears, so the reconcile starts capturing it...
      usbPresent = true;
      holdUsb = true;
      const reconciled = h.controller.refreshDevices();
      await flush();
      reset(h);
      // ...and the user goes quiet before that capture lands.
      silence(h);
      releaseCapture();
      await reconciled;

      assert.ok(late.track._stopped, `the late capture would ${describe}`);
      assert.equal(
        callsTo(h.captured.meshCalls, "setLocalAudioStream").length,
        0,
        "the superseded capture was not adopted",
      );
    });
  });
}

// An abandoned capture is not a verdict on the hardware: marking it unusable
// would drop the pick out of the walk for the rest of the session.
test("mic: a capture abandoned mid-flight leaves the pick usable", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:micId", "usb");
    const attempts = [];
    let usbPresent = false;
    let holdUsb = false;
    let releaseCapture;
    const late = makeMicStream("usb");
    const base = makeFakeMedia();
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...base,
          getUserMedia: async (c) => {
            const exact = c.audio?.deviceId?.exact;
            if (c.audio) attempts.push(exact ?? null);
            if (exact === "usb") {
              if (holdUsb) {
                return new Promise((res) => { releaseCapture = () => res(late.stream); });
              }
              if (!usbPresent) throw new Error("OverconstrainedError");
            }
            return base.getUserMedia(c);
          },
          enumerateDevices: async () => [
            { kind: "audioinput", deviceId: "builtin", groupId: "gb", label: "Built-in" },
            ...(usbPresent
              ? [{ kind: "audioinput", deviceId: "usb", groupId: "gu", label: "USB Mic" }]
              : []),
          ],
        },
      },
    });
    await joinRoom(h);
    usbPresent = true;
    holdUsb = true;
    const reconciled = h.controller.refreshDevices();
    await flush();
    h.controller.toggleDnd();
    releaseCapture();
    await reconciled;

    // Back from DND with the device free: the pick must still be reachable.
    holdUsb = false;
    attempts.length = 0;
    h.controller.toggleDnd();
    await flush();
    assert.ok(attempts.includes("usb"), "the pick is still walked after the abandoned capture");
  });
});

// The camera counterpart of the mic abort guard. Reconciliation captures without
// being asked, so its result can land after the user has turned video off — and
// if that counted as the device refusing, the walk would mark every remaining
// pick unusable on its way out and the next enable would fall back to an
// unconstrained capture with the top pick sitting right there.
test("camera: a capture abandoned by turning video off leaves the picks usable", async () => {
  await withLocalStorage(async () => {
    const attempts = [];
    let displayPresent = false;
    let holdDisplay = false;
    let releaseCapture;
    const base = makeFakeMedia();
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...base,
          getUserMedia: async (c) => {
            const exact = c.video?.deviceId?.exact;
            if (c.video) attempts.push(exact ?? null);
            if (exact === "display-cam") {
              if (holdDisplay) {
                return new Promise((res) => {
                  releaseCapture = () => res(base.getUserMedia(c));
                });
              }
              if (!displayPresent) throw new Error("OverconstrainedError");
            }
            return base.getUserMedia(c);
          },
          enumerateDevices: async () => [
            { kind: "videoinput", deviceId: "builtin-cam", groupId: "gb", label: "FaceTime HD" },
            ...(displayPresent
              ? [{ kind: "videoinput", deviceId: "display-cam", groupId: "gd", label: "Studio Display" }]
              : []),
          ],
        },
      },
    });
    await joinRoom(h);
    // Two picks, display on top, but it is away — so video comes up on built-in.
    displayPresent = true;
    await h.controller.refreshDevices();
    await h.controller.switchCamera("builtin-cam");
    await h.controller.switchCamera("display-cam");
    displayPresent = false;
    await h.controller.refreshDevices();
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
    await flush();

    // The display returns; the reconcile starts capturing it. Turn video off
    // while that capture is in flight.
    displayPresent = true;
    holdDisplay = true;
    const reconciled = h.controller.refreshDevices();
    await flush();
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: false });
    await flush();
    releaseCapture();
    await reconciled;

    // Turn video back on. The top pick is present and openable, so it must come
    // up — not an unconstrained fallback.
    holdDisplay = false;
    attempts.length = 0;
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
    await flush();
    assert.ok(
      attempts.includes("display-cam"),
      `the abandoned capture must not bury the pick (attempts: ${JSON.stringify(attempts)})`,
    );
    assert.equal(
      attempts.includes(null),
      false,
      "and it must not settle for an unconstrained capture",
    );
  });
});

// Unplug recovery hands its stream straight to the mesh, so it walks the stack
// like startLocalCamera rather than dropping to an unconstrained capture the
// moment the top pick fails.
test("camera: unplug recovery walks the stack instead of falling straight back", async () => {
  await withLocalStorage(async () => {
    const attempts = [];
    let displayPresent = true;
    let lastStream = null;
    const base = makeFakeMedia();
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...base,
          getUserMedia: async (c) => {
            const exact = c.video?.deviceId?.exact;
            if (c.video) attempts.push(exact ?? null);
            if (exact === "display-cam" && !displayPresent) {
              throw new Error("OverconstrainedError");
            }
            const s = await base.getUserMedia(c);
            if (c.video) lastStream = s;
            return s;
          },
          enumerateDevices: async () => [
            { kind: "videoinput", deviceId: "builtin-cam", groupId: "gb", label: "FaceTime HD" },
            ...(displayPresent
              ? [{ kind: "videoinput", deviceId: "display-cam", groupId: "gd", label: "Studio Display" }]
              : []),
          ],
        },
      },
    });
    await joinRoom(h);
    // built-in is the second pick, display the first.
    await h.controller.switchCamera("builtin-cam");
    await h.controller.switchCamera("display-cam");
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
    await flush();
    attempts.length = 0;

    // Unplug the display mid-stream: its track ends.
    displayPresent = false;
    lastStream.getVideoTracks()[0]._emit("ended");
    await flush();
    assert.ok(
      attempts.includes("builtin-cam"),
      `recovery pins the next pick (attempts: ${JSON.stringify(attempts)})`,
    );
    assert.equal(
      attempts.includes(null),
      false,
      "and does not settle for an unconstrained capture while a pick is available",
    );
  });
});

// A deviceId that churned (same hardware, new id) fails an exact pin. The pick
// must still be recoverable through the label tier, and the capture that goes
// on the wire must be the rematched device rather than an arbitrary fallback.
test("camera: a pick whose deviceId churned is captured via the rematch, not a fallback", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:cameraId", "cam-old");
    store.set(
      "babbla:cameraId:meta",
      JSON.stringify({ groupId: "gone", label: "Studio Display" }),
    );
    const seen = [];
    const base = makeFakeMedia();
    const h = makeHarness({
      controllerDeps: {
        media: {
          ...base,
          getUserMedia: async (c) => {
            if (c.video) {
              seen.push(c.video.deviceId?.exact ?? null);
              // The stale id is gone from the system, as a browser reports it.
              if (c.video.deviceId?.exact === "cam-old") throw new Error("OverconstrainedError");
            }
            return base.getUserMedia(c);
          },
          enumerateDevices: async () => [
            { kind: "videoinput", deviceId: "cam-new", groupId: "g2", label: "Studio Display" },
            { kind: "videoinput", deviceId: "builtin", groupId: "g1", label: "FaceTime HD" },
          ],
        },
      },
    });
    await joinRoom(h);
    h.controller.toggleCamera();
    await h.captured.signaling.deliver({ type: MSG.CAMERA, id: "self", on: true });
    await flush();

    assert.equal(
      lastCall(h.log, "populateDevices")[1].camId,
      "cam-new",
      "the rematched device is what ends up live",
    );
    assert.ok(!seen.includes(null), "no unconstrained fallback was needed");
    assert.deepEqual(stackIds(store, "babbla:cameraStack"), ["cam-old"], "resolution is read-only");
  });
});

// Two picks in quick succession (a menu double-tap, or a pick landing on top of
// a hotplug reconcile) both route across several audio elements inside the view.
// Unserialized, the slower one finishes last and wins the actual routing, so the
// conversation comes out of the device the user just moved away from.
test("speaker: overlapping picks route in order — the last pick wins", async () => {
  await withLocalStorage(async () => {
    const h = makeHarness();
    await joinRoom(h);
    const applied = [];
    const delays = { spk1: 20, spk2: 0 };
    h.ui.setAudioOutput = (id) =>
      new Promise((res) => {
        setTimeout(() => {
          applied.push(id);
          res(true);
        }, delays[id] ?? 0);
      });

    const first = h.controller.switchSpeaker("spk1");
    const second = h.controller.switchSpeaker("spk2");
    await Promise.all([first, second]);

    assert.equal(applied.at(-1), "spk2", "audio ends up on the device picked last");
    // The slower older request never wins the race: it is dropped while queued
    // (nothing to hear from a device the user has already moved off), or routed
    // before the newer one — never after it.
    assert.ok(
      !applied.includes("spk1") || applied.indexOf("spk1") < applied.indexOf("spk2"),
      "the superseded pick did not route last",
    );
  });
});

// --- Noise reduction ("Brusreducering") ------------------------------------

test("noise: the mesh + self-meter get the PROCESSED stream (not raw localStream)", async () => {
  const h = makeHarness();
  await joinRoom(h);
  const processed = h.captured.pipeline.getStream();
  const raw = h.captured.pipelineRawStream;
  assert.notEqual(processed, raw, "the fake pipeline yields a distinct processed stream");
  // The mesh sends the processed output — by identity, not just "some stream".
  assert.equal(h.captured.lastAudioStream, processed, "mesh got the processed stream");
  assert.notEqual(h.captured.lastAudioStream, raw, "mesh did NOT get the raw mic");
  // The self tile/meter taps the processed stream too (addSelfTile(id, name, stream)).
  assert.equal(lastCall(h.log, "addSelfTile")?.[1], "self");
  assert.equal(lastCall(h.log, "addSelfTile")?.[3], processed, "self-meter taps processed");
  // The pipeline was created (the always-on graph) and seeded with the mute state.
  assert.ok(h.captured.pipeline, "a mic pipeline was created at join");
  assert.ok(callsTo(h.captured.pipelineCalls, "setMuted").length >= 1);
});

test("noise: setNoiseReduction applies to the pipeline and persists", async () => {
  await withLocalStorage(async (store) => {
    const h = makeHarness();
    await joinRoom(h);
    reset(h);
    h.controller.setNoiseReduction("full");
    assert.deepEqual(
      lastCall(h.log, "syncActiveSelection"),
      ["syncActiveSelection", { noiseLevel: "full" }],
    );
    assert.deepEqual(lastCall(h.captured.pipelineCalls, "setConfig"), ["setConfig", "full"]);
    assert.equal(store.get("babbla:noiseReduction"), "full");
    assert.equal(h.controller.getNoiseLevel(), "full");
  });
});

test("noise: a remembered level is read back and seeds the pipeline at join", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:noiseReduction", "full");
    const h = makeHarness();
    await joinRoom(h);
    assert.equal(h.controller.getNoiseLevel(), "full");
    assert.equal(h.captured.pipelineOpts.level, "full", "pipeline created with the pref");
  });
});

test("noise: an invalid stored level falls back to the default (lite)", async () => {
  await withLocalStorage(async () => {
    const h = makeHarness();
    await joinRoom(h);
    h.controller.setNoiseReduction("bogus");
    assert.deepEqual(
      lastCall(h.log, "syncActiveSelection"),
      ["syncActiveSelection", { noiseLevel: "lite" }],
    );
    assert.equal(h.controller.getNoiseLevel(), "lite");
  });
});

test("noise: mute freezes the expander floor (setMuted true/false on the pipeline)", async () => {
  const h = makeHarness();
  await joinRoom(h);
  reset(h);
  h.controller.toggleMute();
  assert.deepEqual(lastCall(h.captured.pipelineCalls, "setMuted"), ["setMuted", true]);
  h.controller.toggleMute();
  assert.deepEqual(lastCall(h.captured.pipelineCalls, "setMuted"), ["setMuted", false]);
});

test("noise: switchMicrophone rebuilds the pipeline and re-attaches the processed stream", async () => {
  const h = makeHarness();
  await joinRoom(h);
  reset(h);
  await h.controller.switchMicrophone("mic2");
  assert.ok(callsTo(h.captured.pipelineCalls, "rebuild").length >= 1, "pipeline rebuilt");
  assert.ok(
    callsTo(h.captured.meshCalls, "setLocalAudioStream").some((c) => c[1] === true),
    "processed stream re-attached to the mesh",
  );
});

// --- SPA: dynamic room, leave-to-landing, async-gap guard ------------------

test("join({ room }) builds the signaling URL for that room", async () => {
  const seen = [];
  const h = makeHarness({
    controllerDeps: {
      signalingUrl: undefined,
      signalingUrlFor: (room) => {
        seen.push(room);
        return `ws://test/ws?room=${room}`;
      },
    },
  });
  await h.controller.join("Me", { room: "festen" });
  assert.equal(h.captured.signalingOpts.url, "ws://test/ws?room=festen");
  assert.deepEqual(seen, ["festen"]);
});

test("async-gap guard: a join superseded during the mic prompt bails + stops the stream", async () => {
  const h = makeHarness();
  // Defer getUserMedia so we can navigate away mid-prompt. Track stop() calls.
  let resolveMic;
  const stopped = [];
  const micTrack = {
    enabled: true,
    contentHint: "",
    getSettings: () => ({ deviceId: "mic1" }),
    applyConstraints: async () => {},
    addEventListener() {},
    stop() { stopped.push("audio"); },
  };
  const micStream = {
    getAudioTracks: () => [micTrack],
    getVideoTracks: () => [],
    getTracks: () => [micTrack],
  };
  h.media.getUserMedia = () => new Promise((res) => { resolveMic = res; });

  const joinPromise = h.controller.join("Me", { room: "alpha" });
  // User presses Back / leaves while the prompt is still open.
  h.controller.leaveToLanding();
  // Now the mic resolves — too late.
  resolveMic(micStream);
  const ok = await joinPromise;

  assert.equal(ok, false, "the superseded join resolves to false");
  assert.equal(h.captured.signaling, undefined, "never connected");
  assert.deepEqual(stopped, ["audio"], "the captured mic stream was stopped (released)");
});

test("async-gap guard: cancelPendingJoin (popstate before in-room) bails + stops the stream", async () => {
  const h = makeHarness();
  let resolveMic;
  const stopped = [];
  const micTrack = {
    enabled: true,
    contentHint: "",
    getSettings: () => ({ deviceId: "mic1" }),
    applyConstraints: async () => {},
    addEventListener() {},
    stop() { stopped.push("audio"); },
  };
  const micStream = {
    getAudioTracks: () => [micTrack],
    getVideoTracks: () => [],
    getTracks: () => [micTrack],
  };
  h.media.getUserMedia = () => new Promise((res) => { resolveMic = res; });

  const joinPromise = h.controller.join("Me", { room: "alpha" });
  // Browser Back during the prompt, before the room came up: the composition
  // root calls cancelPendingJoin (not leaveToLanding, since inRoom is false).
  h.controller.cancelPendingJoin();
  resolveMic(micStream);
  const ok = await joinPromise;

  assert.equal(ok, false, "the cancelled join resolves to false");
  assert.equal(h.captured.signaling, undefined, "never connected");
  assert.deepEqual(stopped, ["audio"], "the captured mic stream was stopped (released)");
});

test("leaveToLanding tears down, releases the mic, and resets mute UI", async () => {
  const h = makeHarness();
  await joinRoom(h);
  // Mute in room A.
  h.controller.toggleMute();
  assert.deepEqual(lastCall(h.log, "setMuteUi"), ["setMuteUi", true]);
  reset(h);

  h.controller.leaveToLanding();
  // Intentional leave is announced + socket closed.
  assert.ok(callsTo(h.captured.sends, "leave").length >= 1, "sent leave");
  assert.ok(callsTo(h.captured.sends, "close").length >= 1, "closed socket");
  // Mute UI reset to unmuted (parity with the old reload).
  assert.deepEqual(lastCall(h.log, "setMuteUi"), ["setMuteUi", false]);
  // Mic pipeline closed (mic released).
  assert.ok(callsTo(h.captured.pipelineCalls, "close").length >= 1, "pipeline closed");
});

test("fresh session: mute does not carry from room A into room B", async () => {
  const h = makeHarness();
  await joinRoom(h, { id: "selfA" });
  h.controller.toggleMute(); // muted in A
  h.controller.leaveToLanding();
  reset(h);

  // Join room B: a fresh mic track starts enabled, and the mute UI is unmuted.
  await joinRoom(h, { id: "selfB" });
  // The self tile is (re)built; the mic track handed to it is enabled.
  const selfTileCall = lastCall(h.log, "addSelfTile");
  assert.equal(selfTileCall?.[1], "selfB");
  // No setMuteUi(true) happened during/after the room B join.
  assert.ok(
    !callsTo(h.log, "setMuteUi").some((c) => c[1] === true),
    "room B did not start muted",
  );
});

test("video-opt-out persists across a leave + rejoin (localStorage preference)", async () => {
  await withLocalStorage(async (store) => {
    const h = makeHarness();
    await joinRoom(h);
    // Opt out of video in room A → persisted.
    h.controller.toggleVideoOptOut();
    assert.equal(store.get("babbla:videoOptOut"), "1");
    h.controller.leaveToLanding();
    reset(h);

    // Re-join: the preference is re-applied (announced to the server after welcome).
    await joinRoom(h);
    assert.ok(
      callsTo(h.captured.sends, "videoOptOut").some((c) => c[1] === true),
      "opt-out re-announced on rejoin",
    );
    assert.ok(
      callsTo(h.log, "setVideoOptOutUi").some((c) => c[1] === true),
      "opt-out UI re-applied on rejoin",
    );
  });
});

test("video-opt-out preference is read at construction and applied on join", async () => {
  await withLocalStorage(async (store) => {
    store.set("babbla:videoOptOut", "1");
    const h = makeHarness();
    await joinRoom(h);
    assert.ok(
      callsTo(h.captured.sends, "videoOptOut").some((c) => c[1] === true),
      "persisted opt-out announced on the first join",
    );
  });
});

// --- Relay / ICE health wiring ---------------------------------------------
// The facts that make "a peer is stuck on ansluter" diagnosable. See the
// initial-connect watchdog in mesh.js for why they exist at all.

test("welcome: the view is told whether a TURN relay is available", async () => {
  const h = makeHarness();
  await joinRoom(h);
  assert.deepEqual(lastCall(h.log, "setRelayAvailable"), ["setRelayAvailable", false]);

  // With TURN configured (server contributed ice servers) it flips to true.
  const h2 = makeHarness();
  h2.captured.turnConfigured = true;
  await joinRoom(h2);
  assert.deepEqual(lastCall(h2.log, "setRelayAvailable"), ["setRelayAvailable", true]);
});

test("an ICE-server error reaches both the view and the server's usage log", async () => {
  const h = makeHarness();
  await joinRoom(h);
  reset(h);

  const error = {
    url: "turn:relay.example:3478?transport=udp",
    errorCode: 401,
    errorText: "Unauthorized.",
    relay: true,
    hint: "TURN-servern avvisade våra uppgifter (401) …",
  };
  h.captured.meshOpts.onIceServerError("peer-1", error);

  assert.deepEqual(lastCall(h.log, "setIceServerError"), ["setIceServerError", "peer-1", error]);
  assert.deepEqual(lastCall(h.captured.sends, "iceError"), ["iceError", error]);
});
