/**
 * ADR-040 F2 + F3 fix (2026-07-09) — BoardWorkerAgent.
 *
 * The audit at `.planning/audits/adr-040-post-ship-audit-2026-07-09.md`
 * found that `workers` was seeded on the v90 migration and then never
 * touched — no heartbeat, no advancer. 373 `ready` cards, 0 in every
 * other column. ADR §2.5 promises a fixed pool of 4 workers that advance
 * cards. This agent is that promise.
 *
 * # Responsibilities per tick (30s cadence)
 *
 * 1. **Heartbeat** — write `now` to `workers.last_active_at` for all 4
 *    rows. Keeps `/api/board/health` honest.
 *
 * 2. **Advance `ready → in_progress`.** For each idle worker (WIP<1) —
 *    the ADR is fine with parallel workers, but the safe default per §2.5
 *    is one-worker-per-ticket. Pick the oldest `ready` card whose
 *    `depends_on_json` deps are all `done` and that isn't blocked.
 *    Match the worker's `profile_hint` against the card's `posture`
 *    where possible, otherwise generalist wins. Write:
 *      - `tasks.kanban_column = 'in_progress'`
 *      - `tasks.assigned_worker_id = worker.id`
 *      - `tasks.entered_column_at = now`
 *      - `workers.current_task_id = task.id`
 *
 * 3. **Advance `in_progress → review`.** For any card in `in_progress`
 *    whose owning Cypher session has closed with `status='done'` or
 *    outcome_note that doesn't indicate failure, transition to review
 *    and clear `workers.current_task_id` (worker becomes idle again).
 *    NB: v1 does not run smoke:bridge from the agent — smoke is a
 *    separate ~30s job that would block the event loop. Smoke gate
 *    is a future refinement; the initial critical path is
 *    "cards move through columns visibly."
 *
 * 4. **Auto-fire panel on `review`.** For any card that just landed
 *    in `review` (or has been there >2 minutes without a panel_review
 *    row), invoke `runPanel(db, task_id)`. On unanimous approve, the
 *    panel writes `kanban_column='e2e'` itself. On reject, the panel
 *    routes back to `in_progress`.
 *
 * # Safety
 *
 * - Wrapped in `inFlight` guard so setInterval races collapse to a no-op.
 * - Bounded work: one advancement per column per tick (avoids single-tick
 *   avalanche when many cards are ready). Fast repeated ticks catch up.
 * - Kill-switch via `BOARD_WORKER_ENABLED`. Default '1' when
 *   `OUTCOME_HONEST_KANBAN_ENABLED=1`, else refuses to register.
 * - `BOARD_BLOCK_NOWORK_ENABLED` (default '1'): when a done dispatch did
 *   zero execute-phase work (halted in SCOPE, 0 `cypher_steps` with
 *   phase='execute'), step 3 moves the card to the Blocked lane instead of
 *   advancing it to `review` (outcome-honesty — no false-positive completes).
 *   Set to '0' to restore the old behavior (advance regardless) as a
 *   rollback lever during the ADR-042 SCOPE-halt window.
 * - Never blocks the bridge — runPanel is async and returns quickly
 *   when panel-agent LLMs are unavailable (falls back to degraded
 *   verdict).
 *
 * # What this agent does NOT do
 *
 * - Does NOT create cards from `/wi` intake — that's the intake path.
 * - Does NOT close cards to `done` — only user_observed evidence does
 *   that (via SQL trigger, ADR §2.4).
 * - Does NOT spawn worker subprocesses. Workers are DB identities
 *   representing capacity slots; the "work" happens inside Cypher
 *   sessions triggered by `/wi/dispatch`.
 */

import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

export interface BoardWorkerAgentOptions {
  db: Database.Database;
  /** How often to auto-fire the panel for a card sitting in `review`. Default 2 min. */
  panelStaleMs?: number;
  /** Bridge base URL for skill-dispatch fanout. Defaults to http://localhost:3132. */
  bridgeBaseUrl?: string;
}

export interface BoardTickResult {
  heartbeated: number;
  advanced_to_in_progress: number;
  advanced_to_review: number;
  panels_fired: number;
  /** Workers freed from stuck/asked_user sessions this tick (step 3b). */
  freed?: number;
  /** Cards blocked this tick for producing no execute-phase work (step 3). */
  blocked_no_work?: number;
  skipped?: 'disabled' | 'reentrant';
  errors: string[];
}

