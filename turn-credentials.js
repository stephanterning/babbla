// Server-only credential providers. Neither long-lived secret is serialized.
import { createHmac } from "node:crypto";

export function createTurnProvider({ env = process.env, fetchImpl = fetch, now = Date.now,
  warn = console.warn, timeoutMs = 3000 } = {}) {
  const provider = (env.TURN_PROVIDER || "native").trim();
  const secret = (env.TURN_SECRET || "").trim();
  const urls = (env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
  const ttlValue = Number(env.TURN_TTL_SECONDS);
  const ttl = Number.isFinite(ttlValue) && ttlValue > 0
    ? Math.min(86400, Math.max(60, Math.floor(ttlValue))) : 3600;
  const keyId = (env.CLOUDFLARE_TURN_KEY_ID || "").trim();
  const token = (env.CLOUDFLARE_TURN_API_TOKEN || "").trim();
  const cloudflare = provider === "cloudflare" && keyId && token;
  if (provider !== "native" && !cloudflare) {
    warn("turn: provider configuration incomplete or unknown; using native fallback");
  }
  function nativeCredentials() {
    if (!secret || !urls.length) return null;
    const username = `${Math.floor(now() / 1000) + ttl}:babbla`;
    return { iceServers: [{ urls, username,
      credential: createHmac("sha1", secret).update(username).digest("base64") }],
      refreshMs: Math.floor(ttl * 500) };
  }

  // One session per WebSocket: credentials are not shared across users. Cache
  // until half-life and coalesce repeated requests so ice-refresh cannot hammer
  // the API. A failed request retries after 30 seconds using native meanwhile.
  return function createSession() {
    let cached = null;
    let refreshAt = 0;
    let pending = null;
    function snapshot() {
      return cached && { iceServers: cached, refreshMs: Math.max(1000, refreshAt - now()) };
    }
    async function renew() {
      const started = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
          { method: "POST", headers: { Authorization: `Bearer ${token}`,
            "Content-Type": "application/json" }, body: JSON.stringify({ ttl }),
            signal: controller.signal, redirect: "error" },
        );
        if (!response.ok) throw new Error("status");
        const body = await response.json();
        const servers = validateCloudflareServers(body);
        cached = servers;
        refreshAt = started + ttl * 500;
        return snapshot();
      } catch {
        // Do not log response bodies or exception strings: either may contain
        // the bearer token or credentials. Fallback is intentionally observable.
        warn("turn: Cloudflare credentials unavailable; using native fallback");
        const fallback = nativeCredentials();
        cached = fallback?.iceServers || [];
        refreshAt = now() + 30_000;
        return snapshot();
      } finally {
        clearTimeout(timer);
      }
    }
    return async function credentials() {
      if (!cloudflare) return nativeCredentials();
      if (now() < refreshAt) return snapshot();
      if (!pending) pending = renew().finally(() => { pending = null; });
      return pending;
    };
  };
}

function validateCloudflareServers(body) {
  if (!Array.isArray(body?.iceServers) || !body.iceServers.length) throw new Error("shape");
  let hasTurn = false;
  const servers = body.iceServers.map(server => {
    const urls = typeof server?.urls === "string" ? [server.urls] : server?.urls;
    if (!Array.isArray(urls) || !urls.length || !urls.every(url => typeof url === "string" &&
      /^(?:stun:stun\.cloudflare\.com:(?:3478|443|53)|turn:turn\.cloudflare\.com:(?:3478|443|80|53)\?transport=(?:udp|tcp)|turns:turn\.cloudflare\.com:(?:5349|443)\?transport=tcp)$/.test(url))) {
      throw new Error("urls");
    }
    const filtered = urls.filter(url => !/:53(?:\?|$)/.test(url));
    if (!filtered.length) return null;
    if (filtered.some(url => /^turns?:/.test(url))) {
      if (typeof server.username !== "string" || !server.username ||
          typeof server.credential !== "string" || !server.credential) throw new Error("credentials");
      hasTurn = true;
      return { urls: filtered, username: server.username, credential: server.credential };
    }
    return { urls: filtered };
  }).filter(Boolean);
  if (!hasTurn) throw new Error("no_turn");
  return servers;
}
