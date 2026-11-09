// Verify that a *live* babbla deployment's TURN relay actually carries media.
//
// This is step 2 of docs/relay-troubleshooting.md, automated. It deliberately
// checks both planes, because either one alone lies:
//
//   Control plane — STUN Binding + an authenticated TURN Allocate. Proves the
//     server answers, the shared secret matches and `external-ip` is public.
//   Data plane   — two real browsers pinned to `iceTransportPolicy: "relay"`
//     against the deployment. Proves the relay port range is reachable and
//     forwards payload. A server can hand out a perfectly public relay
//     candidate while its relay ports are firewalled off, which is exactly the
//     failure that leaves peers stuck on "ansluter" (an earlier Allocate-only
//     `turn-check` tool was removed for calling that case healthy).
//
// Usage:
//   node scripts/relay-live-check.mjs <https://babbla.example.com>
//
// Env:
//   RELAY_CHECK_SHOTS=/dir   write screenshots of the diagnostics UI
//   RELAY_CHECK_SKIP_BROWSER=1  control plane only (no Chrome needed)
import crypto from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import { WebSocket } from "ws";
import puppeteer from "puppeteer-core";

if (!process.argv[2]) {
  console.error("Usage: node scripts/relay-live-check.mjs <https://installation.example.com>");
  process.exit(2);
}
const target = process.argv[2].replace(/\/+$/, "");
const origin = new URL(target);
const wsUrl = `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}/ws`;
const room = `relaycheck-${Math.random().toString(36).slice(2, 8)}`;
const SHOT_DIR = process.env.RELAY_CHECK_SHOTS || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS ${label}`);
  } else {
    fail++;
    console.log(`FAIL ${label}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  }
}

// --- STUN/TURN wire format --------------------------------------------------

const MAGIC = 0x2112a442;
const METHOD = {
  BINDING: 0x0001,
  ALLOCATE: 0x0003,
  SEND: 0x0006,
  DATA: 0x0007,
  CREATE_PERMISSION: 0x0008,
};
const CLASS = { REQUEST: 0x00, INDICATION: 0x01, SUCCESS: 0x02 };

const msgType = (m, c) =>
  ((m & 0x0f80) << 2) | ((m & 0x0070) << 1) | (m & 0x000f) | ((c & 0x02) << 7) | ((c & 0x01) << 4);

function attr(type, value) {
  const pad = (4 - (value.length % 4)) % 4;
  const buf = Buffer.alloc(4 + value.length + pad);
  buf.writeUInt16BE(type, 0);
  buf.writeUInt16BE(value.length, 2);
  value.copy(buf, 4);
  return buf;
}

function build({ method, cls, txid, attrs = [], key = null }) {
  let body = Buffer.concat(attrs);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(msgType(method, cls), 0);
  header.writeUInt32BE(MAGIC, 4);
  txid.copy(header, 8);
  if (key) {
    header.writeUInt16BE(body.length + 24, 2);
    const hmac = crypto.createHmac("sha1", key).update(Buffer.concat([header, body])).digest();
    body = Buffer.concat([body, attr(0x0008, hmac)]);
  }
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function parse(buf) {
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  const attrs = {};
  let off = 20;
  while (off + 4 <= 20 + len) {
    const t = buf.readUInt16BE(off);
    const l = buf.readUInt16BE(off + 2);
    attrs[t] = buf.subarray(off + 4, off + 4 + l);
    off += 4 + l + ((4 - (l % 4)) % 4);
  }
  return {
    cls: ((type & 0x0100) >> 7) | ((type & 0x0010) >> 4),
    attrs,
  };
}

function xorAddrAttr(type, ip, port) {
  const v = Buffer.alloc(8);
  v.writeUInt8(0, 0);
  v.writeUInt8(1, 1);
  v.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  ip.split(".").forEach((o, i) =>
    v.writeUInt8(Number(o) ^ ((MAGIC >>> (24 - 8 * i)) & 0xff), 4 + i),
  );
  return attr(type, v);
}

function xorAddress(v) {
  if (!v || v.length < 8 || v.readUInt8(1) !== 0x01) return null;
  const port = v.readUInt16BE(2) ^ (MAGIC >>> 16);
  const ip = [];
  for (let i = 0; i < 4; i++) ip.push(v.readUInt8(4 + i) ^ ((MAGIC >>> (24 - 8 * i)) & 0xff));
  return `${ip.join(".")}:${port}`;
}

function splitAddress(text) {
  const [ip, port] = String(text).split(":");
  return { ip, port: Number(port) };
}

const errText = (attrs) => {
  const v = attrs[0x0009];
  return v ? `${v.readUInt8(2) * 100 + v.readUInt8(3)} ${v.subarray(4).toString("utf8")}` : "?";
};

// --- Step 0: what does the deployment hand out? -----------------------------

function fetchWelcome() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}?room=${encodeURIComponent(room)}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timed out waiting for welcome"));
    }, 15_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", name: "relay-check" })));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type !== "welcome") return;
      clearTimeout(timer);
      ws.close();
      resolve(msg);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// --- Step 1: control plane --------------------------------------------------

