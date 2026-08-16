/**
 * v83 — ADR-038 v2.5 D6: retention + GC substrate (2026-06-26).
 *
 * Closes Gap 21 — every table that grows unboundedly gets explicit
 * retention. Time-series data rolls up into aggregates. This
 * migration creates the schema; src/services/cypher/gc.ts is the
 * runtime enforcer.
 *
 * **Critical schema separation:** dispatch_snapshots supersedes the
 * proposed "inline messages_blob on cypher_sessions" — keeping the
 * blob inline would bloat year-1 by 2GB+ of overflow pages and slow
 * every query touching cypher_sessions. Separate table now is cheap;
 * retrofitting later is painful.
 *
 * **Four new tables (all additive):**
 *
 *   - dispatch_snapshots: per-iteration message blob for in-progress
 *     dispatches; deleted on dispatch close (success/failed/halted).
 *     The bridge can resume an in-progress dispatch after restart by
 *     re-loading messages_blob.
 *
 *   - cypher_steps_summary: 1 row per closed dispatch summarizing its
 *     tool-call stream. Written when the GC daemon rolls up steps
 *     older than 30 days. Preserves what matters for the self-model
 *     (call_count, unique_tools, duration, failures) but loses
 *     individual call detail.
 *
 *   - cypher_sessions_summary: weekly per-(posture, project) rollup
 *     of dispatch outcomes. Written when GC rolls up cypher_sessions
 *     older than 90 days. Anchor for trend dashboards + supervision.
 *
 *   - gc_log: audit trail of GC runs. Each row carries duration,
 *     per-table actions JSON, freed MB, and any errors encountered.
 *
 * See:
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D6
 *   - src/services/cypher/gc.ts (runtime enforcer)
 */

import type Database from 'better-sqlite3';

export default function migrateV83(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_snapshots (
      dispatch_id    TEXT PRIMARY KEY,
      iter_number    INTEGER NOT NULL,
      messages_blob  TEXT NOT NULL,
      written_at     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS dispatch_snapshots_written_at_idx
      ON dispatch_snapshots(written_at);

    CREATE TABLE IF NOT EXISTS cypher_steps_summary (
      dispatch_id          TEXT PRIMARY KEY,
      tool_call_count      INTEGER NOT NULL,
      unique_tools_count   INTEGER NOT NULL,
      total_duration_ms    INTEGER NOT NULL,
      failed_tool_count    INTEGER NOT NULL,
      per_tool_aggregates  TEXT,
      rolled_up_at         INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cypher_sessions_summary (
      week_start_iso       TEXT NOT NULL,
      posture              TEXT NOT NULL,
      project              TEXT NOT NULL,
      dispatch_count       INTEGER NOT NULL,
      success_count        INTEGER NOT NULL,
      failed_count         INTEGER NOT NULL,
      abandoned_count      INTEGER NOT NULL,
      median_iterations    INTEGER NOT NULL,
      median_cost_usd      REAL NOT NULL DEFAULT 0,
      rolled_up_at         INTEGER NOT NULL,
      PRIMARY KEY (week_start_iso, posture, project)
    );

    CREATE TABLE IF NOT EXISTS gc_log (
      run_id          TEXT PRIMARY KEY,
      ran_at          INTEGER NOT NULL,
      duration_ms     INTEGER NOT NULL,
      table_actions   TEXT NOT NULL,
      total_freed_mb  REAL NOT NULL DEFAULT 0,
      errors          TEXT NULL,
      dry_run         INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS gc_log_ran_at_idx ON gc_log(ran_at DESC);
  `);
}
