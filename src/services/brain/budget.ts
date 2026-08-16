/**
 * Per-user daily budget cap (T-69-01 mitigation, Phase 69-05).
 *
 * Enforces a daily ceiling on Claude calls + input tokens per user to bound
 * cost runaway on /api/brain/decide. Consulted by `runDecision` BEFORE every
 * cache-miss invocation of `brainToolCall`; updated AFTER a successful call.
 *
 * The `dayIsoUtc` argument MUST be the same UTC day used to derive `cache_key`
 * (`new Date().toISOString().slice(0,10)`). Local-day budgeting would let a
 * user near UTC midnight bypass the cap by rolling into "tomorrow" while the
 * cache row stays on today.
 *
 * Limits read from env (`BRAIN_USER_DAILY_CALLS`, `BRAIN_USER_DAILY_INPUT_TOKENS`)
 * with the documented defaults (50 calls / 200k input tokens per user per day).
 */

import type Database from 'better-sqlite3';

export const BUDGET_DEFAULT_CALLS = 50;
export const BUDGET_DEFAULT_INPUT_TOKENS = 200_000;

export interface BudgetLimits {
  maxCallsPerUserPerDay: number;
  maxInputTokensPerUserPerDay: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  callsToday: number;
  tokensToday: number;
  remainingCalls: number;
  remainingTokens: number;
  reason?: 'calls_exceeded' | 'tokens_exceeded';
}

export class BudgetExceededError extends Error {
  reason: 'calls_exceeded' | 'tokens_exceeded';
  remainingCalls: number;
  remainingTokens: number;
  callsToday: number;
  tokensToday: number;
  constructor(result: BudgetCheckResult) {
    super(`brain daily budget exceeded: ${result.reason}`);
    this.name = 'BudgetExceededError';
    this.reason = result.reason ?? 'calls_exceeded';
    this.remainingCalls = result.remainingCalls;
    this.remainingTokens = result.remainingTokens;
    this.callsToday = result.callsToday;
    this.tokensToday = result.tokensToday;
  }
}

function readLimits(override?: BudgetLimits): BudgetLimits {
  if (override) return override;
  const calls = parseInt(process.env.BRAIN_USER_DAILY_CALLS || '', 10);
  const tokens = parseInt(process.env.BRAIN_USER_DAILY_INPUT_TOKENS || '', 10);
  return {
    maxCallsPerUserPerDay: Number.isFinite(calls) && calls > 0 ? calls : BUDGET_DEFAULT_CALLS,
    maxInputTokensPerUserPerDay:
      Number.isFinite(tokens) && tokens > 0 ? tokens : BUDGET_DEFAULT_INPUT_TOKENS,
  };
}

interface LedgerRow {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Idempotent guard: ensures `brain_user_budget_ledger` exists with the
 * Phase 72 / schema v46 shape (composite PK on `(user, day_iso, bucket)`).
 *
 * History: Phase 69-05 self-healed an earlier 2-column PK shape; Phase 72
 * added the `bucket` column via migration v46 to track tool-call budget
 * separately from brain budget. Because SQLite cannot retroactively change
 * a PRIMARY KEY in place, the v46 migration is brittle on partially-
 * migrated DBs where the v45 self-heal ran first with the old PK shape.
 *
 * This rewrite of `ensureLedger` creates the table directly in the v46
 * shape if it does not exist, so:
 *   • Fresh DB → table starts correct, v46 migration is a no-op.
 *   • DB at v45 with old 2-col PK → kept as-is, v46 migration ADDs `bucket`
 *     column + composite index `(user, day_iso, bucket)` for query speed.
 *     The old `(user, day_iso)` PK remains (incompatible with bucket-aware
 *     `ON CONFLICT`) — see migration v46 for the rebuild-table path.
 *   • DB at v46 → no-op.
 *
 * The `ledgerEnsured` flag is module-scoped; deliberate — same process,
 * same DB connection lifetime. Tests that recreate the DB inside a single
 * process should call `resetLedgerEnsured()` for hygiene.
 */
let ledgerEnsured = false;

export function resetLedgerEnsured(): void {
  ledgerEnsured = false;
}

function ensureLedger(db: Database.Database): void {
  if (ledgerEnsured) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_user_budget_ledger (
      user TEXT NOT NULL,
      day_iso TEXT NOT NULL,
      bucket TEXT NOT NULL DEFAULT 'brain',
      calls INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user, day_iso, bucket)
    );
    CREATE INDEX IF NOT EXISTS idx_brain_budget_ledger_user_day
      ON brain_user_budget_ledger(user, day_iso);
  `);
  ledgerEnsured = true;
}

export function checkDailyBudget(args: {
  db: Database.Database;
  user: string;
  dayIsoUtc: string;
  limits?: BudgetLimits;
  bucket?: string;
}): BudgetCheckResult {
  ensureLedger(args.db);
  const limits = readLimits(args.limits);
  const bucket = args.bucket ?? 'brain';
  const row = args.db
    .prepare(
      `SELECT calls, input_tokens, output_tokens
       FROM brain_user_budget_ledger
       WHERE user = ? AND day_iso = ? AND bucket = ?`,
    )
    .get(args.user, args.dayIsoUtc, bucket) as LedgerRow | undefined;

  const callsToday = row?.calls ?? 0;
  const tokensToday = row?.input_tokens ?? 0;
  const remainingCalls = Math.max(0, limits.maxCallsPerUserPerDay - callsToday);
  const remainingTokens = Math.max(0, limits.maxInputTokensPerUserPerDay - tokensToday);

  if (callsToday >= limits.maxCallsPerUserPerDay) {
    return {
      allowed: false,
      callsToday,
      tokensToday,
      remainingCalls,
      remainingTokens,
      reason: 'calls_exceeded',
    };
  }
  if (tokensToday >= limits.maxInputTokensPerUserPerDay) {
    return {
      allowed: false,
      callsToday,
      tokensToday,
      remainingCalls,
      remainingTokens,
      reason: 'tokens_exceeded',
    };
  }
  return { allowed: true, callsToday, tokensToday, remainingCalls, remainingTokens };
}

export function recordSpend(args: {
  db: Database.Database;
  user: string;
  dayIsoUtc: string;
  inputTokens: number;
  outputTokens: number;
  bucket?: string;
}): void {
  ensureLedger(args.db);
  const bucket = args.bucket ?? 'brain';
  args.db
    .prepare(
      `INSERT INTO brain_user_budget_ledger (user, day_iso, bucket, calls, input_tokens, output_tokens)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(user, day_iso, bucket) DO UPDATE SET
         calls = calls + 1,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens`,
    )
    .run(args.user, args.dayIsoUtc, bucket, args.inputTokens | 0, args.outputTokens | 0);
}