function udpSocket() {
  const sock = dgram.createSocket("udp4");
  const waiters = [];
  sock.on("message", (m) => waiters.shift()?.(m));
  return {
    send: (buf, port, host) => sock.send(buf, port, host),
    recv: (ms) =>
      new Promise((resolve) => {
        const t = setTimeout(() => {
          const i = waiters.indexOf(cb);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, ms);
        const cb = (m) => {
          clearTimeout(t);
          resolve(m);
        };
        waiters.push(cb);
      }),
    close: () => sock.close(),
  };
}

function tcpSocket(host, port) {
  const sock = net.connect(port, host);
  let buf = Buffer.alloc(0);
  const waiters = [];
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 20) {
      const len = buf.readUInt16BE(2) + 20;
      if (buf.length < len) break;
      const msg = buf.subarray(0, len);
      buf = buf.subarray(len);
      const w = waiters.shift();
      if (!w) break;
      w(msg);
    }
  });
  return {
    ready: new Promise((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    }),
    send: (b) => sock.write(b),
    recv: (ms) =>
      new Promise((resolve) => {
        const t = setTimeout(() => {
          const i = waiters.indexOf(cb);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, ms);
        const cb = (m) => {
          clearTimeout(t);
          resolve(m);
        };
        waiters.push(cb);
      }),
    close: () => sock.destroy(),
  };
}

// Runs Binding -> anonymous Allocate (to learn realm/nonce) -> authenticated
// Allocate over one transport, and reports how far it got.
async function controlPlane({ host, port, transport, username, credential }) {
  const t = transport === "tcp" ? tcpSocket(host, port) : udpSocket();
  const send = (b) => (transport === "tcp" ? t.send(b) : t.send(b, port, host));
  if (t.ready) {
    try {
      await t.ready;
    } catch (err) {
      return { binding: false, error: err.message };
    }
  }

  send(build({ method: METHOD.BINDING, cls: CLASS.REQUEST, txid: crypto.randomBytes(12) }));
  let reply = await t.recv(5000);
  if (!reply) {
    t.close();
    return { binding: false };
  }
  const mapped = xorAddress(parse(reply).attrs[0x0020]);

  const reqTransport = Buffer.from([17, 0, 0, 0]);
  send(
    build({
      method: METHOD.ALLOCATE,
      cls: CLASS.REQUEST,
      txid: crypto.randomBytes(12),
      attrs: [attr(0x0019, reqTransport)],
    }),
  );
  reply = await t.recv(5000);
  if (!reply) {
    t.close();
    return { binding: true, mapped, allocate: false };
  }
  let p = parse(reply);
  const realm = p.attrs[0x0014]?.toString("utf8");
  const nonce = p.attrs[0x0015];
  if (!realm || !nonce) {
    t.close();
    return { binding: true, mapped, allocate: false, challenge: errText(p.attrs) };
  }

  const key = crypto.createHash("md5").update(`${username}:${realm}:${credential}`).digest();
  send(
    build({
      method: METHOD.ALLOCATE,
      cls: CLASS.REQUEST,
      txid: crypto.randomBytes(12),
      attrs: [
        attr(0x0019, reqTransport),
        attr(0x0006, Buffer.from(username, "utf8")),
        attr(0x0014, Buffer.from(realm, "utf8")),
        attr(0x0015, nonce),
      ],
      key,
    }),
  );
  reply = await t.recv(5000);
  if (!reply) {
    t.close();
    return { binding: true, mapped, allocate: false, realm };
  }
  p = parse(reply);
  t.close();
  if (p.cls !== CLASS.SUCCESS) {
    return { binding: true, mapped, allocate: false, realm, error: errText(p.attrs) };
  }
  return { binding: true, mapped, allocate: true, realm, relayed: xorAddress(p.attrs[0x0016]) };
}

