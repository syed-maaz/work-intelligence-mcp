/**
 * v84 — ADR-038 v2.5 D4: tool-layer boundary audit columns
 * (2026-06-26).
 *
 * D4 (Gap 8 + Gap 19, locked pair) ships per-task git worktrees plus
 * tool-layer boundary enforcement. THIS slice is substrate only —
 * the two audit columns the boundary check writes to:
 *
 *   cypher_steps.path_arg            TEXT NULL — resolved (absolute,
 *                                                canonicalized) path
 *                                                for any path-bearing
 *                                                tool call
 *   cypher_steps.boundary_violation  TEXT NULL — reason code when a
 *                                                tool call was REJECTED
 *                                                by the boundary check.
 *                                                One of:
 *                                                  absolute_path_outside_root
 *                                                  path_traversal
 *                                                  symlink_escape
 *                                                  subprocess_cwd_mismatch
 *
 * Both columns are nullable. Non-path-bearing tool calls (e.g.
 * brain_recall, cypher_record_outcome) leave both NULL.
 *
 * **Why additive ALTER instead of table-rebuild:** these are pure
 * NULL columns with no CHECK widening; ALTER TABLE works. The v77/v78
 * lesson (legacy_alter_table=1 around rename) is moot here — no
 * rename, no FK rewrite hazard.
 *
 * **What's NOT in this slice:**
 *   - Actual worktree creation. `git worktree add` wiring needs the
 *     user-facing repos/ restructure migration; that's a separate
 *     slice gated on Maaz's readiness.
 *   - The runtime checker. src/services/cypher/boundary.ts ships
 *     in this slice as pure-function predicates; the loop hook
 *     (calling checkBoundary before each tool call and writing the
 *     audit columns) is slice 2.
 *   - tasks.worktree_path / .worktree_status / .git_branch wiring.
 *     Those columns already exist (v75 introduced them as nullable
 *     forward-compat); they stay NULL until the worktree wiring
 *     slice flips them on.
 *
 * See:
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D4
 *   - src/services/cypher/boundary.ts (predicate functions)
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV84(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(cypher_steps)`)
    .all() as ColumnInfoRow[];
  const names = new Set(cols.map(c => c.name));
  if (!names.has('path_arg')) {
    db.exec(`ALTER TABLE cypher_steps ADD COLUMN path_arg TEXT NULL`);
  }
  if (!names.has('boundary_violation')) {
    db.exec(`ALTER TABLE cypher_steps ADD COLUMN boundary_violation TEXT NULL`);
  }
}
