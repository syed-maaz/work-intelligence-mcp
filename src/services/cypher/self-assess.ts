/**
 * Cypher v2.5 D8 — self-model (selfAssess).
 *
 * Ratified by ADR-038 § D8 and the design doc at
 * `.planning/cypher/v2.5-D8-self-model-design.md` (Q-2.5 walk).
 *
 * `selfAssess(db, opts)` returns a Beta-posterior-derived confidence,
 * a recommendation tier, and supporting stats for a (goal, posture,
 * task_class, user) tuple. The aggregation is read-only: a single
 * indexed SQLite query per tier with first-non-empty-tier-wins
 * fallback (T0 → T1 → T2 → T3 uniform Beta(1,1)).
 *
 * Architecture:
 *
 *   loop dispatch entry (separate slice)
 *       ↓
 *   selfAssess(db, opts)         ← THIS MODULE
 *       ├─ query cypher_capability_summary (v72 view) at each tier
 *       ├─ compute Beta posterior (α=Beta(1,1)+α_obs, β=Beta(1,1)+β_obs)
 *       ├─ classify failure modes (heuristic over cypher_outcomes rows
 *       │   when failure_pattern is NULL — D2 curator's job in v2)
 *       └─ render recommendation tier per Q-2.5.4 decision tree
 *       ↓
 *   returns SelfAssessment — consumed by:
 *     - loop system prompt (pre-injection, separate slice)
 *     - cypher.self_assess model-tool (separate slice)
 *     - orchestrator D9 (when shipped)
 *
 * Hard rules (Q-2.5 design § Bridge MUST never be blocked):
 *   - Single SQLite read per tier (≤4 reads worst case), ≤10ms p95.
 *   - No model calls. No external service. No event-loop block.
 *   - Cache hits avoid even the SQL — 60s TTL on (plan_shape_hash,
 *     posture, task_class, user).
 *   - Half-credit accounting for mixed outcomes mirrors cap13-lite.ts.
 *
 * Cross-refs:
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D8
 *   - .planning/cypher/v2.5-D8-self-model-design.md § Q-2.5.1–Q-2.5.7
 *   - src/db/migrations/v70_cypher_outcomes_failure_pattern.ts
 *   - src/db/migrations/v71_cypher_sessions_posture.ts
 *   - src/db/migrations/v72_cypher_capability_summary_view.ts
 */

import type Database from 'better-sqlite3';

// ───────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────

// Posture is defined once in tool-catalog.ts (the loop's source of truth).
// Imported for local use AND re-exported so existing
// `import { Posture } from './self-assess.js'` callers keep working, and the
// two never drift (ADR-053 widened it to add 'architect' + 'pm-resume').
import type { Posture } from './tool-catalog.js';
export type { Posture };

export type RecommendationTier =
  | 'proceed'
  | 'proceed_with_caution'
  | 'escalate'           // reserved; not emitted in v1 (waits on D10)
  | 'decline';

export type SelfAssessTier = 'T0' | 'T1' | 'T2' | 'T3';

export interface SelfAssessment {
  confidence: number;              // posterior mean, 0..1
  tier_used: SelfAssessTier;
  n_similar_tasks: number;         // count at winning tier
  n_exact_shape: number;           // T0 count, even when winning tier is T1+
  recent_success_rate: number;     // last 10 at winning tier
  typical_iterations: number;      // avg from plan_shape_gap_observed when available; 0 fallback
  typical_cost_usd: number;        // avg from view's avg_tokens × heuristic rate
  failure_modes: string[];         // top-3 tags
  recommendation: RecommendationTier;
  note?: string;                   // e.g. "insufficient data (n=2 at T2)"
}

export interface SelfAssessOpts {
  goal: string;
  posture: Posture;
  user: string;
  plan_shape_hash?: string;        // optional — when omitted, T0 is skipped
  task_class: string;
}

// ───────────────────────────────────────────────────────────────────
// Config — env-tunable thresholds per Q-2.5.4
// ───────────────────────────────────────────────────────────────────

const DEFAULT_DECLINE_THRESHOLD = 0.3;
const DEFAULT_CAUTION_THRESHOLD = 0.5;
const DEFAULT_MIN_N = 5;