interface WorkerRow {
  id: number;
  number: number;
  profile_hint: string;
  current_task_id: string | null;
  health_status: string;
}

interface TaskRow {
  id: string;
  posture: string | null;
  kanban_column: string;
  assigned_worker_id: number | null;
  entered_column_at: number | null;
  depends_on_json: string | null;
  blocked: number;
  created_at: number;
}


export class BoardWorkerAgent {
  private db: Database.Database;
  private inFlight = false;

  constructor(opts: BoardWorkerAgentOptions) {
    this.db = opts.db;
    // panelStaleMs is retained in the options type for API compat but no
    // longer stored — the panel auto-fire gate is now "no terminal verdict
    // yet OR reworked since last review" (step 4), not a time window, so a
    // deadlocked card no longer re-fires on a stale timer. bridgeBaseUrl is
    // reserved for future runSkillSubagent fan-out.
    void opts.panelStaleMs;
    void opts.bridgeBaseUrl;
  }

  async tick(): Promise<BoardTickResult> {
    if (process.env.OUTCOME_HONEST_KANBAN_ENABLED !== '1') {
      return this.emptyResult('disabled');
    }
    if (process.env.BOARD_WORKER_ENABLED === '0') {
      return this.emptyResult('disabled');
    }
    if (this.inFlight) return this.emptyResult('reentrant');
    this.inFlight = true;
    try {
      return await this.runOnce();
    } finally {
      this.inFlight = false;
    }
  }

