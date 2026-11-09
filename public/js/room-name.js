// Room name — the one canonical mapping from "what's in the URL" to "which room
// you're in". Shared by both runtimes (the Node server's routing key and the
// browser's display + URL rewrite) the same way protocol.js is, so the key and
// the shown name can never drift.
//
// The rule (deliberate, see AGENTS.md):
//   - The room is the FIRST path segment after `/room/`; the URL parser already
//     stops at the next `/`, so trailing segments are ignored and never reach
//     here.
//   - Canonicalize = lowercase + keep every other character verbatim. So
//     `SmartTV` == `smarttv` (case folds), but `Smart-TV` != `Smart TV` (the
//     `-` and the space are real, distinct rooms). Case-folding is the ONLY
//     merge; nothing else collapses two distinct names together.
//   - Strip control chars and any stray `/` (the lone structural char) as
//     safety — these can't appear in a legitimately typed link.
//   - Cap at 64 chars (truncate); empty/whitespace -> the default room.
// There is no "invalid name" error path: a name is either usable as-is or folds
// to the default. Room names are only ever used as in-memory Map keys + display
// text, so arbitrary (capped) strings are safe.

// The room you land in at `/` (no name in the URL). Named rooms come from
// `/room/<name>`; an empty/garbage name collapses to this shared default.
export const DEFAULT_ROOM = "main";

const MAX_ROOM_NAME_LENGTH = 64;

export function sanitizeRoomName(raw) {
  // `?? ""` (not `|| ""`) so only null/undefined fold to empty — a valid falsy
  // value like the number 0 stays the room name "0" rather than the default.
  const cleaned = String(raw ?? "")
    .toLowerCase()
    // Drop the only structural char (`/`) and non-printable control chars; keep
    // everything else verbatim so distinct names stay distinct.
    .replace(/[\u0000-\u001f\u007f/]/g, "")
    .trim()
    .slice(0, MAX_ROOM_NAME_LENGTH);
  return cleaned || DEFAULT_ROOM;
}
