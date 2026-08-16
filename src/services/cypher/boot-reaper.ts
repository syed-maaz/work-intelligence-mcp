/**
 * Cypher v2.5 D7 — bridge boot snapshot reaper (2026-06-26).
 *
 * Runs once at bridge startup. Finds dispatches that were
 * mid-flight when the previous bridge process died
 * (status='pending' + a row in dispatch_snapshots) and marks them
 * as halted/abandoned. The snapshot rows themselves are then deleted.
 *
 * **G5 extension 2026-07-13 (post-audit).** The original reaper only
 * catches sessions with `dispatch_snapshots` rows — sessions that
 * pended WITHOUT ever writing a snapshot (e.g. crashed before the
 * first snapshot flush, or dispatched via a path that skips the
 * snapshotter) leak past forever. As of the 2026-07-13 audit: 87
 * pending sessions accumulated since 2026-07-10, ALL orphaned
 * (0 dispatch_snapshots rows). Also 82 asked_user + 40 halted stuck
 * with `started_at=2` epoch-zero timestamps from an unrelated bug era.
 *
 * The extension: after the snapshot-based reap, run a second sweep
 * that catches ANY pending session older than `CYPHER_REAPER_MAX_AGE_MS`
 * (default 24h) regardless of snapshot presence. Marks them as
 * `abandoned` with `outcome_note='no_progress_since_bridge_restart'`.
 * Safe because: (a) if a session was making real progress after 24h,
 * a snapshot would have been flushed by D7's periodic writer;
 * (b) 24h is generous — normal Cypher dispatches complete in <5m;
 * (c) if the operator wants to preserve a long-running dispatch, they
 * unset the flag with `CYPHER_REAPER_ORPHAN_SWEEP=0`.
 *
 * **Why "abandoned":** v87 (2026-06-28) widened cypher_sessions.outcome
 * CHECK from 3-value ('success','mixed','failed') to 6-value
 * (+'halted','abandoned','rejected_non_interactive'), matching the
 * cypher_record_outcome tool's input enum. Before v87, the reaper
 * wrote 'mixed' because that was the only non-failure label the
 * CHECK admitted — which polluted real 'mixed' verdicts (user
 * marked partially-useful) with crash-orphans. 'abandoned' is the
 * honest semantic for the reaper case ("the dispatch was killed
 * mid-flight by an external event; we don't know what would have
 * happened"). outcome_note='bridge_restart_during_dispatch' still
 * carries the cause for debug. Existing 'mixed' rows written by
 * pre-v87 boots stay valid under the widened set — no data
 * backfill needed.
 *
 * **Why not resume from messages_blob:** v2.5 D7's full scope
 * eventually includes resume — load messages_blob, continue the loop
 * where it left off. But "halted" is the safe minimum for this slice:
 *
 *   - The dispatch may have been mid-confirmation, mid-tool-call,
 *     or otherwise in a state the loop alone can't reconstruct.
 *     Resuming without user awareness could redo destructive work.
 *   - "Halted" preserves the audit trail (the session row stays,
 *     the verdict row stays) without re-running tool calls.
 *   - The user can manually re-dispatch with the same goal if they
 *     want — a one-line copy/paste.
 *
 * Future slices may upgrade to true resume for SAFE dispatches (e.g.
 * read-only postures, or task_class where every tool is tier-1).
 *
 * **No-op when no orphans exist.** Safe to call on every bridge
 * boot. Idempotent — a second call finds zero orphans because the
 * first call cleared them.
 *
 * See:
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D7
 *   - src/services/cypher/loop.ts (dispatch_snapshots writer)
 *   - src/db/migrations/v83_d6_retention_gc.ts (dispatch_snapshots schema)
 *   - .planning/audits/adr-040-followup-audit-2026-07-13.md § G5
 */

import type Database from 'better-sqlite3';

export interface ReapResult {
  /** Total dispatches that were mid-flight at boot. */
  orphans_found: number;
  /** Session IDs that were reaped (for logging). */
  session_ids: string[];
  /** Snapshot rows deleted (should match orphans_found unless a
   *  snapshot existed without a pending session). */
  snapshots_deleted: number;
  /** G5 extension: sessions that leaked past the snapshot-based reap.
   *  These had status='pending' AND age > CYPHER_REAPER_MAX_AGE_MS AND
   *  no dispatch_snapshots row. Marked 'abandoned' via the same shape. */
  orphaned_pending_swept?: number;
}

/**
 * Reap dispatch snapshots left over from a crashed bridge process,
 * plus (G5 extension) any pending sessions older than the max-age
 * threshold that leaked past the snapshot-based reap.
 *
 * Returns the count of reaped dispatches. Caller (typically the
 * bridge startup path) should log the count and pass the result to
 * monitoring. Non-zero values across many boots indicate the bridge
 * is dying mid-dispatch frequently — worth investigating.
 */