  private async runOnce(): Promise<BoardTickResult> {
    const result: BoardTickResult = {
      heartbeated: 0,
      advanced_to_in_progress: 0,
      advanced_to_review: 0,
      panels_fired: 0,
      errors: [],
    };
    const now = Date.now();

    // 1. heartbeat
    try {
      const info = this.db
        .prepare(`UPDATE workers SET last_active_at = ? WHERE health_status = 'active'`)
        .run(now);
      result.heartbeated = info.changes;
    } catch (err) {
      result.errors.push(`heartbeat: ${(err as Error).message}`);
    }

    // 2. try one ready→in_progress advancement
    try {
      const idle = this.db
        .prepare(
          `SELECT id, number, profile_hint, current_task_id, health_status
             FROM workers
            WHERE health_status = 'active' AND current_task_id IS NULL
            ORDER BY number ASC`,
        )
        .all() as WorkerRow[];
      if (idle.length > 0) {
        const worker = idle[0]!;
        const card = this.pickReadyCard(worker);
        if (card) {
          this.assign(worker, card, now);
          result.advanced_to_in_progress = 1;
        }
      }
    } catch (err) {
      result.errors.push(`advance_ready: ${(err as Error).message}`);
    }

    // 3. try one in_progress→review advancement based on closed cypher sessions
    //
    // Smoke freshness gate (ADR-040 follow-up 2026-07-13 D1). When
    // BOARD_SMOKE_GATE_ENABLED=1, refuse to advance if schema_metadata's
    // smoke_bridge_last_green is older than BOARD_SMOKE_MAX_STALE_MIN
    // (default 360 = 6h) — or missing entirely. This is the freshness-gated
    // shape from the audit §4 (not the per-card shape). Weaker guarantee:
    // catches "smoke hasn't been run recently" but not "smoke wasn't run
    // since this card's changes." Default-off (rollout discipline); the
    // audit documents when to flip it on.
    const smokeGateOk = this.smokeFreshnessGate(now);
    try {
      if (!smokeGateOk.pass) {
        // Non-fatal: skip the advance, note it on the oldest in_progress
        // card so the review-column stall is visible. Idempotent — only
        // one note per gate-block, refreshed if stale > 24h between checks.
        const stuck = this.db
          .prepare(
            `SELECT t.id FROM tasks t
               JOIN cypher_sessions cs ON cs.task_id = t.id
              WHERE t.kanban_column = 'in_progress'
                AND cs.status = 'done'
                AND (cs.outcome_note IS NULL OR cs.outcome_note NOT LIKE '%fail%')
              ORDER BY t.entered_column_at ASC LIMIT 1`,
          )
          .get() as { id: string } | undefined;
        if (stuck) {
          const dayAgo = now - 24 * 60 * 60 * 1000;
          const already = this.db
            .prepare(
              `SELECT 1 FROM card_comments
                WHERE task_id = ? AND author = 'system' AND kind = 'note'
                  AND body LIKE 'Smoke freshness gate%'
                  AND created_at > ? LIMIT 1`,
            )
            .get(stuck.id, dayAgo);
          if (!already) {
            this.addComment(
              stuck.id,
              'system',
              'note',
              `Smoke freshness gate blocked review advance — ${smokeGateOk.reason}. Run 'npm run smoke:bridge:record' to refresh, or unset BOARD_SMOKE_GATE_ENABLED to bypass.`,
              now,
            );
          }
        }
      } else {
        // Classify each advanceable in_progress card by whether its dispatch
        // did REAL work — i.e. reached the EXECUTE phase and called at least
        // one tool (>=1 cypher_steps row with phase='execute'). A dispatch
        // that halted in SCOPE (the ADR-042 round-count race) still lands at
        // status='done' with outcome_note=NULL, so the old gate (status=done
        // AND NOT LIKE '%fail%') laundered it up the board as a false-positive
        // completion. Now: no execute work → move to the Blocked lane with a
        // diagnostic reason; real work → advance to review as before.
        //
        // Bounded loop, not one-shot: blocking a no-work card must not starve
        // a genuinely-done card behind it in the same tick, but a full sweep
        // would block the entire in_progress backlog at once. MAX_PASSES caps
        // the per-tick blocks; the 30s cadence drains any backlog over a few
        // ticks (matches the agent's bounded-work-per-tick doctrine). Each
        // block sets blocked=1, so the card drops out of the next SELECT
        // (WHERE t.blocked = 0) — the loop makes forward progress by
        // construction. One real advance per tick (break) preserves the
        // existing one-advance-per-column invariant.
        //
        // BOARD_BLOCK_NOWORK_ENABLED (default on) is the rollback lever: when
        // '0', no-work cards fall through to the advance branch — today's
        // exact behavior — for the ADR-042 window if the board looks alarming.
        const blockNoWork = process.env.BOARD_BLOCK_NOWORK_ENABLED !== '0';
        const MAX_PASSES = 5;
        for (let pass = 0; pass < MAX_PASSES; pass++) {
          const advanceable = this.db
            .prepare(
              `SELECT t.id, t.posture, t.kanban_column, t.assigned_worker_id,
                      t.entered_column_at, t.depends_on_json, t.blocked, t.created_at,
                      cs.session_id AS session_id, cs.outcome_note AS outcome_note,
                      cs.duration_ms AS duration_ms,
                      (SELECT COUNT(*) FROM cypher_steps s
                        WHERE s.session_id = cs.session_id AND s.phase = 'execute') AS exec_steps,
                      (SELECT COUNT(*) FROM cypher_steps s
                        WHERE s.session_id = cs.session_id AND s.phase = 'scope') AS scope_steps
                 FROM tasks t
                 JOIN cypher_sessions cs ON cs.task_id = t.id
                WHERE t.kanban_column = 'in_progress'
                  AND t.blocked = 0
                  AND cs.status = 'done'
                  AND (cs.outcome_note IS NULL OR cs.outcome_note NOT LIKE '%fail%')
                ORDER BY t.entered_column_at ASC
                LIMIT 1`,
            )
            .get() as
              | (TaskRow & {
                  session_id: string;
                  outcome_note: string | null;
                  duration_ms: number | null;
                  exec_steps: number;
                  scope_steps: number;
                })
              | undefined;
          if (!advanceable) break;

          if (blockNoWork && advanceable.exec_steps === 0) {
            // No execute-phase work — the dispatch never left SCOPE. Move to
            // the Blocked lane (blocked is a flag, not a column, per ADR §2.8
            // — leave kanban_column and entered_column_at untouched so the
            // stale-reaper accounting in step 3b stays honest).
            const reason =
              `Dispatch produced no work — halted in SCOPE before EXECUTE ` +
              `(session ${advanceable.session_id}, ${advanceable.scope_steps} scope iters). ` +
              `Re-scope with a sharper/shorter goal or fix manually.`;
            this.db
              .prepare(
                `UPDATE tasks
                    SET blocked = 1, blocked_reason = ?, assigned_worker_id = NULL, last_touched = ?
                  WHERE id = ?`,
              )
              .run(reason, now, advanceable.id);
            if (advanceable.assigned_worker_id != null) {
              this.db
                .prepare(`UPDATE workers SET current_task_id = NULL WHERE id = ?`)
                .run(advanceable.assigned_worker_id);
            }
            this.addComment(advanceable.id, 'system', 'note', `🚫 ${reason}`, now);
            result.blocked_no_work = (result.blocked_no_work ?? 0) + 1;
            continue; // blocked=1 → this card is excluded from the next SELECT
          }

          // Real execute-phase work → advance to review.
          this.db
            .prepare(
              `UPDATE tasks
                  SET kanban_column = 'review', entered_column_at = ?, last_touched = ?
                WHERE id = ?`,
            )
            .run(now, now, advanceable.id);
          if (advanceable.assigned_worker_id != null) {
            this.db
              .prepare(`UPDATE workers SET current_task_id = NULL WHERE id = ?`)
              .run(advanceable.assigned_worker_id);
          }
          // Record the work summary on the card so `review` isn't a blank card.
          const durSec = advanceable.duration_ms ? Math.round(advanceable.duration_ms / 1000) : null;
          const note = advanceable.outcome_note ? ` — ${advanceable.outcome_note.slice(0, 200)}` : '';
          this.addComment(
            advanceable.id,
            'worker',
            'progress',
            `Session completed${durSec != null ? ` in ${durSec}s` : ''}${note}. Advanced to review; panel will evaluate.`,
            now,
          );
          result.advanced_to_review = 1;
          break; // one real advance per tick
        }
      }
    } catch (err) {
      result.errors.push(`advance_in_progress: ${(err as Error).message}`);
    }

    // 3b. Liberate workers stuck on non-advancing cards. A card whose
    // owning cypher_session sits at 'asked_user' (waiting for an answer
    // that will never come from a background dispatch) OR any card that
    // has been in in_progress past BOARD_STALE_IN_PROGRESS_MS with no
    // terminal session pins its worker forever, saturating the pool so
    // real cards never get picked. This was the
    // 2026-07-09 "no more in_progress for repo" report: 4 WI probe
    // cards at asked_user held all 4 workers.
    //
    // Before freeing, surface WHY the card stalled: if the session is
    // asked_user, write its clarifying question as a `question` comment
    // and flag needs_answer=1 so the board shows the card as awaiting the
    // user's reply (distinct badge + colour). The user answers in the
    // ticket → the answer clears needs_answer. Idempotent: we don't
    // re-write the question comment if one already exists for this card.
    try {
      const staleMs = Number(process.env.BOARD_STALE_IN_PROGRESS_MS) || 30 * 60 * 1000;
      const staleCutoff = now - staleMs;
      const stuck = this.db
        .prepare(
          `SELECT t.id, t.assigned_worker_id, cs.session_id, cs.status AS session_status,
                  (SELECT COUNT(*) FROM dispatch_snapshots ds WHERE ds.dispatch_id = cs.session_id) AS has_snapshot
             FROM tasks t
             LEFT JOIN cypher_sessions cs ON cs.task_id = t.id
            WHERE t.kanban_column = 'in_progress'
              AND t.stalled = 0
              AND (
                cs.status = 'asked_user'
                OR (t.entered_column_at IS NOT NULL AND t.entered_column_at < ?
                    AND (cs.status IS NULL OR cs.status NOT IN ('done')))
              )
            ORDER BY t.entered_column_at ASC`,
        )
        .all(staleCutoff) as {
          id: string;
          assigned_worker_id: number | null;
          session_id: string | null;
          session_status: string | null;
          has_snapshot: number;
        }[];
      for (const s of stuck) {
        const isAsk = s.session_status === 'asked_user';
        // Zombie: pending (or null) session, no live snapshot → dead dispatch.
        const isZombie =
          !isAsk &&
          (s.session_status === 'pending' || s.session_status == null) &&
          s.has_snapshot === 0;

        if (isAsk && s.session_id) {
          this.surfaceQuestion(s.id, s.session_id, now);
          this.db
            .prepare(
              `UPDATE tasks SET needs_answer = 1, assigned_worker_id = NULL, last_touched = ? WHERE id = ?`,
            )
            .run(now, s.id);
        } else if (isZombie) {
          const startedAt = s.session_id ? this.sessionStartedAt(s.session_id) : null;
          const mins = startedAt ? Math.round((now - startedAt) / 60000) : 0;
          // Build a reason that reads cleanly whether or not we could tie the
          // dead dispatch back to a session. Card #22 hit the null-session case:
          // the old `session ${id ?? '?'}` wrote a literal "session ?" + "0m",
          // which surfaced to the UI as a useless reason. Omit the session/age
          // clause entirely when there's no id to name.
          const stalledReason = s.session_id
            ? `Dispatch died — session ${s.session_id} stuck 'pending' ${mins}m with no live run. Retrigger to restart.`
            : `Dispatch died before a session was recorded (no live run detected). Retrigger to restart.`;
          this.db
            .prepare(
              `UPDATE tasks SET stalled = 1, stalled_reason = ?,
                      assigned_worker_id = NULL, last_touched = ? WHERE id = ?`,
            )
            .run(stalledReason, now, s.id);
          this.addComment(
            s.id,
            'system',
            'note',
            `⚠️ Worker stalled — the dispatch for this card is no longer running (session stuck 'pending' with no live process). Click Retrigger to start a fresh run, or investigate the goal.`,
            now,
          );
        } else {
          this.db
            .prepare(
              `UPDATE tasks SET kanban_column = 'ready', assigned_worker_id = NULL,
                      entered_column_at = ?, last_touched = ? WHERE id = ?`,
            )
            .run(now, now, s.id);
        }
        if (s.assigned_worker_id != null) {
          this.db
            .prepare(`UPDATE workers SET current_task_id = NULL WHERE id = ?`)
            .run(s.assigned_worker_id);
        }
        result.freed = (result.freed ?? 0) + 1;
      }
    } catch (err) {
      result.errors.push(`liberate_workers: ${(err as Error).message}`);
    }

    // 4. auto-fire panel on a review card that has NO completed panel run yet.
    // Previously this re-fired whenever the last run was older than a stale
    // window — but a `deadlock`/`rejected` card stays in review, so it kept
    // re-qualifying every tick, spamming identical verdict comments (110
    // runs on one card, 14 duplicate "Panel deadlock" comments — 2026-07-09).
    // Fix: only fire when there's no terminal panel verdict, OR the card's
    // work changed since the last review (last_touched newer than the last
    // panel run — i.e. it re-entered review after rework). A deadlock is
    // terminal for auto-fire purposes; the user re-triggers via the manual
    // /api/board/tasks/:id/panel endpoint if they want another round.
    try {
      const needsPanel = this.db
        .prepare(
          `SELECT t.id
             FROM tasks t
             LEFT JOIN (
               SELECT task_id,
                      MAX(started_at) AS last_started,
                      MAX(CASE WHEN verdict != 'pending' THEN 1 ELSE 0 END) AS has_terminal
                 FROM panel_reviews
                GROUP BY task_id
             ) pr ON pr.task_id = t.id
            WHERE t.kanban_column = 'review'
              AND t.blocked = 0
              AND (
                pr.last_started IS NULL
                OR pr.has_terminal = 0
                OR t.last_touched > pr.last_started
              )
            ORDER BY t.entered_column_at ASC
            LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      if (needsPanel) {
        // Dynamic import to keep the agent decoupled at boot.
        const { runPanel } = await import('../services/cypher/panel.js');
        // runPanel updates kanban_column itself on approve/reject; we
        // deliberately don't await it if it takes too long — the panel
        // is a fire-and-track surface.
        try {
          const panelResult = await runPanel(this.db, needsPanel.id);
          result.panels_fired = 1;
          // Surface the panel verdict on the card so `review` shows what
          // the 4-agent panel actually decided.
          if (panelResult) {
            const decisions = (panelResult.decisions ?? []) as { role?: string; verdict?: string }[];
            const tally = decisions
              .map((d) => `${d.role ?? '?'}:${d.verdict ?? '?'}`)
              .join(', ');
            const verdict = panelResult.verdict ?? 'reviewed';
            this.addComment(
              needsPanel.id,
              'cypher',
              'progress',
              `Panel ${verdict}${tally ? ` — ${tally}` : ''}.`,
              Date.now(),
            );
          }
        } catch (err) {
          result.errors.push(`panel(${needsPanel.id}): ${(err as Error).message}`);
        }
      }
    } catch (err) {
      result.errors.push(`fire_panel: ${(err as Error).message}`);
    }

    return result;
  }

  private pickReadyCard(worker: WorkerRow): TaskRow | undefined {
    // Prefer cards whose posture is closest to the worker's profile hint.
    // We do this in two passes: (a) postural match, (b) any card.
    //
    // Skip fixture/smoke cards: they have no goal_text (or use the `tsk_`
    // prefix that smoke §27-31 D2 task-memory tests create, or carry a
    // `smoke*` external_ref). Left unfiltered they flood `ready` and hog
    // all 4 worker slots so real cards never advance (the 2026-07-09
    // "stuck in in_progress" report). Real dispatch cards use the
    // `task_` prefix and always carry goal_text.
    const postureFilter = this.profileToPosture(worker.profile_hint);
    // ADR-043 Phase 1: filter intent='execute' (brainstorm/plan/decide
    // stay in `ready` until user promotes via /pm bump). ORDER BY priority
    // DESC then created_at ASC approximates rank_score without paying to
    // compute the full ranker per pickup — the ranker remains the
    // authoritative "why" surface (GET /api/board/backlog) but this SQL
    // ordering is enough to make workers pick high-priority cards first.
    // When PM_ORCHESTRATION_ENABLED=0, priority stays at its default 50 and
    // this ORDER BY collapses to FIFO by created_at (today's behavior).
    const rows = this.db
      .prepare(
        `SELECT id, posture, kanban_column, assigned_worker_id,
                entered_column_at, depends_on_json, blocked, created_at
           FROM tasks
          WHERE kanban_column = 'ready'
            AND blocked = 0
            AND stalled = 0
            AND intent = 'execute'
            AND goal_text IS NOT NULL
            AND id LIKE 'task_%'
            AND (external_ref IS NULL OR external_ref NOT LIKE 'smoke%')
            AND title NOT LIKE 'adr040-c1-smoke-%'
            AND title NOT LIKE 'Smoke%'
          ORDER BY priority DESC, created_at ASC`,
      )
      .all() as TaskRow[];

    const eligible = rows.filter((r) => this.depsDone(r));
    if (eligible.length === 0) return undefined;
    const preferred = eligible.find((r) => (r.posture ?? 'generic') === postureFilter);
    return preferred ?? eligible[0]!;
  }

  private depsDone(t: TaskRow): boolean {
    if (!t.depends_on_json) return true;
    try {
      const deps = JSON.parse(t.depends_on_json) as unknown;
      if (!Array.isArray(deps) || deps.length === 0) return true;
      const ids = deps.filter((d): d is string => typeof d === 'string');
      if (ids.length === 0) return true;
      const placeholders = ids.map(() => '?').join(',');
      const unfinished = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks WHERE id IN (${placeholders}) AND kanban_column != 'done'`,
        )
        .get(...ids) as { n: number };
      return unfinished.n === 0;
    } catch {
      // Malformed JSON — refuse to advance so a human can fix it.
      return false;
    }
  }

