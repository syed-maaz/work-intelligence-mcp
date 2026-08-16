/**
 * Cypher Beta-prior learning loop — Slice A+B (2026-06-13).
 *
 * Per the locked CAP-12 spec: each skill carries a Beta(α, β) posterior
 * per task class. Outcomes update the posterior:
 *   success → α += 1
 *   failed  → β += 1
 *   mixed   → α += 0.5 ; β += 0.5
 *
 * The mean μ = α / (α + β) is the point estimate of the success rate.
 * Beta(1, 1) is the uninformative starting prior — equivalent to a
 * uniform distribution on [0, 1]. New skills start there and earn
 * confidence with use.
 *
 * Why Beta and not raw success-counts:
 *   - Builds in regularisation: a skill with 1/1 success isn't ranked
 *     ahead of a skill with 47/50.
 *   - Posterior captures uncertainty natively — future slices can
 *     surface "low confidence in this ranking" via posterior variance.
 *   - Cheap to update (one SQL UPDATE per outcome).
 *
 * This module is the SOLE writer for skill_priors. Cypher's run.ts
 * calls `recordSkillOutcome` once per session; nothing else writes to
 * the table. (Hard rule 7 home: src/services/cypher/.)
 */

import type Database from 'better-sqlite3';

export interface SkillPrior {
  skill_name: string;
  task_class: string;
  alpha: number;
  beta: number;
  total_runs: number;
  /** Posterior mean — α / (α + β). Pre-computed on read for convenience. */
  mean: number;
}

export type Outcome = 'success' | 'mixed' | 'failed';

/**
 * ADR-040 §3.4 verified_via tier — how the outcome was verified.
 * The weight multiplies α/β increment: a self_reported success adds
 * 0.1α (not 1.0α), so Cypher self-grading contributes ~10× less signal
 * than a user_observed outcome. Closes GAP-002 Cause 3 at the learning
 * loop layer.
 *
 * Weights (per ADR §3.4 table):
 *   user_observed        1.00  (Maaz clicked 👍)
 *   smoke_passed         0.85  (deterministic smoke green)
 *   cross_family_checked 0.50  (panel unanimous)
 *   self_reported        0.10  (Cypher session-close default)
 */
export type VerifiedVia = 'self_reported' | 'smoke_passed' | 'cross_family_checked' | 'user_observed';

const VERIFIED_VIA_WEIGHT: Record<VerifiedVia, number> = {
  self_reported: 0.10,
  smoke_passed: 0.85,
  cross_family_checked: 0.50,
  user_observed: 1.00,
};

/**
 * Update the Beta posterior for (skill, task_class) given an outcome.
 * Atomic via SQLite per-row lock. Idempotent on the prior row's
 * existence — INSERT OR IGNORE seeds Beta(1, 1) before the UPDATE.
 *
 * task_class defaults to '*' when the caller doesn't specify one.
 * That gives a single global prior per skill — useful in v1 when we
 * don't yet have a rich task-class taxonomy.
 */
/**
 * Update the Beta posterior for (skill, task_class) given an outcome.
 * Atomic via SQLite per-row lock. Idempotent on the prior row's
 * existence — INSERT OR IGNORE seeds Beta(1, 1) before the UPDATE.
 *
 * task_class defaults to '*' when the caller doesn't specify one.
 * That gives a single global prior per skill — useful in v1 when we
 * don't yet have a rich task-class taxonomy.
 *
 * Slice 82a-2: callers pass the *actually invoked* skill (which may
 * differ from the originally chosen_skill). The plural rename
 * recordSkillOutcomes signals this — present-tense single signature
 * but plurality leaves room for future per-step credit assignment
 * (CAP-12-FIX v2: credit one outcome across multiple skills).
 */