/** Read v1 thresholds from env at fire-time. Mirrors cap13-lite's
 *  per-call read (no module cache) so a mid-soak flip takes effect
 *  immediately. */
export interface SelfAssessConfig {
  declineThreshold: number;
  cautionThreshold: number;
  minN: number;
}

export function readSelfAssessConfig(env: NodeJS.ProcessEnv = process.env): SelfAssessConfig {
  const parseNum = (raw: string | undefined, def: number, clamp01 = false): number => {
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n)) return def;
    if (clamp01) {
      if (n < 0) return 0;
      if (n > 1) return 1;
    }
    return n;
  };
  const parseInt0 = (raw: string | undefined, def: number): number => {
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return def;
    return n;
  };
  return {
    declineThreshold: parseNum(env.D8_DECLINE_THRESHOLD, DEFAULT_DECLINE_THRESHOLD, true),
    cautionThreshold: parseNum(env.D8_CAUTION_THRESHOLD, DEFAULT_CAUTION_THRESHOLD, true),
    minN: parseInt0(env.D8_MIN_N, DEFAULT_MIN_N),
  };
}

// ───────────────────────────────────────────────────────────────────
// Failure-mode classifier (Q-2.5.3 heuristic)
// ───────────────────────────────────────────────────────────────────

const MAX_ITER = 30;  // matches loop.ts iteration cap; iteration_cap heuristic
const TIMEOUT_MS = 600_000;  // 10 min — matches CODE_GRAPH_INDEX_TIMEOUT_MS pattern

export interface ClassifyFailureRow {
  outcome: string | null;
  outcome_note: string | null;
  duration_ms: number | null;
  iterations: number | null;
}

/**
 * Map a cypher_sessions row to a coarse failure-mode tag. Called at
 * verdict-write time by the loop (separate slice) and on-the-fly by
 * `selfAssess()` when reading historical rows that have
 * `cypher_outcomes.failure_pattern IS NULL`. When D2 (curator) ships,
 * it writes to the same column and this heuristic stays as the
 * fallback for outcomes the curator hasn't seen yet.
 *
 * Returns null when the row is not a 'failed' outcome.
 */
export function classifyFailure(row: ClassifyFailureRow): string | null {
  if (row.outcome !== 'failed') return null;

  const note = (row.outcome_note ?? '').toLowerCase();

  if (/\bbudget\b/.test(note)) return 'budget_exhaustion';
  if (/\btimeout\b/.test(note)) return 'timeout';
  if (typeof row.duration_ms === 'number' && row.duration_ms > TIMEOUT_MS) return 'timeout';
  if (typeof row.iterations === 'number' && row.iterations >= MAX_ITER) return 'iteration_cap';
  if (/\bhalted\b/.test(note) || /\buser stopped\b/.test(note)) return 'user_halt';

  return 'unknown_failure';
}

// ───────────────────────────────────────────────────────────────────
// Aggregation
// ───────────────────────────────────────────────────────────────────

interface TierAgg {
  alpha: number;        // includes Beta(1,1) prior contribution
  beta: number;
  n: number;            // real observations (excludes prior)
  recent_rate: number;  // success rate over last 10 ordered by created_at DESC
  avg_duration_ms: number;
  avg_tokens: number;
  avg_iterations: number;
  failures: { pattern: string; n: number }[];
}

/**
 * Aggregate cypher_outcomes verdict signals + cypher_sessions for a
 * given tier WHERE clause. Returns the tier's α/β + ancillary stats.
 * Caller decides whether to use this tier or fall through.
 */
