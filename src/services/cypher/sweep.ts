/**
 * Stale-session sweep (slice 82a-1, 2026-06-14).
 *
 * Closes pending sessions in batch with outcome={mixed,failed} and
 * updates the Beta priors. The dispatch endpoint already does this
 * one-at-a-time; the sweep is a bulk version exposed as
 * POST /api/cypher/health/sessions/sweep.
 *
 * Why a separate module not just SQL in the route handler:
 *   - Hard rule 7 — writes against cypher_sessions + skill_priors must
 *     route through the cypher service helpers.
 *   - Reusable: the planned one-time priors-cleanup pass (Phase 82a
 *     order-of-operations step 11) calls this module directly via tsx.
 *   - Smoke § 27.2.x asserts the side effects (session row updated,
 *     prior moved). That's testable here without standing up the bridge.
 *
 * Sweep semantics:
 *   - outcome ∈ {mixed, failed} only. Sweep is by definition NOT a
 *     genuine success — refuse outcome=success at the type boundary.
 *   - Per-session: same code path as a normal close (UPDATE session +
 *     recordSkillOutcome). No PM-AUTO close fires — sweep is for the
 *     historical backlog, not active work; running PM-AUTO over 122
 *     stale rows would auto-link random commits to whatever happened
 *     to be on the branch since each session started.
 *   - Idempotent: a session that's already done is skipped (returned in
 *     the `already_closed` list, not the `swept` count).
 */

import type Database from 'better-sqlite3';
import { recordSkillOutcome } from './learn.js';

export type SweepOutcome = 'mixed' | 'failed';

export interface SweepResult {
  swept: number;
  swept_ids: string[];
  /** Ids that were already done — skipped, not counted as swept. */
  already_closed: string[];
  /** Ids that didn't resolve to a row at all. */
  not_found: string[];
}

interface SessionRow {
  session_id: string;
  status: string;
  chosen_skill: string | null;
  task_class: string | null;
}

/**
 * Close every (existing, pending) session in `session_ids` with the
 * supplied outcome. Updates skill_priors via recordSkillOutcome for
 * each session that has a chosen_skill — sessions with no chosen_skill
 * still get their status flipped but contribute no prior nudge.
 *
 * Wrapped in a single transaction so partial failures roll back.
 */
export function sweepStaleSessions(
  db: Database.Database,
  session_ids: string[],
  outcome: SweepOutcome,
): SweepResult {
  if (outcome !== 'mixed' && outcome !== 'failed') {
    throw new Error(`sweep refuses outcome='${outcome}' — only mixed|failed are valid`);
  }

  const result: SweepResult = {
    swept: 0,
    swept_ids: [],
    already_closed: [],
    not_found: [],
  };

  const lookup = db.prepare<[string], SessionRow>(`
    SELECT session_id, status, chosen_skill, task_class FROM cypher_sessions
     WHERE session_id = ?
  `);
  const update = db.prepare(`
    UPDATE cypher_sessions
       SET status='done', outcome=?, completed_at=datetime('now')
     WHERE session_id=? AND status='pending'
  `);

  const tx = db.transaction((): void => {
    for (const id of session_ids) {
      const row = lookup.get(id);
      if (!row) {
        result.not_found.push(id);
        continue;
      }
      if (row.status !== 'pending') {
        result.already_closed.push(id);
        continue;
      }
      const ran = update.run(outcome, id);
      if (ran.changes === 0) {
        // Race: someone else closed it between lookup and update.
        result.already_closed.push(id);
        continue;
      }
      // Move the prior. No-op if chosen_skill is null.
      if (row.chosen_skill) {
        recordSkillOutcome(db, row.chosen_skill, outcome, row.task_class ?? '*');
      }
      result.swept += 1;
      result.swept_ids.push(id);
    }
  });
  tx();

  return result;
}
