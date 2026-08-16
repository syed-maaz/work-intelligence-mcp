/**
 * ADR-039 AC-8 — refined_goal schema tests.
 *
 * 5 valid shapes pass validation; 5 invalid shapes each name the
 * specific failing field. The validator is hand-rolled (no ajv) per
 * src/services/cypher/refined-goal-schema.ts, so these tests are the
 * contract: any change to required fields or enum membership needs a
 * matching test update.
 */

import { describe, expect, it } from 'vitest';

import {
  parseRefinedGoal,
  validateRefinedGoal,
} from '../../src/services/cypher/refined-goal-schema.js';

const minimalValid = {
  intent: 'investigate',
  target: 'DEMO-15702 401 loop',
  constraints: [],
  success_criteria: ['RCA documented in Jira'],
  out_of_scope: [],
  linkage: { jira: ['DEMO-15702'], prs: [], adrs: [], files: [] },
  expected_output_shape: 'rca',
  evidence_cited: [],
};

describe('refined-goal-schema — valid shapes', () => {
  it('AC-8.v1: minimal investigate intent passes', () => {
    const r = validateRefinedGoal(minimalValid);
    expect(r.ok).toBe(true);
  });

  it('AC-8.v2: build intent with full linkage + evidence passes', () => {
    const payload = {
      intent: 'build',
      target: 'rate limiter for /search',
      constraints: ['must keep p99 < 100ms', 'no new dependencies'],
      success_criteria: [
        'tests pass',
        'smoke § 39 green',
        'p99 unchanged on staging',
      ],
      out_of_scope: ['caching layer', 'multi-tenant isolation'],
      linkage: {
        jira: ['DEMO-9001'],
        prs: ['#3918', '#3919'],
        adrs: ['ADR-039'],
        files: ['src/api/search.ts', 'src/rate-limiter.ts'],
      },
      expected_output_shape: 'patch',
      evidence_cited: [
        {
          source: 'palace.recall',
          ref: 'prior rate-limit incident 2026-05-12',
          snippet: 'token bucket worked, IP-only keying caused NAT FP',
        },
      ],
    };
    const r = validateRefinedGoal(payload);
    expect(r.ok).toBe(true);
  });

  it('AC-8.v3: review intent with code output shape passes', () => {
    const r = validateRefinedGoal({
      ...minimalValid,
      intent: 'review',
      target: 'PR #3920',
      success_criteria: ['CODEOWNERS happy', 'CI green'],
      expected_output_shape: 'code',
    });
    expect(r.ok).toBe(true);
  });

  it('AC-8.v4: analyze intent with brief output passes', () => {
    const r = validateRefinedGoal({
      ...minimalValid,
      intent: 'analyze',
      expected_output_shape: 'brief',
    });
    expect(r.ok).toBe(true);
  });

  it('AC-8.v5: "other" intent with answer output passes', () => {
    const r = validateRefinedGoal({
      ...minimalValid,
      intent: 'other',
      expected_output_shape: 'answer',
    });
    expect(r.ok).toBe(true);
  });
});

describe('refined-goal-schema — invalid shapes', () => {
  it('AC-8.i1: missing target fails with target error', () => {
    const { target: _drop, ...rest } = minimalValid;
    const r = validateRefinedGoal(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.startsWith('target:'))).toBe(true);
    }
  });

  it('AC-8.i2: empty success_criteria fails with non-empty error', () => {
    const r = validateRefinedGoal({ ...minimalValid, success_criteria: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('success_criteria'))).toBe(true);
    }
  });

  it('AC-8.i3: wrong-enum intent fails with intent error', () => {
    const r = validateRefinedGoal({ ...minimalValid, intent: 'frobnicate' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.startsWith('intent:'))).toBe(true);
    }
  });

  it('AC-8.i4: malformed linkage (missing prs key) fails', () => {
    const r = validateRefinedGoal({
      ...minimalValid,
      linkage: { jira: [], adrs: [], files: [] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('linkage.prs'))).toBe(true);
    }
  });

  it('AC-8.i5: malformed evidence_cited (non-string snippet) fails', () => {
    const r = validateRefinedGoal({
      ...minimalValid,
      evidence_cited: [{ source: 'palace', ref: 'x', snippet: 42 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('evidence_cited[0].snippet'))).toBe(
        true,
      );
    }
  });
});