function aggregateTier(
  db: Database.Database,
  tierWhere: string,
  tierParams: unknown[],
): TierAgg {
  // n / alpha / beta + averages from cypher_capability_summary view
  // (v72). The view's GROUP BY is per (posture, task_class, user,
  // plan_shape_hash); we re-aggregate across plan_shape_hash for tier
  // T1+ by summing the wide rows.
  const sumRow = db.prepare(`
    SELECT
      COALESCE(SUM(n_outcomes), 0)    AS n,
      COALESCE(SUM(alpha_delta), 0)   AS alpha_obs,
      COALESCE(SUM(beta_delta), 0)    AS beta_obs,
      AVG(avg_duration_ms)            AS avg_duration_ms,
      AVG(avg_tokens)                 AS avg_tokens
    FROM cypher_capability_summary
    WHERE ${tierWhere}
  `).get(...tierParams) as {
    n: number;
    alpha_obs: number;
    beta_obs: number;
    avg_duration_ms: number | null;
    avg_tokens: number | null;
  };

  const n = Number(sumRow.n) || 0;
  const alphaObs = Number(sumRow.alpha_obs) || 0;
  const betaObs = Number(sumRow.beta_obs) || 0;

  // Recent-10 success rate — pull session-level outcomes ordered by
  // started_at DESC, limit 10. We read s.outcome (TEXT 'success' |
  // 'mixed' | 'failed') NOT cypher_outcomes.value (REAL — those are
  // the Beta-prior numeric signals from outcomes.ts:35–37, not the
  // human-readable verdict).
  const recentRows = db.prepare(`
    SELECT s.outcome AS outcome
      FROM cypher_sessions s
     WHERE s.engine = 'loop'
       AND s.posture IS NOT NULL
       AND s.outcome IS NOT NULL
       AND ${tierWhere.replace(/\bn_outcomes\b/g, '1')}
     ORDER BY s.started_at DESC
     LIMIT 10
  `).all(...tierParams) as { outcome: string }[];

  let recentSucc = 0;
  for (const r of recentRows) {
    if (r.outcome === 'success') recentSucc += 1;
    else if (r.outcome === 'mixed') recentSucc += 0.5;
  }
  const recent_rate = recentRows.length > 0 ? recentSucc / recentRows.length : 0;

  // Failure-mode tally — top-3 patterns at this tier. Reads
  // cypher_outcomes.failure_pattern (v70 column) when present; falls
  // through to the heuristic in classifyFailure() when null.
  const failRows = db.prepare(`
    SELECT
      o.failure_pattern AS pattern,
      s.outcome_note    AS note,
      s.duration_ms     AS duration_ms,
      s.outcome         AS outcome
      FROM cypher_sessions s
      LEFT JOIN cypher_outcomes o
        ON o.session_id = s.session_id
       AND o.signal_kind = 'verdict'
     WHERE s.engine = 'loop'
       AND s.posture IS NOT NULL
       AND s.outcome = 'failed'
       AND ${tierWhere.replace(/\bn_outcomes\b/g, '1')}
  `).all(...tierParams) as {
    pattern: string | null;
    note: string | null;
    duration_ms: number | null;
    outcome: string | null;
  }[];

  const tally = new Map<string, number>();
  for (const r of failRows) {
    let tag = r.pattern;
    if (!tag) {
      // Historical row — apply heuristic on the fly.
      tag = classifyFailure({
        outcome: 'failed',
        outcome_note: r.note,
        duration_ms: r.duration_ms,
        iterations: null,  // sessions.iterations doesn't exist; null punts iteration_cap branch
      });
    }
    if (!tag) continue;
    tally.set(tag, (tally.get(tag) ?? 0) + 1);
  }
  const failures = [...tally.entries()]
    .map(([pattern, n]) => ({ pattern, n }))
    .sort((a, b) => b.n - a.n);

  return {
    alpha: 1 + alphaObs,                 // Beta(1,1) uniform prior
    beta: 1 + betaObs,
    n,
    recent_rate,
    avg_duration_ms: Number(sumRow.avg_duration_ms) || 0,
    avg_tokens: Number(sumRow.avg_tokens) || 0,
    avg_iterations: 0,                   // cypher_sessions has no iterations col;
                                         // v2 may pull from plan_shape_gap_observed.iterations
    failures,
  };
}

// ───────────────────────────────────────────────────────────────────
// Recommendation tree (Q-2.5.4)
// ───────────────────────────────────────────────────────────────────

const COSTLY_TAGS = new Set(['budget_exhaustion', 'timeout']);

