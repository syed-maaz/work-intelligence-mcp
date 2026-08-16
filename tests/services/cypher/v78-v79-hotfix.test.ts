/**
 * v78 + v79 hotfix migration tests — ADR-038 v2.5 D3 slice 2 follow-up.
 *
 * v78 and v79 exist to repair broken FK references on real DBs that ran
 * the first (broken) v77 cut. On a fresh-install DB that runs v77 with
 * the legacy_alter_table=1 fix in place, both migrations are no-ops.
 *
 * Tests verify:
 *   1. v78 + v79 are safe to run on a clean (post-v77-fixed) DB
 *   2. v78 + v79 leave the FK clauses correct (REFERENCES tasks(id))
 *   3. v79 is idempotent — re-running on an already-clean DB does nothing
 *   4. Inserts to task_history, task_contexts, cypher_sessions.task_id
 *      all succeed after the migrations run
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import migrateV59 from '../../../src/db/migrations/v59_cypher_tables.js';
import migrateV75 from '../../../src/db/migrations/v75_d2_task_memory.js';
import migrateV76 from '../../../src/db/migrations/v76_d3_projects_table.js';
import migrateV77 from '../../../src/db/migrations/v77_d3_tasks_project_fk.js';
import migrateV78 from '../../../src/db/migrations/v78_d3_repair_task_history_fk.js';
import migrateV79 from '../../../src/db/migrations/v79_d3_repair_cypher_sessions_task_id_fk.js';
import migrateV81 from '../../../src/db/migrations/v81_d19_recurate_pending.js';
import { createTask } from '../../../src/services/cypher/task-memory.js';

function fullDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV59(db);
  migrateV75(db);
  migrateV76(db);
  migrateV77(db);
  migrateV78(db);
  migrateV79(db);
  migrateV81(db); // D19 — needed for createTask which writes recurate_pending_at
  return db;
}

describe('v78 — task_history + task_contexts FK repair', () => {
  let db: Database.Database;
  beforeEach(() => { db = fullDb(); });
  afterEach(() => { db.close(); });

  it('task_history FK points at tasks(id)', () => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name='task_history'`).get() as { sql: string };
    expect(row.sql).toContain('REFERENCES tasks(id)');
    expect(row.sql).not.toContain('tasks_old_v76');
  });

  it('task_contexts FK points at tasks(id)', () => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name='task_contexts'`).get() as { sql: string };
    expect(row.sql).toContain('REFERENCES tasks(id)');
    expect(row.sql).not.toContain('tasks_old_v76');
  });

  it('inserts into task_history succeed after v78', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    expect(() =>
      db.prepare(`INSERT INTO task_history (task_id, dispatch_id, outcome, ts) VALUES (?, ?, 'pending', ?)`)
        .run(t.id, 'cyp_v78_test', Date.now())
    ).not.toThrow();
  });
});

describe('v79 — cypher_sessions.task_id FK repair', () => {
  let db: Database.Database;
  beforeEach(() => { db = fullDb(); });
  afterEach(() => { db.close(); });

  it('cypher_sessions.task_id FK points at tasks(id)', () => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name='cypher_sessions'`).get() as { sql: string };
    // The fresh-install path leaves the v75 FK clause intact; v79 only
    // rewrites if the broken tasks_old_v76 string is present. Either
    // way the FK must resolve to tasks(id) and not the orphan name.
    expect(row.sql).toContain('task_id');
    expect(row.sql).not.toContain('tasks_old_v76');
  });

  it('inserting a cypher_sessions row with a valid task_id succeeds', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    expect(() =>
      db.prepare(`INSERT INTO cypher_sessions (session_id, goal, user, status, task_id) VALUES (?, 'g', 'maaz', 'pending', ?)`)
        .run('cyp_v79_test', t.id)
    ).not.toThrow();
  });

  it('inserting a cypher_sessions row with NULL task_id still works', () => {
    expect(() =>
      db.prepare(`INSERT INTO cypher_sessions (session_id, goal, user, status, task_id) VALUES (?, 'g', 'maaz', 'pending', NULL)`)
        .run('cyp_v79_null')
    ).not.toThrow();
  });

  it('inserting a cypher_sessions row with an unknown task_id is rejected by the FK', () => {
    expect(() =>
      db.prepare(`INSERT INTO cypher_sessions (session_id, goal, user, status, task_id) VALUES (?, 'g', 'maaz', 'pending', ?)`)
        .run('cyp_v79_orphan', 'tsk_ghost_does_not_exist')
    ).toThrow();
  });

  it('v79 re-run is a no-op (idempotency guard)', () => {
    const before = db.prepare(`SELECT sql FROM sqlite_master WHERE name='cypher_sessions'`).get() as { sql: string };
    migrateV79(db);
    const after = db.prepare(`SELECT sql FROM sqlite_master WHERE name='cypher_sessions'`).get() as { sql: string };
    expect(after.sql).toBe(before.sql);
  });
});
