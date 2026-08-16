/**
 * Tier 2 — per-bucket model + effort configuration.
 *
 * Six functional buckets across WI's Anthropic API call surface:
 *
 *   fetch    — bulk extraction during sync (action items, summaries, etc.)
 *   digest   — daily/weekly synthesis (digest, notebook, member profile)
 *   chat     — UI chat panel reply (chatWithContext, answerQuestion)
 *   analyse  — Jira analyse + PR review (proposeSolution, reviewPR, the
 *              5-way Promise.allSettled in web-server.js)
 *   decide   — brain decision engine (runDecision)
 *   agents   — background long-running agents (correlation, orchestrator,
 *              alert scoring)
 *
 * Each bucket has a (model, effort, thinking_mode) tuple in `model_config`
 * (schema v52). Defaults are evidence-backed against Anthropic docs (May
 * 2026) — see RECOMMENDED below for the per-bucket reasoning.
 *
 * The user can override any bucket via POST /api/model-config or the
 * /setup/models admin UI; bucket cache TTL is 60s so changes propagate
 * without a bridge restart.
 *
 * This module is the single source of truth — every Anthropic call site
 * across analyzer.ts / web-server.js / agents calls bucketCallParams(...)
 * to get the right shape.
 */

import type Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────────────

export type Bucket = 'fetch' | 'digest' | 'chat' | 'analyse' | 'decide' | 'dispatch' | 'agents' | 'bug-investigator' | 'bug-resolver' | 'persona-extract' | 'pm' | 'architect';

export type ModelId =
  | 'claude-haiku-4-5-20251001'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-8'
  | 'claude-opus-latest';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ThinkingMode = 'off' | 'adaptive';

export interface BucketRow {
  bucket: Bucket;
  model: ModelId;
  effort: Effort;
  thinking_mode: ThinkingMode;
}

// ── Constants — capabilities, prices, recommendations ────────────────────────

/**
 * Per-model capabilities. Drives validation in the POST /api/model-config
 * handler and badges in the UI.
 *
 * Anthropic doc references (fetched 2026-05-31):
 *   - Adaptive thinking support: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
 *   - Effort levels per model: https://platform.claude.com/docs/en/build-with-claude/effort
 *   - Cache minimums: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *
 * Note: Haiku 4.5 does NOT support adaptive thinking. Manual extended
 * thinking is the only option, and we don't expose that — too easy to
 * misconfigure (manual budget_tokens is rejected on Opus 4.8 with a 400).
 */
export const MODEL_CAPS: Record<ModelId, {
  supportsAdaptiveThinking: boolean;
  effortsAvailable: Effort[];
  minCacheTokens: number;
  inputPriceMtok: number;
  outputPriceMtok: number;
}> = {
  'claude-haiku-4-5-20251001': {
    supportsAdaptiveThinking: false,
    effortsAvailable: ['low', 'medium', 'high'],
    minCacheTokens: 4096,
    inputPriceMtok: 1,
    outputPriceMtok: 5,
  },
  'claude-sonnet-4-6': {
    supportsAdaptiveThinking: true,
    effortsAvailable: ['low', 'medium', 'high', 'max'],
    minCacheTokens: 1024,
    inputPriceMtok: 3,
    outputPriceMtok: 15,
  },
  'claude-opus-4-8': {
    supportsAdaptiveThinking: true,
    effortsAvailable: ['low', 'medium', 'high', 'xhigh', 'max'],
    minCacheTokens: 1024,
    inputPriceMtok: 5,
    outputPriceMtok: 25,
  },
  // Model alias — resolves to whatever Opus the gateway currently routes
  // to (`claude-opus-latest`). The LLM gateway rejects versioned Opus IDs
  // versioned Opus IDs like `claude-opus-4-8` for some accounts. Same caps
  // as Opus 4.8 because that's what the alias resolves to today; revisit
  // when the proxy advertises a different default.
  'claude-opus-latest': {
    supportsAdaptiveThinking: true,
    effortsAvailable: ['low', 'medium', 'high', 'xhigh', 'max'],
    minCacheTokens: 1024,
    inputPriceMtok: 5,
    outputPriceMtok: 25,
  },
};

