/**
 * AI Analyzer Service
 *
 * Uses Anthropic Claude to analyze work communications and extract insights
 */

import Anthropic from '@anthropic-ai/sdk';
import type { PromptCachingBetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/prompt-caching/messages.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { recordTokenUsage } from '../db/queries.js';
import type { BlastRadiusNode } from '../db/queries/code-graph.js';
import type { CycleTimeBaseline, TicketLearning } from '../db/queries/transitions.js';
import {
  bucketCallParams as bucketCallParamsImpl,
  EFFORT_MAX_TOKENS,
  MODEL_CAPS,
  RECOMMENDED,
  type Bucket,
  type Effort,
  type ModelId,
} from './model-config.js';
import {
  applyPatch,
  renderMarkdown,
  parseMarkdownToState,
  emptyState,
  type NotebookState,
  type NotebookPatch,
} from './notebook-merge.js';

// Models: env-var overrides with latest-alias fallbacks (EP-40-3).
//
// NOTE — these constants are now ONLY used by the four free-function call
// sites at the bottom of this file (Phase 61 override paths) until those
// also get migrated to bucket-aware signatures. All AIAnalyzer methods read
// from `this._bucketParams(bucket)` which routes through the per-bucket
// model_config registry (ADR-031). Do NOT add new references to these
// constants — pick a bucket instead. See `.claude/rules/model-config.md`.
const EXTRACTION_MODEL = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? 'claude-haiku-latest';
const DIGEST_MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'claude-sonnet-latest';

/**
 * Shape of the params object that {@link bucketCallParamsImpl} returns —
 * matches the subset of Anthropic message-create options that the bucket
 * registry controls (model + max_tokens + output_config + optional thinking).
 */
type BucketCallParams = {
  model: ModelId;
  max_tokens: number;
  output_config: { effort: Effort };
  thinking?: { type: 'adaptive' };
};

const CHUNK_SIZE = 50;

export interface Message {
  id: string;
  source: 'teams' | 'email' | 'jira';
  content: string;
  author: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface ActionItem {
  id: string;
  description: string;
  assignee?: string;
  dueDate?: Date;
  status: 'open' | 'in_progress' | 'completed';
  sourceMessageId: string;
  confidence: number;
  extractedAt: Date;
}

export interface Summary {
  topic: string;
  keyPoints: string[];
  mainThreads: string[];
  participants: string[];
  messageCount: number;
  timeRange: {
    from: Date;
    to: Date;
  };
}

export interface Question {
  id: string;
  question: string;
  askedBy: string;
  askedAt: Date;
  answered: boolean;
  sourceMessageId: string;
  confidence: number;
}

export interface Digest {
  topic: string;
  date: Date;
  summary: string;
  actionItems: ActionItem[];
  openQuestions: Question[];
  highlights: string[];
  metrics: {
    totalMessages: number;
    activeParticipants: number;
    newActionItems: number;
    completedActionItems: number;
  };
}

export interface AIAnalyzerConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  db?: Database.Database;
}

/**
 * A single piece of evidence for answerQuestion().
 * Used to pass context items from multiple sources to Claude.
 */
export interface ContextItem {
  source: string;
  title: string;
  content: string;
  url?: string;
  author?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Structured answer returned by answerQuestion().
 */
export interface TopicExpertAnswer {
  narrative: string;
  keyDecisions: string[];
  openItems: string[];
  openPRs: string[];
  participants: string[];
}

// Typed shapes returned by tool use inputs
interface RawActionItem {
  description: string;
  assignee?: string | null;
  dueDate?: string | null;
  status?: string;
  sourceMessageId?: string;
  confidence?: number;
}

interface RawQuestion {
  question: string;
  askedBy: string;
  askedAt: string;
  answered?: boolean;
  sourceMessageId?: string;
  confidence?: number;
}

interface RawDigestItem {
  description: string;
  assignee?: string | null;
  dueDate?: string | null;
  status?: string;
  confidence?: number;
}

interface RawDigestQuestion {
  question: string;
  askedBy: string;
  askedAt: string;
  answered?: boolean;
  confidence?: number;
}

/**
 * Compute estimated USD cost for a Claude API call (EP-32).
 * Prices as of 2026 Q2 — update if Anthropic reprices.
 * Falls back to $0 for unknown models rather than throwing.
 */
export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number {
  // Prices per million tokens. Verified 2026-05-31 against
  // https://platform.claude.com/docs/en/about-claude/pricing.
  // Opus 4.8 / 4.7 / 4.6 / 4.5 are $5/$25 (NOT the legacy Opus 4.1 $15/$75).
  // The `claude-opus-latest` alias resolves to Opus 4.8 today; if a future
  // alias points at a more-expensive Opus tier, this table will under-bill
  // until updated.
  const pricing: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
    // Opus 4.x — current
    'claude-opus-4-8':      { input:  5.00, output: 25.00, cacheRead: 0.50,  cacheWrite:  6.25 },
    'claude-opus-4-7':      { input:  5.00, output: 25.00, cacheRead: 0.50,  cacheWrite:  6.25 },
    'claude-opus-4-6':      { input:  5.00, output: 25.00, cacheRead: 0.50,  cacheWrite:  6.25 },
    'claude-opus-4-5':      { input:  5.00, output: 25.00, cacheRead: 0.50,  cacheWrite:  6.25 },
    'claude-opus-latest':   { input:  5.00, output: 25.00, cacheRead: 0.50,  cacheWrite:  6.25 },
    // Opus 4.1 / 4.0 — legacy / deprecated, retained for back-compat
    'claude-opus-4-1':      { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
    // Sonnet 4.x
    'claude-sonnet-4-6':    { input:  3.00, output: 15.00, cacheRead: 0.30,  cacheWrite:  3.75 },
    'claude-sonnet-4-5':    { input:  3.00, output: 15.00, cacheRead: 0.30,  cacheWrite:  3.75 },
    'claude-sonnet-latest': { input:  3.00, output: 15.00, cacheRead: 0.30,  cacheWrite:  3.75 },
    // Haiku 4.x
    'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
    'claude-haiku-4-5':     { input:  1.00, output:  5.00, cacheRead: 0.10,  cacheWrite:  1.25 },
    'claude-haiku-latest':  { input:  1.00, output:  5.00, cacheRead: 0.10,  cacheWrite:  1.25 },
    // Haiku 3.5 — retired except on Bedrock/Vertex
    'claude-haiku-3-5':     { input:  0.80, output:  4.00, cacheRead: 0.08,  cacheWrite:  1.00 },
  };
  const p = pricing[model];
  if (!p) return 0;
  return (
    (inputTokens * p.input +
     outputTokens * p.output +
     cacheReadTokens * p.cacheRead +
     cacheCreationTokens * p.cacheWrite) / 1_000_000
  );
}

/**
 * Free-function bucket-aware param resolver (ADR-031).
 *
 * The free helpers at the bottom of this file (generatePreBrief,
 * scoreMessageSeverity, generateWeeklyReport, generateChatDigest) are
 * called from contexts that don't always have a Database handle (Phase
 * 61 override paths, MeetingPrepAgent, AlertEngine). They each accept
 * an optional `db` + `bucket` so that when the caller has a DB
 * connection the registry drives the model+effort+thinking; otherwise
 * the function falls back to its legacy `model` argument and a fixed
 * max_tokens ceiling. Either way the return value is a spreadable
 * params object.
 *
 * @param db            Optional DB handle. When provided, registry wins.
 * @param bucket        Bucket to look up when db is provided.
 * @param fallbackModel Model name to use when db is null.
 * @param fallbackMaxTokens max_tokens to use when db is null.
 */
function freeFnParams(
  db: Database.Database | undefined,
  bucket: Bucket,
  fallbackModel: string,
  fallbackMaxTokens: number,
): BucketCallParams | { model: string; max_tokens: number } {
  if (db) {
    return bucketCallParamsImpl(db, bucket, fallbackMaxTokens);
  }
  return { model: fallbackModel, max_tokens: fallbackMaxTokens };
}

/**
 * AI-powered analyzer for work communications
 */
export class AIAnalyzer {
  private client: Anthropic;
  private maxTokens: number;
  private temperature: number;
  private db: Database.Database | null;

  /**
   * Lightweight accessor — exposes the Anthropic client for callers that
   * need to make their own bucketed Anthropic calls (e.g. ADR-030 Phase B
   * BugInvestigatorAgent's createBucketAwareDecideFn).
   */
  public getClient(): Anthropic {
    return this.client;
  }

  constructor(config: AIAnalyzerConfig) {
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    this.client = new Anthropic({
      apiKey: baseURL ? 'x-proxy' : config.apiKey,
      ...(baseURL ? {
        baseURL,
        defaultHeaders: { 'Authorization': `Bearer ${config.apiKey}` },
      } : {}),
    });
    this.maxTokens = config.maxTokens || 4096;
    this.temperature = config.temperature || 0.7;
    this.db = config.db ?? null;
  }

  /**
   * Resolve Anthropic call params for a bucket — model + max_tokens +
   * output_config.effort + optional adaptive thinking. Spread the result
   * into the Anthropic `.messages.create` / `.messages.stream` call body
   * alongside `system`, `tools`, and `messages`.
   *
   * When `this.db` is null (analyzer constructed without a DB — rare,
   * mainly tests / one-shot scripts), falls back to {@link RECOMMENDED}
   * defaults so the call still works without crashing. The admin UI's
   * per-bucket overrides do NOT apply in that mode by definition (no DB
   * to read them from).
   *
   * @param bucket            Which functional bucket this call belongs to.
   * @param maxTokensOverride One-off ceiling override (e.g. unbounded skill
   *                          output). Wins over the bucket's effort default.
   */
  private _bucketParams(bucket: Bucket, maxTokensOverride?: number): BucketCallParams {
    if (this.db) {
      return bucketCallParamsImpl(this.db, bucket, maxTokensOverride);
    }
    // No-DB fallback — mirror bucketCallParamsImpl shape from RECOMMENDED.
    const rec = RECOMMENDED[bucket];
    const params: BucketCallParams = {
      model: rec.model,
      max_tokens: maxTokensOverride ?? EFFORT_MAX_TOKENS[rec.effort],
      output_config: { effort: rec.effort },
    };
    if (rec.thinking_mode === 'adaptive' && MODEL_CAPS[rec.model].supportsAdaptiveThinking) {
      params.thinking = { type: 'adaptive' };
    }
    return params;
  }

  /** Record token usage from an API response (EP-32). No-ops when db not provided. */
  private _track(method: string, model: string, usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  }): void {
    if (!this.db) return;
    try {
      const costUsd = computeCost(
        model,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
      );
      recordTokenUsage(
        this.db,
        method,
        model,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
        costUsd,
      );
    } catch {
      // never let tracking errors break the caller
    }
  }

  /**
   * Detect action items from messages
   */
  async detectActionItems(messages: Message[]): Promise<ActionItem[]> {
    if (messages.length === 0) {
      return [];
    }

    // Process in chunks if needed
    if (messages.length > CHUNK_SIZE) {
      const chunks = this.chunkMessages(messages);
      const results = await Promise.all(chunks.map((chunk) => this.detectActionItemsChunk(chunk)));
      return results.flat();
    }

    return this.detectActionItemsChunk(messages);
  }

  /**
   * Summarize content from messages
   */
  async summarizeContent(messages: Message[]): Promise<Summary> {
    if (messages.length === 0) {
      throw new Error('No messages to summarize');
    }

    // Process in chunks if needed — merge participant/keyPoints/mainThreads across chunks
    if (messages.length > CHUNK_SIZE) {
      const chunks = this.chunkMessages(messages);
      const results = await Promise.all(chunks.map((chunk) => this.summarizeContentChunk(chunk)));
      const merged = this.mergeSummaries(results, messages);
      return merged;
    }

    return this.summarizeContentChunk(messages);
  }

  /**
   * Extract open questions from messages
   */
  async extractQuestions(messages: Message[]): Promise<Question[]> {
    if (messages.length === 0) {
      return [];
    }

    // Process in chunks if needed
    if (messages.length > CHUNK_SIZE) {
      const chunks = this.chunkMessages(messages);
      const results = await Promise.all(chunks.map((chunk) => this.extractQuestionsChunk(chunk)));
      return results.flat();
    }

    return this.extractQuestionsChunk(messages);
  }

  /**
   * Generate a daily digest
   */
  async generateDigest(data: {
    topic: string;
    date: Date;
    messages: Message[];
    existingActionItems?: ActionItem[];
  }): Promise<Digest> {
    const { topic, date, messages, existingActionItems = [] } = data;

    if (messages.length === 0) {
      return this.emptyDigest(topic, date);
    }

    // Process in chunks if needed — merge digest results
    if (messages.length > CHUNK_SIZE) {
      const chunks = this.chunkMessages(messages);
      const results = await Promise.all(
        chunks.map((chunk) => this.generateDigestChunk(topic, date, chunk, existingActionItems))
      );
      return this.mergeDigests(results, topic, date, messages);
    }

    return this.generateDigestChunk(topic, date, messages, existingActionItems);
  }

  // -------------------------------------------------------------------------
  // Private chunk-level implementations
  // -------------------------------------------------------------------------

  private async detectActionItemsChunk(messages: Message[]): Promise<ActionItem[]> {
    const systemPrompt = 'You are an expert at analyzing work communications and extracting action items.';
    const userPrompt = this.buildActionItemsPrompt(messages);

    const cachedSystem: PromptCachingBetaTextBlockParam[] = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];
    const params = this._bucketParams('fetch');
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      temperature: 0,
      system: cachedSystem,
      tools: [
        {
          name: 'extract_action_items',
          description: 'Extract action items from the analyzed messages',
          input_schema: {
            type: 'object' as const,
            properties: {
              actionItems: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    description: { type: 'string' },
                    assignee: { type: ['string', 'null'] },
                    dueDate: { type: ['string', 'null'], description: 'ISO date or null' },
                    status: { type: 'string', enum: ['open', 'in_progress', 'completed'] },
                    sourceMessageId: { type: 'string' },
                    confidence: { type: 'number' },
                  },
                  required: ['description', 'status', 'sourceMessageId', 'confidence'],
                },
              },
            },
            required: ['actionItems'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'extract_action_items' },
      messages: [{ role: 'user', content: userPrompt }],
    });
    this._track('detectActionItems', params.model, response.usage);

    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      return [];
    }

    const input = toolUseBlock.input as { actionItems: RawActionItem[] };
    const now = new Date();

    return (input.actionItems || []).map((item) => ({
      id: randomUUID(),
      description: item.description,
      assignee: item.assignee || undefined,
      dueDate: item.dueDate ? new Date(item.dueDate) : undefined,
      status: (item.status as ActionItem['status']) || 'open',
      sourceMessageId: item.sourceMessageId || messages[0]?.id || '',
      confidence: item.confidence ?? 0.5,
      extractedAt: now,
    }));
  }

  private async summarizeContentChunk(messages: Message[]): Promise<Summary> {
    const systemPrompt = 'You are an expert at summarizing work communications.';
    const userPrompt = this.buildSummaryPrompt(messages);

    const cachedSystem: PromptCachingBetaTextBlockParam[] = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];
    const params = this._bucketParams('fetch');
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      temperature: 0,
      system: cachedSystem,
      tools: [
        {
          name: 'extract_summary',
          description: 'Return a structured summary of the analyzed messages',
          input_schema: {
            type: 'object' as const,
            properties: {
              keyPoints: { type: 'array', items: { type: 'string' } },
              mainThreads: { type: 'array', items: { type: 'string' } },
              participants: { type: 'array', items: { type: 'string' } },
            },
            required: ['keyPoints', 'mainThreads', 'participants'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'extract_summary' },
      messages: [{ role: 'user', content: userPrompt }],
    });
    this._track('summarizeContent', params.model, response.usage);

    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      return this.createEmptySummary(messages);
    }

    const input = toolUseBlock.input as { keyPoints: string[]; mainThreads: string[]; participants: string[] };
    const timestamps = messages.map((m) => m.timestamp);
    const minTime = new Date(Math.min(...timestamps.map((t) => t.getTime())));
    const maxTime = new Date(Math.max(...timestamps.map((t) => t.getTime())));

    return {
      topic: 'Unknown',
      keyPoints: input.keyPoints || [],
      mainThreads: input.mainThreads || [],
      participants: input.participants || [],
      messageCount: messages.length,
      timeRange: { from: minTime, to: maxTime },
    };
  }

  private async extractQuestionsChunk(messages: Message[]): Promise<Question[]> {
    const systemPrompt = 'You are an expert at identifying open questions in work communications.';
    const userPrompt = this.buildQuestionsPrompt(messages);

    const cachedSystem: PromptCachingBetaTextBlockParam[] = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];
    const params = this._bucketParams('fetch');
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      temperature: 0,
      system: cachedSystem,
      tools: [
        {
          name: 'extract_questions',
          description: 'Extract open questions from the analyzed messages',
          input_schema: {
            type: 'object' as const,
            properties: {
              questions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    question: { type: 'string' },
                    askedBy: { type: 'string' },
                    askedAt: { type: 'string', description: 'ISO date' },
                    answered: { type: 'boolean' },
                    sourceMessageId: { type: 'string' },
                    confidence: { type: 'number' },
                  },
                  required: ['question', 'askedBy', 'askedAt', 'answered', 'sourceMessageId', 'confidence'],
                },
              },
            },
            required: ['questions'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'extract_questions' },
      messages: [{ role: 'user', content: userPrompt }],
    });
    this._track('extractQuestions', params.model, response.usage);

    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      return [];
    }

    const input = toolUseBlock.input as { questions: RawQuestion[] };
    const now = new Date();

    return (input.questions || []).map((q, index) => ({
      id: `question-${now.getTime()}-${index}`,
      question: q.question,
      askedBy: q.askedBy,
      askedAt: new Date(q.askedAt),
      answered: q.answered ?? false,
      sourceMessageId: q.sourceMessageId || messages[0]?.id || '',
      confidence: q.confidence ?? 0.5,
    }));
  }

  private async generateDigestChunk(
    topic: string,
    date: Date,
    messages: Message[],
    existingActionItems: ActionItem[]
  ): Promise<Digest> {
    const systemPrompt = `You are an expert at generating daily work digests for topics.`;
    const userPrompt = this.buildDigestPrompt(topic, date, messages, existingActionItems);

    const cachedSystem: PromptCachingBetaTextBlockParam[] = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];
    const params = this._bucketParams('digest', this.maxTokens);
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      temperature: this.temperature,
      system: cachedSystem,
      tools: [
        {
          name: 'generate_digest',
          description: 'Return a structured daily digest',
          input_schema: {
            type: 'object' as const,
            properties: {
              summary: { type: 'string' },
              highlights: { type: 'array', items: { type: 'string' } },
              newActionItems: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    description: { type: 'string' },
                    assignee: { type: ['string', 'null'] },
                    dueDate: { type: ['string', 'null'], description: 'ISO date or null' },
                    status: { type: 'string', enum: ['open', 'in_progress', 'completed'] },
                    confidence: { type: 'number' },
                  },
                  required: ['description', 'status', 'confidence'],
                },
              },
              openQuestions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    question: { type: 'string' },
                    askedBy: { type: 'string' },
                    askedAt: { type: 'string', description: 'ISO date' },
                    answered: { type: 'boolean' },
                    confidence: { type: 'number' },
                  },
                  required: ['question', 'askedBy', 'askedAt', 'answered', 'confidence'],
                },
              },
              activeParticipants: { type: 'number' },
            },
            required: ['summary', 'highlights', 'newActionItems', 'openQuestions', 'activeParticipants'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'generate_digest' },
      messages: [{ role: 'user', content: userPrompt }],
    });
    this._track('generateDigest', params.model, response.usage);

    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      return this.emptyDigest(topic, date);
    }

    const input = toolUseBlock.input as {
      summary: string;
      highlights: string[];
      newActionItems: RawDigestItem[];
      openQuestions: RawDigestQuestion[];
      activeParticipants: number;
    };
    const now = new Date();

    const actionItems: ActionItem[] = (input.newActionItems || []).map((item, index) => ({
      id: `action-${now.getTime()}-${index}`,
      description: item.description,
      assignee: item.assignee || undefined,
      dueDate: item.dueDate ? new Date(item.dueDate) : undefined,
      status: (item.status as ActionItem['status']) || 'open',
      sourceMessageId: '',
      confidence: item.confidence ?? 0.5,
      extractedAt: now,
    }));

    const openQuestions: Question[] = (input.openQuestions || []).map((q, index) => ({
      id: `question-${now.getTime()}-${index}`,
      question: q.question,
      askedBy: q.askedBy,
      askedAt: new Date(q.askedAt),
      answered: q.answered ?? false,
      sourceMessageId: '',
      confidence: q.confidence ?? 0.5,
    }));

    const uniqueParticipants = new Set(messages.map((m) => m.author));

    return {
      topic,
      date,
      summary: input.summary || '',
      actionItems,
      openQuestions,
      highlights: input.highlights || [],
      metrics: {
        totalMessages: messages.length,
        activeParticipants: input.activeParticipants || uniqueParticipants.size,
        newActionItems: actionItems.length,
        completedActionItems: 0,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Merge helpers for chunked results
  // -------------------------------------------------------------------------

  private chunkMessages(messages: Message[]): Message[][] {
    const chunks: Message[][] = [];
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      chunks.push(messages.slice(i, i + CHUNK_SIZE));
    }
    return chunks;
  }

  private mergeSummaries(summaries: Summary[], allMessages: Message[]): Summary {
    const timestamps = allMessages.map((m) => m.timestamp);
    const minTime = new Date(Math.min(...timestamps.map((t) => t.getTime())));
    const maxTime = new Date(Math.max(...timestamps.map((t) => t.getTime())));

    return {
      topic: 'Unknown',
      keyPoints: summaries.flatMap((s) => s.keyPoints),
      mainThreads: summaries.flatMap((s) => s.mainThreads),
      participants: [...new Set(summaries.flatMap((s) => s.participants))],
      messageCount: allMessages.length,
      timeRange: { from: minTime, to: maxTime },
    };
  }

  private mergeDigests(digests: Digest[], topic: string, date: Date, allMessages: Message[]): Digest {
    const uniqueParticipants = new Set(allMessages.map((m) => m.author));
    const actionItems = digests.flatMap((d) => d.actionItems);
    const openQuestions = digests.flatMap((d) => d.openQuestions);

    return {
      topic,
      date,
      // Use the first non-empty summary; if all are empty fall back to joined summaries
      summary: digests.map((d) => d.summary).filter(Boolean).join('\n\n') || 'No activity for this date',
      actionItems,
      openQuestions,
      highlights: digests.flatMap((d) => d.highlights),
      metrics: {
        totalMessages: allMessages.length,
        activeParticipants: uniqueParticipants.size,
        newActionItems: actionItems.length,
        completedActionItems: 0,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Prompt builders (unchanged logic, kept private)
  // -------------------------------------------------------------------------

  private buildActionItemsPrompt(messages: Message[]): string {
    const messagesText = messages
      .map(
        (message) =>
          `[${message.timestamp.toISOString()}] ${message.author} (${message.source}):\n${message.content}\nMessage ID: ${message.id}`
      )
      .join('\n\n---\n\n');

    return `Analyze the following work communications and extract all action items. An action item is a task, commitment, or to-do that someone needs to complete.

For each action item, identify:
1. Clear description of what needs to be done
2. Who is assigned (if mentioned)
3. Due date (if mentioned)
4. Current status (open/in_progress/completed based on context)
5. Your confidence level (0-1)

Messages:
${messagesText}`;
  }

  private buildSummaryPrompt(messages: Message[]): string {
    const messagesText = messages
      .map(
        (message) =>
          `[${message.timestamp.toISOString()}] ${message.author} (${message.source}):\n${message.content}`
      )
      .join('\n\n---\n\n');

    return `Summarize the following work communications. Identify key points, main discussion threads, and active participants.

Messages:
${messagesText}`;
  }

  private buildQuestionsPrompt(messages: Message[]): string {
    const messagesText = messages
      .map(
        (message) =>
          `[${message.timestamp.toISOString()}] ${message.author} (${message.source}):\n${message.content}\nMessage ID: ${message.id}`
      )
      .join('\n\n---\n\n');

    return `Analyze the following work communications and identify all open questions that have not been answered.

For each question, identify:
1. The question text
2. Who asked it
3. When it was asked
4. Whether it was answered in subsequent messages
5. Your confidence level (0-1)

Messages:
${messagesText}`;
  }

  private buildDigestPrompt(
    topic: string,
    date: Date,
    messages: Message[],
    existingActionItems: ActionItem[]
  ): string {
    const messagesText = messages
      .map(
        (message) =>
          `[${message.timestamp.toISOString()}] ${message.author} (${message.source}):\n${message.content}`
      )
      .join('\n\n---\n\n');

    const actionItemsText =
      existingActionItems.length > 0
        ? existingActionItems
            .map((item) => `- [${item.status}] ${item.description} (assigned to: ${item.assignee || 'unassigned'})`)
            .join('\n')
        : 'No existing action items';

    return `Create a daily digest for the topic "${topic}" on ${date.toISOString().split('T')[0]}.

Existing action items:
${actionItemsText}

Today's messages:
${messagesText}

Provide:
1. A concise summary (2-3 paragraphs)
2. Key highlights (bullet points)
3. New action items discovered
4. Open questions
5. Metrics (total messages, active participants, etc.)`;
  }

  // -------------------------------------------------------------------------
  // Fallback constructors
  // -------------------------------------------------------------------------

  private createEmptySummary(messages: Message[]): Summary {
    const timestamps = messages.map((m) => m.timestamp);
    const minTime = timestamps.length > 0 ? new Date(Math.min(...timestamps.map((t) => t.getTime()))) : new Date();
    const maxTime = timestamps.length > 0 ? new Date(Math.max(...timestamps.map((t) => t.getTime()))) : new Date();

    return {
      topic: 'Unknown',
      keyPoints: [],
      mainThreads: [],
      participants: [],
      messageCount: messages.length,
      timeRange: { from: minTime, to: maxTime },
    };
  }

  private emptyDigest(topic: string, date: Date): Digest {
    return {
      topic,
      date,
      summary: 'No activity for this date',
      actionItems: [],
      openQuestions: [],
      highlights: [],
      metrics: {
        totalMessages: 0,
        activeParticipants: 0,
        newActionItems: 0,
        completedActionItems: 0,
      },
    };
  }

  /**
   * Multi-turn chat with context retrieved from the DB.
   * History is stateless (client sends full history each request).
   *
   * @param history   Conversation turns so far (capped at 10)
   * @param message   Current user message
   * @param context   Retrieved evidence from FTS5 search
   * @returns         { reply, suggestedFollowUps }
   */
  async chatWithContext(
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    message: string,
    context: ContextItem[],
    notebookContent?: string,
    maxTokens?: number,
    /**
     * Phase 78a-04: optional cached system blocks prepended to the existing
     * cached system array. Used to inject the per-mode persona block (CHAT-04).
     * Each block is content-keyed by Anthropic's prompt cache; identical
     * inputs across consecutive calls produce a `usage.cache_read_input_tokens
     * > 0` second-turn HIT (verifiable via the smoke § 17.6 test).
     *
     * Backward compat: when omitted/empty, behavior is identical to pre-78a.
     */
    extraSystemBlocks?: PromptCachingBetaTextBlockParam[],
  ): Promise<{ reply: string; suggestedFollowUps: string[]; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } | null }> {
    // Per ADR-031 Decision A: chat is a single bucket. Drop the legacy
    // isComplex Haiku-vs-Sonnet split — the user's `chat` bucket setting
    // (default Opus 4.8/high) drives every chat reply. Cost trade-offs are
    // configurable via /setup/models, not encoded here.

    // Build context block
    const contextText = context.length === 0
      ? 'No relevant information found in the database for this query.'
      : context
          .slice(0, 30)
          .map((item, i) => {
            const truncated = item.content.length > 400 ? item.content.slice(0, 400) + '…' : item.content;
            return [
              `[${i + 1}] ${item.source.toUpperCase()} | ${item.title}`,
              item.author ? `Author: ${item.author}` : '',
              item.timestamp ? `Date: ${item.timestamp.slice(0, 10)}` : '',
              truncated,
            ].filter(Boolean).join('\n');
          })
          .join('\n\n---\n\n');

    const systemPrompt =
      `You are a work intelligence assistant for one user. You have indexed access via the Work Intelligence (wi_*) plugin to:
- Teams chats and meeting transcripts (last 90 days)
- Jira issues, transitions, sprint state, stuck tickets
- Calendar events and action items
- A unified brain: sprint context, noise clusters, open investigations, recalled palace memory
- Source code in configured repos (read-only grep)

The Context block below contains rows pulled from those sources for THIS question. The Context may include a "brain" section (sprint, stuck Jiras, calendar today, recalled memory) — treat it as authoritative current operational state.

Rules:
- When the user asks about a time period (yesterday, today, this week), the Context contains the relevant rows — answer from them. Cite chat names, Jira keys, dates, and people you actually see in Context.
- When Context is empty or insufficient, say which data source you would need and suggest the wi_* tool the user should run (e.g. "run wi_sync to refresh Teams"). Do NOT invent a different role for yourself.
- You are not a "code research agent". You are a work intelligence assistant — even if Context contains code snippets, frame answers around the user's work (the ticket, the chat, the decision) not a codebase tour.
- Be concise and practical.`;

    // Build system blocks: persona FIRST (heaviest cache amortization across
    // mode chains — 78a-04 / D-78a-07), then notebook (persistent memory),
    // then FTS context (EP-40-1).
    const cachedSystem: PromptCachingBetaTextBlockParam[] = [];

    if (extraSystemBlocks && extraSystemBlocks.length > 0) {
      cachedSystem.push(...extraSystemBlocks);
    }

    if (notebookContent) {
      cachedSystem.push({
        type: 'text',
        text: `## Project Knowledge Base\n\nThe following is a structured, up-to-date summary of this topic. Use it as your primary reference when answering questions:\n\n${notebookContent}`,
        cache_control: { type: 'ephemeral' },
      });
    }

    cachedSystem.push({
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    });

    // Cap history at 10 turns, trim oldest first
    const cappedHistory = history.slice(-10);

    const contextualMessage = `Context from database (${context.length} items):

${contextText}

---
User question: ${message}`;

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      ...cappedHistory.slice(0, -0 || undefined),
      { role: 'user', content: contextualMessage },
    ];

    const params = this._bucketParams('chat', maxTokens ?? 1024);
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      system: cachedSystem,
      tools: [
        {
          name: 'chat_response',
          description: 'Return a chat reply with optional suggested follow-up questions',
          input_schema: {
            type: 'object' as const,
            properties: {
              reply: {
                type: 'string',
                description: 'The assistant reply in markdown',
              },
              suggestedFollowUps: {
                type: 'array',
                items: { type: 'string' },
                description: '2-3 short follow-up questions the user might want to ask next',
              },
            },
            required: ['reply', 'suggestedFollowUps'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'chat_response' },
      messages,
    });
    this._track('chatWithContext', params.model, response.usage);

    // If the response was cut off by max_tokens, tool_use input arrives as {} — detect and retry with higher limit
    if (response.stop_reason === 'max_tokens') {
      const retryParams = this._bucketParams('chat', 2048);
      const retryResponse = await this.client.beta.promptCaching.messages.create({
        ...retryParams,
        system: cachedSystem,
        tools: [
          {
            name: 'chat_response',
            description: 'Return a chat reply with optional suggested follow-up questions',
            input_schema: {
              type: 'object' as const,
              properties: {
                reply: { type: 'string', description: 'The assistant reply in markdown' },
                suggestedFollowUps: { type: 'array', items: { type: 'string' }, description: '2-3 short follow-up questions' },
              },
              required: ['reply', 'suggestedFollowUps'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'chat_response' },
        messages,
      });
      this._track('chatWithContext', retryParams.model, retryResponse.usage);
      const retryBlock = retryResponse.content.find((b) => b.type === 'tool_use');
      if (retryBlock && retryBlock.type === 'tool_use') {
        const retryInput = retryBlock.input as { reply: string; suggestedFollowUps: string[] };
        if (retryInput.reply) return { reply: retryInput.reply, suggestedFollowUps: retryInput.suggestedFollowUps ?? [], usage: retryResponse.usage };
      }
    }

    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      return { reply: 'Sorry, I was unable to generate a response.', suggestedFollowUps: [], usage: response.usage };
    }

    const input = toolUseBlock.input as { reply: string; suggestedFollowUps: string[] };
    // Guard against truncated tool_use (stop_reason=max_tokens yields input={})
    if (!input.reply) {
      return { reply: 'Sorry, the response was too long to complete. Try asking a shorter or more specific question.', suggestedFollowUps: [], usage: response.usage };
    }
    return {
      reply: input.reply,
      suggestedFollowUps: input.suggestedFollowUps ?? [],
      usage: response.usage,
    };
  }

  /**
   * Answer a natural language question about a topic using retrieved context.
   * Question-oriented (unlike generateDigest which is date-oriented).
   *
   * @param question  The user's original natural language question
   * @param context   Retrieved evidence from Jira, GitHub, Teams, Email
   * @returns         Structured TopicExpertAnswer
   */
  async answerQuestion(
    question: string,
    context: ContextItem[]
  ): Promise<TopicExpertAnswer> {
    if (context.length === 0) {
      return {
        narrative: 'No relevant content was found across the searched sources.',
        keyDecisions: [],
        openItems: [],
        openPRs: [],
        participants: [],
      };
    }

    // Cap at 60 items; truncate each content to 500 chars
    const capped = context.slice(0, 60);
    const contextText = capped
      .map((item, i) => {
        const truncated =
          item.content.length > 500 ? item.content.slice(0, 500) + '…' : item.content;
        return [
          `[${i + 1}] ${item.source.toUpperCase()} | ${item.title}`,
          item.author ? `Author: ${item.author}` : '',
          item.timestamp ? `Date: ${item.timestamp.slice(0, 10)}` : '',
          item.url ? `URL: ${item.url}` : '',
          item.metadata ? `Status: ${JSON.stringify(item.metadata)}` : '',
          truncated,
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n---\n\n');

    const systemPrompt =
      'You are a work intelligence assistant. You answer questions about engineering topics by synthesizing information from Jira issues, GitHub PRs, Teams messages, and Outlook email. Be factual and cite specific items (issue keys, PR numbers, message dates) where relevant.';

    const cachedSystem: PromptCachingBetaTextBlockParam[] = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];

    const userPrompt = `Question: ${question}

Context (${capped.length} items retrieved from Jira, GitHub, Teams, Email):

${contextText}

Use the answer_question tool to provide a structured response.`;

    const params = this._bucketParams('chat', 2048);
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      temperature: this.temperature,
      system: cachedSystem,
      tools: [
        {
          name: 'answer_question',
          description: 'Provide a structured answer to a work intelligence question',
          input_schema: {
            type: 'object' as const,
            properties: {
              narrative: {
                type: 'string',
                description: '2-4 paragraph prose synthesis answering the question',
              },
              keyDecisions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Key decisions made, each as a single sentence',
              },
              openItems: {
                type: 'array',
                items: { type: 'string' },
                description: 'Open action items, blockers, or unanswered questions',
              },
              openPRs: {
                type: 'array',
                items: { type: 'string' },
                description: 'Open pull requests in format "PR #N: title — URL"',
              },
              participants: {
                type: 'array',
                items: { type: 'string' },
                description: 'Names of people involved in this topic',
              },
            },
            required: [
              'narrative',
              'keyDecisions',
              'openItems',
              'openPRs',
              'participants',
            ],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'answer_question' },
      messages: [{ role: 'user', content: userPrompt }],
    });
    this._track('answerQuestion', params.model, response.usage);

    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      return {
        narrative: 'AI synthesis failed — tool use block not returned.',
        keyDecisions: [],
        openItems: [],
        openPRs: [],
        participants: [],
      };
    }

    const input = toolUseBlock.input as TopicExpertAnswer;
    return {
      narrative: input.narrative ?? '',
      keyDecisions: input.keyDecisions ?? [],
      openItems: input.openItems ?? [],
      openPRs: input.openPRs ?? [],
      participants: input.participants ?? [],
    };
  }

  // ---------------------------------------------------------------------------
  // Calendar extraction from messages
  // ---------------------------------------------------------------------------

  /**
   * Scan messages for meeting invites / calendar-related content and return
   * structured calendar events.  Uses Haiku for cost efficiency.
   * Only processes messages that look like they contain meeting information.
   */
  async extractCalendarFromMessages(messages: Message[]): Promise<ExtractedCalendarEvent[]> {
    if (messages.length === 0) return [];

    // Pre-filter: only process messages likely to have meeting info
    const MEETING_KEYWORDS = /\b(meeting|invite|invitation|scheduled|calendar|standup|sync|call|webinar|conference|agenda|join|accept|tentative)\b/i;
    const candidates = messages.filter(m =>
      MEETING_KEYWORDS.test(m.content) || (m.metadata?.subject && MEETING_KEYWORDS.test(String(m.metadata.subject)))
    );
    if (candidates.length === 0) return [];

    const systemPrompt = `You are an expert at extracting calendar/meeting information from work communications.
Extract any meetings, scheduled calls, or events that have a specific date and time.
Only extract events with concrete dates — skip vague references like "we should meet sometime".
Use ISO 8601 format for dates (YYYY-MM-DDTHH:MM:SS). If year is missing, use the year from the message timestamp.
Today is ${new Date().toISOString().slice(0, 10)}.`;

    const msgText = candidates.slice(0, 20).map(m =>
      `[${m.source.toUpperCase()}] ${m.timestamp.toISOString().slice(0, 10)} — ${m.content.slice(0, 500)}`
    ).join('\n\n---\n\n');

    const userPrompt = `Extract all calendar events from these messages:\n\n${msgText}`;

    const cachedSystem: PromptCachingBetaTextBlockParam[] = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];

    const params = this._bucketParams('fetch', 2048);
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      temperature: 0,
      system: cachedSystem,
      tools: [
        {
          name: 'extract_calendar_events',
          description: 'Extract meeting/calendar events found in the messages',
          input_schema: {
            type: 'object' as const,
            properties: {
              events: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', description: 'Meeting/event title' },
                    startTime: { type: 'string', description: 'ISO datetime e.g. 2026-04-21T09:00:00' },
                    endTime: { type: ['string', 'null'], description: 'ISO datetime or null' },
                    location: { type: ['string', 'null'] },
                    description: { type: ['string', 'null'], description: 'Brief context from the message' },
                    isAllDay: { type: 'boolean' },
                  },
                  required: ['title', 'startTime', 'isAllDay'],
                },
              },
            },
            required: ['events'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'extract_calendar_events' },
      messages: [{ role: 'user', content: userPrompt }],
    });
    this._track('extractCalendarFromMessages', params.model, response.usage);

    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') return [];

    const input = toolUseBlock.input as { events: ExtractedCalendarEvent[] };
    return (input.events ?? []).filter(e => e.title && e.startTime);
  }

  // ---------------------------------------------------------------------------
  // Topic notebooks — LLM memory per topic
  // ---------------------------------------------------------------------------

  private buildNotebookPrompt(
    topicName: string,
    messages: NotebookMessage[],
    meetings: NotebookMeeting[],
    tighten = false
  ): string {
    // Option 5 of the cost-reduction plan (2026-06-23): the incremental
    // updateNotebook path doesn't need as much context as the cold buildNotebook
    // path — the existing notebook itself carries the long-tail memory, so
    // only recent new messages matter for the merge. When `tighten=true` we
    // drop from 100 × 300 chars to 30 × 200 chars on messages and 20 → 10 on
    // meetings, saving ~$1/mo at zero quality cost.
    const msgLimit = tighten ? 30 : 100;
    const msgCharCap = tighten ? 200 : 300;
    const meetLimit = tighten ? 10 : 20;

    const msgLines = messages
      .slice(-msgLimit)
      .map(m => `[${String(m.timestamp).slice(0, 10)}] ${m.author} (${m.source}): ${m.content.slice(0, msgCharCap)}`)
      .join('\n');

    const meetLines = meetings
      .slice(-meetLimit)
      .map(m => [
        `Meeting: ${m.title} (${String(m.date).slice(0, 10)})`,
        m.summary ? `Summary: ${m.summary}` : '',
        m.decisions ? `Decisions: ${m.decisions}` : '',
        m.topics ? `Topics: ${m.topics}` : '',
      ].filter(Boolean).join('\n'))
      .join('\n\n');

    return [
      `Topic: ${topicName}`,
      '',
      messages.length > 0 ? `## Messages (${messages.length} total, showing last ${msgLimit})\n${msgLines}` : '',
      meetings.length > 0 ? `## Meetings (${meetings.length} total, showing last ${meetLimit})\n${meetLines}` : '',
    ].filter(Boolean).join('\n\n');
  }

  async buildNotebook(topicName: string, messages: NotebookMessage[], meetings: NotebookMeeting[], corrections: string[] = []): Promise<{ content: string; sources: string[] }> {
    const contextText = this.buildNotebookPrompt(topicName, messages, meetings);

    const correctionsBlock = corrections.length > 0
      ? `\n\nHuman Corrections (treat as ground truth, higher priority than message data):\n${corrections.map(c => `- ${c}`).join('\n')}`
      : '';

    const systemPrompt = `You are a knowledge management assistant. Your job is to build and maintain a structured notebook that serves as living memory for a work topic. The notebook must always contain all 7 required sections and be written in clear, factual markdown.${correctionsBlock}`;

    const cachedSystem: PromptCachingBetaTextBlockParam[] = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];

    const userPrompt = `Build a comprehensive notebook for the topic "${topicName}" based on all available data.\n\n${contextText}\n\nUse the build_notebook tool to return the structured notebook.`;

    const params = this._bucketParams('digest', 4096);
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      system: cachedSystem,
      tools: [
        {
          name: 'build_notebook',
          description: 'Build a structured knowledge notebook for a work topic',
          input_schema: {
            type: 'object' as const,
            properties: {
              overview: { type: 'string', description: 'One paragraph describing what this topic/project is about' },
              keyPeople: { type: 'array', items: { type: 'string' }, description: 'People involved, format: "Name — role/involvement"' },
              currentStatus: { type: 'string', description: 'Latest status in 2-3 sentences, most recent developments' },
              timeline: { type: 'array', items: { type: 'string' }, description: 'Chronological key events, format: "YYYY-MM-DD — event description"' },
              decisionsMade: { type: 'array', items: { type: 'string' }, description: 'Important decisions made, each as a single sentence' },
              openQuestionsAndBlockers: { type: 'array', items: { type: 'string' }, description: 'Unresolved questions or blockers' },
              keyThreads: { type: 'array', items: { type: 'string' }, description: 'Important ongoing discussions or themes' },
              sources: { type: 'array', items: { type: 'string' }, description: 'Top 5 most relevant source citations used, format: "author | channel | YYYY-MM-DD". Only cite real messages from the data — no fabrication.' },
            },
            required: ['overview', 'keyPeople', 'currentStatus', 'timeline', 'decisionsMade', 'openQuestionsAndBlockers', 'keyThreads'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'build_notebook' },
      messages: [{ role: 'user', content: userPrompt }],
    });
    this._track('buildNotebook', params.model, response.usage);

    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      return { content: `# ${topicName}\n\n*Notebook generation failed.*`, sources: [] };
    }

    const nb = toolUseBlock.input as {
      overview: string;
      keyPeople: string[];
      currentStatus: string;
      timeline: string[];
      decisionsMade: string[];
      openQuestionsAndBlockers: string[];
      keyThreads: string[];
      sources?: string[];
    };

    const content = [
      `# ${topicName}`,
      '',
      '## Overview',
      nb.overview,
      '',
      '## Key People',
      (nb.keyPeople ?? []).map(p => `- ${p}`).join('\n'),
      '',
      '## Current Status',
      nb.currentStatus,
      '',
      '## Timeline',
      (nb.timeline ?? []).map(t => `- ${t}`).join('\n'),
      '',
      '## Decisions Made',
      (nb.decisionsMade ?? []).map(d => `- ${d}`).join('\n'),
      '',
      '## Open Questions & Blockers',
      (nb.openQuestionsAndBlockers ?? []).map(q => `- ${q}`).join('\n'),
      '',
      '## Key Threads',
      (nb.keyThreads ?? []).map(k => `- ${k}`).join('\n'),
    ].join('\n');

    return { content, sources: nb.sources ?? [] };
  }

  async updateNotebook(
    topicName: string,
    existingNotebook: string,
    newMessages: NotebookMessage[],
    newMeetings: NotebookMeeting[],
    corrections: string[] = [],
    existingState: NotebookState | null = null
  ): Promise<{ content: string; sources: string[]; state: NotebookState }> {
    // Recover state from the markdown if the caller didn't pass one in
    // (legacy callers + backfill path). If parsing fails we'll fall back
    // to an empty state and let the model fill it in via a patch.
    const startState: NotebookState =
      existingState
      ?? parseMarkdownToState(existingNotebook)
      ?? emptyState();

    if (newMessages.length === 0 && newMeetings.length === 0) {
      return { content: existingNotebook, sources: [], state: startState };
    }

    // Option 5 (cost reduction, 2026-06-23): tighten the new-context block
    // for the incremental path. The notebook itself carries long-tail memory.
    const newContextText = this.buildNotebookPrompt(topicName, newMessages, newMeetings, /* tighten */ true);

    const correctionsBlock = corrections.length > 0
      ? `\n\nHuman Corrections (treat as ground truth, higher priority than message data):\n${corrections.map(c => `- ${c}`).join('\n')}`
      : '';

    // Option 1 (cost reduction, 2026-06-23):
    // Split the system prompt into two blocks so only the static instructions
    // ride the prompt cache. The dynamic `existingNotebook` changes on virtually
    // every call (98% cache-write rate, 0.7% read rate against current
    // telemetry — see .planning/updatenotebook-cost-reduction/01-...md § 7.0),
    // so caching it just pays the 1.25× write premium for no read benefit.
    // The static instructions block is ~600 tokens and stable across calls —
    // a genuine cache candidate that earns its hits on burst cadence.
    //
    // Option 3 (cost reduction, 2026-06-23):
    // The model now returns a PATCH (only what changed) via patch_notebook,
    // not the entire notebook. Server-side we apply the patch deterministically
    // via applyPatch() and re-render the canonical 7-section markdown via
    // renderMarkdown() — downstream regex consumers see byte-identical output.
    // Output drops from ~3,900 tokens to a few hundred per call.
    const staticInstructions = `You are a knowledge management assistant maintaining a living notebook for a work topic. You have the existing notebook below as your memory — it represents everything you know so far. New data has arrived; produce a PATCH describing only what should change. Never remove decisions or timeline entries. Mark resolved blockers via resolvedBlockers. Add new people, decisions, timeline events, blockers, and threads as they appear. If the new data adds nothing notebook-worthy, set noChanges=true and return an empty patch.`;

    const dynamicMemory = `${correctionsBlock}\n\n## Your Current Memory (existing notebook):\n\n${existingNotebook}`;

    const cachedSystem: PromptCachingBetaTextBlockParam[] = [
      { type: 'text', text: staticInstructions, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dynamicMemory },  // intentionally NOT cached — drifts every call
    ];

    const userPrompt = `New data has arrived for topic "${topicName}". Produce a patch describing what should change. Use the patch_notebook tool. Only include fields that need updating — leave the rest absent. If nothing notebook-worthy is in this batch, set noChanges=true.\n\n${newContextText}`;

    // Option 3: max_tokens drops from 4096 to 1024 because patches are small.
    // A typical patch adds a few timeline entries + maybe a status update.
    const params = this._bucketParams('digest', 1024);
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      system: cachedSystem,
      tools: [
        {
          name: 'patch_notebook',
          description: 'Return a PATCH describing only what changes in the notebook. Leave fields absent when nothing changes in that section.',
          input_schema: {
            type: 'object' as const,
            properties: {
              newTimelineEntries: { type: 'array', items: { type: 'string' }, description: 'New timeline entries to append, chronological format e.g. "2026-06-23: X happened".' },
              newDecisions:       { type: 'array', items: { type: 'string' }, description: 'New decisions to append. Decisions are never removed.' },
              newPeople:          { type: 'array', items: { type: 'string' }, description: 'People newly mentioned. Use full names when known; server will de-dupe variants.' },
              newBlockers:        { type: 'array', items: { type: 'string' }, description: 'New open questions or blockers to add.' },
              resolvedBlockers:   { type: 'array', items: { type: 'string' }, description: 'Existing blockers (verbatim text) to mark resolved.' },
              newThreads:         { type: 'array', items: { type: 'string' }, description: 'New key threads/conversations to track.' },
              updatedStatus:      { type: 'string', description: 'New text for the Current Status section. Omit to keep existing.' },
              updatedOverview:    { type: 'string', description: 'New text for the Overview section. Usually omitted; only set when the high-level framing genuinely changes.' },
              noChanges:          { type: 'boolean', description: 'True when the new data adds nothing notebook-worthy. Pair with empty patch.' },
              sources:            { type: 'array', items: { type: 'string' }, description: 'Top 5 most relevant source citations used. Format: "author | channel | YYYY-MM-DD". Only cite real messages from the data.' },
            },
            required: [],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'patch_notebook' },
      messages: [{ role: 'user', content: userPrompt }],
    });
    this._track('updateNotebook', params.model, response.usage);

    const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      return { content: existingNotebook, sources: [], state: startState }; // fallback
    }

    const patch = toolUseBlock.input as NotebookPatch & { sources?: string[] };
    const sources = Array.isArray(patch.sources) ? patch.sources : [];
    const nextState = applyPatch(startState, patch);
    const content = renderMarkdown(topicName, nextState);

    return { content, sources, state: nextState };
  }

  async reviewPR(input: PRReviewInput): Promise<PRReview> {
    const blastSummary = input.blastRadius.length > 0
      ? `${input.blastRadius.length} files affected (depth 1-2)`
      : 'No downstream impact detected';
    const crossRepo = input.blastRadius.filter(n => n.repo !== input.blastRadius[0]?.repo).map(n => n.repo);

    const meetingsSection = input.workContext.relatedMeetings.length > 0
      ? input.workContext.relatedMeetings.map(m =>
          `  [${m.date}] ${m.title}: ${m.summary.slice(0, 150)}${m.decisions ? ` | Decisions: ${m.decisions.slice(0, 100)}` : ''}`
        ).join('\n')
      : '  none';

    const actionItemsSection = input.workContext.openActionItems.length > 0
      ? input.workContext.openActionItems.map(a => `  - ${a.content.slice(0, 120)} (${a.assignee || 'unassigned'})`).join('\n')
      : '  none';

    const learningsSection = input.workContext.ticketLearnings.length > 0
      ? input.workContext.ticketLearnings.map(l =>
          `  Solution: ${l.solution.slice(0, 150)}${l.traps ? ` | Watch out: ${l.traps.slice(0, 100)}` : ''}`
        ).join('\n')
      : '  none';

    const reviewersSection = input.workContext.potentialReviewers.length > 0
      ? input.workContext.potentialReviewers.map(r => `  ${r.name} (${r.relevanceReason})`).join('\n')
      : '  none — suggest based on changed files';

    // Phase 80 wave 77a-01: persona rules section. Empty when no rules
    // were passed — the prompt is unchanged in that case (zero risk to
    // existing callers).
    const personaRules = input.personaRules ?? [];
    const personaRulesSection = personaRules.length > 0
      ? personaRules.map(r => `  [${r.rule_id}] ${r.body}`).join('\n')
      : '';
    const personaInstructionLine = personaRules.length > 0
      ? `\nWhen any of the persona rules above apply to the diff, cite the rule_id verbatim in the markdownBody (e.g. "Per [tsconfig:noUnusedParameters], ..."). List every cited rule_id in the citedRuleIds array. Cite only rules that actually apply — do not pad.`
      : '';

    const prompt = `You are reviewing a pull request for a production codebase.

PR: ${input.prTitle}
Description: ${input.prBody || '(none)'}

Changed files blast radius: ${blastSummary}
Cross-repo impact: ${crossRepo.length > 0 ? crossRepo.join(', ') : 'none'}
${personaRules.length > 0 ? `\nPersona rules in scope (${personaRules.length}, cite by rule_id when applicable):\n${personaRulesSection}\n` : ''}
Work context:
- Jira tickets: ${input.workContext.jiraTickets.map(j => `${j.key}: ${j.summary} [${j.status}]`).join('; ') || 'none found'}
- Teams messages: ${input.workContext.teamsMessages.slice(0, 5).join(' | ') || 'none'}
- Related meetings:
${meetingsSection}
- Open action items linked to this change:
${actionItemsSection}
- Learnings from similar past tickets:
${learningsSection}
- Potential reviewers (from team activity):
${reviewersSection}
${input.workContext.notebookContent ? `- Topic notebook: ${input.workContext.notebookContent.slice(0, 400)}` : ''}

Diff (first 2000 chars):
${input.diff.slice(0, 2000)}${personaInstructionLine}`;

    const params = this._bucketParams('analyse', 2048);
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      tools: [{
        name: 'pr_review',
        description: 'Structured PR review output',
        input_schema: {
          type: 'object' as const,
          properties: {
            riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
            riskReason: { type: 'string' },
            workContextSummary: { type: 'string' },
            testCoverageSummary: { type: 'string' },
            crossRepoImpact: { type: 'array', items: { type: 'string' } },
            suggestedReviewers: { type: 'array', items: { type: 'string' } },
            missingTests: { type: 'array', items: { type: 'string' } },
            markdownBody: { type: 'string' },
            citedRuleIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Persona rule_ids cited in markdownBody (e.g. "tsconfig:noUnusedParameters"). Empty array when no rules apply.',
            },
          },
          required: ['riskLevel', 'riskReason', 'workContextSummary', 'testCoverageSummary', 'crossRepoImpact', 'suggestedReviewers', 'missingTests', 'markdownBody', 'citedRuleIds'],
        },
      }],
      tool_choice: { type: 'tool', name: 'pr_review' },
      system: [{ type: 'text', text: 'You are a senior engineer performing an AI-assisted PR review. Be specific, grounded, and concise. Only reference files and context actually provided.', cache_control: { type: 'ephemeral' } }] as PromptCachingBetaTextBlockParam[],
      messages: [{ role: 'user', content: prompt }],
    });

    this._track('reviewPR', params.model, response.usage);
    const block = response.content.find(b => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') throw new Error('reviewPR: no tool_use block');
    const parsed = block.input as Partial<PRReview>;
    // Phase 80 wave 77a-01: ensure citedRuleIds is always present and an
    // array of strings even when the model omits it (older model snapshots
    // ignore newly added required fields under tool_choice).
    return {
      ...parsed,
      citedRuleIds: Array.isArray(parsed.citedRuleIds) ? parsed.citedRuleIds.filter((s): s is string => typeof s === 'string') : [],
    } as PRReview;
  }

  async generatePRDescription(opts: {
    branch: string;
    filesChanged: string[];
    jiraContext?: string;
    teamsContext?: string;
    blastRadius?: BlastRadiusNode[];
  }): Promise<string> {
    const jiraKey = opts.branch.match(/([A-Z]+-\d+)/)?.[1] ?? '';
    const blastSummary = opts.blastRadius && opts.blastRadius.length > 0
      ? `\n\n### Blast Radius\n${opts.blastRadius.map(n => `- ${n.repo}/${n.file_path}`).join('\n')}`
      : '';

    const prompt = `Generate a professional GitHub PR description in markdown for this change.

Branch: ${opts.branch}
${jiraKey ? `Jira: ${jiraKey}` : ''}
${opts.jiraContext ? `Jira context: ${opts.jiraContext}` : ''}
${opts.teamsContext ? `Teams context: ${opts.teamsContext}` : ''}

Files changed:
${opts.filesChanged.join('\n')}

Include sections: ## Summary, ## Changes${blastSummary ? ', ## Blast Radius' : ''}.
Keep it under 400 words. Be concrete.`;

    const params = this._bucketParams('analyse', 1024);
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      system: [{ type: 'text', text: 'Generate a concise, professional GitHub PR description. No fluff.', cache_control: { type: 'ephemeral' } }] as PromptCachingBetaTextBlockParam[],
      messages: [{ role: 'user', content: prompt }],
    });

    this._track('generatePRDescription', params.model, response.usage);
    const block = response.content.find(b => b.type === 'text');
    return (block && block.type === 'text') ? block.text + blastSummary : '';
  }

  async buildMemberProfile(input: MemberProfileInput): Promise<MemberProfileOutput> {
    const prompt = `You are analyzing a team member's work profile across multiple sources.

${input.dataCoverageNote}

**Member**: ${input.name}

**Messages (last ${input.dataCoverageNote})**
Count: ${input.messageCount} (team avg: ${input.teamAvgMessages})
Topics: ${input.topTopics.map(t => `${t.name} (${t.count} msgs, weight ${t.relevanceWeight.toFixed(2)})`).join(', ') || 'none'}
Last active: ${input.lastActiveDate ?? 'unknown'}
Recent messages (sample):
${input.recentMessages.slice(0, 5).map(m => `- ${m.slice(0, 120)}`).join('\n') || 'none'}

**Jira Workload**
Open tickets (${input.openTickets.length}): ${input.openTickets.map(t => `${t.key}: ${t.summary} [${t.status}]${t.cycleTimeHours ? ` ~${Math.round(t.cycleTimeHours / 24)}d cycle` : ''}`).join('; ') || 'none'}
Overdue (${input.overdueTickets.length}): ${input.overdueTickets.map(t => `${t.key}: ${t.summary} (${t.daysPast}d past)`).join('; ') || 'none'}

**Meetings**
Recent: ${input.recentMeetings.map(m => m.title).join(', ') || 'none'}
Pending action items: ${input.pendingActionItems.map(a => a.description).join('; ') || 'none'}

**Code Ownership (top files by commits)**
${input.commitsByFile.slice(0, 10).map(f => `${f.file}: ${f.commitCount} commits`).join('\n') || 'none'}

**Team Context**
Team avg messages: ${input.teamAvgMessages}, avg commits: ${input.teamAvgCommits}, avg Jira: ${input.teamAvgJiraActivity}

Activity score formula: 0.4×(messages/${input.teamAvgMessages}) + 0.3×(commits/${input.teamAvgCommits}) + 0.3×(jira/${input.teamAvgJiraActivity}), capped at 1.0.

Synthesize a profile using the build_member_profile tool. Be specific and actionable.`;

    const params = this._bucketParams('digest', 2048);
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      system: [{ type: 'text', text: 'You are a senior engineering manager synthesizing a teammate intelligence profile. Be accurate, specific, and actionable.', cache_control: { type: 'ephemeral' } }] as PromptCachingBetaTextBlockParam[],
      tools: [{
        name: 'build_member_profile',
        description: 'Output a structured teammate profile',
        input_schema: {
          type: 'object' as const,
          properties: {
            summary: { type: 'string', description: 'One-sentence summary of this person (max 200 chars)' },
            activityLevel: { type: 'string', enum: ['high', 'medium', 'low', 'new', 'unknown'] },
            activityScore: { type: 'number', description: '0.0–1.0 weighted composite per formula' },
            workloadSignal: { type: 'string', enum: ['available', 'busy', 'overloaded', 'unknown'] },
            domains: { type: 'array', items: { type: 'string' }, description: 'Top domain areas (max 5)' },
            currentFocus: { type: 'string', description: 'What they are currently working on (max 300 chars)' },
            overdueSummary: { type: 'string', nullable: true, description: 'Summary of overdue items, or null' },
            codeOwnership: { type: 'array', items: { type: 'string' }, description: 'Top owned file paths (max 5)' },
            collaborators: { type: 'array', items: { type: 'string' }, description: 'Frequent co-authors (max 5)' },
            profileMarkdown: { type: 'string', description: 'Full human-readable markdown profile' },
          },
          required: ['summary', 'activityLevel', 'activityScore', 'workloadSignal', 'domains', 'currentFocus', 'overdueSummary', 'codeOwnership', 'collaborators', 'profileMarkdown'],
        },
      }],
      tool_choice: { type: 'tool', name: 'build_member_profile' },
      messages: [{ role: 'user', content: prompt }],
    });

    this._track('buildMemberProfile', params.model, response.usage);
    const block = response.content.find(b => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') throw new Error('buildMemberProfile: no tool_use block');
    return block.input as MemberProfileOutput;
  }

  async rankReviewers(
    file: string,
    candidates: Array<{ member: { name: string; github_handle: string | null }; commitCount: number; workloadSignal: string }>,
    prContext?: string,
  ): Promise<{ bestIndex: number; reasoning: string }> {
    if (candidates.length === 0) return { bestIndex: -1, reasoning: 'No candidates' };
    if (candidates.length === 1) return { bestIndex: 0, reasoning: 'Only one candidate' };

    const prompt = `Pick the best reviewer for changes to \`${file}\`.
${prContext ? `PR context: ${prContext}` : ''}

Candidates:
${candidates.map((c, i) => `${i + 1}. ${c.member.name} (@${c.member.github_handle ?? 'unknown'}) — ${c.commitCount} commits to this file, workload: ${c.workloadSignal}`).join('\n')}

Return the index (1-based) of the best reviewer and a brief reason.`;

    const params = this._bucketParams('fetch', 256);
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      system: [{ type: 'text', text: 'You are selecting the best code reviewer. Prefer lower workload when expertise is similar.', cache_control: { type: 'ephemeral' } }] as PromptCachingBetaTextBlockParam[],
      tools: [{
        name: 'rank_reviewer',
        description: 'Return the best reviewer',
        input_schema: {
          type: 'object' as const,
          properties: {
            bestIndex: { type: 'number', description: '1-based index of the best candidate' },
            reasoning: { type: 'string', description: 'One sentence explaining the choice' },
          },
          required: ['bestIndex', 'reasoning'],
        },
      }],
      tool_choice: { type: 'tool', name: 'rank_reviewer' },
      messages: [{ role: 'user', content: prompt }],
    });

    this._track('rankReviewers', params.model, response.usage);
    const block = response.content.find(b => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') return { bestIndex: 0, reasoning: 'fallback to first' };
    const out = block.input as { bestIndex: number; reasoning: string };
    return { bestIndex: out.bestIndex - 1, reasoning: out.reasoning };
  }

  // ── EP-48-2: Solution Proposal ────────────────────────────────────────────

  /**
   * Propose a concrete implementation solution for a Jira ticket.
   * Uses DIGEST_MODEL (claude-sonnet) for higher quality.
   * Triggered on user click — not at page load.
   */
  async proposeSolution(opts: {
    issueKey: string;
    title: string;
    status: string;
    assignee: string | null;
    codeContext: ContextItem[];
    cycleTimeBaseline?: CycleTimeBaseline | null;
    pastLearnings?: TicketLearning[];
  }): Promise<{ solution: string; steps: string[]; missingInfo: string | null }> {
    const ticketHeader = `Ticket ${opts.issueKey}: "${opts.title}" | Status: ${opts.status} | Assignee: ${opts.assignee ?? 'Unassigned'}`;
    const contextSummary = opts.codeContext
      .slice(0, 8)
      .map(c => `### ${c.title}\n${c.content.slice(0, 600)}`)
      .join('\n\n');

    // Build cycle time baseline section
    const cycleSection = (opts.cycleTimeBaseline && opts.cycleTimeBaseline.n >= 5)
      ? `\nCycle time baseline for similar tickets (n=${opts.cycleTimeBaseline.n}):
  P25: ${Math.round(opts.cycleTimeBaseline.p25)}h | P50: ${Math.round(opts.cycleTimeBaseline.p50)}h | P75: ${Math.round(opts.cycleTimeBaseline.p75)}h${opts.cycleTimeBaseline.warning ? ` (${opts.cycleTimeBaseline.warning})` : ''}`
      : '';

    // Build past learnings section
    const learningsSection = opts.pastLearnings && opts.pastLearnings.length > 0
      ? `\nPast learnings from similar tickets:\n${opts.pastLearnings
          .map((l, i) => `${i + 1}. [${l.issue_key}] ${l.summary}\n   Solution: ${l.solution}${l.traps ? `\n   Traps: ${l.traps}` : ''}`)
          .join('\n')}`
      : '';

    const prompt = `${ticketHeader}

You are a senior engineer proposing a concrete implementation plan for this Jira ticket.
${cycleSection}${learningsSection}

Code context:
${contextSummary || '(no code context available)'}

Produce:
1. A concise solution description (2-4 sentences)
2. Ordered implementation steps (each step is 1 sentence, actionable)
3. Any missing information needed before work can begin (or null if sufficient)`;

    const params = this._bucketParams('analyse', 1024);
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      system: [{ type: 'text', text: 'You are a senior software engineer producing concrete, actionable implementation plans.', cache_control: { type: 'ephemeral' } }] as PromptCachingBetaTextBlockParam[],
      tools: [{
        name: 'solution_proposal',
        description: 'Return a concrete solution proposal',
        input_schema: {
          type: 'object' as const,
          properties: {
            solution: { type: 'string', description: 'Concise solution description' },
            steps: { type: 'array', items: { type: 'string' }, description: 'Ordered implementation steps' },
            missingInfo: { type: 'string', description: 'Missing info needed, or null if sufficient context', nullable: true },
          },
          required: ['solution', 'steps'],
        },
      }],
      tool_choice: { type: 'tool', name: 'solution_proposal' },
      messages: [{ role: 'user', content: prompt }],
    });

    this._track('proposeSolution', params.model, response.usage);
    const block = response.content.find(b => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      return { solution: 'Solution analysis unavailable', steps: [], missingInfo: null };
    }
    const out = block.input as { solution: string; steps: string[]; missingInfo?: string | null };
    return { solution: out.solution, steps: out.steps ?? [], missingInfo: out.missingInfo ?? null };
  }

  /**
   * Analyze the code impact of a Jira ticket using file paths found in codebase search.
   * Uses EXTRACTION_MODEL (claude-haiku) for cost efficiency.
   * Gated at 15 files to prevent noise when code_graph is not yet indexed.
   */
  async analyzeCodeImpact(opts: {
    issueKey: string;
    title: string;
    files: string[];
  }): Promise<{ impactedFiles: string[]; riskLevel: 'low' | 'medium' | 'high'; rationale: string }> {
    if (opts.files.length === 0) {
      return { impactedFiles: [], riskLevel: 'low', rationale: 'No relevant files found in codebase.' };
    }
    if (opts.files.length > 15) {
      return {
        impactedFiles: opts.files.slice(0, 15),
        riskLevel: 'medium',
        rationale: `${opts.files.length} files matched — showing top 15. Run code graph indexing for blast-radius analysis.`,
      };
    }

    const prompt = `Ticket ${opts.issueKey}: "${opts.title}"

Files likely involved:
${opts.files.map((f, i) => `${i + 1}. ${f}`).join('\n')}

Assess the code impact:
- Which files are directly impacted?
- What is the risk level (low/medium/high)?
- Provide a 1–2 sentence rationale.`;

    const params = this._bucketParams('analyse', 512);
    const response = await this.client.beta.promptCaching.messages.create({
      ...params,
      system: [{ type: 'text', text: 'You are assessing the code impact and risk level of a Jira ticket based on the files involved. Only reference files from the provided list. Do not invent or guess file paths not explicitly provided.', cache_control: { type: 'ephemeral' } }] as PromptCachingBetaTextBlockParam[],
      tools: [{
        name: 'code_impact',
        description: 'Return code impact assessment',
        input_schema: {
          type: 'object' as const,
          properties: {
            impactedFiles: { type: 'array', items: { type: 'string' }, description: 'Files directly impacted' },
            riskLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Overall risk level' },
            rationale: { type: 'string', description: 'Brief rationale for the risk assessment' },
          },
          required: ['impactedFiles', 'riskLevel', 'rationale'],
        },
      }],
      tool_choice: { type: 'tool', name: 'code_impact' },
      messages: [{ role: 'user', content: prompt }],
    });

    this._track('analyzeCodeImpact', params.model, response.usage);
    const block = response.content.find(b => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      return { impactedFiles: opts.files, riskLevel: 'medium', rationale: 'Impact analysis unavailable' };
    }
    const out = block.input as { impactedFiles: string[]; riskLevel: 'low' | 'medium' | 'high'; rationale: string };
    const validFiles = new Set(opts.files);
    const safeImpactedFiles = (out.impactedFiles ?? []).filter(f => validFiles.has(f));
    return { impactedFiles: safeImpactedFiles, riskLevel: out.riskLevel ?? 'medium', rationale: out.rationale ?? '' };
  }
}

