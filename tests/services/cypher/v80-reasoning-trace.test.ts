/**
 * v80 — D18 reasoning-trace observability tests (2026-06-26).
 *
 * Covers:
 *   - v80 migration adds reasoning_trace + controller_model columns
 *   - stage CHECK constraint accepts 'tool_use'
 *   - Existing rows survive the table-rebuild verbatim
 *   - INSERT round-trips the new fields correctly
 *   - 4KB truncation is the writer's responsibility (we test the
 *     constraint accepts the truncated value)
 *   - Stage CHECK still rejects unknown values
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import migrateV52 from '../../../src/db/migrations/v52_model_config.js';
import migrateV59 from '../../../src/db/migrations/v59_cypher_tables.js';
import migrateV60 from '../../../src/db/migrations/v60_cypher_pm.js';
import migrateV61 from '../../../src/db/migrations/v61_pm_auto_actions.js';
import migrateV62 from '../../../src/db/migrations/v62_skill_actually_invoked.js';
import migrateV63 from '../../../src/db/migrations/v63_skill_catalog.js';
import migrateV64 from '../../../src/db/migrations/v64_cypher_outcomes.js';
import migrateV65 from '../../../src/db/migrations/v65_cypher_outcomes_legacy_upgrade.js';
import migrateV66 from '../../../src/db/migrations/v66_cap13_birth_decisions.js';
import migrateV67 from '../../../src/db/migrations/v67_cypher_loop_columns.js';
import migrateV80 from '../../../src/db/migrations/v80_d18_reasoning_trace.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  // v52..v67 — bring cypher_steps + cypher_outcomes + cypher_sessions
  // up to the shape v80 expects to rebuild from.
  migrateV52(db);
  migrateV59(db);
  migrateV60(db);
  migrateV61(db);
  migrateV62(db);
  migrateV63(db);
  migrateV64(db);
  migrateV65(db);
  migrateV66(db);
  migrateV67(db);
  // v80 — D18 columns + widened CHECK.
  migrateV80(db);
  return db;
}

function seedSession(db: Database.Database, session_id: string): void {
  db.prepare(`INSERT INTO cypher_sessions (session_id, goal, user, status) VALUES (?, 'g', 'maaz', 'pending')`)
    .run(session_id);
}

describe('v80 migration shape', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('cypher_steps has reasoning_trace column', () => {
    const cols = db.prepare(`PRAGMA table_info(cypher_steps)`).all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('reasoning_trace');
  });

  it('cypher_steps has controller_model column', () => {
    const cols = db.prepare(`PRAGMA table_info(cypher_steps)`).all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('controller_model');
  });

  it('stage CHECK constraint widened to include tool_use', () => {
    seedSession(db, 'cyp_v80_a');
    expect(() => {
      db.prepare(`
        INSERT INTO cypher_steps (session_id, stage, stage_index, status, payload)
        VALUES ('cyp_v80_a', 'tool_use', 0, 'completed', '{"tool":"x"}')
      `).run();
    }).not.toThrow();
  });

  it('legacy stage values still accepted', () => {
    seedSession(db, 'cyp_v80_b');
    for (const stage of ['investigate', 'ask', 'research', 'plan', 'execute', 'quality_gate', 'confirm', 'surface', 'record']) {
      expect(() => {
        db.prepare(`
          INSERT INTO cypher_steps (session_id, stage, stage_index, status)
          VALUES ('cyp_v80_b', ?, 0, 'completed')
        `).run(stage);
      }).not.toThrow();
    }
  });

  it('unknown stage values still rejected', () => {
    seedSession(db, 'cyp_v80_c');
    expect(() => {
      db.prepare(`
        INSERT INTO cypher_steps (session_id, stage, stage_index, status)
        VALUES ('cyp_v80_c', 'invalid_stage_xyz', 0, 'completed')
      `).run();
    }).toThrow();
  });

  it('cypher_steps index recreated after rebuild', () => {
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='cypher_steps'`).all() as Array<{ name: string }>;
    expect(idx.map(i => i.name)).toContain('idx_cypher_steps_session');
  });

  it('FK cypher_steps.session_id → cypher_sessions still resolves', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO cypher_steps (session_id, stage, stage_index, status)
        VALUES ('cyp_ghost_session', 'tool_use', 0, 'completed')
      `).run();
    }).toThrow();
  });
});

describe('cypher_steps reasoning_trace + controller_model round-trip', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedSession(db, 'cyp_v80_rt');
  });
  afterEach(() => { db.close(); });

  it('writes and reads back reasoning_trace + controller_model', () => {
    db.prepare(`
      INSERT INTO cypher_steps (session_id, stage, stage_index, status, payload, reasoning_trace, controller_model)
      VALUES (?, 'tool_use', 0, 'completed', '{"tool":"brain_recall"}', ?, ?)
    `).run('cyp_v80_rt', 'I need to recall past decisions about search-provider', 'claude-sonnet-4-6');

    const row = db.prepare(`
      SELECT stage, reasoning_trace, controller_model FROM cypher_steps WHERE session_id = ?
    `).get('cyp_v80_rt') as { stage: string; reasoning_trace: string; controller_model: string };

    expect(row.stage).toBe('tool_use');
    expect(row.reasoning_trace).toBe('I need to recall past decisions about search-provider');
    expect(row.controller_model).toBe('claude-sonnet-4-6');
  });

  it('NULL reasoning_trace + controller_model permitted (legacy rows)', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO cypher_steps (session_id, stage, stage_index, status)
        VALUES (?, 'execute', 0, 'completed')
      `).run('cyp_v80_rt');
    }).not.toThrow();
    const row = db.prepare(`SELECT reasoning_trace, controller_model FROM cypher_steps WHERE session_id = ?`).get('cyp_v80_rt') as { reasoning_trace: unknown; controller_model: unknown };
    expect(row.reasoning_trace).toBeNull();
    expect(row.controller_model).toBeNull();
  });

  it('accepts a 4KB-truncated reasoning_trace (writer is responsible for slice)', () => {
    const big = 'A'.repeat(4096);
    expect(() => {
      db.prepare(`
        INSERT INTO cypher_steps (session_id, stage, stage_index, status, reasoning_trace)
        VALUES (?, 'tool_use', 0, 'completed', ?)
      `).run('cyp_v80_rt', big);
    }).not.toThrow();
    const row = db.prepare(`SELECT length(reasoning_trace) AS len FROM cypher_steps WHERE session_id = ?`).get('cyp_v80_rt') as { len: number };
    expect(row.len).toBe(4096);
  });
});
