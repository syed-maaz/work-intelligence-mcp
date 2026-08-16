/**
 * v65 migration test — ADR-034 L1.1 follow-up (2026-06-16).
 *
 * **The crucial discovery this test set encodes:** the parked
 * worktree's `cypher_outcomes.weight` column actually held the SIGNAL
 * VALUE (not a multiplier). Live data showed weights like -0.7 for
 * rerun, +0.8 for thumbs_up, ±1.0 for verdict — those are values, not
 * weights. The v64 PRD shape separates value (signal score) from
 * weight (uniform 1.0 multiplier). v65's migration translates by
 * mapping old.weight → new.value and setting new.weight = 1.0.
 *
 * Coverage:
 *   - Fresh DB (already-v64 shape) → v65 is a no-op.
 *   - Old worktree shape → renamed to _v_old; new table created with
 *     v64 shape; rows translated correctly:
 *       - thumbs_up   → kind='thumbs', value=old.weight (e.g. +0.8)
 *       - thumbs_down → kind='thumbs', value=old.weight (e.g. -1.0)
 *       - rerun       → kind='rerun',  value=old.weight (e.g. -0.7)
 *       - verdict     → kind='verdict', value=old.weight (-1, 0.5, +1)
 *       - merge_unchanged / merge_with_edits / smoke_break → SKIPPED
 *         (placeholders only; no L1.1 translation).
 *   - Already-migrated DB (cypher_outcomes_v_old already exists) → no-op.
 *   - metadata carries `migrated_from_v_old=1` on every translated row.
 *   - created_at preserves the original captured_at value.
 *   - Rows with weight outside [-1, +1] are filtered out (v64 CHECK).
 *   - Orphan rows (session deleted) are filtered via EXISTS guard.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import migrateV59 from '../../src/db/migrations/v59_cypher_tables.js';
import migrateV64 from '../../src/db/migrations/v64_cypher_outcomes.js';
import migrateV65 from '../../src/db/migrations/v65_cypher_outcomes_legacy_upgrade.js';

/**
 * Build an in-memory DB that simulates the parked phase-83 worktree's
 * cypher_outcomes shape. Mirrors the worktree's v66 (commit a42dd09).
 */
function freshDbWithOldShape(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateV59(db);
  db.exec(`
    CREATE TABLE cypher_outcomes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT NOT NULL,
      signal_kind  TEXT NOT NULL CHECK(signal_kind IN (
        'verdict','rerun','thumbs_up','thumbs_down',
        'merge_unchanged','merge_with_edits','smoke_break'
      )),
      weight       REAL NOT NULL,
      captured_at  TEXT NOT NULL DEFAULT (datetime('now')),
      evidence     TEXT,
      FOREIGN KEY (session_id) REFERENCES cypher_sessions(session_id)
    );
  `);
  return db;
}

/** Build an in-memory DB already on the v64 shape. */
function freshDbV64(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateV59(db);
  migrateV64(db);
  return db;
}

function seedSession(
  db: Database.Database,
  session_id: string,
  outcome: string | null = null,
): void {
  db.prepare(`
    INSERT INTO cypher_sessions (session_id, goal, user, status, outcome, started_at, completed_at)
    VALUES (?, 'goal', 'maaz', ?, ?, datetime('now'), CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)
  `).run(session_id, outcome ? 'done' : 'pending', outcome, outcome);
}

function seedOldRow(
  db: Database.Database,
  session_id: string,
  signal_kind: string,
  weight: number,
  evidence: string | null = null,
  captured_at: string = '2026-06-14 16:00:00',
): void {
  db.prepare(`
    INSERT INTO cypher_outcomes (session_id, signal_kind, weight, captured_at, evidence)
    VALUES (?, ?, ?, ?, ?)
  `).run(session_id, signal_kind, weight, captured_at, evidence);
}

