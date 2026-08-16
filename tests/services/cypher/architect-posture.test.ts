import { describe, it, expect } from 'vitest';
import {
  architectReview,
  type ArchitectInput,
} from '../../../src/services/cypher/architect-posture.js';
import type { PlanDraft, HydratedBrief } from '../../../src/services/cypher/pm-templates/index.js';

function brief(partial: Partial<HydratedBrief> = {}): HydratedBrief {
  return { goal: 'g', intent: 'build', target: 't', affected_repos: ['example-service', 'example-service'], ...partial };
}

describe('architect posture — deterministic review', () => {
  it('empty plan → verdict=revise with notes', () => {
    const input: ArchitectInput = { plan: { sub_tasks: [] }, brief: brief() };
    const res = architectReview(input);
    expect(res.verdict).toBe('revise');
    expect(res.notes.length).toBeGreaterThan(0);
  });

  it('complete cross-repo plan → verdict=approved', () => {
    const plan: PlanDraft = {
      sub_tasks: [
        { id: 'be', title: 'BE', posture: 'be', depends_on: [] },
        { id: 'fe', title: 'FE', posture: 'fe', depends_on: ['be'] },
        { id: 'ops', title: 'Ops', posture: 'ops', depends_on: ['fe'] },
      ],
    };
    const res = architectReview({ plan, brief: brief() });
    expect(res.verdict).toBe('approved');
  });

  it('plan with cycle → verdict=revise with cycle note', () => {
    const plan: PlanDraft = {
      sub_tasks: [
        { id: 'a', title: 'A', posture: 'be', depends_on: ['b'] },
        { id: 'b', title: 'B', posture: 'fe', depends_on: ['a'] },
      ],
    };
    const res = architectReview({ plan, brief: brief() });
    expect(res.verdict).toBe('revise');
    expect(res.notes.join(' ')).toMatch(/cycle/i);
  });
});
