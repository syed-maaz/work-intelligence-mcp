/**
 * ADR-042 multi-intent — schema validator + classifier tests.
 *
 * Verifies:
 *   1. RefinedGoal validator accepts a valid intents[] array
 *   2. Validator rejects malformed intents[] shapes
 *   3. Back-compat: absent intents[] still validates
 *   4. Mirror invariant: intents[0].intent must match top-level intent
 *   5. classifyMultiIntent degrades gracefully on classifier failure
 */
import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { validateRefinedGoal } from '../../src/services/cypher/refined-goal-schema.js';
import { classifyMultiIntent } from '../../src/services/cypher/multi-intent-classifier.js';

const FLAT = {
  intent: 'investigate',
  target: 'search-provider proxy 401',
  constraints: [],
  success_criteria: ['root cause identified'],
  out_of_scope: [],
  linkage: { jira: [], prs: [], adrs: [], files: [] },
  expected_output_shape: 'rca',
  evidence_cited: [],
};

const SUB_A = {
  intent: 'investigate',
  target: 'search-provider proxy 401',
  constraints: [],
  success_criteria: ['root cause identified'],
  out_of_scope: [],
  linkage: { jira: [], prs: [], adrs: [], files: [] },
  expected_output_shape: 'rca',
  evidence_cited: [],
};
const SUB_B = {
  intent: 'build',
  target: 'the token middleware',
  constraints: [],
  success_criteria: ['refactored + tests green'],
  out_of_scope: [],
  linkage: { jira: [], prs: [], adrs: [], files: [] },
  expected_output_shape: 'code',
  evidence_cited: [],
};

describe('ADR-042 multi-intent — schema validator', () => {
  it('accepts flat single-intent brief (absent intents[])', () => {
    const r = validateRefinedGoal(FLAT);
    expect(r.ok).toBe(true);
  });

  it('accepts multi-intent brief with matching intents[0] mirror', () => {
    const brief = { ...FLAT, intents: [SUB_A, SUB_B] };
    const r = validateRefinedGoal(brief);
    if (!r.ok) console.log('Errors:', r.errors);
    expect(r.ok).toBe(true);
  });

  it('rejects when intents[0].intent does NOT mirror top-level intent', () => {
    const brief = { ...FLAT, intents: [{ ...SUB_A, intent: 'build' }, SUB_B] };
    const r = validateRefinedGoal(brief);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('intents[0].intent must mirror'))).toBe(true);
    }
  });

  it('rejects when intents[0].target does NOT mirror top-level target', () => {
    const brief = { ...FLAT, intents: [{ ...SUB_A, target: 'different target' }, SUB_B] };
    const r = validateRefinedGoal(brief);
    expect(r.ok).toBe(false);
  });

  it('rejects when intents is present but empty array', () => {
    const brief = { ...FLAT, intents: [] };
    const r = validateRefinedGoal(brief);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('non-empty array'))).toBe(true);
    }
  });

  it('rejects when a sub-brief has bad enum', () => {
    const brief = { ...FLAT, intents: [SUB_A, { ...SUB_B, intent: 'nonsense' }] };
    const r = validateRefinedGoal(brief);
    expect(r.ok).toBe(false);
  });

  it('rejects when a sub-brief is missing linkage', () => {
    const bad = { ...SUB_B } as unknown as Record<string, unknown>;
    delete bad.linkage;
    const brief = { ...FLAT, intents: [SUB_A, bad] };
    const r = validateRefinedGoal(brief);
    expect(r.ok).toBe(false);
  });
});

