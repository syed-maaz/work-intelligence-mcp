import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import migrateV53 from '../../src/db/migrations/v53_bug_capture_tables.js';

function createV52Db() {
  const db = new Database(':memory:');
  // Phase A only references brain_decisions from bug_investigations. Create a
  // minimal stub so the FK declares cleanly. Real schema migration order is
  // 45 → ... → 53 with brain_decisions present from v45; we shortcut here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_decisions (
      id INTEGER PRIMARY KEY
    );
  `);
  db.pragma('foreign_keys = ON');
  return db;
}

describe('v53 migration — ADR-030 Phase A bug capture tables', () => {
  it('creates all five tables on a fresh DB', () => {
    const db = createV52Db();
    migrateV53(db);
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map(r => r.name)
    );
    expect(tables.has('bugs')).toBe(true);
    expect(tables.has('bug_occurrences')).toBe(true);
    expect(tables.has('bug_investigations')).toBe(true);
    expect(tables.has('auto_merge_blocklist')).toBe(true);
    expect(tables.has('auto_merge_audit')).toBe(true);
  });

  it('is idempotent — running twice does not throw', () => {
    const db = createV52Db();
    migrateV53(db);
    expect(() => migrateV53(db)).not.toThrow();
  });

  it('inserts a row into each table and SELECT COUNT returns 1', () => {
    const db = createV52Db();
    migrateV53(db);
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run('fp1', 'bridge', 'Err', 'm', now, now);
    db.prepare(`INSERT INTO bug_occurrences (bug_id, seen_at) VALUES (?, ?)`).run(1, now);
    db.prepare(`INSERT INTO bug_investigations (bug_id, root_cause, files_to_change, confidence, decided_at)
                VALUES (?, ?, ?, ?, ?)`).run(1, 'rc', '[]', 0.8, now);
    db.prepare(`INSERT INTO auto_merge_blocklist (fingerprint, reason, blocked_at) VALUES (?, ?, ?)`).run('fp1', 'r', now);
    db.prepare(`INSERT INTO auto_merge_audit (bug_id, fingerprint, merged_at) VALUES (?, ?, ?)`).run(1, 'fp1', now);

    expect((db.prepare(`SELECT COUNT(*) AS n FROM bugs`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM bug_occurrences`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM bug_investigations`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM auto_merge_blocklist`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM auto_merge_audit`).get() as { n: number }).n).toBe(1);
  });

  it('rejects bug_occurrences row with non-existent bug_id (FK enforced)', () => {
    const db = createV52Db();
    migrateV53(db);
    expect(() =>
      db.prepare(`INSERT INTO bug_occurrences (bug_id, seen_at) VALUES (?, ?)`).run(999, '2026-05-31')
    ).toThrow(/FOREIGN KEY/i);
  });

  it("source CHECK enum includes 'bug-investigator' (recursion-guard placeholder)", () => {
    const db = createV52Db();
    migrateV53(db);
    const now = new Date().toISOString();
    expect(() =>
      db.prepare(`INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at)
                  VALUES (?, ?, ?, ?, ?, ?)`).run('fpInv', 'bug-investigator', 'Err', 'm', now, now)
    ).not.toThrow();
    const row = db.prepare(`SELECT source FROM bugs WHERE fingerprint = ?`).get('fpInv') as { source: string } | undefined;
    expect(row?.source).toBe('bug-investigator');
  });

  it('rejects bugs.source values outside the enum', () => {
    const db = createV52Db();
    migrateV53(db);
    const now = new Date().toISOString();
    expect(() =>
      db.prepare(`INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at)
                  VALUES (?, ?, ?, ?, ?, ?)`).run('fpBad', 'mainframe', 'E', 'm', now, now)
    ).toThrow(/CHECK constraint/i);
  });

  it('rejects bugs.severity outside low|medium|high', () => {
    const db = createV52Db();
    migrateV53(db);
    const now = new Date().toISOString();
    expect(() =>
      db.prepare(`INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at, severity)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`).run('fpSev', 'bridge', 'E', 'm', now, now, 'critical')
    ).toThrow(/CHECK constraint/i);
  });

  it('UNIQUE on bugs.fingerprint blocks naive duplicate INSERTs', () => {
    const db = createV52Db();
    migrateV53(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run('fpUnique', 'bridge', 'E', 'm', now, now);
    expect(() =>
      db.prepare(`INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at)
                  VALUES (?, ?, ?, ?, ?, ?)`).run('fpUnique', 'bridge', 'E', 'm', now, now)
    ).toThrow(/UNIQUE/i);
  });

  it('ON DELETE CASCADE removes bug_occurrences when bug is deleted', () => {
    const db = createV52Db();
    migrateV53(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run('fpC', 'bridge', 'E', 'm', now, now);
    const id = (db.prepare(`SELECT id FROM bugs WHERE fingerprint = ?`).get('fpC') as { id: number }).id;
    db.prepare(`INSERT INTO bug_occurrences (bug_id, seen_at) VALUES (?, ?)`).run(id, now);
    db.prepare(`INSERT INTO bug_occurrences (bug_id, seen_at) VALUES (?, ?)`).run(id, now);
    db.prepare(`DELETE FROM bugs WHERE id = ?`).run(id);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM bug_occurrences`).get() as { n: number }).n).toBe(0);
  });

  it('confidence CHECK rejects values outside 0..1', () => {
    const db = createV52Db();
    migrateV53(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run('fpConf', 'bridge', 'E', 'm', now, now);
    const id = (db.prepare(`SELECT id FROM bugs WHERE fingerprint = ?`).get('fpConf') as { id: number }).id;
    expect(() =>
      db.prepare(`INSERT INTO bug_investigations (bug_id, root_cause, files_to_change, confidence, decided_at)
                  VALUES (?, ?, ?, ?, ?)`).run(id, 'rc', '[]', 1.5, now)
    ).toThrow(/CHECK constraint/i);
  });
});
