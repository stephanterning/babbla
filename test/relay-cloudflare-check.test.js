import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installCloudflareOnlyHook, TRANSPORTS, verifySamples } from "../scripts/relay-cloudflare-check.mjs";

test("relay probe excludes native TURN and alternate transports, including refreshed configuration", () => {
  class PC {
    constructor(config) { this.config = config; }
    setConfiguration(config) { this.config = config; }
    getConfiguration() { return this.config; }
  }
  const context = vm.createContext({ window: { RTCPeerConnection: PC } });
  const url = TRANSPORTS[0].url;
  vm.runInContext(`(${installCloudflareOnlyHook})(${JSON.stringify(url)})`, context);
  const entries = [
    { urls: "turn:babbla.example.com:3478", username: "native", credential: "native-secret" },
    { urls: TRANSPORTS.map((t) => t.url), username: "cf", credential: "cf-secret" },
  ];
  const pc = new context.window.RTCPeerConnection({ iceServers: entries });
  assert.equal(pc.config.iceTransportPolicy, "relay");
  assert.equal(pc.config.iceServers.length, 1);
  assert.deepEqual(Array.from(pc.config.iceServers[0].urls), [url]);
  assert.equal(pc.config.iceServers[0].credential, "cf-secret");
  pc.setConfiguration({ iceTransportPolicy: "all", iceServers: entries });
  assert.equal(pc.config.iceTransportPolicy, "relay");
  assert.equal(pc.config.iceServers.length, 1);
  pc.setConfiguration({ iceServers: [entries[0]] });
  assert.equal(pc.config.iceServers.length, 0, "native fallback cannot pass CF-only proof");
});

const before = {
  index: 1, pairId: "pair", localType: "relay", remoteType: "relay",
  url: TRANSPORTS[0].url, relayProtocol: "udp", audioIn: 10, audioOut: 20,
  bytesSent: 1000, bytesReceived: 2000,
};
const after = { ...before, audioIn: 20, audioOut: 40, bytesSent: 2000, bytesReceived: 4000 };

test("relay proof requires selected CF URL, correct transport and bidirectional media", () => {
  assert.deepEqual(verifySamples([before], [after], TRANSPORTS[0]), {
    audioIn: 10, audioOut: 20, bytesSent: 1000, bytesReceived: 2000,
  });
  for (const patch of [
    { url: "turn:babbla.example.com:3478" }, { relayProtocol: "tcp" },
    { localType: "srflx" }, { remoteType: "host" }, { pairId: "other" },
    { audioIn: 10 }, { audioOut: 20 }, { bytesSent: 1000 }, { bytesReceived: 2000 },
  ]) assert.throws(() => verifySamples([before], [{ ...after, ...patch }], TRANSPORTS[0]));
  assert.throws(() => verifySamples([], [], TRANSPORTS[0]));
});
