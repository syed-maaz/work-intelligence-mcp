/**
 * CAP-13-LITE — plan-shape gap recognition (2026-06-24).
 *
 * Ratified by ADR-037.5 v2. The recognition step of α-LITE: when a
 * loop dispatch completes against a plan_shape_hash whose historical
 * posterior shows poor success (`prior_count >= 5 AND
 * prior_success_rate < 0.3`), this module records one row in
 * `plan_shape_gap_observed`. No drafter, no LLM call, no proposal
 * lifecycle — pure observation. α-FULL (drafter + lifecycle) is
 * deferred indefinitely; the trigger to un-defer is documented in
 * ADR-037.5 v2 § Decision D2.
 *
 * Architecture:
 *
 *   loop.ts post-loop write (commit e18f1d4)
 *       ↓
 *   updates cypher_sessions.{plan_shape_hash, prior_count, prior_success_rate}
 *       ↓
 *   (this module) recognition hook
 *       ↓
 *   if (gate predicates pass) → INSERT plan_shape_gap_observed
 *
 * The hook is opportunistic: every part of this module's surface is
 * wrapped in try/catch at the call site so a write failure (FS full,
 * FK violation, concurrent-write race) never crashes the loop.
 *
 * Hard rules (PRD ACs H-08, H-09, H-10):
 *   - Single SQL INSERT, no other I/O.
 *   - No model call. No external service. No event-loop block.
 *   - Idempotent on (session_id, plan_shape_hash) via the table's UNIQUE
 *     constraint; INSERT OR IGNORE swallows the rare double-fire.
 *   - Smoke-probe filter (LIKE-based) is acknowledged fragile-v1 per
 *     audit F6; future hardening: a dedicated is_smoke_probe column on
 *     cypher_sessions populated at dispatch entry.
 *
 * Cross-refs:
 *   - docs/docs/adr/adr-037-5-cap13-skill-self-extension.md § D1-D7
 *   - .planning/cap-13-alpha-lite/PRD.md § Recognition hook (H)
 *   - src/services/cypher/loop.ts — the caller
 *   - src/db/migrations/v69_plan_shape_gap_observed.ts — the schema
 */

import type Database from 'better-sqlite3';

/** Default threshold below which the recognition gate fires. PRD V-02. */
const DEFAULT_GAP_THRESHOLD = 0.3;

/** Default minimum prior_count required for the gate. PRD V-03. */
const DEFAULT_MIN_PRIORS_RUNS = 5;

/** Max length of the `goal` text stored in plan_shape_gap_observed. PRD H-12 / P-01. */
const GOAL_MAX_LEN = 500;

/**
 * Read CAP-13-LITE config from env at fire-time. PRD V-04 (per-fire
 * read, no module cache) + V-02/V-03 (clamp + parse fallbacks).
 */
export interface Cap13LiteConfig {
  enabled: boolean;
  threshold: number;
  minRuns: number;
}

export function readCap13Config(): Cap13LiteConfig {
  // PRD H-07 / V-01: env var presence-only check; default ON.
  const enabled = process.env.CAP13_LITE_ENABLED !== '0';

  // PRD V-02: threshold clamp. Non-numeric / out-of-range → default.
  let threshold = DEFAULT_GAP_THRESHOLD;
  const tRaw = process.env.CAP13_GAP_THRESHOLD;
  if (tRaw !== undefined && tRaw !== '') {
    const t = Number(tRaw);
    if (Number.isFinite(t)) {
      if (t < 0) threshold = 0;
      else if (t > 1) threshold = 1;
      else threshold = t;
    }
  }

  // PRD V-03: min-runs clamp. Non-integer / negative → default.
  let minRuns = DEFAULT_MIN_PRIORS_RUNS;
  const rRaw = process.env.CAP13_MIN_PRIORS_RUNS;
  if (rRaw !== undefined && rRaw !== '') {
    const r = Number(rRaw);
    if (Number.isInteger(r) && r >= 0) {
      minRuns = r;
    }
  }

  return { enabled, threshold, minRuns };
}

