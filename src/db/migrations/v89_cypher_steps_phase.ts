/**
 * v89 — ADR-039 AC-19a per-phase token telemetry (2026-06-29).
 *
 * AC-19a requires: "scope-phase token usage written to cypher_steps and
 * aggregated separately from execute-phase usage. The 2-week dogfood
 * review computes scope_phase_tokens / total_dispatch_tokens per
 * dispatch (median + p90)."
 *
 * Today's `cypher_steps.tokens_used` is a single integer with no phase
 * discriminator. This migration adds:
 *
 *   cypher_steps.phase TEXT NULL CHECK(phase IS NULL OR phase IN ('scope','execute'))
 *
 * Forward-only population: existing rows get NULL (pre-AC-19a era).
 * The loop's `cypher_steps` INSERT path is updated in the same commit
 * to pass the phase value through:
 *   - SCOPE-phase tool_use INSERTs tag the row 'scope'
 *   - EXECUTE-phase tool_use INSERTs tag the row 'execute'
 *   - tool_use rows from pre-AC-7 single-pass loop runs stay NULL
 *
 * AC-19 dogfood queries SUM the `tokens_used` column grouped by `phase`
 * and JOIN to `cypher_sessions` via `session_id` to compute the per-
 * dispatch ratio. The `npm run adr-039:check` script is updated in the
 * same commit to surface this.
 *
 * # Why a CHECK constraint instead of a free-text TEXT column
 *
 * The two values are a closed enum (matches `LoopExecPhase` in loop.ts).
 * A typo like 'scopw' would silently corrupt the AC-19a aggregation.
 * The CHECK constraint catches the bug at INSERT time.
 *
 * # Idempotency
 *
 * PRAGMA-guarded on column existence. Survives parallel-worktree
 * advancement.
 *
 * See:
 *   - docs/docs/adr/adr-039-cypher-refinement-phase.md § AC-19a
 *   - src/services/cypher/loop.ts (cypher_steps INSERTs in SCOPE + EXECUTE phases)
 *   - scripts/adr-039-dogfood-check.sh (new threshold sub-section surfacing the ratio)
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV89(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(cypher_steps)`)
    .all() as ColumnInfoRow[];

  if (!cols.some(c => c.name === 'phase')) {
    // SQLite ALTER ADD COLUMN with a CHECK constraint. The CHECK
    // applies to all future inserts; existing NULL rows are exempt
    // because `phase IS NULL` is in the allowed set.
    db.exec(
      `ALTER TABLE cypher_steps ADD COLUMN phase TEXT NULL ` +
        `CHECK(phase IS NULL OR phase IN ('scope','execute'))`,
    );
  }

  // Partial index on phase so AC-19a aggregation queries
  // (SUM(tokens_used) WHERE phase='scope' JOIN cypher_sessions...)
  // stay sub-millisecond as the table grows past dogfood-end.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_cypher_steps_phase ` +
      `ON cypher_steps(phase, session_id) WHERE phase IS NOT NULL`,
  );
}
