/**
 * Locked brainToolCall wrapper — ADR-024 lines 78–122 / Phase 69-05.
 *
 * Decoupled Anthropic tool-use wrapper for the Unified Brain layer.
 * Used ONLY by /api/brain/* endpoints (currently /api/brain/decide).
 *
 * IMPORTANT: This module MUST NOT import or extend `src/services/analyzer.ts`
 * (`AIAnalyzer`). AIAnalyzer remains the four-stage-pipeline wrapper
 * (extraction / summarization / digest / detection); decision orchestration
 * has its own budget, model, and caching strategy and lives here.
 *
 * Implementation contract (verbatim from ADR-024):
 *  1. Calls the Anthropic beta promptCaching messages endpoint — same beta
 *     namespace AIAnalyzer uses (only namespace exposing `cache_control` in
 *     SDK 0.32.1).
 *  2. System prompt passed as `PromptCachingBetaTextBlockParam[]` with
 *     `cache_control: { type: 'ephemeral' }` on the first block.
 *  3. `tool_choice: { type: 'tool', name: req.toolName }` forces structured
 *     output.
 *  4. Reads `response.content.find(b => b.type === 'tool_use').input` and
 *     returns it as `input: T`.
 *  5. Throws if no `tool_use` block is present (no text-parse fallback).
 *  6. Returns token usage (cacheRead/cacheCreation/input/output) so the
 *     budget gate (Task 3) can charge it.
 *  7. Defaults: `model = 'claude-sonnet-4-6'`, `maxTokens = 2048`.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { PromptCachingBetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/prompt-caching/messages.js';
import type Database from 'better-sqlite3';
import { bucketCallParams, type Bucket } from '../model-config.js';

export interface BrainToolUseRequest {
  systemPrompt: string;                        // cached via cache_control: 'ephemeral'
  userMessage: string;                         // composed by /api/brain/decide from question + Pillar 2 context
  toolName: string;                            // e.g. 'emit_decision'
  toolSchema: Anthropic.Tool['input_schema'];
  /**
   * ADR-031: when `db` and `bucket` are both provided, the per-bucket
   * registry drives model + effort + thinking. The legacy `model` and
   * `maxTokens` overrides below are retained for one-off scripts and
   * tests that don't have a DB handle.
   */
  db?: Database.Database;
  bucket?: Bucket;
  model?: string;                              // legacy override (ignored when db+bucket are set)
  maxTokens?: number;                          // legacy override (ignored when db+bucket are set)
}

export interface BrainToolUseResponse<T = unknown> {
  input: T;                                    // parsed tool_use input — the structured decision
  raw: Anthropic.Beta.PromptCaching.PromptCachingBetaMessage;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  inputTokens: number;
  outputTokens: number;
}

const DEFAULT_MODEL =
  process.env.BRAIN_DECISION_MODEL ??
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
  'claude-sonnet-latest';
const DEFAULT_MAX_TOKENS = 2048;

export async function brainToolCall<T = unknown>(
  client: Anthropic,
  req: BrainToolUseRequest,
): Promise<BrainToolUseResponse<T>> {
  // ADR-031: registry path when (db, bucket) both present — model + effort
  // + thinking come from the live model_config row. Otherwise fall back to
  // the legacy explicit model/maxTokens with the env-var defaults.
  const params: {
    model: string;
    max_tokens: number;
    output_config?: { effort: string };
    thinking?: { type: 'adaptive' };
  } = req.db && req.bucket
    ? bucketCallParams(req.db, req.bucket, req.maxTokens)
    : { model: req.model ?? DEFAULT_MODEL, max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS };

  const system: PromptCachingBetaTextBlockParam[] = [
    {
      type: 'text',
      text: req.systemPrompt,
      cache_control: { type: 'ephemeral' },
    },
  ];

  const response = await client.beta.promptCaching.messages.create({
    ...params,
    system,
    tools: [
      {
        name: req.toolName,
        description: `Emit the structured response for ${req.toolName}.`,
        input_schema: req.toolSchema,
      },
    ],
    tool_choice: { type: 'tool', name: req.toolName },
    messages: [{ role: 'user', content: req.userMessage }],
  });

  const toolUseBlock = response.content.find(
    (b): b is Extract<typeof response.content[number], { type: 'tool_use' }> => b.type === 'tool_use',
  );

  if (!toolUseBlock) {
    throw new Error(
      `[brainToolCall] no tool_use block in response (toolName=${req.toolName}, stop_reason=${response.stop_reason})`,
    );
  }

  const usage = response.usage as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };

  return {
    input: toolUseBlock.input as T,
    raw: response,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}