  /** Started-at (unix ms) of a session, or null if unknown. */
  private sessionStartedAt(sessionId: string): number | null {
    const row = this.db
      .prepare(`SELECT started_at FROM cypher_sessions WHERE session_id = ?`)
      .get(sessionId) as { started_at: number } | undefined;
    return row?.started_at ?? null;
  }

  /**
   * Smoke freshness gate — ADR-040 follow-up 2026-07-13 D1 quick shape.
   *
   * Default-off (BOARD_SMOKE_GATE_ENABLED='1' opts in). When enabled,
   * returns `{pass: false, reason}` if:
   *   - schema_metadata.smoke_bridge_last_green is missing, OR
   *   - the recorded timestamp is older than BOARD_SMOKE_MAX_STALE_MIN
   *     (default 360 = 6h).
   *
   * The gate is a bridge-side read of a value that scripts/record-smoke-green.mjs
   * writes after a successful smoke:bridge run. NOT the per-card smoke shape
   * (that's audit §4 shape 1, ~4h, deferred). This gives weaker guarantees but
   * is cheap to ship and easy to reason about.
   *
   * When BOARD_SMOKE_GATE_ENABLED != '1', always returns {pass: true}.
   */
  private smokeFreshnessGate(now: number): { pass: true } | { pass: false; reason: string } {
    if (process.env.BOARD_SMOKE_GATE_ENABLED !== '1') return { pass: true };
    const maxStaleMin = Number(process.env.BOARD_SMOKE_MAX_STALE_MIN) || 360;
    let row: { value: string } | undefined;
    try {
      row = this.db
        .prepare(`SELECT value FROM schema_metadata WHERE key = 'smoke_bridge_last_green'`)
        .get() as { value: string } | undefined;
    } catch {
      // If schema_metadata is missing for any reason, be permissive rather
      // than block. The gate should never harden into a total block on
      // infrastructure issues unrelated to smoke.
      return { pass: true };
    }
    if (!row?.value) {
      return {
        pass: false,
        reason: 'smoke_bridge_last_green not recorded yet (gate enabled)',
      };
    }
    const lastGreen = Number(row.value);
    if (!Number.isFinite(lastGreen) || lastGreen <= 0) {
      return { pass: false, reason: `smoke_bridge_last_green unparseable: ${row.value}` };
    }
    const ageMin = (now - lastGreen) / 60000;
    if (ageMin > maxStaleMin) {
      return {
        pass: false,
        reason: `smoke:bridge last green ${Math.round(ageMin)}m ago (> ${maxStaleMin}m stale window)`,
      };
    }
    return { pass: true };
  }

