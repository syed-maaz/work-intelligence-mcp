/**
 * ADR-053 Phase 2 — `feature.cross-repo` template (the MVP's single template).
 *
 * Matches cross-repo feature goals: a feature that spans web (frontend)
 * + API/backend + operations. Two responsibilities:
 *
 *   applies(brief)  — set-membership classifier: is this a cross-repo feature?
 *   validate(draft) — domain rule: if `operations` is an affected repo, the
 *                     plan MUST contain an Ops sub-task; if missing, rewrite
 *                     the plan to append one (depending on the last node).
 *
 * Pure + deterministic — unit-tested in tests/services/cypher/pm-templates.test.ts.
 *
 * See docs/docs/adr/adr-053-multi-stage-orchestration.md § Q5 / AC-S5.
 */
import type {
  PlanValidator,
  PlanDraft,
  HydratedBrief,
  ValidatorResult,
} from './index.js';

const BUILD_INTENTS = new Set(['build', 'refactor', 'execute']);

/**
 * Cross-repo signal: the brief touches 2+ repos (or explicitly names
 * operations alongside a code repo) AND the intent is a doing/build verb.
 * Investigate/analyze/answer/doc-only goals are out of shape.
 */
function isCrossRepoFeature(brief: HydratedBrief): boolean {
  const repos = new Set((brief.affected_repos ?? []).map((r) => r.toLowerCase()));
  const multiRepo = repos.size >= 2;
  const intentOk = BUILD_INTENTS.has(brief.intent.toLowerCase());
  return multiRepo && intentOk;
}

const featureCrossRepo: PlanValidator = {
  name: 'feature.cross-repo',
  applies: isCrossRepoFeature,
  validate: (draft: PlanDraft, brief: HydratedBrief): ValidatorResult => {
    const repos = new Set((brief.affected_repos ?? []).map((r) => r.toLowerCase()));
    const needsOps = repos.has('operations');
    if (!needsOps) return { ok: true };

    const hasOps = draft.sub_tasks.some((t) => t.posture === 'ops');
    if (hasOps) return { ok: true };

    // Rewrite: append an Ops sub-task depending on the current terminal node(s)
    // so it runs last in the DAG.
    const ids = new Set(draft.sub_tasks.map((t) => t.id));
    const depended = new Set<string>();
    for (const t of draft.sub_tasks) for (const d of t.depends_on) depended.add(d);
    const terminals = [...ids].filter((id) => !depended.has(id));

    const opsNode = {
      id: 'ops',
      title: 'Ops: deploy / rollout configuration',
      posture: 'ops' as const,
      depends_on: terminals.length > 0 ? terminals : [...ids],
    };

    const rewritten: PlanDraft = { sub_tasks: [...draft.sub_tasks, opsNode] };
    return {
      ok: true,
      draft: rewritten,
      rewrites: [
        {
          validator: 'feature.cross-repo',
          detail: 'added missing Ops sub-task (operations is an affected repo)',
        },
      ],
    };
  },
};

export default featureCrossRepo;
