/**
 * GC daemon tests — ADR-038 v2.5 D6 follow-up (2026-06-27).
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
import migrateV71 from '../../../src/db/migrations/v71_cypher_sessions_posture.js';
import migrateV80 from '../../../src/db/migrations/v80_d18_reasoning_trace.js';
import migrateV82 from '../../../src/db/migrations/v82_d5_permissions_ledger.js';
import migrateV83 from '../../../src/db/migrations/v83_d6_retention_gc.js';
import { startGcDaemon } from '../../../src/services/cypher/gc-daemon.js';

function fullDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
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
  migrateV71(db);
  migrateV80(db);
  migrateV82(db);
  migrateV83(db);
  return db;
}

describe('startGcDaemon', () => {
  let db: Database.Database;
  beforeEach(() => { db = fullDb(); });
  afterEach(() => { db.close(); });

  it('returns a handle with stop() and intervalMs', () => {
    const h = startGcDaemon(db, { intervalMs: 10_000, firstTickDelayMs: 60_000 });
    expect(typeof h.stop).toBe('function');
    expect(h.intervalMs).toBe(10_000);
    h.stop();
  });

  it('intervalMs defaults to env var when not provided in opts', () => {
    const prev = process.env.CYPHER_GC_INTERVAL_MS;
    process.env.CYPHER_GC_INTERVAL_MS = '12345';
    const h = startGcDaemon(db, { firstTickDelayMs: 60_000 });
    expect(h.intervalMs).toBe(12345);
    h.stop();
    if (prev === undefined) delete process.env.CYPHER_GC_INTERVAL_MS;
    else process.env.CYPHER_GC_INTERVAL_MS = prev;
  });

  it('intervalMs defaults to 24h when neither opt nor env set', () => {
    const prev = process.env.CYPHER_GC_INTERVAL_MS;
    delete process.env.CYPHER_GC_INTERVAL_MS;
    const h = startGcDaemon(db, { firstTickDelayMs: 60_000 });
    expect(h.intervalMs).toBe(24 * 60 * 60 * 1000);
    h.stop();
    if (prev !== undefined) process.env.CYPHER_GC_INTERVAL_MS = prev;
  });

  it('fires the first tick after firstTickDelayMs and writes a gc_log row', async () => {
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM gc_log`).get() as { n: number }).n;
    const h = startGcDaemon(db, { intervalMs: 10_000, firstTickDelayMs: 10 });
    await new Promise(r => setTimeout(r, 60));
    h.stop();
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM gc_log`).get() as { n: number }).n;
    expect(after).toBe(before + 1);
  });

  it('stop() prevents further ticks', async () => {
    const h = startGcDaemon(db, { intervalMs: 10, firstTickDelayMs: 5 });
    await new Promise(r => setTimeout(r, 40));
    h.stop();
    const snapshot = (db.prepare(`SELECT COUNT(*) AS n FROM gc_log`).get() as { n: number }).n;
    await new Promise(r => setTimeout(r, 60));
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM gc_log`).get() as { n: number }).n;
    // No more ticks after stop() — count is stable.
    expect(after).toBe(snapshot);
  });
});
