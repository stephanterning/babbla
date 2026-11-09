// Unit tests for the leaf stats decorators: room-name HMAC, UA bucketing, and
// the offline ASN resolver. Pure, no DB. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRoomHasher } from "../stats/hash.js";
import { parseUserAgent } from "../stats/ua.js";
import { createAsnResolver, ipToBigInt } from "../stats/asn.js";

test("room hasher is deterministic, opaque, and key-dependent", () => {
  const h1 = createRoomHasher("secret-A", () => {});
  const h2 = createRoomHasher("secret-A", () => {});
  const h3 = createRoomHasher("secret-B", () => {});
  assert.equal(h1("standup"), h2("standup")); // stable across instances (resume)
  assert.notEqual(h1("standup"), h1("lunch")); // distinct rooms distinct
  assert.notEqual(h1("standup"), h3("standup")); // different key -> different hash
  assert.doesNotMatch(h1("standup"), /standup/); // never leaks the name
  assert.equal(h1("standup").length, 16);
});

test("room hasher warns when no secret is configured", () => {
  let warned = false;
  createRoomHasher("", () => {
    warned = true;
  });
  assert.equal(warned, true);
});

test("UA bucketing: desktop Chrome", () => {
  const ua = parseUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  );
  assert.equal(ua.ua_browser, "Chrome");
  assert.equal(ua.ua_version_major, "124");
  assert.equal(ua.ua_os, "Windows");
  assert.equal(ua.is_ios, 0);
  assert.equal(ua.is_chromium, 1);
});

test("UA bucketing: iOS Safari is WebKit, not chromium", () => {
  const ua = parseUserAgent(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  );
  assert.equal(ua.ua_os, "iOS");
  assert.equal(ua.is_ios, 1);
  assert.equal(ua.is_chromium, 0); // crucial: "Chrome" on iOS would still be 0
  assert.equal(ua.ua_browser, "Safari");
});

test("UA bucketing: 'Chrome' on iOS (CriOS) is still iOS WebKit", () => {
  const ua = parseUserAgent(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1",
  );
  assert.equal(ua.is_ios, 1);
  assert.equal(ua.is_chromium, 0);
  assert.equal(ua.ua_browser, "Chrome");
});

test("ipToBigInt parses v4 and v6, rejects garbage", () => {
  assert.equal(ipToBigInt("0.0.0.0"), 0n);
  assert.equal(ipToBigInt("1.2.3.4"), 16909060n);
  assert.equal(ipToBigInt("255.255.255.255"), 4294967295n);
  assert.equal(ipToBigInt("::1"), 1n);
  assert.equal(ipToBigInt("::"), 0n);
  assert.equal(ipToBigInt("not-an-ip"), null);
  assert.equal(ipToBigInt("1.2.3"), null);
  assert.equal(ipToBigInt("256.0.0.1"), null);
});

test("ASN resolver: missing file is best-effort (always null)", () => {
  const r = createAsnResolver({ tsvPath: "/no/such/file.tsv", warn: () => {} });
  assert.equal(r.ready, false);
  assert.equal(r.lookup("1.2.3.4"), null);
});

test("ASN resolver: looks up a v4 range from a tiny TSV", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "asn-"));
  const file = join(dir, "ip2asn.tsv");
  writeFileSync(
    file,
    [
      "1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET",
      "8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE",
      "0.0.0.0\t0.255.255.255\t0\tNone\tNot routed", // AS0 -> skipped
    ].join("\n"),
    "utf8",
  );
  const r = createAsnResolver({ tsvPath: file });
  assert.equal(r.ready, true);
  assert.deepEqual(r.lookup("8.8.8.8"), { asn: 15169, asn_org: "GOOGLE", country: "US" });
  assert.deepEqual(r.lookup("1.0.0.5"), { asn: 13335, asn_org: "CLOUDFLARENET", country: "US" });
  assert.equal(r.lookup("9.9.9.9"), null); // outside any range
  assert.equal(r.lookup("0.0.0.1"), null); // AS0 skipped
});
