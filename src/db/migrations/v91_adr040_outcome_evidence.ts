/**
 * v91 — ADR-040 commit 2 (2026-06-30): outcome-honest DoD contract at SQL layer.
 *
 * Adds the Definition-of-Done substrate that closes GAP-002 Cause 3
 * (Cypher discipline testing intent rather than delivered value).
 *
 * # New tables
 *
 *   outcome_evidence  — the outcome-side ledger. Every session-close,
 *                       panel review, smoke run, or user click that
 *                       claims "the flow works" writes a row here with
 *                       a tier (0-7), a verified_via tag, and a verdict.
 *                       Three CHECK constraints enforce the DoD
 *                       invariants at INSERT time:
 *                         (a) tier > 0 requires created_by_session_id
 *                         (b) tier > 0 requires
 *                             created_by_session_id != session_id
 *                             (session cannot self-grade)
 *                         (c) verified_via='user_observed' requires
 *                             both verification_output_hash AND
 *                             non_fixture_identifier to be non-null
 *                             (the "someone actually ran it and captured
 *                             the output against a real target" rule)
 *
 *   cost_ledger       — panel-review spend tracking. Populated per LLM
 *                       API response starting in commit 5. §6.5 uses
 *                       this for the $15/week cap.
 *
 *   verifier_health   — verifier-of-verifiers cron output (table only;
 *                       cron scripts land in commit 3). AC-S8/S13/S14
 *                       verify recent rows exist per verifier_name.
 *
 * # New triggers (the load-bearing DoD gate)
 *
 *   tasks_done_requires_user_observed         (BEFORE UPDATE)
 *   tasks_insert_done_requires_user_observed  (BEFORE INSERT)
 *
 * Both refuse any transition/insert that puts a task at
 * kanban_column='done' unless a matching outcome_evidence row exists
 * with verified_via='user_observed' AND verdict='pass' AND
 * author-independence AND non-null hash + non-fixture-id.
 *
 * Author-independence is re-asserted at the trigger boundary (in
 * addition to the row-level CHECK) as defense-in-depth. Rationale in
 * ADR-040 §3.4: catches copy-paste bugs that swap session_id and
 * created_by_session_id at evidence-write time, and any hypothetical
 * INSERT path that bypasses the row-level CHECKs.
 *
 * The companion INSERT trigger closes the direct-INSERT bypass —
 * without it, a migration back-fill or hostile INSERT that creates a
 * task at kanban_column='done' would slip past the UPDATE-only guard.
 *
 * # Dry-run evidence
 *
 * All DDL below is verbatim from scripts/adr040-dry-run.mjs. Dry-run
 * against a copy of production data.db verified all 4 smoke assertions
 * in 19ms (ADR-040 §11.1):
 *   - UPDATE trigger ABORTs on kanban_column='done' without evidence
 *   - INSERT trigger ABORTs on direct-insert-at-done
 *   - workers_delete trigger ABORTs when tasks still assigned
 *   - Seed idempotency via INSERT OR IGNORE
 *
 * # Idempotency
 *
 * CREATE IF NOT EXISTS on all tables, indexes, triggers. Re-running
 * against a v91 DB is a no-op.
 *
 * See:
 *   - docs/docs/adr/adr-040-outcome-honest-delivery-kanban.md §3.4
 *   - .planning/adr-040-commit-2-plan.md
 *   - scripts/adr040-dry-run.mjs (validator)
 */

import type Database from 'better-sqlite3';

