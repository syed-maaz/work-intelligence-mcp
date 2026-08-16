/**
 * v53 — ADR-030 Phase A: Self-Healing Bug Loop tables.
 *
 * Slot history: originally drafted as v52 in the Phase 74 plan, renumbered to
 * v53 because Tier 2 admin UI (model_config) shipped into the v52 slot first
 * while Phase 74 was paused. See v52_model_config.ts header for the matching
 * cross-reference.
 *
 * Five tables ship together so the schema bump is atomic and Phases B/C/D
 * extend by adding columns rather than another migration:
 *
 *   bugs                  — captured exceptions (populated in Phase A)
 *   bug_occurrences       — ring buffer of timestamps per bug (populated in Phase A)
 *   bug_investigations    — Phase B target (empty in Phase A)
 *   auto_merge_blocklist  — Phase D target (empty in Phase A)
 *   auto_merge_audit      — Phase D target (empty in Phase A)
 *
 * Severity is recomputed against bug_occurrences on every UPSERT — never
 * derived from occurrence_count + last_seen_at (Review Finding #1).
 *
 * The bugs.source CHECK enum includes 'bug-investigator' so Phase B's polling
 * SELECT can use `WHERE source != 'bug-investigator'` as the recursion guard
 * without another migration.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS pattern. Foreign keys via REFERENCES
 * with ON DELETE CASCADE for bug_occurrences (occurrences are meaningless
 * without their parent bug).
 *
 * Refs: docs/docs/adr/adr-030-self-healing-bug-loop.md (Phase A scope +
 *       Review Findings 2026-05-30); .planning/phases/74-adr-030-phase-a-...
 */
import Database from 'better-sqlite3';

export default function migrateV53(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bugs (
      id INTEGER PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL CHECK (source IN
        ('bridge','agent','web-ui','sync','bug-investigator')),
      error_name TEXT NOT NULL,
      message TEXT NOT NULL,
      top_frame TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new','investigating','proposed','auto-merged','resolved','wont-fix')),
      severity TEXT NOT NULL DEFAULT 'low'
        CHECK (severity IN ('low','medium','high')),
      context_json TEXT,
      investigation_attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_bugs_status     ON bugs(status);
    CREATE INDEX IF NOT EXISTS idx_bugs_last_seen  ON bugs(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_bugs_source     ON bugs(source);

    CREATE TABLE IF NOT EXISTS bug_occurrences (
      id INTEGER PRIMARY KEY,
      bug_id INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
      seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bug_occurrences_bug_seen
      ON bug_occurrences(bug_id, seen_at DESC);

    CREATE TABLE IF NOT EXISTS bug_investigations (
      id INTEGER PRIMARY KEY,
      bug_id INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
      root_cause TEXT NOT NULL,
      files_to_change TEXT NOT NULL,
      lines_changed INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
      suggested_patch TEXT,
      decided_at TEXT NOT NULL,
      brain_decision_id INTEGER REFERENCES brain_decisions(id)
    );

    CREATE TABLE IF NOT EXISTS auto_merge_blocklist (
      fingerprint TEXT PRIMARY KEY REFERENCES bugs(fingerprint),
      reason TEXT NOT NULL,
      blocked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auto_merge_audit (
      id INTEGER PRIMARY KEY,
      bug_id INTEGER NOT NULL REFERENCES bugs(id),
      fingerprint TEXT NOT NULL,
      merged_at TEXT NOT NULL,
      commit_sha TEXT,
      reverted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auto_merge_audit_merged_at
      ON auto_merge_audit(merged_at DESC);
  `);
}
