import { describe, it, expect } from 'vitest';
import {
  detectCrossRepoShape,
  briefFromRefinedGoal,
} from '../../../src/services/cypher/pm-shape-detection.js';
import type { RefinedGoal } from '../../../src/services/cypher/refined-goal-schema.js';

function rg(partial: Partial<RefinedGoal> = {}): RefinedGoal {
  return {
    intent: 'build',
    target: 'lotse endpoint for X service',
    constraints: [],
    success_criteria: ['works'],
    out_of_scope: [],
    linkage: { jira: [], prs: [], adrs: [], files: [] },
    expected_output_shape: 'code',
    evidence_cited: [],
    ...partial,
  };
}

describe('pm-shape-detection — feature.cross-repo on RefinedGoal', () => {
  it('detects a cross-repo build goal that names FE+BE+Ops', () => {
    const goal = rg({ target: 'new endpoint in lotse (FE + BE + Ops)' });
    const brief = briefFromRefinedGoal('Implement new endpoint in lotse (FE + BE + Ops)', goal);
    expect(brief.affected_repos.length).toBeGreaterThanOrEqual(2);
    expect(detectCrossRepoShape(brief)).toBe(true);
  });

  it('does NOT detect a single-repo bug-fix goal', () => {
    const goal = rg({ intent: 'investigate', target: 'null deref in order processing' });
    const brief = briefFromRefinedGoal('Fix null deref in order processing', goal);
    expect(detectCrossRepoShape(brief)).toBe(false);
  });

  it('does NOT detect a doc-only goal', () => {
    const goal = rg({ intent: 'other', target: 'update README typo' });
    const brief = briefFromRefinedGoal('Update README typo', goal);
    expect(detectCrossRepoShape(brief)).toBe(false);
  });
});
