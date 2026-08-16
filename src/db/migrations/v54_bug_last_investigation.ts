/**
 * v54 — ADR-030 Phase B (Phase 75-01).
 *
 * Two additive changes — no new tables:
 *   1. `bugs.last_investigation_id` column + index. Lets `/api/bugs/:id` show
 *      the latest investigation in O(1) instead of scanning bug_investigations.
 *      Phase 75-03's BugInvestigatorAgent writes this when it ships an
 *      investigation. Phase 75-05's UI reads it to decide whether the
 *      Investigation tab shows live data or the placeholder.
 *   2. New `model_config` row for the `bug-investigator` bucket. Lets the
 *      agent (Phase 75-03) read its model + effort + thinking config from
 *      the same registry every other Anthropic call site uses, so the
 *      /setup/models admin UI controls it just like everything else.
 *
 * The bucket-investigator default is `claude-opus-4-8 / max / adaptive`,
 * mirroring the `decide` bucket. Same work shape — multi-step structured
 * output (root_cause + files_to_change + suggested_patch) — same effort
 * tier. Per-hour cap is enforced separately in code via
 * BUG_INVESTIGATOR_MAX_PER_HOUR (Phase 75-03), not at the SQL layer.
 *
 * Idempotent: ALTER TABLE ADD COLUMN is non-idempotent in SQLite, so we
 * guard via PRAGMA table_info; INSERT OR IGNORE handles the model_config
 * row.
 *
 * Refs: docs/docs/adr/adr-030-self-healing-bug-loop.md § Phase B,
 *       .planning/phases/75-adr-030-phase-b-bug-investigator/PLAN.md § 75-01
 */
import Database from 'better-sqlite3';

export default function migrateV54(db: Database.Database): void {
  // 1. Additive column on bugs (guard for re-run idempotency).
  const cols = db.prepare(`PRAGMA table_info(bugs)`).all() as Array<{ name: string }>;
  const hasCol = cols.some(c => c.name === 'last_investigation_id');
  if (!hasCol) {
    db.exec(`ALTER TABLE bugs ADD COLUMN last_investigation_id INTEGER REFERENCES bug_investigations(id)`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bugs_last_investigation ON bugs(last_investigation_id)`);

  // 2. Seed the bug-investigator bucket. INSERT OR IGNORE so a re-run
  // doesn't clobber a user's manual override.
  db.prepare(
    `INSERT OR IGNORE INTO model_config (bucket, model, effort, thinking_mode) VALUES (?, ?, ?, ?)`,
  ).run('bug-investigator', 'claude-opus-4-8', 'max', 'adaptive');
}
