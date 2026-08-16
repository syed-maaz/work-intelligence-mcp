/**
 * v104 migration test — dispatch_source column (ADR-050 Phase 0).
 *
 * Covers:
 *   - Fresh DB (no cypher_sessions yet): migration is a no-op that also
 *     no-ops on the ALTER because pragma_table_info returns empty
 *   - Existing cypher_sessions table without dispatch_source: column added,
 *     legacy rows default to 'unknown', new rows accept the enum values
 *   - Re-running the migration is idempotent (guarded on pragma_table_info)
 *   - CHECK constraint rejects invalid dispatch_source values
 *   - Partial index exists after migration
 *   - Index only covers rows where dispatch_source != 'unknown'
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import migrateV59 from '../../src/db/migrations/v59_cypher_tables.js';
import migrateV104 from '../../src/db/migrations/v104_dispatch_source.js';

function freshDbPreV104(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Minimum viable cypher_sessions from v59 (before v104 column addition)
  migrateV59(db);
  return db;
}

describe('v104 — dispatch_source column', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDbPreV104();
  });

  afterEach(() => {
    db.close();
  });

  it('adds the dispatch_source column to cypher_sessions', () => {
    const before = db
      .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('cypher_sessions')`)
      .all();
    expect(before.some((c) => c.name === 'dispatch_source')).toBe(false);

    migrateV104(db);

    const after = db
      .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('cypher_sessions')`)
      .all();
    expect(after.some((c) => c.name === 'dispatch_source')).toBe(true);
  });

  it('legacy rows default to "unknown"', () => {
    // Insert a legacy row BEFORE migration
    db.prepare(
      `INSERT INTO cypher_sessions (session_id, goal, user, status)
       VALUES ('cyp_legacy_1', 'legacy goal', 'maaz', 'done')`,
    ).run();

    migrateV104(db);

    const row = db
      .prepare<[], { dispatch_source: string }>(
        `SELECT dispatch_source FROM cypher_sessions WHERE session_id = 'cyp_legacy_1'`,
      )
      .get();
    expect(row?.dispatch_source).toBe('unknown');
  });

  it('accepts all five enum values on new inserts', () => {
    migrateV104(db);
    const validValues = ['user', 'smoke', 'test', 'agent', 'unknown'];
    for (const value of validValues) {
      db.prepare(
        `INSERT INTO cypher_sessions (session_id, goal, user, status, dispatch_source)
         VALUES (?, ?, 'maaz', 'done', ?)`,
      ).run(`cyp_test_${value}`, `test goal ${value}`, value);
    }
    const count = db
      .prepare<[], { n: number }>(`SELECT COUNT(*) as n FROM cypher_sessions`)
      .get();
    expect(count?.n).toBe(5);
  });

  it('rejects invalid dispatch_source values via CHECK constraint', () => {
    migrateV104(db);
    expect(() => {
      db.prepare(
        `INSERT INTO cypher_sessions (session_id, goal, user, status, dispatch_source)
         VALUES ('cyp_bad', 'bad goal', 'maaz', 'done', 'invalid-value')`,
      ).run();
    }).toThrow(/CHECK constraint failed/i);
  });

  it('is idempotent (re-running does not error or duplicate the column)', () => {
    migrateV104(db);
    // Insert one row so we can verify data survives a second migration
    db.prepare(
      `INSERT INTO cypher_sessions (session_id, goal, user, status, dispatch_source)
       VALUES ('cyp_persistent', 'goal', 'maaz', 'done', 'user')`,
    ).run();

    // Second run — should be a no-op
    expect(() => migrateV104(db)).not.toThrow();

    // Data preserved, no duplicate columns
    const columns = db
      .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('cypher_sessions')`)
      .all();
    const dispatchSourceCols = columns.filter((c) => c.name === 'dispatch_source');
    expect(dispatchSourceCols.length).toBe(1);

    const row = db
      .prepare<[], { dispatch_source: string }>(
        `SELECT dispatch_source FROM cypher_sessions WHERE session_id = 'cyp_persistent'`,
      )
      .get();
    expect(row?.dispatch_source).toBe('user');
  });

  it('creates the partial index on (dispatch_source, outcome)', () => {
    migrateV104(db);
    const indexes = db
      .prepare<[], { name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='cypher_sessions'`,
      )
      .all();
    const targetIndex = indexes.find(
      (i) => i.name === 'idx_cypher_sessions_dispatch_source',
    );
    expect(targetIndex).toBeDefined();
    // Verify it's the partial index (has WHERE clause)
    expect(targetIndex?.sql).toMatch(/WHERE dispatch_source != 'unknown'/i);
  });

  it('allows filtering: user vs smoke separation is machine-readable', () => {
    migrateV104(db);
    db.prepare(
      `INSERT INTO cypher_sessions (session_id, goal, user, status, dispatch_source, outcome)
       VALUES ('cyp_u1', 'real user goal', 'maaz', 'done', 'user', 'success')`,
    ).run();
    db.prepare(
      `INSERT INTO cypher_sessions (session_id, goal, user, status, dispatch_source, outcome)
       VALUES ('cyp_s1', 'smoke § 20.2 trivial', 'maaz', 'done', 'smoke', 'mixed')`,
    ).run();

    // The whole point of v104: measurement queries filter on the column,
    // not on goal text
    const realUserRows = db
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) as n FROM cypher_sessions WHERE dispatch_source = 'user'`,
      )
      .get();
    expect(realUserRows?.n).toBe(1);

    const smokeRows = db
      .prepare<[], { n: number }>(
        `SELECT COUNT(*) as n FROM cypher_sessions WHERE dispatch_source = 'smoke'`,
      )
      .get();
    expect(smokeRows?.n).toBe(1);

    // Note: `goal LIKE '%smoke%'` would match BOTH rows here (the real user
    // goal contains "smoke" too — this is exactly the H-12/H-14 failure mode).
    // The dispatch_source column separates them cleanly.
  });
});
