/**
 * v75 — ADR-038 v2.5 D2: Task memory primitive (2026-06-26).
 *
 * Adds three new tables:
 *   - tasks            — persistent named unit of work (gap 2)
 *   - task_contexts    — append-only LLM-curated rolling summaries per task
 *   - task_history     — per-dispatch outcome log for a task
 *
 * Also adds an additive nullable column to cypher_sessions:
 *   - task_id TEXT NULL — links a dispatch to its parent task
 *
 * Design decisions (Q-2.1):
 *   - tasks includes D4 worktree columns (NULL) so D4 needs no backfill migration
 *   - tasks.project defaults to 'wi' as a placeholder; D3 (Q-2.2) adds the FK
 *   - task_contexts is append-only (no UPDATE) for curation audit trail (D19)
 *   - Curator call is async post-done; no blocking writes in the hot loop path
 *
 * See:
 *   - .planning/cypher/Q-2.1-D2-task-memory.md
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D2
 *   - src/services/cypher/task-memory.ts (runtime writer)
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV75(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      posture         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'open',
      parent_task_id  TEXT NULL REFERENCES tasks(id),
      external_ref    TEXT NULL,
      project         TEXT NOT NULL DEFAULT 'wi',
      owner_user_id   TEXT NOT NULL DEFAULT 'maaz',
      created_at      INTEGER NOT NULL,
      last_touched    INTEGER NOT NULL,
      closed_at       INTEGER NULL,
      closed_reason   TEXT NULL,
      git_branch      TEXT NULL,
      worktree_path   TEXT NULL,
      worktree_status TEXT NULL
    );

    CREATE INDEX IF NOT EXISTS tasks_status_idx      ON tasks(status);
    CREATE INDEX IF NOT EXISTS tasks_project_idx     ON tasks(project);
    CREATE INDEX IF NOT EXISTS tasks_last_touched_idx ON tasks(last_touched DESC);

    CREATE TABLE IF NOT EXISTS task_contexts (
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

    CREATE TABLE IF NOT EXISTS task_history (
      task_id      TEXT NOT NULL REFERENCES tasks(id),
      dispatch_id  TEXT NOT NULL,
      outcome      TEXT NOT NULL,
      ts           INTEGER NOT NULL,
      PRIMARY KEY (task_id, dispatch_id)
    );
  `);

  // Additive column on cypher_sessions — idempotent guard
  const cols = db
    .prepare(`PRAGMA table_info(cypher_sessions)`)
    .all() as ColumnInfoRow[];
  if (!cols.some(c => c.name === 'task_id')) {
    db.exec(`ALTER TABLE cypher_sessions ADD COLUMN task_id TEXT NULL REFERENCES tasks(id)`);
  }
}
