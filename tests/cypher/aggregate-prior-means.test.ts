/**
 * BLOCKER-1 regression (audit 2026-07-15): getAggregatePriorMeans must sum
 * alpha/beta across ALL task_classes for a skill, so a skill with evidence only
 * under specific task_classes (and NO '*' row) gets a real mean — not the 0.5
 * default that getEffectivePriors(db,'*',…) returned (the bug that made the
 * recognition blend a static thumb-on-the-scale for the one skill that had a
 * '*' row).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getAggregatePriorMeans } from '../../src/services/cypher/learn.js';
import migrateV59 from '../../src/db/migrations/v59_cypher_tables.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV59(db);
  return db;
}

function seedPrior(db: Database.Database, skill: string, tc: string, a: number, b: number): void {
  db.prepare(
    `INSERT INTO skill_priors (skill_name, task_class, alpha, beta, total_runs) VALUES (?,?,?,?,?)`,
  ).run(skill, tc, a, b, Math.round(a + b));
}

describe('BLOCKER-1 — getAggregatePriorMeans aggregates across task_classes', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('sums alpha/beta across task_classes (skill with NO * row still gets a real mean)', () => {
    // wi-investigate: evidence ONLY under specific task_classes, no '*' row.
    seedPrior(db, 'wi-investigate', 'investigate', 160, 80); // 0.667
    seedPrior(db, 'wi-investigate', 'debug', 40, 20);        // combined 200/100 → 0.667
    const means = getAggregatePriorMeans(db, ['wi-investigate']);
    // Old bug: getEffectivePriors(db,'*',…) → 0.5 (no '*' row). Fixed → ~0.667.
    expect(means.get('wi-investigate')).toBeCloseTo(200 / 300, 5);
  });

  it('omits skills with no rows (caller defaults them to 0.5)', () => {
    const means = getAggregatePriorMeans(db, ['never-seen-skill']);
    expect(means.has('never-seen-skill')).toBe(false);
  });

  it('differentiates skills by real track record', () => {
    seedPrior(db, 'good-skill', 'x', 90, 10); // 0.9
    seedPrior(db, 'bad-skill', 'x', 10, 90);  // 0.1
    const m = getAggregatePriorMeans(db, ['good-skill', 'bad-skill']);
    expect(m.get('good-skill')).toBeCloseTo(0.9, 5);
    expect(m.get('bad-skill')).toBeCloseTo(0.1, 5);
  });

  it('empty candidate list returns empty map (no query)', () => {
    expect(getAggregatePriorMeans(db, []).size).toBe(0);
  });
});
