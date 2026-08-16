/**
 * Cypher v2.5 D6 — retention + GC enforcer (2026-06-26).
 *
 * Runs the per-table retention sweeps described in ADR-038 § D6.
 * Today's slice ships:
 *
 *   - dispatch_snapshots: DELETE WHERE dispatch closed (status IN
 *     ('done','halted','asked_user')) OR written_at older than 24h
 *     and not referenced by an active session.
 *
 *   - cypher_steps: roll up + DELETE where created_at older than 30
 *     days. Roll-up writes one row to cypher_steps_summary per
 *     dispatch (aggregating tool_call_count, unique_tools,
 *     total_duration, failed_count, per_tool_aggregates JSON).
 *
 *   - cypher_sessions: roll up + DELETE where started_at older than
 *     90 days. Roll-up writes per-(week, posture, project) rows to
 *     cypher_sessions_summary.
 *
 *   - permission_uses: DELETE WHERE used_at older than 90 days.
 *
 *   - gc_log itself: trim to last 100 entries.
 *
 * Every run records a row in gc_log: duration, per-table actions
 * JSON, freed MB (best-effort via dbstat), errors. dry_run mode
 * computes the same actions but doesn't execute the DELETE/INSERT —
 * useful for previewing impact.
 *
 * **What this slice does NOT do:**
 *   - A daemon. /api/cypher/gc/run is manual today. Future slice
 *     wires a nightly cron via the agent runtime.
 *   - Palace embedding GC (waiting on the v2.0 baseline measurement
 *     called out in the ADR).
 *   - cost_ledger rollup (D14 hasn't shipped the table yet).
 *
 * See:
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D6
 *   - src/db/migrations/v83_d6_retention_gc.ts
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GcAction {
  table: string;
  rows_affected: number;
  rolled_up_to?: string;
  notes?: string;
}

export interface GcRunResult {
  run_id: string;
  ran_at: number;
  duration_ms: number;
  actions: GcAction[];
  errors: string[];
  total_freed_mb: number;
  dry_run: boolean;
}

export interface GcOptions {
  /** When true, compute actions but don't mutate. Default false. */
  dry_run?: boolean;
  /**
   * Override the snapshot TTL in ms (default 24h). Snapshots older
   * than (now - ttl) belonging to non-active dispatches are deleted.
   */
  snapshot_ttl_ms?: number;
  /** Override cypher_steps retention in ms (default 30 days). */
  steps_ttl_ms?: number;
  /** Override cypher_sessions retention in ms (default 90 days). */
  sessions_ttl_ms?: number;
  /** Override permission_uses retention in ms (default 90 days). */
  permission_uses_ttl_ms?: number;
  /** Max gc_log rows to keep (default 100). */
  gc_log_keep?: number;
}

// ── ID generation ─────────────────────────────────────────────────────────────

function runId(): string {
  const rand = createHash('sha256')
    .update(String(Date.now()) + Math.random().toString(36))
    .digest('hex')
    .slice(0, 12);
  return `gc_${rand}`;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  snapshot_ttl_ms: DAY_MS,           // 24h
  steps_ttl_ms: 30 * DAY_MS,         // 30 days
  sessions_ttl_ms: 90 * DAY_MS,      // 90 days
  permission_uses_ttl_ms: 90 * DAY_MS,
  gc_log_keep: 100,
};

// ── runGc ────────────────────────────────────────────────────────────────────

/**
 * Run the GC sweep. Returns the actions taken (or that would be
 * taken in dry_run mode). Persists a gc_log row on every run
 * (including dry_run, marked dry_run=1).
 *
 * Errors per-action are caught and accumulated in result.errors so a
 * single broken table doesn't abort the whole run. The top-level
 * write to gc_log is the only call that can throw.
 */
