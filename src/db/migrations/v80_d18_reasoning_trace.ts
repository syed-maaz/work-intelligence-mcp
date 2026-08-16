/**
 * v80 — ADR-038 v2.5 D18: reasoning-trace observability (2026-06-26).
 *
 * D18 closes Gap 16 — "why did Cypher do that?" should be a one-row
 * SQL query, not a re-load of the full message history.
 *
 * **What this migration adds to `cypher_steps`:**
 *   - `reasoning_trace TEXT NULL` — the text block (model's "thinking")
 *     immediately preceding the tool_use block. Truncated to 4KB at
 *     capture-time. NULL for non-tool_use rows.
 *   - `controller_model TEXT NULL` — which Anthropic model produced the
 *     tool_use pick. Forward-compat for D15 (per-tool model routing).
 *     NULL for legacy pipeline rows.
 *
 * **And widens the stage CHECK constraint:**
 *   - Adds `'tool_use'` to the set of valid stage values. The loop
 *     writes one cypher_steps row per tool_use block with this stage;
 *     the legacy pipeline (`run.ts`) keeps using its existing 9-stage
 *     vocabulary.
 *
 * **Why a table-rebuild:** SQLite cannot ALTER an existing CHECK
 * constraint via `ALTER TABLE`. We rebuild `cypher_steps` with the
 * widened CHECK, the two new columns, and the existing data. Same
 * pattern as v77 — `legacy_alter_table = 1` MUST be set before the
 * rename or SQLite would auto-rewrite FK references in other tables.
 * (Defensive: today nothing FKs back to cypher_steps, but the rule
 * holds regardless.)
 *
 * **Orphan safety:** PRAGMA foreign_key_check after the rebuild verifies
 * cypher_steps's own FK to cypher_sessions still resolves. If any
 * orphan rows surface, the migration aborts and v80 doesn't apply.
 *
 * See:
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D18
 *   - src/db/migrations/v77_d3_tasks_project_fk.ts (same rebuild
 *     pattern; v77's header documents the legacy_alter_table gotcha)
 *   - src/services/cypher/loop.ts (capture site for the new columns)
 */

import type Database from 'better-sqlite3';

interface ForeignKeyCheckRow {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
}

export default function migrateV80(db: Database.Database): void {
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = 1');

  try {
    db.exec(`
      -- Rename old table out of the way.
      ALTER TABLE cypher_steps RENAME TO cypher_steps_old_v79;

      -- Recreate with the widened CHECK + the two new columns.
      CREATE TABLE cypher_steps (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id        TEXT    NOT NULL,
        stage             TEXT    NOT NULL CHECK(stage IN
                           ('investigate','ask','research','plan','execute',
                            'quality_gate','confirm','surface','record',
                            'tool_use')),
        stage_index       INTEGER NOT NULL,
        status            TEXT    NOT NULL CHECK(status IN
                           ('entered','completed','skipped','failed')),
        payload           TEXT,
        tokens_used       INTEGER NOT NULL DEFAULT 0,
        duration_ms       INTEGER,
        created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
        confirmation_method TEXT,
        reasoning_trace   TEXT NULL,
        controller_model  TEXT NULL,
        FOREIGN KEY (session_id) REFERENCES cypher_sessions(session_id) ON DELETE CASCADE
      );

      -- Copy data verbatim — the two new columns default to NULL on
      -- rows from the old table.
      INSERT INTO cypher_steps (
        id, session_id, stage, stage_index, status, payload,
        tokens_used, duration_ms, created_at, confirmation_method
      )
      SELECT
        id, session_id, stage, stage_index, status, payload,
        tokens_used, duration_ms, created_at, confirmation_method
      FROM cypher_steps_old_v79;

      DROP TABLE cypher_steps_old_v79;

      -- Recreate the index (CREATE INDEX is table-name-bound and gets
      -- orphaned when the table is renamed away).
      CREATE INDEX IF NOT EXISTS idx_cypher_steps_session
        ON cypher_steps(session_id, stage_index);
    `);

    const orphans = db
      .prepare(`PRAGMA foreign_key_check(cypher_steps)`)
      .all() as ForeignKeyCheckRow[];

    if (orphans.length > 0) {
      throw new Error(
        `v80 migration: ${orphans.length} orphan rows in cypher_steps.session_id — ` +
          `existing data referenced sessions that no longer exist. Orphan details: ` +
          JSON.stringify(orphans.slice(0, 5)),
      );
    }
  } finally {
    db.pragma('legacy_alter_table = 0');
    db.pragma('foreign_keys = ON');
  }
}
