/**
 * v87 — ADR-038 v2.5 A1 (2026-06-28): widen cypher_sessions.outcome CHECK
 * to admit ('halted','abandoned','rejected_non_interactive').
 *
 * # The gap this closes
 *
 * The `cypher_record_outcome` tool's input schema (in cypher/tool-catalog.ts)
 * accepts six values:
 *
 *     'success' | 'mixed' | 'failed' | 'halted' | 'abandoned' | 'rejected_non_interactive'
 *
 * The DB CHECK constraint introduced in v59 admits only three:
 *
 *     CHECK(outcome IS NULL OR outcome IN ('success','mixed','failed'))
 *
 * The boot-reaper (src/services/cypher/boot-reaper.ts) currently writes
 * `outcome='mixed'` for orphan-on-reboot sessions because that's the only
 * non-failure label the CHECK admits. That pollutes the Beta priors —
 * crashes count as "mixed", which is a real verdict reserved for sessions
 * the user marked partially-useful. We want a dedicated `abandoned` label
 * so signal-hygiene queries can exclude crash-orphans without losing real
 * `mixed` verdicts.
 *
 * v87 widens the CHECK to the full six-value enum. The accompanying
 * boot-reaper flip (same commit) switches its INSERT to `outcome='abandoned'`.
 *
 * # Why DROP COLUMN + ADD COLUMN (not full table rebuild)
 *
 * cypher_sessions has accumulated many additive columns across migrations
 * v59 .. v85. Enumerating them all in a hand-coded CREATE TABLE is the
 * most-brittle path (any forgotten column drops data on rebuild). The
 * v79 migration already pioneered the DROP COLUMN + ADD COLUMN dance for
 * this exact table when it needed to change column semantics (FK clause).
 *
 * We use the same pattern here:
 *
 *   1. PRAGMA legacy_alter_table = 1; PRAGMA foreign_keys = OFF
 *   2. Stash `outcome` values into a temp column (DROP COLUMN would drop them)
 *   3. ALTER TABLE cypher_sessions DROP COLUMN outcome
 *   4. ALTER TABLE cypher_sessions ADD COLUMN outcome TEXT CHECK(...widened...)
 *   5. UPDATE cypher_sessions SET outcome = __outcome_temp_v87
 *   6. DROP the temp column
 *   7. Restore pragmas
 *
 * DROP COLUMN requires SQLite >= 3.35. better-sqlite3 ships with >= 3.40
 * (this DB runs 3.51), so it's safe.
 *
 * # Index handling
 *
 * `idx_cypher_sessions_outcome` (created in v59) is built on the
 * `outcome` column. SQLite refuses to DROP COLUMN while a dependent
 * index exists — it raises `error in index ... after drop column: no
 * such column: outcome`. So we DROP INDEX before DROP COLUMN, then
 * recreate the index after the new column is in place.
 *
 * # Idempotency
 *
 * Guarded on the live `sqlite_master.sql` text for `cypher_sessions` — we
 * only run the dance if the narrow 3-value CHECK is still present. Once
 * widened, the migration is a no-op. Survives parallel-worktree advances.
 *
 * # Why this is v87 and not the v77 the handoff mentioned
 *
 * The handoff doc was written before the ADR-039 substrate landed v85/v86.
 * `CURRENT_SCHEMA_VERSION` is at 86 on master `5403b54`. v87 is the next
 * free slot. The handoff also suggested hand-coded full-table rebuild;
 * after re-reading v79's pattern, DROP+ADD is the lower-risk choice for
 * this table specifically (substrate stability is the priority — we have
 * 33+ columns to preserve).
 *
 * See:
 *   - src/services/cypher/boot-reaper.ts (flips to outcome='abandoned')
 *   - src/services/cypher/tool-catalog.ts (the 6-value enum source)
 *   - src/db/migrations/v59_cypher_tables.ts (original 3-value CHECK)
 *   - src/db/migrations/v79_d3_repair_cypher_sessions_task_id_fk.ts (DROP+ADD pattern)
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

const WIDENED_CHECK = `outcome IS NULL OR outcome IN ('success','mixed','failed','halted','abandoned','rejected_non_interactive')`;

export default function migrateV87(db: Database.Database): void {
  // Guard: only run if the narrow 3-value CHECK is still present.
  // Once widened, re-running this migration is harmless but doing the
  // DROP+ADD dance on an already-correct DB is wasted I/O.
  const sessionsSql = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cypher_sessions'`)
    .get() as { sql: string } | undefined;

  if (!sessionsSql) {
    // Fresh-install DB where cypher_sessions hasn't been created yet
    // (CURRENT_SCHEMA_VERSION jumped past v59). No-op.
    return;
  }

  if (sessionsSql.sql.includes('rejected_non_interactive')) {
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
    const hasTemp = cols.some(c => c.name === '__outcome_temp_v87');
    if (hasTemp) {
      db.exec(`ALTER TABLE cypher_sessions DROP COLUMN __outcome_temp_v87`);
    }

    db.exec(`
      -- Stash outcome values in a plain (no CHECK) temp column so they
      -- survive the DROP COLUMN.
      ALTER TABLE cypher_sessions ADD COLUMN __outcome_temp_v87 TEXT NULL;
      UPDATE cypher_sessions SET __outcome_temp_v87 = outcome WHERE outcome IS NOT NULL;

      -- Drop the dependent index BEFORE the column it references —
      -- SQLite refuses DROP COLUMN while an index references the
      -- target column.
      DROP INDEX IF EXISTS idx_cypher_sessions_outcome;

      -- Drop the narrow-CHECK column.
      ALTER TABLE cypher_sessions DROP COLUMN outcome;

      -- Re-add with the widened 6-value CHECK.
      ALTER TABLE cypher_sessions ADD COLUMN outcome TEXT CHECK(${WIDENED_CHECK});

      -- Restore values.
      UPDATE cypher_sessions SET outcome = __outcome_temp_v87 WHERE __outcome_temp_v87 IS NOT NULL;

      -- Clean up the temp column.
      ALTER TABLE cypher_sessions DROP COLUMN __outcome_temp_v87;

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
