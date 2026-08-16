/**
 * v56 — ADR-030 Phase C (Phase 76-01) — BugResolverAgent foundation.
 *
 * Three changes ship together:
 *   1. `bugs.status` CHECK enum widens with three new values:
 *      'auto-resolved' | 'resolving' | 'unable-to-resolve'.
 *      Implemented via SQLite's create-new-copy-drop-rename pattern because
 *      SQLite does NOT support `ALTER TABLE … ALTER CHECK`. The ID space and
 *      every column's default + non-null + FK reference is preserved.
 *   2. New `bug_resolutions` table — audit trail of resolver runs. One row
 *      per resolve attempt regardless of outcome; `commit_sha` is set on
 *      success, `failure_reason` is set on `unable-to-resolve`.
 *   3. New `model_config` row for the `bug-resolver` bucket. RESERVED for
 *      Phase 77 brain-escalation; Phase 76's local-apply path doesn't call
 *      the brain. The row is seeded so the /setup/models admin UI shows the
 *      bucket and the §16 smoke can count 8 buckets.
 *
 * The resolver bucket default is `claude-opus-latest / max / off`, mirroring
 * the bug-investigator bucket. thinking_mode='off' because every Anthropic
 * call site that the resolver might eventually trigger uses tool_choice to
 * force structured output — Anthropic rejects HTTP 400 ("Thinking may not be
 * enabled when tool_choice forces tool use") on that combination.
 *
 * Idempotent:
 *   - The status enum widen is guarded by a `pragma_table_info` introspection
 *     of the bugs.status CHECK definition; if the new values are already
 *     present (re-run after partial failure, or running v56 twice in a row),
 *     the create-new-copy-drop-rename block is skipped.
 *   - CREATE TABLE IF NOT EXISTS for bug_resolutions.
 *   - INSERT OR IGNORE for the model_config row (don't clobber a manual override).
 *
 * Refs: docs/docs/adr/adr-030-self-healing-bug-loop.md § Phase C,
 *       .planning/phases/76-bug-resolver-agent/PLAN.md § 76-01.
 */
import Database from 'better-sqlite3';

