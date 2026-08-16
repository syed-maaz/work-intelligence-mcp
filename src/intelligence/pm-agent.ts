/**
 * PMAgent — ADR-043 Phase 3 (Shape A), AC-A3.
 *
 * A background tenant that maintains the PM backlog's health signals. It is
 * NOT a worker: it never picks up cards, never dispatches, never mutates
 * intent or kanban_column. It only refreshes derived signals so the backlog
 * the user queries via `/pm next` / `GET /api/board/backlog` stays honest.
 *
 * Ticks every PM_AGENT_INTERVAL_MS (default 30s), mirroring BoardWorkerAgent's
 * cadence. Per tick (all sub-100ms SQLite — never blocks the event loop):
 *
 *   1. RANK REFRESH (observability). rank_score is a *query-time* computation
 *      (ADR-043 § ranker — deliberately not persisted, so weight tuning needs
 *      no migration). The tick recomputes computeBacklogRank() over the open
 *      backlog purely to (a) exercise the ranker so a formula regression
 *      surfaces in the agent health rollup rather than silently at query time,
 *      and (b) return the current top card id in the tick result for
 *      telemetry. It writes nothing for this step.
 *
 *   2. STALL FLAGGING (durable). Cards sitting in `ready` for longer than
 *      PM_STALL_DAYS (default 14) get `stalled=1` + a stalled_reason, reusing
 *      the v97 flag the board UI already renders. This is the only DB write
 *      the agent makes. Idempotent: already-stalled cards are skipped; a card
 *      the user re-touches (last_touched advances) is un-stalled so it can
 *      re-age. Bounded — one UPDATE per qualifying card, capped per tick.
 *
 * Dedup (Q-3, ADR-043) is explicitly DEFERRED — the ADR marks the cosine
 * threshold as "tune from real duplicate observations", and doing embedding
 * math per tick would violate the never-block rule without a worker thread.
 * When it lands it reuses the v98 prompt_memory machinery; the seam is the
 * `runOnce()` step list.
 *
 * Gating (AC-A4): registers ONLY when PM_AGENT_ENABLED=1. Default-off. The
 * tick itself also re-checks the flag so a mid-run flip to 0 makes the next
 * tick a no-op without a restart. Rollback = PM_AGENT_ENABLED=0 + restart.
 */

import type Database from 'better-sqlite3';
import { computeBacklogRank } from '../services/board/ranker.js';

export interface PMAgentOptions {
  db: Database.Database;
  /** Override the 14-day stall window (ms). Injected for tests. */
  stallMs?: number;
  /** Override "now" (ms). Injected for deterministic tests. */
  nowMs?: number;
  /** Max cards to flag stalled per tick (bounded work). Default 50. */
  maxStallPerTick?: number;
}

export interface PMTickResult {
  /** Top backlog card id this tick (null when backlog empty). */
  top_task_id: string | null;
  /** Number of open backlog cards the ranker scored. */
  ranked: number;
  /** Cards newly flagged stalled this tick. */
  stalled_flagged: number;
  /** Cards un-stalled this tick (re-touched since stalling). */
  stalled_cleared: number;
  skipped?: 'disabled' | 'reentrant';
  errors: string[];
}

const DEFAULT_STALL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days (ready column)
// tsk_aa2abe3414c5 — in_progress/e2e stall faster than ready: a worker has
// picked the card up (or it's in verification limbo) but no advance is a
// stall much sooner than an un-picked ready card. Env-tunable in days.
const DEFAULT_IN_PROGRESS_STALL_MS =
  (Number(process.env.PM_STALL_IN_PROGRESS_DAYS) || 3) * 24 * 60 * 60 * 1000;
const DEFAULT_E2E_STALL_MS =
  (Number(process.env.PM_STALL_E2E_DAYS) || 3) * 24 * 60 * 60 * 1000;

/** Kanban columns the stall gate watches, each with its own window. */
type StallColumn = 'ready' | 'in_progress' | 'e2e';

export class PMAgent {
  private db: Database.Database;
  private stallMs: number;
  /** Per-column stall windows (ms). ready = stallMs (test-injectable). */
  private stallWindows: Record<StallColumn, number>;
  private injectedNow: number | undefined;
  private maxStallPerTick: number;
  private inFlight = false;

