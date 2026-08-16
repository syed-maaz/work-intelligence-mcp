import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/db/schema.js';

// ── Mock Anthropic SDK so the scorer never hits the network in tests ────────
// Both `score()` and `scoreRefinedGoal()` route through `beta.promptCaching.
// messages.create`. We capture the call payload so the test can branch on
// which system prompt was used and recover the actual rubric the scorer ran.
const sdkCalls: Array<{ system: unknown; prompt: string }> = [];

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      beta = {
        promptCaching: {
          messages: {
            create: vi.fn(async (input: any) => {
              sdkCalls.push({
                system: input.system,
                prompt: (input.messages?.[0]?.content as string) ?? '',
              });
              return {
                content: [
                  {
                    type: 'tool_use',
                    id: 'test',
                    name: 'quality_score',
                    input: { relevance: 0.7, depth: 0.6, actionability: 0.8 },
                  },
                ],
              };
            }),
          },
        },
      };
    },
  };
});

import { QualityScorer } from '../../src/intelligence/quality-scorer.js';
import { seedTemplatesIfEmpty } from '../../src/intelligence/prompt-seeds.js';
import type { ClaudeCodeResult } from '../../src/services/claude-code-runner.js';

/**
 * ADR-039 AC-12: when `triggerType === 'goal_refinement'`, QualityScorer
 * scores the refined_goal brief (not the findings). This test asserts the
 * branch by capturing the SDK payload: the goal_refinement path uses a
 * distinct system prompt ("Cypher's scope phase") whereas every other
 * trigger uses the default scorer system prompt ("quality evaluator for
 * AI-generated code research"). Same code path = same mock — branch
 * detection is by the system prompt text + recorded trigger_type.
 */
