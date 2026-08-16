/**
 * src/services/analysis-service.ts — Thin wrapper around AIAnalyzer.
 *
 * Responsibilities:
 *   1. Enforce max_tokens: 4096 on all digest-class calls (EP-31-5)
 *   2. Wrap all AI calls with withRetry() for rate-limit / overload resilience
 *
 * Usage (additive — existing direct analyzer.xxx() calls keep working):
 *
 *   const analysisService = createAnalysisService(process.env.ANTHROPIC_API_KEY, db);
 *   const digest = await analysisService.digest(topic, messages);
 */

import {
  AIAnalyzer,
  AIAnalyzerConfig,
  Message,
  ActionItem,
  Summary,
  Question,
  Digest,
  ContextItem,
  TopicExpertAnswer,
  NotebookMessage,
  NotebookMeeting,
} from './analyzer.js';
import { withRetry, RetryOpts } from '../lib/retry.js';
import Database from 'better-sqlite3';

const DEFAULT_RETRY: RetryOpts = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

export class AnalysisService {
  private readonly analyzer: AIAnalyzer;

  constructor(analyzer: AIAnalyzer) {
    this.analyzer = analyzer;
  }

  // ── Digest generation ──────────────────────────────────────────────────────

  async digest(
    topic: string,
    date: Date,
    messages: Message[],
    existingActionItems?: ActionItem[],
    retryOpts?: RetryOpts
  ): Promise<Digest> {
    return withRetry(
      () => this.analyzer.generateDigest({ topic, date, messages, existingActionItems }),
      retryOpts ?? DEFAULT_RETRY
    );
  }

  // ── Action item extraction ─────────────────────────────────────────────────

  async extractActions(
    messages: Message[],
    retryOpts?: RetryOpts
  ): Promise<ActionItem[]> {
    return withRetry(
      () => this.analyzer.detectActionItems(messages),
      retryOpts ?? DEFAULT_RETRY
    );
  }

  // ── Content summarization ──────────────────────────────────────────────────

  async summarize(
    messages: Message[],
    retryOpts?: RetryOpts
  ): Promise<Summary> {
    return withRetry(
      () => this.analyzer.summarizeContent(messages),
      retryOpts ?? DEFAULT_RETRY
    );
  }

  // ── Question extraction ────────────────────────────────────────────────────

  async extractQuestions(
    messages: Message[],
    retryOpts?: RetryOpts
  ): Promise<Question[]> {
    return withRetry(
      () => this.analyzer.extractQuestions(messages),
      retryOpts ?? DEFAULT_RETRY
    );
  }

  // ── Chat ───────────────────────────────────────────────────────────────────

  async chat(
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    message: string,
    contextItems: ContextItem[],
    notebookContent?: string,
    retryOpts?: RetryOpts
  ): Promise<{ reply: string; suggestedFollowUps: string[] }> {
    return withRetry(
      () => this.analyzer.chatWithContext(history, message, contextItems, notebookContent),
      retryOpts ?? DEFAULT_RETRY
    );
  }

  // ── Topic expert ───────────────────────────────────────────────────────────

  async answerQuestion(
    question: string,
    context: ContextItem[],
    retryOpts?: RetryOpts
  ): Promise<TopicExpertAnswer> {
    return withRetry(
      () => this.analyzer.answerQuestion(question, context),
      retryOpts ?? DEFAULT_RETRY
    );
  }

  // ── Notebook ───────────────────────────────────────────────────────────────

  async buildNotebook(
    topicName: string,
    messages: NotebookMessage[],
    meetings: NotebookMeeting[],
    retryOpts?: RetryOpts
  ): Promise<{ content: string; sources: string[] }> {
    return withRetry(
      () => this.analyzer.buildNotebook(topicName, messages, meetings),
      retryOpts ?? DEFAULT_RETRY
    );
  }

  // ── Expose the underlying analyzer for methods not yet wrapped ────────────
  get raw(): AIAnalyzer {
    return this.analyzer;
  }
}

/**
 * Factory. Pass the Anthropic API key and optionally the DB for token tracking.
 *
 * @example
 * const svc = createAnalysisService(process.env.ANTHROPIC_API_KEY!, db);
 */
export function createAnalysisService(
  apiKey: string,
  db?: Database.Database,
  config?: Partial<AIAnalyzerConfig>
): AnalysisService {
  const analyzer = new AIAnalyzer({
    apiKey,
    maxTokens: 4096,
    db,
    ...config,
  });
  return new AnalysisService(analyzer);
}
