/**
 * src/services/cypher/session-close.ts — session-close side effects (2026-07-13, Option-3 extraction).
 *
 * # Purpose
 *
 * Encapsulates the *side-effect* work that fires when a Cypher dispatch
 * closes with a verdict, in a location that survives Phase 7's deletion
 * of the legacy 9-stage pipeline (`run.ts`). Before this extraction, all
 * of the following lived inside `run.ts:660-800`:
 *
 *   - **G4 verified_via plumbing** (2026-07-13): read the highest-tier
 *     `outcome_evidence.verified_via` for the session's linked task and
 *     pass it into `recordSkillOutcomes` so ADR-040 §3.4's Beta-prior
 *     weight (user_observed=1.0, smoke=0.85, cross_family=0.5, self=0.10)
 *     actually varies. Without this, every prior update fires at 0.10
 *     and the anti-self-grading mechanism is inert.
 *
 *   - **AC-S5 acceptance_text draft** (ADR-040 commit 5): when a session
 *     closing on a `review`-column task has no `acceptance_text` yet,
 *     draft a 1-3 sentence verification instruction via Anthropic Haiku
 *     so the `/board` e2e modal has something to render.
 *
 * # Why this file exists (Phase-7 risk)
 *
 * ADR-037 Phase 7 (scheduled ~2026-08-25) deletes `run.ts`. Under the
 * default engine (`CYPHER_LOOP_ENABLED !== '0'`) all traffic runs
 * through `loop.ts`; run.ts is the legacy escape hatch. A naive Phase-7
 * delete would silently kill:
 *
 *   - G4's verified_via weighting → Beta priors go back to 0.10 for
 *     everyone, forever, with no compiler or runtime error to signal it.
 *   - AC-S5 acceptance_text drafts → `/board` e2e modal renders empty
 *     verification instructions.
 *
 * By moving both to a neutral module the deletion of run.ts leaves them
 * intact, and `loop.ts` can wire them in via the same imports.
 *
 * # Engine-agnostic behavior contract
 *
 * Both `draftAcceptanceText` and `recordVerifiedSkillOutcome` are safe
 * to call from either engine:
 *
 *   - **From `run.ts` (legacy pipeline):** unchanged behavior. G4 fires
 *     when a `chosenSkill` exists and the session's task has evidence.
 *     Acceptance text drafts when the task is in `review` with no
 *     existing acceptance_text and `input.outcome === 'success'`.
 *
 *   - **From `loop.ts` (default engine, ADR-037 D1):** the loop path
 *     does NOT have a `chosenSkill` (it selects tools per-iteration
 *     rather than dispatching a pre-chosen skill), so
 *     `recordVerifiedSkillOutcome` is NOT called from loop.ts. This is
 *     option (a) of the Phase-7 migration decision: preserve current
 *     Beta-priors behavior on the loop path pending a real ADR on what
 *     "skill credit" means for a tool-use-loop dispatch. See
 *     `.planning/phase-7-outcome-recording-migration.md` for the
 *     residual decision.
 *
 *     Acceptance text drafting IS wired into loop.ts by this extraction
 *     because it doesn't depend on a `chosenSkill` — it depends on the
 *     session's linked task being in `review`. A loop-driven card
 *     reaching `review` deserves the same drafted verification
 *     instruction as a pipeline-driven card.
 *
 * # What does NOT live here
 *
 *   - `recordOutcomeSignal` (verdict → `cypher_outcomes` row) — lives in
 *     `outcomes.ts` and is called by BOTH engines already. Not affected
 *     by Phase 7.
 *   - `autoCloseOnOutcome` (PM auto-link + Jira transitions) — lives in
 *     `pm-auto.ts`. Not affected by Phase 7.
 *   - `curateTaskContext` (D2 curator) — lives in `curator.ts`, called
 *     from loop.ts. Not affected by Phase 7.
 *
 * # Contract with outcomes.ts
 *
 * This module IS allowed to make LLM calls (AC-S5's acceptance_text
 * drafter uses Anthropic Haiku directly). The sibling `outcomes.ts`
 * explicitly forbids LLM calls per ADR-034 §Layer 1 ("no LLM judges
 * outcomes — measurement is mechanical"), enforced by
 * `tests/services/cypher/outcomes.test.ts:289`. The two-file split
 * respects that boundary: `outcomes.ts` is pure measurement,
 * `session-close.ts` is post-verdict side effects that MAY include
 * LLM work.
 *
 * See:
 *   - ADR-040 §3.4 (verified_via tier table)
 *   - ADR-040 commit 5 (AC-S5 acceptance_text)
 *   - ADR-037 Phase 7 (run.ts deletion)
 *   - .planning/phase-7-outcome-recording-migration.md (loop.ts wiring decision)
 *   - src/services/cypher/learn.ts:56-61 (VERIFIED_VIA_WEIGHT map)
 */

import type Database from 'better-sqlite3';
import { bucketCallParams } from '../model-config.js';
import { recordSkillOutcomes, type Outcome, type VerifiedVia } from './learn.js';

// ── verified_via lookup + skill prior update ────────────────────────────

