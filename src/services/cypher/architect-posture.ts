/**
 * ADR-053 Phase 2 — Architect posture (deterministic core).
 *
 * Q2 (Option B): the Architect is a distinct posture from PM. It reviews
 * {plan, hydration_evidence} and returns { verdict, notes }. In MVP the
 * structural half of that review is deterministic (cycle/empty/missing-ops),
 * which is what we unit-test. A live-LLM semantic review can layer on top
 * behind the flag, but the deterministic gate always runs first.
 *
 * See docs/docs/adr/adr-053-multi-stage-orchestration.md § Q2 / AC-S3.
 */
import { kahnCycleCheck, type PlanDraft, type HydratedBrief } from './pm-templates/index.js';

export type ArchitectVerdict = 'approved' | 'revise';

export interface ArchitectInput {
  plan: PlanDraft;
  brief: HydratedBrief;
}

export interface ArchitectReview {
  verdict: ArchitectVerdict;
  notes: string[];
}

/**
 * Deterministic architect review. Returns 'revise' with actionable notes for:
 *   - empty plan
 *   - cyclic / orphan-edge DAG
 *   - cross-repo (operations) feature missing an Ops sub-task
 * Otherwise 'approved'.
 */
export function architectReview(input: ArchitectInput): ArchitectReview {
  const notes: string[] = [];
  const { plan, brief } = input;

  if (plan.sub_tasks.length === 0) {
    return { verdict: 'revise', notes: ['plan is empty — no sub-tasks drafted'] };
  }

  const cyc = kahnCycleCheck(plan);
  if (!cyc.ok) {
    return { verdict: 'revise', notes: cyc.errors };
  }

  const repos = new Set((brief.affected_repos ?? []).map((r) => r.toLowerCase()));
  if (repos.has('operations') && !plan.sub_tasks.some((t) => t.posture === 'ops')) {
    notes.push('cross-repo feature touches operations but has no Ops sub-task');
  }

  return notes.length > 0 ? { verdict: 'revise', notes } : { verdict: 'approved', notes: [] };
}
