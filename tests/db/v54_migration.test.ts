import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import migrateV52 from '../../src/db/migrations/v52_model_config.js';
import migrateV53 from '../../src/db/migrations/v53_bug_capture_tables.js';
import migrateV54 from '../../src/db/migrations/v54_bug_last_investigation.js';

function createV53Db() {
  const db = new Database(':memory:');
  // brain_decisions stub for the FK in bug_investigations (carried from v53 test).
  db.exec(`CREATE TABLE IF NOT EXISTS brain_decisions (id INTEGER PRIMARY KEY)`);
  db.pragma('foreign_keys = ON');
  // Apply v52 (model_config seeds 6 buckets) and v53 (bug capture tables)
  // so we're at the correct starting state for v54.
  migrateV52(db);
  migrateV53(db);
  return db;
}

describe('v54 migration — ADR-030 Phase B (Plan 75-01)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createV53Db();
  });

  it('adds bugs.last_investigation_id column', () => {
    migrateV54(db);
    const cols = db.prepare(`PRAGMA table_info(bugs)`).all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'last_investigation_id')).toBe(true);
  });

  it('creates idx_bugs_last_investigation index', () => {
    migrateV54(db);
    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_bugs_last_investigation'`,
    ).get();
    expect(idx).toBeDefined();
  });

  it('seeds the bug-investigator bucket in model_config', () => {
    migrateV54(db);
    const row = db.prepare(`SELECT * FROM model_config WHERE bucket=?`).get('bug-investigator') as
      | { bucket: string; model: string; effort: string; thinking_mode: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.model).toBe('claude-opus-4-8');
    expect(row?.effort).toBe('max');
    expect(row?.thinking_mode).toBe('adaptive');
  });

  it('takes model_config from 6 to 7 buckets', () => {
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM model_config`).get() as { n: number }).n,
    ).toBe(6);
    migrateV54(db);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM model_config`).get() as { n: number }).n,
    ).toBe(7);
  });

  it('is idempotent — running twice does not throw and does not duplicate', () => {
    migrateV54(db);
    expect(() => migrateV54(db)).not.toThrow();
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM model_config`).get() as { n: number }).n,
    ).toBe(7);
    // ALTER TABLE ADD COLUMN guard — the column should still exist exactly once.
    const cols = db.prepare(`PRAGMA table_info(bugs)`).all() as Array<{ name: string }>;
    const matches = cols.filter(c => c.name === 'last_investigation_id');
    expect(matches).toHaveLength(1);
  });

  it('does NOT clobber a manual override on re-run', () => {
    migrateV54(db);
    db.prepare(`UPDATE model_config SET model=? WHERE bucket=?`).run('claude-sonnet-4-6', 'bug-investigator');
    migrateV54(db);
    const row = db.prepare(`SELECT model FROM model_config WHERE bucket=?`).get('bug-investigator') as { model: string };
    expect(row.model).toBe('claude-sonnet-4-6');
  });

  it('FK on last_investigation_id can reference bug_investigations', () => {
    migrateV54(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('fp1', 'bridge', 'E', 'm', now, now);
    const bugId = (db.prepare(`SELECT id FROM bugs WHERE fingerprint=?`).get('fp1') as { id: number }).id;
    db.prepare(
      `INSERT INTO bug_investigations (bug_id, root_cause, files_to_change, confidence, decided_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(bugId, 'rc', '[]', 0.8, now);
    const invId = (db.prepare(`SELECT id FROM bug_investigations WHERE bug_id=?`).get(bugId) as { id: number }).id;

    // Set last_investigation_id to the new investigation; FK passes.
    db.prepare(`UPDATE bugs SET last_investigation_id=? WHERE id=?`).run(invId, bugId);
    const updated = db.prepare(`SELECT last_investigation_id FROM bugs WHERE id=?`).get(bugId) as { last_investigation_id: number };
    expect(updated.last_investigation_id).toBe(invId);

    // Setting to a non-existent investigation id rejects.
    expect(() =>
      db.prepare(`UPDATE bugs SET last_investigation_id=? WHERE id=?`).run(99999, bugId),
    ).toThrow(/FOREIGN KEY/i);
  });
});
