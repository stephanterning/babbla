// Room history — the small bit of client persistence behind the room chooser.
//
// Stores (localStorage) the canonical names of rooms you've actually been in,
// most-recent-first, deduped, capped. Drives the chooser's dropdown and its
// "preselect the last room" behaviour, and persists across sessions so the list
// is there next visit.
//
// (There is no join-intent handoff: the app navigates between rooms in-app via
// history.pushState — no reload — so nothing needs to be carried across a page
// load. See .cursor/plans/spa-room-chooser.md.)
//
// Best-effort: storage access can throw (private mode / blocked storage), so
// every call is guarded and falls back to an empty result rather than crashing
// the join flow.

export const HISTORY_KEY = "babbla:roomHistory";
export const HISTORY_CAP = 10;

function getLocal() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/**
 * The remembered rooms, most-recent-first. Always a clean array of non-empty
 * strings, capped at HISTORY_CAP — garbage in storage folds to [].
 * @param {Storage | null | undefined} [storage]
 * @returns {string[]}
 */
export function readRoomHistory(storage = getLocal()) {
  if (!storage) return [];
  let raw;
  try {
    raw = storage.getItem(HISTORY_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const cleaned = [];
  for (const x of arr) {
    if (typeof x === "string" && x && !cleaned.includes(x)) cleaned.push(x);
    if (cleaned.length >= HISTORY_CAP) break;
  }
  return cleaned;
}

/**
 * Record a visit: move `name` to the front (dedup), cap the list, persist.
 * No-op for an empty name. Returns the new list (useful for tests / callers).
 * @param {string} name canonical room name
 * @param {Storage | null | undefined} [storage]
 * @returns {string[]}
 */
export function recordRoomVisit(name, storage = getLocal()) {
  const list = readRoomHistory(storage);
  if (!name) return list;
  const next = [name, ...list.filter((r) => r !== name)].slice(0, HISTORY_CAP);
  if (storage) {
    try {
      storage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {}
  }
  return next;
}
