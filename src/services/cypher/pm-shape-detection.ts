/**
 * ADR-053 Phase 2.4 — shape detection on the SCOPE-emitted RefinedGoal.
 *
 * The dispatcher evaluates `feature.cross-repo` on the RefinedGoal struct
 * (NOT the raw user string — SCOPE's normalization is load-bearing for
 * classifier accuracy per AC-S5). This module derives a HydratedBrief from a
 * RefinedGoal + raw goal text, and exposes the boolean detector that gates
 * the PM tier branch in web-server.js (behind ADR_053_ENABLED).
 *
 * Pure + deterministic; unit-tested in pm-shape-detection.test.ts.
 */
import type { RefinedGoal } from './refined-goal-schema.js';
import type { HydratedBrief } from './pm-templates/index.js';
import featureCrossRepo from './pm-templates/feature-cross-repo.js';

/** Known code/ops repos we look for in the goal + refined-goal linkage. */
const REPO_HINTS: Record<string, RegExp> = {
  web: /\b(web|frontend|fe|ui|react)\b/i,
  operations: /\b(operations|ops|deploy|rollout|infra|helm|k8s|kubernetes|canary)\b/i,
  backend: /\b(backend|be|api|endpoint|service|server)\b/i,
};

/**
 * Map a RefinedGoal intent to the coarse build/non-build class the template
 * classifier expects. 'build'/'refactor' → build; everything else stays as-is
 * (investigate/analyze/other/plan/... → out of shape).
 */
function coarseIntent(intent: string): string {
  const i = (intent || '').toLowerCase();
  if (i.includes('build') || i.includes('implement') || i.includes('add') || i.includes('create')) return 'build';
  if (i.includes('refactor') || i.includes('rewrite')) return 'refactor';
  if (i.includes('execute') || i.includes('ship')) return 'execute';
  return intent;
}

/**
 * Derive the affected-repos set from the raw goal + RefinedGoal target and
 * file linkage. A repo is "affected" if its hint pattern matches anywhere in
 * the combined text. FE and BE both mapping to code repos count as distinct
 * so a single sentence "FE + BE + Ops" yields 3 repos.
 */
export function briefFromRefinedGoal(rawGoal: string, refined: RefinedGoal): HydratedBrief {
  const haystack = [
    rawGoal,
    refined.target,
    ...(refined.constraints ?? []),
    ...(refined.success_criteria ?? []),
    ...(refined.linkage?.files ?? []),
  ].join(' \n ');

  const affected: string[] = [];
  for (const [repo, pat] of Object.entries(REPO_HINTS)) {
    if (pat.test(haystack)) affected.push(repo);
  }

  return {
    goal: rawGoal,
    intent: coarseIntent(refined.intent),
    target: refined.target,
    affected_repos: affected,
  };
}

/**
 * Does this brief match the feature.cross-repo shape? Delegates to the
 * template's own applies() predicate so detection and validation never drift.
 */
export function detectCrossRepoShape(brief: HydratedBrief): boolean {
  return featureCrossRepo.applies(brief);
}