  constructor(opts: PMAgentOptions) {
    this.db = opts.db;
    this.stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
    // A single injected stallMs (tests) applies to ALL watched columns so the
    // existing ready-column tests keep asserting the value they inject; the
    // per-column production defaults only apply when stallMs is not injected.
    this.stallWindows = {
      ready: this.stallMs,
      in_progress: opts.stallMs ?? DEFAULT_IN_PROGRESS_STALL_MS,
      e2e: opts.stallMs ?? DEFAULT_E2E_STALL_MS,
    };
    this.injectedNow = opts.nowMs;
    this.maxStallPerTick = opts.maxStallPerTick ?? 50;
  }

  private now(): number {
    return this.injectedNow ?? Date.now();
  }

  async tick(): Promise<PMTickResult> {
    if (process.env.PM_AGENT_ENABLED !== '1') {
      return this.empty('disabled');
    }
    if (this.inFlight) return this.empty('reentrant');
    this.inFlight = true;
    try {
      return this.runOnce();
    } finally {
      this.inFlight = false;
    }
  }

  /** Synchronous — all steps are SQLite; no LLM, no network, no await. */
  private runOnce(): PMTickResult {
    const result: PMTickResult = {
      top_task_id: null,
      ranked: 0,
      stalled_flagged: 0,
      stalled_cleared: 0,
      errors: [],
    };
    const now = this.now();

    // 1. Rank refresh (observability only — no write).
    try {
      const backlog = computeBacklogRank(this.db, { nowMs: now, scope: 'open', intent: 'all' });
      result.top_task_id = backlog.top_task_id;
      result.ranked = backlog.backlog.length;
    } catch (err) {
      result.errors.push(`rank_refresh: ${(err as Error).message}`);
    }

    // 2. Stall flagging (durable). tsk_aa2abe3414c5 — a card is stalled when it
    //    has sat in a watched column longer than that column's window. We watch
    //    THREE columns, each with its own threshold, because the failure modes
    //    differ: `ready` = never picked up (14d is fine); `in_progress` = a
    //    worker took it but made no advance (a multi-day pileup is a real stall
    //    — 3d); `e2e` = verification limbo that also trips dispatch backpressure
    //    (3d). We use entered_column_at when present, else created_at, as the
    //    age anchor, and never re-flag an already-stalled or closed card.
    for (const [col, windowMs] of Object.entries(this.stallWindows) as Array<
      [StallColumn, number]
    >) {
      try {
        const cutoff = now - windowMs;
        const candidates = this.db
          .prepare(
            `SELECT id, COALESCE(entered_column_at, created_at) AS age_anchor
               FROM tasks
              WHERE kanban_column = ?
                AND stalled = 0
                AND status != 'closed'
                AND COALESCE(entered_column_at, created_at) < ?
              ORDER BY age_anchor ASC
              LIMIT ?`,
          )
          .all(col, cutoff, this.maxStallPerTick) as Array<{ id: string; age_anchor: number }>;

        const flag = this.db.prepare(
          `UPDATE tasks SET stalled = 1, stalled_reason = ?
             WHERE id = ? AND stalled = 0`,
        );
        for (const c of candidates) {
          const days = Math.floor((now - c.age_anchor) / (24 * 60 * 60 * 1000));
          const info = flag.run(`In ${col} ${days}d without advance (PM stall gate)`, c.id);
          if (info.changes > 0) result.stalled_flagged += 1;
        }
      } catch (err) {
        result.errors.push(`stall_flag[${col}]: ${(err as Error).message}`);
      }
    }

    // 2b. Un-stall cards the user re-touched after they were flagged. A card
    //     whose last_touched moved past its stall window boundary should get
    //     a fresh chance to age. We clear the flag when last_touched is newer
    //     than the age anchor we'd stall against (i.e. it was recently poked).
    //     Applied per watched column with that column's own window.
    for (const [col, windowMs] of Object.entries(this.stallWindows) as Array<
      [StallColumn, number]
    >) {
      try {
        const clearCutoff = now - windowMs;
        const cleared = this.db
          .prepare(
            `UPDATE tasks SET stalled = 0, stalled_reason = NULL
               WHERE kanban_column = ?
                 AND stalled = 1
                 AND status != 'closed'
                 AND last_touched >= ?`,
          )
          .run(col, clearCutoff);
        result.stalled_cleared += cleared.changes;
      } catch (err) {
        result.errors.push(`stall_clear[${col}]: ${(err as Error).message}`);
      }
    }

    return result;
  }

  private empty(reason: 'disabled' | 'reentrant'): PMTickResult {
    return {
      top_task_id: null,
      ranked: 0,
      stalled_flagged: 0,
      stalled_cleared: 0,
      skipped: reason,
      errors: [],
    };
  }
}