export default function migrateV56(db: Database.Database): void {
  // ── 1. Widen bugs.status CHECK enum ────────────────────────────────────────
  //
  // SQLite stores CHECK constraints in the table's CREATE statement. We read
  // it back from sqlite_master and skip the rebuild if the new values are
  // already present (idempotent re-run guard).
  const tableSql = (db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='bugs'`)
    .get() as { sql: string } | undefined)?.sql ?? '';
  const alreadyWidened =
    tableSql.includes("'auto-resolved'") &&
    tableSql.includes("'resolving'") &&
    tableSql.includes("'unable-to-resolve'");

  if (!alreadyWidened) {
    // SQLite recipe for ALTER TABLE-with-CHECK-rebuild when other tables
    // hold FKs against the rebuilt one:
    //
    //   `PRAGMA defer_foreign_keys = ON` defers FK checks until COMMIT,
    //   but SQLite tracks FK constraints by *table object identity*, not
    //   data — once we DROP TABLE bugs and rename bugs__new, every FK
    //   pointing at the old `bugs` is dead. defer_foreign_keys is only
    //   enough when no FK targets the rebuilt table.
    //
    //   Four tables FK against `bugs`:
    //     - bug_occurrences      (REFERENCES bugs(id) ON DELETE CASCADE)
    //     - bug_investigations   (REFERENCES bugs(id) ON DELETE CASCADE)
    //     - auto_merge_blocklist (REFERENCES bugs(fingerprint))   — empty pre-Phase-D
    //     - auto_merge_audit     (REFERENCES bugs(id))            — empty pre-Phase-D
    //
    //   Fix: stash each table's data in a temp copy, drop it, recreate it
    //   with the FK pointing at the new bugs table, restore the data, drop
    //   the stash. Order matters: we tear down ALL dependents first, then
    //   bugs itself, then rebuild bugs, then rebuild dependents on the new
    //   bugs. Idempotent re-runs see `alreadyWidened` and skip the whole
    //   block.
    db.pragma('defer_foreign_keys = ON');

    db.exec(`
      -- ── 1. Stash dependent-table data ───────────────────────────────────
      CREATE TABLE bug_occurrences__stash AS SELECT * FROM bug_occurrences;
      CREATE TABLE bug_investigations__stash AS SELECT * FROM bug_investigations;
      CREATE TABLE auto_merge_blocklist__stash AS SELECT * FROM auto_merge_blocklist;
      CREATE TABLE auto_merge_audit__stash AS SELECT * FROM auto_merge_audit;

      -- ── 2. Drop FK-holding tables in reverse-dep order ──────────────────
      DROP TABLE auto_merge_audit;
      DROP TABLE auto_merge_blocklist;
      DROP TABLE bug_investigations;
      DROP TABLE bug_occurrences;

      -- ── 3. Rebuild bugs with the widened CHECK ──────────────────────────
      CREATE TABLE bugs__new (
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
          CHECK (status IN (
            'new','investigating','proposed','auto-merged','resolved','wont-fix',
            'auto-resolved','resolving','unable-to-resolve'
          )),
        severity TEXT NOT NULL DEFAULT 'low'
          CHECK (severity IN ('low','medium','high')),
        context_json TEXT,
        investigation_attempts INTEGER NOT NULL DEFAULT 0,
        last_investigation_id INTEGER,
        severity_override TEXT
          CHECK (severity_override IS NULL OR severity_override IN ('low','medium','high')),
        severity_override_reason TEXT,
        severity_override_at TEXT
      );

      INSERT INTO bugs__new (
        id, fingerprint, source, error_name, message, top_frame,
        first_seen_at, last_seen_at, occurrence_count, status, severity,
        context_json, investigation_attempts, last_investigation_id,
        severity_override, severity_override_reason, severity_override_at
      )
      SELECT
        id, fingerprint, source, error_name, message, top_frame,
        first_seen_at, last_seen_at, occurrence_count, status, severity,
        context_json, investigation_attempts, last_investigation_id,
        severity_override, severity_override_reason, severity_override_at
      FROM bugs;

      DROP TABLE bugs;
      ALTER TABLE bugs__new RENAME TO bugs;

      -- ── 4. Recreate dependent tables (FK now points at new bugs) ────────
      CREATE TABLE bug_occurrences (
        id INTEGER PRIMARY KEY,
        bug_id INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
        seen_at TEXT NOT NULL
      );
      INSERT INTO bug_occurrences SELECT * FROM bug_occurrences__stash;
      DROP TABLE bug_occurrences__stash;

      CREATE TABLE bug_investigations (
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
      INSERT INTO bug_investigations SELECT * FROM bug_investigations__stash;
      DROP TABLE bug_investigations__stash;

      CREATE TABLE auto_merge_blocklist (
        fingerprint TEXT PRIMARY KEY REFERENCES bugs(fingerprint),
        reason TEXT NOT NULL,
        blocked_at TEXT NOT NULL
      );
      INSERT INTO auto_merge_blocklist SELECT * FROM auto_merge_blocklist__stash;
      DROP TABLE auto_merge_blocklist__stash;

      CREATE TABLE auto_merge_audit (
        id INTEGER PRIMARY KEY,
        bug_id INTEGER NOT NULL REFERENCES bugs(id),
        fingerprint TEXT NOT NULL,
        merged_at TEXT NOT NULL,
        commit_sha TEXT,
        reverted_at TEXT
      );
      INSERT INTO auto_merge_audit SELECT * FROM auto_merge_audit__stash;
      DROP TABLE auto_merge_audit__stash;

      -- ── 5. Restore indexes ──────────────────────────────────────────────
      CREATE INDEX IF NOT EXISTS idx_bugs_status     ON bugs(status);
      CREATE INDEX IF NOT EXISTS idx_bugs_last_seen  ON bugs(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_bugs_source     ON bugs(source);
      CREATE INDEX IF NOT EXISTS idx_bugs_last_investigation
        ON bugs(last_investigation_id);
      CREATE INDEX IF NOT EXISTS idx_bug_occurrences_bug_seen
        ON bug_occurrences(bug_id, seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_auto_merge_audit_merged_at
        ON auto_merge_audit(merged_at DESC);
    `);
  }

  // ── 2. New bug_resolutions audit table ────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS bug_resolutions (
      id INTEGER PRIMARY KEY,
      bug_id INTEGER NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
      attempt_at TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('auto-resolved','unable-to-resolve')),
      cwd TEXT NOT NULL,
      files_changed TEXT,
      commit_sha TEXT,
      failure_reason TEXT,
      brain_decision_id INTEGER REFERENCES brain_decisions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_bug_resolutions_bug_attempt
      ON bug_resolutions(bug_id, attempt_at DESC);
  `);

  // ── 3. Seed bug-resolver model_config row ─────────────────────────────────
  // Reserved for Phase 77 brain-escalation; not used by Phase 76's local-apply
  // path. INSERT OR IGNORE so re-runs don't clobber a manual override.
  db.prepare(
    `INSERT OR IGNORE INTO model_config (bucket, model, effort, thinking_mode) VALUES (?, ?, ?, ?)`,
  ).run('bug-resolver', 'claude-opus-latest', 'max', 'off');
}
