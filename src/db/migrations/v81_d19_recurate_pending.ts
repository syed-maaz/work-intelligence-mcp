/**
 * v81 — ADR-038 v2.5 D19: recurate_pending_at column on tasks
 * (2026-06-26).
 *
 * D19 (Gap 15) — schema evolution policy under task memory. The
 * `task_contexts.curator_format_version` column shipped in v75
 * already tags every curated row with its format version. v80 added
 * the reader-side stale flag. This migration adds the "force
 * re-curation" affordance:
 *
 *   tasks.recurate_pending_at  INTEGER NULL — epoch-ms when a recurate
 *                                              was last requested.
 *                                              NULL = no pending request.
 *
 * The recurate flow:
 *   1. cypher_task_recurate tool (or HTTP PUT) sets
 *      recurate_pending_at = Date.now() on the task.
 *   2. Next dispatch's `curateTaskContext` checks the flag; if set,
 *      it runs the curator UNCONDITIONALLY (bypassing any
 *      "context-still-fresh" optimization slice-2+ might add).
 *   3. After a successful curation that writes a row with
 *      curator_format_version = CURRENT, the curator clears the flag
 *      (recurate_pending_at = NULL).
 *
 * Why an additive nullable column rather than a separate table:
 *   - 1:1 with tasks — never more than one pending recurate per task.
 *   - No FK relationship needed.
 *   - Idempotent set/clear with simple UPDATE.
 *   - Default NULL means existing rows are untouched (no backfill
 *     needed for hot-path queries).
 *
 * See:
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D19
 *   - src/services/cypher/task-memory.ts (recurateTaskContext + curator)
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV81(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(tasks)`)
    .all() as ColumnInfoRow[];

  if (!cols.some(c => c.name === 'recurate_pending_at')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN recurate_pending_at INTEGER NULL`);
  }
}
