import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import up, { down } from '../../src/db/migrations/v46_budget_bucket.js';

function createV45Db() {
  const db = new Database(':memory:');
  // Create the brain_user_budget_ledger table as it exists in v45
  db.exec(`CREATE TABLE IF NOT EXISTS brain_user_budget_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL,
    day_iso TEXT NOT NULL,
    spend INTEGER NOT NULL DEFAULT 0,
    cap INTEGER NOT NULL DEFAULT 50
  )`);
  return db;
}

describe('v46 migration', () => {
  it('adds bucket column on fresh DB', () => {
    const db = createV45Db();
    up(db);
    const cols = db.prepare("PRAGMA table_info(brain_user_budget_ledger)").all() as any[];
    expect(cols.some(c => c.name === 'bucket')).toBe(true);
  });

  it('is idempotent — running twice does not throw', () => {
    const db = createV45Db();
    up(db);
    expect(() => up(db)).not.toThrow();
  });

  it('backfills pre-existing rows to bucket="brain"', () => {
    const db = createV45Db();
    db.exec(`INSERT INTO brain_user_budget_ledger (user, day_iso, spend, cap) VALUES ('alice', '2026-05-20', 5, 50)`);
    up(db);
    const row = db.prepare(`SELECT bucket FROM brain_user_budget_ledger WHERE user='alice'`).get() as any;
    expect(row.bucket).toBe('brain');
  });

  it('down() drops the index but leaves the column', () => {
    const db = createV45Db();
    up(db);
    down(db);
    // Column still present
    const cols = db.prepare("PRAGMA table_info(brain_user_budget_ledger)").all() as any[];
    expect(cols.some(c => c.name === 'bucket')).toBe(true);
    // Index gone
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_brain_budget_user_day_bucket'`).get();
    expect(idx).toBeUndefined();
  });
});