export function recordSkillOutcomes(
  db: Database.Database,
  skillName: string,
  outcome: Outcome,
  taskClass: string = '*',
  verifiedVia: VerifiedVia = 'self_reported',
): void {
  // Seed if missing — Beta(1, 1) uniform prior.
  db.prepare(`
    INSERT OR IGNORE INTO skill_priors (skill_name, task_class, alpha, beta, total_runs)
    VALUES (?, ?, 1.0, 1.0, 0)
  `).run(skillName, taskClass);

  // Apply the outcome, weighted by verified_via tier per ADR-040 §3.4.
  // A self_reported success contributes 0.1α (weight 0.10); a
  // user_observed success contributes 1.0α (weight 1.00). This is
  // the anti-Cause-3 mechanism at the learning-loop layer.
  const weight = VERIFIED_VIA_WEIGHT[verifiedVia];
  let alphaInc = 0;
  let betaInc = 0;
  switch (outcome) {
    case 'success': alphaInc = 1.0 * weight; break;
    case 'failed':  betaInc  = 1.0 * weight; break;
    case 'mixed':   alphaInc = 0.5 * weight; betaInc = 0.5 * weight; break;
  }

  db.prepare(`
    UPDATE skill_priors
       SET alpha = alpha + ?,
           beta  = beta + ?,
           total_runs = total_runs + 1,
           last_outcome_at = datetime('now'),
           updated_at = datetime('now')
     WHERE skill_name = ? AND task_class = ?
  `).run(alphaInc, betaInc, skillName, taskClass);
}

/**
 * Backwards-compat alias. Existing call sites read recordSkillOutcome;
 * keep that import resolving until they migrate to the plural name.
 */
export const recordSkillOutcome = recordSkillOutcomes;

/**
 * Return skills ranked by Beta posterior mean for a given task_class.
 * Falls back to the global prior ('*') when no class-specific prior
 * exists. Skills with no prior at all are returned with mean=0.5
 * (Beta(1, 1) implicit) so they get exploration opportunities — fairer
 * than ranking them last by default.
 *
 * candidateSkills MAY be empty — in which case the function returns
 * just the priors that exist. Callers normally want to provide the
 * candidate set (e.g. wi-* skills relevant to the current goal).
 */
export function getRankedSkills(
  db: Database.Database,
  taskClass: string = '*',
  candidateSkills: string[] = [],
): SkillPrior[] {
  const params: Array<string | number> = [taskClass];
  let sql = `
    SELECT skill_name, task_class, alpha, beta, total_runs
      FROM skill_priors
     WHERE task_class = ?
  `;
  if (candidateSkills.length > 0) {
    const placeholders = candidateSkills.map(() => '?').join(',');
    sql += ` AND skill_name IN (${placeholders})`;
    params.push(...candidateSkills);
  }
  sql += ` ORDER BY (alpha / (alpha + beta)) DESC, total_runs DESC, skill_name ASC`;

  const rows = db.prepare<typeof params, {
    skill_name: string;
    task_class: string;
    alpha: number;
    beta: number;
    total_runs: number;
  }>(sql).all(...params);

  // Add candidates not yet in the table with the uninformative prior.
  const known = new Set(rows.map(r => r.skill_name));
  const ranked: SkillPrior[] = rows.map(r => ({
    ...r,
    mean: r.alpha / (r.alpha + r.beta),
  }));
  for (const candidate of candidateSkills) {
    if (!known.has(candidate)) {
      ranked.push({
        skill_name: candidate,
        task_class: taskClass,
        alpha: 1.0,
        beta: 1.0,
        total_runs: 0,
        mean: 0.5,
      });
    }
  }
  // Re-sort after appending uniform-prior candidates so they slot at 0.5
  // among any sub-0.5 priors and below any > 0.5 priors. Stable on
  // total_runs DESC (so seasoned skills outrank cold-starts at equal mean).
  // Phase 82c: when candidates were supplied (caller curated), use their
  // input position as the final tiebreak — preserves the seeded-list
  // ordering from candidates.ts (e.g. for `pr-review` the canonical
  // top-3 wi-pr-review / wi-blast-radius / wi-investigate stays on top
  // when their priors are uniform with surrounding global-skill noise).
  const inputOrder = new Map<string, number>();
  candidateSkills.forEach((s, i) => inputOrder.set(s, i));
  ranked.sort((a, b) => {
    if (a.mean !== b.mean) return b.mean - a.mean;
    if (a.total_runs !== b.total_runs) return b.total_runs - a.total_runs;
    const ai = inputOrder.has(a.skill_name) ? inputOrder.get(a.skill_name)! : Number.MAX_SAFE_INTEGER;
    const bi = inputOrder.has(b.skill_name) ? inputOrder.get(b.skill_name)! : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.skill_name.localeCompare(b.skill_name);
  });
  return ranked;
}

