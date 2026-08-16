/**
 * ADR-053 — live LLM Architect review (closes RADAR "Shipped Architect is
 * deterministic").
 *
 * Two-tier review, per Q2 (Option B — the Architect is a reasoning-heavy
 * role, not a stateless service):
 *   1. The deterministic gate (`architectReview`) ALWAYS runs first. Structural
 *      defects (empty plan, cycle, orphan edges, missing Ops sub-task) need no
 *      Opus spend and its notes are authoritative for those failures.
 *   2. Only when the deterministic gate approves does the semantic LLM pass
 *      run — one call per goal via the `architect` model bucket (Opus,
 *      "call sparingly", ≤1×/goal per Q4). The LLM judges coverage, dependency
 *      order, and feasibility of the DAG against the brief.
 *
 * The LLM pass is advisory: on transport / parse failure it returns the
 * deterministic verdict (approved) with a note rather than blocking the plan
 * on infrastructure. The verdict parser is pure and unit-tested.
 *
 * See docs/docs/adr/adr-053-multi-stage-orchestration.md § Q2 / RADAR.
 */
import type Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { bucketCallParams } from '../model-config.js';
import {
  architectReview,
  type ArchitectInput,
  type ArchitectReview,
} from './architect-posture.js';

export interface ArchitectLiveOpts {
  /** Injectable for tests. Defaults to a real Anthropic client. */
  client?: Anthropic;
  /** Skip the LLM pass and return the deterministic verdict (tests / dry-run). */
  deterministicOnly?: boolean;
}

/** Build the semantic-review prompt for the LLM pass. */
export function buildArchitectPrompt(input: ArchitectInput): string {
  const { plan, brief } = input;
  return [
    'You are the Architect reviewing a PM-drafted sub-task plan for a cross-repo software feature.',
    '',
    'Goal: ' + brief.goal,
    'Intent: ' + brief.intent,
    'Target: ' + brief.target,
    'Affected repos: ' + (brief.affected_repos ?? []).join(', ') || '(none detected)',
    '',
    'Plan (DAG): ' + JSON.stringify(plan, null, 2),
    '',
    'Check:',
    '1. Every affected repo is covered by at least one sub-task.',
    '2. Dependency order is sensible (code/backend before frontend integration, deploy last).',
    '3. The plan is minimal but complete — no missing step that would block execution.',
    '4. No structural risk that would stall execution (missing ACs, unclear handoffs).',
    '',
    'Respond with ONLY a JSON object, no prose:',
    '{"verdict":"approved"|"revise","notes":["note1","note2"]}',
    '',
    'Use "revise" sparingly — only when a concrete defect would block execution. ' +
      'Notes must be actionable for the PM to re-draft against.',
  ].join('\n');
}

/**
 * Parse the LLM's JSON verdict. Tolerant of a ```json fence. Throws on
 * unparseable output or an invalid verdict value — callers treat a throw as
 * "LLM pass unavailable" and fall back to the deterministic verdict.
 */
export function parseArchitectVerdict(text: string): ArchitectReview {
  let jsonStr: string | undefined;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    jsonStr = fence[1].trim();
  } else {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) jsonStr = text.slice(first, last + 1);
  }
  if (!jsonStr) throw new Error('architect-review-live: no JSON verdict found in model output');

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`architect-review-live: failed to parse verdict JSON: ${(e as Error).message}`);
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;
  const verdict = String(obj.verdict ?? '');
  if (verdict !== 'approved' && verdict !== 'revise') {
    throw new Error(`architect-review-live: invalid verdict '${verdict}' (expected approved|revise)`);
  }
  const notes = Array.isArray(obj.notes)
    ? obj.notes.map((n) => String(n)).filter((n) => n.length > 0)
    : [];
  return { verdict, notes };
}

/** Coalesce assistant text content (same pattern as pm-drafter-sonnet). */
function coalesceText(resp: Anthropic.Message): string {
  return (resp.content || [])
    .map((b: { type?: string; text?: string }) => (b && b.type === 'text' ? String(b.text || '') : ''))
    .join('\n');
}

/**
 * Live architect review: deterministic gate first, then one Opus semantic
 * pass when the gate approves. Never throws — infrastructure failure degrades
 * to the deterministic verdict.
 */
export async function architectReviewLive(
  db: Database.Database,
  input: ArchitectInput,
  opts: ArchitectLiveOpts = {},
): Promise<ArchitectReview> {
  // Tier 1 — deterministic structural gate. Its revise notes are authoritative;
  // no Opus spend on plans that fail structure.
  const structural = architectReview(input);
  if (structural.verdict === 'revise') return structural;
  if (opts.deterministicOnly) return structural;

  // Tier 2 — one semantic LLM review per goal (Q4 "always at decomposition").
  try {
    const client =
      opts.client ??
      new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY || '',
        baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
      });
    const params = bucketCallParams(db, 'architect');
    const resp = await client.messages.create({
      ...params,
      messages: [{ role: 'user', content: buildArchitectPrompt(input) }],
    } as any);
    return parseArchitectVerdict(coalesceText(resp));
  } catch (err) {
    const msg = (err as Error).message;
    console.error(
      `[ADR-053] architect LLM review unavailable (${msg}) — falling back to deterministic approval`,
    );
    return {
      verdict: 'approved',
      notes: [`LLM architect review unavailable (${msg}); deterministic gate approved`],
    };
  }
}

export default architectReviewLive;
