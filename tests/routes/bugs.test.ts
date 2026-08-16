import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import migrateV52 from '../../src/db/migrations/v52_model_config.js';
import migrateV53 from '../../src/db/migrations/v53_bug_capture_tables.js';
import migrateV54 from '../../src/db/migrations/v54_bug_last_investigation.js';
import migrateV55 from '../../src/db/migrations/v55_bug_severity_override.js';
import {
  captureBug,
  computeSeverity,
  buildBugsHealthBlock,
  resolveAllBugs,
} from '../../src/routes/bugs.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  // brain_decisions stub for the FK in bug_investigations.
  db.exec(`CREATE TABLE IF NOT EXISTS brain_decisions (id INTEGER PRIMARY KEY)`);
  db.pragma('foreign_keys = ON');
  migrateV52(db);
  migrateV53(db);
  migrateV54(db);
  migrateV55(db);
  return db;
}

describe('captureBug — UPSERT semantics', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('first call inserts a row and returns is_new=true', () => {
    const r = captureBug(db, {
      source: 'bridge',
      errorName: 'TypeError',
      message: 'first call',
      stack: '    at handler (/src/x.ts:10)',
    });
    expect(r.is_new).toBe(true);
    expect(r.occurrence_count).toBe(1);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM bugs`).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('second call with same payload increments occurrence_count, no new row', () => {
    const a = captureBug(db, {
      source: 'bridge',
      errorName: 'TypeError',
      message: 'same fingerprint',
      stack: '    at handler (/src/y.ts:1)',
    });
    const b = captureBug(db, {
      source: 'bridge',
      errorName: 'TypeError',
      message: 'same fingerprint',
      stack: '    at handler (/src/y.ts:1)',
    });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(b.is_new).toBe(false);
    expect(b.occurrence_count).toBe(2);
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM bugs`).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('100 sequential calls with identical payload → 1 bug row, occurrence_count=100, 100 occurrences', () => {
    let fp = '';
    for (let i = 0; i < 100; i++) {
      const r = captureBug(db, {
        source: 'bridge',
        errorName: 'TypeError',
        message: 'stress test',
        stack: '    at handler (/src/z.ts:1)',
      });
      if (i === 0) fp = r.fingerprint;
      expect(r.fingerprint).toBe(fp);
    }
    expect((db.prepare(`SELECT COUNT(*) AS n FROM bugs`).get() as { n: number }).n).toBe(1);
    expect(
      (db.prepare(`SELECT occurrence_count FROM bugs`).get() as { occurrence_count: number }).occurrence_count,
    ).toBe(100);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM bug_occurrences`).get() as { n: number }).n).toBe(100);
  });

  it('different sources with same name+message produce different fingerprints (2 rows)', () => {
    captureBug(db, { source: 'bridge', errorName: 'E', message: 'm' });
    captureBug(db, { source: 'agent',  errorName: 'E', message: 'm' });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM bugs`).get() as { n: number }).n).toBe(2);
  });

  it("source='bug-investigator' round-trips (recursion-guard placeholder)", () => {
    const r = captureBug(db, {
      source: 'bug-investigator',
      errorName: 'SelfTest',
      message: 'recursion guard placeholder',
    });
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const row = db.prepare(`SELECT source FROM bugs WHERE fingerprint = ?`).get(r.fingerprint) as { source: string };
    expect(row.source).toBe('bug-investigator');
  });

  it('writes context_json when context is provided', () => {
    const r = captureBug(db, {
      source: 'bridge',
      errorName: 'E',
      message: 'with ctx',
      context: { req_id: 'abc-123', route: '/api/x' },
    });
    const row = db.prepare(`SELECT context_json FROM bugs WHERE id = ?`).get(r.id) as { context_json: string | null };
    expect(row.context_json).not.toBeNull();
    expect(JSON.parse(row.context_json!)).toEqual({ req_id: 'abc-123', route: '/api/x' });
  });
});

describe('computeSeverity — real query against bug_occurrences', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('low for a single occurrence', () => {
    const r = captureBug(db, { source: 'bridge', errorName: 'E', message: 'one' });
    expect(r.severity).toBe('low');
  });

  it('medium after 5 occurrences within 24h', () => {
    let last = { severity: 'low' as string };
    for (let i = 0; i < 5; i++) {
      last = captureBug(db, { source: 'bridge', errorName: 'E', message: 'window-medium' });
    }
    expect(last.severity).toBe('medium');
  });

  it('high after 10 occurrences within 1h', () => {
    let last = { severity: 'low' as string };
    for (let i = 0; i < 10; i++) {
      last = captureBug(db, { source: 'bridge', errorName: 'E', message: 'window-high' });
    }
    expect(last.severity).toBe('high');
  });

  it("agent crash-loop: high after 5 occurrences within 10 min", () => {
    let last = { severity: 'low' as string };
    for (let i = 0; i < 5; i++) {
      last = captureBug(db, { source: 'agent', errorName: 'AgentE', message: 'crash-loop' });
    }
    expect(last.severity).toBe('high');
  });

  it('non-agent source needs ≥10/hour for high (5 is only medium)', () => {
    let last = { severity: 'low' as string };
    for (let i = 0; i < 5; i++) {
      last = captureBug(db, { source: 'bridge', errorName: 'E', message: 'bridge-five' });
    }
    expect(last.severity).toBe('medium');
  });
});

