/**
 * Decision engine — Pillar 1 of Unified Brain (ADR-024 / Phase 69-05).
 *
 * Implements `runDecision({db, question, user, context, consumer, client})`:
 *   1. Derives `cache_key = sha256(normalizeQuestion(question) \x1f user \x1f utcDayIso())`
 *      using the LOCKED formula from ADR-024 lines 248–268.
 *   2. Looks up an existing decision via the LOCKED single-column SELECT
 *      `WHERE cache_key = ? LIMIT 1` (ADR-024 lines 276–281). NO multi-column
 *      WHERE; the UNIQUE index on cache_key is the only path used.
 *   3. On HIT: hydrates and returns the prior decision (cache_hit: true).
 *      `alternatives` is returned as `[]` because the locked schema does not
 *      persist it — only the pinned set { id, decision, rationale, confidence,
 *      evidence, next_actions, outcome, created_at } is durable. This is
 *      intentional: cross-consumer cache hits remain byte-stable.
 *   4. On MISS: enforces the per-user daily budget BEFORE invoking
 *      `brainToolCall`; on budget rejection throws `BudgetExceededError`.
 *      Otherwise calls Claude Sonnet via the locked wrapper, persists with
 *      the LOCKED INSERT shape (ADR-024 lines 285–290), and records spend.
 *
 * Boundary: this module imports `brainToolCall`. It does NOT import
 * `src/services/analyzer.ts` (`AIAnalyzer`) — see ADR-024 lines 78–122.
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { brainToolCall } from './anthropic-tool-use.js';
import {
  BudgetExceededError,
  checkDailyBudget,
  recordSpend,
} from './budget.js';
import type { PalaceClient } from '../../intelligence/palace-client.js';
import { buildBrainContext, type BrainContext } from './context-builder.js';
import {
  BRAIN_EVIDENCE_TOOL_ITEM,
  coerceEvidenceForPersist,
  parseEvidenceJson,
  toUiEvidence,
  type BrainEvidenceUi,
} from './evidence-schema.js';
import { augmentMemoryRelevant, DECIDE_RECALL_LIMIT } from './recall-context.js';

// ---------- Locked cache_key derivation (ADR-024 lines 248–268) ------------

const SEP = '\x1f'; // ASCII unit separator — non-printable, never appears in normalized inputs

function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

function utcDayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function brainCacheKey(question: string, user: string, dayIso: string): string {
  return createHash('sha256')
    .update(`${normalizeQuestion(question)}${SEP}${user}${SEP}${dayIso}`)
    .digest('hex');
}

// ---------- Public types ---------------------------------------------------

export type Consumer = 'ui' | 'atlas' | 'mcp';

export interface DecisionContext {
  [key: string]: unknown;
}

export interface DecisionInput {
  decision: string;
  rationale: string;
  confidence: number;
  evidence: Array<Record<string, unknown> | string>;
  next_actions: string[];
  alternatives: string[];
}

export interface DecisionResult {
  cache_hit: boolean;
  decision_id: string;
  decision: string;
  rationale: string | null;
  confidence: number | null;
  evidence: BrainEvidenceUi[];
  next_actions: string[];
  alternatives: string[]; // [] on cache hit (not persisted)
  outcome: string;
  created_at: number;
}

/**
 * OP-7 / U-3: stage progress callback. The streaming endpoint passes one of
 * these so the UI can show "Loading context… → Asking the brain…" instead of
 * 5–25 seconds of silence. Non-streaming callers pass nothing.
 */
export type DecisionStage =
  | 'cache_lookup'
  | 'cache_hit'
  | 'budget_check'
  | 'thinking'
  | 'persisting'
  | 'done';

export type OnStage = (stage: DecisionStage, meta?: Record<string, unknown>) => void;

export interface RunDecisionArgs {
  db: Database.Database;
  question: string;
  user: string;
  context?: DecisionContext;
  /** MemPalace client — enables automatic recall in operational context. */
  palace?: PalaceClient | null;
  consumer: Consumer;
  client?: Anthropic; // optional — constructed from env when omitted
  onStage?: OnStage;  // optional progress sink (no-op when absent)
}

// ---------- Anthropic client construction (mirrors AIAnalyzer pattern) -----

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  // .claude/rules/web-server.md: when ANTHROPIC_BASE_URL is set, use 'x-proxy'
  // sentinel apiKey + Bearer Authorization header. Do NOT set x-api-key — the
  // newer SDK rejects empty x-api-key when proxy is active.
  return new Anthropic({
    apiKey: baseURL ? 'x-proxy' : apiKey,
    ...(baseURL
      ? {
          baseURL,
          defaultHeaders: { Authorization: `Bearer ${apiKey}` },
        }
      : {}),
  });
}

// ---------- Tool schema for Claude tool-use --------------------------------

