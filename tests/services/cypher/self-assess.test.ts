/**
 * Unit tests for src/services/cypher/self-assess.ts — v2.5 D8 self-model.
 *
 * Covers ACs from .planning/cypher/v2.5-D8-self-model-design.md § Q-2.5.7:
 *   - T0/T1/T2/T3 tier resolution
 *   - Recommendation tree thresholds
 *   - Half-credit mixed accounting
 *   - Failure-pattern heuristic cases
 *   - Env override behavior
 *   - NULL-posture exclusion from warm tiers
 *   - Cache hit/miss
 *   - readSelfAssessConfig clamp/parse fallbacks
 *
 * Test isolation: each test creates a fresh in-memory DB with the minimum
 * tables + view that selfAssess() touches. We don't run the full migration
 * chain — only what's needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  selfAssess,
  classifyFailure,
  readSelfAssessConfig,
  _resetSelfAssessCache,
  type Posture,
} from '../../../src/services/cypher/self-assess.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE cypher_sessions (
      session_id        TEXT PRIMARY KEY,
      goal              TEXT NOT NULL,
      task_class        TEXT NOT NULL,
      user              TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      outcome           TEXT,
      outcome_note      TEXT,
      total_tokens      INTEGER NOT NULL DEFAULT 0,
      duration_ms       INTEGER,
      plan_shape_hash   TEXT,
      posture           TEXT,
      engine            TEXT,
      started_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE cypher_outcomes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL,
      signal_kind     TEXT NOT NULL,
      value           REAL NOT NULL,
      weight          REAL NOT NULL DEFAULT 1.0,
      metadata        TEXT,
      created_by      TEXT,
      failure_pattern TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES cypher_sessions(session_id)
    );
    CREATE VIEW cypher_capability_summary AS
    SELECT
      s.posture                                   AS posture,
      s.task_class                                AS task_class,
      s.user                                      AS user,
      s.plan_shape_hash                           AS plan_shape_hash,
      COUNT(*)                                    AS n_outcomes,
      SUM(CASE WHEN s.outcome = 'success' THEN 1.0
               WHEN s.outcome = 'mixed'   THEN 0.5
               ELSE 0.0 END)                      AS alpha_delta,
      SUM(CASE WHEN s.outcome = 'failed' THEN 1.0
               WHEN s.outcome = 'mixed'  THEN 0.5
               ELSE 0.0 END)                      AS beta_delta,
      AVG(s.duration_ms)                          AS avg_duration_ms,
      AVG(s.total_tokens)                         AS avg_tokens
    FROM cypher_sessions s
    WHERE s.engine = 'loop'
      AND s.posture IS NOT NULL
      AND s.outcome IS NOT NULL
    GROUP BY s.posture, s.task_class, s.user, s.plan_shape_hash;
  `);
  return db;
}

interface SeedOpts {
  session_id: string;
  posture?: Posture | null;       // null means historical NULL row
  task_class?: string;
  user?: string;
  plan_shape_hash?: string | null;
  outcome: 'success' | 'mixed' | 'failed';
  outcome_note?: string | null;
  duration_ms?: number | null;
  total_tokens?: number;
  failure_pattern?: string | null;
  engine?: string;
}

function seedSessionAndOutcome(db: Database.Database, o: SeedOpts): void {
  db.prepare(
    `INSERT INTO cypher_sessions
       (session_id, goal, task_class, user, status, outcome, outcome_note,
        total_tokens, duration_ms, plan_shape_hash, posture, engine)
       VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.session_id,
    'goal',
    o.task_class ?? 'design',
    o.user ?? 'maaz',
    o.outcome,
    o.outcome_note ?? null,
    o.total_tokens ?? 1000,
    o.duration_ms ?? 5000,
    o.plan_shape_hash ?? null,
    o.posture ?? null,
    o.engine ?? 'loop',
  );
  // cypher_outcomes.value is REAL (Beta-prior signal: 0.8/0.0/-0.8);
  // s.outcome is the canonical TEXT verdict. selfAssess() reads
  // s.outcome (v73). We seed the outcomes row anyway so failure_pattern
  // tests have a row to read against.
  const numericValue =
    o.outcome === 'success' ? 0.8 : o.outcome === 'failed' ? -0.8 : 0.0;
  db.prepare(
    `INSERT INTO cypher_outcomes
       (session_id, signal_kind, value, failure_pattern)
       VALUES (?, 'verdict', ?, ?)`,
  ).run(o.session_id, numericValue, o.failure_pattern ?? null);
}

beforeEach(() => {
  _resetSelfAssessCache();
});

afterEach(() => {
  // Cleanup any env overrides set during the test.
  delete process.env.D8_MIN_N;
  delete process.env.D8_DECLINE_THRESHOLD;
  delete process.env.D8_CAUTION_THRESHOLD;
  _resetSelfAssessCache();
});

describe('selfAssess — tier resolution', () => {
  it('AC-01: T0 win — exact plan_shape_hash with N=10', () => {
    const db = freshDb();
    for (let i = 0; i < 10; i++) {
      seedSessionAndOutcome(db, {
        session_id: `s${i}`,
        plan_shape_hash: 'hash_x',
        posture: 'pr-review',
        outcome: i < 8 ? 'success' : 'failed',
      });
    }
    const r = selfAssess(db, {
      goal: 'g', posture: 'pr-review', user: 'maaz',
      plan_shape_hash: 'hash_x', task_class: 'design',
    });
    expect(r.tier_used).toBe('T0');
    expect(r.n_similar_tasks).toBe(10);
    expect(r.n_exact_shape).toBe(10);
    // 8 success / 2 fail + Beta(1,1) prior → α=9, β=3 → mean=9/12=0.75
    expect(r.confidence).toBeCloseTo(0.75, 2);
  });

  it('AC-02: T1 win — exact hash empty, (posture, task_class, user) warm', () => {
    const db = freshDb();
    for (let i = 0; i < 8; i++) {
      seedSessionAndOutcome(db, {
        session_id: `s${i}`,
        plan_shape_hash: `other_hash_${i}`,  // different hashes
        posture: 'pr-review',
        task_class: 'design',
        outcome: 'success',
      });
    }
    const r = selfAssess(db, {
      goal: 'g', posture: 'pr-review', user: 'maaz',
      plan_shape_hash: 'never_seen_hash', task_class: 'design',
    });
    expect(r.tier_used).toBe('T1');
    expect(r.n_exact_shape).toBe(0);
    expect(r.n_similar_tasks).toBe(8);
  });

  it('AC-03: T2 win — task_class novel, posture has prior runs', () => {
    const db = freshDb();
    for (let i = 0; i < 4; i++) {
      seedSessionAndOutcome(db, {
        session_id: `s${i}`,
        plan_shape_hash: `h${i}`,
        posture: 'bug-investigate',
        task_class: 'other_class',
        outcome: 'success',
      });
    }
    const r = selfAssess(db, {
      goal: 'g', posture: 'bug-investigate', user: 'maaz',
      task_class: 'novel_class',
    });
    expect(r.tier_used).toBe('T2');
    expect(r.n_similar_tasks).toBe(4);
  });

  it('AC-04: T3 win — first-ever dispatch at this posture for this user', () => {
    const db = freshDb();
    const r = selfAssess(db, {
      goal: 'g', posture: 'pm', user: 'novel_user',
      task_class: 'design',
    });
    expect(r.tier_used).toBe('T3');
    expect(r.n_similar_tasks).toBe(0);
    expect(r.confidence).toBeCloseTo(0.5, 2);  // Beta(1,1) mean = 0.5
    expect(r.recommendation).toBe('proceed');
    expect(r.note).toMatch(/insufficient data/);
    expect(r.failure_modes).toEqual([]);
  });
});

describe('selfAssess — recommendation tree (Q-2.5.4)', () => {
  it('AC-05: all-success at n≥5 → recommendation "proceed"', () => {
    const db = freshDb();
    for (let i = 0; i < 6; i++) {
      seedSessionAndOutcome(db, {
        session_id: `s${i}`, plan_shape_hash: 'h', posture: 'generic',
        outcome: 'success',
      });
    }
    const r = selfAssess(db, {
      goal: 'g', posture: 'generic', user: 'maaz',
      plan_shape_hash: 'h', task_class: 'design',
    });
    expect(r.recommendation).toBe('proceed');
  });

  it('AC-06: all-failed at n≥5 → recommendation "decline"', () => {
    const db = freshDb();
    for (let i = 0; i < 6; i++) {
      seedSessionAndOutcome(db, {
        session_id: `s${i}`, plan_shape_hash: 'h', posture: 'generic',
        outcome: 'failed', failure_pattern: 'unknown_failure',
      });
    }
    const r = selfAssess(db, {
      goal: 'g', posture: 'generic', user: 'maaz',
      plan_shape_hash: 'h', task_class: 'design',
    });
    expect(r.recommendation).toBe('decline');
  });

  it('AC-07: 4-of-10 success → mean 0.42 → "proceed_with_caution"', () => {
    const db = freshDb();
    for (let i = 0; i < 10; i++) {
      seedSessionAndOutcome(db, {
        session_id: `s${i}`, plan_shape_hash: 'h', posture: 'generic',
        outcome: i < 4 ? 'success' : 'failed',
        failure_pattern: i >= 4 ? 'unknown_failure' : null,
      });
    }
    const r = selfAssess(db, {
      goal: 'g', posture: 'generic', user: 'maaz',
      plan_shape_hash: 'h', task_class: 'design',
    });
    // (1+4)/(1+4+1+6) = 5/12 ≈ 0.417 — between 0.3 and 0.5 → caution
    expect(r.recommendation).toBe('proceed_with_caution');
  });

  it('AC-08: costly failure tag overrides "proceed" with caution', () => {
    const db = freshDb();
    // 7-of-8 success + 1 timeout failure → mean ≈ 0.8 (otherwise proceed)
    for (let i = 0; i < 7; i++) {
      seedSessionAndOutcome(db, {
        session_id: `s${i}`, plan_shape_hash: 'h', posture: 'generic',
        outcome: 'success',
      });
    }
    seedSessionAndOutcome(db, {
      session_id: 's7', plan_shape_hash: 'h', posture: 'generic',
      outcome: 'failed', failure_pattern: 'timeout',
    });
    const r = selfAssess(db, {
      goal: 'g', posture: 'generic', user: 'maaz',
      plan_shape_hash: 'h', task_class: 'design',
    });
    expect(r.failure_modes).toContain('timeout');
    expect(r.recommendation).toBe('proceed_with_caution');
  });
});

describe('selfAssess — mixed outcome accounting', () => {
  it('AC-09: mixed contributes α+=0.5 and β+=0.5', () => {
    const db = freshDb();
    // 4 success + 4 mixed → α=1+4+2=7, β=1+0+2=3 → mean=7/10=0.7
    for (let i = 0; i < 4; i++) {
      seedSessionAndOutcome(db, {
        session_id: `s${i}`, plan_shape_hash: 'h', posture: 'generic',
        outcome: 'success',
      });
    }
    for (let i = 4; i < 8; i++) {
      seedSessionAndOutcome(db, {
        session_id: `s${i}`, plan_shape_hash: 'h', posture: 'generic',
        outcome: 'mixed',
      });
    }
    const r = selfAssess(db, {
      goal: 'g', posture: 'generic', user: 'maaz',
      plan_shape_hash: 'h', task_class: 'design',
    });
    expect(r.confidence).toBeCloseTo(0.7, 2);
    expect(r.n_similar_tasks).toBe(8);
  });
});

describe('classifyFailure — heuristic (Q-2.5.3)', () => {
  it('AC-10: budget keyword in note → budget_exhaustion', () => {
    expect(classifyFailure({
      outcome: 'failed', outcome_note: 'budget exhausted on iter 14',
      duration_ms: 1000, iterations: 5,
    })).toBe('budget_exhaustion');
  });

  it('AC-11: duration_ms > 600s → timeout', () => {
    expect(classifyFailure({
      outcome: 'failed', outcome_note: null,
      duration_ms: 700_000, iterations: 5,
    })).toBe('timeout');
  });

  it('AC-12: iterations >= 30 → iteration_cap', () => {
    expect(classifyFailure({
      outcome: 'failed', outcome_note: null,
      duration_ms: 1000, iterations: 30,
    })).toBe('iteration_cap');
  });

  it('AC-13: "halted" in note → user_halt', () => {
    expect(classifyFailure({
      outcome: 'failed', outcome_note: 'user halted dispatch',
      duration_ms: 1000, iterations: 5,
    })).toBe('user_halt');
    // returns null for non-failed outcomes
    expect(classifyFailure({
      outcome: 'success', outcome_note: 'halted',
      duration_ms: 1000, iterations: 5,
    })).toBeNull();
    // fallback when no specific match
    expect(classifyFailure({
      outcome: 'failed', outcome_note: 'something went wrong',
      duration_ms: 1000, iterations: 5,
    })).toBe('unknown_failure');
  });
});

describe('selfAssess — env overrides + posture filter', () => {
  it('AC-14: D8_MIN_N=1 flips T3-fallback into warm-tier signal', () => {
    const db = freshDb();
    seedSessionAndOutcome(db, {
      session_id: 's1', plan_shape_hash: 'h', posture: 'generic',
      outcome: 'success',
    });
    process.env.D8_MIN_N = '1';
    const r = selfAssess(db, {
      goal: 'g', posture: 'generic', user: 'maaz',
      plan_shape_hash: 'h', task_class: 'design',
    });
    // T0 has n=1; with MIN_N=1 the recommendation passes the "insufficient
    // data" gate and goes to mean-based logic. Mean = 2/3 ≈ 0.67 → proceed.
    expect(r.tier_used).toBe('T0');
    expect(r.recommendation).toBe('proceed');
    expect(r.note).toBeUndefined();
  });

  it('AC-15: posture IS NULL historical rows do not contribute to T1', () => {
    const db = freshDb();
    // NULL posture row that would have matched T1 if posture were set
    seedSessionAndOutcome(db, {
      session_id: 's_null', plan_shape_hash: 'h', posture: null,
      task_class: 'design', outcome: 'success',
    });
    const r = selfAssess(db, {
      goal: 'g', posture: 'pr-review', user: 'maaz',
      task_class: 'design',
    });
    expect(r.tier_used).toBe('T3');  // NULL row excluded by view filter
    expect(r.n_similar_tasks).toBe(0);
  });

  it('AC-16: 60s cache returns same value on same key', () => {
    const db = freshDb();
    seedSessionAndOutcome(db, {
      session_id: 's1', plan_shape_hash: 'h', posture: 'generic',
      outcome: 'success',
    });
    const a = selfAssess(db, {
      goal: 'g', posture: 'generic', user: 'maaz',
      plan_shape_hash: 'h', task_class: 'design',
    });
    // Mutate the DB; cache should still return the prior value.
    seedSessionAndOutcome(db, {
      session_id: 's2', plan_shape_hash: 'h', posture: 'generic',
      outcome: 'failed', failure_pattern: 'unknown_failure',
    });
    const b = selfAssess(db, {
      goal: 'g', posture: 'generic', user: 'maaz',
      plan_shape_hash: 'h', task_class: 'design',
    });
    expect(b).toEqual(a);
    // After reset, fresh aggregation picks up the new row.
    _resetSelfAssessCache();
    const c = selfAssess(db, {
      goal: 'g', posture: 'generic', user: 'maaz',
      plan_shape_hash: 'h', task_class: 'design',
    });
    expect(c.n_similar_tasks).toBe(2);
  });
});

describe('readSelfAssessConfig — env parse + clamp', () => {
  it('honors defaults when env is empty', () => {
    const cfg = readSelfAssessConfig({});
    expect(cfg.declineThreshold).toBe(0.3);
    expect(cfg.cautionThreshold).toBe(0.5);
    expect(cfg.minN).toBe(5);
  });

  it('clamps D8_DECLINE_THRESHOLD into [0, 1]', () => {
    expect(readSelfAssessConfig({ D8_DECLINE_THRESHOLD: '1.7' }).declineThreshold).toBe(1);
    expect(readSelfAssessConfig({ D8_DECLINE_THRESHOLD: '-0.5' }).declineThreshold).toBe(0);
    // non-numeric falls back to default
    expect(readSelfAssessConfig({ D8_DECLINE_THRESHOLD: 'nope' }).declineThreshold).toBe(0.3);
  });

  it('D8_MIN_N falls back to default on non-integer', () => {
    expect(readSelfAssessConfig({ D8_MIN_N: '7' }).minN).toBe(7);
    expect(readSelfAssessConfig({ D8_MIN_N: '3.5' }).minN).toBe(5);
    expect(readSelfAssessConfig({ D8_MIN_N: '-1' }).minN).toBe(5);
  });
});
