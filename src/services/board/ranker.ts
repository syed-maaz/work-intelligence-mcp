/**
 * ADR-043 Phase 1 — Backlog ranker.
 *
 * Pure function producing a ranked list of open tasks with explicit per-signal
 * contributions. Used by:
 *   - GET /api/board/backlog (surface via /pm next / /pm backlog)
 *   - BoardWorkerAgent (via `pickTopReadyTaskForWorker` — future refactor)
 *
 * Formula (initial — tune from real observations, weights live here not in DB):
 *
 *   rank_score =
 *       priority                                           # 0..100
 *     - blocked_penalty       (999 if blocked=1 else 0)    # blocked sinks
 *     - deps_penalty          (100 × count_deps_not_done)  # unready deps sink
 *     + age_bonus             (min(30, days_since_created))# stale ready floats
 *     - effort_penalty        (effort_points × 0.5, or 0 when NULL)
 *
 * Invariant asserted by tests + smoke: sum(reasons[i].contribution) == rank_score
 * (within 0.01). This is AC-U2's teeth — the "why" is not a black box.
 *
 * Cross-refs:
 *   - docs/docs/adr/adr-043-pm-orchestration-layer.md § Decision → The ranker
 *   - src/db/migrations/v99_adr043_pm_layer.ts (schema)
 *   - tests/board/ranker.test.ts (invariants)
 */

import type Database from 'better-sqlite3';

// ── Types ─────────────────────────────────────────────────────────────────

export type BacklogSignal =
  | 'priority'
  | 'blocked_penalty'
  | 'deps_penalty'
  | 'age_bonus'
  | 'effort_penalty';

export interface BacklogReason {
  signal: BacklogSignal;
  /** The raw value observed (e.g. priority=90, days_since_created=5). */
  value: number;
  /** Weight applied to `value` to produce `contribution`. */
  weight: number;
  /** Signed contribution to rank_score (weight × value, signed per formula). */
  contribution: number;
}

export interface RankedTask {
  id: string;
  title: string;
  intent: 'brainstorm' | 'plan' | 'execute' | 'decide';
  kanban_column: 'ready' | 'in_progress' | 'review' | 'e2e' | 'done';
  priority: number;
  effort_points: number | null;
  blocked: 0 | 1;
  card_number: number | null;
  rank_score: number;
  reasons: BacklogReason[];
}

export interface BacklogResult {
  top_task_id: string | null;
  backlog: RankedTask[];
}

// ── Formula constants (exported for tests) ────────────────────────────────

export const WEIGHTS = {
  BLOCKED_PENALTY: 999,
  DEPS_PENALTY_PER_DEP: 100,
  AGE_BONUS_CAP_DAYS: 30,
  EFFORT_PENALTY_PER_POINT: 0.5,
} as const;

const MS_PER_DAY = 86_400_000;

// ── Row shape as read from DB ─────────────────────────────────────────────

