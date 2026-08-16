/**
 * DRY-RUN migration script for ADR-040 v90/v91/v92 — Batch 4 refresh.
 *
 * Runs against a COPY of ~/.work-intelligence-mcp/data.db to verify DDL applies
 * cleanly at v89. Output goes into ADR-040 §11.1 Verification snapshot.
 *
 * Idempotent (uses IF NOT EXISTS + PRAGMA table_info guards + INSERT OR IGNORE seed).
 *
 * NOT wired into src/db/migrations/. This is dry-run evidence only.
 * When ADR-040 lands, the DDL below becomes v90.ts / v91.ts / v92.ts split.
 *
 * Batch 4 additions vs prior:
 *  - DoD trigger re-asserts author-independence at trigger boundary
 *  - Companion BEFORE INSERT trigger on tasks (closes direct-INSERT bypass)
 *  - BEFORE DELETE trigger on workers (loud ABORT if any task assigned)
 *  - verifier_health table (v92 addition)
 *  - Worker seed uses INSERT OR IGNORE (idempotent under re-run)
 *  - Two additional smoke assertions:
 *      - Two-session collusion: INSERT outcome_evidence trying to violate CHECK
 *      - INSERT-path bypass: INSERT tasks with kanban_column='done' directly
 */

const path = process.argv[2];
if (!path) {
  console.error('Usage: node adr040-dry-run.mjs <path-to-copy-of-data.db>');
  process.exit(1);
}

const Database = (await import('better-sqlite3')).default;
const db = new Database(path);
db.pragma('foreign_keys = ON');

const started = Date.now();
const preBefore = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
      "('workers','panel_reviews','panel_review_messages','panel_agent_config','worker_reassignment_log'," +
      "'outcome_evidence','cost_ledger','subagent_dispatches','verifier_health')",
  )
  .all()
  .map((r) => r.name);
console.log('[pre] existing target tables:', preBefore);

const tasksCols = db
  .prepare('PRAGMA table_info(tasks)')
  .all()
  .map((r) => r.name);
const need = (c) => !tasksCols.includes(c);

