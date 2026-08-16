/**
 * v57 migration test — Phase 78a-01 (chat_modes + chat_messages).
 *
 * Mirrors the v56 test pattern: in-memory DB, run migration, assert the new
 * tables exist with the expected columns + CHECK constraints + indexes, plus
 * an idempotent re-run check and an UPSERT collapse check on chat_modes.
 *
 * Drift-prevention pattern from Phase 73 F2: tests reference table + index
 * names by literal string so a future rename breaks the test with a useful
 * "table not found" error rather than silently passing.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import migrateV57 from '../../../src/db/migrations/v57_chat_modes_messages.js';

function createV56Db(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // v57 is net-new (chat_modes + chat_messages have no FKs against any
  // pre-v57 table) so we don't need to apply v45→v56 to set up dependencies.
  return db;
}

describe('v57 migration — Phase 78a chat_modes + chat_messages', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createV56Db();
  });

  it('creates chat_modes and chat_messages tables', () => {
    migrateV57(db);
    const tables = new Set(
      (db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as Array<{ name: string }>).map(r => r.name),
    );
    expect(tables.has('chat_modes')).toBe(true);
    expect(tables.has('chat_messages')).toBe(true);
  });

  it('chat_modes has the expected columns and types', () => {
    migrateV57(db);
    const cols = db.prepare(`PRAGMA table_info(chat_modes)`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = new Map(cols.map(c => [c.name, c] as const));

    expect(byName.get('conversation_id')?.type).toBe('TEXT');
    expect(byName.get('conversation_id')?.pk).toBe(1);
    expect(byName.get('manual_mode')?.type).toBe('TEXT');
    expect(byName.get('last_detected')?.type).toBe('TEXT');
    expect(byName.get('last_detected')?.notnull).toBe(1);
    expect(byName.get('last_signals')?.type).toBe('TEXT');
    expect(byName.get('last_signals')?.notnull).toBe(1);
    expect(byName.get('last_confidence')?.type).toBe('REAL');
    expect(byName.get('last_confidence')?.notnull).toBe(1);
    expect(byName.get('updated_at')?.type).toBe('INTEGER');
    expect(byName.get('updated_at')?.notnull).toBe(1);
  });

  it('chat_messages has the expected columns and types', () => {
    migrateV57(db);
    const cols = db.prepare(`PRAGMA table_info(chat_messages)`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const names = cols.map(c => c.name);
    for (const expected of [
      'id',
      'conversation_id',
      'role',
      'content',
      'mode',
      'private_turn',
      'ts',
      'metadata',
    ]) {
      expect(names).toContain(expected);
    }

    const byName = new Map(cols.map(c => [c.name, c] as const));
    expect(byName.get('id')?.pk).toBe(1);
    expect(byName.get('conversation_id')?.notnull).toBe(1);
    expect(byName.get('role')?.notnull).toBe(1);
    expect(byName.get('content')?.notnull).toBe(1);
    expect(byName.get('private_turn')?.notnull).toBe(1);
    expect(byName.get('ts')?.notnull).toBe(1);
    // mode + metadata are nullable.
    expect(byName.get('mode')?.notnull).toBe(0);
    expect(byName.get('metadata')?.notnull).toBe(0);
  });

  it('creates the three chat_messages indexes (one full + two partial)', () => {
    migrateV57(db);
    const idx = db
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='chat_messages'`,
      )
      .all() as Array<{ name: string; sql: string | null }>;
    const byName = new Map(idx.map(i => [i.name, i] as const));

    expect(byName.has('idx_chat_messages_conv_ts')).toBe(true);
    expect(byName.has('idx_chat_messages_mode_ts')).toBe(true);
    expect(byName.has('idx_chat_messages_private')).toBe(true);

    // mode_ts and private indexes must be partial (WHERE clause in DDL).
    expect(byName.get('idx_chat_messages_mode_ts')?.sql ?? '').toMatch(/WHERE/i);
    expect(byName.get('idx_chat_messages_private')?.sql ?? '').toMatch(/WHERE/i);
  });

  it('CHECK constraints reject bad values', () => {
    migrateV57(db);
    const now = Date.now();

    // chat_modes.last_detected must be 'work' | 'life' | 'ambiguous'.
    expect(() =>
      db
        .prepare(
          `INSERT INTO chat_modes (conversation_id, last_detected, updated_at) VALUES (?, ?, ?)`,
        )
        .run('conv-bad-detected', 'invalid', now),
    ).toThrow(/CHECK/i);

    // chat_modes.manual_mode must be NULL | 'work' | 'life' (not 'ambiguous').
    expect(() =>
      db
        .prepare(
          `INSERT INTO chat_modes (conversation_id, manual_mode, last_detected, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run('conv-bad-manual', 'ambiguous', 'work', now),
    ).toThrow(/CHECK/i);

    // chat_messages.role must be 'user' | 'assistant' (not 'system').
    expect(() =>
      db
        .prepare(
          `INSERT INTO chat_messages (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)`,
        )
        .run('conv-1', 'system', 'hi', now),
    ).toThrow(/CHECK/i);

    // chat_messages.mode must be NULL | 'work' | 'life' | 'ambiguous'.
    expect(() =>
      db
        .prepare(
          `INSERT INTO chat_messages (conversation_id, role, content, mode, ts) VALUES (?, ?, ?, ?, ?)`,
        )
        .run('conv-1', 'user', 'hi', 'garbage', now),
    ).toThrow(/CHECK/i);

    // chat_messages.private_turn must be 0 | 1.
    expect(() =>
      db
        .prepare(
          `INSERT INTO chat_messages (conversation_id, role, content, private_turn, ts)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('conv-1', 'user', 'hi', 2, now),
    ).toThrow(/CHECK/i);
  });

  it('CHECK constraints accept all enumerated good values', () => {
    migrateV57(db);
    const now = Date.now();

    // chat_modes — every valid (manual_mode, last_detected) combo.
    let i = 0;
    for (const last_detected of ['work', 'life', 'ambiguous']) {
      for (const manual_mode of [null, 'work', 'life']) {
        db.prepare(
          `INSERT INTO chat_modes (conversation_id, manual_mode, last_detected, updated_at)
           VALUES (?, ?, ?, ?)`,
        ).run(`conv-${i++}`, manual_mode, last_detected, now);
      }
    }
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM chat_modes`).get() as { n: number }).n,
    ).toBe(9);

    // chat_messages — every valid (role, mode, private_turn) shape.
    for (const role of ['user', 'assistant']) {
      for (const mode of [null, 'work', 'life', 'ambiguous']) {
        for (const priv of [0, 1]) {
          db.prepare(
            `INSERT INTO chat_messages (conversation_id, role, content, mode, private_turn, ts)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run('conv-msg', role, 'hi', mode, priv, now);
        }
      }
    }
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM chat_messages`).get() as { n: number }).n,
    ).toBe(2 * 4 * 2);
  });

  it('is idempotent — running twice does not throw and tables exist exactly once', () => {
    migrateV57(db);
    expect(() => migrateV57(db)).not.toThrow();

    const tableRows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('chat_modes','chat_messages')`,
      )
      .get() as { n: number };
    expect(tableRows.n).toBe(2);

    // Indexes also single-instance.
    const idxRows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index'
           AND name IN ('idx_chat_messages_conv_ts','idx_chat_messages_mode_ts','idx_chat_messages_private')`,
      )
      .get() as { n: number };
    expect(idxRows.n).toBe(3);
  });

  it('UPSERT on chat_modes(conversation_id) collapses to one row, last write wins', () => {
    migrateV57(db);
    const now = Date.now();

    db.prepare(
      `INSERT INTO chat_modes (conversation_id, last_detected, last_confidence, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('conv-up', 'work', 0.6, now);

    db.prepare(
      `INSERT INTO chat_modes (conversation_id, last_detected, last_confidence, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         last_detected = excluded.last_detected,
         last_confidence = excluded.last_confidence,
         updated_at = excluded.updated_at`,
    ).run('conv-up', 'life', 0.85, now + 1000);

    const rows = db
      .prepare(`SELECT * FROM chat_modes WHERE conversation_id = ?`)
      .all('conv-up') as Array<{ last_detected: string; last_confidence: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0].last_detected).toBe('life');
    expect(rows[0].last_confidence).toBe(0.85);
  });
});