describe('refined-goal-schema — parseRefinedGoal JSON gate', () => {
  it('parses valid JSON to a validated shape', () => {
    const r = parseRefinedGoal(JSON.stringify(minimalValid));
    expect(r.ok).toBe(true);
  });

  it('returns json_parse error on malformed JSON', () => {
    const r = parseRefinedGoal('{not-json');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].startsWith('json_parse:')).toBe(true);
    }
  });
});

// ── expected_output_shape near-miss coercion (2026-07-16) ──────────────────
// The refiner LLM intermittently emits off-enum shapes (esp. 'plan' — it
// conflates the Stage-1 brief with a Stage-2 plan) + legacy pr|branch|summary.
// Hard-rejecting halted the whole dispatch at iter 0 (the SCOPE schema halt).
// These coerce to the closest valid shape instead of failing.
describe('refined-goal-schema — expected_output_shape coercion', () => {
  const withShape = (shape: string) => ({ ...minimalValid, expected_output_shape: shape });

  it("coerces 'plan' → 'brief' (the value that halted every dispatch)", () => {
    const r = validateRefinedGoal(withShape('plan'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.expected_output_shape).toBe('brief');
  });

  it("coerces legacy pr|branch → 'patch', summary → 'brief'", () => {
    for (const [inp, want] of [['pr', 'patch'], ['branch', 'patch'], ['summary', 'brief']] as const) {
      const r = validateRefinedGoal(withShape(inp));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.expected_output_shape).toBe(want);
    }
  });

  it('is case/whitespace tolerant', () => {
    const r = validateRefinedGoal(withShape('  Plan '));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.expected_output_shape).toBe('brief');
  });

  it('leaves a valid shape untouched', () => {
    const r = validateRefinedGoal(withShape('code'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.expected_output_shape).toBe('code');
  });

  it('still REJECTS a genuinely-unknown shape (no silent pass)', () => {
    const r = validateRefinedGoal(withShape('banana'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('output_shape'))).toBe(true);
  });
});

// ── Deliberative intents (AC-A1, 2026-07-17) ────────────────────────────────
// The refiner may now emit brainstorm|plan|decide for thinking-work goals.
// These MUST validate (so the PM capture hook can route them to the board);
// before this they hit the "expected one of …" error and halted the dispatch.
// This is the schema half of the two-ADR vocabulary reconciliation — the
// downstream mapRefinedIntent (task-memory.ts) already expects these keys.
describe('refined-goal-schema — deliberative intents (AC-A1)', () => {
  const withIntent = (intent: string) => ({ ...minimalValid, intent });

  it('accepts brainstorm|plan|decide as valid intents', () => {
    for (const intent of ['brainstorm', 'plan', 'decide'] as const) {
      const r = validateRefinedGoal(withIntent(intent));
      expect(r.ok, `intent '${intent}' should validate`).toBe(true);
      if (r.ok) expect(r.value.intent).toBe(intent);
    }
  });

  it('still rejects a genuinely-unknown intent verb (no silent pass)', () => {
    const r = validateRefinedGoal(withIntent('ponder'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('intent:'))).toBe(true);
  });

  it('leaves the six doing-verbs untouched', () => {
    for (const intent of ['investigate', 'build', 'review', 'analyze', 'refactor', 'other'] as const) {
      const r = validateRefinedGoal(withIntent(intent));
      expect(r.ok, `intent '${intent}' should still validate`).toBe(true);
    }
  });
});