export default function migrateV91(db: Database.Database): void {
  // ── outcome_evidence — the DoD ledger ─────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS outcome_evidence (
      id                          TEXT    PRIMARY KEY,
      task_id                     TEXT    NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id                  TEXT    NOT NULL REFERENCES cypher_sessions(session_id) ON DELETE CASCADE,
      created_by_session_id       TEXT    NULL REFERENCES cypher_sessions(session_id),
      tier                        INTEGER NOT NULL CHECK(tier BETWEEN 0 AND 7),
      verified_via                TEXT    NOT NULL
                                  CHECK(verified_via IN
                                    ('self_reported','smoke_passed','cross_family_checked','user_observed')),
      verdict                     TEXT    NOT NULL
                                  CHECK(verdict IN
                                    ('pass','fail','flaky','partial','inconclusive','timeout','verifier_error')),
      verification_output_hash    TEXT    NULL,
      raw_payload                 TEXT    NOT NULL,
      non_fixture_identifier      TEXT    NULL,
      created_at                  INTEGER NOT NULL,
      CHECK (tier = 0 OR created_by_session_id IS NOT NULL),
      CHECK (tier = 0 OR created_by_session_id != session_id),
      CHECK (verified_via != 'user_observed' OR (
        verification_output_hash IS NOT NULL AND non_fixture_identifier IS NOT NULL
      ))
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS outcome_evidence_task_idx ON outcome_evidence(task_id, created_at DESC)`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS outcome_evidence_session_idx ON outcome_evidence(session_id)`);

  // ── cost_ledger — panel spend (populated in commit 5) ─────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_ledger (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      panel_review_id       INTEGER NULL REFERENCES panel_reviews(id) ON DELETE SET NULL,
      provider              TEXT    NOT NULL,
      model                 TEXT    NOT NULL,
      input_tokens          INTEGER NOT NULL,
      output_tokens         INTEGER NOT NULL,
      usd_estimated         REAL    NOT NULL,
      created_at            INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS cost_ledger_week_idx ON cost_ledger(created_at DESC)`);

  // ── verifier_health — v-of-v cron output (cron scripts in commit 3)
  db.exec(`
    CREATE TABLE IF NOT EXISTS verifier_health (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      verifier_name  TEXT NOT NULL CHECK(verifier_name IN
                     ('mutation_test_nightly','cross_family_audit_weekly','evidence_schema_lint_per_commit')),
      ran_at         INTEGER NOT NULL,
      outcome        TEXT NOT NULL CHECK(outcome IN ('pass','fail','flaky','error')),
      detail_json    TEXT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS verifier_health_name_idx ON verifier_health(verifier_name, ran_at DESC)`,
  );

  // ── DoD triggers — the load-bearing gate ──────────────────────────
  //
  // Author-independence + non-null hash/id are re-asserted at the trigger
  // boundary (in addition to the row-level CHECK on outcome_evidence).
  // Belt + braces: CHECK catches at row INSERT; trigger catches at
  // kanban_column write. See ADR §3.4 for rationale.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tasks_done_requires_user_observed
    BEFORE UPDATE OF kanban_column ON tasks
    WHEN NEW.kanban_column = 'done' AND OLD.kanban_column != 'done'
    BEGIN
      SELECT RAISE(ABORT,
        'tasks.kanban_column=done requires outcome_evidence with verified_via=user_observed AND author-independence')
      WHERE NOT EXISTS (
        SELECT 1 FROM outcome_evidence oe
        WHERE oe.task_id = NEW.id
          AND oe.verified_via = 'user_observed'
          AND oe.verdict = 'pass'
          AND oe.created_by_session_id IS NOT NULL
          AND oe.created_by_session_id != oe.session_id
          AND oe.verification_output_hash IS NOT NULL
          AND oe.non_fixture_identifier IS NOT NULL
      );
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tasks_insert_done_requires_user_observed
    BEFORE INSERT ON tasks
    WHEN NEW.kanban_column = 'done'
    BEGIN
      SELECT RAISE(ABORT,
        'tasks INSERT with kanban_column=done rejected — no matching user_observed evidence at insert time')
      WHERE NOT EXISTS (
        SELECT 1 FROM outcome_evidence oe
        WHERE oe.task_id = NEW.id
          AND oe.verified_via = 'user_observed'
          AND oe.verdict = 'pass'
          AND oe.created_by_session_id IS NOT NULL
          AND oe.created_by_session_id != oe.session_id
          AND oe.verification_output_hash IS NOT NULL
          AND oe.non_fixture_identifier IS NOT NULL
      );
    END
  `);
}
