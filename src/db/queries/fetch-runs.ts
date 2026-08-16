/**
 * ADR-044 S2.6 — fetch telemetry queries.
 *
 * recordFetchRun() persists one row of the orchestrator's FetchProgress result
 * envelope per source per fetch attempt. readFetchTelemetry() returns the recent
 * ledger plus a per-source rollup (last status + when + how many) so a stalled
 * or silently-empty source is visible at a glance — the gap that let Jira go
 * 47 days stale while /api/sync/status still said running:true.
 */

import type Database from 'better-sqlite3';

export type FetchRunStatus = 'ok' | 'timed_out' | 'error';

export interface FetchRunInput {
  source: string;
  status: FetchRunStatus;
  count: number;
  durationMs: number;
  note?: string | null;
  /** What kicked the fetch — 'sync' | 'manual' | 'watcher'. Default 'sync'. */
  trigger?: string;
}

export interface FetchRunRow {
  id: number;
  source: string;
  status: FetchRunStatus;
  count: number;
  duration_ms: number;
  note: string | null;
  trigger: string;
  created_at: string;
}

/** Per-source rollup: the most recent run for each source. */
export interface FetchSourceRollup {
  source: string;
  last_status: FetchRunStatus;
  last_count: number;
  last_duration_ms: number;
  last_note: string | null;
  last_run_at: string;
  total_runs: number;
}

/**
 * Append one telemetry row for a completed fetch attempt. Never throws on a
 * bad note — the row is best-effort telemetry, not a hard dependency of the
 * fetch itself.
 * @returns the new row id
 */
export function recordFetchRun(db: Database.Database, input: FetchRunInput): number {
  const info = db
    .prepare(
      `INSERT INTO fetch_runs (source, status, count, duration_ms, note, trigger)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.source,
      input.status,
      input.count | 0,
      input.durationMs | 0,
      input.note ?? null,
      input.trigger ?? 'sync',
    );
  return Number(info.lastInsertRowid);
}

/**
 * Read the recent fetch ledger + a per-source rollup.
 * @param limit max recent rows to return (default 50)
 */
export function readFetchTelemetry(
  db: Database.Database,
  limit = 50,
): { recent: FetchRunRow[]; rollup: FetchSourceRollup[] } {
  const recent = db
    .prepare(`SELECT * FROM fetch_runs ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(limit) as FetchRunRow[];

  // Per-source rollup: newest row per source (via a correlated max(id)) + count.
  const rollup = db
    .prepare(
      `SELECT r.source        AS source,
              r.status        AS last_status,
              r.count         AS last_count,
              r.duration_ms   AS last_duration_ms,
              r.note          AS last_note,
              r.created_at    AS last_run_at,
              (SELECT COUNT(*) FROM fetch_runs c WHERE c.source = r.source) AS total_runs
         FROM fetch_runs r
         JOIN (SELECT source, MAX(id) AS max_id FROM fetch_runs GROUP BY source) m
           ON r.id = m.max_id
        ORDER BY r.source`,
    )
    .all() as FetchSourceRollup[];

  return { recent, rollup };
}
