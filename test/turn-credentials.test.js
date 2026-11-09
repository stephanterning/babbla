import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createTurnProvider } from "../turn-credentials.js";

const native = { TURN_SECRET: "native-secret", TURN_URLS: "turn:native.example:3478", TURN_TTL_SECONDS: "60" };
const cloudflare = { ...native, TURN_PROVIDER: "cloudflare", CLOUDFLARE_TURN_KEY_ID: "test-key", CLOUDFLARE_TURN_API_TOKEN: "long-lived-api-token" };
// URL set returned by the live credential API on 2026-10-31; credentials are fake.
const iceServers = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:443"] },
  { urls: [
    "turn:turn.cloudflare.com:3478?transport=udp",
    "turn:turn.cloudflare.com:3478?transport=tcp",
    "turns:turn.cloudflare.com:5349?transport=tcp",
    "turn:turn.cloudflare.com:443?transport=udp",
    "turn:turn.cloudflare.com:80?transport=tcp",
    "turns:turn.cloudflare.com:443?transport=tcp",
  ], username: "short-user", credential: "short-password" },
];
const response = () => ({ ok: true, json: async () => ({ iceServers }) });

test("native remains default and does not contact Cloudflare even with a token", async () => {
  const get = createTurnProvider({ env: { ...cloudflare, TURN_PROVIDER: undefined }, now: () => 100_000,
    fetchImpl: () => { throw new Error("must not fetch"); } })();
  const value = await get();
  assert.equal(value.iceServers[0].username, "160:babbla");
  assert.equal(value.iceServers[0].credential, createHmac("sha1", native.TURN_SECRET).update("160:babbla").digest("base64"));
  assert.equal(value.refreshMs, 30_000);
});

test("unconfigured native yields no TURN", async () => {
  assert.equal(await createTurnProvider({ env: {} })()(), null);
});

test("live Cloudflare URL set including STUN 443 avoids native fallback", async () => {
  const warnings = [];
  const get = createTurnProvider({ env: cloudflare, fetchImpl: async () => response(),
    warn: warning => warnings.push(warning) })();
  assert.deepEqual((await get()).iceServers, iceServers);
  assert.deepEqual(warnings, []);
});

test("Cloudflare request is authenticated server-side and only ephemeral fields reach clients", async () => {
  let request;
  const get = createTurnProvider({ env: cloudflare, fetchImpl: async (...args) => {
    request = args; return { ok: true, json: async () => ({ iceServers: iceServers.map(s => ({ ...s, secret: "discard-me" })), token: "discard-me" }) };
  } })();
  const result = await get();
  assert.equal(request[0], "https://rtc.live.cloudflare.com/v1/turn/keys/test-key/credentials/generate-ice-servers");
  assert.equal(request[1].headers.Authorization, "Bearer long-lived-api-token");
  assert.equal(request[1].redirect, "error");
  assert.equal(JSON.parse(request[1].body).ttl, 60);
  assert.deepEqual(result.iceServers, iceServers);
  assert.doesNotMatch(JSON.stringify(result), /native-secret|long-lived-api-token|discard-me/);
});

test("sessions get separate credentials; repeated refreshes coalesce and renew at half life", async () => {
  let time = 0, calls = 0;
  const createSession = createTurnProvider({ env: cloudflare, now: () => time,
    fetchImpl: async () => { calls++; return response(); } });
  const first = createSession();
  await Promise.all([first(), first(), first()]);
  assert.equal(calls, 1);
  time = 10_000; assert.equal((await first()).refreshMs, 20_000); assert.equal(calls, 1);
  await createSession()(); assert.equal(calls, 2);
  time = 30_000; await first(); assert.equal(calls, 3);
});

for (const [name, fetchImpl] of [
  ["HTTP denial", async () => ({ ok: false, json: async () => { throw new Error("must not parse denial"); } })],
  ["network failure", async () => { throw new Error("long-lived-api-token"); }],
  ["malformed JSON", async () => ({ ok: true, json: async () => { throw new Error("long-lived-api-token"); } })],
  ["malformed credentials", async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: "turn:turn.cloudflare.com:3478?transport=udp" }] }) })],
  ["unexpected relay", async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: "turn:evil.example:3478", username: "u", credential: "c" }] }) })],
  ["unexpected STUN host on port 443", async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: "stun:evil.example:443" }, iceServers[1]] }) })],
  ["unexpected Cloudflare STUN port", async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: "stun:stun.cloudflare.com:444" }, iceServers[1]] }) })],
  ["STUN-only response", async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] }) })],
]) {
  test(`${name} falls back to native without leaking upstream data`, async () => {
    const warnings = [];
    const get = createTurnProvider({ env: cloudflare, fetchImpl, warn: x => warnings.push(x) })();
    const result = await get();
    assert.deepEqual(result.iceServers[0].urls, [native.TURN_URLS]);
    assert.equal(result.refreshMs, 30_000);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings.join(), /long-lived-api-token|native-secret/);
  });
}

test("timed-out request is aborted and native fallback returns promptly", async () => {
  let aborted = false;
  const get = createTurnProvider({ env: cloudflare, timeoutMs: 10, warn: () => {},
    fetchImpl: (_, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("timeout")); });
    }) })();
  assert.deepEqual((await get()).iceServers[0].urls, [native.TURN_URLS]);
  assert.equal(aborted, true);
});

test("failed fetch cools down and recovers on the next refresh", async () => {
  let time = 0, calls = 0;
  const get = createTurnProvider({ env: cloudflare, now: () => time, warn: () => {}, fetchImpl: async () => {
    calls++; if (calls === 1) throw new Error("outage"); return response();
  } })();
  await get(); await get(); assert.equal(calls, 1);
  time = 30_000; assert.deepEqual((await get()).iceServers, iceServers); assert.equal(calls, 2);
});

test("incomplete Cloudflare configuration uses native without HTTP", async () => {
  const warnings = [];
  const get = createTurnProvider({ env: { ...cloudflare, CLOUDFLARE_TURN_API_TOKEN: "" }, warn: x => warnings.push(x),
    fetchImpl: () => { throw new Error("must not fetch"); } })();
  assert.deepEqual((await get()).iceServers[0].urls, [native.TURN_URLS]); assert.equal(warnings.length, 1);
});

test("Cloudflare outage without native credentials remains STUN-only", async () => {
  const get = createTurnProvider({ env: { ...cloudflare, TURN_SECRET: "" }, fetchImpl: async () => { throw new Error("offline"); }, warn: () => {} })();
  assert.deepEqual(await get(), { iceServers: [], refreshMs: 30_000 });
});

test("TTL is finite and bounded to one day", async () => {
  for (const [input, expected] of [["Infinity", 3600], ["garbage", 3600], ["1", 60], ["999999", 86400]]) {
    const get = createTurnProvider({ env: { ...cloudflare, TURN_TTL_SECONDS: input }, fetchImpl: async (_, options) => {
      assert.equal(JSON.parse(options.body).ttl, expected); return response();
    } })();
    await get();
  }
});
