/**
 * v88 — ADR-039 AC-19 measurement scaffold (2026-06-29):
 * prompt_outcomes.session_id FK + index.
 *
 * # Why this column
 *
 * AC-19's third threshold is "user_verdict captured on ≥10 dispatches"
 * — measured against refinement-enabled dispatches specifically (not
 * all `prompt_outcomes` rows, which include legacy single-pass
 * `jira_analyze` / `chat` / `investigate` / `alert` triggers). To
 * filter prompt_outcomes to dispatches where SCOPE actually ran, we
 * need a join key back to `cypher_sessions`. Today there's none.
 *
 * The pre-existing prompt_outcomes table (declared inline at
 * src/db/schema.ts:1205, NOT via a migration) has no FK to
 * cypher_sessions — it was created for the OPRO learning pipeline
 * which keyed on `template_id` and free-text `trigger_input`. ADR-039
 * AC-14 added the `user_verdict` column (v86) but didn't add the
 * dispatch linkage; that was left implicit on the assumption that
 * the join would happen via trigger_input ≈ goal text. AC-19's
 * dogfood SQL exposed that approach as fragile.
 *
 * # What this migration does
 *
 * 1. ALTER TABLE prompt_outcomes ADD COLUMN session_id TEXT NULL
 *    REFERENCES cypher_sessions(session_id).
 *
 * 2. Index on session_id so the AC-19 measurement queries (which
 *    join prompt_outcomes back to cypher_sessions for every
 *    refinement-enabled dispatch's verdict) stay sub-millisecond
 *    as the table grows.
 *
 * # Forward-only population
 *
 * Existing rows get session_id=NULL. The loop's writer
 * (src/services/cypher/loop.ts, where the SCOPE phase will call
 * QualityScorer per AC-12) is responsible for passing session_id
 * through on every new INSERT. AC-19 measurement queries treat
 * NULL session_id as "pre-v88 row, ignore" — same convention as
 * v85's NULL scope_iters meaning "no SCOPE phase observed."
 *
 * # Idempotency
 *
 * PRAGMA-guarded. Survives parallel-worktree advancement.
 *
 * See:
 *   - docs/docs/adr/adr-039-cypher-refinement-phase.md § AC-19
 *   - .planning/cypher/adr-039-dogfood.md (the measurement queries
 *     this column unblocks)
 *   - scripts/adr-039-dogfood-check.sh (one-shot metrics runner)
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV88(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(prompt_outcomes)`)
    .all() as ColumnInfoRow[];

  const hasSessionId = cols.some(c => c.name === 'session_id');
  if (!hasSessionId) {
    db.exec(
      `ALTER TABLE prompt_outcomes ADD COLUMN session_id TEXT NULL ` +
        `REFERENCES cypher_sessions(session_id)`,
    );
  }

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_prompt_outcomes_session_id ` +
      `ON prompt_outcomes(session_id) WHERE session_id IS NOT NULL`,
  );
}
