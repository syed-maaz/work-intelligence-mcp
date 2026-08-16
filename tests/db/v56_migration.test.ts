import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import migrateV52 from '../../src/db/migrations/v52_model_config.js';
import migrateV53 from '../../src/db/migrations/v53_bug_capture_tables.js';
import migrateV54 from '../../src/db/migrations/v54_bug_last_investigation.js';
import migrateV55 from '../../src/db/migrations/v55_bug_severity_override.js';
import migrateV56 from '../../src/db/migrations/v56_bug_resolver.js';

function createV55Db() {
  const db = new Database(':memory:');
  // brain_decisions stub for the FK in bug_investigations + bug_resolutions.
  db.exec(`CREATE TABLE IF NOT EXISTS brain_decisions (id INTEGER PRIMARY KEY)`);
  db.pragma('foreign_keys = ON');
  // Apply v52→v55 to land at the correct starting state for v56.
  migrateV52(db);
  migrateV53(db);
  migrateV54(db);
  migrateV55(db);
  return db;
}

describe('v56 migration — ADR-030 Phase C (Plan 76-01)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createV55Db();
  });

  it('widens bugs.status CHECK enum with the three new resolver values', () => {
    migrateV56(db);
    const tableSql = (db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='bugs'`)
      .get() as { sql: string }).sql;
    expect(tableSql).toContain("'auto-resolved'");
    expect(tableSql).toContain("'resolving'");
    expect(tableSql).toContain("'unable-to-resolve'");
  });

  it('preserves all pre-existing status values after the enum widen', () => {
    migrateV56(db);
    const tableSql = (db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='bugs'`)
      .get() as { sql: string }).sql;
    for (const status of ['new', 'investigating', 'proposed', 'auto-merged', 'resolved', 'wont-fix']) {
      expect(tableSql).toContain(`'${status}'`);
    }
  });

  it('preserves bugs row data through the create-new-copy-drop-rename', () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('fp-survives', 'bridge', 'TypeError', 'cannot read x', now, now, 'proposed');
    migrateV56(db);
    const row = db.prepare(`SELECT * FROM bugs WHERE fingerprint=?`).get('fp-survives') as
      | { fingerprint: string; status: string; error_name: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.status).toBe('proposed');
    expect(row?.error_name).toBe('TypeError');
  });

  it('preserves v55 severity_override columns through the rebuild', () => {
    migrateV56(db);
    const cols = db.prepare(`PRAGMA table_info(bugs)`).all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('severity_override');
    expect(names).toContain('severity_override_reason');
    expect(names).toContain('severity_override_at');
  });

  it('accepts the new resolver status values on INSERT', () => {
    migrateV56(db);
    const now = new Date().toISOString();
    for (const status of ['resolving', 'auto-resolved', 'unable-to-resolve']) {
      db.prepare(
        `INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(`fp-${status}`, 'bridge', 'E', 'm', now, now, status);
    }
    const count = (db.prepare(
      `SELECT COUNT(*) AS n FROM bugs WHERE status IN ('resolving','auto-resolved','unable-to-resolve')`,
    ).get() as { n: number }).n;
    expect(count).toBe(3);
  });

  it('still rejects invalid status values after the widen', () => {
    migrateV56(db);
    const now = new Date().toISOString();
    expect(() =>
      db.prepare(
        `INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('fp-bad', 'bridge', 'E', 'm', now, now, 'invented-status'),
    ).toThrow(/CHECK/i);
  });

  it('creates bug_resolutions table with the right columns', () => {
    migrateV56(db);
    const cols = db.prepare(`PRAGMA table_info(bug_resolutions)`).all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    for (const expected of [
      'id', 'bug_id', 'attempt_at', 'outcome', 'cwd',
      'files_changed', 'commit_sha', 'failure_reason', 'brain_decision_id',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('creates idx_bug_resolutions_bug_attempt index', () => {
    migrateV56(db);
    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_bug_resolutions_bug_attempt'`,
    ).get();
    expect(idx).toBeDefined();
  });

  it('bug_resolutions outcome CHECK enforces auto-resolved | unable-to-resolve', () => {
    migrateV56(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('fp-res', 'bridge', 'E', 'm', now, now);
    const bugId = (db.prepare(`SELECT id FROM bugs WHERE fingerprint=?`).get('fp-res') as { id: number }).id;
    expect(() =>
      db.prepare(
        `INSERT INTO bug_resolutions (bug_id, attempt_at, outcome, cwd) VALUES (?, ?, ?, ?)`,
      ).run(bugId, now, 'wishful-thinking', '/tmp'),
    ).toThrow(/CHECK/i);
    db.prepare(
      `INSERT INTO bug_resolutions (bug_id, attempt_at, outcome, cwd) VALUES (?, ?, ?, ?)`,
    ).run(bugId, now, 'auto-resolved', '/tmp');
    const ok = db.prepare(`SELECT COUNT(*) AS n FROM bug_resolutions`).get() as { n: number };
    expect(ok.n).toBe(1);
  });

  it('bug_resolutions ON DELETE CASCADE removes rows when parent bug deleted', () => {
    migrateV56(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO bugs (fingerprint, source, error_name, message, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('fp-cascade', 'bridge', 'E', 'm', now, now);
    const bugId = (db.prepare(`SELECT id FROM bugs WHERE fingerprint=?`).get('fp-cascade') as { id: number }).id;
    db.prepare(
      `INSERT INTO bug_resolutions (bug_id, attempt_at, outcome, cwd) VALUES (?, ?, ?, ?)`,
    ).run(bugId, now, 'auto-resolved', '/tmp');
    db.prepare(`DELETE FROM bugs WHERE id=?`).run(bugId);
    const remaining = (db.prepare(`SELECT COUNT(*) AS n FROM bug_resolutions WHERE bug_id=?`).get(bugId) as { n: number }).n;
    expect(remaining).toBe(0);
  });

  it('seeds the bug-resolver bucket in model_config', () => {
    migrateV56(db);
    const row = db.prepare(`SELECT * FROM model_config WHERE bucket=?`).get('bug-resolver') as
      | { bucket: string; model: string; effort: string; thinking_mode: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.model).toBe('claude-opus-latest');
    expect(row?.effort).toBe('max');
    expect(row?.thinking_mode).toBe('off');
  });

  it('takes model_config from 7 to 8 buckets', () => {
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM model_config`).get() as { n: number }).n,
    ).toBe(7);
    migrateV56(db);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM model_config`).get() as { n: number }).n,
    ).toBe(8);
  });

  it('is idempotent — running twice does not throw and does not duplicate', () => {
    migrateV56(db);
    expect(() => migrateV56(db)).not.toThrow();
    // 8 buckets, not 9.
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM model_config`).get() as { n: number }).n,
    ).toBe(8);
    // The bug_resolutions table still exists exactly once.
    const tableRows = db.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='bug_resolutions'`,
    ).get() as { n: number };
    expect(tableRows.n).toBe(1);
  });

  it('does NOT clobber a manual bug-resolver model override on re-run', () => {
    migrateV56(db);
    db.prepare(`UPDATE model_config SET model=? WHERE bucket=?`).run('claude-sonnet-4-6', 'bug-resolver');
    migrateV56(db);
    const row = db.prepare(`SELECT model FROM model_config WHERE bucket=?`).get('bug-resolver') as { model: string };
    expect(row.model).toBe('claude-sonnet-4-6');
  });
});