interface TaskRow {
  id: string;
  title: string;
  intent: string;
  kanban_column: string;
  priority: number;
  effort_points: number | null;
  blocked: number;
  depends_on_json: string | null;
  created_at: number;
  card_number: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Count how many of the task's dependency IDs are NOT yet in `done`.
 * Missing dep rows count as "not done" — safer default.
 */
function countUnreadyDeps(db: Database.Database, depsJson: string | null): number {
  if (!depsJson) return 0;
  let deps: string[] = [];
  try {
    const parsed = JSON.parse(depsJson);
    if (Array.isArray(parsed)) deps = parsed.filter((x) => typeof x === 'string');
  } catch {
    return 0; // malformed → treat as no-deps (won't sink the card silently)
  }
  if (deps.length === 0) return 0;

  const placeholders = deps.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, kanban_column FROM tasks WHERE id IN (${placeholders})`,
    )
    .all(...deps) as Array<{ id: string; kanban_column: string }>;
  const doneCount = rows.filter((r) => r.kanban_column === 'done').length;
  // Missing rows count as unready.
  return deps.length - doneCount;
}

/**
 * Compute rank_score + reasons for a single row. Pure — no DB writes.
 * `nowMs` is injected for deterministic tests.
 */
function scoreTask(row: TaskRow, unreadyDepCount: number, nowMs: number): RankedTask {
  const reasons: BacklogReason[] = [];

  // 1. priority (base)
  const priorityValue = row.priority;
  reasons.push({
    signal: 'priority',
    value: priorityValue,
    weight: 1.0,
    contribution: priorityValue,
  });

  // 2. blocked_penalty
  const blockedValue = row.blocked === 1 ? 1 : 0;
  const blockedContribution = -WEIGHTS.BLOCKED_PENALTY * blockedValue;
  reasons.push({
    signal: 'blocked_penalty',
    value: blockedValue,
    weight: -WEIGHTS.BLOCKED_PENALTY,
    contribution: blockedContribution,
  });

  // 3. deps_penalty
  const depsContribution = -WEIGHTS.DEPS_PENALTY_PER_DEP * unreadyDepCount;
  reasons.push({
    signal: 'deps_penalty',
    value: unreadyDepCount,
    weight: -WEIGHTS.DEPS_PENALTY_PER_DEP,
    contribution: depsContribution,
  });

  // 4. age_bonus (capped at 30 days)
  const rawAgeDays = Math.max(0, (nowMs - row.created_at) / MS_PER_DAY);
  const ageValue = Math.min(WEIGHTS.AGE_BONUS_CAP_DAYS, rawAgeDays);
  reasons.push({
    signal: 'age_bonus',
    value: ageValue,
    weight: 1.0,
    contribution: ageValue,
  });

  // 5. effort_penalty (NULL effort → 0)
  const effortValue = row.effort_points ?? 0;
  const effortContribution = -WEIGHTS.EFFORT_PENALTY_PER_POINT * effortValue;
  reasons.push({
    signal: 'effort_penalty',
    value: effortValue,
    weight: -WEIGHTS.EFFORT_PENALTY_PER_POINT,
    contribution: effortContribution,
  });

  const rank_score = reasons.reduce((s, r) => s + r.contribution, 0);

  // Normalise -0 to 0 in all contribution fields (JS quirk — -0 * n == -0).
  // Only cosmetic in JSON output, but tests use `.toBe(0)` which distinguishes.
  for (const r of reasons) {
    if (Object.is(r.contribution, -0)) r.contribution = 0;
  }
  const normalisedScore = Object.is(rank_score, -0) ? 0 : rank_score;

  return {
    id: row.id,
    title: row.title,
    intent: row.intent as RankedTask['intent'],
    kanban_column: row.kanban_column as RankedTask['kanban_column'],
    priority: row.priority,
    effort_points: row.effort_points,
    blocked: (row.blocked === 1 ? 1 : 0) as 0 | 1,
    card_number: row.card_number,
    rank_score: normalisedScore,
    reasons,
  };
}

// ── Public API ────────────────────────────────────────────────────────────

export interface ComputeBacklogRankOpts {
  /** Now, in ms. Injected for deterministic tests. Defaults to Date.now(). */
  nowMs?: number;
  /** Max rows returned. Default 50. */
  limit?: number;
  /**
   * Filter by intent. Default: only 'execute' cards (matches
   * BoardWorkerAgent's pickup filter). Pass 'all' to include every intent
   * (used by `/pm backlog` to show brainstorm/plan cards too).
   */
  intent?: 'execute' | 'all';
  /**
   * Filter by column. Default 'ready' — the actionable backlog. Pass 'open'
   * to include ready + in_progress + review + e2e (everything not done).
   */
  scope?: 'ready' | 'open';
}

/**
 * Compute the ranked backlog. Read-only; safe to call any time.
 *
 * @returns `{ top_task_id, backlog: RankedTask[] }` with backlog sorted by
 *   rank_score desc, then created_at asc as tiebreak (older wins on ties).
 */
export function computeBacklogRank(
  db: Database.Database,
  opts: ComputeBacklogRankOpts = {},
): BacklogResult {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  const intentFilter = opts.intent ?? 'execute';
  const scopeFilter = opts.scope ?? 'ready';

  const whereClauses: string[] = [];
  const params: Array<string | number> = [];

  if (intentFilter === 'execute') {
    whereClauses.push(`intent = 'execute'`);
  }
  if (scopeFilter === 'ready') {
    whereClauses.push(`kanban_column = 'ready'`);
  } else {
    whereClauses.push(`kanban_column IN ('ready','in_progress','review','e2e')`);
  }
  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT id, title, intent, kanban_column, priority, effort_points,
              blocked, depends_on_json, created_at, card_number
         FROM tasks
         ${whereSql}
         ORDER BY created_at ASC`,
    )
    .all(...params) as TaskRow[];

  const ranked: RankedTask[] = rows.map((r) =>
    scoreTask(r, countUnreadyDeps(db, r.depends_on_json), nowMs),
  );

  ranked.sort((a, b) => {
    if (b.rank_score !== a.rank_score) return b.rank_score - a.rank_score;
    // Tie-break: prefer the older card (earlier created_at). The SELECT above
    // orders created_at ASC (oldest first) and Array.prototype.sort is stable,
    // so a rank_score tie preserves oldest-first — matching the ADR's
    // "stale ready cards float" intent + AC-S5 FIFO. (Fixed 2026-07-15: the
    // SELECT was DESC, which stably preserved NEWEST-first on ties — the exact
    // opposite of this contract. Found by the ADR-043 multi-agent audit; no
    // existing scenario constructed an exact rank_score tie so it slipped past
    // 17/17.)
    return 0;
  });

  const trimmed = ranked.slice(0, limit);
  return {
    top_task_id: trimmed[0]?.id ?? null,
    backlog: trimmed,
  };
}

// Test-only export — allows tests to score a synthetic row without hitting DB.
export const _testing = { scoreTask };