/**
 * PRD AC H-04. Single-tenant smoke-user filter.
 * Case-sensitive — production users have proper names, not 'smoke'.
 */
export function isSmokeUser(user: string): boolean {
  return user === 'smoke' || user === 'system';
}

/**
 * PRD AC H-05. Smoke-probe filter via case-insensitive substring.
 * Acknowledged fragile per audit F6 — replace with a column-based
 * filter (cypher_sessions.is_smoke_probe) in α-LITE v2 if pollution
 * shows up in the corpus.
 */
const SMOKE_PROBE_RE = /smoke|probe|sanity|phase 5 day-0/i;
export function isSmokeProbe(goal: string): boolean {
  return SMOKE_PROBE_RE.test(goal);
}

/**
 * Context object for one recognition write. Constructed by the caller
 * (loop.ts) from data already in scope at the post-loop UPDATE point.
 * No additional DB reads here — the caller has everything.
 */
export interface PlanShapeGapContext {
  session_id: string;
  plan_shape_hash: string;
  posture: string;
  /** Already JSON.stringify'd by the caller. PRD H-13: no double-serialization. */
  tool_sequence_json: string;
  goal: string;
  user: string;
  prior_count: number;
  prior_success_rate: number;
  iterations: number;
  verdict: string;
}

/**
 * PRD AC H-02 / H-03. Insert one row, idempotent on
 * `(session_id, plan_shape_hash)` via the table's UNIQUE constraint.
 *
 * NOTE: this function does NOT check the gate predicate. The caller
 * (loop.ts) is responsible for that — keeping the gate logic close
 * to its data lets the caller short-circuit before computing
 * tool_sequence_json on the not-firing path (PRD H-15).
 *
 * Truncates `goal` to 500 chars at write-time (PRD H-12 / P-01).
 */
export function recordPlanShapeGap(
  db: Database.Database,
  ctx: PlanShapeGapContext,
): void {
  const goalTrunc = ctx.goal.length > GOAL_MAX_LEN
    ? ctx.goal.slice(0, GOAL_MAX_LEN)
    : ctx.goal;

  db.prepare(`
    INSERT OR IGNORE INTO plan_shape_gap_observed
      (session_id, plan_shape_hash, posture, tool_sequence_json,
       goal, user, prior_count, prior_success_rate, iterations, verdict)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ctx.session_id,
    ctx.plan_shape_hash,
    ctx.posture,
    ctx.tool_sequence_json,
    goalTrunc,
    ctx.user,
    ctx.prior_count,
    ctx.prior_success_rate,
    ctx.iterations,
    ctx.verdict,
  );
}

/**
 * Combined gate predicate. Returns true iff all of:
 *   - CAP13_LITE_ENABLED !== '0' (PRD H-08 step 1)
 *   - prior_count >= minRuns (step 2)
 *   - prior_success_rate is non-null (step 3)
 *   - prior_success_rate < threshold (step 4)
 *   - !isSmokeUser(user) (step 5)
 *   - !isSmokeProbe(goal) (step 6)
 *
 * Short-circuits on the cheapest checks first so disabled / non-smoke /
 * empty-history paths never look at config or strings.
 *
 * Acceptance of PRD H-08 ordering: env first (cheapest exit when
 * disabled), then prior signal (already in scope), then string
 * filters (most expensive checks).
 */
export function shouldRecognizeGap(
  user: string,
  goal: string,
  prior_count: number,
  prior_success_rate: number | null,
  config: Cap13LiteConfig,
): boolean {
  if (!config.enabled) return false;
  if (prior_count < config.minRuns) return false;
  if (prior_success_rate === null) return false;
  if (prior_success_rate >= config.threshold) return false;
  if (isSmokeUser(user)) return false;
  if (isSmokeProbe(goal)) return false;
  return true;
}
