import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import migrateV108 from '../../src/db/migrations/v108_posture_enum_widen.js';

describe('v108 posture CHECK constraint (add from scratch)', () => {
  function setup(): Database.Database {
    const db = new Database(':memory:');
    // Reproduce the pre-v108 state: posture TEXT NULL, no CHECK.
    db.exec(`
      CREATE TABLE cypher_sessions (
        session_id TEXT PRIMARY KEY,
        goal       TEXT NOT NULL,
        posture    TEXT NULL
      );
    `);
    return db;
  }

  it('post-migration, posture accepts all intended values', () => {
    const db = setup();
    migrateV108(db);
    for (const p of ['pr-review', 'bug-investigate', 'pm', 'generic', 'architect', 'pm-resume']) {
      expect(() =>
        db
          .prepare(`INSERT INTO cypher_sessions (session_id, goal, posture) VALUES (?, 'g', ?)`)
          .run(`s_${p}`, p),
      ).not.toThrow();
    }
  });

  it('post-migration, NULL posture is still accepted (legacy rows)', () => {
    const db = setup();
    migrateV108(db);
    expect(() =>
      db
        .prepare(`INSERT INTO cypher_sessions (session_id, goal, posture) VALUES ('s_null', 'g', NULL)`)
        .run(),
    ).not.toThrow();
  });

  it('post-migration, posture rejects bogus values', () => {
    const db = setup();
    migrateV108(db);
    expect(() =>
      db
        .prepare(`INSERT INTO cypher_sessions (session_id, goal, posture) VALUES ('s_bogus', 'g', 'bogus')`)
        .run(),
    ).toThrow(/CHECK constraint/);
  });

  it('preserves existing rows (including NULL posture) across migration', () => {
    const db = setup();
    db.prepare(`INSERT INTO cypher_sessions (session_id, goal, posture) VALUES ('legacy', 'goal', NULL)`).run();
    migrateV108(db);
    const row = db
      .prepare(`SELECT posture FROM cypher_sessions WHERE session_id = 'legacy'`)
      .get() as { posture: string | null };
    expect(row.posture).toBeNull();
  });

  it('is idempotent — re-run does not throw', () => {
    const db = setup();
    migrateV108(db);
    expect(() => migrateV108(db)).not.toThrow();
  });
});