/**
 * Default max_tokens per effort tier. Bucket call sites can override per
 * call if they have a specific output expectation (e.g. the Jira analyse
 * tool_use schema needs a known floor).
 *
 * Anthropic guidance: "When running at xhigh or max effort, set a large
 * max_tokens so the model has room to think and act across subagents and
 * tool calls. Starting at 64k tokens and tuning from there is a reasonable
 * default." We use lower floors here because WI calls have bounded output
 * expectations and we don't want runaway billing.
 */
export const EFFORT_MAX_TOKENS: Record<Effort, number> = {
  low:    1024,
  medium: 4096,
  high:   8192,
  xhigh:  16384,
  max:    32000,
};

/**
 * Evidence-backed defaults. Each row cites the Anthropic doc claim that
 * supports the recommendation; the UI surfaces `reason` and `doc_url`
 * to help the user understand why we picked what we picked. See
 * .claude/plans/dapper-plotting-dawn.md for the full evidence section.
 */
export const RECOMMENDED: Record<Bucket, {
  model: ModelId;
  effort: Effort;
  thinking_mode: ThinkingMode;
  reason: string;
  doc_url: string;
  preamble: string;
  fallbackChain: string[];
}> = {
  fetch: {
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    thinking_mode: 'off',
    reason: 'High-volume structured-output extraction; max effort can lead to overthinking on this shape (per Anthropic effort docs)',
    doc_url: 'https://platform.claude.com/docs/en/build-with-claude/effort#when-to-adjust-the-effort-parameter',
    preamble: 'Task: retrieve information from local sources (messages, code, Jira, teams). Return structured data, no commentary.',
    fallbackChain: ['haiku', 'haiku', 'opus'],
  },
  digest: {
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    thinking_mode: 'off',
    reason: 'Anthropic\'s recommended default for Sonnet 4.6: "best balance of speed, cost, and performance". thinking_mode=off because every digest call site uses tool_choice to force structured output (`generate_digest`, `build_notebook`); Anthropic rejects HTTP 400 with "Thinking may not be enabled when tool_choice forces tool use" when `thinking` and forced `tool_choice` are combined.',
    doc_url: 'https://platform.claude.com/docs/en/build-with-claude/effort#recommended-effort-levels-for-sonnet-4-6',
    preamble: 'Task: summarize and condense information. Return concise structured digests.',
    fallbackChain: ['sonnet', 'opus'],
  },
  chat: {
    model: 'claude-opus-latest',
    effort: 'high',
    thinking_mode: 'off',
    reason: 'High effort = "complex reasoning, nuanced analysis"; max would overspend per-turn for routine chat. Alias `claude-opus-latest` resolves to the proxy\'s current Opus default. thinking_mode=off because the chat call sites use tool_choice to force `chat_response` / `answer_question` — Anthropic rejects HTTP 400 with "Thinking may not be enabled when tool_choice forces tool use" when `thinking` and forced `tool_choice` are combined.',
    doc_url: 'https://platform.claude.com/docs/en/build-with-claude/effort#when-to-adjust-the-effort-parameter',
    preamble: 'Task: engage in natural language conversation. Be helpful and direct.',
    fallbackChain: ['opus', 'sonnet'],
  },
  analyse: {
    model: 'claude-opus-latest',
    effort: 'max',
    thinking_mode: 'off',
    reason: 'User-triggered multi-step analysis with linked context; max + 64k max_tokens is Anthropic\'s starting point for agentic work. Alias `claude-opus-latest` resolves to the gateway\'s current Opus default. thinking_mode=off because the analyse call sites use tool_choice to force structured output (`extract_action_items`, `extract_summary`, `propose_solution`, etc) — Anthropic rejects HTTP 400 with "Thinking may not be enabled when tool_choice forces tool use" when `thinking` and forced `tool_choice` are combined.',
    doc_url: 'https://platform.claude.com/docs/en/build-with-claude/effort#recommended-effort-levels-for-claude-opus-4-8',
    preamble: 'Task: analyze data deeply. Return analytical insights with evidence citations.',
    fallbackChain: ['opus', 'sonnet'],
  },
  decide: {
    model: 'claude-opus-latest',
    effort: 'max',
    thinking_mode: 'off',
    reason: 'Agentic loop (recall + cluster + verify). Alias `claude-opus-latest` resolves to the gateway\'s current Opus default. thinking_mode=off because the decide call sites use tool_choice to force structured output — Anthropic rejects HTTP 400 with "Thinking may not be enabled when tool_choice forces tool use" when `thinking` and forced `tool_choice` are combined. (Adaptive thinking is the right default once we have a `thinking + free-form output` call site; today every call site uses tool_choice.)',
    doc_url: 'https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking#how-adaptive-thinking-works',
    preamble: 'Task: make decisions based on evidence. Return a single decision with rationale.',
    fallbackChain: ['opus', 'sonnet', 'haiku'],
  },
  dispatch: {
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    thinking_mode: 'off',
    reason: 'Routine /wi agentic loop — fetch/summarize/review/lookup goals. Retrieval + faithful synthesis over already-stored context, no novel plan reasoning; Sonnet 4.6 is Anthropic\'s "best balance of speed, cost, and performance" for this shape. The controller router in cypher/loop.ts routes fetch-summarize-review task_classes here and leaves design/debug/plan/write/unknown on the Opus-backed `decide` bucket. thinking_mode=off because the loop uses tool_choice to drive tool selection — Anthropic rejects adaptive thinking + forced tool_choice with HTTP 400.',
    doc_url: 'https://platform.claude.com/docs/en/build-with-claude/effort#recommended-effort-levels-for-sonnet-4-6',
    preamble: 'Task: dispatch skill subagent. Execute the requested skill and report results.',
    fallbackChain: ['sonnet', 'haiku'],
  },
  agents: {
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    thinking_mode: 'off',
    reason: 'Continuous classifier load; opus would 15-25x cost with no quality benefit on score_severity-style tasks',
    doc_url: 'https://platform.claude.com/docs/en/build-with-claude/effort#when-to-adjust-the-effort-parameter',
    preamble: 'Task: execute autonomous multi-step workflow. Use available tools, report completion.',
    fallbackChain: ['haiku', 'haiku', 'sonnet'],
  },
  'bug-investigator': {
    model: 'claude-opus-latest',
    effort: 'max',
    thinking_mode: 'off',
    reason: 'ADR-030 Phase B BugInvestigatorAgent — multi-step structured output (root_cause + files_to_change + suggested_patch). Uses tool_choice to force `propose_investigation` — Anthropic rejects adaptive thinking + forced tool_choice combo with HTTP 400 ("Thinking may not be enabled when tool_choice forces tool use"), so thinking_mode stays `off`. Alias `claude-opus-latest` resolves to the gateway\'s current Opus default. Mid-volume — capped per-hour by BUG_INVESTIGATOR_MAX_PER_HOUR=10 in code, not at the SQL layer.',
    doc_url: 'https://platform.claude.com/docs/en/build-with-claude/effort#recommended-effort-levels-for-claude-opus-4-8',
    preamble: 'Task: investigate bugs. Find root cause, collect evidence, report findings.',
    fallbackChain: ['opus', 'haiku'],
  },
  'bug-resolver': {
    model: 'claude-opus-latest',
    effort: 'max',
    thinking_mode: 'off',
    reason: 'ADR-030 Phase C BugResolverAgent — RESERVED for Phase 77 brain-escalation. Phase 76 does not call the brain; it just applies the existing `suggested_patch` from the Phase B investigation. The bucket is seeded so the /setup/models admin UI surfaces it and §16 smoke can count 8 buckets. When Phase 77 wires brain-escalation in, the call site will use tool_choice to force structured output, so thinking_mode stays `off` for the same Anthropic 400 reason as the investigator bucket.',
    doc_url: 'https://platform.claude.com/docs/en/build-with-claude/effort#recommended-effort-levels-for-claude-opus-4-8',
    preamble: 'Task: resolve bugs. Apply fixes, verify resolution.',
    fallbackChain: ['opus', 'sonnet'],
  },
  'persona-extract': {
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    thinking_mode: 'off',
    reason: 'ADR-032 Phase 80 wave 77a-03 (canonical-prose extractor) + 77b (cluster + lesson_candidate emission). Bulk structured-output extraction over markdown / review comments — same shape as the `fetch` bucket but lives under its own name so the /setup/models admin UI can surface it independently and per-bucket cost tracking attributes persona-loop spend to the persona surface, not the sync surface. Uses tool_choice to force structured output (`extract_lesson_candidate` / `cluster_review_comments`), so thinking_mode stays `off` for the same Anthropic 400 reason as the other tool_choice-forced buckets.',
    doc_url: 'https://platform.claude.com/docs/en/build-with-claude/effort#when-to-adjust-the-effort-parameter',
    preamble: 'Task: extract persona attributes from conversation. Return structured persona data.',
    fallbackChain: ['haiku', 'haiku'],
  },
  pm: {
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    thinking_mode: 'off',
    reason: 'ADR-053 PM orchestrator — plan assembly and coordination. Safe default is Sonnet 4.6 per bridge standard (balance of speed/cost/perf). PM tier uses structured tool outputs; thinking_mode stays off to avoid 400 when tool_choice is forced.',
    doc_url: 'https://platform.claude.com/docs/en/build-with-claude/effort#recommended-effort-levels-for-sonnet-4-6',
    preamble: 'Task: plan and coordinate project management work. Return structured plans.',
    fallbackChain: [],
  },
  architect: {
    model: 'claude-opus-latest',
    effort: 'high',
    thinking_mode: 'off',
    reason: 'ADR-053 Architect reviewer — low-frequency, high-judgment verification of PM drafts. Opus is appropriate; called ≤1×/goal.',
    doc_url: 'https://platform.claude.com/docs/en/build-with-claude/effort#recommended-effort-levels-for-claude-opus-4-8',
    preamble: 'Task: review architectural designs. Return structured review with recommendations.',
    fallbackChain: [],
  },
};

