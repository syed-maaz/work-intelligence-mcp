/**
 * v102 — fetch_runs (ADR-044 S2.6 fetch telemetry, 2026-07-17).
 *
 * # Why
 *
 * The fetcher orchestrator (src/fetcher/orchestrator.ts) already produces a
 * per-source `FetchProgress` result envelope — {source, status, count,
 * durationMs, note} — for every fetch. Today that envelope is logged to stderr
 * and thrown away. Nothing persists it, so a source that times out, errors, or
 * silently returns 0 rows never surfaces anywhere queryable. This is the exact
 * failure mode that let Jira go 47 days stale unnoticed while /api/sync/status
 * still reported running:true (see .planning + project_jira_mcp_and_telemetry_gap).
 *
 * # Shape — one row per source per fetch attempt
 *
 * Append-only ledger. Each fetch attempt (email today; Teams/Jira/etc. as they
 * move onto the orchestrator in S3–S5) writes one row with the envelope fields
 * plus a wall-clock timestamp. `status` mirrors FetchStatus ('ok'|'timed_out'|
 * 'error'). `note` carries the timeout budget or the error's first line.
 * `trigger` records what kicked the fetch ('sync'|'manual'|'watcher') so a
 * background-cron stall can be told apart from a user-triggered one.
 *
 * # Read path
 *
 * GET /api/sync/telemetry reads the latest N rows (and a per-source rollup) so
 * a human or the /system-health surface can see "email: ok 3s ago; jira: never
 * fetched" at a glance. Non-ok rows are ALSO routed to captureBug() at write
 * time so a silent failure becomes a /bugs row.
 *
 * # Idempotency
 *
 * `CREATE TABLE IF NOT EXISTS` — re-running is a no-op. Pure synchronous DDL,
 * matching v98_prompt_memory / v101_doc_embeddings.
 *
 * See:
 *   - src/fetcher/orchestrator.ts (FetchProgress result envelope)
 *   - src/db/queries/fetch-runs.ts (recordFetchRun + readFetchTelemetry)
 *   - web-server.js runEmailSync (first writer) + GET /api/sync/telemetry (reader)
 */

import type Database from 'better-sqlite3';

export default function migrateV102(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fetch_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('ok', 'timed_out', 'error')),
      count       INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      note        TEXT,
      trigger     TEXT NOT NULL DEFAULT 'sync',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fetch_runs_source_time
      ON fetch_runs (source, created_at DESC);
  `);
}