export interface ExtractedCalendarEvent {
  title: string;
  startTime: string;   // ISO datetime
  endTime: string | null;
  location: string | null;
  description: string | null;
  isAllDay: boolean;
}

export interface PRWorkContext {
  jiraTickets: Array<{ key: string; summary: string; status: string }>;
  teamsMessages: string[];
  relatedMeetings: Array<{ title: string; summary: string; decisions: string; date: string }>;
  openActionItems: Array<{ content: string; assignee: string }>;
  ticketLearnings: Array<{ solution: string; traps: string; cycleHours: number | null }>;
  potentialReviewers: Array<{ name: string; relevanceReason: string }>;
  notebookContent?: string;
}

export interface PRReviewInput {
  prTitle: string;
  prBody?: string;
  diff: string;
  blastRadius: BlastRadiusNode[];
  workContext: PRWorkContext;
  /**
   * Phase 80 wave 77a-01: persona rules from the `reviews` palace wing
   * (Tier-0 tsconfig parser today; canonical-prose + Tier-1 in later waves).
   * The route layer is responsible for fetching + prefix-filtering by
   * rule_id before passing in. When non-empty, the prompt instructs the
   * model to cite by rule_id and the response carries `citedRuleIds`.
   */
  personaRules?: Array<{ rule_id: string; body: string }>;
}

