// Small shared formatting helpers for the stats pages.

export function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

export function fmtDur(ms) {
  if (!ms || ms < 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function shortHash(id, n = 8) {
  return String(id || "?").slice(0, n);
}

// Human label for an ASN: the network's org name (e.g. "Telia Company AB") from
// the offline iptoasn TSV, which is what an operator actually wants to read —
// not a bare "AS3301". Falls back to "AS<n>" when the TSV had no org string for
// that AS, and to "okänd" when the IP never resolved to an ASN at all (null —
// e.g. STUN was blocked). With `withNumber`, append "(AS<n>)" for tooltips/detail
// where both the name and the number are useful.
export function asnLabel({ asn, asn_org } = {}, { withNumber = false } = {}) {
  if (asn == null) return "okänd";
  const org = String(asn_org || "").trim();
  if (!org) return `AS${asn}`;
  return withNumber ? `${org} (AS${asn})` : org;
}