  /**
   * Append an activity comment to a card's thread. Used at each lifecycle
   * transition (pick-up, session-complete, panel-verdict) so `review` and
   * later columns show "what has been done so far" instead of a blank card.
   * Best-effort — a comment write must never break the tick.
   */
  private addComment(
    taskId: string,
    author: 'worker' | 'cypher' | 'user' | 'system',
    kind: 'progress' | 'question' | 'answer' | 'note',
    body: string,
    now: number,
  ): void {
    try {
      const id = `cmt_${randomBytes(6).toString('hex')}`;
      this.db
        .prepare(
          `INSERT INTO card_comments(id, task_id, author, kind, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, taskId, author, kind, body.slice(0, 2000), now);
    } catch {
      // swallow — activity logging is non-critical
    }
  }

  /**
   * Idempotent — skips if a question comment already exists for this card.
   * The question text is pulled from the `ask` step payload in
   * cypher_steps (shape: {questions:[{question,default},...]}); falls back
   * to a generic prompt if the payload can't be parsed.
   */
  private surfaceQuestion(taskId: string, sessionId: string, now: number): void {
    const already = this.db
      .prepare(`SELECT 1 FROM card_comments WHERE task_id = ? AND kind = 'question' LIMIT 1`)
      .get(taskId);
    if (already) return;

    let questionText = 'Cypher needs your input to continue. Reply below to unblock this card.';
    try {
      const step = this.db
        .prepare(
          `SELECT payload FROM cypher_steps
            WHERE session_id = ? AND stage = 'ask'
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(sessionId) as { payload: string } | undefined;
      if (step?.payload) {
        const parsed = JSON.parse(step.payload) as { questions?: { question: string; default?: string }[] };
        if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
          questionText = parsed.questions
            .map((q, i) => `${i + 1}. ${q.question}${q.default ? ` (default: ${q.default})` : ''}`)
            .join('\n');
        }
      }
    } catch {
      // fall back to the generic prompt
    }

    this.addComment(taskId, 'cypher', 'question', questionText, now);
  }

