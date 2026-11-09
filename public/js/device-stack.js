// Device stack — the user's explicit device picks, most-recent-first.
//
// The model has two halves that must not be confused:
//
//   * the **stack** is intent. It is written ONLY when the user actively picks a
//     mic / camera / speaker. Nothing else ever writes to it — not a fallback,
//     not a rematch, not an auto-selection.
//   * the **active** device is whatever is live right now, which may be a lower
//     stack entry (or an unconstrained capture) while the top pick is away.
//
// Resolution walks the stack top-down and returns the first entry that is
// present and usable. It is a pure read: resolving never mutates the stack, so a
// wrong guess costs one session instead of destroying the entry.
//
// An entry is either the "follow the OS default" sentinel `{ system: true }` or a
// concrete `{ deviceId, label }`. Only those two fields are persisted, and that
// is deliberate: `deviceId` is an HMAC over a persistent per-origin salt so it
// survives reloads, but `groupId` is salted per *document* and is regenerated on
// every page load — a stored groupId can never match again. groupId is still
// useful for a replug *within* one page load, so callers pass it in as session
// state via `groupIdFor` rather than persisting it.

/** Matches HISTORY_CAP in room-history.js — same move-to-front-and-cap shape. */
export const STACK_CAP = 10;

/** The `<select>` / menu value that means "follow the OS default", per kind. */
export const SYSTEM_VALUE = { mic: "default", speaker: "" };

/**
 * Kinds that have an OS-level default the user can change. Cameras do not: no
 * platform exposes a "default camera" setting, so a sentinel there would never
 * differ meaningfully from "the first camera".
 */
export function kindHasSystemEntry(kind) {
  return kind === "mic" || kind === "speaker";
}

export function isSystemEntry(entry) {
  return !!entry && entry.system === true;
}

/** Is this UI value the kind's "follow the OS default" sentinel? */
export function isSystemValue(kind, value) {
  return kindHasSystemEntry(kind) && value === SYSTEM_VALUE[kind];
}

/** Build a stack entry from a `<select>` / menu value plus the live device. */
export function entryFromValue(kind, value, device = null) {
  if (isSystemValue(kind, value)) return { system: true };
  return {
    deviceId: typeof value === "string" ? value : "",
    label: normLabel(device?.label),
  };
}

/** The UI value that represents this entry (inverse of entryFromValue). */
export function valueFromEntry(kind, entry) {
  if (isSystemEntry(entry)) return SYSTEM_VALUE[kind] ?? "";
  return entry?.deviceId || "";
}

/** Stable key for session-scoped side tables (groupIds, unusable set). */
export function entryKey(kind, entry) {
  return isSystemEntry(entry) ? `${kind}:@system` : `${kind}:${entry?.deviceId ?? ""}`;
}

export function sameEntry(a, b) {
  if (isSystemEntry(a) || isSystemEntry(b)) {
    return isSystemEntry(a) && isSystemEntry(b);
  }
  return !!a?.deviceId && a.deviceId === b?.deviceId;
}

/** Tolerant read: anything unparseable folds to an empty stack. */
export function parseStack(raw) {
  if (typeof raw !== "string" || !raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    if (item.system === true) {
      if (!out.some(isSystemEntry)) out.push({ system: true });
      continue;
    }
    if (typeof item.deviceId !== "string" || !item.deviceId) continue;
    if (out.some((e) => !isSystemEntry(e) && e.deviceId === item.deviceId)) continue;
    out.push({ deviceId: item.deviceId, label: normLabel(item.label) });
  }
  return enforceInvariants(out);
}

export function serializeStack(stack) {
  return JSON.stringify(
    (Array.isArray(stack) ? stack : []).map((e) =>
      isSystemEntry(e) ? { system: true } : { deviceId: e.deviceId, label: normLabel(e.label) },
    ),
  );
}

/**
 * Record an explicit pick: move it to the front, dedupe, then re-assert the
 * invariants. The only mutation of a stack in the whole app.
 */
