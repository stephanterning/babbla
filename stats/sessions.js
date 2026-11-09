// Session registry — owns `room_session_id` lifecycle for the stats log.
//
// A "room session" is one occupancy of a room: from the first join into an empty
// room to the last leave (the user's "första in -> sista ut"). It is NOT tied to
// the live Room object (room.js `removeIfEmpty` GCs that immediately at 0 peers),
// so this state lives in the server adapter and is keyed by `room_hash`.
//
// Deploy-resilience (the key design point — see .cursor/plans/stats-poc.md
// beslut 5): a server restart (every deploy) wipes this in-memory map. To avoid
// splitting a live session, open sessions are re-derived from the event log at
// startup (stats/derive.js) and re-seeded via hydrate(); a returning client
// (same client_id, carried in sessionStorage across the deploy-restore reload)
// rejoins the SAME room_session_id. Pure: all clock/timer/id/record deps are
// injected, so it runs and is asserted in Node with fakes.

import { randomUUID } from "node:crypto";

/**
 * @param {object} opts
 * @param {(event: object) => void} opts.record sink for room-session-start/end
 * @param {() => number} [opts.now]
 * @param {() => string} [opts.newId] room_session_id generator
 * @param {number} [opts.graceMs] same-process empty->end delay
 * @param {number} [opts.resumeWindowMs] startup resume horizon (> graceMs)
 * @param {typeof setTimeout} [opts.setTimeoutFn]
 * @param {typeof clearTimeout} [opts.clearTimeoutFn]
 */
export function createSessionRegistry({
  record,
  now = Date.now,
  newId = randomUUID,
  graceMs = 15_000,
  resumeWindowMs = 300_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  /**
   * @type {Map<string, {
   *   roomSessionId: string, startedTs: number, lastActivityTs: number,
   *   present: Set<string>, members: Set<string>, endTimer: any,
   * }>}
   */
  const sessions = new Map();

  function clearEndTimer(s) {
    if (s.endTimer) {
      clearTimeoutFn(s.endTimer);
      s.endTimer = null;
    }
  }

  function endNow(roomHash) {
    const s = sessions.get(roomHash);
    if (!s) return;
    // Defensive: someone rejoined between scheduling and firing.
    if (s.present.size > 0) {
      clearEndTimer(s);
      return;
    }
    record({
      type: "room-session-end",
      ts: s.lastActivityTs,
      room_hash: roomHash,
      room_session_id: s.roomSessionId,
    });
    sessions.delete(roomHash);
  }

  function scheduleEnd(roomHash, delayMs) {
    const s = sessions.get(roomHash);
    if (!s) return;
    clearEndTimer(s);
    if (delayMs <= 0) {
      endNow(roomHash);
      return;
    }
    s.endTimer = setTimeoutFn(() => endNow(roomHash), delayMs);
    s.endTimer?.unref?.();
  }

  /** First join into an empty room mints + announces a session. */
  function onJoin(roomHash, clientId, connId) {
    const t = now();
    let s = sessions.get(roomHash);
    let reconnect = false;
    if (!s) {
      const roomSessionId = newId();
      s = {
        roomSessionId,
        startedTs: t,
        lastActivityTs: t,
        present: new Set(),
        members: new Set(),
        endTimer: null,
      };
      sessions.set(roomHash, s);
      record({
        type: "room-session-start",
        ts: t,
        room_hash: roomHash,
        room_session_id: roomSessionId,
      });
    } else {
      // A join (re)arrived — cancel any pending grace/resume end.
      clearEndTimer(s);
      reconnect = s.members.has(clientId);
    }
    s.present.add(connId);
    s.members.add(clientId);
    s.lastActivityTs = t;
    return { roomSessionId: s.roomSessionId, reconnect };
  }

  /** A connection left; arm the grace timer once the room is empty. */
  function onLeave(roomHash, clientId, connId) {
    const s = sessions.get(roomHash);
    if (!s) return null;
    s.present.delete(connId);
    s.lastActivityTs = now();
    if (s.present.size === 0) scheduleEnd(roomHash, graceMs);
    return { roomSessionId: s.roomSessionId };
  }

  function sessionIdFor(roomHash) {
    return sessions.get(roomHash)?.roomSessionId ?? null;
  }

  function noteActivity(roomHash, ts = now()) {
    const s = sessions.get(roomHash);
    if (s) s.lastActivityTs = ts;
  }

  // Startup reconciliation: re-seed open sessions derived from the event log and
  // arm a resume timer for each. Sessions whose last activity is already older
  // than the resume window end immediately (synthetic room-session-end at their
  // last-activity ts); the rest await a reconnect within the remaining window.
  function hydrate(openSessions = []) {
    const t = now();
    for (const o of openSessions) {
      if (sessions.has(o.roomHash)) continue;
      sessions.set(o.roomHash, {
        roomSessionId: o.roomSessionId,
        startedTs: o.startedTs ?? o.lastActivityTs,
        lastActivityTs: o.lastActivityTs,
        present: new Set(),
        members: new Set(o.members || []),
        endTimer: null,
      });
      scheduleEnd(o.roomHash, resumeWindowMs - (t - o.lastActivityTs));
    }
  }

  // Clear timers without ending sessions (graceful process stop; the next start
  // re-derives + resumes/ends them from the log).
  function stop() {
    for (const s of sessions.values()) clearEndTimer(s);
  }

  return {
    onJoin,
    onLeave,
    sessionIdFor,
    noteActivity,
    hydrate,
    stop,
    // Introspection (tests / live snapshot).
    activeCount: () => sessions.size,
    snapshot: () =>
      [...sessions.entries()].map(([roomHash, s]) => ({
        roomHash,
        roomSessionId: s.roomSessionId,
        present: s.present.size,
        members: s.members.size,
      })),
  };
}