export const ALL_BUCKETS: Bucket[] = ['fetch', 'digest', 'chat', 'analyse', 'decide', 'dispatch', 'agents', 'bug-investigator', 'bug-resolver', 'persona-extract', 'pm', 'architect'];
export const ALL_MODELS: ModelId[] = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-latest'];
export const ALL_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const ALL_THINKING_MODES: ThinkingMode[] = ['off', 'adaptive'];

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Returns null if the (model, effort, thinking_mode) tuple is valid for
 * that model, or an error string explaining what's wrong. Used by the
 * POST /api/model-config handler.
 */
export function validateBucketConfig(model: ModelId, effort: Effort, thinking_mode: ThinkingMode): string | null {
  const caps = MODEL_CAPS[model];
  if (!caps) return `Unknown model '${model}'`;
  if (!caps.effortsAvailable.includes(effort)) {
    return `Effort '${effort}' is not available on ${model}; supported: ${caps.effortsAvailable.join(', ')}`;
  }
  if (thinking_mode === 'adaptive' && !caps.supportsAdaptiveThinking) {
    return `Adaptive thinking is not supported on ${model}; set thinking_mode to 'off'`;
  }
  return null;
}

// ── Cache + accessors ────────────────────────────────────────────────────────

const TTL_MS = 60_000;

