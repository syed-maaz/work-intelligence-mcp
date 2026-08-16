/**
 * ADR-042 multi-intent classifier — 2026-07-15.
 *
 * A small (cheap) Anthropic call that decides: is this goal SINGLE or
 * COMPOUND? If compound, split into N atomic sub-goals with per-intent
 * classification.
 *
 * Contract:
 *   - Runs BEFORE the main Stage-1 refiner call.
 *   - One LLM call, small system prompt, ~200 output tokens max.
 *   - Never throws — degrades to "single intent, same goal" on any error.
 *   - Returns `null` when the classifier couldn't be run (Anthropic key
 *     missing, timeout, network) — caller treats as single-intent.
 *
 * Cost budget: this is a SECOND Anthropic call per SCOPE dispatch when
 * `WI_STAGE1_ENABLED=1`, but it's cheap:
 *   - Small system prompt (~300 tokens)
 *   - Small output (JSON-only, ~50-150 tokens)
 *   - Uses the same client and bucket as the main call
 *
 * When it fires:
 *   - Only when `WI_STAGE1_ENABLED=1` — legacy path unchanged
 *   - Regardless of goal length (some short goals are compound too)
 *
 * Related:
 *   - src/services/cypher/loop.ts (single-pass consumer)
 *   - src/services/cypher/refined-goal-schema.ts:SubBrief
 */

import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { bucketCallParams } from '../model-config.js';

/** An atomic sub-goal identified by the classifier. */
export interface AtomicSubGoal {
  /** The classifier's guess at the intent for this sub-goal. */
  intent: 'investigate' | 'build' | 'review' | 'analyze' | 'refactor' | 'other';
  /** The atomic sub-goal text — a rewritten single-focus goal, not the raw. */
  goal: string;
  /** Optional: the exact snippet of the raw goal this sub-goal came from. */
  source_span?: string;
}

export interface ClassifyResult {
  /** True when the raw goal was single-intent (or classifier fell back). */
  is_single: boolean;
  /** 1..N atomic sub-goals. When is_single=true, this has exactly one entry. */
  sub_goals: AtomicSubGoal[];
  /** Set when the classifier failed and we returned a fallback. */
  classifier_error?: string;
}

const CLASSIFIER_SYSTEM_PROMPT = `You are Cypher's goal-splitting classifier. Your ONLY job: decide whether a raw user goal is single-intent or compound (multi-intent), and if compound, split it into 1..N atomic sub-goals.

Rules:
- SINGLE intent: the goal has one clear thing to do (investigate a bug, build a feature, review a PR, analyze something, answer a question).
- COMPOUND intent: the goal uses AND / then / also / plus to chain multiple distinct actions with different intents OR different targets.
- Rewrite each sub-goal as a self-contained single-focus goal, NOT the raw span. E.g. "investigate X and refactor Y" splits to [{goal: "investigate X"}, {goal: "refactor Y"}].
- Cap at 5 sub-goals. If more, split the first 4 and lump the rest as one "other" sub-goal.

Intent enum: investigate | build | review | analyze | refactor | other

Return JSON ONLY, this exact shape:
{
  "is_single": boolean,
  "sub_goals": [
    { "intent": "investigate"|"build"|"review"|"analyze"|"refactor"|"other",
      "goal": "atomic sub-goal text",
      "source_span": "verbatim snippet from raw goal (optional)" }
  ]
}

No prose, no markdown, no code fence. JSON only.`;

/**
 * Classify a raw goal as single-intent or compound.
 *
 * Never throws. Returns a `ClassifyResult` with `is_single=true` and a
 * one-element `sub_goals` array on any failure (Anthropic down, timeout,
 * parse error).
 *
 * @param model  optional Anthropic model name — defaults to
 *   'claude-sonnet-latest' which is the codebase convention. Caller can
 *   inject a cheaper model when available. If the model is unknown to the
 *   proxy, the classifier fails silently and degrades to single-intent.
 */
export async function classifyMultiIntent(
  goal: string,
  client: Anthropic,
  opts: { timeoutMs?: number; model?: string; db?: Database.Database } = {},
): Promise<ClassifyResult> {
  const trimmed = goal.trim();
  const fallback: ClassifyResult = {
    is_single: true,
    sub_goals: [{ intent: 'other', goal: trimmed }],
  };
  if (!trimmed) return fallback;

  const timeoutMs = opts.timeoutMs ?? 12_000;
  const params = opts.db ? bucketCallParams(opts.db, 'dispatch', 400) : {
    model: opts.model ?? 'claude-sonnet-latest' as const,
    max_tokens: 400,
  };

  try {
    // Use the same beta.promptCaching path the main refiner uses so all
    // Stage-1 traffic is consistent + observable.
    const resp = await client.beta.promptCaching.messages.create(
      {
        ...params,
        system: [{ type: 'text', text: CLASSIFIER_SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: trimmed }],
      },
      { timeout: timeoutMs },
    );

    const text = resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (!text) return { ...fallback, classifier_error: 'empty response' };

    // Extract JSON (fenced or bare).
    let parsed: unknown;
    const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const jsonText = fenced ? fenced[1]! : text;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      return { ...fallback, classifier_error: `parse: ${(e as Error).message}` };
    }

    const shape = parsed as {
      is_single?: unknown;
      sub_goals?: unknown;
    };
    if (typeof shape.is_single !== 'boolean' || !Array.isArray(shape.sub_goals)) {
      return { ...fallback, classifier_error: 'wrong shape' };
    }

    const VALID = ['investigate', 'build', 'review', 'analyze', 'refactor', 'other'] as const;
    const sub_goals: AtomicSubGoal[] = [];
    for (const raw of shape.sub_goals as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const s = raw as Record<string, unknown>;
      const intent = VALID.includes(s.intent as (typeof VALID)[number])
        ? (s.intent as AtomicSubGoal['intent'])
        : 'other';
      const g = typeof s.goal === 'string' ? s.goal.trim() : '';
      if (!g) continue;
      const source_span =
        typeof s.source_span === 'string' && s.source_span.trim().length > 0
          ? s.source_span.trim()
          : undefined;
      sub_goals.push({ intent, goal: g, source_span });
      if (sub_goals.length >= 5) break;
    }

    if (sub_goals.length === 0) {
      return { ...fallback, classifier_error: 'empty sub_goals' };
    }

    // Sanity: if classifier said single but returned >1 sub-goal, trust the
    // count over the flag; if it said compound but returned exactly one,
    // trust the count too. This heals classifier self-contradiction.
    const isSingle = sub_goals.length === 1;
    return { is_single: isSingle, sub_goals };
  } catch (e) {
    return { ...fallback, classifier_error: (e as Error).message };
  }
}

// Test-only surface — allows unit tests to mock the classifier without an SDK.
export const _testing = { CLASSIFIER_SYSTEM_PROMPT };