// ── CAP-12-FIX (2026-06-24): effective-mean reader for clean priors ──────────
//
// Background. Pre-fix recordSkillOutcomes credited `chosen_skill` for every
// session outcome, regardless of whether that skill was actually invoked
// (a session might rank skill X first and then short-circuit, never invoke
// X, but the prior shifted anyway). That's a credit-assignment bias which
// deflates priors of skills that were ranked-top but never given a chance.
//
// Master's v62 migration added `cypher_sessions.skill_actually_invoked TEXT`
// so callers can declare the skill they actually invoked when closing a
// session — distinct from `chosen_skill` which records what Cypher
// *recommended*. The recordSkillOutcomes function above receives the
// honest skill name from callers (e.g. wi-record-outcome --used <skill>);
// behaviour from that point forward is clean.
//
// What's still needed (this commit): a way to disambiguate priors that
// accumulated pre-fix (potentially contaminated) from priors accumulated
// post-fix (clean). The `skill_priors.pre_fix_runs INTEGER` column tracks
// the contaminated count separately. `getEffectivePriors` returns a
// downweighted mean that treats contaminated runs at PRE_FIX_RUN_WEIGHT
// of full credit, so CAP-13's gap-recognition gate (when it ships) reads
// honest priors instead of pre-fix-tainted ones.
//
// This export is **forward-looking** — there's no caller for it on master
// today. CAP-13-LITE (pending ADR-037.5 redesign per .planning/audits/
// 2026-06-24-adr-037-5-audit.md) is the intended consumer.
//
// Reference: spike at .planning/spikes/2026-06-14-cap-13-original/src/
// services/cypher/learn.ts § getEffectivePriors. Algorithm preserved
// verbatim; only adapted to master's type signatures.

/** Downweight factor applied to `pre_fix_runs` when computing effective_mean. */
export const PRE_FIX_RUN_WEIGHT = 0.2;

export interface EffectiveSkillPrior extends SkillPrior {
  /** Mean computed with pre_fix_runs downweighted at PRE_FIX_RUN_WEIGHT. */
  effective_mean: number;
  /** Honest (post-fix) runs — total_runs minus pre_fix_runs. */
  post_fix_runs: number;
  /** The pre_fix_runs column verbatim. */
  pre_fix_runs: number;
}

/**
 * Read effective priors for a candidate set. Skills not yet in the
 * table are surfaced with effective_mean=0.5 (uniform Beta(1,1)) so
 * gap-recognition treats untouched skills as "no evidence either way" —
 * the case CAP-13 (when it ships) wants to flag.
 *
 * Algorithm: deflate (alpha, beta) toward Beta(1,1) by the contaminated
 * fraction at (1 - PRE_FIX_RUN_WEIGHT) discount. effective_alpha =
 * 1 + (alpha - 1) * (honest + contaminated * weight) / total. Same for
 * effective_beta. Mean = effective_alpha / (effective_alpha + effective_beta).
 *
 * Returns one entry per candidateSkills item, in input order.
 */