// --- Step 1b: which DIRECTION of the relay is broken? -----------------------
//
// Silence over UDP looks the same whether the request never arrived or the
// answer never made it back, and those have opposite fixes: one is a port
// forward, the other is the relay host's own egress. The TCP control channel
// can drive each half separately and tell them apart:
//
//   inbound  — send UDP at the allocation's relayed address; if coturn gets it,
//              it comes back as a Data indication on the TCP channel.
//   outbound — ask coturn (over TCP) to Send a datagram at us; if the relay's
//              outbound UDP survives the trip, our UDP socket receives it.
//
// coturn only relays from permitted addresses, and a host behind a pooled NAT
// egresses from several public IPs, so permissions are installed for every
// mapping this socket is observed to have. Permitting one guess produces a
// false "inbound is blocked".
const STUN_FOR_MAPPING = [
  ["stun.cloudflare.com", 3478],
  ["stun.nextcloud.com", 3478],
  ["stun.l.google.com", 19302],
  ["stun1.l.google.com", 19302],
  ["stun2.l.google.com", 19302],
  ["stun3.l.google.com", 19302],
  ["stun4.l.google.com", 19302],
];

async function learnOwnMappings(sock) {
  const found = new Map();
  for (const [host, port] of STUN_FOR_MAPPING) {
    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 4000);
      const onMsg = (m) => {
        clearTimeout(timer);
        sock.raw.off("message", onMsg);
        resolve(m);
      };
      sock.raw.on("message", onMsg);
      sock.send(
        build({ method: METHOD.BINDING, cls: CLASS.REQUEST, txid: crypto.randomBytes(12) }),
        port,
        host,
      );
    });
    if (!reply) continue;
    const mapped = xorAddress(parse(reply).attrs[0x0020]);
    if (mapped) found.set(mapped, splitAddress(mapped));
  }
  return [...found.values()];
}

async function directionProbe({ host, port, username, credential }) {
  const raw = dgram.createSocket("udp4");
  await new Promise((resolve) => raw.bind(resolve));
  const received = [];
  raw.on("message", (m) => received.push(m));
  const sock = {
    raw,
    send: (buf, p, h) => raw.send(buf, p, h),
  };

  const mappings = await learnOwnMappings(sock);
  if (!mappings.length) {
    raw.close();
    return { error: "could not learn this host's public UDP mapping" };
  }

  const t = tcpSocket(host, port);
  try {
    await t.ready;
  } catch (err) {
    raw.close();
    return { error: err.message };
  }

  const reqTransport = Buffer.from([17, 0, 0, 0]);
  t.send(
    build({
      method: METHOD.ALLOCATE,
      cls: CLASS.REQUEST,
      txid: crypto.randomBytes(12),
      attrs: [attr(0x0019, reqTransport)],
    }),
  );
  let reply = await t.recv(5000);
  if (!reply) {
    raw.close();
    t.close();
    return { error: "no challenge over TCP" };
  }
  let p = parse(reply);
  const realm = p.attrs[0x0014]?.toString("utf8");
  const nonce = p.attrs[0x0015];
  if (!realm || !nonce) {
    raw.close();
    t.close();
    return { error: "no realm/nonce over TCP" };
  }
  const key = crypto.createHash("md5").update(`${username}:${realm}:${credential}`).digest();
  const auth = [
    attr(0x0006, Buffer.from(username, "utf8")),
    attr(0x0014, Buffer.from(realm, "utf8")),
    attr(0x0015, nonce),
  ];

  t.send(
    build({
      method: METHOD.ALLOCATE,
      cls: CLASS.REQUEST,
      txid: crypto.randomBytes(12),
      attrs: [attr(0x0019, reqTransport), ...auth],
      key,
    }),
  );
  reply = await t.recv(5000);
  p = reply ? parse(reply) : null;
  if (!p || p.cls !== CLASS.SUCCESS) {
    raw.close();
    t.close();
    return { error: "allocate over TCP failed" };
  }
  const relayed = splitAddress(xorAddress(p.attrs[0x0016]));

  t.send(
    build({
      method: METHOD.CREATE_PERMISSION,
      cls: CLASS.REQUEST,
      txid: crypto.randomBytes(12),
      attrs: [...mappings.map((m) => xorAddrAttr(0x0012, m.ip, m.port)), ...auth],
      key,
    }),
  );
  await t.recv(5000);

  // Inbound: our datagram should come back as a Data indication over TCP.
  // Retried, re-learning our mappings each round: a NAT that egresses from a
  // pool can pick an address we have not permitted yet, and that would look
  // exactly like a blocked port forward.
  const permitted = new Set(mappings.map((m) => `${m.ip}:${m.port}`));
  let inbound = false;
  for (let round = 0; round < 6 && !inbound; round++) {
    if (round > 0) {
      const fresh = (await learnOwnMappings(sock)).filter(
        (m) => !permitted.has(`${m.ip}:${m.port}`),
      );
      if (fresh.length) {
        for (const m of fresh) permitted.add(`${m.ip}:${m.port}`);
        t.send(
          build({
            method: METHOD.CREATE_PERMISSION,
            cls: CLASS.REQUEST,
            txid: crypto.randomBytes(12),
            attrs: [...fresh.map((m) => xorAddrAttr(0x0012, m.ip, m.port)), ...auth],
            key,
          }),
        );
        await t.recv(5000);
      }
    }
    for (let i = 0; i < 6; i++) sock.send(Buffer.from("inbound-probe"), relayed.port, relayed.ip);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !inbound) {
      const msg = await t.recv(1000);
      if (!msg) continue;
      const q = parse(msg);
      if (q.method === METHOD.DATA && q.cls === CLASS.INDICATION) inbound = true;
    }
  }

  // Outbound: ask the relay to emit a datagram at each of our mappings.
  received.length = 0;
  for (const m of mappings) {
    for (let i = 0; i < 3; i++) {
      t.send(
        build({
          method: METHOD.SEND,
          cls: CLASS.INDICATION,
          txid: crypto.randomBytes(12),
          attrs: [xorAddrAttr(0x0012, m.ip, m.port), attr(0x0013, Buffer.from("outbound-probe"))],
        }),
      );
    }
  }
  await sleep(6000);
  const outbound = received.some((m) => m.toString("utf8").includes("outbound-probe"));

  raw.close();
  t.close();
  return { relayed: `${relayed.ip}:${relayed.port}`, mappings: permitted.size, inbound, outbound };
}