function recommendFromAgg(
  agg: TierAgg,
  cfg: SelfAssessConfig,
): { recommendation: RecommendationTier; note?: string } {
  const mean = agg.alpha / (agg.alpha + agg.beta);

  if (agg.n < cfg.minN) {
    return {
      recommendation: 'proceed',
      note: `insufficient data (n=${agg.n})`,
    };
  }

  if (mean < cfg.declineThreshold) {
    return { recommendation: 'decline' };
  }

  if (mean < cfg.cautionThreshold) {
    return { recommendation: 'proceed_with_caution' };
  }

  // Costly-failure override — even when mean is OK, surface caution.
  for (const f of agg.failures) {
    if (COSTLY_TAGS.has(f.pattern)) {
      return { recommendation: 'proceed_with_caution' };
    }
  }

  return { recommendation: 'proceed' };
}

// ───────────────────────────────────────────────────────────────────
// Cache (60s TTL on (plan_shape_hash, posture, task_class, user))
// ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  ts: number;
  value: SelfAssessment;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(opts: SelfAssessOpts): string {
  return `${opts.plan_shape_hash ?? ''}|${opts.posture}|${opts.task_class}|${opts.user}`;
}

/** Test-only — drops the in-memory cache. */
export function _resetSelfAssessCache(): void {
  cache.clear();
}

// ───────────────────────────────────────────────────────────────────
// Main entry
// ───────────────────────────────────────────────────────────────────

const COST_PER_TOKEN_USD = 0.000005;  // Sonnet 4.6 input-equiv heuristic;
                                       // refined when bucket-aware costing lands

/**
 * Read-only aggregation. Tier walk: T0 (exact plan_shape_hash + user) →
 * T1 ((posture, task_class, user)) → T2 ((posture, user)) →
 * T3 (uniform Beta(1,1)). First tier with n_outcomes > 0 wins.
 * 60s cache on the input opts tuple.
 */
export function selfAssess(
  db: Database.Database,
  opts: SelfAssessOpts,
): SelfAssessment {
  const cfg = readSelfAssessConfig();
  const now = Date.now();

  const key = cacheKey(opts);
  const cached = cache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }

  // T0 — exact plan_shape_hash + user.
  let tier_used: SelfAssessTier = 'T3';
  let agg: TierAgg | null = null;
  let n_exact_shape = 0;

  if (opts.plan_shape_hash) {
    const t0 = aggregateTier(
      db,
      `plan_shape_hash = ? AND user = ?`,
      [opts.plan_shape_hash, opts.user],
    );
    n_exact_shape = t0.n;
    if (t0.n > 0) {
      tier_used = 'T0';
      agg = t0;
    }
  }

  // T1 — (posture, task_class, user).
  if (!agg) {
    const t1 = aggregateTier(
      db,
      `posture = ? AND task_class = ? AND user = ?`,
      [opts.posture, opts.task_class, opts.user],
    );
    if (t1.n > 0) {
      tier_used = 'T1';
      agg = t1;
    }
  }

  // T2 — (posture, user).
  if (!agg) {
    const t2 = aggregateTier(
      db,
      `posture = ? AND user = ?`,
      [opts.posture, opts.user],
    );
    if (t2.n > 0) {
      tier_used = 'T2';
      agg = t2;
    }
  }

  // T3 — uniform Beta(1,1).
  if (!agg) {
    tier_used = 'T3';
    agg = {
      alpha: 1,
      beta: 1,
      n: 0,
      recent_rate: 0,
      avg_duration_ms: 0,
      avg_tokens: 0,
      avg_iterations: 0,
      failures: [],
    };
  }

  const confidence = agg.alpha / (agg.alpha + agg.beta);
  const top3 = agg.failures.slice(0, 3).map(f => f.pattern);
  const { recommendation, note } = recommendFromAgg(agg, cfg);

  const assessment: SelfAssessment = {
    confidence,
    tier_used,
    n_similar_tasks: agg.n,
    n_exact_shape,
    recent_success_rate: agg.recent_rate,
    typical_iterations: agg.avg_iterations,
    typical_cost_usd: agg.avg_tokens * COST_PER_TOKEN_USD,
    failure_modes: tier_used === 'T3' ? [] : top3,
    recommendation,
    ...(note ? { note } : {}),
  };

  cache.set(key, { ts: now, value: assessment });
  return assessment;
}
