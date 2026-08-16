/**
 * v77 — ADR-038 v2.5 D3 slice 2: tasks.project FK constraint (2026-06-26).
 *
 * Adds `FOREIGN KEY (project) REFERENCES projects(id) ON DELETE RESTRICT`
 * to the `tasks` table via the canonical SQLite table-rebuild pattern.
 *
 * **Why a rebuild?** SQLite cannot add a FK constraint to an existing
 * column via `ALTER TABLE`. The only supported route is:
 *   1. Disable FK enforcement (PRAGMA foreign_keys = OFF)
 *   2. Rename old table out of the way
 *   3. CREATE TABLE with the new constraint
 *   4. INSERT … SELECT to copy rows verbatim
 *   5. DROP old table
 *   6. Recreate indexes (CREATE INDEX doesn't carry over a rename)
 *   7. PRAGMA foreign_key_check — fails the migration if any orphan
 *   8. Re-enable FK enforcement
 *
 * The `BEGIN`/`COMMIT` framing is provided by the migration runner in
 * src/db/schema.ts which wraps each migration in `db.transaction()`.
 * IMPORTANT: PRAGMA foreign_keys MUST be set outside the transaction
 * (better-sqlite3 cannot toggle inside a BEGIN…COMMIT block). Slice 2
 * tolerates this by toggling the pragma at the connection level —
 * better-sqlite3 swallows the no-op when foreign_keys is already in
 * the requested state, and the table-rebuild itself runs inside the
 * outer transaction.
 *
 * **ON DELETE RESTRICT** is the chosen behaviour. Projects are
 * archival entities (D3 assumption); deleting a project should force
 * the user to handle its tasks explicitly first rather than silently
 * cascade-delete (data loss) or SET NULL (orphan tasks that can't be
 * scoped). Hard-fail on cross-table delete is the right default for
 * the scope hierarchy.
 *
 * **Orphan safety:** v76 (slice 1) backfilled every DISTINCT
 * tasks.project into `projects` via INSERT OR IGNORE. PRAGMA
 * foreign_key_check at the end of this migration is the belt-and-
 * braces verification — if it returns any rows, the transaction
 * aborts and the schema stays at v76.
 *
 * **Reproduces v75 tasks DDL exactly** — every column, default, and
 * index from src/db/migrations/v75_d2_task_memory.ts is mirrored
 * below, with only the new FK clause added. If v75 ever changes
 * (column add, index rename), this migration must be updated to match
 * OR a v78 must follow with a separate rebuild.
 *
 * See:
 *   - src/db/migrations/v75_d2_task_memory.ts (original tasks DDL)
 *   - src/db/migrations/v76_d3_projects_table.ts (projects + backfill)
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D3
 *   - SQLite docs: https://www.sqlite.org/lang_altertable.html
 *     "Making Other Kinds Of Table Schema Changes"
 */

import type Database from 'better-sqlite3';

interface ForeignKeyCheckRow {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
}

export default function migrateV77(db: Database.Database): void {
  // Disable FK enforcement for the duration of the rebuild. The
  // migration runner's outer transaction will commit/rollback the
  // schema swap atomically; the pragma flip is harmless if FKs were
  // already disabled (better-sqlite3 treats it as a no-op).
  db.pragma('foreign_keys = OFF');

  // **Critical:** turn ON legacy_alter_table BEFORE the RENAME. Without
  // this, modern SQLite (>=3.25) automatically rewrites FK references
  // in OTHER tables to point at the new name (`tasks_old_v76`), which
  // leaves `task_history.task_id REFERENCES "tasks_old_v76"(id)` and
  // `task_contexts.task_id REFERENCES "tasks_old_v76"(id)` after the
  // rebuild — silently breaking every subsequent insert to those
  // tables with "no such table: tasks_old_v76".
  //
  // The legacy behaviour leaves the FK strings unchanged, so when we
  // CREATE TABLE tasks below, the FK references in the dependent
  // tables resolve correctly to the new `tasks`. This is the
  // SQLite-documented workaround for in-place column constraint
  // changes (https://www.sqlite.org/lang_altertable.html, "9. Making
  // Other Kinds Of Table Schema Changes", step 5).
  db.pragma('legacy_alter_table = 1');

  try {
    db.exec(`
      -- Step 1: rename old table
      ALTER TABLE tasks RENAME TO tasks_old_v76;

      -- Step 2: create the new table with the FK constraint. Column
      -- shape mirrors v75 exactly; only the FOREIGN KEY clause is new.
      CREATE TABLE tasks (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        posture         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'open',
        parent_task_id  TEXT NULL REFERENCES tasks(id),
        external_ref    TEXT NULL,
        project         TEXT NOT NULL DEFAULT 'wi'
                        REFERENCES projects(id) ON DELETE RESTRICT,
        owner_user_id   TEXT NOT NULL DEFAULT 'maaz',
        created_at      INTEGER NOT NULL,
        last_touched    INTEGER NOT NULL,
        closed_at       INTEGER NULL,
        closed_reason   TEXT NULL,
        git_branch      TEXT NULL,
        worktree_path   TEXT NULL,
        worktree_status TEXT NULL
      );

      -- Step 3: copy every row verbatim. Column list is explicit so a
      -- future v75-shape change blows up loudly here rather than
      -- silently dropping data.
      INSERT INTO tasks (
        id, title, posture, status, parent_task_id, external_ref,
        project, owner_user_id, created_at, last_touched,
        closed_at, closed_reason, git_branch, worktree_path, worktree_status
      )
      SELECT
        id, title, posture, status, parent_task_id, external_ref,
        project, owner_user_id, created_at, last_touched,
        closed_at, closed_reason, git_branch, worktree_path, worktree_status
      FROM tasks_old_v76;

      -- Step 4: drop the old table.
      DROP TABLE tasks_old_v76;

      -- Step 5: recreate indexes from v75 — these did NOT survive the
      -- rename (CREATE INDEX targets the table by name and gets
      -- orphaned when the table goes away).
      CREATE INDEX IF NOT EXISTS tasks_status_idx       ON tasks(status);
      CREATE INDEX IF NOT EXISTS tasks_project_idx      ON tasks(project);
      CREATE INDEX IF NOT EXISTS tasks_last_touched_idx ON tasks(last_touched DESC);
    `);

    // Step 6: verify no orphan rows. If any tasks.project doesn't
    // resolve in projects.id, this returns one row per orphan; throw
    // and the migration runner rolls back to v76.
    const orphans = db
      .prepare(`PRAGMA foreign_key_check(tasks)`)
      .all() as ForeignKeyCheckRow[];

    if (orphans.length > 0) {
      throw new Error(
        `v77 migration: ${orphans.length} orphan rows in tasks.project — ` +
          `v76 backfill should have covered these. Orphan details: ` +
          JSON.stringify(orphans.slice(0, 5)),
      );
    }
  } finally {
    // Always re-enable FK enforcement and reset legacy_alter_table, even
    // if the rebuild threw.
    db.pragma('legacy_alter_table = 0');
    db.pragma('foreign_keys = ON');
  }
}