let cache: Map<Bucket, BucketRow> | null = null;
let cacheLoadedAt = 0;

function loadCache(db: Database.Database): Map<Bucket, BucketRow> {
  const fresh = new Map<Bucket, BucketRow>();
  try {
    const rows = db.prepare(
      'SELECT bucket, model, effort, thinking_mode FROM model_config',
    ).all() as Array<{ bucket: string; model: string; effort: string; thinking_mode: string }>;
    for (const r of rows) {
      // Defensive cast — DB stores TEXT, we trust the migration seeded valid values
      // and the POST handler validates user updates.
      fresh.set(r.bucket as Bucket, {
        bucket: r.bucket as Bucket,
        model: r.model as ModelId,
        effort: r.effort as Effort,
        thinking_mode: r.thinking_mode as ThinkingMode,
      });
    }
  } catch (err) {
    // Schema gap or migration not applied yet — fall back to RECOMMENDED.
    // Fresh-install path on first boot before applyMigrations runs lands here.
    process.stderr.write(`[model-config] cache load failed (${(err as Error).message}) — using RECOMMENDED defaults\n`);
  }
  return fresh;
}

function getCache(db: Database.Database): Map<Bucket, BucketRow> {
  if (!cache || Date.now() - cacheLoadedAt > TTL_MS) {
    cache = loadCache(db);
    cacheLoadedAt = Date.now();
  }
  return cache;
}

/**
 * Invalidates the bucket cache. Call after writing to model_config so the
 * next request picks up the new values without waiting for the 60s TTL.
 */
