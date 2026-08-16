import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/db/schema.js';
import { SEED_TEMPLATES, seedTemplatesIfEmpty } from '../../src/intelligence/prompt-seeds.js';
import { ALL_TRIGGER_TYPES } from '../../src/intelligence/cost-gate.js';

/**
 * ADR-039 AC-11 test: the v1 `goal_refinement` seed must be inserted by
 * `seedTemplatesIfEmpty` and must encode the cardinal scope-phase
 * directives (scope-don't-solve, refined_goal JSON schema reference,
 * {{catalog_hint}} variable, classify_clarity tool schema for clarifying
 * questions).
 */
describe('prompt-seeds — goal_refinement v1 (ADR-039 AC-11)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
  });

  it('SEED_TEMPLATES has a key for every TriggerType including goal_refinement', () => {
    for (const trigger of ALL_TRIGGER_TYPES) {
      expect(SEED_TEMPLATES, `missing seed for trigger '${trigger}'`).toHaveProperty(trigger);
      expect((SEED_TEMPLATES as Record<string, string>)[trigger].length).toBeGreaterThan(0);
    }
    expect(SEED_TEMPLATES.goal_refinement.length).toBeGreaterThan(500);
  });

  it("encodes the cardinal scope-phase rule 'Scope, don't solve.'", () => {
    expect(SEED_TEMPLATES.goal_refinement).toMatch(/Scope, don't solve\. Build a structured brief, then stop\./);
  });

  it('references all eight required refined_goal schema fields', () => {
    const seed = SEED_TEMPLATES.goal_refinement;
    for (const field of [
      'intent',
      'target',
      'constraints',
      'success_criteria',
      'out_of_scope',
      'linkage',
      'expected_output_shape',
      'evidence_cited',
    ]) {
      expect(seed, `seed missing required schema field '${field}'`).toContain(field);
    }
  });

  it('exposes the {{catalog_hint}} substitution variable as a non-binding hint', () => {
    const seed = SEED_TEMPLATES.goal_refinement;
    expect(seed).toContain('{{catalog_hint}}');
    expect(seed).toMatch(/NON-BINDING|non-binding|not a routing decision/i);
  });

  it('includes the classify_clarity tool schema with a max-3 clarifying questions cap', () => {
    const seed = SEED_TEMPLATES.goal_refinement;
    expect(seed).toContain('classify_clarity');
    expect(seed).toMatch(/max 3|up to 3/i);
  });

  it('exposes the {{raw_goal}} substitution variable', () => {
    expect(SEED_TEMPLATES.goal_refinement).toContain('{{raw_goal}}');
  });

  it('seedTemplatesIfEmpty inserts a v1 goal_refinement row when table is empty', () => {
    seedTemplatesIfEmpty(db);

    const row = db
      .prepare(`SELECT trigger_type, version, template, is_active
                FROM prompt_templates
                WHERE trigger_type = 'goal_refinement'
                ORDER BY version ASC LIMIT 1`)
      .get() as { trigger_type: string; version: number; template: string; is_active: number } | undefined;

    expect(row, 'no goal_refinement row inserted by seedTemplatesIfEmpty').toBeDefined();
    expect(row!.version).toBe(1);
    expect(row!.is_active).toBe(1);
    expect(row!.template).toBe(SEED_TEMPLATES.goal_refinement);
  });

  it('seedTemplatesIfEmpty inserts exactly one row per TriggerType', () => {
    seedTemplatesIfEmpty(db);
    const counts = db.prepare('SELECT trigger_type, COUNT(*) as n FROM prompt_templates GROUP BY trigger_type').all() as { trigger_type: string; n: number }[];
    const byTrigger = Object.fromEntries(counts.map(r => [r.trigger_type, r.n]));
    for (const trigger of ALL_TRIGGER_TYPES) {
      expect(byTrigger[trigger], `wrong seed count for '${trigger}'`).toBe(1);
    }
  });

  it('seedTemplatesIfEmpty is idempotent (no-op when table is non-empty)', () => {
    seedTemplatesIfEmpty(db);
    const firstCount = (db.prepare('SELECT COUNT(*) as c FROM prompt_templates').get() as { c: number }).c;
    seedTemplatesIfEmpty(db);
    const secondCount = (db.prepare('SELECT COUNT(*) as c FROM prompt_templates').get() as { c: number }).c;
    expect(secondCount).toBe(firstCount);
  });
});
