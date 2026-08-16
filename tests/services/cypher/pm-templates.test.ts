import { describe, it, expect } from 'vitest';
import {
  kahnCycleCheck,
  runPlanValidators,
  STRUCTURAL_VALIDATORS,
  type PlanDraft,
  type HydratedBrief,
} from '../../../src/services/cypher/pm-templates/index.js';
import featureCrossRepo from '../../../src/services/cypher/pm-templates/feature-cross-repo.js';

function brief(partial: Partial<HydratedBrief>): HydratedBrief {
  return {
    goal: 'g',
    intent: 'build',
    target: 't',
    affected_repos: [],
    ...partial,
  };
}

describe('pm-templates harness — Kahn cycle check', () => {
  it('accepts an acyclic 3-node DAG', () => {
    const draft: PlanDraft = {
      sub_tasks: [
        { id: 'be', title: 'BE', posture: 'be', depends_on: [] },
        { id: 'fe', title: 'FE', posture: 'fe', depends_on: ['be'] },
        { id: 'ops', title: 'Ops', posture: 'ops', depends_on: ['fe'] },
      ],
    };
    expect(kahnCycleCheck(draft).ok).toBe(true);
  });

  it('rejects a cyclic DAG', () => {
    const draft: PlanDraft = {
      sub_tasks: [
        { id: 'a', title: 'A', posture: 'be', depends_on: ['c'] },
        { id: 'b', title: 'B', posture: 'fe', depends_on: ['a'] },
        { id: 'c', title: 'C', posture: 'ops', depends_on: ['b'] },
      ],
    };
    const res = kahnCycleCheck(draft);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/cycle/i);
  });

  it('rejects an orphan dependency (edge to unknown node)', () => {
    const draft: PlanDraft = {
      sub_tasks: [{ id: 'a', title: 'A', posture: 'be', depends_on: ['ghost'] }],
    };
    const res = kahnCycleCheck(draft);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/orphan|unknown/i);
  });
});

describe('pm-templates harness — runPlanValidators', () => {
  it('empty template registry runs only structural checks (no rewrites)', () => {
    const draft: PlanDraft = {
      sub_tasks: [
        { id: 'be', title: 'BE', posture: 'be', depends_on: [] },
        { id: 'fe', title: 'FE', posture: 'fe', depends_on: ['be'] },
      ],
    };
    const res = runPlanValidators(draft, brief({}), []);
    expect(res.ok).toBe(true);
    expect(res.rewrites ?? []).toHaveLength(0);
  });

  it('structural validators reject a cyclic draft even with empty registry', () => {
    const draft: PlanDraft = {
      sub_tasks: [
        { id: 'a', title: 'A', posture: 'be', depends_on: ['b'] },
        { id: 'b', title: 'B', posture: 'fe', depends_on: ['a'] },
      ],
    };
    const res = runPlanValidators(draft, brief({}), []);
    expect(res.ok).toBe(false);
  });

  it('exposes at least one structural validator', () => {
    expect(STRUCTURAL_VALIDATORS.length).toBeGreaterThanOrEqual(1);
  });
});

describe('feature.cross-repo template', () => {
  it('applies() classifies a 10-goal corpus with >=80% accuracy', () => {
    const inShape: HydratedBrief[] = [
      brief({ goal: 'Implement new endpoint in lotse (FE + BE + Ops)', intent: 'build', affected_repos: ['example-service', 'operations'] }),
      brief({ goal: 'Add payments module across web and API', intent: 'build', affected_repos: ['example-service', 'operations'] }),
      brief({ goal: 'Cross-repo feature: SSO for admin panel', intent: 'build', affected_repos: ['example-service', 'operations'] }),
      brief({ goal: 'Wire new service endpoint end to end', intent: 'refactor', affected_repos: ['example-service', 'operations'] }),
      brief({ goal: 'Add canary rollout for web app with ops', intent: 'build', affected_repos: ['example-service', 'operations'] }),
    ];
    const outShape: HydratedBrief[] = [
      brief({ goal: 'Fix a null deref bug in order processing', intent: 'investigate', affected_repos: ['example-service'] }),
      brief({ goal: 'Update README typo', intent: 'other', affected_repos: [] }),
      brief({ goal: 'Optimize a DB query on reports', intent: 'refactor', affected_repos: ['example-service'] }),
      brief({ goal: 'Investigate flaky test', intent: 'investigate', affected_repos: ['example-service'] }),
      brief({ goal: 'Answer a question about config', intent: 'analyze', affected_repos: [] }),
    ];
    let correct = 0;
    for (const b of inShape) if (featureCrossRepo.applies(b)) correct++;
    for (const b of outShape) if (!featureCrossRepo.applies(b)) correct++;
    expect(correct / 10).toBeGreaterThanOrEqual(0.8);
  });

  it('validate() forces an Ops sub-task when operations is an affected repo', () => {
    const draft: PlanDraft = {
      sub_tasks: [
        { id: 'be', title: 'BE', posture: 'be', depends_on: [] },
        { id: 'fe', title: 'FE', posture: 'fe', depends_on: ['be'] },
      ],
    };
    const b = brief({ affected_repos: ['example-service', 'operations'] });
    const res = featureCrossRepo.validate(draft, b);
    expect(res.ok).toBe(true);
    expect(res.draft?.sub_tasks.some((t: { posture: string }) => t.posture === 'ops')).toBe(true);
    expect((res.rewrites ?? []).some((r: { detail: string }) => /ops/i.test(r.detail))).toBe(true);
  });

  it('validate() leaves a plan untouched when an Ops sub-task already exists', () => {
    const draft: PlanDraft = {
      sub_tasks: [
        { id: 'be', title: 'BE', posture: 'be', depends_on: [] },
        { id: 'ops', title: 'Ops', posture: 'ops', depends_on: ['be'] },
      ],
    };
    const b = brief({ affected_repos: ['example-service'] });
    const res = featureCrossRepo.validate(draft, b);
    expect(res.ok).toBe(true);
    expect(res.rewrites ?? []).toHaveLength(0);
  });
});