const DECISION_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    decision: { type: 'string', description: 'The recommended decision in 1-2 sentences.' },
    rationale: { type: 'string', description: 'Why this decision over alternatives.' },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Confidence in the decision, 0.0–1.0.',
    },
    evidence: {
      type: 'array',
      items: BRAIN_EVIDENCE_TOOL_ITEM,
      description:
        'Structured evidence: source + source_id + snippet (+ optional url, timestamp). Prefer jira keys, PR refs, and links from context.',
    },
    next_actions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Concrete next actions the user should take.',
    },
    alternatives: {
      type: 'array',
      items: { type: 'string' },
      description: 'Other options considered and why they ranked lower.',
    },
  },
  required: ['decision', 'rationale', 'confidence', 'evidence', 'next_actions', 'alternatives'],
};

const SYSTEM_PROMPT = `You are the decision pillar of the Unified Brain for a developer-productivity assistant.

Given a user question and structured context (sprint state, stuck tickets, calendar, open investigations, recent memories), return ONE structured decision via the emit_decision tool.

Constraints:
- decision: one concrete recommendation, 1–2 sentences, action-oriented.
- rationale: why this beats the alternatives, citing the strongest evidence.
- confidence: 0.0–1.0 reflecting evidence quality (NOT how forceful the recommendation sounds).
- evidence: structured items (source, source_id, snippet, optional url/timestamp), each grounded in context.
- next_actions: imperative, completable today.
- alternatives: other options you considered, briefly explaining why they ranked lower.

You MUST call the emit_decision tool exactly once. Do not return free-form text.`;

// ---------- ULID-ish id (no ulid package; use UUID-derived 26-char base32) -

function decId(): string {
  // Crockford-style: take UUID hex, uppercase, slice to 26 chars, prefix "dec_".
  // Not strictly monotonic but unique and 26 chars matches ULID width — the
  // plan permits this fallback when `ulid` is not in package.json.
  const hex = randomUUID().replace(/-/g, '').toUpperCase().slice(0, 26);
  return `dec_${hex}`;
}

// ---------- runDecision ----------------------------------------------------

interface CacheRow {
  id: string;
  question: string;
  decision: string;
  rationale: string | null;
  confidence: number | null;
  evidence_json: string | null;
  next_actions_json: string | null;
  outcome: string | null;
  created_at: number;
}

function safeJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function evidenceFromJson(s: string | null | undefined): BrainEvidenceUi[] {
  return toUiEvidence(parseEvidenceJson(s));
}

function isBrainContextShape(value: unknown): value is BrainContext {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    Array.isArray(o.stuck_jiras) &&
    Array.isArray(o.memory_relevant) &&
    Array.isArray(o.stale_warnings)
  );
}

/** Build or merge 7-field context and fill memory_relevant via recallMemory(). */
async function resolveOperationalContext(args: {
  db: Database.Database;
  user: string;
  question: string;
  context?: DecisionContext;
  palace: PalaceClient | null;
}): Promise<BrainContext> {
  let base: BrainContext;
  if (isBrainContextShape(args.context)) {
    base = args.context;
  } else {
    base = await buildBrainContext(args.db, args.user, { palace: args.palace });
    if (args.context && typeof args.context === 'object') {
      base = { ...base, ...(args.context as Partial<BrainContext>) };
    }
  }
  return augmentMemoryRelevant(base, {
    db: args.db,
    palace: args.palace,
    extraPattern: args.question,
    limit: DECIDE_RECALL_LIMIT,
  });
}

// ---------- Phase 79-02: freshness guard -----------------------------------

const STOPWORDS = new Set([
  'what','how','when','where','why','who','which','the','and','for','with',
  'that','this','from','into','about','should','could','would','have','does',
  'is','it','a','an','of','to','on','in','at','by','be','are','was','were',
]);

/**
 * Phase 79-02: freshness guard for same-day cache hits.
 *
 * cache_key is (question, user, utcDay) — same-day repeats return the cached
 * answer even if newer evidence has landed. Checks whether any of these stores
 * have rows newer than the cache row's created_at:
 *   - topic_notebooks.last_updated
 *   - brain_verifications.checked_at (for matching claim keywords)
 *
 * Returns true if the cache should be BYPASSED and re-computed.
 * Best-effort: any error → false (keep the cache hit, don't fail-loud).
 */
