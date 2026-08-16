/**
 * v59 — Phase: Cypher v1 spine (slice A+B, 2026-06-13).
 *
 * Three net-new tables ship together:
 *
 *   1. `cypher_sessions` — one row per wi_dispatch engagement. The session
 *      lifecycle: pending → done (outcome=success|mixed|failed) | halted |
 *      asked_user. Carries the goal, the resolved task class, the chosen
 *      skill (or sequence), the outcome verdict, and audit-shaped metadata
 *      (created_at, completed_at, total_token_cost, duration_ms).
 *
 *   2. `cypher_steps` — one row per 9-step contract transition within a
 *      session. The 9 stages from `.planning/cypher/03-FRAMEWORK-CONTRACT.md`:
 *      investigate → ask → research → plan → execute → quality_gate →
 *      confirm → surface → record. Each row captures `stage`, `status`
 *      (entered|completed|skipped|failed), payload (JSON), and timing.
 *
 *   3. `skill_priors` — Beta(α, β) per-skill priors per CAP-12 spec.
 *      α counts successes, β counts failures, mixed contributes 0.5 to
 *      each. The mean μ = α/(α+β) is what `getRankedSkills` orders by.
 *      Posterior-based — no need for explicit smoothing because Beta(1,1)
 *      is the uninformative prior baked in.
 *
 * Why three tables, not embedded JSON columns:
 *   - Sessions and steps need indexed timestamps for "show me the last 10
 *     dispatches" queries.
 *   - Beta priors need atomic UPDATE on outcome write — keeping them in
 *     a separate table avoids contention with sessions writes.
 *   - The cypher_steps table is the audit trail that makes Cypher
 *     reproducible — replaying a session means walking its steps in
 *     order and re-deriving each stage's input.
 *
 * CHECK constraints:
 *   - cypher_sessions.outcome ∈ {NULL, 'success', 'mixed', 'failed'}
 *   - cypher_sessions.status  ∈ {'pending', 'done', 'halted', 'asked_user'}
 *   - cypher_steps.stage      ∈ {'investigate','ask','research','plan',
 *                                 'execute','quality_gate','confirm',
 *                                 'surface','record'}
 *   - cypher_steps.status     ∈ {'entered','completed','skipped','failed'}
 *   - skill_priors.alpha + skill_priors.beta > 0  (posterior validity)
 *
 * Indexes (hot paths):
 *   - idx_cypher_sessions_user_started — for "my recent dispatches"
 *   - idx_cypher_steps_session — for replay/audit
 *   - idx_skill_priors_class — for ranked retrieval by task class
 */

import type Database from 'better-sqlite3';

export default function migrateV59(db: Database.Database): void {
  // ── 1. cypher_sessions — one row per wi_dispatch engagement ──────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS cypher_sessions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL UNIQUE,
      goal            TEXT    NOT NULL,
      context         TEXT,
      task_class      TEXT,
      chosen_skill    TEXT,
      user            TEXT    NOT NULL DEFAULT 'maaz',
      status          TEXT    NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','done','halted','asked_user')),
      outcome         TEXT
                       CHECK(outcome IS NULL OR outcome IN ('success','mixed','failed')),
      outcome_note    TEXT,
      total_tokens    INTEGER NOT NULL DEFAULT 0,
      duration_ms     INTEGER,
      allow_destructive INTEGER NOT NULL DEFAULT 0 CHECK(allow_destructive IN (0,1)),
      started_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      completed_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cypher_sessions_user_started
      ON cypher_sessions(user, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cypher_sessions_outcome
      ON cypher_sessions(outcome, completed_at DESC) WHERE outcome IS NOT NULL;
  `);

  // ── 2. cypher_steps — one row per 9-step transition ──────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS cypher_steps (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL,
      stage           TEXT    NOT NULL CHECK(stage IN
                       ('investigate','ask','research','plan','execute',
                        'quality_gate','confirm','surface','record')),
      stage_index     INTEGER NOT NULL,
      status          TEXT    NOT NULL CHECK(status IN
                       ('entered','completed','skipped','failed')),
      payload         TEXT,
      tokens_used     INTEGER NOT NULL DEFAULT 0,
      duration_ms     INTEGER,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES cypher_sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cypher_steps_session
      ON cypher_steps(session_id, stage_index);
  `);

  // ── 3. skill_priors — Beta(α, β) per skill per task class ────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_priors (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name      TEXT    NOT NULL,
      task_class      TEXT    NOT NULL DEFAULT '*',
      alpha           REAL    NOT NULL DEFAULT 1.0,
      beta            REAL    NOT NULL DEFAULT 1.0,
      total_runs      INTEGER NOT NULL DEFAULT 0,
      last_outcome_at TEXT,
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(skill_name, task_class),
      CHECK(alpha + beta > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_skill_priors_class
      ON skill_priors(task_class, alpha DESC);
  `);
}
