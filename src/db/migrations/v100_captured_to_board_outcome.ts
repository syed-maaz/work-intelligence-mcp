/**
 * v100 — ADR-043 Phase 3 (Shape A, 2026-07-15): widen cypher_sessions.outcome
 * CHECK to admit 'captured_to_board'.
 *
 * # The gap this closes
 *
 * ADR-043 AC-A1 specifies that when Cypher's Stage 1 refiner classifies a
 * goal's intent as non-execute (brainstorm | plan | decide), the loop must
 * NOT dispatch Stage 2 — instead it files a PM board card via
 * `capturePmTicket()` and closes the session with:
 *
 *     outcome = 'captured_to_board'
 *
 * The v87 CHECK admits only the six execution-verdict labels:
 *
 *     'success' | 'mixed' | 'failed' | 'halted' | 'abandoned' | 'rejected_non_interactive'
 *
 * Closing a captured session under that CHECK would throw
 * `CHECK constraint failed`. `captured_to_board` is a seventh, distinct
 * lifecycle label — the session neither succeeded, failed, nor was
 * abandoned; it was intentionally re-routed to the backlog. Keeping it
 * separate keeps the Beta priors clean (a capture is not a mixed verdict on
 * skill choice — no skill ran).
 *
 * # Pattern — identical DROP COLUMN + ADD COLUMN dance as v87
 *
 * cypher_sessions carries 33+ additive columns; a hand-coded full-table
 * CREATE is the brittle path. v87 pioneered the stash → drop-index →
 * drop-column → add-widened-column → restore → recreate-index sequence for
 * this exact column. We reuse it verbatim, only changing the widened enum.
 *
 * DROP COLUMN requires SQLite >= 3.35 (this DB runs 3.51). The dependent
 * index `idx_cypher_sessions_outcome` MUST be dropped before the column or
 * SQLite raises `no such column: outcome` (the v87 bug, memory 15980).
 *
 * # Idempotency
 *
 * Guarded on the live `sqlite_master.sql` text: run only if the CHECK does
 * not already contain 'captured_to_board'. Once widened it's a no-op.
 * Survives parallel-worktree advances.
 *
 * See:
 *   - src/services/cypher/task-memory.ts (capturePmTicket — the writer)
 *   - src/db/migrations/v87_outcome_check_widen.ts (the pattern this copies)
 *   - docs/docs/adr/adr-043-pm-orchestration-layer.md (AC-A1)
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

const WIDENED_CHECK = `outcome IS NULL OR outcome IN ('success','mixed','failed','halted','abandoned','rejected_non_interactive','captured_to_board')`;

export default function migrateV100(db: Database.Database): void {
  const sessionsSql = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cypher_sessions'`)
    .get() as { sql: string } | undefined;

  if (!sessionsSql) {
    // Fresh-install DB where cypher_sessions was created past v59. No-op.
    return;
  }

  if (sessionsSql.sql.includes('captured_to_board')) {
    // Already widened. No-op.
    return;
  }

  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = 1');

  try {
    // Idempotency: clean up a stale temp column from a prior failed run.
    const cols = db
      .prepare(`PRAGMA table_info(cypher_sessions)`)
      .all() as ColumnInfoRow[];
    if (cols.some((c) => c.name === '__outcome_temp_v100')) {
      db.exec(`ALTER TABLE cypher_sessions DROP COLUMN __outcome_temp_v100`);
    }

    db.exec(`
      -- Stash outcome values in a plain (no CHECK) temp column so they
      -- survive the DROP COLUMN.
      ALTER TABLE cypher_sessions ADD COLUMN __outcome_temp_v100 TEXT NULL;
      UPDATE cypher_sessions SET __outcome_temp_v100 = outcome WHERE outcome IS NOT NULL;

      -- Drop the dependent index BEFORE the column it references.
      DROP INDEX IF EXISTS idx_cypher_sessions_outcome;

      -- Drop the narrow-CHECK column.
      ALTER TABLE cypher_sessions DROP COLUMN outcome;

      -- Re-add with the widened 7-value CHECK.
      ALTER TABLE cypher_sessions ADD COLUMN outcome TEXT CHECK(${WIDENED_CHECK});

      -- Restore values.
      UPDATE cypher_sessions SET outcome = __outcome_temp_v100 WHERE __outcome_temp_v100 IS NOT NULL;

      -- Clean up the temp column.
      ALTER TABLE cypher_sessions DROP COLUMN __outcome_temp_v100;

      -- Recreate the index against the new column.
      CREATE INDEX IF NOT EXISTS idx_cypher_sessions_outcome
        ON cypher_sessions(outcome, completed_at DESC)
        WHERE outcome IS NOT NULL;
    `);
  } finally {
    db.pragma('legacy_alter_table = 0');
    db.pragma('foreign_keys = ON');
  }
}