export function getEffectivePriors(
  db: Database.Database,
  taskClass: string,
  candidateSkills: string[],
): EffectiveSkillPrior[] {
  if (candidateSkills.length === 0) return [];
  const placeholders = candidateSkills.map(() => '?').join(',');
  const params: string[] = [taskClass, ...candidateSkills];
  const rows = db
    .prepare<typeof params, {
      skill_name: string;
      task_class: string;
      alpha: number;
      beta: number;
      total_runs: number;
      pre_fix_runs: number;
    }>(
      `SELECT skill_name, task_class, alpha, beta, total_runs, pre_fix_runs
         FROM skill_priors
        WHERE task_class = ? AND skill_name IN (${placeholders})`,
    )
    .all(...params);

  const known = new Map(rows.map(r => [r.skill_name, r]));
  const out: EffectiveSkillPrior[] = [];

  for (const skill of candidateSkills) {
    const r = known.get(skill);
    if (!r) {
      // Untouched skill — Beta(1,1), mean 0.5, post_fix_runs 0.
      out.push({
        skill_name: skill,
        task_class: taskClass,
        alpha: 1.0,
        beta: 1.0,
        total_runs: 0,
        mean: 0.5,
        effective_mean: 0.5,
        post_fix_runs: 0,
        pre_fix_runs: 0,
      });
      continue;
    }
    const honest = r.total_runs - r.pre_fix_runs;
    const contaminated = r.pre_fix_runs;
    const totalRuns = r.total_runs;
    // Effective fraction of evidence to credit. When all runs are pre-fix,
    // effectiveTotal = weight (heavy discount). When all are post-fix,
    // effectiveTotal = 1.0 (full credit). When total_runs = 0, no shift.
    const effectiveTotal = totalRuns > 0
      ? (honest + contaminated * PRE_FIX_RUN_WEIGHT) / totalRuns
      : 0;
    const effAlpha = 1 + (r.alpha - 1) * effectiveTotal;
    const effBeta = 1 + (r.beta - 1) * effectiveTotal;
    out.push({
      skill_name: skill,
      task_class: taskClass,
      alpha: r.alpha,
      beta: r.beta,
      total_runs: r.total_runs,
      mean: r.alpha / (r.alpha + r.beta),
      effective_mean: effAlpha / (effAlpha + effBeta),
      post_fix_runs: honest,
      pre_fix_runs: contaminated,
    });
  }
  return out;
}

/**
 * Aggregate per-skill success-rate across ALL task_classes.
 *
 * `getEffectivePriors(db, '*', …)` filters `WHERE task_class = '*'` — but `'*'`
 * is a literal partition key, not a wildcard. In practice almost no skill has a
 * `'*'` row (only the global-default skill does), so that call returns the
 * uninformative 0.5 for every real skill (audit BLOCKER-1, 2026-07-15). This
 * reader instead SUMs alpha/beta across every task_class a skill has, giving a
 * real global mean (e.g. wi-investigate 0.67, wi-search 0.87) for skills that
 * have any history, and 0.5 for genuinely-unseen skills.
 *
 * Read-only; `learn.ts` remains the sole reader/writer of `skill_priors`
 * (hard-rule-7). Returns a map skill_name → mean in [0,1] for the requested
 * candidate skills. Skills with no rows are omitted (caller defaults to 0.5).
 * @returns Map of skill_name → aggregated posterior mean.
 */
export function getAggregatePriorMeans(
  db: Database.Database,
  candidateSkills: string[],
): Map<string, number> {
  const means = new Map<string, number>();
  if (candidateSkills.length === 0) return means;
  const placeholders = candidateSkills.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT skill_name, SUM(alpha) AS sa, SUM(beta) AS sb
         FROM skill_priors
        WHERE skill_name IN (${placeholders})
        GROUP BY skill_name`,
    )
    .all(...candidateSkills) as Array<{ skill_name: string; sa: number; sb: number }>;
  for (const r of rows) {
    const denom = r.sa + r.sb;
    if (denom > 0) means.set(r.skill_name, r.sa / denom);
  }
  return means;
}


export function getSkillPrior(
  db: Database.Database,
  skillName: string,
  taskClass: string = '*',
): SkillPrior | null {
  const row = db.prepare<[string, string], {
    skill_name: string;
    task_class: string;
    alpha: number;
    beta: number;
    total_runs: number;
  } | undefined>(`
    SELECT skill_name, task_class, alpha, beta, total_runs
      FROM skill_priors
     WHERE skill_name = ? AND task_class = ?
  `).get(skillName, taskClass);
  if (!row) return null;
  return { ...row, mean: row.alpha / (row.alpha + row.beta) };
}
