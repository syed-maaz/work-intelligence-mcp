/**
 * src/services/cypher/loop.ts — ADR-037 Phase 3-C/D loop controller.
 *
 * The production tool-use loop that supersedes the 9-stage pipeline in
 * `run.ts`. Default-off behind `CYPHER_LOOP_ENABLED=0` until Phase 6
 * cutover. Wired into `/api/wi/dispatch/stream` in Phase 4; consumed by
 * the production catalog (`tool-catalog.ts`) landed in Phase 2.
 *
 * **Phase 3-D scope (this file, current commit).** The full body: types
 * + Anthropic tool-use loop + Plan-Confirm-Act control flow (D15) +
 * free-text classifier (D16 / Q-1.11) + halt-flag semantics
 * (D17 / Q-1.12) + budget guards (token + wallclock + iteration) +
 * outcome writeback to cypher_outcomes via recordOutcomeSignal.
 *
 * The shape mirrors the Phase 1 spike (`scripts/spike-cypher-loop.ts`,
 * on `cypher-loop-spike` branch) which was the architectural derisking
 * exercise. The spike's `run()` function is the ancestor of `runLoop`
 * here, with three Phase 3-D additions over the spike:
 *
 *   1. Plan-Confirm-Act wrapper around the bare D1 loop. Three exit
 *      paths from `propose_plan` per D15: Phase 1 (cold-start, full
 *      confirm), Phase 2-soft (warm priors, veto window), and
 *      rejected_non_interactive (non-TTY + confirm_mode!='auto').
 *      Phase 2-hard (silent execute, no plan render) is rejected by
 *      v2.0 scope per the execution plan. Phase 3-D ships the loop
 *      body in Phase-2-soft equivalence — Phase 4 wires the planner +
 *      classifier into actual user-facing confirm prompts; Phase 3-D
 *      defaults to confirm_mode='auto' equivalence (no plan render,
 *      no wait) so the loop is testable without an SSE round-trip.
 *
 *   2. Halt-flag semantics per D17 / Q-1.12. The bridge sets a single
 *      `halt_requested: bool` on the dispatch context; the loop checks
 *      it at exactly two points — at the top of each iteration, and
 *      before issuing the next tool call. `/stop` during an in-flight
 *      tool call lets the call complete normally, then exits at the
 *      next iteration boundary with `verdict='halted'` and
 *      `halt_after_call_id=<id>`.
 *
 *   3. Outcome writeback to the v67 schema columns. The loop writes a
 *      `verdict` signal row to `cypher_outcomes` (NOT to
 *      `cypher_sessions.outcome` — the wider enum requires the v68
 *      CHECK widening that's deferred per v67's docblock). Verdicts
 *      use the six-token contract from ADR-037 D14 / D19: `success`,
 *      `mixed`, `failed`, `halted`, `abandoned`, `rejected_non_interactive`.
 *
 * Cross-references:
 *   - ADR-037 D1, D14-D21 (`docs/docs/adr/adr-037-cypher-tool-use-loop.md`)
 *   - Execution plan § 3 (`.planning/cypher/11-ADR-037-EXECUTION-PLAN.md`)
 *   - v2.0 PRD § 6 (`docs/docs/prd/cypher-v2.0.md`)
 *   - Phase 1 spike learnings (`.planning/cypher/14-SPIKE-LEARNINGS.md`)
 *   - Tool catalog (`src/services/cypher/tool-catalog.ts`)
 *   - Outcome writer (`src/services/cypher/outcomes.ts` —
 *     `recordOutcomeSignal`, `VERDICT_SUCCESS` / `VERDICT_MIXED` /
 *     `VERDICT_FAILED` constants for the value field)
 *   - Schema v67 columns (`src/db/migrations/v67_cypher_loop_columns.ts`)
 */

import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

import type { PalaceClient } from '../../intelligence/palace-client.js';
import { bucketCallParams, type Bucket } from '../model-config.js';
import { computeCost } from '../analyzer.js';
import { recordTokenUsage } from '../../db/queries/system.js';
import {
  recordOutcomeSignal,
  VERDICT_SUCCESS,
  VERDICT_MIXED,
  VERDICT_FAILED,
} from './outcomes.js';
import { draftAcceptanceText } from './session-close.js';
import { classifyFailure, selfAssess } from './self-assess.js';
import { suggestAutoLinks } from './auto-link.js';
import { autoLinkOnDispatch } from './pm-auto.js';
import {
  loadTaskContext,
  recordTaskDispatch,
  updateTaskDispatchOutcome,
  renderTaskContextBlock,
  curateTaskContext,
} from './task-memory.js';
import type { Posture, ToolDefinition } from './tool-catalog.js';
import {
  toolsForPosture as catalogToolsForPosture,
  effectiveRiskTier,
  isToolParallelizable,
  getCatalogForPhase,
  getCatalogHint,
} from './tool-catalog.js';
import { findActiveMatch, recordPermissionUse } from './permissions.js';
import { checkBoundary } from './boundary.js';
import { validateRefinedGoal } from './refined-goal-schema.js';
import {
  readCap13Config,
  recordPlanShapeGap,
  shouldRecognizeGap,
} from './cap13-lite.js';
import { writeHeartbeat } from './heartbeat.js';

// ---------------------------------------------------------------------------
// Controller-model routing by task_class
// ---------------------------------------------------------------------------

/**
 * task_class values that route the loop controller to the Sonnet-backed
 * `dispatch` bucket. These are routine retrieval/synthesis goals — fetch a
 * PR and summarize it, look something up, review a diff — where Sonnet 4.6's
 * speed/cost balance is the right call and Opus/max is overkill (and slow).
 *
 * Anything NOT in this set — including `generic`, `build-feature`, `debug`,
 * `plan`, `design`, and any write-class dispatch — falls through to the
 * Opus-backed `decide` bucket. The default is deliberately conservative:
 * we never silently downgrade a possibly-hard reasoning task to Sonnet.
 */
const DISPATCH_TASK_CLASSES = new Set<string>([
  'dispatch',
  'fetch',
  'fetch-summarize',
  'summarize',
  'review',
  'lookup',
  'search',
]);

/**
 * Picks the model-config bucket for the loop controller based on task_class.
 * @returns `'dispatch'` (Sonnet/medium) for routine goals, else `'decide'` (Opus/max).
 */
export const pickControllerBucket = (taskClass?: string): Bucket =>
  taskClass && DISPATCH_TASK_CLASSES.has(taskClass) ? 'dispatch' : 'decide';

/**
 * Per-call timeout (ms) applied to every Anthropic `messages.create` in the
 * loop (SCOPE refiner + EXECUTE controller). The Anthropic SDK aborts the
 * socket when no response arrives within this window — a TRUE deadline that
 * bounds a single stalled call, which the between-iterations wall-clock guard
 * cannot do (it only checks at the top of each iteration; a call hung inside
 * the `await` never returns control to it — see cyp_29a1fd1dc480, 2026-07-10).
 *
 * Default 90_000. MUST stay below the SCOPE wall-clock budget
 * (CYPHER_SCOPE_MAX_WALLCLOCK_MS, default 60_000) so a single call can't
 * outlive the phase guard. Pass `budgetRemainingMs` (the ms left in the
 * current phase's wall-clock budget) and the returned timeout is clamped to
 * strictly below it minus BUDGET_GUARD_MARGIN_MS — so the per-call SDK abort
 * always fires BEFORE the between-iterations guard would, never after. Without
 * this clamp the 90s default silently outlived the 60s SCOPE budget and let a
 * single stalled refiner call overrun the phase to 130s+ (cyp_b29a0e6f4870,
 * 2026-07-15). Set the env var to 0 to disable (falls back to the SDK's own
 * 10-minute default — still clamped by budget when one is passed).
 * @returns the effective per-call timeout in ms (0 = unbounded)
 */
export const llmCallTimeoutMs = (budgetRemainingMs?: number): number => {
  const raw = Number(process.env.CYPHER_LLM_CALL_TIMEOUT_MS ?? 90_000);
  const configured = Number.isFinite(raw) && raw > 0 ? raw : 90_000;
  return clampToBudget(configured, budgetRemainingMs);
};

/**
 * Per-call timeout (ms) for a single Cypher tool handler. Tool handlers run
 * OUR code (not the Anthropic SDK), so the SDK `timeout` option can't bound
 * them — a handler that does a live browser scrape (e.g. `search_all` →
 * Outlook, a known 3+ min hanger) blocks the loop inside its `await` and the
 * between-iterations wall-clock guard never regains control. Default 120_000.
 * Pass `budgetRemainingMs` to clamp to the current phase budget (same rule as
 * llmCallTimeoutMs) so a scope-eligible tool dispatch can't outlive the phase
 * guard either — the 120s default was 2x the 60s SCOPE budget. Set to 0 to
 * disable (unbounded — restores the hang symptom, still budget-clamped when a
 * budget is passed).
 * @returns the effective per-call tool timeout in ms (0 = unbounded)
 */
export const toolCallTimeoutMs = (budgetRemainingMs?: number): number => {
  const raw = Number(process.env.CYPHER_TOOL_TIMEOUT_MS ?? 120_000);
  const configured = Number.isFinite(raw) && raw >= 0 ? raw : 120_000;
  return clampToBudget(configured, budgetRemainingMs);
};

/**
 * Safety margin (ms) subtracted from the remaining phase budget when clamping
 * a per-call timeout. Ensures the SDK/tool abort fires strictly BEFORE the
 * between-iterations wall-clock guard, leaving room for the catch + persist
 * path to run inside the budget. 2s is comfortably above the persist cost.
 */
const BUDGET_GUARD_MARGIN_MS = 2_000;

/**
 * Clamps a configured per-call timeout to the remaining phase wall-clock
 * budget. Returns the smaller of `configured` and `budgetRemainingMs - margin`.
 * When no budget is passed (EXECUTE phase with a 10-min budget where the 90s
 * default is already safely inside), returns `configured` unchanged. Never
 * returns a negative or zero clamp that would disable the timeout — if the
 * remaining budget is already below the margin, returns a 1ms floor so the
 * call aborts immediately rather than running unbounded.
 * @returns the clamped timeout in ms
 */
export const clampToBudget = (configured: number, budgetRemainingMs?: number): number => {
  if (budgetRemainingMs === undefined || budgetRemainingMs <= 0) return configured;
  const budgetCap = Math.max(1, budgetRemainingMs - BUDGET_GUARD_MARGIN_MS);
  // configured===0 means "unbounded" — but a budget was passed, so honor the
  // budget cap rather than the unbounded intent.
  if (configured <= 0) return budgetCap;
  return Math.min(configured, budgetCap);
};

/**
 * Races a promise against a timeout. On timeout, rejects with a descriptive
 * Error so the caller's existing catch records a clean tool_result error and
 * the loop continues (or halts) rather than hanging forever. A timeoutMs of 0
 * disables the race and returns the original promise unbounded.
 * @returns the resolved value of `p`, or rejects on timeout
 */
const withTimeout = <T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  if (timeoutMs <= 0) return p;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`tool '${label}' exceeded ${timeoutMs}ms timeout (CYPHER_TOOL_TIMEOUT_MS)`)),
      timeoutMs,
    );
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
};

// ---------------------------------------------------------------------------
// Verdict contract (ADR-037 D14 / D19 / Q-1.3)
// ---------------------------------------------------------------------------

/**
 * The six v2.0-frozen Contract A verdicts. Closed-additive at v2.0
 * launch — post-launch additions follow the developer-mediated PR
 * protocol in `docs/docs/architecture/contract-evolution.md`. Removals
 * are never allowed.
 *
 * Today (schema v67) only `'success'`, `'mixed'`, `'failed'` clear the
 * `cypher_sessions.outcome` CHECK constraint — the three new tokens
 * (`'halted'`, `'abandoned'`, `'rejected_non_interactive'`) wait on the
 * deferred v68 migration. Phase 3-D's loop writes verdicts as
 * `signal_kind='verdict'` rows on `cypher_outcomes` (the multi-signal
 * ledger), not to `cypher_sessions.outcome`, so all six tokens are
 * legal at the signal layer.
 */
export type Verdict =
  | 'success'
  | 'mixed'
  | 'failed'
  | 'halted'
  | 'abandoned'
  | 'rejected_non_interactive'
  | 'captured_to_board';

/**
 * Phase-2-soft / Phase 1 / rejected — the three exits from `propose_plan`
 * per D15. Phase 2-hard (silent execution, no plan render) is rejected
 * by v2.0 scope per the execution plan.
 */
export type LoopPhase = 1 | 2;

/**
 * ADR-039 — scope vs execute phase tag for `runLoop`. The legacy
 * single-pass loop runs as `'execute'` (the default when omitted). The
 * scope phase is gated behind `CYPHER_REFINEMENT_ENABLED=1` per AC-16;
 * see `runLoop` for the dispatch flow.
 *
 * Note: this is distinct from `LoopPhase` (above), which is the
 * Phase-1/Phase-2-soft confirm-flow tag persisted in cypher_sessions
 * and surfaced to clients. They share the word "phase" because the
 * two concepts pre-date each other in the codebase; widening
 * `LoopPhase` is rejected because it would silently break the
 * persisted column's CHECK constraint.
 */
export type LoopExecPhase = 'scope' | 'execute';

/**
 * ADR-039 AC-16 — single env-flag gate for the SCOPE phase. Reads
 * `process.env.CYPHER_REFINEMENT_ENABLED` and returns `true` only when
 * the value is exactly `'1'`. Any other value (unset, `'0'`, `'true'`,
 * `'yes'`, `'on'`) leaves the loop in single-pass mode. The strict
 * `'1'` match keeps rollback (`CYPHER_REFINEMENT_ENABLED=0`) safe and
 * matches the smoke § 17.6 toggle contract — flipping the var between
 * dispatches MUST observably change behavior on the NEXT dispatch
 * without restart (no caching of the value at module-load time).
 */
export function isRefinementEnabled(): boolean {
  return process.env.CYPHER_REFINEMENT_ENABLED === '1';
}

/**
 * `confirm_mode` shape from `wi_dispatch` body (D18 / Q-1.13).
 *
 *   - `'interactive'` (default) — interactive transport (CLI / TTY) runs
 *     Phase 1 normally; non-interactive (n8n / cron / MCP-without-stdin)
 *     is rejected with `verdict='rejected_non_interactive'`.
 *   - `'auto'` — skip Phase 1 wait regardless of transport. Plan still
 *     rendered into cypher_steps for audit but proceeds straight into
 *     the D1 loop (forces Phase 2-soft with zero veto window).
 *   - `'reject'` — refuse without rendering a plan. Useful for
 *     capability-probe / dry-run flows.
 */
export type ConfirmMode = 'interactive' | 'auto' | 'reject';

// ---------------------------------------------------------------------------
// LoopOptions / LoopResult / LoopEvent (the public surface)
// ---------------------------------------------------------------------------

/**
 * Caller-owned signal that the bridge sets when the user issues `/stop`
 * or a transport disconnect is detected. The loop reads this between
 * tool calls (D17 / Q-1.12) — never during an in-flight call. The
 * shape is a plain `{ value: boolean }` so a single reference can be
 * shared across the bridge route handler, the loop, and any teardown
 * code without coordination.
 */
export interface HaltFlag {
  value: boolean;
}

/**
 * Loop input. The bridge wires these from the dispatch route handler:
 *
 *   - `db` / `palace` — already-open per-request handles. The loop
 *     does not own their lifecycle.
 *   - `goal` — the user's free-text dispatch goal.
 *   - `user` — the dispatcher identity (per-Beta-prior accounting).
 *   - `session_id` — the cypher_sessions row the loop writes against.
 *     MUST already exist; the loop reads it for posture/priors and
 *     writes outcomes against it. The dispatch route is responsible
 *     for `INSERT INTO cypher_sessions` before calling `runLoop`.
 *   - `posture` — one of the four loop postures (pr-review,
 *     bug-investigate, pm, generic). Determines which subset of
 *     TOOL_CATALOG the loop exposes per `toolsForPosture(posture)`.
 *   - `confirm_mode` — caller's requested mode per D18. Persisted to
 *     `cypher_sessions.confirm_mode_requested`; `confirm_mode_used`
 *     captures what the loop actually fell back to.
 *   - `is_interactive` — transport capability check the bridge does
 *     once at dispatch entry. False for n8n / cron / MCP-without-stdin
 *     callers. Combined with `confirm_mode` it drives the
 *     rejected_non_interactive path.
 *   - `halt_flag` — caller-owned `/stop` signal (see HaltFlag).
 *   - `max_iterations` / `max_tokens` / `max_wallclock_ms` — budget
 *     guards. Defaults applied when omitted; the loop returns
 *     `verdict='mixed'` cleanly on any exhausted budget.
 *   - `on_event` — optional streaming sink. The Phase 4 SSE endpoint
 *     wires this to forward `tool_call_started`, `tool_call_completed`,
 *     `text_delta`, `confirm_required`, and `done` events to the
 *     client. Non-streaming callers omit this and receive only the
 *     final `LoopResult`.
 *   - `anthropic_client` — caller-supplied Anthropic client. Optional;
 *     defaults to a freshly-constructed client using ANTHROPIC_API_KEY
 *     / ANTHROPIC_BASE_URL from the environment. Phase 3-E tests pass
 *     a mock here; Phase 4 routes pass a shared client.
 */
