/**
 * Second-brain recall wiring (ADR-024 §6b).
 *
 * Connects Pillar 4 (`recallMemory`) into Pillar 2 (`buildBrainContext`) and
 * Pillar 1 (`runDecision`) so operational context and decisions automatically
 * see MemPalace + past brain_decisions + action clusters — not only via the
 * standalone POST /api/brain/recall endpoint.
 */

import type Database from 'better-sqlite3';
import type { PalaceClient } from '../../intelligence/palace-client.js';
import type { BrainContext } from './context-builder.js';
import { recallMemory, type RecallResult } from './recall.js';

export const CONTEXT_RECALL_LIMIT = 8;
export const DECIDE_RECALL_LIMIT = 12;

export interface RecallPatternInput {
  question?: string;
  sprintName?: string | null;
  stuckKeys?: string[];
  clusterSignatures?: string[];
}

/**
 * Build a single FTS-friendly pattern from operational signals + the user's question.
 * MemPalace search and SQL LIKE both use this string.
 */
export function buildRecallPattern(input: RecallPatternInput): string {
  const parts: string[] = [];
  if (input.sprintName?.trim()) parts.push(input.sprintName.trim());
  for (const key of (input.stuckKeys ?? []).slice(0, 5)) {
    if (key?.trim()) parts.push(key.trim());
  }
  for (const sig of (input.clusterSignatures ?? []).slice(0, 3)) {
    if (sig?.trim()) parts.push(sig.trim());
  }
  if (input.question?.trim()) {
    const q = input.question.trim().replace(/\s+/g, ' ');
    parts.push(q.length > 120 ? q.slice(0, 120) : q);
  }
  const joined = parts.join(' ').trim();
  return joined.length > 0 ? joined : 'work intelligence sprint jira';
}

/** Human-readable line for `memory_relevant[]` (ADR-024 example: "obs-6783: FF_RM_11372 pattern"). */
export function formatRecallLine(result: RecallResult): string {
  const snippet = result.snippet.replace(/\s+/g, ' ').trim().slice(0, 140);
  const score = result.score.toFixed(2);
  return `[${result.source}] ${result.id}: ${snippet} (score ${score})`;
}

export interface FetchMemoryRelevantArgs {
  db: Database.Database;
  pattern: string;
  palace?: PalaceClient | null;
  limit?: number;
}

/**
 * Run combined recall and return formatted strings. Never throws — failures
 * yield an empty list so context/decide stay available when palace is offline.
 */
export async function fetchMemoryRelevantStrings(
  args: FetchMemoryRelevantArgs,
): Promise<string[]> {
  const { db, pattern, palace = null, limit = CONTEXT_RECALL_LIMIT } = args;
  if (!pattern.trim()) return [];
  try {
    const results = await recallMemory({ db, pattern: pattern.trim(), limit, palace });
    return results.map(formatRecallLine);
  } catch (err) {
    console.error('[brain/recall-context] fetch failed:', err);
    return [];
  }
}

/**
 * Merge recall hits into `memory_relevant`, deduplicating by line text.
 */
export async function augmentMemoryRelevant(
  ctx: BrainContext,
  args: {
    db: Database.Database;
    palace?: PalaceClient | null;
    extraPattern?: string;
    limit?: number;
  },
): Promise<BrainContext> {
  const pattern = buildRecallPattern({
    question: args.extraPattern,
    sprintName: ctx.sprint?.name ?? null,
    stuckKeys: ctx.stuck_jiras.map((j) => j.key),
    clusterSignatures: ctx.noise_clusters.map((c) => c.signature),
  });

  const recalled = await fetchMemoryRelevantStrings({
    db: args.db,
    palace: args.palace ?? null,
    pattern,
    limit: args.limit ?? CONTEXT_RECALL_LIMIT,
  });

  const seen = new Set(ctx.memory_relevant);
  const merged = [...ctx.memory_relevant];
  for (const line of recalled) {
    if (!seen.has(line)) {
      seen.add(line);
      merged.push(line);
    }
  }

  return { ...ctx, memory_relevant: merged.slice(0, args.limit ?? CONTEXT_RECALL_LIMIT) };
}

/** Build pattern from an assembled BrainContext (no question). */
export function patternFromBrainContext(ctx: BrainContext): string {
  return buildRecallPattern({
    sprintName: ctx.sprint?.name ?? null,
    stuckKeys: ctx.stuck_jiras.map((j) => j.key),
    clusterSignatures: ctx.noise_clusters.map((c) => c.signature),
  });
}
