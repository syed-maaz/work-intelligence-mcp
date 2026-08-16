/**
 * v86 — ADR-039 AC-14 (2026-06-27): prompt_outcomes.user_verdict.
 *
 * ADR-039 ("Cypher Refinement Phase — Two-Pass Loop for Goal Scope Before
 * Execution") wires a 5th `triggerType` — `goal_refinement` — into the
 * PromptEvolver + OPRO + TextGrad + A/B machinery from ADR-021. T6 landed
 * the trigger plumbing (v85 on cypher_sessions; PromptEvolver / seeds /
 * scorer wiring). T7 (this migration) adds the missing signal the loop
 * needs to learn about *prompt clarity* — not just *output quality*:
 *
 *   - `user_verdict TEXT DEFAULT 'unrated'`
 *       CHECK (user_verdict IN ('useful','wrong_question','wrong_scope','unrated'))
 *
 *   `useful`        — user got what they asked for; the refined goal
 *                     was on-target.
 *   `wrong_question`— Cypher interpreted the goal incorrectly; the
 *                     SCOPE phase asked the wrong clarifying questions.
 *   `wrong_scope`   — Cypher had the right question but bounded the
 *                     work incorrectly (too narrow, too wide).
 *   `unrated`       — default; no user signal yet. Distinguished from
 *                     NULL only by convention (`unrated` is the
 *                     explicit "not rated" state for downstream OPRO
 *                     filters that want to count only rated rows).
 *
 * Why on `prompt_outcomes` and not a sidecar table:
 *   ADR-039 reuses the existing learning substrate from ADR-021/034 —
 *   the row is already keyed by `(template_id, research_id,
 *   trigger_input)` and OPRO reads it nightly to pick winners. Adding
 *   the column here lets the nightly sweep filter on `user_verdict`
 *   without a new JOIN. The `user_feedback INTEGER` column already on
 *   the table is the legacy thumbs (-1/+1) signal from ADR-021; the
 *   two co-exist (one numeric, one enum). OPRO can read either.
 *
 * Why v86 and not v65 (which the original card body referenced):
 *   The card body was written before ADR-039 was renumbered. Master HEAD
 *   is at v85 (T3 cypher_sessions.refined_goal + scope_iters, merged
 *   2026-06-27 ee42062). v65 is taken by
 *   `v65_cypher_outcomes_legacy_upgrade.ts`. AC-14 binds this migration
 *   to v86; the card's "v65" wording is stale.
 *
 * Idempotent: PRAGMA-checks `prompt_outcomes` for the column before
 * issuing the ALTER. Same defense as v71 posture / v85 refined_goal
 * migrations — survives the case where a parallel worktree advanced the
 * schema past v86 before this slot's transaction ran.
 *
 * Default `'unrated'` applies to newly-inserted rows; existing rows get
 * NULL. Downstream queries that want "rated only" filter on
 * `user_verdict IN ('useful','wrong_question','wrong_scope')` (or
 * equivalently `!= 'unrated' AND IS NOT NULL`). The CHECK constraint
 * tolerates NULL because SQLite CHECKs always allow NULL unless the
 * column is NOT NULL — which we deliberately do not impose, so
 * historical rows stay valid.
 *
 * See:
 *   - docs/docs/adr/adr-039-cypher-refinement-phase.md § AC-14
 *   - src/db/queries/research-cache.ts — updateUserVerdict helper
 *   - src/routes/cypher.ts — POST /api/cypher/sessions/:id/user-verdict
 *   - scripts/smoke-bridge.sh § 38 — insert/read each verdict + 400
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV86(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(prompt_outcomes)`)
    .all() as ColumnInfoRow[];

  const hasUserVerdict = cols.some(c => c.name === 'user_verdict');

  if (!hasUserVerdict) {
    // CHECK applies to newly-inserted rows; existing rows skip the
    // check on ADD COLUMN (SQLite behaviour). The DEFAULT 'unrated'
    // applies only to inserts that omit the column — existing rows
    // get NULL, which both downstream readers treat as "no signal".
    db.exec(`
      ALTER TABLE prompt_outcomes
        ADD COLUMN user_verdict TEXT DEFAULT 'unrated'
        CHECK (user_verdict IS NULL OR user_verdict IN ('useful','wrong_question','wrong_scope','unrated'))
    `);
  }
}