describe('QualityScorer — branches on trigger_type (ADR-039 AC-12)', () => {
  let db: Database.Database;
  let scorer: QualityScorer;
  let templateId: number;

  beforeEach(() => {
    sdkCalls.length = 0;
    db = new Database(':memory:');
    initializeDatabase(db);
    seedTemplatesIfEmpty(db);
    scorer = new QualityScorer('fake-api-key', db);

    const row = db
      .prepare(`SELECT id FROM prompt_templates WHERE trigger_type = 'goal_refinement' AND version = 1`)
      .get() as { id: number } | undefined;
    if (!row) throw new Error('seed did not create goal_refinement template');
    templateId = row.id;
  });

  function mkResult(extra: Partial<ClaudeCodeResult> = {}): ClaudeCodeResult {
    return {
      findings: [
        {
          title: 'brief',
          explanation: JSON.stringify({
            intent: 'unify scope and execute',
            target: 'src/services/cypher/loop.ts',
            constraints: ['no schema break'],
            success_criteria: ['typecheck clean'],
            out_of_scope: ['UI changes'],
            linkage: { tickets: ['ADR-039'], prs: [], files: ['src/services/cypher/loop.ts'] },
            expected_output_shape: 'patch',
            evidence_cited: ['loop.ts:583 runLoop entry'],
          }),
          confidence: 0.9,
          relevantFiles: ['src/services/cypher/loop.ts'],
        },
      ],
      filesExamined: ['src/services/cypher/loop.ts'],
      confidence: 0.9,
      model: 'claude-sonnet-test',
      tokensUsed: 1000,
      costUsd: 0.01,
      durationMs: 100,
      ...extra,
    } as ClaudeCodeResult;
  }

  it('default trigger (jira_analyze) uses the generic code-research scorer rubric', async () => {
    const result = mkResult();
    const score = await scorer.score(result, templateId, 'What broke ticket DEMO-15257?', undefined, 'jira_analyze');
    expect(score).not.toBeNull();
    expect(sdkCalls).toHaveLength(1);

    const systemBlocks = sdkCalls[0].system as Array<{ text: string }>;
    expect(systemBlocks[0].text).toMatch(/quality evaluator for AI-generated code research/);
    expect(systemBlocks[0].text).not.toMatch(/scope phase/i);
    expect(sdkCalls[0].prompt).toMatch(/Score this code research output/);
  });

  it('goal_refinement trigger uses the refined_goal scorer rubric (AC-12)', async () => {
    const result = mkResult();
    const score = await scorer.score(result, templateId, 'unify Cypher scope and execute', undefined, 'goal_refinement');
    expect(score).not.toBeNull();
    expect(sdkCalls).toHaveLength(1);

    const systemBlocks = sdkCalls[0].system as Array<{ text: string }>;
    expect(systemBlocks[0].text).toMatch(/scope phase/i);
    expect(systemBlocks[0].text).toMatch(/structured brief/i);
    expect(sdkCalls[0].prompt).toMatch(/Score this goal-refinement brief/);
    // Re-anchored axes wording must appear in the rubric prompt.
    expect(sdkCalls[0].prompt).toMatch(/disambiguate the required fields/);
    expect(sdkCalls[0].prompt).toMatch(/Could the execute phase act on this brief without re-asking/);
  });

  it('scoreRefinedGoal() callable directly with a typed RefinedGoalArtifact', async () => {
    const score = await scorer.scoreRefinedGoal({
      rawGoal: 'fix the rate limiter race',
      refinedGoal: {
        intent: 'fix race window in rate limiter',
        target: 'src/services/rate-limiter.ts',
        constraints: ['no breaking API'],
        success_criteria: ['all 14 tests pass'],
        out_of_scope: ['IP-only fallback redesign'],
        linkage: { tickets: ['DEMO-1'], prs: [], files: ['src/services/rate-limiter.ts'] },
        expected_output_shape: 'patch',
        evidence_cited: ['rate-limiter.ts:42'],
      },
      templateId,
    });
    expect(score).not.toBeNull();
    expect(score!.combined).toBeCloseTo(0.7 * 0.4 + 0.6 * 0.3 + 0.8 * 0.3, 6);
  });

  it('writes prompt_outcomes row with the raw goal as trigger_input', async () => {
    const before = (db.prepare('SELECT COUNT(*) as c FROM prompt_outcomes').get() as { c: number }).c;
    await scorer.scoreRefinedGoal({
      rawGoal: 'GOAL-SENTINEL-XYZ',
      refinedGoal: {
        intent: 'x',
        target: 'y',
        constraints: [],
        success_criteria: [],
        out_of_scope: [],
        linkage: { tickets: [], prs: [], files: [] },
        expected_output_shape: 'plan',
        evidence_cited: [],
      },
      templateId,
    });
    const after = (db.prepare('SELECT COUNT(*) as c FROM prompt_outcomes').get() as { c: number }).c;
    expect(after).toBe(before + 1);

    const row = db
      .prepare('SELECT trigger_input, template_id FROM prompt_outcomes ORDER BY id DESC LIMIT 1')
      .get() as { trigger_input: string; template_id: number };
    expect(row.trigger_input).toBe('GOAL-SENTINEL-XYZ');
    expect(row.template_id).toBe(templateId);
  });

  it('parses ClaudeCodeResult.findings[0].explanation as the brief JSON', async () => {
    // Verifies the branch's JSON parse path: the explanation IS the brief.
    const result = mkResult();
    await scorer.score(result, templateId, 'raw goal text', undefined, 'goal_refinement');
    expect(sdkCalls).toHaveLength(1);
    // Brief JSON should be quoted inside the prompt — the scorer serializes
    // the parsed object, so target appears under its JSON key.
    expect(sdkCalls[0].prompt).toContain('"target"');
    expect(sdkCalls[0].prompt).toContain('src/services/cypher/loop.ts');
  });

  it('falls back to rawBrief text when the explanation is not valid JSON', async () => {
    const result = mkResult({
      findings: [
        {
          title: 'brief',
          explanation: 'this is not JSON, just prose',
          confidence: 0.3,
          relevantFiles: [],
        },
      ],
    });
    const score = await scorer.score(result, templateId, 'fuzzy raw goal', undefined, 'goal_refinement');
    expect(score).not.toBeNull();
    expect(sdkCalls).toHaveLength(1);
    expect(sdkCalls[0].prompt).toContain('this is not JSON, just prose');
  });
});
