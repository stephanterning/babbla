// SQLite store for the stats event log. Uses the built-in `node:sqlite`
// (DatabaseSync) so there's no new npm dependency — see
// .cursor/plans/stats-poc.md (driver-not). Append-only `events` table; every
// metric is derived at read time, so there are NO rollup/summary tables and no
// mutable "open session" table — the log is the single source of truth (the
// deploy-resilient session resume re-derives open sessions from it at startup).
//
// The module is intentionally thin: open + schema + a batched insert + a couple
// of read helpers. All decoration/aggregation lives in the pure modules
// (recorder/sessions/derive/aggregate) so this stays trivially swappable.

import { DatabaseSync } from "node:sqlite";

// Column order is the contract between insert() and the prepared statement.
export const EVENT_COLUMNS = [
  "ts",
  "type",
  "room_hash",
  "room_session_id",
  "actor_client_id",
  "actor_conn_id",
  "target_client_id",
  "payload",
  "asn",
  "asn_org",
  "country",
  "ua_browser",
  "ua_version_major",
  "ua_os",
  "is_ios",
  "is_chromium",
  "build_version",
  "env",
];

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  room_hash TEXT,
  room_session_id TEXT,
  actor_client_id TEXT,
  actor_conn_id TEXT,
  target_client_id TEXT,
  payload TEXT,
  asn INTEGER,
  asn_org TEXT,
  country TEXT,
  ua_browser TEXT,
  ua_version_major TEXT,
  ua_os TEXT,
  is_ios INTEGER,
  is_chromium INTEGER,
  build_version TEXT,
  env TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(room_session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`;

/**
 * @param {string} path file path or ":memory:"
 * @returns {{
 *   insert: (rows: object[]) => void,
 *   all: (sql: string, params?: any[]) => any[],
 *   deleteOlderThan: (ts: number) => number,
 *   close: () => void,
 *   db: DatabaseSync,
 * }}
 */
export function openStatsDb(path) {
  const db = new DatabaseSync(path);
  // WAL keeps reads (the /stats dashboard) from blocking the writer, and
  // survives a hard kill better than the rollback journal. No-op for :memory:.
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {}
  db.exec(CREATE_SQL);

  const placeholders = EVENT_COLUMNS.map(() => "?").join(", ");
  const insertStmt = db.prepare(
    `INSERT INTO events (${EVENT_COLUMNS.join(", ")}) VALUES (${placeholders})`,
  );
  const deleteStmt = db.prepare("DELETE FROM events WHERE ts < ?");

  // Batched insert inside one transaction. A single failed row must not poison
  // the rest, but at this scale the simplest robust thing is all-or-nothing per
  // flush with the whole call guarded by the caller (recorder) try/catch.
  function insert(rows) {
    if (!rows.length) return;
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        insertStmt.run(...EVENT_COLUMNS.map((c) => normalize(row[c])));
      }
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }

  function all(sql, params = []) {
    return db.prepare(sql).all(...params);
  }

  function deleteOlderThan(ts) {
    const info = deleteStmt.run(ts);
    return Number(info.changes || 0);
  }

  function close() {
    try {
      db.close();
    } catch {}
  }

  return { insert, all, deleteOlderThan, close, db };
}

// node:sqlite accepts null/number/bigint/string/Uint8Array. Coerce booleans and
// undefined; everything else passes through. Objects should already be
// JSON.stringified by the caller (payload), but stringify defensively.
function normalize(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}
