/**
 * v78 — ADR-038 v2.5 D3 slice 2 hotfix: repair task_history /
 * task_contexts FK references (2026-06-26).
 *
 * **The bug v77 caused on real DBs:**
 *
 * v77's table-rebuild renamed `tasks` → `tasks_old_v76` before creating
 * the new `tasks` table. The first cut of v77 did NOT set
 * `PRAGMA legacy_alter_table = 1` before that rename. Modern SQLite
 * (>=3.25) defaults to rewriting FK references in OTHER tables when a
 * referenced table is renamed — so `task_history` and `task_contexts`
 * (both `REFERENCES tasks(id)` at v75 time) had their FK clauses
 * silently rewritten to `REFERENCES "tasks_old_v76"(id)`. v77 then
 * dropped `tasks_old_v76`, leaving those FKs pointing at a non-existent
 * table. Every subsequent INSERT to `task_history` or `task_contexts`
 * fails with "no such table: main.tasks_old_v76".
 *
 * The v77 source was patched in the same session to add
 * `legacy_alter_table = 1` — so fresh DBs migrating v75 → v77 directly
 * are fine. But any DB that ran the broken v77 first (real bridge DB
 * at ~/.work-intelligence-mcp/data.db) needs this in-place repair.
 *
 * **What this migration does:**
 *
 * Rebuilds `task_history` and `task_contexts` so their FK clauses point
 * back at `tasks(id)`. Both tables are small (one row per dispatch,
 * one row per curator pass) so the rebuild is cheap.
 *
 * `cypher_sessions.task_id` suffered the same FK rewrite — that's
 * repaired by v79 (separate migration because cypher_sessions has many
 * additive columns from prior migrations and warrants its own commit
 * for revertability).
 *
 * Idempotency: if the FKs already reference `tasks(id)` correctly
 * (fresh-install DB that ran v77 post-fix), this migration is a no-op
 * by virtue of the data-copy being verbatim. The structural rewrite
 * is still cheap and the outcome is unchanged.
 *
 * **Slice 2 wraps up here.** Future D3 slices (slice 3: cypher_project_create
 * tool; slice 4+: brain/palace/skill_priors project scoping) do not depend
 * on this hotfix.
 *
 * See:
 *   - src/db/migrations/v77_d3_tasks_project_fk.ts (the original rebuild)
 *   - SQLite docs: https://www.sqlite.org/pragma.html#pragma_legacy_alter_table
 */

import type Database from 'better-sqlite3';

export default function migrateV78(db: Database.Database): void {
  // Same gotcha as v77 — set legacy_alter_table BEFORE any ALTER TABLE
  // RENAME so SQLite doesn't auto-rewrite FK strings in dependent
  // tables. (Here the dependents would be empty, but defensive.)
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = 1');

  try {
    db.exec(`
      -- task_history rebuild
      ALTER TABLE task_history RENAME TO task_history_old_v77;

      CREATE TABLE task_history (
        task_id      TEXT NOT NULL REFERENCES tasks(id),
        dispatch_id  TEXT NOT NULL,
        outcome      TEXT NOT NULL,
        ts           INTEGER NOT NULL,
        PRIMARY KEY (task_id, dispatch_id)
      );

      INSERT INTO task_history (task_id, dispatch_id, outcome, ts)
      SELECT task_id, dispatch_id, outcome, ts FROM task_history_old_v77;

      DROP TABLE task_history_old_v77;

      -- task_contexts rebuild
      ALTER TABLE task_contexts RENAME TO task_contexts_old_v77;

      CREATE TABLE task_contexts (
        task_id                 TEXT NOT NULL REFERENCES tasks(id),
        version                 INTEGER NOT NULL,
        context_summary         TEXT NOT NULL,
        open_questions          TEXT NULL,
        things_tried            TEXT NULL,
        curator_dispatch_id     TEXT NULL,
        curator_format_version  INTEGER NOT NULL DEFAULT 1,
        created_at              INTEGER NOT NULL,
        PRIMARY KEY (task_id, version)
      );

      INSERT INTO task_contexts (
        task_id, version, context_summary, open_questions, things_tried,
        curator_dispatch_id, curator_format_version, created_at
      )
      SELECT
        task_id, version, context_summary, open_questions, things_tried,
        curator_dispatch_id, curator_format_version, created_at
      FROM task_contexts_old_v77;

      DROP TABLE task_contexts_old_v77;
    `);
  } finally {
    db.pragma('legacy_alter_table = 0');
    db.pragma('foreign_keys = ON');
  }
}