// --- Step 2: data plane (two real browsers, relay only) ---------------------

const RELAY_HOOK = `
  window.__pcs = [];
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (cfg, ...rest) {
    const pc = new OrigPC(Object.assign({}, cfg || {}, { iceTransportPolicy: "relay" }), ...rest);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;
`;

const LAUNCH = {
  executablePath: "/usr/bin/google-chrome-stable",
  headless: false,
  args: [
    "--no-sandbox",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--window-size=1000,760",
  ],
};

async function newClient(name) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(RELAY_HOOK);
  await page.setViewport({ width: 1000, height: 760 });
  await page.goto(`${target}/room/${room}`, { waitUntil: "networkidle2", timeout: 45_000 });
  await page.type("#name-input", name);
  await page.click("#join-form button");
  await page.waitForSelector("#room-view:not([hidden])", { timeout: 20_000 });
  return { browser, page };
}

// The selected candidate pair plus its byte counters, straight from getStats().
function mediaStats(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs) {
      const report = await pc.getStats();
      let pair = null;
      const candidates = new Map();
      report.forEach((s) => {
        if (s.type === "local-candidate" || s.type === "remote-candidate") candidates.set(s.id, s);
      });
      report.forEach((s) => {
        if (s.type === "candidate-pair" && (s.selected || s.state === "succeeded")) {
          const local = candidates.get(s.localCandidateId);
          const remote = candidates.get(s.remoteCandidateId);
          pair = {
            localType: local?.candidateType,
            remoteType: remote?.candidateType,
            localAddress: local?.address,
            bytesSent: s.bytesSent,
            bytesReceived: s.bytesReceived,
          };
        }
      });
      let audioIn = 0;
      let audioOut = 0;
      report.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "audio") audioIn += s.packetsReceived || 0;
        if (s.type === "outbound-rtp" && s.kind === "audio") audioOut += s.packetsSent || 0;
      });
      out.push({ connectionState: pc.connectionState, pair, audioIn, audioOut });
    }
    return out;
  });
}

