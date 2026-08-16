/**
 * outcomes.ts unit tests — ADR-034 L1.1 (2026-06-15).
 *
 * Coverage:
 *   - aggregateOutcome — weighted-mean math, [-1,1] clamp, empty case,
 *     mixed-signal aggregation (verdict + thumbs + rerun → expected
 *     weighted mean per AC L1.1-C-05).
 *   - recordOutcomeSignal — validation (kind, value range, thumbs
 *     allowlist, weight), idempotent UPSERT on (session_id,
 *     signal_kind, created_by), kill-switch wiring, missing-session
 *     rejection.
 *   - detectRerun — exact-match SQL window query (AC L1.1-B-02..B-06,
 *     X-05): writes against the EARLIER session, never the new one;
 *     multi-prior session writes one row per match.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import migrateV59 from '../../../src/db/migrations/v59_cypher_tables.js';
import migrateV64 from '../../../src/db/migrations/v64_cypher_outcomes.js';
import migrateV70 from '../../../src/db/migrations/v70_cypher_outcomes_failure_pattern.js';
import {
  aggregateOutcome,
  recordOutcomeSignal,
  detectRerun,
  THUMBS_UP_VALUE,
  THUMBS_DOWN_VALUE,
  RERUN_VALUE,
} from '../../../src/services/cypher/outcomes.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateV59(db);
  migrateV64(db);
  // ADR-038 v2.5 D8 — recordOutcomeSignal now writes failure_pattern.
  migrateV70(db);
  return db;
}

function seedSession(
  db: Database.Database,
  session_id: string,
  goal: string = 'goal',
  user: string = 'maaz',
  startedOffsetMin: number = 0,
): void {
  // started_at defaults to now in the table; we override here so rerun
  // window tests can pin a specific time. SQLite datetime modifiers
  // accept negative minutes for "in the past".
  db.prepare(`
    INSERT INTO cypher_sessions (session_id, goal, user, status, started_at)
    VALUES (?, ?, ?, 'pending', datetime('now', ?))
  `).run(session_id, goal, user, `${startedOffsetMin} minutes`);
}

describe('aggregateOutcome', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('returns {aggregate: 0, signals: []} for unknown session_id (AC L1.1-C-06)', () => {
    const result = aggregateOutcome(db, 'cyp_nope');
    expect(result.aggregate).toBe(0);
    expect(result.signals).toEqual([]);
  });

  it('returns {aggregate: 0, signals: []} for a session with no signals', () => {
    seedSession(db, 'cyp_empty');
    const result = aggregateOutcome(db, 'cyp_empty');
    expect(result.aggregate).toBe(0);
    expect(result.signals).toEqual([]);
  });

  it('weighted-means a single signal correctly', () => {
    seedSession(db, 'cyp_one');
    db.prepare(`INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, 'thumbs', 0.8, 1.0)`).run('cyp_one');
    const result = aggregateOutcome(db, 'cyp_one');
    expect(result.aggregate).toBeCloseTo(0.8, 6);
    expect(result.signals).toHaveLength(1);
  });

  it('combines verdict + thumbs as weighted mean, not sum (AC L1.1-C-05)', () => {
    // Two equal-weight signals at +0.8 each → weighted mean +0.8, NOT +1.6.
    seedSession(db, 'cyp_two');
    db.prepare(`INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, 'verdict', 0.8, 1.0)`).run('cyp_two');
    db.prepare(`INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, 'thumbs', 0.8, 1.0)`).run('cyp_two');
    expect(aggregateOutcome(db, 'cyp_two').aggregate).toBeCloseTo(0.8, 6);
  });

  it('weights matter — a heavier negative signal pulls the mean down', () => {
    seedSession(db, 'cyp_w');
    db.prepare(`INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, 'verdict', 0.8, 1.0)`).run('cyp_w');
    db.prepare(`INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, 'rerun', -0.7, 2.0)`).run('cyp_w');
    // (0.8*1 + -0.7*2) / (1+2) = (0.8 - 1.4) / 3 = -0.2
    expect(aggregateOutcome(db, 'cyp_w').aggregate).toBeCloseTo(-0.2, 6);
  });

  it('clamps the aggregate to [-1, 1] defensively', () => {
    // Force a hypothetical out-of-range mean by ALL signals at the boundary.
    // Even at boundaries, the math stays in range — but the clamp guarantees
    // a future buggy writer can't produce > 1.0 in the surface.
    seedSession(db, 'cyp_clamp');
    db.prepare(`INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, 'thumbs', 1.0, 1.0)`).run('cyp_clamp');
    db.prepare(`INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight) VALUES (?, 'verdict', 1.0, 5.0)`).run('cyp_clamp');
    const r = aggregateOutcome(db, 'cyp_clamp');
    expect(r.aggregate).toBeLessThanOrEqual(1.0);
    expect(r.aggregate).toBeGreaterThanOrEqual(-1.0);
  });

  it('parses metadata JSON in the returned signals', () => {
    seedSession(db, 'cyp_meta');
    db.prepare(`
      INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight, metadata, created_by)
      VALUES (?, 'rerun', -0.7, 1.0, json_object('trigger_session_id', 'cyp_other'), 'cyp_other')
    `).run('cyp_meta');
    const r = aggregateOutcome(db, 'cyp_meta');
    expect(r.signals[0].metadata).toEqual({ trigger_session_id: 'cyp_other' });
    expect(r.signals[0].created_by).toBe('cyp_other');
  });
});

describe('recordOutcomeSignal', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('rejects unknown session_id', () => {
    const r = recordOutcomeSignal(db, { session_id: 'cyp_nope', signal_kind: 'thumbs', value: 0.8 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('SESSION_NOT_FOUND');
  });

  it('rejects invalid signal_kind', () => {
    seedSession(db, 'cyp_x');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = recordOutcomeSignal(db, { session_id: 'cyp_x', signal_kind: 'bogus' as any, value: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('INVALID_SIGNAL_KIND');
  });

  it('rejects out-of-range value', () => {
    seedSession(db, 'cyp_x');
    expect(recordOutcomeSignal(db, { session_id: 'cyp_x', signal_kind: 'verdict', value: 1.5 }).error).toBe('INVALID_VALUE_RANGE');
    expect(recordOutcomeSignal(db, { session_id: 'cyp_x', signal_kind: 'verdict', value: -2 }).error).toBe('INVALID_VALUE_RANGE');
  });

  it('rejects thumbs values outside the {+0.8, -1.0} allowlist (AC L1.1-A-05)', () => {
    seedSession(db, 'cyp_x');
    const r = recordOutcomeSignal(db, { session_id: 'cyp_x', signal_kind: 'thumbs', value: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('INVALID_THUMBS_VALUE');
  });

  it('accepts the canonical thumbs values', () => {
    seedSession(db, 'cyp_x');
    expect(recordOutcomeSignal(db, { session_id: 'cyp_x', signal_kind: 'thumbs', value: THUMBS_UP_VALUE, created_by: 'maaz' }).ok).toBe(true);
    expect(recordOutcomeSignal(db, { session_id: 'cyp_x', signal_kind: 'thumbs', value: THUMBS_DOWN_VALUE, created_by: 'other' }).ok).toBe(true);
  });

  it('UPSERTs on (session_id, signal_kind, created_by) — re-write same triple flips value, no new row (AC L1.1-A-04)', () => {
    seedSession(db, 'cyp_x');
    const first = recordOutcomeSignal(db, { session_id: 'cyp_x', signal_kind: 'thumbs', value: THUMBS_UP_VALUE, created_by: 'maaz' });
    expect(first.ok).toBe(true);
    expect(first.upserted).toBe(false);
    const second = recordOutcomeSignal(db, { session_id: 'cyp_x', signal_kind: 'thumbs', value: THUMBS_DOWN_VALUE, created_by: 'maaz' });
    expect(second.ok).toBe(true);
    expect(second.upserted).toBe(true);
    expect(second.id).toBe(first.id); // same row, value flipped
    const rows = db.prepare(`SELECT value FROM cypher_outcomes WHERE session_id = 'cyp_x'`).all() as Array<{ value: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(THUMBS_DOWN_VALUE);
  });

  it('different created_by produces parallel rows, not UPSERT', () => {
    seedSession(db, 'cyp_x');
    recordOutcomeSignal(db, { session_id: 'cyp_x', signal_kind: 'thumbs', value: THUMBS_UP_VALUE, created_by: 'maaz' });
    recordOutcomeSignal(db, { session_id: 'cyp_x', signal_kind: 'thumbs', value: THUMBS_DOWN_VALUE, created_by: 'other' });
    const rows = db.prepare(`SELECT created_by FROM cypher_outcomes WHERE session_id = 'cyp_x' ORDER BY id`).all() as Array<{ created_by: string }>;
    expect(rows.map(r => r.created_by)).toEqual(['maaz', 'other']);
  });

  it('honors CYPHER_OUTCOMES_DISABLED kill-switch (AC L1.1-X-01)', () => {
    seedSession(db, 'cyp_x');
    const prior = process.env.CYPHER_OUTCOMES_DISABLED;
    process.env.CYPHER_OUTCOMES_DISABLED = '1';
    try {
      const r = recordOutcomeSignal(db, { session_id: 'cyp_x', signal_kind: 'thumbs', value: THUMBS_UP_VALUE });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('OUTCOMES_DISABLED');
      expect(r.id).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.CYPHER_OUTCOMES_DISABLED;
      else process.env.CYPHER_OUTCOMES_DISABLED = prior;
    }
  });

  it('honors CYPHER_OUTCOMES_THUMBS_DISABLED independently (AC L1.1-X-02)', () => {
    seedSession(db, 'cyp_x');
    const prior = process.env.CYPHER_OUTCOMES_THUMBS_DISABLED;
    process.env.CYPHER_OUTCOMES_THUMBS_DISABLED = '1';
    try {
      // thumbs blocked
      expect(recordOutcomeSignal(db, { session_id: 'cyp_x', signal_kind: 'thumbs', value: THUMBS_UP_VALUE }).ok).toBe(false);
      // verdict still works
      expect(recordOutcomeSignal(db, { session_id: 'cyp_x', signal_kind: 'verdict', value: 0.8 }).ok).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.CYPHER_OUTCOMES_THUMBS_DISABLED;
      else process.env.CYPHER_OUTCOMES_THUMBS_DISABLED = prior;
    }
  });
});

describe('detectRerun', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('writes a rerun row keyed against the EARLIER session, never the new one (AC L1.1-X-05)', () => {
    seedSession(db, 'cyp_old', 'investigate the login bug', 'maaz', -60); // 1h ago
    seedSession(db, 'cyp_new', 'investigate the login bug', 'maaz', 0);
    const r = detectRerun(db, 'cyp_new');
    expect(r.matched_sessions).toEqual(['cyp_old']);
    expect(r.rerun_rows_written).toBe(1);
    const rows = db.prepare(`SELECT session_id, signal_kind, value FROM cypher_outcomes WHERE signal_kind='rerun'`).all() as Array<{ session_id: string; signal_kind: string; value: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('cyp_old'); // EARLIER session, not new
    expect(rows[0].value).toBeCloseTo(RERUN_VALUE, 6);
  });

  it('matches on normalized goal text — case + whitespace insensitive (AC L1.1-B-02)', () => {
    seedSession(db, 'cyp_old', 'investigate the login bug', 'maaz', -60);
    seedSession(db, 'cyp_new', '  Investigate The Login Bug  ', 'maaz', 0);
    const r = detectRerun(db, 'cyp_new');
    expect(r.matched_sessions).toEqual(['cyp_old']);
  });

  it('does not match a session outside the 24h window (AC L1.1-B-03)', () => {
    seedSession(db, 'cyp_old', 'goal text', 'maaz', -25 * 60); // 25 hours ago
    seedSession(db, 'cyp_new', 'goal text', 'maaz', 0);
    const r = detectRerun(db, 'cyp_new');
    expect(r.matched_sessions).toEqual([]);
  });

  it('does not match a session by a different user', () => {
    seedSession(db, 'cyp_old', 'goal text', 'alice', -60);
    seedSession(db, 'cyp_new', 'goal text', 'maaz', 0);
    const r = detectRerun(db, 'cyp_new');
    expect(r.matched_sessions).toEqual([]);
  });

  it('writes one rerun row per matching prior session — multi-rerun case (AC L1.1-B-05)', () => {
    seedSession(db, 'cyp_first', 'find the leak', 'maaz', -120);
    seedSession(db, 'cyp_second', 'find the leak', 'maaz', -60);
    seedSession(db, 'cyp_third', 'find the leak', 'maaz', 0);
    const r = detectRerun(db, 'cyp_third');
    expect(r.matched_sessions.sort()).toEqual(['cyp_first', 'cyp_second']);
    expect(r.rerun_rows_written).toBe(2);
  });

  it('returns empty when called on a non-existent session', () => {
    const r = detectRerun(db, 'cyp_does_not_exist');
    expect(r.matched_sessions).toEqual([]);
    expect(r.rerun_rows_written).toBe(0);
  });

  it('returns empty when called on a session with empty goal', () => {
    seedSession(db, 'cyp_empty_goal', '', 'maaz', 0);
    const r = detectRerun(db, 'cyp_empty_goal');
    expect(r.matched_sessions).toEqual([]);
  });

  it('honors CYPHER_OUTCOMES_RERUN_DISABLED', () => {
    seedSession(db, 'cyp_old', 'goal text', 'maaz', -60);
    seedSession(db, 'cyp_new', 'goal text', 'maaz', 0);
    const prior = process.env.CYPHER_OUTCOMES_RERUN_DISABLED;
    process.env.CYPHER_OUTCOMES_RERUN_DISABLED = '1';
    try {
      const r = detectRerun(db, 'cyp_new');
      expect(r.matched_sessions).toEqual([]);
      expect(r.rerun_rows_written).toBe(0);
    } finally {
      if (prior === undefined) delete process.env.CYPHER_OUTCOMES_RERUN_DISABLED;
      else process.env.CYPHER_OUTCOMES_RERUN_DISABLED = prior;
    }
  });
});

describe('outcomes.ts — no LLM call (AC L1.1-X-03 fact check)', () => {
  it('the outcomes.ts source contains no Anthropic / messages.create / analyzer call', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    // Resolve relative to this test file (tests/services/cypher/) up to repo root.
    const src = await fs.readFile(
      path.resolve(import.meta.dirname, '../../../src/services/cypher/outcomes.ts'),
      'utf8',
    );
    // Ban any of: messages.create, getDecision, analyzer., AIAnalyzer
    expect(src).not.toMatch(/messages\.create/);
    expect(src).not.toMatch(/getDecision/);
    expect(src).not.toMatch(/AIAnalyzer/);
    // Comments mentioning "no LLM" are allowed; live calls are not.
    expect(src).not.toMatch(/anthropic\.messages/i);
  });
});
