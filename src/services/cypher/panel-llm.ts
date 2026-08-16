/**
 * ADR-040 commit 5 (2026-07-06): cross-family LLM adapter for the
 * 4-agent argument panel. Thin fetch wrappers over OpenAI, Google
 * Gemini, and local Llama. Anthropic is already in the tree via the
 * SDK; we call it there rather than duplicating here.
 *
 * # Fail-open semantics (§6.3)
 *
 * Every call function returns `{ ok: false, reason }` on missing key
 * or provider error rather than throwing. The panel scheduler treats
 * a false response as "agent unavailable → skip + set degraded=1".
 *
 * # Cost tracking
 *
 * Callers pass `db` + `panelReviewId`. Every successful call writes
 * one `cost_ledger` row with tokens + `usd_estimated`. Rough per-1M-
 * token pricing anchored to public list prices as of 2026-07:
 *   openai gpt-4o-mini      : $0.15 input / $0.60 output
 *   google gemini flash     : $0.075 input / $0.30 output
 *   llama local             : $0 (self-hosted)
 *
 * # Timeouts
 *
 * 60s per agent call. Longer panels indicate model latency, not a
 * real audit signal. Timed-out agents count as `degraded`.
 */

import type Database from 'better-sqlite3';

const PANEL_TIMEOUT_MS = 60_000;

export interface AgentCallResult {
  ok: true;
  content: string;
  input_tokens: number;
  output_tokens: number;
  usd_estimated: number;
}

export interface AgentCallFailure {
  ok: false;
  reason: string;
}

export type AgentCallResponse = AgentCallResult | AgentCallFailure;

interface CallOpts {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  db: Database.Database;
  panelReviewId: number;
}

/**
 * Log a cost_ledger row. Called once per successful agent invocation.
 */
function logCost(
  db: Database.Database,
  panelReviewId: number,
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  usdEstimated: number,
): void {
  db.prepare(
    `INSERT INTO cost_ledger(panel_review_id, provider, model, input_tokens, output_tokens, usd_estimated, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(panelReviewId, provider, model, inputTokens, outputTokens, usdEstimated, Date.now());
}

/**
 * OpenAI chat completions. GPT-4o-mini default.
 */
export async function callOpenAI(opts: CallOpts): Promise<AgentCallResponse> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, reason: 'OPENAI_API_KEY unset' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PANEL_TIMEOUT_MS);
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userPrompt },
        ],
        max_tokens: 800,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    const usd = (inputTokens * 0.15 + outputTokens * 0.6) / 1_000_000;
    logCost(opts.db, opts.panelReviewId, 'openai', opts.model, inputTokens, outputTokens, usd);
    return { ok: true, content, input_tokens: inputTokens, output_tokens: outputTokens, usd_estimated: usd };
  } catch (err) {
    return { ok: false, reason: `openai error: ${(err as Error).message.slice(0, 100)}` };
  }
}

/**
 * Google Gemini generateContent. Flash default.
 */
export async function callGoogle(opts: CallOpts): Promise<AgentCallResponse> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, reason: 'GOOGLE_API_KEY unset' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PANEL_TIMEOUT_MS);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${key}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: opts.userPrompt }] }],
        systemInstruction: { parts: [{ text: opts.systemPrompt }] },
        generationConfig: { maxOutputTokens: 800, temperature: 0.2 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    const data = (await resp.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
    const usd = (inputTokens * 0.075 + outputTokens * 0.3) / 1_000_000;
    logCost(opts.db, opts.panelReviewId, 'google', opts.model, inputTokens, outputTokens, usd);
    return { ok: true, content, input_tokens: inputTokens, output_tokens: outputTokens, usd_estimated: usd };
  } catch (err) {
    return { ok: false, reason: `google error: ${(err as Error).message.slice(0, 100)}` };
  }
}

/**
 * Local Llama endpoint (Ollama-compatible). Expects LLAMA_ENDPOINT_URL,
 * default http://localhost:11434/api/chat.
 */
export async function callLlama(opts: CallOpts): Promise<AgentCallResponse> {
  const url = process.env.LLAMA_ENDPOINT_URL || 'http://localhost:11434/api/chat';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PANEL_TIMEOUT_MS);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: opts.userPrompt },
        ],
        stream: false,
        options: { temperature: 0.2, num_predict: 800 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    const data = (await resp.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const content = data.message?.content ?? '';
    const inputTokens = data.prompt_eval_count ?? 0;
    const outputTokens = data.eval_count ?? 0;
    // Local llama is free — $0 estimated but tokens still logged for volume metrics.
    logCost(opts.db, opts.panelReviewId, 'llama_local', opts.model, inputTokens, outputTokens, 0);
    return { ok: true, content, input_tokens: inputTokens, output_tokens: outputTokens, usd_estimated: 0 };
  } catch (err) {
    return { ok: false, reason: `llama error: ${(err as Error).message.slice(0, 100)}` };
  }
}
