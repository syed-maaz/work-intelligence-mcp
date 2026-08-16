/**
 * ADR-053 Phase 2 — PM template validator harness.
 *
 * Q5 (Option C): PM's decomposition is two-stage — an LLM drafts a DAG of
 * sub-tasks, then this deterministic layer inspects the draft, catches
 * structural bugs (cycles, orphan edges), and applies domain templates that
 * can rewrite the plan (e.g. force an Ops sub-task on cross-repo work).
 *
 * This module is pure and dependency-free so it is fully unit-testable
 * without any live LLM call. The LLM drafter and the Architect reviewer are
 * injected into the PM orchestrator (see pm-orchestrator.ts).
 *
 * See:
 *   - docs/docs/adr/adr-053-multi-stage-orchestration.md § Q5
 *   - .planning/adr-053-multi-stage-orchestration/DISCUSSION.md § Q5 (Option C)
 */

/** A sub-task posture inside a PM-drafted plan. */
export type SubTaskPosture = 'fe' | 'be' | 'ops' | 'generic';

/** One node in the PM-drafted DAG. */
export interface PlanSubTask {
  id: string;
  title: string;
  posture: SubTaskPosture;
  /** Parent node ids — DAG edges. Empty = dispatchable immediately. */
  depends_on: string[];
}

/** The DAG the PM LLM drafts (before validation). */
export interface PlanDraft {
  sub_tasks: PlanSubTask[];
}

/**
 * Hydrated brief handed to templates. In MVP the hydration is template-
 * hard-coded; the fields here mirror what the SCOPE phase's RefinedGoal
 * exposes plus the affected-repos signal PM computes.
 */
export interface HydratedBrief {
  goal: string;
  intent: string;
  target: string;
  affected_repos: string[];
}

/** A single mutation a template applied to the draft (audit trail). */
export interface PlanRewrite {
  validator: string;
  detail: string;
}

/** Result of a validator (structural or template) run. */
export interface ValidatorResult {
  ok: boolean;
  /** Present when the validator rewrote the plan. */
  draft?: PlanDraft;
  rewrites?: PlanRewrite[];
  errors?: string[];
}

/** A domain template: applies() gates it; validate() inspects/rewrites. */
export interface PlanValidator {
  name: string;
  applies: (brief: HydratedBrief) => boolean;
  validate: (draft: PlanDraft, brief: HydratedBrief) => ValidatorResult;
}

/**
 * Kahn topological-sort cycle check + orphan-edge check. Returns ok=false
 * with an error naming the failure. Pure; no rewrite.
 */
export function kahnCycleCheck(draft: PlanDraft): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set(draft.sub_tasks.map((t) => t.id));

  // Orphan-edge check: every depends_on target must be a known node.
  for (const t of draft.sub_tasks) {
    for (const dep of t.depends_on) {
      if (!ids.has(dep)) {
        errors.push(`orphan edge: '${t.id}' depends on unknown node '${dep}'`);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // Kahn's algorithm: repeatedly remove zero-in-degree nodes.
  const indegree = new Map<string, number>();
  for (const t of draft.sub_tasks) indegree.set(t.id, 0);
  for (const t of draft.sub_tasks) {
    for (const _dep of t.depends_on) {
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);

  const byId = new Map(draft.sub_tasks.map((t) => [t.id, t]));
  // Build reverse adjacency: dep -> dependents
  const dependents = new Map<string, string[]>();
  for (const t of draft.sub_tasks) {
    for (const dep of t.depends_on) {
      const arr = dependents.get(dep) ?? [];
      arr.push(t.id);
      dependents.set(dep, arr);
    }
  }

  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    visited++;
    for (const child of dependents.get(id) ?? []) {
      const node = byId.get(child);
      if (!node) continue;
      indegree.set(child, (indegree.get(child) ?? 0) - 1);
      if ((indegree.get(child) ?? 0) === 0) queue.push(child);
    }
  }

  if (visited !== draft.sub_tasks.length) {
    return { ok: false, errors: ['cycle detected: plan DAG is not acyclic'] };
  }
  return { ok: true, errors: [] };
}

/**
 * Structural validators run on EVERY plan regardless of template match.
 * Today: the Kahn cycle + orphan check.
 */
export const STRUCTURAL_VALIDATORS: PlanValidator[] = [
  {
    name: 'structural_acyclic',
    applies: () => true,
    validate: (draft) => {
      const res = kahnCycleCheck(draft);
      return res.ok ? { ok: true } : { ok: false, errors: res.errors };
    },
  },
];

/**
 * Run structural validators + any applicable domain templates in order.
 * Templates may rewrite the draft; rewrites accumulate. Returns the final
 * (possibly rewritten) draft, ok flag, accumulated rewrites, and errors.
 */
export function runPlanValidators(
  draft: PlanDraft,
  brief: HydratedBrief,
  templates: PlanValidator[],
): ValidatorResult {
  let current = draft;
  const rewrites: PlanRewrite[] = [];

  // 1. Structural checks first — a cyclic/orphan plan is rejected outright.
  for (const v of STRUCTURAL_VALIDATORS) {
    const res = v.validate(current, brief);
    if (!res.ok) return { ok: false, errors: res.errors, rewrites };
  }

  // 2. Domain templates that apply — may rewrite.
  for (const t of templates) {
    if (!t.applies(brief)) continue;
    const res = t.validate(current, brief);
    if (!res.ok) return { ok: false, errors: res.errors, rewrites };
    if (res.draft) current = res.draft;
    if (res.rewrites) rewrites.push(...res.rewrites);
  }

  // 3. Re-run structural checks after rewrites (defensive).
  for (const v of STRUCTURAL_VALIDATORS) {
    const res = v.validate(current, brief);
    if (!res.ok) return { ok: false, errors: res.errors, rewrites };
  }

  return { ok: true, draft: current, rewrites };
}
