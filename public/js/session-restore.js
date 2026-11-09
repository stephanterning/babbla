// Deploy-restore — snapshot session state across a controlled reload when the
// server build changes. See docs/session-restore.md for the full contract and
// the checklist for adding new persisted fields.

export const RESTORE_REASON = "deploy-restore";
export const STORAGE_KEY = "babbla:deploy-restore";
export const SNAPSHOT_TTL_MS = 60_000;

/** @typedef {{
 *   reason: typeof RESTORE_REASON,
 *   buildVersion: string,
 *   roomPath: string,
 *   name: string,
 *   muted: boolean,
 *   videoOptOut: boolean,
 *   dnd: boolean,
 *   cameraOn: boolean,
 *   screenOn: boolean,
 *   micDeviceId: string | null,
 *   cameraDeviceId: string | null,
 *   expiresAt: number,
 *   restoreAttempts: number,
 * }} DeployRestoreSnapshot */

/** Read the build stamp injected by the server into index.html. */
export function getClientBuildVersion() {
  const v = globalThis.__BUILD_VERSION__;
  return typeof v === "string" ? v : "";
}

/**
 * @param {Storage | null | undefined} [storage]
 * @returns {DeployRestoreSnapshot | null}
 */
export function readPendingRestore(storage = getDefaultStorage()) {
  if (!storage) return null;
  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let snap;
  try {
    snap = JSON.parse(raw);
  } catch {
    clearSessionRestore(storage);
    return null;
  }

  if (snap?.reason !== RESTORE_REASON) {
    clearSessionRestore(storage);
    return null;
  }
  if (typeof snap.expiresAt !== "number" || Date.now() > snap.expiresAt) {
    clearSessionRestore(storage);
    return null;
  }
  if (snap.restoreAttempts !== 0) {
    return null;
  }
  if (typeof snap.roomPath !== "string" || typeof snap.name !== "string") {
    clearSessionRestore(storage);
    return null;
  }
  const validated = validateRestoreSnapshot(snap);
  if (!validated) {
    clearSessionRestore(storage);
    return null;
  }
  return validated;
}

/** @param {unknown} snap */
function validateRestoreSnapshot(snap) {
  if (!snap || typeof snap !== "object") return null;
  const s = /** @type {Record<string, unknown>} */ (snap);
  if (s.reason !== RESTORE_REASON) return null;
  if (typeof s.expiresAt !== "number" || Date.now() > s.expiresAt) return null;
  if (s.restoreAttempts !== 0) return null;
  if (typeof s.roomPath !== "string" || typeof s.name !== "string") return null;
  if (typeof s.buildVersion !== "string") return null;
  if (typeof s.muted !== "boolean") return null;
  if (typeof s.videoOptOut !== "boolean") return null;
  // `dnd` was added later; tolerate older snapshots that omit it (default false)
  // rather than rejecting the whole restore.
  if (s.dnd !== undefined && typeof s.dnd !== "boolean") return null;
  if (typeof s.cameraOn !== "boolean") return null;
  if (typeof s.screenOn !== "boolean") return null;
  const micDeviceId = normalizeDeviceId(s.micDeviceId);
  if (micDeviceId === undefined) return null;
  const cameraDeviceId = normalizeDeviceId(s.cameraDeviceId);
  if (cameraDeviceId === undefined) return null;
  /** @type {DeployRestoreSnapshot} */
  return {
    reason: RESTORE_REASON,
    buildVersion: s.buildVersion,
    roomPath: s.roomPath,
    name: s.name,
    muted: s.muted,
    videoOptOut: s.videoOptOut,
    dnd: s.dnd === true,
    cameraOn: s.cameraOn,
    screenOn: s.screenOn,
    micDeviceId,
    cameraDeviceId,
    expiresAt: s.expiresAt,
    restoreAttempts: 0,
  };
}

/** @param {unknown} id */
function normalizeDeviceId(id) {
  if (id === null || id === undefined) return null;
  return typeof id === "string" ? id : undefined;
}

/** @param {string} raw */
function classifyStoredSnapshot(raw) {
  let snap;
  try {
    snap = JSON.parse(raw);
  } catch {
    return "invalid";
  }
  if (snap?.reason !== RESTORE_REASON) return "invalid";
  if (typeof snap.expiresAt !== "number" || Date.now() > snap.expiresAt) {
    return "expired";
  }
  if (snap.restoreAttempts !== 0) return "tombstone";
  return validateRestoreSnapshot(snap) ? "pending" : "invalid";
}

/** @param {Storage | null | undefined} [storage] */
export function clearSessionRestore(storage = getDefaultStorage()) {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {}
}

/**
 * Persist a deploy-restore snapshot before a version-mismatch reload.
 * Returns null when a snapshot is already present (one reload budget exhausted).
 *
 * @param {Omit<DeployRestoreSnapshot, "reason" | "expiresAt" | "restoreAttempts">} state
 * @param {Storage | null | undefined} [storage]
 * @returns {DeployRestoreSnapshot | null}
 */
export function writeDeployRestoreSnapshot(state, storage = getDefaultStorage()) {
  if (!storage) return null;
  try {
    const existing = storage.getItem(STORAGE_KEY);
    if (existing) {
      const kind = classifyStoredSnapshot(existing);
      if (kind === "expired" || kind === "invalid") {
        clearSessionRestore(storage);
      } else if (kind === "pending") {
        // Reload budget exhausted — tombstone so auto-restore won't retry on refresh.
        try {
          const prev = JSON.parse(existing);
          storage.setItem(
            STORAGE_KEY,
            JSON.stringify({ ...prev, restoreAttempts: 1 }),
          );
        } catch {}
        return null;
      } else {
        // Active tombstone — fail closed without another reload.
        return null;
      }
    }
  } catch {
    return null;
  }
  /** @type {DeployRestoreSnapshot} */
  const snap = {
    reason: RESTORE_REASON,
    buildVersion: state.buildVersion,
    roomPath: state.roomPath,
    name: state.name,
    muted: !!state.muted,
    videoOptOut: !!state.videoOptOut,
    dnd: !!state.dnd,
    cameraOn: !!state.cameraOn,
    screenOn: !!state.screenOn,
    micDeviceId: state.micDeviceId || null,
    cameraDeviceId: state.cameraDeviceId || null,
    expiresAt: Date.now() + SNAPSHOT_TTL_MS,
    restoreAttempts: 0,
  };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch {
    return null;
  }
  return snap;
}

/** @param {string} pathname */
export function roomPathFromLocation(pathname = globalThis.location?.pathname ?? "/") {
  return pathname || "/";
}

/** @param {DeployRestoreSnapshot} snap */
export function snapshotMatchesRoom(snap, pathname = globalThis.location?.pathname ?? "/") {
  return snap.roomPath === roomPathFromLocation(pathname);
}

function getDefaultStorage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}
