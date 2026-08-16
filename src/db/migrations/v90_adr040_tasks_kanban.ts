/**
 * v90 — ADR-040 commit 1 (2026-06-30): outcome-honest delivery kanban substrate.
 *
 * Adds:
 *   - 9 columns to the existing `tasks` table (from ADR-038 D2) to carry
 *     goal-text, acceptance-text, kanban_column, kanban_order,
 *     assigned_worker_id, blocked flag+reason, entered_column_at, and
 *     depends_on_json (JSON array of prerequisite task_ids).
 *   - `workers` table — the fixed pool of 4 numbered workers with
 *     Beta-prior state (populated later; empty JSON default at seed).
 *     Idempotently seeded with 4 rows (Worker 1..4 with profile hints
 *     backend/frontend/schema/generalist).
 *   - `workers_delete_requires_no_assignments` trigger — refuses to
 *     DELETE a worker while any `tasks.assigned_worker_id` still points
 *     at it. Symmetrical with the ON DELETE SET NULL cascade in the
 *     reverse direction (workers.current_task_id → tasks(id)).
 *   - `panel_reviews` + `panel_review_messages` tables — empty schema
 *     that commit 5 populates. Landing them here means the v90 migration
 *     is one clean unit rather than a partial split.
 *   - `panel_agent_config` table — hot-swap LLM routing config for the
 *     4-agent panel (populated in commit 5).
 *   - `worker_reassignment_log` table — audit log for the crash-recovery
 *     reassignment path in §6.4 (populated in commit 6).
 *
 * Explicitly NOT in v90 (defer to v91 in commit 2):
 *   - outcome_evidence + verified_via enum + DoD triggers
 *   - cost_ledger
 *   - verifier_health
 *
 * # Why one large migration instead of splitting
 *
 * All 6 tables + 9 tasks columns are structurally coupled (workers
 * references tasks; panel_reviews references tasks; the workers DELETE
 * trigger references tasks). Splitting would create intermediate states
 * where FKs are broken or the trigger references a column that doesn't
 * yet exist. Landing as one atomic migration keeps every state consistent.
 *
 * # Idempotency
 *
 * All ALTERs guarded by PRAGMA table_info check.
 * All CREATE TABLE / CREATE INDEX / CREATE TRIGGER use IF NOT EXISTS.
 * Worker seed uses INSERT OR IGNORE (workers.number UNIQUE handles collision).
 * Re-running against an already-v90 DB is a no-op.
 *
 * # Dry-run evidence
 *
 * The DDL in this file is verbatim from scripts/adr040-dry-run.mjs which
 * was verified 2026-06-30 against a copy of production data.db (v89, 480MB)
 * — 19ms application, all 4 smoke assertions green (UPDATE trigger,
 * INSERT trigger, DELETE trigger for workers, seed idempotency). See
 * ADR-040 §11.1 for the recorded evidence.
 *
 * See:
 *   - docs/docs/adr/adr-040-outcome-honest-delivery-kanban.md §3.1-§3.3, §3.7
 *   - .planning/adr-040-commit-1-plan.md §2 Step 1
 *   - scripts/adr040-dry-run.mjs (the validator)
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV90(db: Database.Database): void {
  const tasksCols = db
    .prepare(`PRAGMA table_info(tasks)`)
    .all() as ColumnInfoRow[];
  const hasCol = (name: string): boolean => tasksCols.some((c) => c.name === name);

  // ── tasks extension (9 new columns) ────────────────────────────────
  //
  // All nullable-or-defaulted so existing v89 rows remain valid.
  // kanban_column DEFAULT 'ready' back-fills existing rows into the
  // ready column — expected behavior (they've been sitting there
  // conceptually already; now they're formally in ready).
  if (!hasCol('goal_text')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN goal_text TEXT`);
  }
  if (!hasCol('acceptance_text')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN acceptance_text TEXT`);
  }
  if (!hasCol('kanban_column')) {
    db.exec(
      `ALTER TABLE tasks ADD COLUMN kanban_column TEXT NOT NULL DEFAULT 'ready' ` +
        `CHECK(kanban_column IN ('ready','in_progress','review','e2e','done'))`,
    );
  }
  if (!hasCol('kanban_order')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN kanban_order INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasCol('assigned_worker_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN assigned_worker_id INTEGER NULL`);
  }
  if (!hasCol('blocked')) {
    db.exec(
      `ALTER TABLE tasks ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1))`,
    );
  }
  if (!hasCol('blocked_reason')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN blocked_reason TEXT`);
  }
  if (!hasCol('entered_column_at')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN entered_column_at INTEGER`);
  }
  if (!hasCol('depends_on_json')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN depends_on_json TEXT`);
  }

  // ── workers table ──────────────────────────────────────────────────
  //
  // Fixed pool of 4 workers with DB identity. Beta-prior state
  // materializes in `beta_priors_json` starting commit 6's update-signal
  // work; v90 lands the empty schema + seed only.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      id                INTEGER PRIMARY KEY,
      number            INTEGER NOT NULL UNIQUE CHECK(number BETWEEN 1 AND 4),
      profile_hint      TEXT    NOT NULL DEFAULT 'generalist'
                        CHECK(profile_hint IN ('backend','frontend','schema','generalist')),
      beta_priors_json  TEXT    NOT NULL DEFAULT '{}',
      current_task_id   TEXT    NULL REFERENCES tasks(id) ON DELETE SET NULL,
      health_status     TEXT    NOT NULL DEFAULT 'active'
                        CHECK(health_status IN ('active','crashed','offline')),
      last_active_at    INTEGER NOT NULL,
      created_at        INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS workers_health_idx ON workers(health_status)`);

  // Idempotent seed — INSERT OR IGNORE respects UNIQUE(number).
  // Re-running on an already-seeded workers table is a no-op.
  const now = Date.now();
  const seedStmt = db.prepare(
    `INSERT OR IGNORE INTO workers(number, profile_hint, last_active_at, created_at) VALUES (?, ?, ?, ?)`,
  );
  seedStmt.run(1, 'backend', now, now);
  seedStmt.run(2, 'frontend', now, now);
  seedStmt.run(3, 'schema', now, now);
  seedStmt.run(4, 'generalist', now, now);

  // ── workers DELETE trigger ─────────────────────────────────────────
  //
  // Symmetrical with workers.current_task_id → tasks(id) ON DELETE SET
  // NULL. In the reverse direction, tasks.assigned_worker_id has no FK
  // (SQLite can't add FK constraints via ALTER TABLE). This trigger
  // enforces the invariant: refuse to DELETE a worker while any task
  // still points at it. Fix path is "reassign first, then delete."
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS workers_delete_requires_no_assignments
    BEFORE DELETE ON workers
    BEGIN
      SELECT RAISE(ABORT, 'workers.id in use — reassign tasks.assigned_worker_id first')
      WHERE EXISTS (SELECT 1 FROM tasks WHERE assigned_worker_id = OLD.id);
    END
  `);

  // ── panel_reviews + panel_review_messages ──────────────────────────
  //
  // Empty schema — commit 5 populates. Landing here so the v90 unit is
  // structurally complete for §3.3 of the ADR.
  db.exec(`
    CREATE TABLE IF NOT EXISTS panel_reviews (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id               TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      round_number          INTEGER NOT NULL CHECK(round_number IN (1,2)),
      verdict               TEXT    NOT NULL
                            CHECK(verdict IN ('approved','rejected','deadlock','pending')),
      unanimous             INTEGER NOT NULL DEFAULT 0 CHECK(unanimous IN (0,1)),
      panel_disagreement    INTEGER NOT NULL DEFAULT 0 CHECK(panel_disagreement IN (0,1)),
      injection_detected    INTEGER NOT NULL DEFAULT 0 CHECK(injection_detected IN (0,1)),
      degraded              INTEGER NOT NULL DEFAULT 0 CHECK(degraded IN (0,1)),
      cost_capped           INTEGER NOT NULL DEFAULT 0 CHECK(cost_capped IN (0,1)),
      started_at            INTEGER NOT NULL,
      completed_at          INTEGER NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS panel_reviews_task_idx ON panel_reviews(task_id, round_number)`,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS panel_review_messages (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      panel_review_id       INTEGER NOT NULL REFERENCES panel_reviews(id) ON DELETE CASCADE,
      agent_role            TEXT    NOT NULL
                            CHECK(agent_role IN ('architect','qa','pm','skeptic')),
      agent_model           TEXT    NOT NULL,
      content_text          TEXT    NOT NULL,
      verdict               TEXT    NOT NULL
                            CHECK(verdict IN ('approve','reject','abstain')),
      injection_flagged     INTEGER NOT NULL DEFAULT 0 CHECK(injection_flagged IN (0,1)),
      created_at            INTEGER NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS panel_review_messages_review_idx ` +
      `ON panel_review_messages(panel_review_id, created_at)`,
  );

  // ── panel_agent_config — LLM hot-swap routing ──────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS panel_agent_config (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      role          TEXT NOT NULL CHECK(role IN ('architect','qa','pm','skeptic')),
      provider      TEXT NOT NULL CHECK(provider IN ('anthropic','openai','google','llama_local')),
      model         TEXT NOT NULL,
      active_from   INTEGER NOT NULL,
      active_to     INTEGER NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS panel_agent_config_active_idx ` +
      `ON panel_agent_config(role, active_from DESC) WHERE active_to IS NULL`,
  );

  // ── worker_reassignment_log — crash-recovery audit ─────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_reassignment_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id           TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      from_worker_id    INTEGER NOT NULL,
      to_worker_id      INTEGER NULL,
      reason            TEXT    NOT NULL CHECK(reason IN ('heartbeat_miss','manual','crashed')),
      created_at        INTEGER NOT NULL
    )
  `);
}