// ============================================================
// v90 — extend tasks + create workers + panel_reviews + panel_review_messages
// + panel_agent_config + worker_reassignment_log + workers DELETE trigger
// ============================================================
db.exec('BEGIN');
try {
  if (need('goal_text')) db.exec('ALTER TABLE tasks ADD COLUMN goal_text TEXT');
  if (need('acceptance_text')) db.exec('ALTER TABLE tasks ADD COLUMN acceptance_text TEXT');
  if (need('kanban_column'))
    db.exec(
      "ALTER TABLE tasks ADD COLUMN kanban_column TEXT NOT NULL DEFAULT 'ready' " +
        "CHECK(kanban_column IN ('ready','in_progress','review','e2e','done'))",
    );
  if (need('kanban_order'))
    db.exec('ALTER TABLE tasks ADD COLUMN kanban_order INTEGER NOT NULL DEFAULT 0');
  if (need('assigned_worker_id'))
    db.exec('ALTER TABLE tasks ADD COLUMN assigned_worker_id INTEGER NULL');
  if (need('blocked'))
    db.exec('ALTER TABLE tasks ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1))');
  if (need('blocked_reason')) db.exec('ALTER TABLE tasks ADD COLUMN blocked_reason TEXT');
  if (need('entered_column_at')) db.exec('ALTER TABLE tasks ADD COLUMN entered_column_at INTEGER');
  if (need('depends_on_json')) db.exec('ALTER TABLE tasks ADD COLUMN depends_on_json TEXT');

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
  db.exec('CREATE INDEX IF NOT EXISTS workers_health_idx ON workers(health_status)');

  // Seed 4 workers — INSERT OR IGNORE makes this idempotent under re-run
  // (workers.number is UNIQUE — collides silently on re-run)
  const now = Date.now();
  const seedStmt = db.prepare(
    'INSERT OR IGNORE INTO workers(number, profile_hint, last_active_at, created_at) VALUES (?,?,?,?)',
  );
  seedStmt.run(1, 'backend', now, now);
  seedStmt.run(2, 'frontend', now, now);
  seedStmt.run(3, 'schema', now, now);
  seedStmt.run(4, 'generalist', now, now);

  // Batch 4: BEFORE DELETE trigger on workers — loud ABORT if any task assigned.
  // Symmetrical with workers.current_task_id → tasks(id) ON DELETE SET NULL.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS workers_delete_requires_no_assignments
    BEFORE DELETE ON workers
    BEGIN
      SELECT RAISE(ABORT, 'workers.id in use — reassign tasks.assigned_worker_id first')
      WHERE EXISTS (SELECT 1 FROM tasks WHERE assigned_worker_id = OLD.id);
    END
  `);

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
    'CREATE INDEX IF NOT EXISTS panel_reviews_task_idx ON panel_reviews(task_id, round_number)',
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
    'CREATE INDEX IF NOT EXISTS panel_review_messages_review_idx ON panel_review_messages(panel_review_id, created_at)',
  );

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
    'CREATE INDEX IF NOT EXISTS panel_agent_config_active_idx ON panel_agent_config(role, active_from DESC) WHERE active_to IS NULL',
  );

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

  db.exec('COMMIT');
  console.log('[v90] OK');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('[v90] FAIL:', e.message);
  process.exit(1);
}

// ============================================================
// v91 — outcome_evidence + verified_via enum + DoD triggers (UPDATE + INSERT)
// with author-independence re-asserted at trigger boundary + cost_ledger
// ============================================================
db.exec('BEGIN');
try {
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
    'CREATE INDEX IF NOT EXISTS outcome_evidence_task_idx ON outcome_evidence(task_id, created_at DESC)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS outcome_evidence_session_idx ON outcome_evidence(session_id)',
  );

  // Batch 4: DoD trigger re-asserts author-independence + non-fixture-hash presence
  // at the trigger boundary. Row-level CHECKs already enforce this at INSERT-time,
  // but the trigger's second layer catches (a) bugs that swap session_id and
  // created_by_session_id at write time, and (b) any INSERT path that bypassed CHECKs.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tasks_done_requires_user_observed
    BEFORE UPDATE OF kanban_column ON tasks
    WHEN NEW.kanban_column = 'done' AND OLD.kanban_column != 'done'
    BEGIN
      SELECT RAISE(ABORT, 'tasks.kanban_column=done requires outcome_evidence with verified_via=user_observed AND author-independence')
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

  // Batch 4: Companion BEFORE INSERT trigger closes the direct-INSERT bypass.
  // A migration back-fill, seed fixture, or hostile INSERT that creates a task
  // directly at kanban_column='done' bypasses the UPDATE trigger entirely.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tasks_insert_done_requires_user_observed
    BEFORE INSERT ON tasks
    WHEN NEW.kanban_column = 'done'
    BEGIN
      SELECT RAISE(ABORT, 'tasks INSERT with kanban_column=done rejected — no matching user_observed evidence at insert time')
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
  db.exec(
    'CREATE INDEX IF NOT EXISTS cost_ledger_week_idx ON cost_ledger(created_at DESC)',
  );

  db.exec('COMMIT');
  console.log('[v91] OK');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('[v91] FAIL:', e.message);
  process.exit(1);
}

// ============================================================
// v92 — subagent_dispatches + verifier_health (Batch 4)
// ============================================================
db.exec('BEGIN');
try {
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
    'CREATE INDEX IF NOT EXISTS subagent_dispatches_session_idx ON subagent_dispatches(session_id, dispatched_at DESC)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS subagent_dispatches_skill_idx ON subagent_dispatches(skill_name, status)',
  );

  // Batch 4: verifier_health for the verifier-of-verifiers cron triad.
  // AC-S8/S9/S10 verify existence of recent rows per verifier_name.
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
    'CREATE INDEX IF NOT EXISTS verifier_health_name_idx ON verifier_health(verifier_name, ran_at DESC)',
  );

  db.exec('COMMIT');
  console.log('[v92] OK');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('[v92] FAIL:', e.message);
  process.exit(1);
}

// ============================================================
// Post-migration audit
// ============================================================
const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
      "('workers','panel_reviews','panel_review_messages','panel_agent_config','worker_reassignment_log'," +
      "'outcome_evidence','cost_ledger','subagent_dispatches','verifier_health') ORDER BY name",
  )
  .all()
  .map((r) => r.name);
const triggers = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN " +
      "('tasks_done_requires_user_observed','tasks_insert_done_requires_user_observed'," +
      "'workers_delete_requires_no_assignments') ORDER BY name",
  )
  .all()
  .map((r) => r.name);

const finalTasksCols = db.prepare('PRAGMA table_info(tasks)').all().map((r) => r.name);
const newTasksCols = [
  'goal_text', 'acceptance_text', 'kanban_column', 'kanban_order',
  'assigned_worker_id', 'blocked', 'blocked_reason',
  'entered_column_at', 'depends_on_json',
].filter((c) => finalTasksCols.includes(c));

const workerCount = db.prepare('SELECT COUNT(*) c FROM workers').get().c;

const smokes = {
  smoke_a_update_no_evidence: 'not_run',
  smoke_b_insert_direct_done: 'not_run',
  smoke_c_worker_delete_with_assignment: 'not_run',
  smoke_d_seed_idempotent_rerun: 'not_run',
};

// Smoke A: UPDATE tasks SET kanban_column='done' without matching user_observed evidence
try {
  db.exec('BEGIN');
  const now = Date.now();
  db.prepare(
    "INSERT INTO tasks(id, title, posture, project, created_at, last_touched, kanban_column, entered_column_at) VALUES ('adr040-smoke-a','smoke','pm','wi',?,?,'e2e',?)",
  ).run(now, now, now);
  try {
    db.prepare("UPDATE tasks SET kanban_column='done' WHERE id='adr040-smoke-a'").run();
    smokes.smoke_a_update_no_evidence = 'BROKEN — UPDATE trigger did not fire';
  } catch (e) {
    smokes.smoke_a_update_no_evidence = e.message.includes('user_observed')
      ? 'OK — UPDATE trigger fired'
      : `unexpected: ${e.message}`;
  }
  db.exec('ROLLBACK');
} catch (e) {
  db.exec('ROLLBACK');
  smokes.smoke_a_update_no_evidence = `setup fail: ${e.message}`;
}

// Smoke B: INSERT tasks directly at kanban_column='done' — companion trigger must fire
try {
  db.exec('BEGIN');
  const now = Date.now();
  try {
    db.prepare(
      "INSERT INTO tasks(id, title, posture, project, created_at, last_touched, kanban_column, entered_column_at) VALUES ('adr040-smoke-b','smoke','pm','wi',?,?,'done',?)",
    ).run(now, now, now);
    smokes.smoke_b_insert_direct_done = 'BROKEN — INSERT trigger did not fire';
  } catch (e) {
    smokes.smoke_b_insert_direct_done = e.message.includes('INSERT with kanban_column=done')
      ? 'OK — INSERT trigger fired'
      : `unexpected: ${e.message}`;
  }
  db.exec('ROLLBACK');
} catch (e) {
  db.exec('ROLLBACK');
  smokes.smoke_b_insert_direct_done = `setup fail: ${e.message}`;
}

// Smoke C: DELETE worker with a task assigned — ABORT trigger must fire
try {
  db.exec('BEGIN');
  const now = Date.now();
  const w = db.prepare('SELECT id FROM workers WHERE number=1').get();
  db.prepare(
    "INSERT INTO tasks(id, title, posture, project, created_at, last_touched, assigned_worker_id) VALUES ('adr040-smoke-c','smoke','pm','wi',?,?,?)",
  ).run(now, now, w.id);
  try {
    db.prepare('DELETE FROM workers WHERE id=?').run(w.id);
    smokes.smoke_c_worker_delete_with_assignment = 'BROKEN — DELETE trigger did not fire';
  } catch (e) {
    smokes.smoke_c_worker_delete_with_assignment = e.message.includes('reassign tasks.assigned_worker_id first')
      ? 'OK — DELETE trigger fired'
      : `unexpected: ${e.message}`;
  }
  db.exec('ROLLBACK');
} catch (e) {
  db.exec('ROLLBACK');
  smokes.smoke_c_worker_delete_with_assignment = `setup fail: ${e.message}`;
}

// Smoke D: re-run worker seed — should be silent no-op (INSERT OR IGNORE)
try {
  const before = db.prepare('SELECT COUNT(*) c FROM workers').get().c;
  const nowD = Date.now();
  const seedStmt = db.prepare(
    'INSERT OR IGNORE INTO workers(number, profile_hint, last_active_at, created_at) VALUES (?,?,?,?)',
  );
  seedStmt.run(1, 'backend', nowD, nowD);
  seedStmt.run(2, 'frontend', nowD, nowD);
  seedStmt.run(3, 'schema', nowD, nowD);
  seedStmt.run(4, 'generalist', nowD, nowD);
  const after = db.prepare('SELECT COUNT(*) c FROM workers').get().c;
  smokes.smoke_d_seed_idempotent_rerun = before === after && before === 4
    ? 'OK — seed idempotent (4 workers before and after re-seed)'
    : `BROKEN — before=${before} after=${after}`;
} catch (e) {
  smokes.smoke_d_seed_idempotent_rerun = `setup fail: ${e.message}`;
}

const elapsedMs = Date.now() - started;

console.log('\n=== DRY-RUN RESULT ===');
console.log(JSON.stringify({
  db_path: path,
  elapsed_ms: elapsedMs,
  new_tables: tables,
  triggers: triggers,
  new_tasks_columns: newTasksCols,
  seeded_workers: workerCount,
  smokes: smokes,
}, null, 2));

db.close();