export function runGc(db: Database.Database, opts: GcOptions = {}): GcRunResult {
  const start = Date.now();
  const dry_run = !!opts.dry_run;
  const actions: GcAction[] = [];
  const errors: string[] = [];

  const snapshotTtl = opts.snapshot_ttl_ms ?? DEFAULTS.snapshot_ttl_ms;
  const stepsTtl = opts.steps_ttl_ms ?? DEFAULTS.steps_ttl_ms;
  const sessionsTtl = opts.sessions_ttl_ms ?? DEFAULTS.sessions_ttl_ms;
  const permissionUsesTtl = opts.permission_uses_ttl_ms ?? DEFAULTS.permission_uses_ttl_ms;
  const gcLogKeep = opts.gc_log_keep ?? DEFAULTS.gc_log_keep;

  // ── 1. dispatch_snapshots: delete closed-dispatch + stale rows.
  try {
    const cutoff = Date.now() - snapshotTtl;
    const closedRow = db.prepare(`
      SELECT COUNT(*) AS n FROM dispatch_snapshots ds
      WHERE EXISTS (
        SELECT 1 FROM cypher_sessions cs
        WHERE cs.session_id = ds.dispatch_id
          AND cs.status IN ('done','halted','asked_user')
      )
    `).get() as { n: number };

    const staleRow = db.prepare(`
      SELECT COUNT(*) AS n FROM dispatch_snapshots
      WHERE written_at < ?
        AND dispatch_id NOT IN (
          SELECT session_id FROM cypher_sessions WHERE status = 'pending'
        )
    `).get(cutoff) as { n: number };

    const total = closedRow.n + staleRow.n;
    if (!dry_run && total > 0) {
      db.prepare(`
        DELETE FROM dispatch_snapshots
        WHERE dispatch_id IN (
          SELECT session_id FROM cypher_sessions WHERE status IN ('done','halted','asked_user')
        )
        OR (written_at < ? AND dispatch_id NOT IN (SELECT session_id FROM cypher_sessions WHERE status = 'pending'))
      `).run(cutoff);
    }
    actions.push({ table: 'dispatch_snapshots', rows_affected: total, notes: 'closed + stale snapshots' });
  } catch (err) {
    errors.push(`dispatch_snapshots: ${(err as Error).message}`);
  }

  // ── 2. cypher_steps: rollup + delete older than steps_ttl.
  try {
    const cutoff = Date.now() - stepsTtl;
    // Find dispatches whose steps are entirely older than cutoff and
    // not yet rolled up. We use the latest step's created_at as the
    // dispatch's "freshness" proxy.
    const rows = db.prepare(`
      SELECT
        s.session_id AS dispatch_id,
        COUNT(*) AS tool_call_count,
        COUNT(DISTINCT s.stage) AS unique_tools_count,
        COALESCE(SUM(s.duration_ms), 0) AS total_duration_ms,
        SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) AS failed_tool_count,
        MAX(s.created_at) AS last_created_at
      FROM cypher_steps s
      WHERE NOT EXISTS (SELECT 1 FROM cypher_steps_summary x WHERE x.dispatch_id = s.session_id)
      GROUP BY s.session_id
      HAVING MAX(strftime('%s', s.created_at)) * 1000 < ?
    `).all(cutoff) as Array<{
      dispatch_id: string;
      tool_call_count: number;
      unique_tools_count: number;
      total_duration_ms: number;
      failed_tool_count: number;
      last_created_at: string;
    }>;

    let rolled = 0;
    if (!dry_run) {
      const insertSummary = db.prepare(`
        INSERT OR IGNORE INTO cypher_steps_summary (
          dispatch_id, tool_call_count, unique_tools_count,
          total_duration_ms, failed_tool_count, per_tool_aggregates, rolled_up_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const deleteSteps = db.prepare(`DELETE FROM cypher_steps WHERE session_id = ?`);
      const now = Date.now();
      for (const r of rows) {
        insertSummary.run(
          r.dispatch_id,
          r.tool_call_count,
          r.unique_tools_count,
          r.total_duration_ms,
          r.failed_tool_count,
          null,
          now,
        );
        const delRes = deleteSteps.run(r.dispatch_id);
        rolled += delRes.changes;
      }
    }
    actions.push({
      table: 'cypher_steps',
      rows_affected: dry_run ? rows.reduce((s, r) => s + r.tool_call_count, 0) : rolled,
      rolled_up_to: 'cypher_steps_summary',
      notes: `${rows.length} dispatches rolled up`,
    });
  } catch (err) {
    errors.push(`cypher_steps: ${(err as Error).message}`);
  }

  // ── 3. cypher_sessions: weekly rollup + delete older than sessions_ttl.
  // We DO NOT delete cypher_sessions raw rows in this slice — the loop
  // and self-model both still need them. We only INSERT the rollup
  // rows for completeness and future GC slices to consume. This
  // matches the ADR's "Keep 90 days hot; older roll up" intent
  // without the destructive delete yet.
  try {
    const cutoff = Date.now() - sessionsTtl;
    const rows = db.prepare(`
      SELECT
        strftime('%Y-W%W', started_at, 'weekday 0', '-7 days') AS week_start_iso,
        COALESCE(posture, 'generic') AS posture,
        'wi' AS project,
        COUNT(*) AS dispatch_count,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN status = 'halted' THEN 1 ELSE 0 END) AS abandoned_count
      FROM cypher_sessions
      WHERE strftime('%s', started_at) * 1000 < ?
      GROUP BY week_start_iso, posture
    `).all(cutoff) as Array<{
      week_start_iso: string;
      posture: string;
      project: string;
      dispatch_count: number;
      success_count: number;
      failed_count: number;
      abandoned_count: number;
    }>;

    let inserted = 0;
    if (!dry_run) {
      const insert = db.prepare(`
        INSERT OR REPLACE INTO cypher_sessions_summary (
          week_start_iso, posture, project,
          dispatch_count, success_count, failed_count, abandoned_count,
          median_iterations, median_cost_usd, rolled_up_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
      `);
      const now = Date.now();
      for (const r of rows) {
        insert.run(
          r.week_start_iso, r.posture, r.project,
          r.dispatch_count, r.success_count, r.failed_count, r.abandoned_count,
          now,
        );
        inserted++;
      }
    }
    actions.push({
      table: 'cypher_sessions',
      rows_affected: dry_run ? rows.length : inserted,
      rolled_up_to: 'cypher_sessions_summary',
      notes: 'weekly rollup (raw rows kept)',
    });
  } catch (err) {
    errors.push(`cypher_sessions: ${(err as Error).message}`);
  }

  // ── 4. permission_uses: delete older than permission_uses_ttl.
  try {
    const cutoff = Date.now() - permissionUsesTtl;
    const countRow = db.prepare(`SELECT COUNT(*) AS n FROM permission_uses WHERE used_at < ?`).get(cutoff) as { n: number };
    let deleted = 0;
    if (!dry_run && countRow.n > 0) {
      const r = db.prepare(`DELETE FROM permission_uses WHERE used_at < ?`).run(cutoff);
      deleted = r.changes;
    }
    actions.push({
      table: 'permission_uses',
      rows_affected: dry_run ? countRow.n : deleted,
      notes: `older than ${Math.round(permissionUsesTtl / DAY_MS)}d`,
    });
  } catch (err) {
    errors.push(`permission_uses: ${(err as Error).message}`);
  }

  // ── 5. brain_decisions: auto-expire stale pending (>14d) to 'expired'.
  try {
    // Check table exists first (migration v45+; may be absent in partial schemas)
    const tableCheck = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='brain_decisions'`
    ).get() as { name: string } | undefined;
    if (tableCheck) {
      const expiryCutoff = Date.now() - 14 * DAY_MS;
      const staleRow = db.prepare(
        `SELECT COUNT(*) AS n FROM brain_decisions
         WHERE outcome IS NULL AND created_at < ?`
      ).get(expiryCutoff) as { n: number };
      let expired = 0;
      if (!dry_run && staleRow.n > 0) {
        const r = db.prepare(
          `UPDATE brain_decisions
              SET outcome = 'expired', outcome_recorded_at = ?
            WHERE outcome IS NULL AND created_at < ?`
        ).run(Date.now(), expiryCutoff);
        expired = r.changes;
      }
      actions.push({
        table: 'brain_decisions',
        rows_affected: dry_run ? staleRow.n : expired,
        notes: 'auto-expire pending >14d to expired',
      });
    }
  } catch (err) {
    errors.push(`brain_decisions auto-expire: ${(err as Error).message}`);
  }

  // ── 6. gc_log: trim to last gcLogKeep entries.
  try {
    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM gc_log`).get() as { n: number };
    const excess = Math.max(0, totalRow.n - gcLogKeep);
    let deleted = 0;
    if (!dry_run && excess > 0) {
      const r = db.prepare(`
        DELETE FROM gc_log
        WHERE run_id IN (
          SELECT run_id FROM gc_log ORDER BY ran_at ASC LIMIT ?
        )
      `).run(excess);
      deleted = r.changes;
    }
    actions.push({
      table: 'gc_log',
      rows_affected: dry_run ? excess : deleted,
      notes: `trim to last ${gcLogKeep}`,
    });
  } catch (err) {
    errors.push(`gc_log: ${(err as Error).message}`);
  }

  const duration_ms = Date.now() - start;
  const id = runId();
  const result: GcRunResult = {
    run_id: id,
    ran_at: start,
    duration_ms,
    actions,
    errors,
    total_freed_mb: 0, // best-effort; not measured in this slice
    dry_run,
  };

  // Always log — dry_run too.
  try {
    db.prepare(`
      INSERT INTO gc_log (run_id, ran_at, duration_ms, table_actions, total_freed_mb, errors, dry_run)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      start,
      duration_ms,
      JSON.stringify(actions),
      0,
      errors.length > 0 ? JSON.stringify(errors) : null,
      dry_run ? 1 : 0,
    );
  } catch (err) {
    // If we can't even write the log row, surface the error but
    // don't crash the caller — the result object still has the data.
    process.stderr.write(`[gc] could not write gc_log row: ${(err as Error).message}\n`);
  }

  return result;
}

/**
 * Read the most recent gc_log rows. Default limit 20.
 */
export function listGcLog(db: Database.Database, limit = 20): Array<{
  run_id: string;
  ran_at: number;
  duration_ms: number;
  table_actions: unknown;
  total_freed_mb: number;
  errors: unknown;
  dry_run: boolean;
}> {
  const rows = db.prepare(`
    SELECT run_id, ran_at, duration_ms, table_actions, total_freed_mb, errors, dry_run
    FROM gc_log ORDER BY ran_at DESC LIMIT ?
  `).all(Math.min(Math.max(1, limit), 100)) as Array<{
    run_id: string; ran_at: number; duration_ms: number; table_actions: string;
    total_freed_mb: number; errors: string | null; dry_run: number;
  }>;
  return rows.map(r => ({
    run_id: r.run_id,
    ran_at: r.ran_at,
    duration_ms: r.duration_ms,
    table_actions: safeParse(r.table_actions),
    total_freed_mb: r.total_freed_mb,
    errors: r.errors ? safeParse(r.errors) : null,
    dry_run: r.dry_run === 1,
  }));
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