describe('v65 migration — legacy cypher_outcomes upgrade', () => {
  describe('fresh DB (already-v64 shape)', () => {
    let db: Database.Database;
    beforeEach(() => { db = freshDbV64(); });
    afterEach(() => { db.close(); });

    it('is a no-op when cypher_outcomes is already in v64 shape', () => {
      expect(() => migrateV65(db)).not.toThrow();
      const oldTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cypher_outcomes_v_old'`).all();
      expect(oldTable).toHaveLength(0);
      const cols = (db.prepare(`PRAGMA table_info(cypher_outcomes)`).all() as Array<{ name: string }>).map(c => c.name);
      expect(cols).toContain('value');
      expect(cols).toContain('metadata');
      expect(cols).toContain('created_by');
    });

    it('preserves any existing v64 rows (no destructive rewrite)', () => {
      seedSession(db, 'cyp_x');
      db.prepare(`INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, 'thumbs', 0.8, 1.0)`).run('cyp_x');
      migrateV65(db);
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM cypher_outcomes`).get() as { n: number }).n;
      expect(n).toBe(1);
    });
  });

  describe('old worktree shape', () => {
    let db: Database.Database;
    beforeEach(() => { db = freshDbWithOldShape(); });
    afterEach(() => { db.close(); });

    it('renames old table to _v_old and creates v64-shape cypher_outcomes', () => {
      seedSession(db, 'cyp_a');
      seedOldRow(db, 'cyp_a', 'thumbs_up', 0.8, 'click via panel');

      migrateV65(db);

      const oldTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cypher_outcomes_v_old'`).all();
      expect(oldTable).toHaveLength(1);
      const cols = (db.prepare(`PRAGMA table_info(cypher_outcomes)`).all() as Array<{ name: string }>).map(c => c.name);
      expect(cols).toContain('value');
      expect(cols).toContain('metadata');
      expect(cols).toContain('created_by');
      expect(cols).not.toContain('captured_at');
      expect(cols).not.toContain('evidence');
    });

    it('translates thumbs_up → kind=thumbs, value=old.weight, weight=1.0', () => {
      seedSession(db, 'cyp_a');
      seedOldRow(db, 'cyp_a', 'thumbs_up', 0.8, 'evidence-up', '2026-06-14 10:00:00');

      migrateV65(db);

      const rows = db.prepare(`
        SELECT session_id, signal_kind, value, weight, created_by, created_at,
               json_extract(metadata, '$.migrated_from_v_old') AS migrated,
               json_extract(metadata, '$.legacy_kind') AS legacy_kind,
               json_extract(metadata, '$.legacy_evidence') AS legacy_evidence
        FROM cypher_outcomes
      `).all() as Array<{
        session_id: string; signal_kind: string; value: number; weight: number;
        created_by: string; created_at: string; migrated: number;
        legacy_kind: string; legacy_evidence: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        session_id: 'cyp_a',
        signal_kind: 'thumbs',
        value: 0.8,
        weight: 1.0,
        created_by: '__migrated',
        created_at: '2026-06-14 10:00:00',
        migrated: 1,
        legacy_kind: 'thumbs_up',
        legacy_evidence: 'evidence-up',
      });
    });

    it('translates thumbs_down → kind=thumbs, value=old.weight (e.g. -1.0)', () => {
      seedSession(db, 'cyp_a');
      seedOldRow(db, 'cyp_a', 'thumbs_down', -1.0, null);

      migrateV65(db);

      const row = db.prepare(`SELECT signal_kind, value, weight FROM cypher_outcomes`).get() as { signal_kind: string; value: number; weight: number };
      expect(row.signal_kind).toBe('thumbs');
      expect(row.value).toBe(-1.0);
      expect(row.weight).toBe(1.0);
    });

    it('translates rerun → kind=rerun, value=old.weight (e.g. -0.7)', () => {
      seedSession(db, 'cyp_a');
      seedOldRow(db, 'cyp_a', 'rerun', -0.7, '{"prior_session_id":"cyp_z"}');

      migrateV65(db);

      const row = db.prepare(`SELECT signal_kind, value, weight FROM cypher_outcomes`).get() as { signal_kind: string; value: number; weight: number };
      expect(row.signal_kind).toBe('rerun');
      expect(row.value).toBe(-0.7);
      expect(row.weight).toBe(1.0);
    });

    it('translates verdict → kind=verdict, value=old.weight verbatim (no JOIN with sessions)', () => {
      // Live data showed verdict.weight ranging -1.0 to 1.0 (the
      // worktree's verdict writer encoded success=+1, failed=-1, mixed
      // somewhere in between). The new shape preserves whatever value
      // the old shape had — we don't re-derive from session.outcome.
      seedSession(db, 'cyp_s', 'success');
      seedSession(db, 'cyp_m', 'mixed');
      seedSession(db, 'cyp_f', 'failed');
      seedOldRow(db, 'cyp_s', 'verdict', 1.0, 'success');
      seedOldRow(db, 'cyp_m', 'verdict', 0.0, 'mixed');
      seedOldRow(db, 'cyp_f', 'verdict', -1.0, 'failed');

      migrateV65(db);

      const rows = db.prepare(`SELECT session_id, signal_kind, value FROM cypher_outcomes ORDER BY session_id`).all() as Array<{ session_id: string; signal_kind: string; value: number }>;
      expect(rows).toEqual([
        { session_id: 'cyp_f', signal_kind: 'verdict', value: -1.0 },
        { session_id: 'cyp_m', signal_kind: 'verdict', value: 0.0 },
        { session_id: 'cyp_s', signal_kind: 'verdict', value: 1.0 },
      ]);
    });

    it('skips placeholder kinds (merge_unchanged, merge_with_edits, smoke_break)', () => {
      seedSession(db, 'cyp_a');
      seedOldRow(db, 'cyp_a', 'merge_unchanged', 0.5, null);
      seedOldRow(db, 'cyp_a', 'merge_with_edits', 0.5, null);
      seedOldRow(db, 'cyp_a', 'smoke_break', -0.9, null);
      seedOldRow(db, 'cyp_a', 'thumbs_up', 0.8, null); // one valid row

      migrateV65(db);

      const kinds = db.prepare(`SELECT signal_kind FROM cypher_outcomes ORDER BY signal_kind`).all() as Array<{ signal_kind: string }>;
      expect(kinds.map(k => k.signal_kind)).toEqual(['thumbs']); // only the thumbs_up survived
    });

    it('skips rows whose weight is outside [-1, +1] (v64 CHECK guard)', () => {
      seedSession(db, 'cyp_a');
      seedOldRow(db, 'cyp_a', 'thumbs_up', 1.5, null); // out of range — defensive
      seedOldRow(db, 'cyp_a', 'thumbs_down', -2.0, null); // out of range
      seedOldRow(db, 'cyp_a', 'thumbs_up', 0.8, null); // in range

      migrateV65(db);

      const rows = db.prepare(`SELECT value FROM cypher_outcomes`).all() as Array<{ value: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe(0.8);
    });

    it('skips rows whose session was deleted before migration (orphans)', () => {
      seedSession(db, 'cyp_a');
      seedOldRow(db, 'cyp_a', 'thumbs_up', 0.8, null);
      // Disable FK to allow the orphaning delete (the old shape's FK
      // wasn't CASCADE).
      db.pragma('foreign_keys = OFF');
      db.prepare(`DELETE FROM cypher_sessions WHERE session_id = 'cyp_a'`).run();
      db.pragma('foreign_keys = ON');

      migrateV65(db);

      const n = (db.prepare(`SELECT COUNT(*) AS n FROM cypher_outcomes`).get() as { n: number }).n;
      expect(n).toBe(0);
    });

    it('translates live-DB-shaped data correctly (76 verdict + 12 rerun + 10 thumbs_up scenario)', () => {
      // Seed sessions to back the rows.
      for (let i = 0; i < 76; i++) {
        seedSession(db, `cyp_v${i}`, i % 3 === 0 ? 'success' : i % 3 === 1 ? 'mixed' : 'failed');
        const w = i % 3 === 0 ? 1.0 : i % 3 === 1 ? 0.5 : -1.0;
        seedOldRow(db, `cyp_v${i}`, 'verdict', w);
      }
      for (let i = 0; i < 12; i++) {
        seedSession(db, `cyp_r${i}`);
        seedOldRow(db, `cyp_r${i}`, 'rerun', -0.7);
      }
      for (let i = 0; i < 10; i++) {
        seedSession(db, `cyp_t${i}`);
        seedOldRow(db, `cyp_t${i}`, 'thumbs_up', 0.8);
      }

      migrateV65(db);

      const counts = db.prepare(`
        SELECT signal_kind, COUNT(*) AS n
        FROM cypher_outcomes GROUP BY signal_kind ORDER BY signal_kind
      `).all() as Array<{ signal_kind: string; n: number }>;
      expect(counts).toEqual([
        { signal_kind: 'rerun',   n: 12 },
        { signal_kind: 'thumbs',  n: 10 },
        { signal_kind: 'verdict', n: 76 },
      ]);
    });
  });

  describe('idempotency', () => {
    it('is a no-op on a second run (cypher_outcomes_v_old already exists)', () => {
      const db = freshDbWithOldShape();
      seedSession(db, 'cyp_a');
      seedOldRow(db, 'cyp_a', 'thumbs_up', 0.8, null);

      migrateV65(db);
      const firstCount = (db.prepare(`SELECT COUNT(*) AS n FROM cypher_outcomes`).get() as { n: number }).n;
      expect(firstCount).toBe(1);

      // Second run — must be a no-op.
      expect(() => migrateV65(db)).not.toThrow();
      const secondCount = (db.prepare(`SELECT COUNT(*) AS n FROM cypher_outcomes`).get() as { n: number }).n;
      expect(secondCount).toBe(1);
      db.close();
    });
  });
});