// The app opens more than one RTCPeerConnection (the public-IP probe has no
// media), so totals have to be summed rather than read off the first one.
function totals(samples) {
  return samples.reduce(
    (acc, s) => ({
      audioIn: acc.audioIn + (s.audioIn || 0),
      audioOut: acc.audioOut + (s.audioOut || 0),
      bytesSent: acc.bytesSent + (s.pair?.bytesSent || 0),
      bytesReceived: acc.bytesReceived + (s.pair?.bytesReceived || 0),
    }),
    { audioIn: 0, audioOut: 0, bytesSent: 0, bytesReceived: 0 },
  );
}

// A loopback/private TURN host is a local test rig, where a private relayed
// address is correct. Only a public deployment must advertise a public one.
function isPrivateHost(host) {
  return (
    host === "localhost" ||
    /^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    host === "::1"
  );
}

function tileState(page, name) {
  return page.evaluate((n) => {
    const t = [...document.querySelectorAll(".video-tile")].find(
      (el) =>
        !el.classList.contains("screen-tile") &&
        !el.classList.contains("self") &&
        el.querySelector(".video-tile-name")?.textContent?.trim() === n,
    );
    if (!t) return { found: false };
    return {
      found: true,
      connecting: t.classList.contains("connection-connecting"),
      uncertain: t.classList.contains("connection-uncertain"),
      relayed: t.classList.contains("connection-relayed"),
    };
  }, name);
}

function iceHealth(page) {
  return page.evaluate(() => {
    const box = document.getElementById("ice-health");
    if (!box) return { present: false };
    return { present: true, hidden: box.hidden, text: (box.textContent || "").trim() };
  });
}

async function shot(page, name) {
  if (!SHOT_DIR) return;
  await page.evaluate(() => {
    const bubble = document.getElementById("share-onboarding");
    if (bubble) bubble.hidden = true;
  });
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
  console.log(`   shot: ${SHOT_DIR}/${name}.png`);
}

async function waitFor(read, predicate, timeoutMs, stepMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(stepMs);
    last = await read();
  }
  return last;
}

// --- run --------------------------------------------------------------------

