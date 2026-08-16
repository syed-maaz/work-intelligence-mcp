/**
 * v64 migration test — ADR-034 L1.1 cypher_outcomes ledger (2026-06-15).
 *
 * Coverage:
 *   - Idempotency (AC L1.1-C-03): two ensureLatest() calls land the
 *     same end-state; running migrateV64 twice on a populated table
 *     is a no-op.
 *   - CHECK constraints (AC L1.1-C-01, X-04): signal_kind enum,
 *     value [-1,1], weight > 0.
 *   - FK CASCADE on session deletion (AC L1.1-C-01 implied).
 *   - Indexes exist (AC L1.1-C-02).
 *   - Verdict backfill (AC L1.1-C-07): one row per closed session
 *     with the ADR-034 §Layer 1 weight table. metadata.backfilled=1.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import migrateV59 from '../../src/db/migrations/v59_cypher_tables.js';
import migrateV64 from '../../src/db/migrations/v64_cypher_outcomes.js';

function createV59Db(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // v59 ships cypher_sessions + cypher_steps + skill_priors. v60-v63
  // add work_items / pm_auto / skill_actually_invoked / skill_catalog
  // — none of which v64 reads, so jumping straight from v59 to v64 is
  // a clean test fixture (no need to plumb migrations we don't touch).
  migrateV59(db);
  return db;
}

function seedSession(
  db: Database.Database,
  session_id: string,
  outcome: string | null,
  goal: string = 'goal',
): void {
  db.prepare(`
    INSERT INTO cypher_sessions (session_id, goal, user, status, outcome, started_at, completed_at)
    VALUES (?, ?, 'maaz', ?, ?, datetime('now', '-1 hour'), CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)
  `).run(session_id, goal, outcome ? 'done' : 'pending', outcome, outcome);
}

describe('v64 migration — ADR-034 L1.1 cypher_outcomes', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createV59Db();
  });

  it('creates the cypher_outcomes table with the expected columns', () => {
    migrateV64(db);
    const cols = db.prepare(`PRAGMA table_info(cypher_outcomes)`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual(['created_at', 'created_by', 'id', 'metadata', 'session_id', 'signal_kind', 'value', 'weight']);
  });

  it('enforces signal_kind enum (CHECK)', () => {
    migrateV64(db);
    seedSession(db, 'cyp_x', null);
    expect(() =>
      db.prepare(
        `INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, ?, ?, 1.0)`,
      ).run('cyp_x', 'bogus_kind', 0.5),
    ).toThrow(/CHECK/i);
  });

  it('enforces value range [-1, 1] (CHECK)', () => {
    migrateV64(db);
    seedSession(db, 'cyp_x', null);
    // Out-of-range high
    expect(() =>
      db.prepare(
        `INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, ?, ?, 1.0)`,
      ).run('cyp_x', 'thumbs', 1.5),
    ).toThrow(/CHECK/i);
    // Out-of-range low
    expect(() =>
      db.prepare(
        `INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, ?, ?, 1.0)`,
      ).run('cyp_x', 'thumbs', -2.0),
    ).toThrow(/CHECK/i);
    // In-range edges work
    expect(() =>
      db.prepare(
        `INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, ?, ?, 1.0)`,
      ).run('cyp_x', 'thumbs', 1.0),
    ).not.toThrow();
    expect(() =>
      db.prepare(
        `INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, ?, ?, 1.0)`,
      ).run('cyp_x', 'thumbs', -1.0),
    ).not.toThrow();
  });

  it('enforces weight > 0 (CHECK)', () => {
    migrateV64(db);
    seedSession(db, 'cyp_x', null);
    expect(() =>
      db.prepare(
        `INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, ?, ?, ?)`,
      ).run('cyp_x', 'thumbs', 0.5, 0),
    ).toThrow(/CHECK/i);
    expect(() =>
      db.prepare(
        `INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, ?, ?, ?)`,
      ).run('cyp_x', 'thumbs', 0.5, -1),
    ).toThrow(/CHECK/i);
  });

  it('cascades on session deletion (FK)', () => {
    migrateV64(db);
    seedSession(db, 'cyp_drop', null);
    db.prepare(`INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, 'thumbs', 0.8, 1.0)`).run('cyp_drop');
    expect((db.prepare(`SELECT COUNT(*) AS n FROM cypher_outcomes`).get() as { n: number }).n).toBe(1);
    db.prepare(`DELETE FROM cypher_sessions WHERE session_id = ?`).run('cyp_drop');
    expect((db.prepare(`SELECT COUNT(*) AS n FROM cypher_outcomes`).get() as { n: number }).n).toBe(0);
  });

  it('creates the expected indexes', () => {
    migrateV64(db);
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cypher_outcomes' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name).sort();
    expect(names).toContain('idx_cypher_outcomes_session');
    expect(names).toContain('idx_cypher_outcomes_recent_signals');
  });

  it('is idempotent — second migrateV64 call is a no-op', () => {
    migrateV64(db);
    seedSession(db, 'cyp_x', null);
    db.prepare(`INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, 'thumbs', 0.8, 1.0)`).run('cyp_x');
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM cypher_outcomes`).get() as { n: number }).n;
    expect(before).toBe(1);
    // Re-running the migration should not drop or re-create the table.
    expect(() => migrateV64(db)).not.toThrow();
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM cypher_outcomes`).get() as { n: number }).n;
    expect(after).toBe(1); // existing row preserved
  });

  it('backfills one verdict row per closed session', () => {
    // Seed a mix of closed + pending sessions BEFORE the migration runs.
    seedSession(db, 'cyp_a', 'success');
    seedSession(db, 'cyp_b', 'mixed');
    seedSession(db, 'cyp_c', 'failed');
    seedSession(db, 'cyp_d', null); // pending — should NOT be backfilled

    migrateV64(db);

    const rows = db.prepare(`
      SELECT session_id, value, weight, created_by, json_extract(metadata, '$.backfilled') AS backfilled
      FROM cypher_outcomes ORDER BY session_id
    `).all() as Array<{ session_id: string; value: number; weight: number; created_by: string; backfilled: number }>;

    expect(rows.map(r => r.session_id)).toEqual(['cyp_a', 'cyp_b', 'cyp_c']);
    expect(rows[0].value).toBe(0.8);   // success
    expect(rows[1].value).toBe(0.0);   // mixed
    expect(rows[2].value).toBe(-0.8);  // failed
    expect(rows.every(r => r.weight === 1.0)).toBe(true);
    expect(rows.every(r => r.created_by === '__backfill')).toBe(true);
    expect(rows.every(r => r.backfilled === 1)).toBe(true);
  });

  it('backfill skips sessions with NULL outcome', () => {
    seedSession(db, 'cyp_pending', null);
    migrateV64(db);
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM cypher_outcomes`).get() as { n: number }).n;
    expect(count).toBe(0);
  });
});