export function pushPick(stack, entry, cap = STACK_CAP) {
  const list = Array.isArray(stack) ? stack : [];
  return enforceInvariants([entry, ...list.filter((e) => !sameEntry(e, entry))], cap);
}

/**
 * The sentinel always resolves, so anything below it can never be consulted.
 * Drop that dead tail rather than storing state that provably cannot affect
 * behavior, which keeps one invariant to reason about: the system entry is
 * either absent or last.
 */
function enforceInvariants(stack, cap = STACK_CAP) {
  const systemAt = stack.findIndex(isSystemEntry);
  const pruned = systemAt === -1 ? stack : stack.slice(0, systemAt + 1);
  return pruned.slice(0, cap);
}

/**
 * Find the live device for one concrete entry: exact deviceId, then this
 * session's groupId, then label. The group and label tiers must be
 * *unambiguous* — two present devices sharing a label (twin webcams, two
 * "USB Audio Device"s) is a coin flip we refuse to make, because a wrong guess
 * means capturing the wrong hardware silently.
 */
export function matchEntry(devices, entry, sessionGroupId = "") {
  if (isSystemEntry(entry) || !entry?.deviceId) return null;
  const list = Array.isArray(devices) ? devices : [];
  const exact = list.find((d) => d.deviceId === entry.deviceId);
  if (exact) return exact;
  if (sessionGroupId) {
    const byGroup = list.filter((d) => d.groupId && d.groupId === sessionGroupId);
    if (byGroup.length === 1) return byGroup[0];
  }
  const want = normLabel(entry.label);
  if (want) {
    const byLabel = list.filter((d) => normLabel(d.label) === want);
    if (byLabel.length === 1) return byLabel[0];
  }
  return null;
}

/**
 * Walk the stack for the device that should be live.
 *
 * `isUnusable` is asked about the *resolved device*, not the entry, and only
 * after the entry has been matched to live hardware. Refusing to open is a fact
 * about one physical device, while an entry is a description that can point at
 * a different device than it did last time (a `deviceId` churns, and the entry
 * then rematches by group or label). Judging the entry instead would let one
 * failed capture on a stale id disqualify the pick permanently, which is exactly
 * the case the group/label tiers exist to recover from.
 *
 * @returns {{entry: object, device: object|null}|null} the winning entry (with
 *   `device: null` for the sentinel, which has no concrete device), or null when
 *   nothing on the stack resolved — callers then leave capture unconstrained.
 */
export function resolveStack(stack, devices, { groupIdFor, isUnusable } = {}) {
  for (const entry of Array.isArray(stack) ? stack : []) {
    // The sentinel cannot be absent and cannot be walked past: unconstrained
    // capture is the terminal fallback, so there is nothing below it to try.
    if (isSystemEntry(entry)) return { entry, device: null };
    const device = matchEntry(devices, entry, groupIdFor?.(entry) || "");
    if (!device || isUnusable?.(device)) continue;
    return { entry, device };
  }
  return null;
}

/** groupId of the virtual `default` entry for a kind, or "" when absent. */
export function systemDefaultGroupId(rawDevices, kind) {
  const sys = (Array.isArray(rawDevices) ? rawDevices : []).find(
    (d) => d.kind === kind && d.deviceId === "default",
  );
  return typeof sys?.groupId === "string" ? sys.groupId : "";
}

/**
 * Has the OS default moved out from under a live capture?
 *
 * A track opened on the virtual `default` device does NOT follow a later OS
 * default change — it keeps the device it was granted (see the AWS Chime and
 * Twilio findings in docs). The drift is detectable because `getSettings()`
 * exposes `groupId` from the same document salt as `enumerateDevices`, so the
 * live track's groupId can be compared against the current `default` entry's.
 */
export function systemDefaultDrifted(trackSettings, rawDevices, kind) {
  const want = systemDefaultGroupId(rawDevices, kind);
  const have = trackSettings?.groupId;
  if (!want || typeof have !== "string" || !have) return false;
  return want !== have;
}

function normLabel(label) {
  return typeof label === "string" ? label.trim() : "";
}
