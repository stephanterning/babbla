// ASN resolver — maps a client IP to its Autonomous System (network operator)
// so we can later analyze "do certain ASNs fail P2P / need relay more often?"
// We store ONLY the ASN/org/country (never the raw IP — see server.js), so this
// is the one place the IP is touched, and it's discarded right after.
//
// Offline by design (no per-connection third-party API call, no IP leaving the
// box): loads the public-domain iptoasn.com TSV at startup into sorted range
// arrays and binary-searches. Best-effort: if the file is missing/unreadable,
// every lookup returns null and the rest of the stats pipeline continues
// (asn: null) rather than blocking. See .cursor/plans/stats-poc.md.
//
// TSV columns (tab-separated): range_start, range_end, AS_number, country, desc.
// v4 ranges are dotted IPv4, v6 ranges are IPv6; the combined file mixes both,
// so we detect the family per line.

import { readFileSync } from "node:fs";

/**
 * @param {object} opts
 * @param {string} [opts.tsvPath] path to an iptoasn TSV (env STATS_ASN_TSV)
 * @param {(msg: string) => void} [opts.warn]
 * @returns {{ ready: boolean, lookup: (ip: string) =>
 *   ({ asn: number, asn_org: string, country: string } | null) }}
 */
export function createAsnResolver({ tsvPath, warn = console.warn } = {}) {
  const v4 = [];
  const v6 = [];
  let ready = false;

  if (tsvPath) {
    try {
      load(readFileSync(tsvPath, "utf8"), v4, v6);
      v4.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      v6.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      ready = true;
    } catch (e) {
      warn(
        `[babbla:stats] ASN-databasen kunde inte laddas (${tsvPath}): ${e.message}. ` +
          "ASN loggas som null.",
      );
    }
  }

  function lookup(ip) {
    if (!ready) return null;
    const n = ipToBigInt(ip);
    if (n === null) return null;
    const table = String(ip).includes(":") ? v6 : v4;
    return search(table, n);
  }

  return { ready, lookup };
}

function load(text, v4, v6) {
  for (const line of text.split("\n")) {
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < 5) continue;
    const [startStr, endStr, asnStr, country, org] = cols;
    const asn = Number(asnStr);
    // AS 0 = "not routed"/unknown in the iptoasn dataset.
    if (!asn) continue;
    const start = ipToBigInt(startStr);
    const end = ipToBigInt(endStr);
    if (start === null || end === null) continue;
    const entry = { start, end, asn, country: country || "", org: org || "" };
    (startStr.includes(":") ? v6 : v4).push(entry);
  }
}

// Largest range whose start <= n, then check it actually contains n.
function search(table, n) {
  let lo = 0;
  let hi = table.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid].start <= n) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) return null;
  const e = table[found];
  if (n > e.end) return null;
  return { asn: e.asn, asn_org: e.org, country: e.country };
}

/** Parse an IPv4 or IPv6 string into a BigInt, or null if unparseable. */
export function ipToBigInt(ip) {
  const s = String(ip || "").trim();
  if (!s) return null;
  return s.includes(":") ? ipv6ToBigInt(s) : ipv4ToBigInt(s);
}

function ipv4ToBigInt(s) {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255 || !/^\d+$/.test(p)) return null;
    n = (n << 8n) | BigInt(o);
  }
  return n;
}

function ipv6ToBigInt(s) {
  // Strip a zone id (fe80::1%eth0) if present.
  const addr = s.split("%")[0];
  // Embedded IPv4 (::ffff:1.2.3.4) — convert the trailing dotted quad to two
  // hextets so the rest of the parser sees a pure v6 address.
  let work = addr;
  const v4tail = work.match(/(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const v4 = ipv4ToBigInt(v4tail[2]);
    if (v4 === null) return null;
    const hi = (v4 >> 16n) & 0xffffn;
    const lo = v4 & 0xffffn;
    work = `${v4tail[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const halves = work.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - (head.length + tail.length);
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups =
    halves.length === 2
      ? [...head, ...Array(missing).fill("0"), ...tail]
      : head;
  if (groups.length !== 8) return null;

  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}