export interface LoopOptions {
  db: Database.Database;
  palace: PalaceClient | null;
  goal: string;
  user: string;
  session_id: string;
  posture: Posture;
  /**
   * ADR-038 v2.5 D8 — task_class is the warm-tier aggregation key for
   * selfAssess (Q-2.5.1 T1). Optional; defaults to 'generic'. The
   * dispatch endpoint reads this from the request body (alongside
   * posture) and passes it through.
   */
  task_class?: string;
  /**
   * ADR-038 v2.5 D2 — optional task_id links this dispatch to a persistent
   * task. When supplied, loadTaskContext() injects [task-context] into the
   * system prompt and curateTaskContext() runs after the done event.
   */
  task_id?: string;
  confirm_mode?: ConfirmMode;
  is_interactive: boolean;
  halt_flag: HaltFlag;
  /**
   * ADR-039 AC-7 — `phase: 'scope' | 'execute'`. Optional; defaults to
   * `'execute'` (today's single-pass behavior, unchanged). When the
   * caller asks for `'scope'` the loop enters the SCOPE phase entry
   * point — see runLoop body for the gated dispatch flow. The
   * dispatch route does NOT pass this directly; the bridge orchestrates
   * two calls (scope → execute) when `CYPHER_REFINEMENT_ENABLED=1`.
   */
  phase?: LoopExecPhase;
  max_iterations?: number;
  max_tokens?: number;
  max_wallclock_ms?: number;
  on_event?: (event: LoopEvent) => void;
  anthropic_client?: Anthropic;
}

/**
 * Default budget caps when LoopOptions omits them. Sized to match the
 * execution plan § 3.1 defaults (max 25 iterations, 200k tokens, 10 min
 * wallclock). Aggressively low caps would mask real cost regressions
 * during Phase 5 shadow mode; aggressively high caps would defeat the
 * point of having a guard.
 */
export const LOOP_DEFAULTS = {
  max_iterations: 25,
  max_tokens: 200_000,
  max_wallclock_ms: 600_000, // 10 minutes
} as const;

/**
 * Per-tool-call record. The loop pushes one of these into
 * `LoopResult.tool_calls` for every tool fire and emits the matching
 * `tool_call_started` / `tool_call_completed` event when `on_event` is
 * wired. Also serialized into `cypher_steps` rows (one per tool call,
 * `step_kind='tool_call'` per ADR-037 D7).
 */
export interface ToolCallRecord {
  id: string;
  name: string;
  posture: Posture;
  input: Record<string, unknown>;
  /** Serialized tool_result content. Truncated to ~1KB by the handler. */
  result: unknown;
  duration_ms: number;
  ok: boolean;
  /** Set when ok=false. Plain-text reason from the caught exception. */
  error?: string;
}

/**
 * Loop output. Single object returned from `runLoop` for non-streaming
 * callers; streaming callers also receive incremental events via
 * `on_event` but the final `LoopResult` is identical.
 */
export interface LoopResult {
  verdict: Verdict;
  /** Final assistant text message (the "surface"). Empty on rejected_non_interactive. */
  surface: string;
  session_id: string;
  /** Phase the loop ended in (1 = Phase 1 wait/confirm, 2 = Phase 2-soft execute). */
  phase: LoopPhase;
  /** Plan-shape hash for clustering (D15). Empty on Phase 1 cold-start. */
  plan_shape_hash: string;
  /** Beta-prior snapshot at dispatch entry — frozen to history (D15). */
  prior_count: number;
  prior_success_rate: number | null;
  /** The confirm_mode the loop actually used (may differ from requested). */
  confirm_mode_used: ConfirmMode;
  /** Engine label for D20 — always 'loop' from this path. */
  engine: 'loop';
  /** Every tool fired during this dispatch, in invocation order. */
  tool_calls: ToolCallRecord[];
  /** Aggregate token usage across all Anthropic calls. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  };
  /** Wallclock duration in ms (loop entry → return). */
  duration_ms: number;
  /** Set when verdict='halted' (D17). The tool call after which the halt fired. */
  halt_after_call_id?: string;
  /** Set when verdict='halted'. ISO timestamp of when the halt was observed. */
  halt_requested_at?: string;
  /**
   * Model-emitted note from `cypher_record_outcome` (when called).
   * Truncated to 4KB. Persisted to `cypher_sessions.outcome_note` by
   * `persistOutcome()` so the human-readable rationale survives on the
   * audit row alongside the verdict. Absent when the model didn't call
   * the tool. Added 2026-07-25 (see .planning/execute-no-skill/).
   */
  outcome_note?: string;
  /**
   * ADR-043 Phase 3 AC-A1 — populated when the loop closed via the PM capture
   * hook (verdict='captured_to_board'). This is the id of the `tasks` row the
   * capture created; `persistOutcome` writes it to `cypher_sessions.task_id`
   * so the session row links back to the card. NULL on every other verdict.
   *
   * Fixes the 2026-07-17 silent-fail bug where 3 sessions closed captured
   * with `task_id IS NULL` and no `tasks` row existed. See ADR-043 §
   * "Audit note — AC-A1 wiring bug (2026-07-24)".
   */
  task_id?: string | null;
  /** Card number surfaced in the AC-A1 "Filed as card #N …" line, if any. */
  card_number?: number | null;
}

/**
 * Streaming events for Phase 4's SSE endpoint. `on_event` consumers
 * receive these in temporal order. The final event is always `done`.
 *
 * Phase 3-D emits these synchronously inside the loop; the Phase 4 SSE
 * route translates them into `event: <name>\ndata: <json>\n\n` chunks.
 */
