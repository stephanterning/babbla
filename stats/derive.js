// Pure startup reconciliation: given a list of recent event rows, find the room
// sessions that are still OPEN (no `room-session-end`) so the server can resume
// them after a restart instead of splitting a live session across a deploy. See
// .cursor/plans/stats-poc.md beslut 5. The caller (stats/index.js) seeds these
// into the session registry, which arms a resume timer per session and ends the
// stale ones (last activity older than the resume window) with a synthetic end.
//
// Membership (for reconnect detection) is derived from join/reconnect events. We
// operate on a recent slice of the log (the facade bounds the query), which is
// where a just-interrupted session's events live.

/**
 * @param {object[]} events rows with { type, ts, room_hash, room_session_id, actor_client_id }
 * @returns {{ roomSessionId: string, roomHash: string, startedTs: number,
 *   lastActivityTs: number, members: string[] }[]}
 */
export function deriveOpenSessions(events) {
  const byId = new Map();
  for (const e of events) {
    if (!e.room_session_id) continue;
    let g = byId.get(e.room_session_id);
    if (!g) {
      g = {
        roomSessionId: e.room_session_id,
        roomHash: e.room_hash || null,
        startedTs: e.ts,
        lastActivityTs: e.ts,
        members: new Set(),
        ended: false,
      };
      byId.set(e.room_session_id, g);
    }
    if (e.ts < g.startedTs) g.startedTs = e.ts;
    if (e.ts > g.lastActivityTs) g.lastActivityTs = e.ts;
    if (!g.roomHash && e.room_hash) g.roomHash = e.room_hash;
    if (e.type === "room-session-end") g.ended = true;
    if (
      (e.type === "join" || e.type === "reconnect") &&
      e.actor_client_id
    ) {
      g.members.add(e.actor_client_id);
    }
  }
  return [...byId.values()]
    .filter((g) => !g.ended)
    .map((g) => ({
      roomSessionId: g.roomSessionId,
      roomHash: g.roomHash,
      startedTs: g.startedTs,
      lastActivityTs: g.lastActivityTs,
      members: [...g.members],
    }));
}
