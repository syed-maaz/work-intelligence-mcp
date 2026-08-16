import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/db/schema.js';
import { PromptEvolver, GOAL_REFINEMENT_TRIGGER } from '../../src/intelligence/prompt-evolver.js';
import { seedTemplatesIfEmpty } from '../../src/intelligence/prompt-seeds.js';

/**
 * ADR-039 AC-11 test: `PromptEvolver.buildPrompt('goal_refinement', ctx)`
 *
 *   - returns a non-empty prompt
 *   - the prompt contains the refined_goal JSON schema field reference
 *   - {{raw_goal}} and {{catalog_hint}} are substituted from ctx
 *   - the templateId points at the v1 seed row
 */
describe('PromptEvolver.buildPrompt — goal_refinement (ADR-039 AC-11)', () => {
  let db: Database.Database;
  let evolver: PromptEvolver;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
    seedTemplatesIfEmpty(db);
    evolver = new PromptEvolver(db);
  });

  it('exports the GOAL_REFINEMENT_TRIGGER constant for AC-11 grep verification', () => {
    expect(GOAL_REFINEMENT_TRIGGER).toBe('goal_refinement');
  });

  it('selectTemplate returns the active v1 seed for goal_refinement', () => {
    const tmpl = evolver.selectTemplate('goal_refinement');
    expect(tmpl).not.toBeNull();
    expect(tmpl!.triggerType).toBe('goal_refinement');
    expect(tmpl!.version).toBe(1);
    expect(tmpl!.isActive).toBe(true);
    expect(tmpl!.template.length).toBeGreaterThan(500);
  });

  it('buildPrompt returns a non-empty prompt containing the refined_goal JSON schema reference', async () => {
    const built = await evolver.buildPrompt('goal_refinement', {
      triggerContext: '',
      researchQuestion: '',
      repoList: 'work-intelligence-mcp',
      rawGoal: 'unify Cypher scope and execute under one loop',
      catalogHint: 'shortlist: claude_code_search, claude_code_read',
    });
    expect(built).not.toBeNull();
    expect(built!.prompt.length).toBeGreaterThan(500);

    // Schema references — required eight fields named in the prompt body.
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
      expect(built!.prompt).toContain(field);
    }
  });

  it('substitutes {{raw_goal}} from the build context', async () => {
    const built = await evolver.buildPrompt('goal_refinement', {
      triggerContext: '',
      researchQuestion: '',
      repoList: 'work-intelligence-mcp',
      rawGoal: 'fix the rate limiter race condition',
      catalogHint: 'hint',
    });
    expect(built!.prompt).toContain('fix the rate limiter race condition');
    expect(built!.prompt).not.toContain('{{raw_goal}}');
  });

  it('substitutes {{catalog_hint}} from the build context', async () => {
    const built = await evolver.buildPrompt('goal_refinement', {
      triggerContext: '',
      researchQuestion: '',
      repoList: 'work-intelligence-mcp',
      rawGoal: 'x',
      catalogHint: 'shortlist: claude_code_search',
    });
    expect(built!.prompt).toContain('shortlist: claude_code_search');
    expect(built!.prompt).not.toContain('{{catalog_hint}}');
  });

  it('falls back to a placeholder when catalogHint is omitted (AC-10 non-binding)', async () => {
    const built = await evolver.buildPrompt('goal_refinement', {
      triggerContext: '',
      researchQuestion: '',
      repoList: 'work-intelligence-mcp',
      rawGoal: 'x',
    });
    expect(built!.prompt).toContain('no catalog hint available');
    expect(built!.prompt).not.toContain('{{catalog_hint}}');
  });

  it('templateId points at a row in prompt_templates with trigger_type=goal_refinement', async () => {
    const built = await evolver.buildPrompt('goal_refinement', {
      triggerContext: '',
      researchQuestion: '',
      repoList: 'work-intelligence-mcp',
      rawGoal: 'x',
      catalogHint: 'y',
    });
    expect(built).not.toBeNull();

    const row = db
      .prepare('SELECT trigger_type, version FROM prompt_templates WHERE id = ?')
      .get(built!.templateId) as { trigger_type: string; version: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.trigger_type).toBe('goal_refinement');
    expect(row!.version).toBe(1);
  });

  it('every existing trigger type still resolves a template after seeding', () => {
    for (const trigger of ['jira_analyze', 'chat', 'investigate', 'alert', 'goal_refinement'] as const) {
      const tmpl = evolver.selectTemplate(trigger);
      expect(tmpl, `template missing for trigger '${trigger}'`).not.toBeNull();
    }
  });
});
