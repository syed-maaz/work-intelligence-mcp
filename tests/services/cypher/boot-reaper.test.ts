/**
 * Boot-reaper tests — ADR-038 v2.5 D7 follow-up (2026-06-26).
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
import migrateV83 from '../../../src/db/migrations/v83_d6_retention_gc.js';
import migrateV87 from '../../../src/db/migrations/v87_outcome_check_widen.js';
import { reapBootOrphans } from '../../../src/services/cypher/boot-reaper.js';

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
  migrateV83(db);
  migrateV87(db);
  return db;
}

function seedSession(db: Database.Database, session_id: string, status: string, outcome: string | null = null): void {
  db.prepare(`INSERT INTO cypher_sessions (session_id, goal, user, status, outcome) VALUES (?, 'g', 'maaz', ?, ?)`)
    .run(session_id, status, outcome);
}

function seedSnapshot(db: Database.Database, dispatch_id: string, iter = 1): void {
  db.prepare(`INSERT INTO dispatch_snapshots (dispatch_id, iter_number, messages_blob, written_at) VALUES (?, ?, '[]', ?)`)
    .run(dispatch_id, iter, Date.now());
}

describe('reapBootOrphans', () => {
  let db: Database.Database;
  beforeEach(() => { db = fullDb(); });
  afterEach(() => { db.close(); });

  it('returns 0 orphans on a clean DB', () => {
    const r = reapBootOrphans(db);
    expect(r.orphans_found).toBe(0);
    expect(r.session_ids).toEqual([]);
    expect(r.snapshots_deleted).toBe(0);
  });

  it('reaps a pending session with a snapshot', () => {
    seedSession(db, 'cyp_dead', 'pending');
    seedSnapshot(db, 'cyp_dead');
    const r = reapBootOrphans(db);
    expect(r.orphans_found).toBe(1);
    expect(r.session_ids).toEqual(['cyp_dead']);
    expect(r.snapshots_deleted).toBe(1);
  });

  it('flips reaped session to halted + abandoned + outcome_note', () => {
    seedSession(db, 'cyp_dead', 'pending');
    seedSnapshot(db, 'cyp_dead');
    reapBootOrphans(db);
    const row = db.prepare(`SELECT status, outcome, outcome_note FROM cypher_sessions WHERE session_id = ?`).get('cyp_dead') as { status: string; outcome: string; outcome_note: string };
    expect(row.status).toBe('halted');
    expect(row.outcome).toBe('abandoned');
    expect(row.outcome_note).toBe('bridge_restart_during_dispatch');
  });

  it('deletes the snapshot row for reaped dispatches', () => {
    seedSession(db, 'cyp_dead', 'pending');
    seedSnapshot(db, 'cyp_dead');
    reapBootOrphans(db);
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM dispatch_snapshots WHERE dispatch_id = ?`).get('cyp_dead') as { n: number }).n;
    expect(n).toBe(0);
  });

  it('leaves pending sessions WITHOUT a snapshot untouched', () => {
    seedSession(db, 'cyp_pending_no_snap', 'pending');
    reapBootOrphans(db);
    const row = db.prepare(`SELECT status FROM cypher_sessions WHERE session_id = ?`).get('cyp_pending_no_snap') as { status: string };
    expect(row.status).toBe('pending');
  });

  it('leaves done sessions untouched even if they have a stale snapshot', () => {
    seedSession(db, 'cyp_done_stale_snap', 'done', 'success');
    seedSnapshot(db, 'cyp_done_stale_snap');
    reapBootOrphans(db);
    const row = db.prepare(`SELECT status, outcome FROM cypher_sessions WHERE session_id = ?`).get('cyp_done_stale_snap') as { status: string; outcome: string };
    expect(row.status).toBe('done');
    expect(row.outcome).toBe('success');
  });

  it('reaps multiple orphans in one pass', () => {
    seedSession(db, 'cyp_a', 'pending');
    seedSnapshot(db, 'cyp_a');
    seedSession(db, 'cyp_b', 'pending');
    seedSnapshot(db, 'cyp_b');
    seedSession(db, 'cyp_c', 'pending');
    seedSnapshot(db, 'cyp_c');
    const r = reapBootOrphans(db);
    expect(r.orphans_found).toBe(3);
    expect(r.session_ids.sort()).toEqual(['cyp_a', 'cyp_b', 'cyp_c']);
  });

  it('is idempotent — a second call finds zero orphans', () => {
    seedSession(db, 'cyp_dead', 'pending');
    seedSnapshot(db, 'cyp_dead');
    reapBootOrphans(db);
    const r = reapBootOrphans(db);
    expect(r.orphans_found).toBe(0);
  });

  it('preserves an existing outcome_note via COALESCE', () => {
    db.prepare(`INSERT INTO cypher_sessions (session_id, goal, user, status, outcome_note) VALUES ('cyp_with_note', 'g', 'maaz', 'pending', 'pre-existing note')`).run();
    seedSnapshot(db, 'cyp_with_note');
    reapBootOrphans(db);
    const row = db.prepare(`SELECT outcome_note FROM cypher_sessions WHERE session_id = ?`).get('cyp_with_note') as { outcome_note: string };
    expect(row.outcome_note).toBe('pre-existing note');
  });

  it('multi-orphan run leaves zero stuck in pending', () => {
    for (const id of ['x1', 'x2', 'x3']) {
      seedSession(db, id, 'pending');
      seedSnapshot(db, id);
    }
    reapBootOrphans(db);
    const stuck = db.prepare(`SELECT COUNT(*) AS n FROM cypher_sessions WHERE session_id IN ('x1','x2','x3') AND status != 'halted'`).get() as { n: number };
    expect(stuck.n).toBe(0);
  });
});
