/**
 * v79 — ADR-038 v2.5 D3 slice 2 hotfix part 2: repair
 * cypher_sessions.task_id FK reference (2026-06-26).
 *
 * Companion to v78. Same root cause: v77's first cut renamed `tasks` →
 * `tasks_old_v76` without setting `legacy_alter_table = 1`, which made
 * SQLite auto-rewrite the FK clauses in dependent tables. v78 fixed
 * the small dependents (`task_history`, `task_contexts`); this fixes
 * `cypher_sessions.task_id` which has the same broken `REFERENCES
 * "tasks_old_v76"(id)` clause.
 *
 * **Why a separate migration:**
 *
 * cypher_sessions has accumulated many additive columns across prior
 * migrations (v60 .. v74). Enumerating them all in a whole-table
 * INSERT…SELECT is brittle (any forgotten column drops data). Instead
 * we use the SQLite-recommended "drop and re-add column" pattern:
 *
 *   1. ALTER TABLE cypher_sessions DROP COLUMN task_id    (loses the FK clause)
 *   2. ALTER TABLE cypher_sessions ADD COLUMN task_id     (re-adds with the correct FK)
 *
 * DROP COLUMN is supported since SQLite 3.35 (2021). better-sqlite3
 * ships with SQLite >= 3.40 today so this is safe.
 *
 * Data preserved: task_id values are saved to a temp column first,
 * restored after the drop/re-add.
 *
 * Idempotency: if cypher_sessions.task_id already references `tasks(id)`
 * correctly (fresh-install DB), this migration still runs the dance but
 * the end state is unchanged.
 *
 * See:
 *   - src/db/migrations/v78_d3_repair_task_history_fk.ts (sibling)
 *   - SQLite docs: https://www.sqlite.org/lang_altertable.html#altertabdropcol
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV79(db: Database.Database): void {
  // Guard: only run if the broken FK clause is actually present.
  // Re-running this migration is harmless thanks to the dance below,
  // but doing the dance on a clean DB is wasted I/O — skip it.
  const sessionsSql = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cypher_sessions'`)
    .get() as { sql: string } | undefined;

  if (!sessionsSql || !sessionsSql.sql.includes('tasks_old_v76')) {
    // Fresh-install DB or already-repaired DB. No-op.
    return;
  }

  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = 1');

  try {
    // Step 1: stash task_id values in a plain (non-FK) temp column.
    // This survives the DROP COLUMN. Idempotency guard: if a prior
    // failed run left this column behind, drop it first.
    const cols = db
      .prepare(`PRAGMA table_info(cypher_sessions)`)
      .all() as ColumnInfoRow[];
    const hasTemp = cols.some(c => c.name === '__task_id_temp_v79');
    if (hasTemp) {
      db.exec(`ALTER TABLE cypher_sessions DROP COLUMN __task_id_temp_v79`);
    }

    db.exec(`
      ALTER TABLE cypher_sessions ADD COLUMN __task_id_temp_v79 TEXT NULL;
      UPDATE cypher_sessions SET __task_id_temp_v79 = task_id WHERE task_id IS NOT NULL;

      -- Drop the broken FK column.
      ALTER TABLE cypher_sessions DROP COLUMN task_id;

      -- Re-add with the correct FK to tasks(id).
      ALTER TABLE cypher_sessions ADD COLUMN task_id TEXT NULL REFERENCES tasks(id);

      -- Restore the values.
      UPDATE cypher_sessions SET task_id = __task_id_temp_v79 WHERE __task_id_temp_v79 IS NOT NULL;

      -- Clean up the temp column.
      ALTER TABLE cypher_sessions DROP COLUMN __task_id_temp_v79;
    `);
  } finally {
    db.pragma('legacy_alter_table = 0');
    db.pragma('foreign_keys = ON');
  }
}
