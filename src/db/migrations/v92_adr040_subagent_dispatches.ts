/**
 * v92 — ADR-040 commit 3 (2026-06-30): subagent_dispatches audit table.
 *
 * The audit ledger for every skill dispatch through runSkillSubagent().
 * Every /wi <goal> invocation that resolves to a wi-* skill writes a
 * row here — first as 'pending', then transitions through 'running'
 * to a terminal 'succeeded' | 'failed' | 'timed_out'. Closes GAP-001
 * at the audit-visibility layer: STUB handlers used to swallow their
 * inputs; now every dispatch has a row that shows what was asked, what
 * came back, and how long it took.
 *
 * tier_3_confirmed carries the ADR-038 D5 permissions-ladder verdict
 * for mutating skills. Populated by callers when destructive skills
 * (wi-bug-resolve, wi-update-context, wi-sync, wi-save-to-ticket) are
 * gated behind an explicit user confirmation. Non-mutating skills
 * leave it at 0.
 *
 * See:
 *   - .planning/adr-040-commit-3-plan.md
 *   - src/services/cypher/skill-dispatch.ts (the writer)
 *   - ADR-040 §3.5 subagent_dispatches
 */

import type Database from 'better-sqlite3';

export default function migrateV92(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subagent_dispatches (
      id                  TEXT PRIMARY KEY,
      session_id          TEXT    NOT NULL REFERENCES cypher_sessions(session_id) ON DELETE CASCADE,
      task_id             TEXT    NULL REFERENCES tasks(id) ON DELETE SET NULL,
      skill_name          TEXT    NOT NULL,
      args_json           TEXT    NOT NULL,
      result_json         TEXT    NULL,
      output_summary      TEXT    NULL,
      status              TEXT    NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','running','succeeded','failed','timed_out')),
      tier_3_confirmed    INTEGER NOT NULL DEFAULT 0 CHECK(tier_3_confirmed IN (0,1)),
      tokens_used         INTEGER NULL,
      dispatched_at       INTEGER NOT NULL,
      completed_at        INTEGER NULL,
      error_text          TEXT    NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS subagent_dispatches_session_idx ` +
      `ON subagent_dispatches(session_id, dispatched_at DESC)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS subagent_dispatches_skill_idx ` +
      `ON subagent_dispatches(skill_name, status)`,
  );
}
