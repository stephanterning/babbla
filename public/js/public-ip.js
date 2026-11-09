// Public-IP discovery for usage stats — finds this client's own public IP via a
// STUN server-reflexive (srflx) ICE candidate, so the server can resolve it to
// an ASN. This exists because some deployments sit behind a proxy/NAT that
// rewrites the source address before it reaches the server (e.g. Docker Desktop
// for macOS SNATs all ingress to its VM gateway), so the server's view of the
// client IP — and thus X-Forwarded-For — is useless. The browser, by contrast,
// learns its real public IP straight from STUN.
//
// No third-party HTTP call: this reuses the same public STUN servers the mesh
// already relies on (a plain UDP binding, no payload). Best-effort and fully
// isolated — a failure resolves null (the server then logs asn: null), never
// throws into the join path. The result is reported to the server as a field on
// the existing `join` message; the server keeps doing the offline TSV lookup.

// Pull the reflexive (public) address out of an ICE candidate. Prefers the
// structured fields (modern browsers) and falls back to parsing the SDP string:
//   candidate:<foundation> <component> <transport> <priority> <ADDRESS> <port> typ <TYPE> ...
// Only `srflx` candidates carry the STUN-observed public address; host (often an
// mDNS .local) and relay candidates are ignored.
export function srflxAddressFrom(candidate) {
  if (!candidate) return null;
  if (candidate.type === "srflx" && candidate.address) return candidate.address;
  const m = String(candidate.candidate || "").match(
    /^candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\S+)/i,
  );
  return m && m[2] === "srflx" ? m[1] : null;
}

/**
 * Resolve this client's public IP via a throwaway STUN-only RTCPeerConnection.
 * Resolves the first srflx address seen, or null on timeout / no STUN / failure.
 *
 * @param {object} [opts]
 * @param {RTCIceServer[]} [opts.iceServers] STUN (and/or TURN) servers to probe
 * @param {number} [opts.timeoutMs] give up after this long (default 2000)
 * @param {typeof RTCPeerConnection} [opts.RTCPeerConnectionImpl] injectable for tests
 * @returns {Promise<string|null>}
 */
export function discoverPublicIp({
  iceServers = [],
  timeoutMs = 2000,
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
} = {}) {
  if (typeof RTCPeerConnectionImpl !== "function") return Promise.resolve(null);

  let pc;
  try {
    pc = new RTCPeerConnectionImpl({ iceServers });
  } catch {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ip) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch {}
      resolve(ip || null);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    pc.addEventListener("icecandidate", (e) => {
      // A null candidate marks end-of-gathering: if we got here without an srflx
      // (STUN blocked / UDP filtered), give up rather than wait for the timeout.
      if (!e.candidate) {
        finish(null);
        return;
      }
      const ip = srflxAddressFrom(e.candidate);
      if (ip) finish(ip);
    });

    // A data channel gives the connection something to gather candidates for
    // without needing any media; the offer kicks off ICE gathering.
    try {
      pc.createDataChannel("ip-probe");
      Promise.resolve(pc.createOffer())
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => finish(null));
    } catch {
      finish(null);
    }
  });
}
