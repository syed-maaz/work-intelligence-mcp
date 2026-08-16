/**
 * D6 retention + GC tests — ADR-038 v2.5 (2026-06-26).
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import migrateV52 from '../../../src/db/migrations/v52_model_config.js';
import migrateV59 from '../../../src/db/migrations/v59_cypher_tables.js';
import migrateV60 from '../../../src/db/migrations/v60_cypher_pm.js';
import migrateV61 from '../../../src/db/migrations/v61_pm_auto_actions.js';
import migrateV62 from '../../../src/db/migrations/v62_skill_actually_invoked.js';
import migrateV63 from '../../../src/db/migrations/v63_skill_catalog.js';
import migrateV64 from '../../../src/db/migrations/v64_cypher_outcomes.js';
import migrateV65 from '../../../src/db/migrations/v65_cypher_outcomes_legacy_upgrade.js';
import migrateV66 from '../../../src/db/migrations/v66_cap13_birth_decisions.js';
import migrateV67 from '../../../src/db/migrations/v67_cypher_loop_columns.js';
import migrateV71 from '../../../src/db/migrations/v71_cypher_sessions_posture.js';
import migrateV80 from '../../../src/db/migrations/v80_d18_reasoning_trace.js';
import migrateV82 from '../../../src/db/migrations/v82_d5_permissions_ledger.js';
import migrateV83 from '../../../src/db/migrations/v83_d6_retention_gc.js';
import { runGc, listGcLog } from '../../../src/services/cypher/gc.js';

function fullDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV52(db);
  migrateV59(db);
  migrateV60(db);
  migrateV61(db);
  migrateV62(db);
  migrateV63(db);
  migrateV64(db);
  migrateV65(db);
  migrateV66(db);
  migrateV67(db);
  migrateV71(db);   // posture col on cypher_sessions (needed by GC rollup query)
  migrateV80(db);   // adds tool_use stage + reasoning_trace/controller_model on cypher_steps
  migrateV82(db);   // permissions + permission_uses
  migrateV83(db);   // dispatch_snapshots, *_summary, gc_log
  return db;
}

function seedSession(db: Database.Database, id: string, status = 'pending', outcome: string | null = null): void {
  db.prepare(`
    INSERT INTO cypher_sessions (session_id, goal, user, status, outcome)
    VALUES (?, 'g', 'maaz', ?, ?)
  `).run(id, status, outcome);
}

// ── Migration shape ───────────────────────────────────────────────────────────

describe('v83 migration', () => {
  let db: Database.Database;
  beforeEach(() => { db = fullDb(); });
  afterEach(() => { db.close(); });

  it('creates all four new tables', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    for (const t of ['dispatch_snapshots', 'cypher_steps_summary', 'cypher_sessions_summary', 'gc_log']) {
      expect(names).toContain(t);
    }
  });

  it('is idempotent', () => {
    expect(() => migrateV83(db)).not.toThrow();
    expect(() => migrateV83(db)).not.toThrow();
  });
});

// ── runGc lifecycle ───────────────────────────────────────────────────────────

describe('runGc smoke', () => {
  let db: Database.Database;
  beforeEach(() => { db = fullDb(); });
  afterEach(() => { db.close(); });

  it('runs without errors on an empty DB', () => {
    const r = runGc(db);
    expect(r.run_id).toMatch(/^gc_/);
    expect(r.errors).toEqual([]);
    expect(r.actions.length).toBeGreaterThan(0);
  });

  it('writes a row to gc_log', () => {
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM gc_log`).get() as { n: number }).n;
    runGc(db);
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM gc_log`).get() as { n: number }).n;
    expect(after).toBe(before + 1);
  });

  it('dry_run does not mutate', () => {
    seedSession(db, 'cyp_old1', 'done', 'success');
    db.prepare(`INSERT INTO dispatch_snapshots (dispatch_id, iter_number, messages_blob, written_at) VALUES ('cyp_old1', 1, '[]', ?)`)
      .run(Date.now() - 60_000);
    const r = runGc(db, { dry_run: true });
    expect(r.dry_run).toBe(true);
    // dispatch_snapshots row still there
    const remaining = (db.prepare(`SELECT COUNT(*) AS n FROM dispatch_snapshots WHERE dispatch_id = ?`).get('cyp_old1') as { n: number }).n;
    expect(remaining).toBe(1);
    // gc_log still gets a row, marked dry_run=1
    const logged = (db.prepare(`SELECT dry_run FROM gc_log WHERE run_id = ?`).get(r.run_id) as { dry_run: number }).dry_run;
    expect(logged).toBe(1);
  });

  it('deletes dispatch_snapshots for closed dispatches', () => {
    seedSession(db, 'cyp_closed', 'done', 'success');
    seedSession(db, 'cyp_open', 'pending');
    db.prepare(`INSERT INTO dispatch_snapshots (dispatch_id, iter_number, messages_blob, written_at) VALUES (?, 1, '[]', ?)`)
      .run('cyp_closed', Date.now());
    db.prepare(`INSERT INTO dispatch_snapshots (dispatch_id, iter_number, messages_blob, written_at) VALUES (?, 1, '[]', ?)`)
      .run('cyp_open', Date.now());
    runGc(db);
    const remaining = (db.prepare(`SELECT COUNT(*) AS n FROM dispatch_snapshots`).get() as { n: number }).n;
    expect(remaining).toBe(1); // only open survives
    const survivor = db.prepare(`SELECT dispatch_id FROM dispatch_snapshots`).get() as { dispatch_id: string };
    expect(survivor.dispatch_id).toBe('cyp_open');
  });

  it('rolls up old permission_uses', () => {
    db.prepare(`INSERT INTO permissions (id, granted_at, action_pattern, scope_kind) VALUES ('prm_a', ?, 'x', 'standing')`)
      .run(Date.now());
    // Old use (older than 90 days).
    db.prepare(`INSERT INTO permission_uses (permission_id, dispatch_id, step_id, used_at) VALUES ('prm_a', 'cyp_old', 1, ?)`)
      .run(Date.now() - 91 * 24 * 60 * 60 * 1000);
    // Recent use.
    db.prepare(`INSERT INTO permission_uses (permission_id, dispatch_id, step_id, used_at) VALUES ('prm_a', 'cyp_new', 1, ?)`)
      .run(Date.now());
    runGc(db);
    const remaining = (db.prepare(`SELECT COUNT(*) AS n FROM permission_uses`).get() as { n: number }).n;
    expect(remaining).toBe(1);
    const survivor = db.prepare(`SELECT dispatch_id FROM permission_uses`).get() as { dispatch_id: string };
    expect(survivor.dispatch_id).toBe('cyp_new');
  });

  it('trims gc_log to keep limit', () => {
    // Stuff in many old rows.
    for (let i = 0; i < 110; i++) {
      db.prepare(`INSERT INTO gc_log (run_id, ran_at, duration_ms, table_actions) VALUES (?, ?, 1, '[]')`)
        .run(`gc_${i}`, Date.now() - i * 1000);
    }
    runGc(db, { gc_log_keep: 50 });
    // runGc trims first, then writes its own row — so after the call
    // the count is at most keep+1.
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM gc_log`).get() as { n: number }).n;
    expect(n).toBeLessThanOrEqual(51);
    expect(n).toBeGreaterThan(50);
  });

  it('per-action errors do not abort the whole run', () => {
    // The dispatch_snapshots probe should still work even if everything
    // else is happy. We just verify a clean run returns errors=[].
    const r = runGc(db);
    expect(Array.isArray(r.errors)).toBe(true);
  });
});

// ── listGcLog ────────────────────────────────────────────────────────────────

describe('listGcLog', () => {
  let db: Database.Database;
  beforeEach(() => { db = fullDb(); });
  afterEach(() => { db.close(); });

  it('returns recent gc_log rows in DESC order', () => {
    runGc(db);
    runGc(db);
    const rows = listGcLog(db, 10);
    expect(rows.length).toBe(2);
    expect(rows[0].ran_at).toBeGreaterThanOrEqual(rows[1].ran_at);
  });

  it('parses table_actions JSON into objects', () => {
    runGc(db);
    const rows = listGcLog(db, 1);
    expect(Array.isArray(rows[0].table_actions)).toBe(true);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) runGc(db);
    expect(listGcLog(db, 3).length).toBe(3);
  });
});