export interface PRReview {
  riskLevel: 'low' | 'medium' | 'high';
  riskReason: string;
  workContextSummary: string;
  testCoverageSummary: string;
  crossRepoImpact: string[];
  suggestedReviewers: string[];
  missingTests: string[];
  markdownBody: string;
  /**
   * Phase 80 wave 77a-01: rule_ids the model cited in markdownBody.
   * Empty when no personaRules were passed. Always present for shape
   * stability (older callers ignoring the field is fine).
   */
  citedRuleIds: string[];
}

// Simple raw-row types for notebook methods — avoid cross-module schema imports
export interface NotebookMessage {
  source: string;
  content: string;
  author: string;
  timestamp: string | Date;
}

export interface NotebookMeeting {
  title: string;
  date: string | Date;
  summary: string | null;
  decisions: string | null;
  topics: string | null;
}

export interface PreBriefContext {
  subject: string;
  content: string;
}

/**
 * Generate a pre-meeting brief for a calendar event.
 * Called by web-server.js during runFullSync for events in next 24h.
 */
export async function generatePreBrief(
  title: string,
  attendees: string,
  hoursAway: number,
  contextItems: PreBriefContext[],
  apiKey: string,
  model: string = DIGEST_MODEL,  // Phase 61: optional override — ignored when db+bucket are passed
  db?: Database.Database,         // ADR-031: when set, registry drives model/effort/thinking
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const contextText = contextItems.length === 0
    ? 'No relevant prior discussions found.'
    : contextItems.slice(0, 20).map((c, i) =>
        `[${i + 1}] ${c.subject}\n${c.content.slice(0, 300)}`
      ).join('\n\n---\n\n');

  const prompt = `I have a meeting called "${title}" in ${Math.round(hoursAway)} hours with attendees: ${attendees || 'unknown'}.

Based on the context below from Teams messages, emails, and meetings, give me:
1. **What was previously discussed** on this topic (key decisions, status, recent activity)
2. **Open items or blockers** I should know about going into this meeting
3. **3 suggested questions** to raise or topics to cover

Be concise. Use bullet points. Focus on actionable information.

---

${contextText}`;

  const params = freeFnParams(db, 'digest', model, 800);
  const response = await client.messages.create({
    ...params,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = response.content.find(b => b.type === 'text');
  return (block && block.type === 'text') ? block.text : 'Unable to generate brief.';
}

/**
 * Score a work message for alert severity.
 * Called by AlertScorerAgent in web-server.js via dynamic import.
 * Uses Haiku (cost-bounded — this runs on every new message).
 *
 * Four-Stage Pipeline: Analyze stage — no direct DB writes here.
 */
export async function scoreMessageSeverity(
  content: string,
  author: string,
  subject: string,
  apiKey: string,
  model: string = EXTRACTION_MODEL,
  db?: Database.Database,         // ADR-031: when set, registry drives model/effort/thinking
): Promise<{ severity: 'low' | 'medium' | 'high'; summary: string; reason: string }> {
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const client = new Anthropic({
    apiKey: baseURL ? 'x-proxy' : apiKey,
    ...(baseURL ? {
      baseURL,
      defaultHeaders: { Authorization: `Bearer ${apiKey}` },
    } : {}),
  });
  const systemPrompt = 'You are an alert triage assistant. Score work messages by urgency.';

  const params = freeFnParams(db, 'fetch', model, 256);
  const response = await client.beta.promptCaching.messages.create({
    ...params,
    temperature: 0,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    tools: [
      {
        name: 'score_severity',
        description: 'Score message severity for work alert triage',
        input_schema: {
          type: 'object' as const,
          properties: {
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            summary:  { type: 'string', description: 'One-line summary (max 80 chars)' },
            reason:   { type: 'string', description: 'Why this severity was assigned' },
          },
          required: ['severity', 'summary', 'reason'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'score_severity' },
    messages: [
      {
        role: 'user',
        content: `From: ${author}\nSubject: ${subject}\n\n${content.slice(0, 500)}`,
      },
    ],
  });

  const block = response.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') {
    return { severity: 'low', summary: 'Unable to score', reason: 'AI response parse error' };
  }
  return block.input as { severity: 'low' | 'medium' | 'high'; summary: string; reason: string };
}

// ── EP-38: Weekly pattern analysis ───────────────────────────────────────

export interface WeeklyStats {
  weekOf: string;
  openItems: Array<{ title: string; assignee: string | null; due_date: string | null }>;
  overdueItems: Array<{ title: string; assignee: string | null; due_date: string | null }>;
  messageVolume: Array<{ date: string; source: string; count: number }>;
  topicSummaries: Array<{ name: string; messageCount: number }>;
  tokenCostThisWeek?: number;
}

export async function generateWeeklyReport(
  stats: WeeklyStats,
  apiKey: string,
  db?: Database.Database,         // ADR-031: when set, registry drives model/effort/thinking
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const statsText = JSON.stringify(stats, null, 2);

  const prompt = `You are analyzing weekly work patterns. Given the statistics below, produce a concise weekly intelligence report in markdown.

Include:
1. **Week summary** (2-3 sentences about the week's activity)
2. **Action item status** (overdue count, completion rate, assignments needing attention)
3. **Message volume patterns** (which sources were most active, any unusual activity)
4. **Topics activity** (which topics were most active this week)
5. **Recommendations** (2-3 specific things to act on this week based on the data)

Keep it under 500 words. Use markdown headers and bullet points.

Statistics for week of ${stats.weekOf}:
${statsText}`;

  const params = freeFnParams(db, 'digest', DIGEST_MODEL, 1024);
  const response = await client.messages.create({
    ...params,
    system: 'You are a work intelligence assistant generating concise weekly reports. Be actionable and specific.',
    messages: [{ role: 'user', content: prompt }],
  });

  const block = response.content.find(b => b.type === 'text');
  return (block && block.type === 'text') ? block.text : 'Unable to generate weekly report.';
}

// ── EP-53: Chat digest ────────────────────────────────────────────────────────

export interface ChatDigestInput {
  chatName: string;
  messages: Array<{ author: string; content: string; timestamp: string }>;
  decisions?: string[];
  actionItems?: string[];
}

export async function generateChatDigest(
  input: ChatDigestInput,
  apiKey: string,
  db?: Database.Database,         // ADR-031: when set, registry drives model/effort/thinking
): Promise<string> {
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const client = new Anthropic({
    apiKey: baseURL ? 'x-proxy' : apiKey,
    ...(baseURL ? {
      baseURL,
      defaultHeaders: { Authorization: `Bearer ${apiKey}` },
    } : {}),
  });

  const { chatName, messages, decisions = [], actionItems = [] } = input;
  const msgText = messages
    .slice(-100)
    .map(m => `[${m.timestamp.slice(0, 10)}] ${m.author}: ${m.content.slice(0, 300)}`)
    .join('\n');

  const decisionsBlock = decisions.length > 0
    ? `\nKnown decisions from meetings:\n${decisions.slice(0, 10).map(d => `- ${d}`).join('\n')}`
    : '';
  const actionItemsBlock = actionItems.length > 0
    ? `\nKnown action items:\n${actionItems.slice(0, 10).map(a => `- ${a}`).join('\n')}`
    : '';

  const prompt = `Summarize the Teams chat "${chatName}" based on the recent messages below.

Produce a concise intelligence digest in markdown with these sections:
1. **What's happening** (2-3 sentences — the main topic/thread right now)
2. **Key people** (who is most active and what they're working on)
3. **Decisions & blockers** (any decisions made or blockers mentioned)
4. **Action items** (specific tasks mentioned, with owners if named)

Keep it under 300 words. Be direct and specific — this is for a developer who needs a quick catch-up.
${decisionsBlock}${actionItemsBlock}

Recent messages (newest last):
${msgText}`;

  const params = freeFnParams(db, 'fetch', EXTRACTION_MODEL, 600);
  const response = await client.messages.create({
    ...params,
    system: 'You are a work intelligence assistant. Summarize Teams chat activity concisely and helpfully. Focus on actionable information.',
    messages: [{ role: 'user', content: prompt }],
  });

  const block = response.content.find(b => b.type === 'text');
  return (block && block.type === 'text') ? block.text : 'Unable to generate chat digest.';
}

// ── EP-45: Teammate Intelligence types ───────────────────────────────────────

export interface MemberProfileInput {
  name: string;
  dataCoverageNote: string;
  messageCount: number;
  topTopics: Array<{ name: string; count: number; relevanceWeight: number }>;
  lastActiveDate: string | null;
  recentMessages: string[];
  openTickets: Array<{ key: string; summary: string; status: string; dueDate?: string; cycleTimeHours?: number }>;
  overdueTickets: Array<{ key: string; summary: string; daysPast: number }>;
  recentMeetings: Array<{ title: string; date: string; hadActionItems: boolean }>;
  pendingActionItems: Array<{ description: string; dueDate?: string }>;
  commitsByFile: Array<{ file: string; commitCount: number }>;
  teamAvgMessages: number;
  teamAvgCommits: number;
  teamAvgJiraActivity: number;
}

export interface MemberProfileOutput {
  summary: string;
  activityLevel: 'high' | 'medium' | 'low' | 'new' | 'unknown';
  activityScore: number;
  workloadSignal: 'available' | 'busy' | 'overloaded' | 'unknown';
  domains: string[];
  currentFocus: string;
  overdueSummary: string | null;
  codeOwnership: string[];
  collaborators: string[];
  profileMarkdown: string;
}
