/**
 * v103 — drop dead tables (storage audit cleanup, 2026-07-18).
 *
 * # Why
 *
 * The 2026-07-18 storage audit (.planning/storage-retrieval-audit/) + the
 * senior-review verification pass identified a set of tables that are provably
 * dead: 0 rows AND no live writer AND no live reader in src/. They are pure
 * schema debris — cognitive load and a handful of index pages. Verified each
 * against the live DB (0 rows) and grep of src/ (no non-migration writer/reader)
 * before inclusion here.
 *
 * # What's dropped (11 tables)
 *
 * Truly dead (no writer, no reader):
 *   auto_merge_audit, auto_merge_blocklist     — ADR-030 Phase D never shipped
 *   cap13_birth_decisions                      — ADR-037 D21 α-FULL deferred (LITE shipped instead)
 *   code_diff_outcomes, lessons_learned,
 *     pr_review_comments, skill_proposals       — ADR-032 persona loop (~3% built, pipeline never wired)
 *   worker_reassignment_log                    — ADR-040 crash-recovery, never triggered
 *   panel_agent_config                         — ADR-040 panel config, only a schema comment references it
 *
 * Superseded, migrated off first (both 0 rows):
 *   decisions   — legacy per-topic store, superseded by brain_decisions (ADR-024).
 *                 Its only live reader (src/tools/digest.ts getDailyDigest) was
 *                 migrated to return [] in the same commit as this migration.
 *   questions   — legacy per-topic questions, superseded by notebook-chat.
 *                 digest.ts reader migrated to [] in the same commit.
 *
 * # What's explicitly NOT dropped (audit flagged, verification KEPT)
 *
 *   plan_shape_gap_observed — 0 rows but has a LIVE gated writer
 *     (src/services/cypher/cap13-lite.ts:151, env CAP13_LITE_ENABLED=1). 0-row
 *     because the gate predicate rarely fires, NOT because it's dead. Dropping
 *     would break the CAP-13-LITE hook when it fires. Two audits mislabeled it
 *     drop-safe; the code says otherwise.
 *
 *   cypher_sessions_summary — 0 rows, write-only. BUT gc.ts:255 has a live
 *     INSERT OR REPLACE writer (the weekly rollup). Dropping it would make every
 *     GC run log a 'no such table' error. Removing the rollup is a separate GC
 *     refactor; not worth coupling to this cleanup. Kept as-is.
 *
 * # Idempotency
 *
 * DROP TABLE IF EXISTS — re-running is a no-op. Pure synchronous DDL. Dropping
 * a table also drops its indexes. Foreign keys are OFF at the DB level, so no
 * cascade side effects on drop.
 *
 * See:
 *   - .planning/storage-retrieval-audit/SENIOR-REVIEW-2026-07-18.md (verification)
 *   - .planning/storage-retrieval-audit/dead-tables-root-cause.md (per-table trace)
 *   - src/tools/digest.ts (decisions/questions reader migration, same commit)
 */

import type Database from 'better-sqlite3';

export default function migrateV103(db: Database.Database): void {
  const deadTables = [
    'auto_merge_audit',
    'auto_merge_blocklist',
    'cap13_birth_decisions',
    'code_diff_outcomes',
    'lessons_learned',
    'pr_review_comments',
    'skill_proposals',
    'worker_reassignment_log',
    'panel_agent_config',
    'decisions',
    'questions',
  ];
  for (const t of deadTables) {
    db.exec(`DROP TABLE IF EXISTS ${t};`);
  }
}