export function reapBootOrphans(db: Database.Database): ReapResult {
  const orphans = db.prepare(`
    SELECT cs.session_id
    FROM cypher_sessions cs
    INNER JOIN dispatch_snapshots ds ON ds.dispatch_id = cs.session_id
    WHERE cs.status = 'pending'
  `).all() as Array<{ session_id: string }>;

  const session_ids = orphans.map(o => o.session_id);

  const markStmt = db.prepare(`
    UPDATE cypher_sessions
    SET status = 'halted',
        outcome = 'abandoned',
        outcome_note = COALESCE(outcome_note, 'bridge_restart_during_dispatch'),
        completed_at = COALESCE(completed_at, datetime('now'))
    WHERE session_id = ? AND status = 'pending'
  `);

  const deleteSnapshot = db.prepare(
    `DELETE FROM dispatch_snapshots WHERE dispatch_id = ?`
  );

  let snapshots_deleted = 0;

  if (session_ids.length > 0) {
    db.transaction(() => {
      for (const session_id of session_ids) {
        const delResult = deleteSnapshot.run(session_id);
        snapshots_deleted += delResult.changes;
        markStmt.run(session_id);
      }
    })();
  }

  // G5 extension: sweep orphaned pending sessions with NO snapshot rows.
  // Default-on (this is a bugfix, not a rollout). Kill-switch:
  // CYPHER_REAPER_ORPHAN_SWEEP=0.
  let orphaned_pending_swept = 0;
  if (process.env.CYPHER_REAPER_ORPHAN_SWEEP !== '0') {
    const maxAgeMs = Number(process.env.CYPHER_REAPER_MAX_AGE_MS) || 24 * 60 * 60 * 1000;
    // G5 extension bugfix (2026-07-13, post-restart evidence): the first
    // version of this query used `AND started_at < ?` with a numeric cutoff,
    // assuming `started_at` was integer unix-ms. In reality the column is
    // TEXT and contains BOTH shapes across the DB's history:
    //   - Recent rows: text-encoded unix-ms like "1783598373227.0"
    //     (numeric comparison works — SQLite coerces cleanly)
    //   - Older rows: ISO date strings like "2026-06-26 15:22:46"
    //     (numeric comparison silently returns false — the reason 163
    //      stuck sessions from the pre-2026-07 bug era were NOT swept
    //      after the first f7d762f restart on 2026-07-13)
    //
    // Fix: handle both formats explicitly.
    //   - Text-encoded unix-ms: CAST to INTEGER, compare against `cutoff` (ms).
    //   - ISO date string: julianday() comparison against a 24h-ago julianday.
    // The OR-branch structure keeps both filters cheap; no full-table
    // recompute needed. Sessions whose started_at is garbage (empty, non-
    // parseable) are excluded by both branches — safe default.
    //
    // Detection heuristic for text-encoded unix-ms: value > year-2000-ms
    // (946684800000). This filters out the epoch-2 timestamps (started_at=2)
    // from a separate pre-existing bug that would otherwise be swept
    // aggressively — those need a targeted cleanup, not a boot-time reaper
    // gone rogue.
    const nowMs = Date.now();
    const cutoff = nowMs - maxAgeMs;
    const Y2K_MS = 946684800000; // 2000-01-01 unix ms — safe lower bound for real timestamps
    const orphanSweep = db.prepare(`
      UPDATE cypher_sessions
      SET status = 'halted',
          outcome = 'abandoned',
          outcome_note = COALESCE(outcome_note, 'no_progress_since_bridge_restart_g5_sweep'),
          completed_at = COALESCE(completed_at, datetime('now'))
      WHERE status IN ('pending', 'asked_user')
        AND session_id NOT IN (SELECT dispatch_id FROM dispatch_snapshots)
        AND (
          -- Format 1: text-encoded unix-ms. Sanity-gate on Y2K_MS so we
          -- don't sweep the epoch-2 garbage rows.
          (CAST(started_at AS INTEGER) > ${Y2K_MS}
             AND CAST(started_at AS INTEGER) < ?)
          OR
          -- Format 2: ISO date string like "2026-06-26 15:22:46".
          -- julianday() parses it; a NULL julianday (non-ISO input) makes
          -- the < comparison false, so garbage rows are excluded.
          (started_at LIKE '20__-__-__%'
             AND julianday(started_at) < julianday('now', ?))
        )
    `).run(cutoff, `-${Math.floor(maxAgeMs / 1000)} seconds`);
    orphaned_pending_swept = orphanSweep.changes;
  }

  return {
    orphans_found: orphans.length,
    session_ids,
    snapshots_deleted,
    orphaned_pending_swept,
  };
}
