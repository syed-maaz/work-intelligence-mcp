/**
 * Tests for `getEffectivePriors` — the CAP-12-FIX downweight reader
 * that CAP-13's eventual gap-recognition gate will read instead of
 * the raw posterior mean.
 *
 * Scenarios:
 *   1. Empty candidate list returns empty.
 *   2. Untouched skills (no prior row) get effective_mean 0.5 + zero runs.
 *   3. All-honest priors have effective_mean == mean (no downweight).
 *   4. All-pre-fix priors have effective_mean closer to 0.5 than mean
 *      (heavy discount toward uninformative).
 *   5. Mixed priors interpolate between honest and pre-fix means.
 *   6. Multiple skills returned in input order.
 *
 * Test isolation: each test creates a fresh in-memory DB and applies
 * the schema migration up to v62+ where skill_priors.pre_fix_runs
 * exists. We don't run the full migration chain — that's not what's
 * under test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getEffectivePriors,
  PRE_FIX_RUN_WEIGHT,
  recordSkillOutcomes,
} from '../../../src/services/cypher/learn.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  // Minimal schema — just skill_priors with pre_fix_runs column.
  db.exec(`
    CREATE TABLE skill_priors (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name      TEXT    NOT NULL,
      task_class      TEXT    NOT NULL DEFAULT '*',
      alpha           REAL    NOT NULL DEFAULT 1.0,
      beta            REAL    NOT NULL DEFAULT 1.0,
      total_runs      INTEGER NOT NULL DEFAULT 0,
      last_outcome_at TEXT,
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      pre_fix_runs    INTEGER NOT NULL DEFAULT 0,
      UNIQUE(skill_name, task_class),
      CHECK(alpha + beta > 0)
    );
  `);
  return db;
}

describe('getEffectivePriors (CAP-12-FIX)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('returns empty array for empty candidate list', () => {
    expect(getEffectivePriors(db, '*', [])).toEqual([]);
  });

  it('untouched skill returns effective_mean=0.5 with zero runs', () => {
    const result = getEffectivePriors(db, '*', ['unknown-skill']);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      skill_name: 'unknown-skill',
      task_class: '*',
      alpha: 1.0,
      beta: 1.0,
      total_runs: 0,
      mean: 0.5,
      effective_mean: 0.5,
      post_fix_runs: 0,
      pre_fix_runs: 0,
    });
  });

  it('all-honest priors: effective_mean equals mean', () => {
    // Drive 5 successes via recordSkillOutcomes (self_reported weight=0.10).
    // alpha = 1 + 5*0.10 = 1.5, beta = 1.0 → mean = 1.5/2.5 = 0.6
    for (let i = 0; i < 5; i++) {
      recordSkillOutcomes(db, 'skill-a', 'success', '*');
    }
    const result = getEffectivePriors(db, '*', ['skill-a']);
    expect(result).toHaveLength(1);
    expect(result[0].mean).toBeCloseTo(1.5 / 2.5, 5);
    // No pre_fix_runs → effective_mean == mean exactly.
    expect(result[0].effective_mean).toBeCloseTo(result[0].mean, 5);
    expect(result[0].pre_fix_runs).toBe(0);
    expect(result[0].post_fix_runs).toBe(5);
  });

  it('all-pre-fix priors: effective_mean shifts toward 0.5', () => {
    // Manually set up: alpha=6, beta=1, total_runs=5, pre_fix_runs=5 (all pre-fix)
    // mean = 6/7 ≈ 0.857
    // effectiveTotal = (0 + 5 * 0.2) / 5 = 0.2
    // effAlpha = 1 + (6 - 1) * 0.2 = 2.0
    // effBeta = 1 + (1 - 1) * 0.2 = 1.0
    // effective_mean = 2.0 / 3.0 ≈ 0.667 — closer to 0.5 than raw 0.857
    db.prepare(
      `INSERT INTO skill_priors (skill_name, task_class, alpha, beta, total_runs, pre_fix_runs)
       VALUES ('skill-tainted', '*', 6, 1, 5, 5)`,
    ).run();
    const result = getEffectivePriors(db, '*', ['skill-tainted']);
    expect(result).toHaveLength(1);
    expect(result[0].mean).toBeCloseTo(6 / 7, 5);
    expect(result[0].effective_mean).toBeCloseTo(2 / 3, 3);
    // Sanity: effective_mean is strictly closer to 0.5 than raw mean.
    expect(Math.abs(result[0].effective_mean - 0.5)).toBeLessThan(
      Math.abs(result[0].mean - 0.5),
    );
  });

  it('mixed priors: effective_mean interpolates between honest and pre-fix', () => {
    // alpha=11, beta=1, total_runs=10, pre_fix_runs=5 (half clean, half tainted)
    // raw mean = 11/12 ≈ 0.917
    // effectiveTotal = (5 + 5 * 0.2) / 10 = 6/10 = 0.6
    // effAlpha = 1 + (11 - 1) * 0.6 = 7.0
    // effBeta = 1 + (1 - 1) * 0.6 = 1.0
    // effective_mean = 7/8 = 0.875 — between 0.5 and 0.917
    db.prepare(
      `INSERT INTO skill_priors (skill_name, task_class, alpha, beta, total_runs, pre_fix_runs)
       VALUES ('skill-mixed', '*', 11, 1, 10, 5)`,
    ).run();
    const result = getEffectivePriors(db, '*', ['skill-mixed']);
    expect(result[0].mean).toBeCloseTo(11 / 12, 5);
    expect(result[0].effective_mean).toBeCloseTo(7 / 8, 3);
    expect(result[0].effective_mean).toBeLessThan(result[0].mean);
    expect(result[0].effective_mean).toBeGreaterThan(0.5);
  });

  it('returns results in input order', () => {
    // Touch one of them to differentiate them at the SQL level.
    recordSkillOutcomes(db, 'skill-b', 'success', '*');
    const result = getEffectivePriors(db, '*', ['skill-c', 'skill-a', 'skill-b']);
    expect(result.map(r => r.skill_name)).toEqual([
      'skill-c',
      'skill-a',
      'skill-b',
    ]);
  });

  it('PRE_FIX_RUN_WEIGHT is 0.2 (the spike-locked downweight)', () => {
    expect(PRE_FIX_RUN_WEIGHT).toBe(0.2);
  });

  it('class-specific priors do not bleed across task_class boundaries', () => {
    recordSkillOutcomes(db, 'skill-x', 'success', 'pr-review');
    recordSkillOutcomes(db, 'skill-x', 'success', 'pr-review');
    recordSkillOutcomes(db, 'skill-x', 'failed', 'investigate');
    const prReview = getEffectivePriors(db, 'pr-review', ['skill-x']);
    const investigate = getEffectivePriors(db, 'investigate', ['skill-x']);
    // pr-review: 2 successes (weight 0.10 each) → alpha=1.2, beta=1.0, mean=1.2/2.2≈0.545
    expect(prReview[0].mean).toBeCloseTo(1.2 / 2.2, 3);
    // investigate: 1 failure (weight 0.10) → alpha=1.0, beta=1.1, mean=1.0/2.1≈0.476
    expect(investigate[0].mean).toBeCloseTo(1.0 / 2.1, 3);
  });
});