export function invalidateBucketCache(): void {
  cache = null;
  cacheLoadedAt = 0;
}

/**
 * Returns the resolved config for a bucket — either the row stored in
 * model_config or the RECOMMENDED default if the row is missing.
 *
 * Never throws. Defensive against schema-gap (migration hasn't run yet)
 * and missing-row (partial DB state).
 */
export function getBucketConfig(db: Database.Database, bucket: Bucket): BucketRow {
  const c = getCache(db);
  const stored = c.get(bucket);
  if (stored) return stored;
  const rec = RECOMMENDED[bucket];
  return {
    bucket,
    model: rec.model,
    effort: rec.effort,
    thinking_mode: rec.thinking_mode,
  };
}

/**
 * Builds the Anthropic call params for a bucket.
 *
 * Returns the right shape for the configured (model, effort, thinking_mode):
 *   - Haiku: { model, max_tokens, output_config: {effort} } — no thinking key
 *   - Sonnet/Opus with thinking off: same shape as haiku
 *   - Sonnet/Opus with thinking adaptive: + thinking: {type: 'adaptive'}
 *
 * Per-call `maxTokensOverride` wins over the bucket's effort-derived ceiling
 * — so a one-off skill that needs a bigger output ceiling can pass it
 * without re-configuring the bucket.
 */
export function bucketCallParams(
  db: Database.Database,
  bucket: Bucket,
  maxTokensOverride?: number,
): {
  model: ModelId;
  max_tokens: number;
  output_config: { effort: Effort };
  thinking?: { type: 'adaptive' };
} {
  const cfg = getBucketConfig(db, bucket);
  const params: ReturnType<typeof bucketCallParams> = {
    model: cfg.model,
    max_tokens: maxTokensOverride ?? EFFORT_MAX_TOKENS[cfg.effort],
    output_config: { effort: cfg.effort },
  };
  if (cfg.thinking_mode === 'adaptive' && MODEL_CAPS[cfg.model].supportsAdaptiveThinking) {
    params.thinking = { type: 'adaptive' };
  }
  return params;
}

// ── DB helpers (for the REST handler) ────────────────────────────────────────

/**
 * Returns all six bucket rows. If a bucket is missing from the DB, returns
 * the RECOMMENDED default in its place — so the response is always full
 * even on a fresh / partial DB.
 */
export function listBucketConfigs(db: Database.Database): BucketRow[] {
  return ALL_BUCKETS.map(b => getBucketConfig(db, b));
}

/**
 * Upsert one bucket config row. Validates the (model, effort, thinking_mode)
 * combination first; throws if invalid.
 */
export function upsertBucketConfig(db: Database.Database, row: BucketRow): void {
  const err = validateBucketConfig(row.model, row.effort, row.thinking_mode);
  if (err) throw new Error(err);
  if (!ALL_BUCKETS.includes(row.bucket)) throw new Error(`Unknown bucket '${row.bucket}'`);

  db.prepare(
    `INSERT INTO model_config (bucket, model, effort, thinking_mode, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(bucket) DO UPDATE SET
       model = excluded.model,
       effort = excluded.effort,
       thinking_mode = excluded.thinking_mode,
       updated_at = datetime('now')`,
  ).run(row.bucket, row.model, row.effort, row.thinking_mode);

  invalidateBucketCache();
}

// ── CAP-11 preamble builder ──────────────────────────────────────────────────

/**
 * Returns the preamble string for a bucket. If the bucket is unknown or has
 * no preamble configured, returns an empty string.
 */
export function buildPreamble(bucket: string): string {
  const rec = RECOMMENDED[bucket as Bucket];
  return rec?.preamble ?? '';
}

// ── Per-bucket fallback chains ───────────────────────────────────────────────

/**
 * Returns the fallback chain for a bucket — a list of bucket names to try
 * if the primary model call fails. If the bucket is unknown or has no
 * fallback chain configured, returns an empty array.
 *
 * The caller is responsible for iterating the chain; this module stores
 * the chain and provides lookups only. No retry or internal try-once logic.
 */
export function getFallbackChain(bucket: string): string[] {
  const rec = RECOMMENDED[bucket as Bucket];
  return rec?.fallbackChain ?? [];
}