  private assign(worker: WorkerRow, card: TaskRow, now: number): void {
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tasks
              SET kanban_column = 'in_progress',
                  assigned_worker_id = ?,
                  entered_column_at = ?,
                  last_touched = ?
            WHERE id = ? AND kanban_column = 'ready'`,
        )
        .run(worker.id, now, now, card.id);
      this.db
        .prepare(`UPDATE workers SET current_task_id = ?, last_active_at = ? WHERE id = ?`)
        .run(card.id, now, worker.id);
      this.addComment(
        card.id,
        'worker',
        'progress',
        `Worker ${worker.number} (${worker.profile_hint}) picked this up — moved to in_progress.`,
        now,
      );
    });
    txn();
  }

  private profileToPosture(profile: string): string {
    // Rough mapping. Postures are open-ended per §2.4/2.5 — this only
    // exists for the "prefer matching worker" bias. Missing mappings
    // just default to 'generic', which is fine.
    switch (profile) {
      case 'backend': return 'bug-investigate';
      case 'frontend': return 'pr-review';
      case 'schema': return 'pm';
      default: return 'generic';
    }
  }

  private emptyResult(reason: 'disabled' | 'reentrant'): BoardTickResult {
    return {
      heartbeated: 0,
      advanced_to_in_progress: 0,
      advanced_to_review: 0,
      panels_fired: 0,
      skipped: reason,
      errors: [],
    };
  }
}