export type LoopEvent =
  | { type: 'plan_rendered'; plan_shape_hash: string; phase: LoopPhase }
  | { type: 'confirm_required'; question: string }
  | { type: 'tool_call_started'; call_id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_call_completed'; call_id: string; name: string; duration_ms: number; ok: boolean }
  | { type: 'text_delta'; text: string }
  | { type: 'done'; verdict: Verdict; surface: string };

// ---------------------------------------------------------------------------
// Tool subset selection
// ---------------------------------------------------------------------------

/**
 * Filter the production tool catalog to the subset visible to the model
 * for the given posture. Re-exports `toolsForPosture` from the catalog
 * module so callers don't need two imports.
 *
 * Phase 3-D's loop uses this to build the `tools` array passed to
 * `client.beta.promptCaching.messages.create`. The result is a stable
 * snapshot — the catalog is consulted once at dispatch entry; subsequent
 * iterations re-use the same array so prompt caching stays warm.
 */
export const toolsForPosture = catalogToolsForPosture;

// ---------------------------------------------------------------------------
// Helpers (D15 plan_shape_hash, D16 classifier)
// ---------------------------------------------------------------------------

/**
 * Compute a stable hash of a plan shape — the sequence of (posture,
 * tool_name) tuples that the plan declares. Used by D15 to cluster
 * "same plan, different goal text" duplicates for Phase 2-soft trigger
 * gating. Embedding-based similarity is v2.5 work; v2.0 ships exact
 * shape matching only.
 *
 * Phase 3-D computes the hash deterministically: SHA-256 over the JSON
 * representation of `{posture, tools: [name1, name2, ...]}`, truncated
 * to 16 hex characters. Statistically negligible collision rate at the
 * scale of cypher_sessions (single-digit-millions max). Argument values
 * do NOT participate in the hash — only the posture and the ordered
 * tool name sequence.
 */
export function planShapeHash(
  posture: Posture,
  toolSequence: readonly string[],
): string {
  const canonical = JSON.stringify({ posture, tools: toolSequence });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Free-text classifier for Phase 1 confirm replies (D16 / Q-1.11).
 *
 * Deterministic — no model call. The length-20 rule is the discriminator:
 *
 *   - normalized starts with confirm-affirmatives AND length ≤ 20 → confirm
 *   - normalized starts with halt-words AND length ≤ 20 → halt
 *   - length > 20 → correct (full reply becomes correction; loop re-proposes)
 *   - else → re-prompt
 */
export type ConfirmVerdict = 'confirm' | 'halt' | 'correct' | 'reprompt';
export interface ClassifyConfirmReplyResult {
  verdict: ConfirmVerdict;
  method:
    | 'pattern_confirm'
    | 'pattern_halt'
    | 'length_correct'
    | 'reprompt_confirm'
    | 'reprompt_halt'
    | 'reprompt_correct';
}

const CONFIRM_PATTERNS = [
  'yes',
  'y',
  'go',
  'do it',
  'confirm',
  'ok',
  'okay',
  'lgtm',
  'ship',
  'proceed',
] as const;
const HALT_PATTERNS = ['no', 'stop', 'wait', 'cancel', 'halt', 'abort', 'hold'] as const;

/**
 * Classify a free-text reply to a Phase 1 confirm prompt. Pure function
 * — no DB, no network. Exported for Phase 3-E test access.
 *
 * The length-20 boundary is the load-bearing rule: short affirmatives
 * are unambiguous; anything longer is plausibly a qualification
 * ("yes but only for BD-2871") and routes to `correct` rather than
 * guessing. Tune from `confirmation_method` audit data post-launch.
 */
export function classifyConfirmReply(reply: string): ClassifyConfirmReplyResult {
  const normalized = reply.toLowerCase().trim();
  const len = normalized.length;

  // Long replies always route to correct, regardless of how they start.
  if (len > 20) {
    return { verdict: 'correct', method: 'length_correct' };
  }

  const startsWithAny = (patterns: readonly string[]): boolean =>
    patterns.some((p) => normalized === p || normalized.startsWith(p + ' '));

  if (startsWithAny(CONFIRM_PATTERNS)) {
    return { verdict: 'confirm', method: 'pattern_confirm' };
  }
  if (startsWithAny(HALT_PATTERNS)) {
    return { verdict: 'halt', method: 'pattern_halt' };
  }
  // Short, doesn't match either pattern — re-prompt the user. The
  // method name captures which fallback path fired for telemetry.
  if (len === 0) {
    return { verdict: 'reprompt', method: 'reprompt_correct' };
  }
  return { verdict: 'reprompt', method: 'reprompt_correct' };
}

/**
 * Type guard: is the loop's posture eligible to call the given tool?
 * Filters `posture_eligibility` declaratively per D21 rule 1.
 */
export function isToolEligibleForPosture(
  tool: ToolDefinition,
  posture: Posture,
): boolean {
  return tool.posture_eligibility.includes(posture);
}

// ---------------------------------------------------------------------------
// Internal — Anthropic client construction
// ---------------------------------------------------------------------------

/**
 * Build the Anthropic client when the caller doesn't supply one. Mirrors
 * the proxy-aware pattern from AIAnalyzer / decision-engine.ts: when
 * `ANTHROPIC_BASE_URL` is set, the SDK rejects an empty `x-api-key`, so
 * we pass a sentinel `'x-proxy'` and the real key as Bearer Authorization.
 */
async function getAnthropicClient(): Promise<Anthropic> {
  const { default: AnthropicSdk } = await import('@anthropic-ai/sdk');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY required for runLoop');
  }
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  return new AnthropicSdk({
    apiKey: baseURL ? 'x-proxy' : apiKey,
    ...(baseURL
      ? { baseURL, defaultHeaders: { Authorization: `Bearer ${apiKey}` } }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// System prompt (Phase 1 spike, verbatim — proven on 3 dispatches)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Cypher, a senior-engineer agent running inside Work Intelligence MCP.

You drive a 9-step contract for every goal: investigate, ask, research, plan, execute, quality_gate, confirm, surface, record. Implement them by composing the tools below — no tool maps to one step.

Rules:
  1. Reason out loud briefly between tool calls so the trace is auditable.
  2. Don't call the same tool with the same args twice. If a result is empty, change the query or pivot to a different tool — don't retry.
  3. Don't hallucinate data. If a tool returns nothing useful, say so in your final surface.
  4. Stop when you have enough to answer the goal — don't pad the response with more tool calls.
  5. Your final message (after all tool calls) MUST be a coherent answer to the goal — concrete next steps, not "I have explored some tools."
  6. Use cypher_record_outcome with outcome="success" | "mixed" | "failed" exactly once before your final message. "success" if you produced concrete next steps, "mixed" if partial, "failed" if blocked.

Budget: the host enforces iteration / token / wallclock caps. Exceeding any one returns verdict='mixed' with what you found so far.`;

// ---------------------------------------------------------------------------
// Verdict resolution
// ---------------------------------------------------------------------------

/**
 * Map the loop's terminal state to one of the six Contract A verdicts
 * AND the numeric value the multi-signal ledger expects on
 * `cypher_outcomes.signal_kind='verdict'` rows.
 *
 * The numeric mapping mirrors the spike + outcomes.ts:
 *   - success → VERDICT_SUCCESS (+0.8)
 *   - mixed   → VERDICT_MIXED   (0.0)
 *   - failed  → VERDICT_FAILED  (-0.8)
 *
 * Halted / abandoned / rejected_non_interactive get VERDICT_MIXED today
 * (until v68 widens the verdict enum on cypher_outcomes too). The
 * granular token survives in `metadata.verdict` on the signal row so
 * downstream analytics distinguishes "user stopped me" from "I gave up".
 */
function verdictValue(v: Verdict): number {
  switch (v) {
    case 'success':
      return VERDICT_SUCCESS;
    case 'failed':
      return VERDICT_FAILED;
    case 'mixed':
    case 'halted':
    case 'abandoned':
    case 'rejected_non_interactive':
    case 'captured_to_board':
      return VERDICT_MIXED;
  }
}

/**
 * Look up the Beta-prior snapshot for this user + plan_shape_hash combo.
 *
 * Phase 3-D ships the prior-snapshot read with a posture-only fallback:
 * for genuinely-cold-start sessions (no prior plan-shape match) we look
 * up the user's overall success rate within the posture. This still
 * gives Phase 2-soft signal to work with without requiring exact
 * plan-shape collision. Phase 5 shadow data will tell us whether
 * exact-shape-only is too restrictive.
 *
 * Reads cypher_sessions for prior completions with outcome IS NOT NULL.
 * The count is the number of prior dispatches; the success rate is
 * `success / (success+mixed+failed)` excluding halted/abandoned rows
 * (which don't represent learning signal).
 */
function snapshotPriors(
  db: Database.Database,
  user: string,
  plan_shape_hash: string,
): { prior_count: number; prior_success_rate: number | null } {
  // First try exact plan_shape_hash match — most precise signal.
  if (plan_shape_hash !== '') {
    const exact = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) AS successes
         FROM cypher_sessions
         WHERE user = ? AND plan_shape_hash = ? AND outcome IN ('success','mixed','failed')`,
      )
      .get(user, plan_shape_hash) as { total: number; successes: number };
    if (exact.total > 0) {
      return {
        prior_count: exact.total,
        prior_success_rate: exact.successes / exact.total,
      };
    }
  }
  // No exact-shape priors — cold-start. Return zero count, NULL rate
  // (the schema distinguishes this from "0% historical success").
  return { prior_count: 0, prior_success_rate: null };
}

/**
 * Extract the human-readable summary string from a cypher_compact_context
 * tool result. The handler returns `{ summary, instruction }` on success
 * and `{ error, ... }` on failure. We accept anything that has a non-empty
 * `summary` string field; everything else returns null so the caller skips
 * compaction. B1 (2026-06-28).
 */
export function extractCompactSummary(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const r = result as Record<string, unknown>;
  const s = r.summary;
  return typeof s === 'string' && s.length > 0 ? s : null;
}

/**
 * ADR-039 AC-7 commit 1 (2026-06-29) — extract a candidate refined_goal
 * JSON object from assistant text. Handles both bare JSON ("just an
 * object") and JSON wrapped in ```json ... ``` fences. Returns the
 * parsed object on success, null when no JSON-looking block is found
 * OR when the candidate fails JSON.parse.
 *
 * Validation against refined-goal-schema is the caller's job — this
 * helper only handles the parse, so the caller can distinguish
 * "no JSON emitted" (clarifying question path) from "JSON emitted but
 * schema-invalid" (loop and re-prompt path).
 */
export function extractJsonBrief(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // ```json ... ``` fenced block
  const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      return null;
    }
  }

  // Bare object: find the first '{' and try to parse from there to the
  // matching '}'. We use a simple brace counter; good enough for the
  // refiner's well-formed output.
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * ADR-039 AC-7 commit 1 (2026-06-29) — persist the scope-phase outcome
 * to cypher_sessions.refined_goal + cypher_sessions.scope_iters.
 *
 * Called once per scope-phase dispatch, regardless of verdict. When
 * the brief is null (halt path), the column stays NULL so downstream
 * readers can distinguish "scope ran but didn't produce a brief"
 * (scope_iters > 0, refined_goal NULL) from "scope didn't run"
 * (scope_iters NULL via v85 ALTER ADD column default 0; ran from a
 * pre-v85 dispatch).
 */
export function persistRefinedGoal(
  db: Database.Database,
  session_id: string,
  refined_goal_json: string | null,
  scope_iters: number,
): void {
  db.prepare(
    `UPDATE cypher_sessions
       SET refined_goal = ?,
           scope_iters = ?
     WHERE session_id = ?`,
  ).run(refined_goal_json, scope_iters, session_id);
}

/**
 * Fallback system prompt for the SCOPE-phase refiner when the OPRO
 * `goal_refinement` seed isn't loaded yet (fresh-install case, or
 * tests that skip seedTemplatesIfEmpty). Mirrors the load-bearing
 * fields from prompt-seeds.ts:131 in compressed form. ADR-039 AC-7
 * commit 1 (2026-06-29).
 */
const REFINER_FALLBACK_PROMPT = `You are Cypher's SCOPE-phase refiner. Your job is to take the user's fuzzy goal and produce a structured brief that the EXECUTE phase can act on — nothing more.

You may call read-only tools (search, recall, palace_search, fts) to gather context. You may NOT call write/commit/push tools — they have been removed from your tool list.

When you have enough context, emit a JSON object with this exact shape (and ONLY this — no preamble, no commentary):

{
  "intent": "<EXACTLY one of: investigate | build | review | analyze | refactor | brainstorm | plan | decide | other>",
  "target": "<what the work touches: file, ticket, system, behavior>",
  "constraints": ["<each constraint as a short phrase>"],
  "success_criteria": ["<what 'done' looks like, one criterion per entry>"],
  "out_of_scope": ["<things NOT to touch>"],
  "linkage": { "jira": [], "prs": [], "adrs": [], "files": [] },
  "expected_output_shape": "<rca | patch | brief | code | answer>",
  "evidence_cited": [{ "source": "<file/url/id>", "ref": "<line/section>", "snippet": "<≤120 chars>" }]
}

INTENT — pick the ONE that matches what the user is really asking for:
  DOING work (Cypher will execute it now): investigate (find root cause) · build (write/ship code) · review (assess a PR/change) · analyze (examine data/behavior) · refactor (restructure code) · other (none of these fit).
  DELIBERATIVE work (this gets parked on the backlog as a thinking-card, NOT executed): brainstorm (generate ideas/options — "brainstorm ways to…", "ideas for…") · plan (design an approach/roadmap — "plan the migration", "how should we…") · decide (choose between options — "should we X or Y", "evaluate whether…").
  Rule of thumb: if the user wants a concrete artifact NOW (a fix, a PR, an answer, a report) → doing-verb. If they want to think/explore/choose before any work is scoped → deliberative-verb. When genuinely unsure between analyze and brainstorm, prefer the doing-verb (analyze) — a mystery goal is better dispatched than silently parked.

If the goal is genuinely ambiguous (two intents in one sentence, missing target, no success_criteria can be inferred), emit a SHORT clarifying question instead of JSON. Do NOT emit both.

Iteration budget: 3 model calls before the loop force-halts.`;

/**
 * In-place compaction of the loop's messages array. B1 (2026-06-28).
 *
 * Replaces messages[1..N-7] with a single synthetic assistant turn
 * containing `[compacted: <summary>]`. Keeps the initial user goal
 * (index 0) and the last 3 iteration pairs (indices N-6..N-1).
 *
 * No-ops (returns false, leaves the array unchanged) when:
 *   - summary is empty
 *   - messages.length <= 8 (compaction would not shrink)
 *
 * Exported so the unit test can exercise the mutation contract
 * without booting a full runLoop. Returns true on mutate, false on
 * no-op so the caller can log appropriately.
 */
export function compactMessagesInPlace(
  messages: Anthropic.Messages.MessageParam[],
  summary: string,
): boolean {
  if (!summary || messages.length <= 8) return false;
  const kept_initial = messages.slice(0, 1);
  const kept_tail = messages.slice(messages.length - 6);
  const synthetic: Anthropic.Messages.MessageParam = {
    role: 'assistant',
    content: `[compacted: ${summary.slice(0, 4000)}]`,
  };
  messages.length = 0;
  messages.push(...kept_initial, synthetic, ...kept_tail);
  return true;
}

// ---------------------------------------------------------------------------
// runLoop — the entry point
// ---------------------------------------------------------------------------

/**
 * The loop controller entry point. Implements the Plan-Confirm-Act flow
 * with the Anthropic tool-use body, budget guards, halt-flag handling,
 * and outcome writeback.
 *
 * Phase 3-D ships this with `confirm_mode='auto'` equivalence as the
 * default execution path — no plan render, no Phase 1 wait. Phase 4
 * wires the SSE endpoint and `confirm_mode='interactive'` brings the
 * full Phase 1 / Phase 2-soft branching into play once the route layer
 * can surface `confirm_required` events to a TTY client. The classifier
 * (`classifyConfirmReply`) is wired and tested today; only the route
 * plumbing is deferred.
 */

/**
 * ADR-038 v2.5 D8 — render a SelfAssessment object into the structured
 * text block injected as a system prompt at dispatch entry. Format
 * matches the example in .planning/cypher/v2.5-D8-self-model-design.md
 * § Q-2.5.5: a [self-assessment] header followed by key:value lines
 * the model can parse without ambiguity.
 */
function renderSelfAssessmentBlock(a: ReturnType<typeof selfAssess>): string {
  const lines: string[] = [
    '[self-assessment]',
    `confidence: ${a.confidence.toFixed(2)} (n=${a.n_similar_tasks} at tier=${a.tier_used})`,
    `recent_success_rate: ${a.recent_success_rate.toFixed(2)}`,
    `typical_cost_usd: ${a.typical_cost_usd.toFixed(4)}`,
    `failure_modes: ${a.failure_modes.length > 0 ? a.failure_modes.join(', ') : '(none observed)'}`,
    `recommendation: ${a.recommendation}`,
  ];
  if (a.note) lines.push(`note: ${a.note}`);
  return lines.join('\n');
}

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const startMs = Date.now();
  const maxIterations = opts.max_iterations ?? LOOP_DEFAULTS.max_iterations;
  const maxTokens = opts.max_tokens ?? LOOP_DEFAULTS.max_tokens;
  const maxWallclockMs = opts.max_wallclock_ms ?? LOOP_DEFAULTS.max_wallclock_ms;

  // ── ADR-039 AC-7 / AC-16 — phase entry resolution ────────────────────────
  // Default phase is 'execute' (today's single-pass loop, unchanged).
  // The bridge ONLY supplies phase='scope' when
  // `CYPHER_REFINEMENT_ENABLED=1` AND the dispatch is the first half of
  // a two-pass dispatch. When the flag is off, the bridge never calls
  // runLoop with phase='scope', so we don't need to gate flag-off
  // callers here — but we DO gate stray phase='scope' callers when
  // the flag is off, to make accidental enablement impossible (AC-20
  // rollback contract).
  const requestedPhase: LoopExecPhase = opts.phase ?? 'execute';
  if (requestedPhase === 'scope' && !isRefinementEnabled()) {
    // Caller asked for scope but the env flag is off. The loop falls
    // back to execute behavior (single-pass) so a stray caller doesn't
    // crash the dispatch. This is the AC-20 rollback path: flipping
    // CYPHER_REFINEMENT_ENABLED=0 mid-flight reverts behavior on the
    // NEXT dispatch without any further coordination.
    opts.on_event?.({
      type: 'text_delta',
      text:
        '[ADR-039] phase=scope requested but CYPHER_REFINEMENT_ENABLED!=1 — falling back to single-pass execute\n',
    });
  }
  const effectivePhase: LoopExecPhase =
    requestedPhase === 'scope' && isRefinementEnabled()
      ? 'scope'
      : 'execute';

  const requestedConfirmMode: ConfirmMode = opts.confirm_mode ?? 'interactive';
  const tool_calls: ToolCallRecord[] = [];
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };

  // ── PM-AUTO on dispatch (tsk_aa2abe3414c5) ────────────────────────────────
  // Port of the run.ts Stage-1 auto-link that regressed silent when dispatch
  // moved from the 9-stage pipeline to the loop on 2026-06-23 (pm_auto_actions
  // flatlined that day). suggestAutoLinks + autoLinkOnDispatch are pure SQL
  // (no LLM, no network), idempotent (evidence-link + pending→in_progress
  // guarded), so they run once per dispatch regardless of phase. Best-effort:
  // a failure here must never break the dispatch, so it's fully wrapped.
  try {
    const autoLinks = suggestAutoLinks(opts.db, opts.goal);
    const pmAuto = autoLinkOnDispatch(opts.db, opts.session_id, autoLinks);
    if (pmAuto.linked.length || pmAuto.transitioned.length) {
      opts.on_event?.({
        type: 'text_delta',
        text: `[pm-auto] linked ${pmAuto.linked.length} card(s), transitioned ${pmAuto.transitioned.length}\n`,
      });
    }
  } catch (err) {
    opts.on_event?.({
      type: 'text_delta',
      text: `[pm-auto] auto-link skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    });
  }

  // ── G1 heartbeat — write freshness row at every loop entry ─────────────
  try {
    writeHeartbeat(opts.db, 'loop', effectivePhase, JSON.stringify({
      session_id: opts.session_id,
      goal: opts.goal.slice(0, 200),
    }));
  } catch {
    // Best-effort: never break the dispatch on heartbeat write failure.
  }

  // ── ADR-039 AC-7 — SCOPE phase entry point (runs BEFORE confirm-mode
  // early-returns so a scope dispatch is never short-circuited as
  // rejected_non_interactive). ─────────────────────────────────────────────
  // When effectivePhase === 'scope', runLoop runs the refinement mini-
  // loop here (refiner system prompt sourced from
  // PromptEvolver.buildPrompt('goal_refinement', ctx); read-only tool
  // catalog via getCatalogForPhase('scope'); emits refined_goal
  // validated against src/services/cypher/refined-goal-schema.ts).
  //
  // The exit contract per AC-7:
  //   (a) brief emitted → verdict='success', surface=JSON(refined_goal),
  //       persisted to cypher_sessions.refined_goal.
  //   (b) scope_iters >= CYPHER_SCOPE_MAX_ITERS (default 3) →
  //       verdict='halted', surface names budget exhaustion.
  //   (c) refiner emits clear=false with questions → verdict='halted',
  //       surface contains the clarifying questions; bridge fans out
  //       to the user.
  //
  // The mini-loop body itself (refiner dispatch, parallel tool_use
  // within scope, schema validation gate) lands in a follow-up T8-mini
  // card. This entry point exists today to (1) satisfy AC-7's "runLoop
  // accepts a phase parameter" contract and (2) make the AC-16 +
  // AC-20 flag-flip contract testable without yet shipping the body —
  // smoke § 17 verifies that flag=on + phase=scope returns a halted
  // result distinguishable from the single-pass loop, and that
  // flag=off + phase=scope falls back to single-pass (above).
  if (effectivePhase === 'scope') {
    updateSessionMetadata(opts.db, opts.session_id, {
      confirm_mode_requested: requestedConfirmMode,
      confirm_mode_used: requestedConfirmMode,
      phase: 1,
      engine: 'loop',
      prior_count: 0,
      prior_success_rate: null,
    });

    // ADR-039 AC-7 commit 1 (2026-06-29) — refiner mini-loop body.
    // Build a read-only system prompt (via PromptEvolver's
    // `goal_refinement` template) + a scope-filtered tool list, then
    // iterate up to CYPHER_SCOPE_MAX_ITERS (default 3) times asking
    // the model to either (a) emit a JSON `refined_goal` brief that
    // validates against refined-goal-schema.ts, (b) call read-only
    // tools to gather context, or (c) emit a clarifying question.
    //
    // This is a deliberately small loop — NOT a full runLoop. It
    // skips self-assessment, task-context curation, plan-confirm-act,
    // and complex halt-flag handling because scope phase is supposed
    // to be cheap (≤ 3 model calls) and read-only. The execute phase
    // does the heavy lifting against the brief that lands in
    // cypher_sessions.refined_goal.
    const scopeStartMs = Date.now();
    // ADR-040 F6 fix + ADR-042 — hard wall-clock deadline for the SCOPE phase,
    // hoisted here so both the single-pass (ADR-042) and multi-round paths
    // clamp their per-call timeouts to the remaining budget. 0 disables.
    const scopeWallclockMs = Math.max(0, parseInt(process.env.CYPHER_SCOPE_MAX_WALLCLOCK_MS ?? '60000', 10) || 60_000);
    const scopeMaxIters = Math.max(
      1,
      Math.min(10, parseInt(process.env.CYPHER_SCOPE_MAX_ITERS ?? '3', 10) || 3),
    );

    // Build the catalog hint (AC-9 + AC-10 — non-binding). Empty
    // string if the goal has no overlap with any catalog description.
    let catalogHint = '';
    try {
      catalogHint = await getCatalogHint(opts.goal, opts.db);
    } catch {
      // Best-effort. The hint is advisory; refiner runs fine without.
    }

    // ── ADR-042 Stage 1 (Prompt Generation) ─────────────────────────────
    // When WI_STAGE1_ENABLED=1, run the parallel fetch (prompt_memory +
    // message_embeddings + two-tier catalog), assemble the evidence
    // bundle, and append the rendered block to the refiner prompt as
    // extra context. The existing catalogHint stays — Stage 1 is
    // ADDITIVE, not a replacement, until AC-U1 recall crosses the flip
    // threshold. Flag defaults OFF so master behavior is unchanged.
    // Never throws — degrades to empty string on any error.
    let stage1EvidenceBlock = '';
    // Multi-intent state: when non-empty, the refiner is asked for an
    // intents[] array response instead of a single flat brief.
    let multiIntentSubGoals: Array<{ intent: string; goal: string }> = [];
    // Recognition-feedback loop (2026-07-17). Holds the Stage-1 confidence
    // flag + top-skill so the SCOPE surface can emit a low-confidence human
    // feedback prompt AFTER the brief is produced. Null when Stage 1 didn't
    // run (flag off / errored). NEVER used to block or halt — advisory only.
    let stage1Confidence:
      | { confidence: 'high' | 'low'; top_skill: string | null }
      | null = null;
    if (process.env.WI_STAGE1_ENABLED === '1') {
      try {
        const { stage1Fetch, renderStage1EvidenceBlock } = await import('./stage1.js');

        // ── ADR-042 multi-intent classify (2026-07-15) ──────────────────
        // Cheap Anthropic call: split raw goal into 1..N atomic sub-goals.
        // Never throws — degrades to single-intent on any classifier error.
        // Only fires when Stage 1 flag is on (this branch).
        // Model resolved via bucketCallParams('digest') — the codebase's
        // cheap-bucket model that's guaranteed to work with the current
        // proxy (in some environments, direct model names like
        // 'claude-3-5-haiku-latest' fail with INVALID_MODEL).
        const scopeClientEarly = opts.anthropic_client ?? (await getAnthropicClient());
        const { classifyMultiIntent } = await import('./multi-intent-classifier.js');
        const digestParams = bucketCallParams(opts.db, 'digest', 400);
        const classifier = await classifyMultiIntent(opts.goal, scopeClientEarly, {
          timeoutMs: 12_000,
          model: digestParams.model,
          db: opts.db,
        });

        if (classifier.is_single) {
          // Standard single-pass path (unchanged): one Stage 1 fetch on the raw goal.
          const ev = await stage1Fetch(opts.goal, opts.db);
          stage1EvidenceBlock = renderStage1EvidenceBlock(ev);
          // Retain the recognition-confidence signal for the SCOPE surface.
          stage1Confidence = {
            confidence: ev.recognition_confidence,
            top_skill: ev.confidence_signal.top_skill,
          };
        } else {
          // Compound goal: run stage1Fetch PER sub-goal in parallel,
          // render each as a labeled evidence block, and set the sub-goals
          // aside so the schema-strict prompt below can ask for intents[].
          multiIntentSubGoals = classifier.sub_goals.map((s) => ({ intent: s.intent, goal: s.goal }));
          const perSubEvidence = await Promise.all(
            classifier.sub_goals.map((s) => stage1Fetch(s.goal, opts.db)),
          );
          const labeled = classifier.sub_goals.map((s, i) => {
            const block = renderStage1EvidenceBlock(perSubEvidence[i]!);
            return `\n### Sub-intent ${i + 1}/${classifier.sub_goals.length} — intent=${s.intent}\n\n> Sub-goal: ${s.goal}\n\n${block}`;
          });
          stage1EvidenceBlock =
            `## MULTI-INTENT DETECTED (${classifier.sub_goals.length} sub-intents)\n\n` +
            `Classifier split the raw goal into ${classifier.sub_goals.length} atomic sub-goals. ` +
            `Each has its own Stage 1 evidence bundle below. In your response, emit ONE refined_goal ` +
            `object with an \`intents\` array containing ONE sub-brief per sub-intent (in the same order).\n` +
            labeled.join('\n');
          // Aggregate confidence for a compound goal: low if ANY sub-goal is
          // low (the conservative choice — one uncertain sub-intent is enough
          // to warrant a thumbs check). top_skill is the first low sub-goal's
          // top candidate, so the prompt names something concrete.
          const firstLow = perSubEvidence.find((e) => e.recognition_confidence === 'low');
          stage1Confidence = firstLow
            ? { confidence: 'low', top_skill: firstLow.confidence_signal.top_skill }
            : { confidence: 'high', top_skill: perSubEvidence[0]?.confidence_signal.top_skill ?? null };
        }
      } catch {
        // Best-effort. Stage 1 is a fresh path — if it fails, the loop's
        // existing SCOPE refiner still works exactly as before.
      }
    }

    // Build the refiner system prompt from the PromptEvolver template.
    // Falls back to a hand-coded minimal prompt if the OPRO seed
    // isn't in the DB yet (fresh-install case before seedTemplatesIfEmpty).
    let refinerSystemPrompt: string;
    let refinerTemplateId: number | null = null;
    try {
      const { PromptEvolver } = await import('../../intelligence/prompt-evolver.js');
      const evolver = new PromptEvolver(opts.db);
      const built = await evolver.buildPrompt('goal_refinement', {
        triggerContext: 'cypher_scope_phase',
        researchQuestion: opts.goal,
        repoList: 'work-intelligence-mcp',
        rawGoal: opts.goal,
        catalogHint,
      });
      if (built) {
        refinerSystemPrompt = built.prompt;
        refinerTemplateId = built.templateId;
      } else {
        refinerSystemPrompt = REFINER_FALLBACK_PROMPT;
      }
    } catch {
      refinerSystemPrompt = REFINER_FALLBACK_PROMPT;
    }

    // ADR-042: prepend Stage 1 evidence to the refiner prompt when enabled.
    // Kept as a prepend (not replace) so the existing OPRO-evolved refiner
    // template still runs — Stage 1 evidence is additional context, not a
    // substitute for the refiner's reasoning.
    if (stage1EvidenceBlock) {
      refinerSystemPrompt = `${stage1EvidenceBlock}\n\n---\n\n${refinerSystemPrompt}`;
    }

    // ADR-042 Stage 1: when single-pass is enabled, append a strict schema
    // spec so the LLM emits a schema-conformant refined_goal on the first
    // try. The multi-round loop retries on validation failure; single-pass
    // has no retry, so schema clarity is load-bearing.
    if (process.env.WI_STAGE1_ENABLED === '1' && stage1EvidenceBlock) {
      refinerSystemPrompt += `

---

## STRICT SCHEMA (single-pass — no retry — emit exactly this shape)

Return a JSON object with EXACTLY these 8 keys (plus optional \`intents\` when multi-intent — see below), no extras, all populated:

\`\`\`json
{
  "intent": "investigate" | "build" | "review" | "analyze" | "refactor" | "brainstorm" | "plan" | "decide" | "other",
  "target": "<specific subject: ticket key, file path, PR number, symbol name — non-empty string>",
  "constraints": ["<hard rule 1>", "<hard rule 2>"],
  "success_criteria": ["<at least one testable done-condition>"],
  "out_of_scope": ["<explicit exclusion 1>"],
  "linkage": {
    "jira": ["<ticket key or empty array>"],
    "prs": ["<PR number as string or empty array>"],
    "adrs": ["<ADR number or empty array>"],
    "files": ["<file path or empty array>"]
  },
  "expected_output_shape": "rca" | "patch" | "brief" | "code" | "answer",
  "evidence_cited": [
    { "source": "<file|ticket|doc|msg>", "ref": "<path or id>", "snippet": "<≤120 chars>" }
  ]
}
\`\`\`

Rules:
- Every key MUST be present. Use empty arrays for constraints/out_of_scope/linkage.jira/prs/adrs/files/evidence_cited when nothing applies. Do NOT omit a key.
- \`intent\` picks the ONE verb matching the user's real ask. DOING work (executed now): investigate · build · review · analyze · refactor · other. DELIBERATIVE work (parked on the backlog as a thinking-card, NOT executed): brainstorm (generate ideas/options) · plan (design an approach/roadmap) · decide (choose between options). If the user wants a concrete artifact NOW → doing-verb; if they want to think/explore/choose before work is scoped → deliberative-verb. When unsure between analyze and brainstorm, prefer analyze (dispatch beats silently parking).
- \`linkage\` MUST be an object with the 4 keys above, each an array of strings.
- \`evidence_cited\` MUST be an array of OBJECTS (not strings), each with source+ref+snippet fields.
- \`success_criteria\` MUST have at least one entry describing an observable done-condition.
- No markdown, no code fence, no prose — JSON ONLY, parseable by \`JSON.parse()\`.
- If the goal is genuinely ambiguous and you cannot fill \`target\` from evidence, respond with a SHORT clarifying question (one sentence, no JSON). The system will halt with \`asked_user\` and prompt the user to re-dispatch.
${
  multiIntentSubGoals.length > 1
    ? `
## MULTI-INTENT REQUIRED

The classifier detected ${multiIntentSubGoals.length} sub-intents. You MUST include an \`intents\` array in the JSON, one sub-brief per sub-intent, in the same order shown in the evidence blocks above.

Each element in \`intents\` has the SAME 8 keys as the top-level shape.

\`\`\`json
{
  "intent": "<same as intents[0].intent>",
  "target": "<same as intents[0].target>",
  ... (top-level fields mirror intents[0])
  "intents": [
    { "intent": "...", "target": "...", "constraints": [], "success_criteria": ["..."],
      "out_of_scope": [], "linkage": {"jira":[],"prs":[],"adrs":[],"files":[]},
      "expected_output_shape": "...", "evidence_cited": [] },
    { ...next sub-brief... }
  ]
}
\`\`\`

STRICT rules for multi-intent:
- \`intents\` MUST have EXACTLY ${multiIntentSubGoals.length} entries (one per sub-intent from the classifier).
- Top-level \`intent\` and \`target\` MUST mirror \`intents[0].intent\` and \`intents[0].target\`.
- Enrich each sub-intent independently using the labeled evidence block ABOVE for that sub-intent. Do NOT cross-pollinate.
- If the classifier was wrong and this is actually a single-intent goal, OMIT the \`intents\` array and emit the flat top-level shape only.

Classifier's sub-goals (for reference):
${multiIntentSubGoals.map((s, i) => `  ${i + 1}. [intent=${s.intent}] ${s.goal}`).join('\n')}
`
    : ''
}`;
    }

    // Filter the tool catalog to scope-eligible read-only tools.
    // Intersect with posture-eligible tools so the refiner sees only
    // the read tools its posture is allowed. Construct
    // posture-eligible inline rather than reading the later-declared
    // `eligibleTools` const (the SCOPE block runs before the main
    // execute scaffolding in runLoop).
    const scopePostureEligible = toolsForPosture(opts.posture);
    const scopeCatalog = getCatalogForPhase('scope');
    const postureNames = new Set(scopePostureEligible.map((t) => t.name));
    const scopeEligibleTools = scopeCatalog.filter((t) => postureNames.has(t.name));
    const scopeSdkTools: Anthropic.Messages.Tool[] = scopeEligibleTools.map((t) => ({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
    }));

    // Anthropic client — same factory the main loop uses below. We
    // hold this in a scope-local const so this block stays
    // declaration-order-independent of the main loop's setup.
    const scopeClient = opts.anthropic_client ?? (await getAnthropicClient());

    const scopeMessages: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: opts.goal },
    ];
    let refinedGoalJson: string | null = null;
    let clarifyingQuestion: string | null = null;
    let scopeIters = 0;
    let scopeStopReason: string | null = null;
    const scopeUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };

    // ── ADR-042 Stage 1 single-pass path ────────────────────────────────
    // When WI_STAGE1_ENABLED=1 AND Stage 1 produced a non-empty evidence
    // block, execute ONE Anthropic call and skip the multi-round mini-loop
    // below. The 1a evidence is already prepended to refinerSystemPrompt;
    // the LLM's job is to emit ONE response — either a refined_goal JSON
    // brief OR a single clarifying question. No tool dispatch.
    //
    // This is what actually cures the SCOPE 60s halt (documented across
    // sessions 18092–18143). The multi-round loop stays intact when
    // WI_STAGE1_ENABLED=0 so master-default behavior is unchanged.
    if (process.env.WI_STAGE1_ENABLED === '1' && stage1EvidenceBlock) {
      scopeIters = 1;
      let onePassResponse: Anthropic.Beta.PromptCaching.PromptCachingBetaMessage;
      try {
        const scopeParams = bucketCallParams(opts.db, 'decide', 2048);
        onePassResponse = await scopeClient.beta.promptCaching.messages.create({
          ...scopeParams,
          system: [
            { type: 'text', text: refinerSystemPrompt, cache_control: { type: 'ephemeral' } },
          ],
          // NO tools — Stage 1's contract is recognition-only. The 1a evidence
          // in the system prompt is complete; the model must NOT dispatch.
          tools: [],
          messages: scopeMessages,
        }, { timeout: llmCallTimeoutMs(
          // Floor the remaining budget at 1ms. Without the floor, an already-
          // over-budget SCOPE (elapsed > scopeWallclockMs) would pass a
          // negative value, which clampToBudget reads as "no budget" and
          // returns the full 90s — the exact unclamped path this fix closes.
          scopeWallclockMs > 0 ? Math.max(1, scopeWallclockMs - (Date.now() - scopeStartMs)) : undefined,
        ) });
      } catch (err) {
        const halt: LoopResult = {
          verdict: 'halted',
          surface: `SCOPE phase (Stage 1 single-pass): refiner call failed: ${(err as Error).message}`,
          session_id: opts.session_id,
          phase: 1,
          plan_shape_hash: '',
          prior_count: 0,
          prior_success_rate: null,
          confirm_mode_used: requestedConfirmMode,
          engine: 'loop',
          tool_calls,
          usage: scopeUsage,
          duration_ms: Date.now() - scopeStartMs,
          halt_after_call_id: undefined,
          halt_requested_at: new Date().toISOString(),
        };
        persistRefinedGoal(opts.db, opts.session_id, null, scopeIters);
        persistOutcome(opts.db, opts.session_id, halt, opts.user);
        opts.on_event?.({ type: 'done', verdict: halt.verdict, surface: halt.surface });
        return halt;
      }

      scopeUsage.input_tokens += onePassResponse.usage.input_tokens;
      scopeUsage.output_tokens += onePassResponse.usage.output_tokens;
      scopeUsage.cache_read_tokens += onePassResponse.usage.cache_read_input_tokens ?? 0;
      scopeUsage.cache_write_tokens += onePassResponse.usage.cache_creation_input_tokens ?? 0;
      scopeStopReason = onePassResponse.stop_reason;

      // Per-phase telemetry (parity with multi-round path).
      try {
        opts.db.prepare(`
          INSERT INTO cypher_steps (
            session_id, stage, stage_index, status, payload,
            tokens_used, duration_ms, reasoning_trace, controller_model, phase
          ) VALUES (?, 'tool_use', ?, 'completed', ?, ?, 0, NULL, NULL, 'scope')
        `).run(
          opts.session_id,
          0,
          JSON.stringify({
            single_pass: true,
            stop_reason: scopeStopReason,
          }).slice(0, 8000),
          onePassResponse.usage.input_tokens + onePassResponse.usage.output_tokens,
        );
      } catch (insErr) {
        process.stderr.write(
          `[cypher-scope stage1] cypher_steps INSERT failed (non-fatal): ${(insErr as Error).message}\n`,
        );
      }

      // Extract the response text.
      const assistantText = onePassResponse.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      // Try to parse as a refined_goal JSON brief; if that fails, treat the
      // response as a clarifying question. No retry — single-pass contract.
      const briefCandidate = extractJsonBrief(assistantText);
      if (briefCandidate) {
        // ── LLM-shortcut normalizer (2026-07-15) ──────────────────────
        // The strict-schema prompt asks for evidence_cited as OBJECTS
        // {source, ref, snippet}, but LLMs often shortcut to plain strings
        // like "msg#42 — Some Teams message". Rather than fail validation
        // (single-pass has no retry), coerce string entries into objects
        // by parsing common shapes at the boundary. Same for intents[].evidence_cited.
        // This is defensive — the schema itself stays strict.
        const normalizeEvidence = (arr: unknown): unknown => {
          if (!Array.isArray(arr)) return arr;
          return arr.map((entry) => {
            if (typeof entry === 'string') {
              // Try "source — snippet" or "source: snippet" split
              const dashSplit = entry.match(/^([^—:]+?)[—:]\s*(.+)$/);
              if (dashSplit) {
                return { source: dashSplit[1]!.trim(), ref: dashSplit[1]!.trim(), snippet: dashSplit[2]!.trim().slice(0, 120) };
              }
              return { source: 'text', ref: entry.slice(0, 40), snippet: entry.slice(0, 120) };
            }
            return entry;
          });
        };
        if (typeof briefCandidate === 'object' && briefCandidate !== null) {
          const b = briefCandidate as Record<string, unknown>;
          if (Array.isArray(b.evidence_cited)) b.evidence_cited = normalizeEvidence(b.evidence_cited);
          if (Array.isArray(b.intents)) {
            b.intents = (b.intents as unknown[]).map((sub) => {
              if (typeof sub === 'object' && sub !== null) {
                const s = sub as Record<string, unknown>;
                if (Array.isArray(s.evidence_cited)) s.evidence_cited = normalizeEvidence(s.evidence_cited);
                return s;
              }
              return sub;
            });
            // ── Mirror-heal (2026-07-15) ──────────────────────────────
            // The strict-schema prompt says "top-level MUST mirror intents[0]"
            // but LLMs occasionally invent a top-level summary that doesn't
            // match. Since intents[0] is the primary sub-brief by contract,
            // heal by copying intents[0] fields UP into the top level. This
            // is a boundary correction, not a semantic change.
            const first = (b.intents as unknown[])[0] as Record<string, unknown> | undefined;
            if (first && typeof first === 'object') {
              for (const k of [
                'intent', 'target', 'constraints', 'success_criteria',
                'out_of_scope', 'linkage', 'expected_output_shape', 'evidence_cited',
              ] as const) {
                if (first[k] !== undefined) b[k] = first[k];
              }
            }
          }
        }
        const validation = validateRefinedGoal(briefCandidate);
        if (validation.ok) {
          // ── ADR-042 AC-U2 multi-intent halt-marker veto (2026-07-15) ──
          // Real-world 10-agent scenario #10 found that when the LLM was
          // handed a compound goal ("investigate X AND refactor Y AND ship
          // it"), the refiner correctly RECOGNIZED the conflict and wrote
          // its own halt-signal into the brief:
          //     target: "unspecified — clarifying-Q halt required"
          //     constraints: ["compound goal must be split"]
          // …but then also filled in a guessed `intent` so the brief
          // schema-validated. The loop passed it through unchanged.
          //
          // Detect two halt-marker patterns the refiner uses in practice and
          // veto the brief, promoting to clarify-question halt instead. The
          // brief self-declared it needs a halt; we honour that self-declaration.
          //
          // EXCEPTION: when the brief has a valid `intents[]` array with >=2
          // entries, that IS the correct compound handling (multi-intent
          // path landed 2026-07-15). Skip the veto — the refiner recognized
          // the compound structure AND enriched each sub-intent separately.
          const rg = validation.value;
          const isMultiIntentBrief = Array.isArray(rg.intents) && rg.intents.length >= 2;
          const targetLc = rg.target.toLowerCase();
          const constraintsBlob = rg.constraints.join(' | ').toLowerCase();
          const targetHalt =
            targetLc.startsWith('unspecified') ||
            targetLc.includes('clarifying-q halt required') ||
            targetLc.includes('clarifying question required') ||
            targetLc.includes('halt required');
          const constraintsHalt =
            /compound goal|multi-intent|split.*goal|goal must be split|too many intents/.test(
              constraintsBlob,
            );
          if ((targetHalt || constraintsHalt) && !isMultiIntentBrief) {
            clarifyingQuestion =
              'Stage 1 refiner recognized the goal is compound or ambiguous and marked ' +
              'itself as requiring a clarifying question. Please split the goal into a ' +
              'single intent (investigate | build | review | analyze | refactor | brainstorm | plan | decide) with a specific ' +
              `target, then re-dispatch. (Halt marker: target="${rg.target.slice(0, 80)}"` +
              (constraintsHalt ? `; constraints="${constraintsBlob.slice(0, 120)}"` : '') +
              ')';
          } else {
            refinedGoalJson = JSON.stringify(briefCandidate);
          }
        } else {
          // JSON parsed but failed schema — surface as clarifying question so
          // the user can re-dispatch with sharper input. No re-round.
          clarifyingQuestion =
            'Stage 1 refiner emitted a JSON brief that failed schema validation: ' +
            validation.errors.join('; ') +
            '. Re-dispatch with a sharper goal statement.';
        }
      } else {
        // No JSON brief → treat entire response as a clarifying question.
        clarifyingQuestion = assistantText || '(refiner produced empty response)';
      }
    } else {
      // ── Legacy multi-round SCOPE mini-loop (WI_STAGE1_ENABLED=0 path) ──
      // Preserved verbatim so master-default behavior is unchanged.
      while (scopeIters < scopeMaxIters && !refinedGoalJson && !clarifyingQuestion) {
      // scopeWallclockMs is hoisted above the single/multi-path branch (line 1019)
      // and shared by both paths — `CYPHER_SCOPE_MAX_WALLCLOCK_MS` (default 60s, 0 disables).
      if (scopeWallclockMs > 0 && Date.now() - scopeStartMs > scopeWallclockMs) {
        persistRefinedGoal(opts.db, opts.session_id, null, scopeIters);
        const wallclockHalt: LoopResult = {
          verdict: 'halted',
          surface:
            `SCOPE phase: wall-clock budget (${scopeWallclockMs}ms) exhausted after ` +
            `${scopeIters} iter(s). Re-dispatch with a sharper goal or raise ` +
            `CYPHER_SCOPE_MAX_WALLCLOCK_MS.`,
          session_id: opts.session_id,
          phase: 2,
          plan_shape_hash: '',
          prior_count: 0,
          prior_success_rate: null,
          confirm_mode_used: 'auto',
          engine: 'loop',
          tool_calls: [],
          usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
          duration_ms: Date.now() - scopeStartMs,
        };
        // Close the session on the wall-clock halt path too — parity with the
        // refiner-failed catch below. Without this the session sticks at
        // 'pending' with no cypher_outcomes row (observed cyp_824c94b550e9).
        persistOutcome(opts.db, opts.session_id, wallclockHalt, opts.user);
        return wallclockHalt;
      }
      scopeIters++;
      // Remaining SCOPE budget for this iteration — used to clamp the per-call
      // LLM + tool timeouts so no single await outlives the phase guard.
      // scopeWallclockMs===0 (disabled) → no budget clamp (undefined).
      const scopeBudgetRemainingMs =
        scopeWallclockMs > 0 ? scopeWallclockMs - (Date.now() - scopeStartMs) : undefined;
      let scopeResponse: Anthropic.Beta.PromptCaching.PromptCachingBetaMessage;
      try {
        const scopeParams = bucketCallParams(opts.db, 'decide', 2048);
        scopeResponse = await scopeClient.beta.promptCaching.messages.create({
          ...scopeParams,
          system: [
            { type: 'text', text: refinerSystemPrompt, cache_control: { type: 'ephemeral' } },
          ],
          tools: scopeSdkTools,
          messages: scopeMessages,
        }, { timeout: llmCallTimeoutMs(scopeBudgetRemainingMs) });
      } catch (err) {
        // Refiner call failed — surface as halted (not failed) so the
        // caller can re-dispatch. Single-pass loop will pick up the
        // pieces if the user re-submits.
        const halt: LoopResult = {
          verdict: 'halted',
          surface: `SCOPE phase: refiner call failed at iter ${scopeIters}: ${(err as Error).message}`,
          session_id: opts.session_id,
          phase: 1,
          plan_shape_hash: '',
          prior_count: 0,
          prior_success_rate: null,
          confirm_mode_used: requestedConfirmMode,
          engine: 'loop',
          tool_calls,
          usage: scopeUsage,
          duration_ms: Date.now() - scopeStartMs,
          halt_after_call_id: undefined,
          halt_requested_at: new Date().toISOString(),
        };
        persistRefinedGoal(opts.db, opts.session_id, null, scopeIters);
        persistOutcome(opts.db, opts.session_id, halt, opts.user);
        opts.on_event?.({ type: 'done', verdict: halt.verdict, surface: halt.surface });
        return halt;
      }

      scopeUsage.input_tokens += scopeResponse.usage.input_tokens;
      scopeUsage.output_tokens += scopeResponse.usage.output_tokens;
      scopeUsage.cache_read_tokens += scopeResponse.usage.cache_read_input_tokens ?? 0;
      scopeUsage.cache_write_tokens += scopeResponse.usage.cache_creation_input_tokens ?? 0;
      scopeStopReason = scopeResponse.stop_reason;

      // ADR-039 AC-19a (2026-06-29) — per-phase token telemetry.
      // Write a cypher_steps row tagged phase='scope' for this
      // iteration's refiner call. tokens_used aggregates the input
      // + output tokens of THIS iteration (not the cumulative scope
      // total) so dogfood queries can SUM(tokens_used) WHERE
      // phase='scope' and get an honest per-dispatch total.
      // Best-effort — a missing audit row doesn't derail the dispatch.
      try {
        opts.db.prepare(`
          INSERT INTO cypher_steps (
            session_id, stage, stage_index, status, payload,
            tokens_used, duration_ms, reasoning_trace, controller_model, phase
          ) VALUES (?, 'tool_use', ?, 'completed', ?, ?, 0, NULL, NULL, 'scope')
        `).run(
          opts.session_id,
          scopeIters - 1, // 0-based iter ordinal
          JSON.stringify({ refiner_iter: scopeIters, stop_reason: scopeStopReason }).slice(0, 8000),
          scopeResponse.usage.input_tokens + scopeResponse.usage.output_tokens,
        );
      } catch (insErr) {
        process.stderr.write(
          `[cypher-scope] cypher_steps INSERT failed (non-fatal): ${(insErr as Error).message}\n`,
        );
      }

      // Push assistant turn so the next iter (if any) sees its own
      // tool_use blocks.
      scopeMessages.push({ role: 'assistant', content: scopeResponse.content });

      // Pull the model's text — this is where a refined_goal brief or
      // clarifying question lives.
      const assistantText = scopeResponse.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      // Try to parse the text as a refined_goal JSON brief.
      const briefCandidate = extractJsonBrief(assistantText);
      if (briefCandidate) {
        const validation = validateRefinedGoal(briefCandidate);
        if (validation.ok) {
          refinedGoalJson = JSON.stringify(briefCandidate);
          break;
        }
        // JSON parsed but failed schema — feed the error back and
        // give the model another iteration to fix it.
        scopeMessages.push({
          role: 'user',
          content:
            'Your previous JSON brief failed schema validation: ' +
            validation.errors.join('; ') +
            '. Please correct and re-emit ONLY the JSON object, no preamble.',
        });
        continue;
      }

      // No JSON brief. Did the model want to dispatch tools?
      const toolUses = scopeResponse.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );

      if (toolUses.length === 0) {
        // No JSON, no tool use → clarifying question. Surface it.
        clarifyingQuestion =
          assistantText || '(refiner produced empty response)';
        break;
      }

      // Dispatch scope-eligible tools. Read-only by construction (the
      // catalog filter already excluded mutators) so no permission
      // gate, no boundary check, no parallel/serial partition fuss —
      // just fire them.
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const slot = scopeEligibleTools.find((t) => t.name === tu.name);
        let result: unknown;
        let ok = true;
        try {
          if (!slot) {
            throw new Error(`tool ${tu.name} not in scope catalog`);
          }
          result = await withTimeout(
            slot.handler(
              (tu.input ?? {}) as Record<string, unknown>,
              {
                db: opts.db,
                user: opts.user,
                session_id: opts.session_id,
                palace: opts.palace,
                posture: opts.posture,
                task_class: opts.task_class ?? 'generic',
              },
            ),
            // Clamp to the budget still remaining after the LLM call this
            // iteration — a scope tool dispatch must not outlive the phase
            // guard (the 120s tool default was 2x the 60s SCOPE budget).
            toolCallTimeoutMs(
              scopeWallclockMs > 0 ? scopeWallclockMs - (Date.now() - scopeStartMs) : undefined,
            ),
            tu.name,
          );
        } catch (err) {
          ok = false;
          result = { error: (err as Error).message };
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result).slice(0, 8000),
          is_error: !ok,
        });
      }
      scopeMessages.push({ role: 'user', content: toolResults });
    }
    } // end of `else` block for legacy multi-round path (ADR-042 Stage 1 gate)

    // Scope phase complete — resolve verdict.
    let scopeVerdict: Verdict;
    let scopeSurface: string;
    if (refinedGoalJson) {
      scopeVerdict = 'success';
      scopeSurface = refinedGoalJson;
    } else if (clarifyingQuestion) {
      scopeVerdict = 'halted';
      scopeSurface = clarifyingQuestion;
    } else {
      scopeVerdict = 'halted';
      scopeSurface =
        `SCOPE phase: iteration cap (${scopeMaxIters}) reached without a valid brief. ` +
        `Last stop_reason=${scopeStopReason ?? 'unknown'}. ` +
        `Re-dispatch with a sharper goal or set CYPHER_SCOPE_MAX_ITERS=5.`;
    }

    persistRefinedGoal(opts.db, opts.session_id, refinedGoalJson, scopeIters);

    // ── ADR-043 Phase 3 (Shape A) AC-A1: intent-routing capture ──────────
    // When Stage 1's refined_goal classifies a NON-execute intent
    // (brainstorm|plan|decide), do NOT dispatch Stage 2 — file a PM board
    // card and close the session outcome='captured_to_board'. Dormant
    // unless BOTH WI_STAGE1_ENABLED=1 AND PM_ORCHESTRATION_ENABLED=1 (the
    // ADR-042 dependency gate). shouldCaptureToBoard returns null otherwise,
    // so the loop falls through to EXECUTE exactly as today.
    if (refinedGoalJson) {
      try {
        const { shouldCaptureToBoard, captureToBoard } = await import('./pm-capture-hook.js');
        const decision = shouldCaptureToBoard(refinedGoalJson, opts.goal);
        if (decision) {
          // ── ADR-043 AC-A1 fix (2026-07-24): the capture itself and the
          // persistence step run OUTSIDE the outer try/catch. A capture
          // failure MUST NOT be silently swallowed with fall-through to
          // EXECUTE — that was the 2026-07-17 silent-fail pattern where
          // the user saw a false "captured" surface with no card behind
          // it. If captureToBoard throws, we close the session
          // outcome='halted' with the real error surfaced (see the
          // dedicated catch immediately below).
          let cap: Awaited<ReturnType<typeof captureToBoard>>;
          try {
            cap = captureToBoard(opts.db, decision, opts.task_id ?? undefined);
          } catch (captureErr) {
            const errMsg =
              captureErr instanceof Error ? captureErr.message : String(captureErr);
            process.stderr.write(
              `[cypher-scope] PM capture hook failed (HALT): ${errMsg}\n`,
            );
            const haltResult: LoopResult = {
              verdict: 'halted',
              surface:
                `PM capture failed for intent='${decision.intent}': ${errMsg}. ` +
                `Session not routed to the board — nothing was filed. ` +
                `Re-dispatch after resolving the underlying error.`,
              session_id: opts.session_id,
              phase: 1,
              plan_shape_hash: '',
              prior_count: 0,
              prior_success_rate: null,
              confirm_mode_used: requestedConfirmMode,
              engine: 'loop',
              tool_calls,
              usage: scopeUsage,
              duration_ms: Date.now() - scopeStartMs,
            };
            persistOutcome(opts.db, opts.session_id, haltResult, opts.user);
            opts.on_event?.({
              type: 'done',
              verdict: haltResult.verdict,
              surface: haltResult.surface,
            });
            return haltResult;
          }
          const capturedResult: LoopResult = {
            verdict: 'captured_to_board',
            surface: cap.surface,
            session_id: opts.session_id,
            phase: 1,
            plan_shape_hash: '',
            prior_count: 0,
            prior_success_rate: null,
            confirm_mode_used: requestedConfirmMode,
            engine: 'loop',
            tool_calls,
            usage: scopeUsage,
            duration_ms: Date.now() - scopeStartMs,
            // ADR-043 AC-A1: carry the task_id / card_number so persistOutcome
            // writes cypher_sessions.task_id. Without this, the session closes
            // captured_to_board with task_id NULL (the 2026-07-17 silent bug).
            task_id: cap.task_id,
            card_number: cap.card_number,
          };
          persistOutcome(opts.db, opts.session_id, capturedResult, opts.user);
          opts.on_event?.({
            type: 'done',
            verdict: capturedResult.verdict,
            surface: capturedResult.surface,
          });
          return capturedResult;
        }
      } catch (captureErr) {
        // Best-effort ONLY for the `shouldCaptureToBoard` dynamic-import path
        // — a decision-time failure (import throw, JSON parse) is genuinely
        // non-fatal and can fall through to EXECUTE. captureToBoard()'s own
        // failures are handled by the inner try/catch above (loud HALT), so
        // they never reach this block.
        process.stderr.write(
          `[cypher-scope] PM capture decision failed (non-fatal, fell through to execute): ${(captureErr as Error).message}\n`,
        );
      }
    }

    // ADR-039 AC-12 + AC-19 (2026-06-29) — score the refined_goal
    // brief with QualityScorer when SCOPE produced one. Writes a
    // prompt_outcomes row with session_id linking back to this
    // cypher_sessions row so AC-19's dogfood SQL can count
    // refinement-enabled dispatches. Best-effort: a scorer error
    // never derails the dispatch — worst case is a missing
    // measurement row.
    if (refinedGoalJson && refinerTemplateId != null) {
      try {
        const { QualityScorer } = await import('../../intelligence/quality-scorer.js');
        const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
        if (apiKey) {
          const scorer = new QualityScorer(apiKey, opts.db);
          const parsedBrief = JSON.parse(refinedGoalJson);
          // Fire-and-forget. AC-12's verification only requires that
          // a prompt_outcomes row eventually lands; the dispatch
          // does not wait for the scorer to finish.
          scorer
            .scoreRefinedGoal({
              rawGoal: opts.goal,
              refinedGoal: parsedBrief,
              templateId: refinerTemplateId,
              sessionId: opts.session_id,
              tokensUsed: scopeUsage.input_tokens + scopeUsage.output_tokens,
            })
            .catch((err) => {
              process.stderr.write(
                `[cypher-scope] QualityScorer failed (non-fatal): ${(err as Error).message}\n`,
              );
            });
        }
      } catch (scorerErr) {
        process.stderr.write(
          `[cypher-scope] QualityScorer import failed (non-fatal): ${(scorerErr as Error).message}\n`,
        );
      }
    }

    // ── Recognition-feedback loop (2026-07-17): low-confidence thumbs prompt ──
    // When Stage 1 recognised the goal with LOW confidence (weak or tied
    // candidate field — see stage1.ts computeRecognitionConfidence), surface
    // an advisory feedback prompt naming the top-1 skill. This is
    // NON-BLOCKING by design (user decision 2026-07-16): we emit a
    // `confirm_required` event and append a one-line affordance to the
    // surface, then proceed with the dispatch exactly as before. The user's
    // 👍/👎 reply lands ASYNC via POST /api/cypher/sessions/:id/user-verdict
    // (S3 wires the priors update). Non-interactive callers (cron / MCP)
    // simply never reply → the prompt_outcomes row stays 'unrated'. Nothing
    // here waits, halts, or mutates the verdict.
    //
    // Gated on scopeVerdict==='success' AND a real brief: a halted/failed
    // SCOPE has no dispatch to rate. Best-effort — the surface annotation
    // must never derail the dispatch.
    if (
      stage1Confidence?.confidence === 'low' &&
      stage1Confidence.top_skill &&
      scopeVerdict === 'success' &&
      refinedGoalJson
    ) {
      const topSkill = stage1Confidence.top_skill;
      // Persist the guessed skill so a LATER bare 👎 (verdict without a named
      // skill) can down-weight it. Without this, cypher_sessions.chosen_skill
      // stays NULL on the loop path and recordRecognitionFeedback has nothing
      // to move — the wrong-skill down-weight is a silent no-op unless the user
      // also names the right skill. Best-effort: a write failure must not
      // derail the dispatch (matches the surface annotation's contract).
      try {
        opts.db
          .prepare(`UPDATE cypher_sessions SET chosen_skill = ? WHERE session_id = ?`)
          .run(topSkill, opts.session_id);
      } catch (e) {
        process.stderr.write(
          `[cypher-scope] chosen_skill persist failed (non-fatal): ${(e as Error).message}\n`,
        );
      }
      const feedbackQuestion =
        `Recognition was low-confidence for this goal. Best guess: \`${topSkill}\`. ` +
        `Was that the right call? Reply 👍 (useful) / 👎 (wrong) — or name the skill you'd use — ` +
        `via POST /api/cypher/sessions/${opts.session_id}/user-verdict. ` +
        `This is optional and does not block the dispatch.`;
      try {
        opts.on_event?.({ type: 'confirm_required', question: feedbackQuestion });
      } catch {
        // on_event is best-effort; a sink failure must not derail SCOPE.
      }
      scopeSurface =
        `${scopeSurface}\n\n> ⚠️ Low-confidence recognition — best guess \`${topSkill}\`. ` +
        `Rate it (optional, non-blocking): POST /api/cypher/sessions/${opts.session_id}/user-verdict ` +
        `{ "verdict": "useful" | "wrong_scope", "skill": "<the-right-skill>" }`;
    }

    const scopeResult: LoopResult = {
      verdict: scopeVerdict,
      surface: scopeSurface,
      session_id: opts.session_id,
      phase: 1,
      plan_shape_hash: '',
      prior_count: 0,
      prior_success_rate: null,
      confirm_mode_used: requestedConfirmMode,
      engine: 'loop',
      tool_calls,
      usage: scopeUsage,
      duration_ms: Date.now() - scopeStartMs,
      halt_after_call_id: undefined,
      halt_requested_at:
        scopeVerdict === 'halted' ? new Date().toISOString() : undefined,
    };
    persistOutcome(opts.db, opts.session_id, scopeResult, opts.user);
    opts.on_event?.({
      type: 'done',
      verdict: scopeResult.verdict,
      surface: scopeResult.surface,
    });
    return scopeResult;
  }

  // ── Early-return: confirm_mode='reject' (Q-1.13) ─────────────────────────
  // Capability-probe / dry-run path. No plan render, no tool calls.
  if (requestedConfirmMode === 'reject') {
    const result: LoopResult = {
      verdict: 'rejected_non_interactive',
      surface: '',
      session_id: opts.session_id,
      phase: 1,
      plan_shape_hash: '',
      prior_count: 0,
      prior_success_rate: null,
      confirm_mode_used: 'reject',
      engine: 'loop',
      tool_calls,
      usage,
      duration_ms: Date.now() - startMs,
    };
    persistOutcome(opts.db, opts.session_id, result, opts.user);
    opts.on_event?.({ type: 'done', verdict: result.verdict, surface: result.surface });
    return result;
  }

  // ── Early-return: non-interactive transport without confirm_mode='auto' ──
  // Q-1.13 — n8n / cron / MCP-without-stdin callers cannot answer a
  // Phase 1 confirm prompt. We reject immediately rather than blocking.
  if (!opts.is_interactive && requestedConfirmMode === 'interactive') {
    const result: LoopResult = {
      verdict: 'rejected_non_interactive',
      surface: '',
      session_id: opts.session_id,
      phase: 1,
      plan_shape_hash: '',
      prior_count: 0,
      prior_success_rate: null,
      confirm_mode_used: 'interactive',
      engine: 'loop',
      tool_calls,
      usage,
      duration_ms: Date.now() - startMs,
    };
    persistOutcome(opts.db, opts.session_id, result, opts.user);
    opts.on_event?.({ type: 'done', verdict: result.verdict, surface: result.surface });
    return result;
  }

  // ── Tool selection for the dispatch posture ──────────────────────────────
  const eligibleTools = toolsForPosture(opts.posture);
  if (eligibleTools.length === 0) {
    // Posture filter excluded every tool — misconfiguration, fail closed.
    const result: LoopResult = {
      verdict: 'failed',
      surface: `No tools eligible for posture '${opts.posture}'.`,
      session_id: opts.session_id,
      phase: 1,
      plan_shape_hash: '',
      prior_count: 0,
      prior_success_rate: null,
      confirm_mode_used: requestedConfirmMode,
      engine: 'loop',
      tool_calls,
      usage,
      duration_ms: Date.now() - startMs,
    };
    persistOutcome(opts.db, opts.session_id, result, opts.user);
    opts.on_event?.({ type: 'done', verdict: result.verdict, surface: result.surface });
    return result;
  }

  // ── Prior-snapshot read (D15) ─────────────────────────────────────────────
  // Dispatch-entry placeholder. The plan_shape_hash is only knowable
  // *after* the loop runs (computed from the actual tool-invocation
  // sequence at line ~903 below). At dispatch entry we don't have the
  // hash yet, so this read returns {prior_count: 0, prior_success_rate:
  // null} — the cold-start case.
  //
  // The authoritative posterior read happens post-loop, after planHash
  // is computed but before persistOutcome fires. See the second
  // snapshotPriors call below. The session row's prior_count /
  // prior_success_rate columns get a placeholder write here and an
  // authoritative update post-loop.
  //
  // Fixed 2026-06-24: pre-fix, this single call read with an empty hash
  // and the result was the only value ever written to the session row.
  // Every dispatch surfaced prior_count=0 (737/737 sessions on master at
  // the time of the fix), making the loop's posterior signal broken-on-
  // read. The audit at .planning/audits/2026-06-24-adr-037-5-audit.md
  // surfaced this via the CAP-13 redesign workflow (.planning/
  // cap-13-redesign/SYNTHESIS.md). The fix here is a precondition for
  // any future CAP-13 (α) gap-recognition gate — without it, the gate
  // reads zero priors forever.
  const priorsAtEntry = snapshotPriors(opts.db, opts.user, '');

  // Persist confirm_mode_requested / confirm_mode_used to cypher_sessions.
  // Effective mode: 'auto' or 'reject' pass through; 'interactive' stays
  // 'interactive' (Phase 4 wires actual prompting). Phase 3-D defaults to
  // running the loop body unconditionally — equivalence to Phase 2-soft
  // with zero veto window. Real Phase 1 wait wires into Phase 4 via
  // on_event 'confirm_required' + halt_flag polling.
  const effectiveConfirmMode: ConfirmMode = requestedConfirmMode;
  updateSessionMetadata(opts.db, opts.session_id, {
    confirm_mode_requested: requestedConfirmMode,
    confirm_mode_used: effectiveConfirmMode,
    phase: 2,
    engine: 'loop',
    prior_count: priorsAtEntry.prior_count,
    prior_success_rate: priorsAtEntry.prior_success_rate,
  });

  // ── Loop body (the spike, productionized) ────────────────────────────────
  const client = opts.anthropic_client ?? (await getAnthropicClient());
  // Controller model routes by task_class: routine fetch/summarize/review goals
  // run on the Sonnet-backed `dispatch` bucket; design/debug/plan/write/unknown
  // stay on the Opus-backed `decide` bucket. See pickControllerBucket above.
  const controllerBucket = pickControllerBucket(opts.task_class);
  const params = bucketCallParams(opts.db, controllerBucket);
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: opts.goal },
  ];

  // ADR-038 v2.5 D8 — pre-loop self-assessment per Q-2.5.5. Reads the
  // tiered Beta posterior + recent-10 success rate + failure modes for
  // (posture, task_class, user) and renders the result into the system
  // prompt below. Single indexed SQLite read (< 10ms p95). When
  // CAP13_LITE_ENABLED=0 OR D8 disabled, returns the T3 uniform prior
  // so the system prompt is still well-formed. Wrapped in try/catch so
  // a substrate hiccup never crashes the loop — the loop runs without
  // the self-assessment if anything goes wrong.
  let selfAssessment: ReturnType<typeof selfAssess> | null = null;
  try {
    selfAssessment = selfAssess(opts.db, {
      goal: opts.goal,
      posture: opts.posture,
      user: opts.user,
      task_class: opts.task_class ?? 'generic',
      // plan_shape_hash is only known POST-loop (see loop.ts:316–319);
      // T0 will be skipped here and the tiered fallback (T1→T2→T3) wins.
      // selfAssess() handles the optional field correctly.
    });
    // Shadow-mode logging (v74). Persist the JSON-serialized assessment
    // for offline review per Q-2.5.7 § Soak protocol. Best-effort: a
    // write failure (e.g. column doesn't exist in some forked DB) is
    // logged but never propagated to the loop.
    try {
      opts.db
        .prepare(`UPDATE cypher_sessions SET self_assess_at_entry = ? WHERE session_id = ?`)
        .run(JSON.stringify(selfAssessment), opts.session_id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[cypher-loop] D8 shadow-log write failed:', (err as Error).message);
    }
  } catch (err) {
    // Non-fatal — log and proceed with no assessment. Production rule:
    // the loop must run even when D8 substrate has problems.
    // eslint-disable-next-line no-console
    console.warn('[cypher-loop] D8 self-assessment failed:', (err as Error).message);
  }

  // ADR-038 v2.5 D2 — pre-loop task context injection per Q-2.1. Reads the
  // latest task_contexts row and renders [task-context] block into the system
  // prompt. Also records a task_history entry (outcome='pending', updated at
  // close). Non-fatal: a missing/closed task produces no block.
  let taskContextBlock: ReturnType<typeof loadTaskContext> = null;
  if (opts.task_id) {
    try {
      taskContextBlock = loadTaskContext(opts.db, opts.task_id);
      if (taskContextBlock) {
        recordTaskDispatch(opts.db, opts.task_id, opts.session_id);
      }
    } catch (err) {
      console.warn('[cypher-loop] D2 task-context load failed:', (err as Error).message);
    }
  }

  let surface = '';
  let stopReason: string | null = null;
  let iterations = 0;
  let haltAfterCallId: string | undefined;
  let haltRequestedAt: string | undefined;
  let budgetExhausted = false;
  let errorVerdict: Verdict | null = null;

  // Build the SDK-shaped tool array once. Cache_control on the last entry
  // caches the whole tools block — and since the system prompt is below
  // the 1024-token cache minimum (per spike learnings), the tools array
  // is the only reliably-cacheable prefix.
  const sdkTools: Anthropic.Messages.Tool[] = eligibleTools.map((t, idx) => ({
    name: t.name,
    description: typeof t.description === 'string' ? t.description : '',
    input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
    ...(idx === eligibleTools.length - 1
      ? { cache_control: { type: 'ephemeral' as const } }
      : {}),
  }));

  // Tool dispatch context — passed to every handler invocation.
  const toolCtx = {
    db: opts.db,
    user: opts.user,
    session_id: opts.session_id,
    palace: opts.palace,
    posture: opts.posture,
    task_class: opts.task_class ?? 'generic',
  };

  while (iterations < maxIterations) {
    // Halt-flag check #1 — top of each iteration. Per Q-1.12.
    if (opts.halt_flag.value) {
      haltRequestedAt = new Date().toISOString();
      break;
    }
    // Budget check — wallclock + tokens.
    if (Date.now() - startMs > maxWallclockMs) {
      budgetExhausted = true;
      break;
    }
    if (usage.input_tokens + usage.output_tokens > maxTokens) {
      budgetExhausted = true;
      break;
    }
    iterations++;

    let response: Anthropic.Beta.PromptCaching.PromptCachingBetaMessage;
    try {
      // ADR-038 v2.5 D8 — prepend the self-assessment block to the
      // system prompt when available. The model reads its own track
      // record before deciding what to do. Rendered as a structured
      // text snippet so the model can parse it (matches the shape
      // documented in v2.5-D8-self-model-design.md § Q-2.5.5).
      const selfAssessBlock = selfAssessment
        ? renderSelfAssessmentBlock(selfAssessment)
        : null;
      const taskCtxBlock = taskContextBlock
        ? renderTaskContextBlock(taskContextBlock)
        : null;
      response = await client.beta.promptCaching.messages.create({
        ...params,
        system: [
          ...(selfAssessBlock
            ? [{ type: 'text' as const, text: selfAssessBlock }]
            : []),
          ...(taskCtxBlock
            ? [{ type: 'text' as const, text: taskCtxBlock }]
            : []),
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        tools: sdkTools,
        messages,
      }, { timeout: llmCallTimeoutMs(maxWallclockMs > 0 ? maxWallclockMs - (Date.now() - startMs) : undefined) });
    } catch (err) {
      // Anthropic call failed — surface as failed verdict so the user
      // sees what happened. We don't retry; the loop's budget guards
      // assume monotonic progress.
      errorVerdict = 'failed';
      surface = `Anthropic call failed at iter ${iterations}: ${(err as Error).message}`;
      break;
    }

    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    usage.cache_read_tokens += response.usage.cache_read_input_tokens ?? 0;
    usage.cache_write_tokens += response.usage.cache_creation_input_tokens ?? 0;
    stopReason = response.stop_reason;

    // 2026-06-24 fix: persist this iteration's Anthropic call to token_usage
    // so /cypher/cost can show the loop's per-method spend. Without this, the
    // loop is invisible to cost tracking even when it's firing real Anthropic
    // calls. Matches the `_track` pattern in AIAnalyzer (45+ existing call
    // sites that wrap `messages.create` then call `recordTokenUsage`).
    //
    // method='runLoop' so loop dispatches aggregate into their own row on the
    // /cypher/cost "Top spend by method" panel (independent from cron-driven
    // methods like `updateNotebook` / `extractCalendarFromMessages`).
    //
    // Per-iteration rather than per-dispatch: matches every other call site in
    // the codebase, and surfaces individual expensive iterations in the
    // recent-dispatches ledger so we can spot a runaway iter that drives the
    // dispatch cost up. Cost is one INSERT per iter (cheap; loop maxIterations
    // is ~25, so ≤25 rows per dispatch).
    try {
      const callInputTokens = response.usage.input_tokens;
      const callOutputTokens = response.usage.output_tokens;
      const callCacheRead = response.usage.cache_read_input_tokens ?? 0;
      const callCacheWrite = response.usage.cache_creation_input_tokens ?? 0;
      const callCost = computeCost(
        params.model,
        callInputTokens,
        callOutputTokens,
        callCacheRead,
        callCacheWrite,
      );
      recordTokenUsage(
        opts.db,
        'runLoop',
        params.model,
        callInputTokens,
        callOutputTokens,
        callCacheRead,
        callCacheWrite,
        callCost,
      );
    } catch (trackErr) {
      // Don't let a token_usage write fail the dispatch. Worst case is a
      // missing cost row; the loop's own usage accumulator still has the
      // numbers, and recordOutcomeSignal will see them via the LoopResult.
      // (Same defensive posture as AIAnalyzer._track at analyzer.ts:324.)
      process.stderr.write(
        `[cypher-loop] recordTokenUsage failed (non-fatal): ${(trackErr as Error).message}\n`,
      );
    }

    // Capture any text the model emitted this iteration as a potential
    // surface message. The final iteration's text wins — earlier text
    // is reasoning, the last block is the answer.
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        opts.on_event?.({ type: 'text_delta', text: block.text });
        if (response.stop_reason === 'end_turn') {
          surface = block.text.trim();
        }
      }
    }

    if (response.stop_reason === 'end_turn') break;

    const toolUses = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
    );
    if (toolUses.length === 0) {
      // Model stopped for some reason other than end_turn but didn't
      // request a tool call. Treat as mixed — partial result.
      break;
    }

    // Push the assistant turn so the model sees its own tool_use blocks
    // on the next iteration.
    messages.push({ role: 'assistant', content: response.content });

    // ADR-038 v2.5 D18 — reasoning-trace observability.
    //
    // Extract the model's text block that preceded the tool_use blocks
    // in this iteration. This is the "thinking" the model emitted before
    // picking a tool — without it, "why did Cypher do that?" requires
    // reloading the full conversation. Captured once per iteration and
    // attached to the FIRST tool_use row of the iteration (subsequent
    // rows get NULL — the trace was for the iteration as a whole, not
    // per-tool).
    //
    // Truncated to 4KB per the ADR. Larger reasoning is rare and the
    // cost-of-store quickly outpaces the cost-of-read at debug time.
    let iterationReasoningTrace: string | null = null;
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        iterationReasoningTrace = block.text.slice(0, 4096);
        break; // first text block only — the model emits one big text then tool_uses
      }
    }
    const iterationControllerModel = response.model;

    // ADR-039 T5 (AC-6) — partitioned tool dispatch.
    //
    // The model can emit multiple tool_use blocks per iteration. Pre-T5
    // we awaited them in a sequential for-loop, which serialised reads
    // (palace_search, code_graph_blast_radius, brain_recall, ...)
    // unnecessarily and inflated dispatch wallclock. T5 splits the
    // batch:
    //
    //   parallelGroup  — tools where isToolParallelizable(tool) is true
    //                    (default; pure reads and commutative work).
    //                    Run together via Promise.all.
    //   serialGroup    — tools that declare parallelizable: false
    //                    (state mutators, subprocess spawns, terminal
    //                    writes, halting semantics). Run sequentially
    //                    AFTER the parallel batch.
    //
    // The model never sees the partition: tool_calls, cypher_steps, and
    // the tool_result[] array pushed onto the message history all
    // preserve the original tool_use order. Halt-flag check #2 stays
    // pre-call for the serial batch — a parallel batch in flight can't
    // be preempted, but the outer halt check at the bottom of this
    // iteration short-circuits any subsequent SDK call.
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    let firstToolUseOfIteration = true;

    interface DispatchSlot {
      idx: number;
      tu: Anthropic.Messages.ToolUseBlock;
      tool: ToolDefinition | undefined;
      parallelizable: boolean;
    }
    interface SlotResult {
      ok: boolean;
      result: unknown;
      errMsg: string | undefined;
      duration_ms: number;
    }

    const slots: DispatchSlot[] = toolUses.map((tu, idx) => {
      const tool = eligibleTools.find((t) => t.name === tu.name);
      // Unknown tools default to parallelizable=true so their error
      // gets recorded in the fast batch rather than blocking serial
      // mutators behind a 'not found' error.
      const parallelizable = tool ? isToolParallelizable(tool) : true;
      return { idx, tu, tool, parallelizable };
    });

    const parallelSlots = slots.filter((s) => s.parallelizable);
    const serialSlots = slots.filter((s) => !s.parallelizable);
    const slotResults = new Map<number, SlotResult>();

    const invokeSlot = async (slot: DispatchSlot): Promise<SlotResult> => {
      const callStart = Date.now();
      let ok = true;
      let result: unknown;
      let errMsg: string | undefined;
      // ADR-038 v2.5 D5 — track any grant that auto-approved this call
      // so we can record-use it after the handler runs.
      let matchedGrantId: string | undefined;
      const input = (slot.tu.input ?? {}) as Record<string, unknown>;
      try {
        if (!slot.tool) {
          throw new Error(`unknown tool: ${slot.tu.name}`);
        }
        if (!isToolEligibleForPosture(slot.tool, opts.posture)) {
          throw new Error(
            `tool '${slot.tu.name}' not eligible for posture '${opts.posture}'`,
          );
        }

        // ADR-038 v2.5 D5 — consult the permissions ledger for tier-2
        // tools. Tier 1 = no friction (bypass). Tier 3 = ALWAYS ask
        // (safety floor, ledger ignored). Tier 2 = check the ledger;
        // on match, log auto-approval + record use after the call.
        const riskTier = effectiveRiskTier(slot.tool);
        if (riskTier === 2) {
          try {
            const match = findActiveMatch(opts.db, slot.tu.name, {
              session_id: opts.session_id,
              task_id: opts.task_id,
              // project: not threaded through runLoop today; D3 slice 4+
              // wires it in. project-scoped grants won't auto-approve
              // until then.
            });
            if (match) {
              matchedGrantId = match.id;
              process.stderr.write(
                `[grant-auto-approved] session=${opts.session_id} tool=${slot.tu.name} ` +
                `grant=${match.id} pattern='${match.action_pattern}' scope=${match.scope_kind}\n`
              );
            }
          } catch (gateErr) {
            // Ledger lookup failure must NOT block the tool call.
            process.stderr.write(
              `[grant-gate] lookup failed (non-fatal): ${(gateErr as Error).message}\n`
            );
          }
        }

        // ADR-038 v2.5 D4 — tool-layer boundary enforcement (Gap 19).
        // Before invoking a path-bearing tool, resolve each path
        // argument against the worktree root. On violation: REJECT
        // the call and write boundary_violation to cypher_steps so the
        // audit trail captures the attempt. Today we use process.cwd()
        // as the boundary because per-task worktrees (Gap 8) haven't
        // shipped — that gives us project-root enforcement (no path
        // escape outside the WI repo), which is the safety floor.
        //
        // Heuristic: inspect input fields literally named 'path',
        // 'file_path', or 'file'. Conservative — we don't try to
        // canonicalize every string input. New tools that take paths
        // under different field names won't be enforced until they're
        // either renamed or this list extended; that's a known gap
        // and surfaces in the audit (boundary_violation stays NULL).
        const PATH_FIELDS = ['path', 'file_path', 'file'];
        const boundaryRoot = process.cwd();
        let boundaryViolation: string | undefined;
        let resolvedPathArg: string | undefined;
        for (const field of PATH_FIELDS) {
          const v = input[field];
          if (typeof v !== 'string' || v.length === 0) continue;
          const check = checkBoundary(v, boundaryRoot, { existsOnDisk: false });
          if (!check.ok) {
            boundaryViolation = check.reason;
            resolvedPathArg = check.input;
            break;
          } else {
            resolvedPathArg = check.resolved;
          }
        }
        if (boundaryViolation) {
          // Hard reject. The catch block below records errMsg + result
          // shape; we just throw with a descriptive message.
          throw new Error(
            `boundary_violation:${boundaryViolation} path='${resolvedPathArg}' root='${boundaryRoot}'`
          );
        }

        result = await withTimeout(
          slot.tool.handler(input, toolCtx),
          toolCallTimeoutMs(maxWallclockMs > 0 ? maxWallclockMs - (Date.now() - startMs) : undefined),
          slot.tu.name,
        );

        // ADR-038 v2.5 D5 — audit the use of the matched grant. Done
        // POST-handler so uses_count tracks attempted invocations
        // (same approval, same audit weight regardless of outcome).
        if (matchedGrantId) {
          try {
            recordPermissionUse(
              opts.db,
              matchedGrantId,
              opts.session_id,
              tool_calls.length, // 0-based ordinal of this tool_use
            );
          } catch (useErr) {
            process.stderr.write(
              `[grant-record-use] failed (non-fatal): ${(useErr as Error).message}\n`
            );
          }
        }
      } catch (err) {
        ok = false;
        errMsg = (err as Error).message;
        result = { error: errMsg };
      }
      return {
        ok,
        result,
        errMsg,
        duration_ms: Date.now() - callStart,
      };
    };

    // Halt-flag check #2 — before any tool fires this iteration. If
    // set, both batches are skipped; the outer halt check below
    // (lines ~1072) records bookkeeping and breaks the while loop.
    const haltBeforeDispatch = opts.halt_flag.value;

    if (!haltBeforeDispatch && parallelSlots.length > 0) {
      // Emit started events up front so streaming SSE clients see them
      // before we await the batch.
      for (const slot of parallelSlots) {
        opts.on_event?.({
          type: 'tool_call_started',
          call_id: slot.tu.id,
          name: slot.tu.name,
          input: (slot.tu.input ?? {}) as Record<string, unknown>,
        });
      }
      const results = await Promise.all(parallelSlots.map(invokeSlot));
      for (let i = 0; i < parallelSlots.length; i++) {
        slotResults.set(parallelSlots[i].idx, results[i]);
      }
    }

    if (!haltBeforeDispatch) {
      // Serial batch — halt-aware: re-check before each invocation so
      // a halt that fired during the parallel batch stops further
      // mutators. Preserves the original pre-T5 per-call semantics.
      for (const slot of serialSlots) {
        if (opts.halt_flag.value) {
          break;
        }
        opts.on_event?.({
          type: 'tool_call_started',
          call_id: slot.tu.id,
          name: slot.tu.name,
          input: (slot.tu.input ?? {}) as Record<string, unknown>,
        });
        const r = await invokeSlot(slot);
        slotResults.set(slot.idx, r);
      }
    }

    // Recording pass — iterate slots in ORIGINAL tool_use order so
    // tool_calls, cypher_steps, and toolResults preserve the model's
    // own sequence regardless of which batch each slot ran in.
    for (const slot of slots) {
      const r = slotResults.get(slot.idx);
      if (!r) continue; // slot didn't run (halt or pre-dispatch halt)
      const callId = slot.tu.id;
      const input = (slot.tu.input ?? {}) as Record<string, unknown>;
      const rec: ToolCallRecord = {
        id: callId,
        name: slot.tu.name,
        posture: opts.posture,
        input,
        result: r.result,
        duration_ms: r.duration_ms,
        ok: r.ok,
      };
      if (r.errMsg !== undefined) rec.error = r.errMsg;
      tool_calls.push(rec);

      // ADR-038 v2.5 D18 — persist a cypher_steps row per tool_use so
      // `/wi debug <session_id>` can reconstruct the chain without
      // re-loading the full message history. stage='tool_use' is the
      // loop-specific value added by the v80 CHECK widening. payload
      // captures tool name + (trimmed) input so the row is
      // self-contained for SQL inspection. reasoning_trace lives only
      // on the first tool_use of the iteration (the model emitted ONE
      // text block for the iteration, not per-tool). controller_model
      // is the same model on every row of an iteration — captured per
      // row anyway so future per-tool routing (D15) reads cleanly.
      //
      // The stage_index is monotonic across the dispatch (the order
      // tool_calls were pushed), so SELECT ... ORDER BY stage_index
      // reconstructs the chain.
      try {
        opts.db.prepare(`
          INSERT INTO cypher_steps (
            session_id, stage, stage_index, status, payload,
            tokens_used, duration_ms, reasoning_trace, controller_model, phase
          ) VALUES (?, 'tool_use', ?, ?, ?, 0, ?, ?, ?, 'execute')
        `).run(
          opts.session_id,
          tool_calls.length - 1,   // 0-based ordinal of this tool_use
          r.ok ? 'completed' : 'failed',
          JSON.stringify({ tool: slot.tu.name, input }).slice(0, 8000),
          r.duration_ms,
          firstToolUseOfIteration ? iterationReasoningTrace : null,
          iterationControllerModel,
        );
      } catch (insErr) {
        // Don't let a cypher_steps write fail the dispatch. Worst case
        // is a missing audit row; the loop's own tool_calls accumulator
        // still has the data, surfaced via the LoopResult. Same
        // defensive posture as recordTokenUsage above.
        process.stderr.write(
          `[cypher-loop] cypher_steps insert failed (non-fatal): ${(insErr as Error).message}\n`,
        );
      }
      firstToolUseOfIteration = false;

      opts.on_event?.({
        type: 'tool_call_completed',
        call_id: callId,
        name: slot.tu.name,
        duration_ms: r.duration_ms,
        ok: r.ok,
      });

      // Truncate tool_result content at 8KB — per spike learnings. Bigger
      // payloads bloat the message history without giving the model more
      // useful signal. Handlers SHOULD already trim to ~1KB; this is a
      // backstop.
      toolResults.push({
        type: 'tool_result',
        tool_use_id: callId,
        content: JSON.stringify(r.result).slice(0, 8000),
        is_error: !r.ok,
      });
    }

    // If we broke out of the inner tool loop on halt, propagate to outer.
    // The halt may have fired mid-handler — in that case the inner for-loop
    // exited naturally (no early-break) and haltRequestedAt is still
    // undefined. We set the bookkeeping fields here so verdict resolution
    // sees the halt regardless of which path got us out of the inner loop.
    if (opts.halt_flag.value) {
      if (haltRequestedAt === undefined) {
        haltRequestedAt = new Date().toISOString();
        haltAfterCallId = tool_calls[tool_calls.length - 1]?.id;
      }
      break;
    }

    messages.push({ role: 'user', content: toolResults });

    // ADR-038 v2.5 B1 — in-place compaction (2026-06-28).
    //
    // When the iteration just ran a successful cypher_compact_context
    // call, fold the older middle of `messages` into a synthetic
    // assistant turn so the next iteration sends a shorter prompt to
    // the controller. Before today, the tool returned the Haiku
    // summary but the loop kept every prior assistant + tool_result
    // turn in `messages` — the model could reference the summary but
    // never benefit from a smaller prompt. The 200K cap stayed at
    // risk and tokens kept burning on stale context.
    //
    // Compaction shape (executed only when conditions below hold):
    //
    //   messages[0]                    initial user goal      (keep)
    //   messages[1..N-7]               older assistant/user   (REPLACE)
    //                                  pairs of past iterations
    //   [synthetic assistant turn]     '[compacted: <summary>]'  (insert)
    //   messages[N-6..N-1]             last 3 iter pairs      (keep)
    //
    // Conditions:
    //   (a) the iteration just finished and tool_calls contains a
    //       successful cypher_compact_context call;
    //   (b) the messages array has enough turns that compaction will
    //       actually shrink it. With 1 initial user + last 3 pairs
    //       kept (6 entries) + 1 synthetic assistant (1 entry), the
    //       minimum kept-after-compaction is 8 entries. We require
    //       messages.length > 8 to bother — at exactly 8 (or below),
    //       compaction would no-op or even grow the array.
    //
    // The compaction is best-effort. If anything in the detection or
    // mutation throws, we log and move on — the loop is correct
    // without compaction; this only improves token economy.
    try {
      const lastCompactCall = tool_calls.find(c =>
        c.name === 'cypher_compact_context' && c.ok,
      );
      if (lastCompactCall) {
        const summary = extractCompactSummary(lastCompactCall.result);
        if (summary) {
          const before_len = messages.length;
          const mutated = compactMessagesInPlace(messages, summary);
          if (mutated) {
            process.stderr.write(
              `[cypher-loop] in-place compaction: ${before_len} → ${messages.length} messages\n`,
            );
          }
        }
      }
    } catch (compactErr) {
      process.stderr.write(
        `[cypher-loop] in-place compaction failed (non-fatal): ${(compactErr as Error).message}\n`,
      );
    }

    // ADR-038 v2.5 D7 — dispatch durability snapshot. Persist the
    // current messages array to dispatch_snapshots so a bridge crash
    // mid-dispatch can resume from this iteration's end. Best-effort:
    // a write failure here logs to stderr but does NOT abort the loop.
    // Cleanup runs at the bottom of this function (post-verdict).
    try {
      opts.db.prepare(`
        INSERT INTO dispatch_snapshots (dispatch_id, iter_number, messages_blob, written_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(dispatch_id) DO UPDATE SET
          iter_number = excluded.iter_number,
          messages_blob = excluded.messages_blob,
          written_at = excluded.written_at
      `).run(
        opts.session_id,
        iterations,
        JSON.stringify(messages),
        Date.now(),
      );
    } catch (snapErr) {
      process.stderr.write(
        `[cypher-loop] dispatch_snapshots write failed (non-fatal): ${(snapErr as Error).message}\n`,
      );
    }
  }

  // ── Model-emitted outcome (2026-07-25) ──────────────────────────────────
  //
  // Scan the tool_calls trail for the LAST successful `cypher_record_outcome`
  // invocation. When present, the model has explicitly declared a verdict
  // (via the tool the system prompt at loop.ts:640-654 tells it to call
  // "exactly once before your final message"). Adopt that verdict rather
  // than inferring from stopReason + surface-length — see
  // .planning/execute-no-skill/00-CANDIDATES.md (C1) for the failure mode
  // this cures.
  //
  // The tool handler at tool-catalog.ts:2213 is still a phase-2 stub that
  // discards the input and returns {deferred:'phase-3'} — but the input the
  // model emitted survives on the tool_calls[] record, so we recover the
  // outcome/note here without touching the handler contract. The stub can
  // stay for now; the audit-tail rewrite (C2) is a separate ADR.
  //
  // IGNORED fields on the model's call:
  //   - session_id: the model routinely fills this with 'cyp_current' or
  //     '__SESSION_ID__' — a literal placeholder from the tool description.
  //     The loop knows its own session id (opts.session_id).
  //   - Second and later record_outcome calls: only the LAST one counts;
  //     the description says "call exactly once" but the model has been
  //     observed to redo it. Last-write-wins matches the model's own intent.
  const RECORD_OUTCOME_TOOL = 'cypher_record_outcome';
  const ALLOWED_MODEL_OUTCOMES: readonly Verdict[] = [
    'success', 'mixed', 'failed', 'halted', 'abandoned', 'rejected_non_interactive',
  ];
  let modelVerdict: Verdict | null = null;
  let modelOutcomeNote: string | null = null;
  for (let i = tool_calls.length - 1; i >= 0; i--) {
    const tc = tool_calls[i];
    if (tc.name !== RECORD_OUTCOME_TOOL || !tc.ok) continue;
    const input = tc.input as { outcome?: unknown; note?: unknown };
    const claimed = typeof input.outcome === 'string' ? input.outcome : '';
    if ((ALLOWED_MODEL_OUTCOMES as readonly string[]).includes(claimed)) {
      modelVerdict = claimed as Verdict;
      if (typeof input.note === 'string' && input.note.length > 0) {
        modelOutcomeNote = input.note.slice(0, 4000);
      }
    }
    break;
  }

  // ── Verdict resolution ───────────────────────────────────────────────────
  let verdict: Verdict;
  if (errorVerdict !== null) {
    verdict = errorVerdict;
  } else if (haltRequestedAt !== undefined) {
    verdict = 'halted';
  } else if (budgetExhausted || iterations >= maxIterations) {
    verdict = 'mixed';
    if (!surface) {
      surface = `Budget exhausted after ${iterations} iteration(s); partial results collected.`;
    }
  } else if (modelVerdict !== null) {
    // The model self-declared. Honour it — even when stopReason==='end_turn'
    // with a non-empty surface. Historically (pre-2026-07-25) this branch
    // fell through to `surface.length>0 → 'success'`, which contradicted
    // the model on 10/53 phase=2 "successes" in the corpus. See
    // .planning/execute-no-skill/00-REPRO.md.
    verdict = modelVerdict;
  } else if (stopReason === 'end_turn') {
    verdict = surface.length > 0 ? 'success' : 'mixed';
  } else {
    verdict = 'mixed';
  }

  // Plan-shape hash computed from the actual tool invocation sequence.
  const planHash = planShapeHash(
    opts.posture,
    tool_calls.map((tc) => tc.name),
  );

  // Authoritative posterior read — uses the just-computed planHash, not
  // the empty hash the pre-loop placeholder used. This is the read that
  // CAP-13 (α) and any future plan-shape-aware feature consume. Without
  // this call, cypher_sessions.prior_count and prior_success_rate stay
  // at the zero/null placeholder forever. Fixed 2026-06-24 per the
  // CAP-13 redesign workflow synthesis.
  const priorsAtCompletion = snapshotPriors(opts.db, opts.user, planHash);

  const result: LoopResult = {
    verdict,
    surface,
    session_id: opts.session_id,
    phase: 2,
    plan_shape_hash: planHash,
    prior_count: priorsAtCompletion.prior_count,
    prior_success_rate: priorsAtCompletion.prior_success_rate,
    confirm_mode_used: effectiveConfirmMode,
    engine: 'loop',
    tool_calls,
    usage,
    duration_ms: Date.now() - startMs,
  };
  if (haltAfterCallId !== undefined) result.halt_after_call_id = haltAfterCallId;
  if (haltRequestedAt !== undefined) result.halt_requested_at = haltRequestedAt;
  if (modelOutcomeNote !== null) result.outcome_note = modelOutcomeNote;

  // Persist plan_shape_hash AND the authoritative priors snapshot in one
  // UPDATE. Both columns existed since v67 but only got placeholder
  // values pre-2026-06-24 because the priors read used an empty hash.
  opts.db
    .prepare(
      'UPDATE cypher_sessions SET plan_shape_hash = ?, prior_count = ?, prior_success_rate = ? WHERE session_id = ?',
    )
    .run(
      planHash,
      priorsAtCompletion.prior_count,
      priorsAtCompletion.prior_success_rate,
      opts.session_id,
    );

  // ── CAP-13-LITE recognition hook (ADR-037.5 v2 D3) ───────────────────────
  // Opportunistic gap-recognition write. Gate predicates short-circuit on
  // the cheapest checks first (env disabled / no priors / smoke). Only
  // when all predicates pass do we compute tool_sequence_json + write
  // (PRD H-15). Entire block is try/catch'd — recognition failure must
  // not crash the loop (PRD H-09). See src/services/cypher/cap13-lite.ts
  // for gate logic + .planning/cap-13-alpha-lite/PRD.md § H for ACs.
  try {
    const cap13Config = readCap13Config();
    if (
      shouldRecognizeGap(
        opts.user,
        opts.goal,
        priorsAtCompletion.prior_count,
        priorsAtCompletion.prior_success_rate,
        cap13Config,
      ) &&
      priorsAtCompletion.prior_success_rate !== null
    ) {
      recordPlanShapeGap(opts.db, {
        session_id: opts.session_id,
        plan_shape_hash: planHash,
        posture: opts.posture,
        tool_sequence_json: JSON.stringify(tool_calls.map((tc) => tc.name)),
        goal: opts.goal,
        user: opts.user,
        prior_count: priorsAtCompletion.prior_count,
        prior_success_rate: priorsAtCompletion.prior_success_rate,
        iterations: tool_calls.length,
        verdict: result.verdict,
      });
    }
  } catch (err) {
    process.stderr.write(
      `[cypher-cap13-lite] gap-observe write failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  persistOutcome(opts.db, opts.session_id, result, opts.user);

  // AC-S5 acceptance_text draft — engine-agnostic post-verdict draft.
  // Loop path picks this up via the 2026-07-13 Option-3 extraction
  // (session-close.ts). Fires only on success + review-column task +
  // no existing acceptance_text; best-effort with internal error swallow.
  // Loop deliberately does NOT call recordVerifiedSkillOutcome (option (a)
  // — loop has no chosen_skill semantics; see phase-7 migration plan).
  if (result.verdict === 'success') {
    try {
      await draftAcceptanceText(opts.db, opts.session_id, opts.goal);
    } catch (err) {
      process.stderr.write(
        `[cypher-loop] draftAcceptanceText failed (non-fatal): ${(err as Error).message}\n`,
      );
    }
  }

  // ADR-038 v2.5 D2 — async post-done curation. Fires after persistOutcome
  // so the verdict row exists before the curator may update failure_pattern.
  // setImmediate ensures this never blocks the SSE done event.
  if (opts.task_id && taskContextBlock && result.verdict !== 'halted') {
    setImmediate(() => {
      updateTaskDispatchOutcome(opts.db, opts.task_id!, opts.session_id, result.verdict);
      const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
      if (apiKey) {
        curateTaskContext(opts.db, {
          task_id: opts.task_id!,
          dispatch_id: opts.session_id,
          surface: result.surface,
          verdict: result.verdict,
          existing_context: taskContextBlock!.context,
          anthropic_api_key: apiKey,
          base_url: process.env.ANTHROPIC_BASE_URL,
        }).catch(() => { /* already logged inside curateTaskContext */ });
      }
    });
  }
  // ADR-038 v2.5 D7 — clear the dispatch snapshot now that the verdict
  // is resolved. Whether success/mixed/failed/halted, the dispatch is
  // closed from the loop's perspective and the snapshot is dead weight.
  // Best-effort like the write side.
  try {
    opts.db.prepare(`DELETE FROM dispatch_snapshots WHERE dispatch_id = ?`)
      .run(opts.session_id);
  } catch (delErr) {
    process.stderr.write(
      `[cypher-loop] dispatch_snapshots cleanup failed (non-fatal): ${(delErr as Error).message}\n`,
    );
  }
  opts.on_event?.({ type: 'done', verdict: result.verdict, surface: result.surface });
  return result;
}

// ---------------------------------------------------------------------------
// Internal — session row updates
// ---------------------------------------------------------------------------

interface SessionMetadataUpdate {
  confirm_mode_requested: ConfirmMode;
  confirm_mode_used: ConfirmMode;
  phase: LoopPhase;
  engine: 'loop';
  prior_count: number;
  prior_success_rate: number | null;
}

/**
 * Write the dispatch-entry snapshot to cypher_sessions. Called once
 * per dispatch, before any tool fires. The session row must already
 * exist (the bridge dispatch route inserts it).
 */
function updateSessionMetadata(
  db: Database.Database,
  session_id: string,
  m: SessionMetadataUpdate,
): void {
  db.prepare(
    `UPDATE cypher_sessions
       SET confirm_mode_requested = ?,
           confirm_mode_used = ?,
           phase = ?,
           engine = ?,
           prior_count = ?,
           prior_success_rate = ?
     WHERE session_id = ?`,
  ).run(
    m.confirm_mode_requested,
    m.confirm_mode_used,
    m.phase,
    m.engine,
    m.prior_count,
    m.prior_success_rate,
    session_id,
  );
}

/**
 * Persist the dispatch outcome via the multi-signal ledger.
 *
 * Writes a `verdict` signal row to cypher_outcomes with:
 *   - value: VERDICT_SUCCESS / MIXED / FAILED (numeric Beta-prior signal)
 *   - metadata.verdict: the granular six-token verdict (preserves
 *     halted / abandoned / rejected_non_interactive distinctions until
 *     v68 widens cypher_sessions.outcome too)
 *   - metadata.halt_after_call_id / halt_requested_at when applicable
 *
 * Also updates cypher_sessions to mark the dispatch complete:
 *   - status='done' (terminal status enum value; cypher_sessions.status
 *     already accepts 'done' per v59)
 *   - outcome: success/mixed/failed only (the three pre-v68 tokens);
 *     halted/abandoned/rejected_non_interactive remap to mixed at this
 *     layer until v68 widens the CHECK
 *   - duration_ms / completed_at
 *   - task_id (ADR-043 AC-A1, 2026-07-24): when `result.task_id` is set
 *     — only the capture branch populates it — COALESCE it onto the
 *     session row. Preserves an existing task_id (parent-link case)
 *     because non-null wins in COALESCE only when the column is NULL.
 *
 * Exported so integration tests can drive the outcome-close path
 * without booting the full runLoop.
 */
export function persistOutcome(
  db: Database.Database,
  session_id: string,
  result: LoopResult,
  user: string,
): void {
  const value = verdictValue(result.verdict);
  const metadata: Record<string, unknown> = {
    verdict: result.verdict,
    source: 'cypher-loop',
    iterations: result.tool_calls.length,
    surface_len: result.surface.length,
  };
  if (result.halt_after_call_id !== undefined) {
    metadata.halt_after_call_id = result.halt_after_call_id;
  }
  if (result.halt_requested_at !== undefined) {
    metadata.halt_requested_at = result.halt_requested_at;
  }
  // `created_by` is the user — the verdict signal lives on the session
  // row written by this user, and `recordOutcomeSignal` uses the
  // (session_id, signal_kind, created_by) triple as the idempotency
  // key. The loop writes at most once per dispatch so collisions are
  // impossible in normal operation, but the key prevents double-writes
  // if a caller mistakenly retries.
  //
  // ADR-038 v2.5 D8 — when verdict='failed', classify the failure
  // mode via the Q-2.5.3 heuristic and persist the tag onto
  // cypher_outcomes.failure_pattern (v70 column). This is what
  // cypher.self_assess reads to populate failure_modes[]. The classifier
  // is a pure function; D2's curator will replace it with smarter tags
  // when shipped (same column, no API change).
  const failure_pattern =
    result.verdict === 'failed'
      ? classifyFailure({
          outcome: 'failed',
          outcome_note: null,
          duration_ms: null,
          iterations: result.tool_calls.length,
        })
      : null;
  recordOutcomeSignal(db, {
    session_id,
    signal_kind: 'verdict',
    value,
    weight: 1,
    metadata,
    created_by: `cypher-loop:${user}`,
    failure_pattern,
  });

  // Map the wider Phase 3-D verdict tokens back to the cypher_sessions.outcome
  // CHECK constraint. Halted/abandoned/rejected_non_interactive coalesce to
  // 'mixed' at the session layer; the granular verdict survives in the
  // cypher_outcomes signal metadata above. EXCEPTION (ADR-043 Phase 3 AC-A1):
  // 'captured_to_board' is a distinct lifecycle label (v100 widened the CHECK
  // to admit it) — a capture is NOT a mixed verdict on skill choice (no skill
  // ran), so we preserve it verbatim to keep the Beta priors clean.
  // Verdict → schema-allowed outcome. The cypher_sessions.outcome CHECK
  // constraint accepts: success | mixed | failed | halted | abandoned |
  // rejected_non_interactive | captured_to_board.
  //
  // 2026-07-25 fix (F4 in 02-REVIEW.md): historically this reducer
  // collapsed halted/abandoned/rejected_non_interactive → 'mixed'. That
  // masked the model's own 'halted' verdict — 3 sessions in the B4c
  // bucket had the model say 'halted' and the DB record 'mixed'. Since
  // ALLOWED_MODEL_OUTCOMES (2704) explicitly permits these codes and the
  // schema accepts them, propagate them honestly.
  let sessionOutcome:
    | 'success' | 'mixed' | 'failed' | 'halted'
    | 'abandoned' | 'rejected_non_interactive' | 'captured_to_board';
  switch (result.verdict) {
    case 'success':                   sessionOutcome = 'success'; break;
    case 'failed':                    sessionOutcome = 'failed'; break;
    case 'halted':                    sessionOutcome = 'halted'; break;
    case 'abandoned':                 sessionOutcome = 'abandoned'; break;
    case 'rejected_non_interactive':  sessionOutcome = 'rejected_non_interactive'; break;
    case 'captured_to_board':         sessionOutcome = 'captured_to_board'; break;
    default:                          sessionOutcome = 'mixed';
  }

  // ADR-043 AC-A1 (2026-07-24): the captured branch carries task_id + card_number
  // on LoopResult; write task_id back to cypher_sessions so the session row
  // links to the card. COALESCE preserves a pre-existing task_id (AC-A2
  // parent-link case) rather than overwriting it. Non-capture branches leave
  // result.task_id undefined and the UPDATE below skips the task_id column.
  //
  // 2026-07-25 addition: also write outcome_note when the model emitted one
  // via cypher_record_outcome (see .planning/execute-no-skill/). COALESCE
  // preserves any note already on the row (e.g. from the boot-reaper's
  // 'bridge_restart_during_dispatch' tag) — a completed session's own note
  // shouldn't clobber a lifecycle marker written earlier.
  const noteToWrite = result.outcome_note ?? null;
  if (result.task_id) {
    db.prepare(
      `UPDATE cypher_sessions
         SET status = 'done',
             outcome = ?,
             outcome_note = COALESCE(outcome_note, ?),
             task_id = COALESCE(task_id, ?),
             duration_ms = ?,
             completed_at = datetime('now')
       WHERE session_id = ?`,
    ).run(sessionOutcome, noteToWrite, result.task_id, result.duration_ms, session_id);
  } else {
    db.prepare(
      `UPDATE cypher_sessions
         SET status = 'done',
             outcome = ?,
             outcome_note = COALESCE(outcome_note, ?),
             duration_ms = ?,
             completed_at = datetime('now')
       WHERE session_id = ?`,
    ).run(sessionOutcome, noteToWrite, result.duration_ms, session_id);
  }
}
