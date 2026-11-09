// Live Cloudflare-only media smoke test. Does not change the target configuration.
// Usage: node scripts/relay-cloudflare-check.mjs <https://babbla.example.com>
// CHROME_BIN overrides the platform Chrome path. Headless + synthetic mic only.
// Runs each transport separately; native fallback MUST NOT make this test green.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

export const TRANSPORTS = [
  { name: "UDP 3478", url: "turn:turn.cloudflare.com:3478?transport=udp", relayProtocol: "udp" },
  { name: "TLS 443", url: "turns:turn.cloudflare.com:443?transport=tcp", relayProtocol: "tls" },
];

// Serialized into each document before the application loads. Filtering applies
// to refreshes too: setConfiguration() must never re-enable the native fallback.
export function installCloudflareOnlyHook(allowedUrl) {
  const NativePC = window.RTCPeerConnection;
  const filter = (config = {}) => ({
    ...config,
    iceTransportPolicy: "relay",
    iceServers: (config.iceServers || []).flatMap((entry) => {
      const urls = [].concat(entry.urls || []).filter((url) => url === allowedUrl);
      return urls.length ? [{ ...entry, urls }] : [];
    }),
  });
  window.__cloudflareCheckPCs = [];
  window.RTCPeerConnection = class extends NativePC {
    constructor(config, ...rest) {
      super(filter(config), ...rest);
      window.__cloudflareCheckPCs.push(this);
    }
    setConfiguration(config) {
      return super.setConfiguration(filter({
        ...config,
        iceServers: config?.iceServers ?? this.getConfiguration().iceServers,
      }));
    }
  };
}

async function sample(page) {
  return page.evaluate(async () => {
    const results = [];
    for (const [index, pc] of window.__cloudflareCheckPCs.entries()) {
      // Ignore the application's public-IP probe and old closed connections.
      if (pc.connectionState !== "connected" ||
          !pc.getSenders().some((s) => s.track?.kind === "audio")) continue;
      const stats = await pc.getStats();
      let selected;
      for (const row of stats.values()) {
        if (row.type === "transport" && row.selectedCandidatePairId) {
          selected = stats.get(row.selectedCandidatePairId);
          break;
        }
      }
      if (!selected) continue;
      const local = stats.get(selected.localCandidateId);
      const remote = stats.get(selected.remoteCandidateId);
      let audioIn = 0;
      let audioOut = 0;
      for (const row of stats.values()) {
        if (row.type === "inbound-rtp" && row.kind === "audio") audioIn += row.packetsReceived || 0;
        if (row.type === "outbound-rtp" && row.kind === "audio") audioOut += row.packetsSent || 0;
      }
      results.push({
        index, pairId: selected.id, localType: local?.candidateType,
        remoteType: remote?.candidateType, url: local?.url,
        relayProtocol: local?.relayProtocol,
        bytesSent: selected.bytesSent || 0, bytesReceived: selected.bytesReceived || 0,
        audioIn, audioOut,
      });
    }
    return results;
  });
}

export function verifySamples(before, after, transport) {
  assert.equal(before.length, 1, "expected exactly one connected audio peer");
  assert.equal(after.length, 1, "expected exactly one connected audio peer");
  const a = before[0];
  const b = after[0];
  for (const row of [a, b]) {
    assert.equal(row.localType, "relay", "selected local candidate is not relay");
    assert.equal(row.remoteType, "relay", "selected remote candidate is not relay");
    assert.equal(row.url, transport.url, "selected candidate did not come from the requested Cloudflare URL");
    assert.equal(row.relayProtocol, transport.relayProtocol, "wrong client-to-TURN transport");
  }
  assert.equal(a.index, b.index, "peer connection changed while sampling");
  assert.equal(a.pairId, b.pairId, "selected pair changed while sampling; repeat the check");
  const deltas = Object.fromEntries(["audioIn", "audioOut", "bytesSent", "bytesReceived"]
    .map((key) => [key, b[key] - a[key]]));
  for (const [key, delta] of Object.entries(deltas)) {
    assert.ok(delta > 0, `${key} did not increase over the selected Cloudflare relay`);
  }
  return deltas;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTransport(target, transport) {
  const browsers = [];
  const room = `cf-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const clients = [];
    for (const name of ["CloudflareCheckA", "CloudflareCheckB"]) {
      const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_BIN || (process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : "/usr/bin/google-chrome-stable"),
        headless: true,
        args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
          "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
      });
      browsers.push(browser); // register before any page operations can fail
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(installCloudflareOnlyHook, transport.url);
      await page.goto(`${target}/room/${room}`, { waitUntil: "networkidle2", timeout: 45_000 });
      await page.type("#name-input", name);
      await page.click("#join-form button");
      await page.waitForSelector("#room-view:not([hidden])", { timeout: 20_000 });
      clients.push(page);
    }
    const deadline = Date.now() + 45_000;
    let first;
    do {
      first = await Promise.all(clients.map(sample));
      if (first.every((rows) => rows.length === 1 && rows[0].audioIn > 0 && rows[0].audioOut > 0)) break;
      await sleep(500);
    } while (Date.now() < deadline);
    await sleep(4_000);
    const second = await Promise.all(clients.map(sample));
    for (let i = 0; i < clients.length; i++) {
      const deltas = verifySamples(first[i], second[i], transport);
      // Only public server URL, transport and counters; never log ICE credentials.
      console.log(`PASS ${transport.name} client ${i + 1}: ${transport.url} ` +
        `relayProtocol=${second[i][0].relayProtocol} ${JSON.stringify(deltas)}`);
    }
  } finally {
    await Promise.allSettled(browsers.map((browser) => browser.close()));
  }
}

async function main() {
  if (!process.argv[2]) {
    console.error("Usage: node scripts/relay-cloudflare-check.mjs <https://installation.example.com>");
    return 2;
  }
  const url = new URL(process.argv[2]);
  assert.ok(!url.username && !url.password, "target URL must not contain credentials");
  assert.ok(url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)),
  "target must use HTTPS (except localhost)");
  let failures = 0;
  for (const transport of TRANSPORTS) {
    console.log(`Checking ${transport.name} against ${url.origin}`);
    try {
      await runTransport(url.origin, transport);
    } catch (error) {
      failures++;
      console.error(`FAIL ${transport.name}: ${error.message}`);
    }
  }
  return failures ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // All browsers have closed in finally before exit. Puppeteer can otherwise
  // leave protocol timeout handles keeping this completed CLI alive on macOS.
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`Cloudflare relay check failed: ${error.message}`);
    process.exit(1);
  });
}