(async () => {
  console.log(`# relay check against ${target} (room ${room})\n`);

  const welcome = await fetchWelcome();
  console.log(`build: ${welcome.buildVersion}`);
  const turnEntry = (welcome.iceServers || []).find((s) =>
    [].concat(s.urls || []).some((u) => u.startsWith("turn:") || u.startsWith("turns:")),
  );
  check("the deployment hands out TURN credentials", Boolean(turnEntry), welcome.iceServers);
  if (!turnEntry) {
    console.log("\nSTUN-only deployment: nothing to relay-check.");
    process.exit(1);
  }
  const urls = [].concat(turnEntry.urls);
  console.log(`turn urls: ${urls.join(", ")}\n`);

  // --- control plane, per advertised URL -----------------------------------
  for (const url of urls) {
    const m = /^turns?:([^:?]+)(?::(\d+))?(?:\?transport=(\w+))?/.exec(url);
    if (!m) continue;
    const host = m[1];
    const port = Number(m[2] || 3478);
    const advertised = (m[3] || "udp").toLowerCase();

    console.log(`## control plane — ${url}`);
    const asAdvertised = await controlPlane({
      host,
      port,
      transport: advertised,
      username: turnEntry.username,
      credential: turnEntry.credential,
    });
    console.log(`   ${advertised}: ${JSON.stringify(asAdvertised)}`);
    check(
      `${advertised.toUpperCase()} ${host}:${port} answers STUN Binding`,
      asAdvertised.binding,
      asAdvertised,
    );
    check(
      `${advertised.toUpperCase()} ${host}:${port} grants an authenticated Allocate`,
      asAdvertised.allocate,
      asAdvertised,
    );
    if (asAdvertised.relayed && !isPrivateHost(host)) {
      check(
        "the relayed address is public (external-ip is set correctly)",
        !isPrivateHost(asAdvertised.relayed.split(":")[0]),
        asAdvertised.relayed,
      );
    }

    // Cross-check the other transport. Reaching the server over TCP while UDP
    // is silent pins the fault on UDP forwarding rather than on coturn itself.
    const other = advertised === "udp" ? "tcp" : "udp";
    const viaOther = await controlPlane({
      host,
      port,
      transport: other,
      username: turnEntry.username,
      credential: turnEntry.credential,
    });
    console.log(`   ${other} (cross-check): ${JSON.stringify(viaOther)}`);

    // Silent over the advertised transport but alive over the other one: the
    // relay server itself is fine, so the useful question is which direction of
    // UDP is lost. Drive both halves from the transport that still works.
    if (!asAdvertised.binding && viaOther.binding && other === "tcp") {
      console.log(
        `   coturn is alive over ${other.toUpperCase()} but silent over ` +
          `${advertised.toUpperCase()}. Probing each UDP direction separately:`,
      );
      const dir = await directionProbe({
        host,
        port,
        username: turnEntry.username,
        credential: turnEntry.credential,
      });
      if (dir.error) {
        console.log(`   direction probe unavailable: ${dir.error}`);
      } else {
        console.log(
          `   relay ${dir.relayed} — inbound ${dir.inbound ? "OK" : "NO PAYLOAD"}, ` +
            `outbound ${dir.outbound ? "OK" : "NO PAYLOAD"} ` +
            `(${dir.mappings} local mapping(s) permitted)`,
        );
        if (dir.inbound && !dir.outbound) {
          console.log(
            "   => The port forward is FINE — datagrams reach the relay. What is lost is\n" +
              "      the relay's own outbound UDP. On the macOS host that is the PF\n" +
              "      min-ttl scrub not matching: coturn emits UDP with TTL 1, which dies\n" +
              "      at the first hop. Check `sudo pfctl -a babbla-coturn -sr` and that the\n" +
              "      rule's source IP/interface still match the host, then re-run\n" +
              "      scripts/install-native-coturn.sh.",
          );
        } else if (!dir.inbound && dir.outbound) {
          console.log("   => Inbound UDP is blocked before the relay: check the port forward.");
        } else if (!dir.inbound && !dir.outbound) {
          // Only the outbound half is proven here. This host may egress from a
          // pooled NAT address the relay was never told to permit, which is
          // indistinguishable from a blocked forward — so don't send anyone at
          // the router on this evidence.
          console.log(
            "   => The relay's outbound UDP is definitely lost. Inbound is UNPROVEN: this\n" +
              "      prober's own egress address may not have matched a permission. Re-run;\n" +
              "      a single inbound OK settles that the port forward is fine.",
          );
        }
      }
    }
    console.log("");
  }

  if (process.env.RELAY_CHECK_SKIP_BROWSER) {
    console.log(`\n${pass}/${pass + fail} checks passed (control plane only)`);
    process.exit(fail ? 1 : 0);
  }

  // --- data plane -----------------------------------------------------------
  console.log("## data plane — two browsers pinned to relay only");
  let a;
  let b;
  try {
    a = await newClient("RelayCheckA");
    b = await newClient("RelayCheckB");

    const tile = await waitFor(
      () => tileState(a.page, "RelayCheckB"),
      (t) => t.found && t.relayed && !t.uncertain && !t.connecting,
      45_000,
    );
    check("the pair comes up over the relay", tile.relayed && !tile.uncertain, tile);

    const first = totals(await mediaStats(a.page));
    await sleep(4000);
    const after = await mediaStats(a.page);
    const second = totals(after);
    const pair = after.find((s) => s.pair)?.pair;
    console.log(`   selected pair: ${JSON.stringify(pair)}`);
    check("the selected candidate pair is a relay pair", pair?.localType === "relay", pair);

    // Both counters matter: RTP packets prove media, candidate-pair bytes prove
    // it is the relay carrying them.
    const sent = second.audioOut - first.audioOut;
    const received = second.audioIn - first.audioIn;
    const bytesUp = second.bytesSent - first.bytesSent;
    const bytesDown = second.bytesReceived - first.bytesReceived;
    console.log(
      `   over 4 s: RTP sent ${sent} pkts / received ${received} pkts, ` +
        `relay pair ${bytesUp} B up / ${bytesDown} B down`,
    );
    check("RTP flows outbound through the relay", sent > 0, { sent });
    check("RTP flows inbound through the relay", received > 0, { received });
    check("the relay candidate pair carries bytes both ways", bytesUp > 0 && bytesDown > 0, {
      bytesUp,
      bytesDown,
    });

    const health = await iceHealth(a.page);
    console.log(`   ice-health box: ${JSON.stringify(health)}`);
    check("no active STUN/TURN error is reported", health.hidden || !/Fel från/.test(health.text), health);
    await shot(a.page, "relay_live_check");
  } catch (err) {
    console.error("relay-live-check: error", err);
    fail++;
    if (a) await shot(a.page, "relay_live_check_failed");
  } finally {
    try {
      await a?.browser.close();
    } catch {}
    try {
      await b?.browser.close();
    } catch {}
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})();