// ── classifier ───────────────────────────────────────────────────────────
function mockClient(replyText: string) {
  const create = vi.fn(async () => ({
    id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-mock',
    content: [{ type: 'text', text: replyText }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }));
  const client = { beta: { promptCaching: { messages: { create } } } } as unknown as Anthropic;
  return { client, create };
}

describe('ADR-042 classifyMultiIntent', () => {
  it('classifier: single-intent goal returns is_single=true, 1 sub-goal', async () => {
    const { client } = mockClient(JSON.stringify({
      is_single: true,
      sub_goals: [{ intent: 'investigate', goal: 'why search-provider 401' }],
    }));
    const r = await classifyMultiIntent('why is search-provider returning 401', client);
    expect(r.is_single).toBe(true);
    expect(r.sub_goals).toHaveLength(1);
    expect(r.sub_goals[0]!.intent).toBe('investigate');
  });

  it('classifier: compound goal returns is_single=false, N sub-goals', async () => {
    const { client } = mockClient(JSON.stringify({
      is_single: false,
      sub_goals: [
        { intent: 'investigate', goal: 'investigate search-provider 401' },
        { intent: 'build', goal: 'refactor the token middleware' },
        { intent: 'build', goal: 'ship the fix' },
      ],
    }));
    const r = await classifyMultiIntent('investigate search-provider 401 AND refactor middleware AND ship it', client);
    expect(r.is_single).toBe(false);
    expect(r.sub_goals).toHaveLength(3);
  });

  it('classifier: caps at 5 sub-goals', async () => {
    const { client } = mockClient(JSON.stringify({
      is_single: false,
      sub_goals: Array(10).fill(0).map((_, i) => ({ intent: 'other', goal: `sub ${i}` })),
    }));
    const r = await classifyMultiIntent('massive compound goal', client);
    expect(r.sub_goals.length).toBeLessThanOrEqual(5);
  });

  it('classifier: heals contradiction (is_single=true but sub_goals.length>1)', async () => {
    const { client } = mockClient(JSON.stringify({
      is_single: true,
      sub_goals: [
        { intent: 'investigate', goal: 'A' },
        { intent: 'build', goal: 'B' },
      ],
    }));
    const r = await classifyMultiIntent('goal', client);
    expect(r.is_single).toBe(false); // healed: count wins over flag
    expect(r.sub_goals).toHaveLength(2);
  });

  it('classifier: degrades gracefully on parse error', async () => {
    const { client } = mockClient('this is not JSON at all');
    const r = await classifyMultiIntent('goal', client);
    expect(r.is_single).toBe(true);
    expect(r.sub_goals).toHaveLength(1);
    expect(r.sub_goals[0]!.goal).toBe('goal');
    expect(r.classifier_error).toBeTruthy();
  });

  it('classifier: degrades on client throw', async () => {
    const client = { beta: { promptCaching: { messages: { create: vi.fn(async () => { throw new Error('anthropic down'); }) } } } } as unknown as Anthropic;
    const r = await classifyMultiIntent('goal', client);
    expect(r.is_single).toBe(true);
    expect(r.classifier_error).toContain('anthropic down');
  });

  it('classifier: empty goal returns fallback with empty sub-goal.goal', async () => {
    const { client } = mockClient('doesnt matter');
    const r = await classifyMultiIntent('   ', client);
    expect(r.is_single).toBe(true);
    // Fallback path — sub_goal.goal is the trimmed raw goal (empty here).
    expect(r.sub_goals[0]!.goal).toBe('');
  });

  it('classifier: unknown intent maps to other, invalid entries skipped', async () => {
    const { client } = mockClient(JSON.stringify({
      is_single: false,
      sub_goals: [
        { intent: 'investigate', goal: 'A' },
        { intent: 'weird-unknown', goal: 'B' },
        { intent: 'build' /* no goal */ },
        { goal: 'no intent' },
        'not an object',
      ],
    }));
    const r = await classifyMultiIntent('mixed shapes', client);
    // Only 3 valid: {intent:investigate, goal:A}, {intent:other, goal:B}, {intent:other, goal:'no intent'}
    expect(r.sub_goals.length).toBe(3);
    expect(r.sub_goals[1]!.intent).toBe('other'); // 'weird-unknown' → 'other'
  });
});
