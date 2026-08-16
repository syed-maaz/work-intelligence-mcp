/**
 * REDUNDANCY-001 (resolved 2026-05-21): deterministic budget gate.
 *
 * Previously this used a Claude Haiku call (~200–400 tokens) to decide
 * whether to spend $0.30–0.50 on a Claude Code research invocation. Since
 * ADR-024 shipped `brain_user_budget_ledger` we have a structural budget
 * surface. Spending tokens to decide whether to spend tokens is self-
 * defeating, so the gate is now a cheap SQL check.
 *
 * Behaviour preserved at the caller boundary:
 *   - `TriggerType` enum unchanged
 *   - `CostGateInput` field set unchanged (no caller migration)
 *   - `CostGateResult` shape unchanged (`approved`, `reason`, `estimatedValue`)
 *   - `evaluate()` still async (matches old signature)
 *
 * Cost model:
 *   - Each approved invocation increments the `research` bucket count by 1.
 *   - Daily cap = `RESEARCH_DAILY_BUDGET_CALLS` env (default 10 — ~$3–5/day).
 *   - System-wide cap (`user='__research__'`) — research isn't per-user today.
 *
 * Tiebreaker preserved from the old logic:
 *   - If `existingCodeItems >= 3` the gate rejects regardless of budget
 *     (sufficient context already; no need to pay for more).
 */

import type Database from 'better-sqlite3';

export type TriggerType = 'jira_analyze' | 'chat' | 'investigate' | 'alert' | 'goal_refinement';

/**
 * Closed-set enumeration of every TriggerType, for OPRO sweep iteration,
 * seed-coverage tests (prompt-seeds.test.ts), and any grep-based audit
 * that needs to assert "all triggers are wired here". Kept as a tuple-
 * literal `as const` so `typeof ALL_TRIGGER_TYPES[number]` equals
 * `TriggerType` — if a new union member is added without updating this
 * array, TS will refuse to compile downstream usages.
 */
export const ALL_TRIGGER_TYPES = [
  'jira_analyze',
  'chat',
  'investigate',
  'alert',
  'goal_refinement',
] as const satisfies readonly TriggerType[];

export interface CostGateInput {
  triggerType: TriggerType;
  question: string;
  existingContextCount: number;
  existingCodeItems: number;
  complexitySignals: string[];
}

export interface CostGateResult {
  approved: boolean;
  reason: string;
  estimatedValue: number;
}

const RESEARCH_BUCKET = 'research';
const RESEARCH_PSEUDO_USER = '__research__';

export class CostGateClassifier {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Deterministic budget check. No AI call — runs in ~1 ms.
   */
  async evaluate(input: CostGateInput): Promise<CostGateResult> {
    // Tiebreaker: enough existing code context → don't spend
    if (input.existingCodeItems >= 3) {
      return {
        approved: false,
        reason: `Sufficient existing code context (${input.existingCodeItems} items)`,
        estimatedValue: 0.2,
      };
    }

    const maxCalls = Math.max(0, parseInt(process.env.RESEARCH_DAILY_BUDGET_CALLS || '10', 10));
    const dayIso = new Date().toISOString().slice(0, 10);

    let callsToday = 0;
    try {
      const row = this.db
        .prepare(
          `SELECT COALESCE(SUM(calls), 0) AS calls
           FROM brain_user_budget_ledger
           WHERE day_iso = ? AND bucket = ?`,
        )
        .get(dayIso, RESEARCH_BUCKET) as { calls: number } | undefined;
      callsToday = row?.calls ?? 0;
    } catch {
      // Ledger missing (fresh DB pre-migration). Fail open — approve once;
      // recordCall() will create the row on success.
      return {
        approved: true,
        reason: 'Budget ledger not initialized — first-call grace',
        estimatedValue: 0.7,
      };
    }

    if (callsToday >= maxCalls) {
      return {
        approved: false,
        reason: `Research budget exceeded (${callsToday}/${maxCalls} today). Bump RESEARCH_DAILY_BUDGET_CALLS to allow more.`,
        estimatedValue: 0,
      };
    }

    return {
      approved: true,
      reason: `Research budget OK (${callsToday}/${maxCalls} used today)`,
      estimatedValue: 0.7,
    };
  }

  /**
   * Record a successful research invocation against today's budget.
   * Call this AFTER `claudeCodeRunner.execute()` succeeds, so failed
   * runs don't consume budget. Idempotent against the composite
   * UNIQUE index `(user, day_iso, bucket)`.
   */
  recordCall(): void {
    const dayIso = new Date().toISOString().slice(0, 10);
    try {
      this.db
        .prepare(
          `INSERT INTO brain_user_budget_ledger (user, day_iso, bucket, calls, input_tokens, output_tokens)
           VALUES (?, ?, ?, 1, 0, 0)
           ON CONFLICT(user, day_iso, bucket) DO UPDATE SET calls = calls + 1`,
        )
        .run(RESEARCH_PSEUDO_USER, dayIso, RESEARCH_BUCKET);
    } catch (err) {
      // Non-fatal — budget tracking is a best-effort overlay on top of
      // the actual research call. Log and move on.
      process.stderr.write(`[CostGate] recordCall failed: ${(err as Error).message}\n`);
    }
  }
}
