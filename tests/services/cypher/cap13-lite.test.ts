/**
 * Unit tests for src/services/cypher/cap13-lite.ts — the CAP-13-LITE
 * recognition module ratified by ADR-037.5 v2.
 *
 * Covers PRD ACs:
 *   H-02, H-03 — recordPlanShapeGap insert + idempotency
 *   H-04 — isSmokeUser truth table
 *   H-05 — isSmokeProbe truth table
 *   H-08 — shouldRecognizeGap gate ordering + short-circuits
 *   H-12 / P-01 — goal truncated to 500 chars on write
 *   V-02 — CAP13_GAP_THRESHOLD clamp to [0, 1]
 *   V-03 — CAP13_MIN_PRIORS_RUNS integer ≥ 0
 *   V-04 — readCap13Config has no module cache (per-call env read)
 *
 * Test isolation: each test creates a fresh in-memory DB with the
 * minimum tables needed (cypher_sessions + plan_shape_gap_observed).
 * We don't run the full migration chain — only what cap13-lite touches.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  readCap13Config,
  recordPlanShapeGap,
  shouldRecognizeGap,
  isSmokeUser,
  isSmokeProbe,
  type PlanShapeGapContext,
} from '../../../src/services/cypher/cap13-lite.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Minimum parent table for the FK.
  db.exec(`
    CREATE TABLE cypher_sessions (
      session_id TEXT PRIMARY KEY,
      goal       TEXT NOT NULL,
      user       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE plan_shape_gap_observed (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id          TEXT    NOT NULL,
      plan_shape_hash     TEXT    NOT NULL,
      posture             TEXT    NOT NULL,
      tool_sequence_json  TEXT    NOT NULL,
      goal                TEXT    NOT NULL,
      user                TEXT    NOT NULL,
      prior_count         INTEGER NOT NULL,
      prior_success_rate  REAL    NOT NULL,
      iterations          INTEGER NOT NULL,
      verdict             TEXT    NOT NULL,
      status              TEXT    NOT NULL DEFAULT 'observed'
                           CHECK(status IN ('observed','reviewed','acted_on','dismissed')),
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      reviewed_at         TEXT,
      reviewed_by         TEXT,
      reviewer_note       TEXT,
      UNIQUE(session_id, plan_shape_hash),
      FOREIGN KEY (session_id) REFERENCES cypher_sessions(session_id) ON DELETE CASCADE
    );
  `);
  return db;
}

function seedSession(db: Database.Database, session_id: string, user = 'maaz', goal = 'test goal'): void {
  db.prepare(
    `INSERT INTO cypher_sessions (session_id, goal, user, status)
     VALUES (?, ?, ?, 'done')`,
  ).run(session_id, goal, user);
}

function baseCtx(overrides: Partial<PlanShapeGapContext> = {}): PlanShapeGapContext {
  return {
    session_id: 'cyp_test',
    plan_shape_hash: 'abcd1234',
    posture: 'generic',
    tool_sequence_json: JSON.stringify(['tool_a', 'tool_b']),
    goal: 'a real user goal',
    user: 'maaz',
    prior_count: 7,
    prior_success_rate: 0.15,
    iterations: 2,
    verdict: 'failed',
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// isSmokeUser (PRD H-04)
// ──────────────────────────────────────────────────────────────────────────

describe('isSmokeUser', () => {
  it('returns true for "smoke"', () => {
    expect(isSmokeUser('smoke')).toBe(true);
  });
  it('returns true for "system"', () => {
    expect(isSmokeUser('system')).toBe(true);
  });
  it('returns false for "maaz" (real user)', () => {
    expect(isSmokeUser('maaz')).toBe(false);
  });
  it('is case-sensitive — "Smoke" is NOT treated as smoke', () => {
    expect(isSmokeUser('Smoke')).toBe(false);
    expect(isSmokeUser('SYSTEM')).toBe(false);
  });
  it('returns false for empty string', () => {
    expect(isSmokeUser('')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// isSmokeProbe (PRD H-05)
// ──────────────────────────────────────────────────────────────────────────

describe('isSmokeProbe', () => {
  it.each([
    ['smoke probe'],
    ['probe the system'],
    ['sanity check the loop'],
    ['phase 5 day-0 verification'],
    ['SMOKE TEST'],         // case-insensitive
    ['Smoke harness run'],  // case-insensitive
  ])('matches: %s', (goal) => {
    expect(isSmokeProbe(goal)).toBe(true);
  });

  it.each([
    ['add work-context vocab to mode detector'],
    ['investigate flaky test'],
    ['ship cap-13-lite endpoint'],
    [''],                    // empty is not a probe
  ])('does not match: %s', (goal) => {
    expect(isSmokeProbe(goal)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// readCap13Config (PRD V-02..V-04)
// ──────────────────────────────────────────────────────────────────────────

describe('readCap13Config', () => {
  const ORIG = {
    enabled: process.env.CAP13_LITE_ENABLED,
    threshold: process.env.CAP13_GAP_THRESHOLD,
    minRuns: process.env.CAP13_MIN_PRIORS_RUNS,
  };
  afterEach(() => {
    if (ORIG.enabled === undefined) delete process.env.CAP13_LITE_ENABLED;
    else process.env.CAP13_LITE_ENABLED = ORIG.enabled;
    if (ORIG.threshold === undefined) delete process.env.CAP13_GAP_THRESHOLD;
    else process.env.CAP13_GAP_THRESHOLD = ORIG.threshold;
    if (ORIG.minRuns === undefined) delete process.env.CAP13_MIN_PRIORS_RUNS;
    else process.env.CAP13_MIN_PRIORS_RUNS = ORIG.minRuns;
  });

  it('defaults: enabled=true, threshold=0.3, minRuns=5', () => {
    delete process.env.CAP13_LITE_ENABLED;
    delete process.env.CAP13_GAP_THRESHOLD;
    delete process.env.CAP13_MIN_PRIORS_RUNS;
    const c = readCap13Config();
    expect(c).toEqual({ enabled: true, threshold: 0.3, minRuns: 5 });
  });

  it('CAP13_LITE_ENABLED=0 → enabled=false', () => {
    process.env.CAP13_LITE_ENABLED = '0';
    expect(readCap13Config().enabled).toBe(false);
  });

  it('CAP13_LITE_ENABLED="1", "true", anything-but-0 → enabled=true', () => {
    process.env.CAP13_LITE_ENABLED = '1';
    expect(readCap13Config().enabled).toBe(true);
    process.env.CAP13_LITE_ENABLED = 'on';
    expect(readCap13Config().enabled).toBe(true);
  });

  it('CAP13_GAP_THRESHOLD clamps below 0 to 0', () => {
    process.env.CAP13_GAP_THRESHOLD = '-0.5';
    expect(readCap13Config().threshold).toBe(0);
  });

  it('CAP13_GAP_THRESHOLD clamps above 1 to 1', () => {
    process.env.CAP13_GAP_THRESHOLD = '2.5';
    expect(readCap13Config().threshold).toBe(1);
  });

  it('CAP13_GAP_THRESHOLD non-numeric falls back to default (0.3)', () => {
    process.env.CAP13_GAP_THRESHOLD = 'garbage';
    expect(readCap13Config().threshold).toBe(0.3);
  });

  it('CAP13_GAP_THRESHOLD valid mid-range passes through', () => {
    process.env.CAP13_GAP_THRESHOLD = '0.42';
    expect(readCap13Config().threshold).toBeCloseTo(0.42, 5);
  });

  it('CAP13_MIN_PRIORS_RUNS non-negative integer passes through', () => {
    process.env.CAP13_MIN_PRIORS_RUNS = '12';
    expect(readCap13Config().minRuns).toBe(12);
  });

  it('CAP13_MIN_PRIORS_RUNS=0 is valid (no minimum)', () => {
    process.env.CAP13_MIN_PRIORS_RUNS = '0';
    expect(readCap13Config().minRuns).toBe(0);
  });

  it('CAP13_MIN_PRIORS_RUNS non-integer falls back to default (5)', () => {
    process.env.CAP13_MIN_PRIORS_RUNS = '3.7';
    expect(readCap13Config().minRuns).toBe(5);
    process.env.CAP13_MIN_PRIORS_RUNS = 'abc';
    expect(readCap13Config().minRuns).toBe(5);
  });

  it('CAP13_MIN_PRIORS_RUNS negative falls back to default', () => {
    process.env.CAP13_MIN_PRIORS_RUNS = '-3';
    expect(readCap13Config().minRuns).toBe(5);
  });

  it('reads env on every call (no module cache) — V-04', () => {
    process.env.CAP13_GAP_THRESHOLD = '0.1';
    expect(readCap13Config().threshold).toBeCloseTo(0.1, 5);
    process.env.CAP13_GAP_THRESHOLD = '0.9';
    expect(readCap13Config().threshold).toBeCloseTo(0.9, 5);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// shouldRecognizeGap — gate predicate (PRD H-08)
// ──────────────────────────────────────────────────────────────────────────

describe('shouldRecognizeGap', () => {
  const CFG = { enabled: true, threshold: 0.3, minRuns: 5 };

  it('fires when all predicates pass', () => {
    expect(shouldRecognizeGap('maaz', 'real goal', 7, 0.15, CFG)).toBe(true);
  });

  it('does NOT fire when disabled (step 1)', () => {
    expect(shouldRecognizeGap('maaz', 'real goal', 7, 0.15, { ...CFG, enabled: false })).toBe(false);
  });

  it('does NOT fire when prior_count < minRuns (step 2)', () => {
    expect(shouldRecognizeGap('maaz', 'real goal', 4, 0.15, CFG)).toBe(false);
  });

  it('does NOT fire when prior_success_rate is null (step 3)', () => {
    expect(shouldRecognizeGap('maaz', 'real goal', 7, null, CFG)).toBe(false);
  });

  it('does NOT fire when prior_success_rate >= threshold (step 4)', () => {
    expect(shouldRecognizeGap('maaz', 'real goal', 7, 0.3, CFG)).toBe(false);
    expect(shouldRecognizeGap('maaz', 'real goal', 7, 0.5, CFG)).toBe(false);
  });

  it('does NOT fire for smoke user (step 5)', () => {
    expect(shouldRecognizeGap('smoke', 'real goal', 7, 0.15, CFG)).toBe(false);
    expect(shouldRecognizeGap('system', 'real goal', 7, 0.15, CFG)).toBe(false);
  });

  it('does NOT fire for smoke goal (step 6)', () => {
    expect(shouldRecognizeGap('maaz', 'smoke probe', 7, 0.15, CFG)).toBe(false);
    expect(shouldRecognizeGap('maaz', 'sanity check', 7, 0.15, CFG)).toBe(false);
  });

  it('fires at the boundary: rate < threshold strict', () => {
    expect(shouldRecognizeGap('maaz', 'real goal', 5, 0.2999, CFG)).toBe(true);
    expect(shouldRecognizeGap('maaz', 'real goal', 5, 0.3, CFG)).toBe(false);
  });

  it('fires at the boundary: prior_count exactly equals minRuns', () => {
    expect(shouldRecognizeGap('maaz', 'real goal', 5, 0.15, CFG)).toBe(true);
    expect(shouldRecognizeGap('maaz', 'real goal', 4, 0.15, CFG)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// recordPlanShapeGap — insert + idempotency + truncation
// ──────────────────────────────────────────────────────────────────────────

describe('recordPlanShapeGap', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedSession(db, 'cyp_test');
  });
  afterEach(() => db.close());

  it('inserts a row with all context fields', () => {
    recordPlanShapeGap(db, baseCtx());
    const row = db.prepare(`SELECT * FROM plan_shape_gap_observed WHERE session_id = ?`).get('cyp_test') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.plan_shape_hash).toBe('abcd1234');
    expect(row.posture).toBe('generic');
    expect(row.tool_sequence_json).toBe(JSON.stringify(['tool_a', 'tool_b']));
    expect(row.goal).toBe('a real user goal');
    expect(row.user).toBe('maaz');
    expect(row.prior_count).toBe(7);
    expect(row.prior_success_rate).toBeCloseTo(0.15, 5);
    expect(row.iterations).toBe(2);
    expect(row.verdict).toBe('failed');
    expect(row.status).toBe('observed');
  });

  it('is idempotent on (session_id, plan_shape_hash) via UNIQUE', () => {
    recordPlanShapeGap(db, baseCtx());
    recordPlanShapeGap(db, baseCtx());        // second call same key
    recordPlanShapeGap(db, baseCtx({ goal: 'different goal but same key' }));
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM plan_shape_gap_observed WHERE session_id = ?`).get('cyp_test') as { n: number }).n;
    expect(count).toBe(1);
  });

  it('allows distinct rows when plan_shape_hash differs for same session', () => {
    recordPlanShapeGap(db, baseCtx({ plan_shape_hash: 'aaaa' }));
    recordPlanShapeGap(db, baseCtx({ plan_shape_hash: 'bbbb' }));
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM plan_shape_gap_observed WHERE session_id = ?`).get('cyp_test') as { n: number }).n;
    expect(count).toBe(2);
  });

  it('truncates goal > 500 chars to exactly 500', () => {
    const longGoal = 'x'.repeat(750);
    recordPlanShapeGap(db, baseCtx({ goal: longGoal }));
    const row = db.prepare(`SELECT goal FROM plan_shape_gap_observed WHERE session_id = ?`).get('cyp_test') as { goal: string };
    expect(row.goal.length).toBe(500);
    expect(row.goal).toBe('x'.repeat(500));
  });

  it('passes through goal <= 500 chars unchanged', () => {
    const goal = 'short goal under the limit';
    recordPlanShapeGap(db, baseCtx({ goal }));
    const row = db.prepare(`SELECT goal FROM plan_shape_gap_observed WHERE session_id = ?`).get('cyp_test') as { goal: string };
    expect(row.goal).toBe(goal);
  });
});