/**
 * Read the highest-tier `outcome_evidence.verified_via` for the session's
 * linked task. Returns 'self_reported' when:
 *   - the session has no `task_id` (ad-hoc /wi dispatch, not board-linked)
 *   - the task has no `outcome_evidence` rows yet (session closing before
 *     any smoke passed or user clicked)
 *   - the DB query fails (defensive fallback — never break a session close
 *     over a lookup issue)
 *
 * Tier order (highest to lowest): user_observed > smoke_passed >
 * cross_family_checked > self_reported. Matches the WEIGHT map in
 * learn.ts; taking the max weight is the honest signal.
 *
 * Pure query — no side effects, no LLM call. Safe to call frequently.
 */
export function readVerifiedViaForSession(
  db: Database.Database,
  sessionId: string,
): VerifiedVia {
  try {
    const sessionRow = db
      .prepare(`SELECT task_id FROM cypher_sessions WHERE session_id = ?`)
      .get(sessionId) as { task_id: string | null } | undefined;
    if (!sessionRow?.task_id) return 'self_reported';

    const evidence = db
      .prepare(
        `SELECT verified_via FROM outcome_evidence
          WHERE task_id = ?
          ORDER BY CASE verified_via
            WHEN 'user_observed' THEN 4
            WHEN 'smoke_passed' THEN 3
            WHEN 'cross_family_checked' THEN 2
            WHEN 'self_reported' THEN 1
            ELSE 0 END DESC
          LIMIT 1`,
      )
      .get(sessionRow.task_id) as { verified_via: string } | undefined;
    if (!evidence?.verified_via) return 'self_reported';

    const v = evidence.verified_via;
    if (v === 'user_observed' || v === 'smoke_passed' ||
        v === 'cross_family_checked' || v === 'self_reported') {
      return v;
    }
    return 'self_reported';
  } catch {
    return 'self_reported';
  }
}

/**
 * Update the Beta prior for a skill given a session-close outcome,
 * weighted by the session's task's highest-tier verified_via.
 *
 * This is G4's public entry point — extracted from run.ts:664 during
 * the Option-3 refactor so the mechanism survives Phase 7's run.ts
 * deletion. `run.ts` calls it during pipeline close; `loop.ts` does
 * NOT call it (the loop has no chosen_skill semantics — see docblock).
 */
export function recordVerifiedSkillOutcome(
  db: Database.Database,
  sessionId: string,
  skillName: string,
  outcome: Outcome,
  taskClass: string = '*',
): VerifiedVia {
  const verifiedVia = readVerifiedViaForSession(db, sessionId);
  recordSkillOutcomes(db, skillName, outcome, taskClass, verifiedVia);
  return verifiedVia;
}

// ── AC-S5 acceptance_text draft (LLM call — engine-agnostic) ────────────

/**
 * ADR-040 commit 5: draft a 1-3 sentence verification instruction for
 * a session's linked task if:
 *   - `OUTCOME_HONEST_KANBAN_ENABLED === '1'`
 *   - the session has a `task_id`
 *   - that task is in `kanban_column='review'`
 *   - the task has no `acceptance_text` yet
 *
 * Otherwise: no-op. Best-effort — any LLM/DB failure logs to stderr and
 * returns without throwing. A missed draft leaves the `/board` e2e modal
 * empty on that card; a broken draft would break the session close.
 *
 * Small model + short output caps cost <$0.001 per card. Uses Anthropic
 * Haiku directly rather than routing through the panel LLM adapter
 * because this is a pure single-turn write and the panel adapter's
 * cost_ledger side effects would be misleading (this isn't panel work).
 *
 * Called by BOTH engines on `outcome === 'success'`.
 */
export async function draftAcceptanceText(
  db: Database.Database,
  sessionId: string,
  goal: string,
): Promise<void> {
  if (process.env.OUTCOME_HONEST_KANBAN_ENABLED !== '1') return;

  try {
    const link = db
      .prepare(`SELECT task_id FROM cypher_sessions WHERE session_id = ?`)
      .get(sessionId) as { task_id: string | null } | undefined;
    if (!link?.task_id) return;

    const task = db
      .prepare(`SELECT kanban_column, acceptance_text FROM tasks WHERE id = ?`)
      .get(link.task_id) as
      | { kanban_column: string; acceptance_text: string | null }
      | undefined;
    if (!task) return;
    if (task.kanban_column !== 'review') return;
    if (task.acceptance_text) return;

    // Best-effort synchronous draft.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({});
    const bucketParams = bucketCallParams(db, 'fetch', 200);
    const draft = await client.messages.create({
      ...bucketParams,
      messages: [{
        role: 'user',
        content:
          `You just completed work on this goal: "${goal}"\n\n` +
          `Draft a 1-3 sentence verification instruction the human user can ` +
          `run to confirm the delivery works. Be concrete: name commands, files, ` +
          `or observable behavior. Output the instruction only, no preamble.`,
      }],
    });
    const draftText = draft.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join(' ')
      .trim()
      .slice(0, 1000);
    if (draftText) {
      db.prepare(`UPDATE tasks SET acceptance_text = ? WHERE id = ?`)
        .run(draftText, link.task_id);
    }
  } catch (err) {
    process.stderr.write(`[session-close] acceptance_text draft failed: ${(err as Error).message}\n`);
  }
}