export function hasNewerRelatedEvidence(
  db: Database.Database,
  cachedRow: CacheRow,
): boolean {
  try {
    const cachedAt = cachedRow.created_at;
    // F4 fix: extract keywords from the ORIGINAL user question, not the LLM's
    // decision text. Generic decision output ("Proceed with recommended approach")
    // washes out domain terms — the question ("search proxy 401 errors?") carries
    // the recall signal. Fall back to decision text if question is empty (defensive).
    const question = (cachedRow.question || cachedRow.decision || '').toLowerCase();
    const keywords = question
      .split(/\W+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
      .slice(0, 5);
    if (keywords.length === 0) return false;

    const likePatterns = keywords.map((k) => `%${k}%`);

    // Notebook freshness: any topic notebook updated after cachedAt
    // whose name or content matches at least one keyword.
    const notebookHit = db.prepare(
      `SELECT 1 FROM topic_notebooks
        WHERE strftime('%s', last_updated) * 1000 > ?
          AND (${keywords.map(() => `(lower(topic_name) LIKE ? OR lower(content) LIKE ?)`).join(' OR ')})
        LIMIT 1`,
    ).get(cachedAt, ...likePatterns.flatMap((p) => [p, p])) as { 1: number } | undefined;
    if (notebookHit) return true;

    // Verification freshness: any verification newer than cache row.
    // brain_verifications uses checked_at (INTEGER epoch ms).
    const verifyHit = db.prepare(
      `SELECT 1 FROM brain_verifications
        WHERE checked_at > ?
          AND (${keywords.map(() => `lower(claim) LIKE ?`).join(' OR ')})
        LIMIT 1`,
    ).get(cachedAt, ...likePatterns) as { 1: number } | undefined;
    if (verifyHit) return true;

    return false;
  } catch (err) {
    console.error('[brain/decision-engine] freshness guard error (keeping cache):', err);
    return false;
  }
}

export async function runDecision(args: RunDecisionArgs): Promise<DecisionResult> {
  const { db, question, user, consumer, onStage } = args;
  const emit: OnStage = onStage ?? (() => {});
  const dayIsoUtc = utcDayIso();
  const cacheKey = brainCacheKey(question, user, dayIsoUtc);

  emit('cache_lookup');

  // Locked cache lookup — single-column WHERE, UNIQUE index on cache_key.
  const hit = db
    .prepare(
      `SELECT id, question, decision, rationale, confidence, evidence_json, next_actions_json, outcome, created_at
       FROM brain_decisions
       WHERE cache_key = ?
       LIMIT 1`,
    )
    .get(cacheKey) as CacheRow | undefined;

  if (hit) {
    // Phase 79-02: bypass cache if newer evidence landed since this hit.
    if (!hasNewerRelatedEvidence(db, hit)) {
      emit('cache_hit', { decision_id: hit.id });
      emit('done', { cache_hit: true });
      return {
        cache_hit: true,
        decision_id: hit.id,
        decision: hit.decision,
        rationale: hit.rationale,
        confidence: hit.confidence,
        evidence: evidenceFromJson(hit.evidence_json),
        next_actions: safeJsonArray(hit.next_actions_json),
        alternatives: [], // not persisted in locked schema — cache hits return []
        outcome: hit.outcome ?? 'pending',
        created_at: hit.created_at,
      };
    }
    console.error(`[brain/decide] cache-bypass (freshness): decision_id=${hit.id}`);
    // Fall through to re-compute.
  }

  // Cache miss — enforce per-user daily budget BEFORE Claude.
  emit('budget_check');
  const budget = checkDailyBudget({ db, user, dayIsoUtc });
  if (!budget.allowed) {
    throw new BudgetExceededError(budget);
  }

  emit('thinking', { model: 'claude-sonnet (brainToolCall)' });
  const client = args.client ?? getClient();
  const operationalContext = await resolveOperationalContext({
    db,
    user,
    question,
    context: args.context,
    palace: args.palace ?? null,
  });
  const userMessage = [
    `Question: ${question}`,
    `Context (JSON):\n${JSON.stringify(operationalContext, null, 2)}`,
  ].join('\n\n');

  const response = await brainToolCall<DecisionInput>(client, {
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    toolName: 'emit_decision',
    toolSchema: DECISION_TOOL_SCHEMA,
    // ADR-031: route through the per-bucket registry. The `decide` bucket
    // is the right home for the agentic recall+cluster+verify loop.
    db,
    bucket: 'decide',
  });

  emit('persisting');

  const decision = response.input;
  const evidenceRecords = coerceEvidenceForPersist(decision.evidence ?? []);
  const id = decId();
  const createdAt = Date.now();

  // Locked INSERT shape (ADR-024 lines 285–290).
  db.prepare(
    `INSERT INTO brain_decisions (
       id, cache_key, question, user, day_iso, decision, rationale, confidence,
       evidence_json, next_actions_json, outcome, consumer, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    cacheKey,
    question,
    user,
    dayIsoUtc,
    decision.decision,
    decision.rationale,
    decision.confidence,
    JSON.stringify(evidenceRecords),
    JSON.stringify(decision.next_actions ?? []),
    consumer,
    createdAt,
  );

  recordSpend({
    db,
    user,
    dayIsoUtc,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  });

  emit('done', { cache_hit: false, decision_id: id });

  return {
    cache_hit: false,
    decision_id: id,
    decision: decision.decision,
    rationale: decision.rationale,
    confidence: decision.confidence,
    evidence: toUiEvidence(evidenceRecords),
    next_actions: decision.next_actions ?? [],
    alternatives: decision.alternatives ?? [],
    outcome: 'pending',
    created_at: createdAt,
  };
}

// Re-exported for the route handler.
export { BudgetExceededError } from './budget.js';
