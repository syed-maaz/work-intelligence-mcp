import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import migrateV107 from '../../src/db/migrations/v107_sub_task_events.js';

describe('v107 sub_task_events migration', () => {
  it('creates sub_task_events with correct schema', () => {
    const db = new Database(':memory:');
    migrateV107(db);
    const cols = db
      .prepare(`SELECT name, type FROM pragma_table_info('sub_task_events')`)
      .all() as Array<{ name: string; type: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'created_at',
      'id',
      'kind',
      'payload_json',
      'resolution_note',
      'resolved_at',
      'resolved_by',
      'sub_task_id',
    ]);
  });

  it('enforces kind CHECK constraint', () => {
    const db = new Database(':memory:');
    migrateV107(db);
    // Valid kind — should succeed
    expect(() =>
      db
        .prepare(
          `INSERT INTO sub_task_events (sub_task_id, kind, payload_json) VALUES ('t1', 'question', '{}')`,
        )
        .run(),
    ).not.toThrow();
    // Invalid kind — should throw
    expect(() =>
      db
        .prepare(
          `INSERT INTO sub_task_events (sub_task_id, kind, payload_json) VALUES ('t2', 'bogus', '{}')`,
        )
        .run(),
    ).toThrow(/CHECK constraint/);
  });

  it('creates partial index on unresolved events', () => {
    const db = new Database(':memory:');
    migrateV107(db);
    const idxs = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sub_task_events'`,
      )
      .all() as Array<{ name: string }>;
    expect(idxs.some((i) => i.name === 'idx_ste_unresolved')).toBe(true);
  });

  it('is idempotent — re-run does not throw', () => {
    const db = new Database(':memory:');
    migrateV107(db);
    expect(() => migrateV107(db)).not.toThrow();
  });
});
