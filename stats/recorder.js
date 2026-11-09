// Buffered, fault-isolated event recorder. The signaling hot path
// (server.js ws.on("message")) calls record() which only pushes to an in-memory
// buffer — never touches SQLite inline — so logging can't add latency to the
// audio/signaling relay. A timer flushes the buffer in one batched transaction.
//
// CRITICAL: a stats failure must NEVER bubble into signaling. flush() swallows
// all errors (logged once via onError); a dead/locked DB loses stats, never a
// call. See .cursor/plans/stats-poc.md (beslut 10).

/**
 * @param {object} opts
 * @param {(rows: object[]) => void} opts.insert batched write (stats/db.js)
 * @param {() => number} [opts.now]
 * @param {number} [opts.flushIntervalMs] 0 = no timer (flush manually; tests)
 * @param {number} [opts.maxBuffer] flush early once the buffer reaches this size
 * @param {(e: Error) => void} [opts.onError]
 * @param {typeof setInterval} [opts.setIntervalFn]
 * @param {typeof clearInterval} [opts.clearIntervalFn]
 */
export function createRecorder({
  insert,
  now = Date.now,
  flushIntervalMs = 1_000,
  maxBuffer = 500,
  onError = (e) => console.warn("[babbla:stats] flush misslyckades:", e.message),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  /** @type {object[]} */
  let buffer = [];
  let timer = null;

  function record(event) {
    // Stamp the server-authoritative timestamp here if the caller didn't.
    buffer.push(event.ts == null ? { ...event, ts: now() } : event);
    if (buffer.length >= maxBuffer) flush();
  }

  function flush() {
    if (!buffer.length) return;
    const rows = buffer;
    buffer = [];
    try {
      insert(rows);
    } catch (e) {
      // Drop the batch (don't re-buffer — avoids unbounded growth if the DB is
      // wedged) and keep going. Stats are best-effort; calls are not.
      onError(e);
    }
  }

  if (flushIntervalMs > 0) {
    timer = setIntervalFn(flush, flushIntervalMs);
    // Don't keep the process alive just for the stats flush timer.
    timer?.unref?.();
  }

  function close() {
    if (timer) clearIntervalFn(timer);
    timer = null;
    flush();
  }

  return { record, flush, close, pending: () => buffer.length };
}
