// Room-name pseudonymization. The stats log must never store a room name in
// clear text (it can leak the room's topic/relationship — see
// .cursor/plans/stats-poc.md "Leak-safe by default"). Instead we store an
// HMAC of the canonical room name keyed by a server-side secret that lives
// OUTSIDE the SQLite volume (an env secret), so a DB/volume leak alone cannot
// reverse the hashes.
//
// The hash must be STABLE across process restarts: the deploy-resilient session
// resume (stats/sessions.js + stats/derive.js) matches a returning join to an
// open session by `room_hash`. A per-process random key would re-pseudonymize
// every room on each restart and break that match (and all longitudinal
// room-reuse analysis), so the key is long-lived. In production it comes from
// STATS_HMAC_SECRET; for local dev (no secret) we fall back to a fixed constant
// and warn — the local DB is throwaway and never leaves the machine.

import { createHmac } from "node:crypto";

const DEV_FALLBACK_SECRET = "babbla-stats-dev-key-not-for-production";

/**
 * @param {string} secret HMAC key (env STATS_HMAC_SECRET). Empty -> dev fallback.
 * @param {(msg: string) => void} [warn]
 * @returns {(roomName: string) => string} canonical room name -> opaque hex hash
 */
export function createRoomHasher(secret, warn = console.warn) {
  const key = (secret || "").trim();
  if (!key) {
    warn(
      "[babbla:stats] STATS_HMAC_SECRET är osatt — använder dev-fallback-nyckel. " +
        "Sätt en hemlighet i produktion (rumsnamn hashas annars med en känd nyckel).",
    );
  }
  const effectiveKey = key || DEV_FALLBACK_SECRET;
  // Truncated to 16 hex chars (64 bits): plenty to keep distinct rooms distinct
  // at this scale, while keeping the token short in the UI/log.
  return (roomName) =>
    createHmac("sha256", effectiveKey)
      .update(String(roomName ?? ""))
      .digest("hex")
      .slice(0, 16);
}