describe('buildBugsHealthBlock', () => {
  it('returns zero-state on an empty DB', () => {
    const db = freshDb();
    const block = buildBugsHealthBlock(db);
    expect(block.total).toBe(0);
    expect(block.new).toBe(0);
    expect(block.investigating).toBe(0);
    expect(block.proposed).toBe(0);
    expect(block.auto_merged_24h).toBe(0);
    expect(block.resolved_24h).toBe(0);
    expect(block.top_fingerprints).toEqual([]);
    expect(block.investigator_status).toBe('not-implemented');
    expect(block.auto_merge_cooldown_until).toBeNull();
  });

  it('counts bugs by status and lists top fingerprints', () => {
    const db = freshDb();
    captureBug(db, { source: 'bridge', errorName: 'A', message: 'a' });
    captureBug(db, { source: 'bridge', errorName: 'A', message: 'a' });
    captureBug(db, { source: 'bridge', errorName: 'B', message: 'b' });
    const block = buildBugsHealthBlock(db);
    expect(block.total).toBe(2);
    expect(block.new).toBe(2);
    expect(block.top_fingerprints).toHaveLength(2);
    // Top fingerprint should be the one with occurrence_count=2.
    expect(block.top_fingerprints[0].occurrence_count).toBe(2);
  });

  it('excludes resolved/wont-fix from top_fingerprints', () => {
    const db = freshDb();
    const a = captureBug(db, { source: 'bridge', errorName: 'A', message: 'a' });
    db.prepare(`UPDATE bugs SET status='resolved' WHERE id = ?`).run(a.id);
    const block = buildBugsHealthBlock(db);
    expect(block.top_fingerprints).toEqual([]);
  });
});

describe('resolveAllBugs — Plan 75-07 bulk resolve', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('updates all matching new bugs to resolved by default', () => {
    captureBug(db, { source: 'bridge', errorName: 'A', message: 'a' });
    captureBug(db, { source: 'bridge', errorName: 'B', message: 'b' });
    captureBug(db, { source: 'bridge', errorName: 'C', message: 'c' });
    const result = resolveAllBugs(db, {
      status: 'new',
      resolution: 'resolved',
      max_matches: 100,
    });
    expect(result.updated).toBe(3);
    expect(result.skipped_over_cap).toBe(false);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE status='resolved'`).get() as { n: number }).n).toBe(3);
  });

  it('respects max_matches safety cap — returns updated:0 when filter matches more', () => {
    for (let i = 0; i < 5; i++) {
      captureBug(db, { source: 'bridge', errorName: `E${i}`, message: 'm' });
    }
    const result = resolveAllBugs(db, {
      status: 'new',
      resolution: 'resolved',
      max_matches: 2,
    });
    expect(result.updated).toBe(0);
    expect(result.skipped_over_cap).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE status='new'`).get() as { n: number }).n).toBe(5);
  });

  it('filter by source narrows the match', () => {
    captureBug(db, { source: 'bridge', errorName: 'A', message: 'a' });
    captureBug(db, { source: 'agent', errorName: 'A', message: 'a' });
    const result = resolveAllBugs(db, {
      status: 'new',
      source: 'bridge',
      resolution: 'resolved',
      max_matches: 100,
    });
    expect(result.updated).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE status='new' AND source='agent'`).get() as { n: number }).n).toBe(1);
  });

  it('filter by severity narrows the match', () => {
    captureBug(db, { source: 'bridge', errorName: 'A', message: 'a' });
    const b = captureBug(db, { source: 'bridge', errorName: 'B', message: 'b' });
    db.prepare(`UPDATE bugs SET severity='high' WHERE id=?`).run(b.id);
    const result = resolveAllBugs(db, {
      status: 'new',
      severity: 'high',
      resolution: 'resolved',
      max_matches: 100,
    });
    expect(result.updated).toBe(1);
  });

  it('resolution wont-fix sets status to wont-fix', () => {
    captureBug(db, { source: 'bridge', errorName: 'A', message: 'a' });
    const result = resolveAllBugs(db, {
      status: 'new',
      resolution: 'wont-fix',
      max_matches: 100,
    });
    expect(result.updated).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE status='wont-fix'`).get() as { n: number }).n).toBe(1);
  });

  it('only matches the requested status — leaves resolved/wont-fix alone', () => {
    const a = captureBug(db, { source: 'bridge', errorName: 'A', message: 'a' });
    captureBug(db, { source: 'bridge', errorName: 'B', message: 'b' });
    db.prepare(`UPDATE bugs SET status='resolved' WHERE id=?`).run(a.id);
    const result = resolveAllBugs(db, {
      status: 'new',
      resolution: 'resolved',
      max_matches: 100,
    });
    expect(result.updated).toBe(1);
    // The previously-resolved bug stays resolved (not double-set);
    // the new bug gets resolved.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE status='resolved'`).get() as { n: number }).n).toBe(2);
  });

  it('returns updated:0 when no rows match (and skipped_over_cap:false)', () => {
    const result = resolveAllBugs(db, {
      status: 'new',
      resolution: 'resolved',
      max_matches: 100,
    });
    expect(result.updated).toBe(0);
    expect(result.skipped_over_cap).toBe(false);
  });
});
