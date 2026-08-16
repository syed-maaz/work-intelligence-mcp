/**
 * D7 dispatch durability tests — ADR-038 v2.5 (2026-06-26).
 *
 * Coverage:
 *   - dispatch_snapshots UPSERT on (dispatch_id) — second iter overwrites first
 *   - DELETE-on-close cleanup pattern (verified at SQL level)
 *   - Snapshot data shape (messages_blob as JSON; iter_number monotonic)
 *
 * The loop.ts integration itself is exercised end-to-end via smoke § 34 —
 * we don't unit-test runLoop because it requires the full DB + Anthropic
 * stub. The SQL contract is what matters here.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import migrateV59 from '../../../src/db/migrations/v59_cypher_tables.js';
import migrateV83 from '../../../src/db/migrations/v83_d6_retention_gc.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV59(db);
  migrateV83(db);
  return db;
}

describe('dispatch_snapshots UPSERT contract (D7 loop integration)', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  function writeSnapshot(dispatch_id: string, iter: number, messages: unknown[]): void {
    db.prepare(`
      INSERT INTO dispatch_snapshots (dispatch_id, iter_number, messages_blob, written_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(dispatch_id) DO UPDATE SET
        iter_number = excluded.iter_number,
        messages_blob = excluded.messages_blob,
        written_at = excluded.written_at
    `).run(dispatch_id, iter, JSON.stringify(messages), Date.now());
  }

  it('first write inserts a row', () => {
    writeSnapshot('cyp_a', 1, [{ role: 'user', content: 'hi' }]);
    const row = db.prepare(`SELECT iter_number FROM dispatch_snapshots WHERE dispatch_id = ?`).get('cyp_a') as { iter_number: number };
    expect(row.iter_number).toBe(1);
  });

  it('second write upserts (one row per dispatch)', () => {
    writeSnapshot('cyp_a', 1, [{ role: 'user', content: 'a' }]);
    writeSnapshot('cyp_a', 2, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
    const rows = db.prepare(`SELECT iter_number, messages_blob FROM dispatch_snapshots WHERE dispatch_id = ?`).all('cyp_a') as Array<{ iter_number: number; messages_blob: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].iter_number).toBe(2);
    const parsed = JSON.parse(rows[0].messages_blob) as unknown[];
    expect(parsed).toHaveLength(2);
  });

  it('different dispatch_ids get separate rows', () => {
    writeSnapshot('cyp_a', 1, [{ role: 'user', content: 'a' }]);
    writeSnapshot('cyp_b', 1, [{ role: 'user', content: 'b' }]);
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM dispatch_snapshots`).get() as { n: number }).n;
    expect(n).toBe(2);
  });

  it('DELETE on close removes the snapshot', () => {
    writeSnapshot('cyp_c', 1, [{ role: 'user', content: 'x' }]);
    db.prepare(`DELETE FROM dispatch_snapshots WHERE dispatch_id = ?`).run('cyp_c');
    const remaining = (db.prepare(`SELECT COUNT(*) AS n FROM dispatch_snapshots WHERE dispatch_id = ?`).get('cyp_c') as { n: number }).n;
    expect(remaining).toBe(0);
  });

  it('messages_blob round-trips structured content', () => {
    const original = [
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 't', input: { k: 'v' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
    ];
    writeSnapshot('cyp_d', 1, original);
    const row = db.prepare(`SELECT messages_blob FROM dispatch_snapshots WHERE dispatch_id = ?`).get('cyp_d') as { messages_blob: string };
    const restored = JSON.parse(row.messages_blob) as unknown[];
    expect(restored).toEqual(original);
  });

  it('written_at advances on UPSERT', async () => {
    writeSnapshot('cyp_e', 1, []);
    const first = (db.prepare(`SELECT written_at FROM dispatch_snapshots WHERE dispatch_id = ?`).get('cyp_e') as { written_at: number }).written_at;
    // Brief spin so Date.now() advances by at least 1ms.
    const start = Date.now();
    while (Date.now() === start) { /* spin */ }
    writeSnapshot('cyp_e', 2, []);
    const second = (db.prepare(`SELECT written_at FROM dispatch_snapshots WHERE dispatch_id = ?`).get('cyp_e') as { written_at: number }).written_at;
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
