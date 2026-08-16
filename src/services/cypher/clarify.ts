/**
 * Cypher clarification — Phase 82c (2026-06-14), pivoted ADR-039 T2 (2026-06-26).
 *
 * The ask stage in `run.ts` v1 was a trivial "if goal is empty, ask"
 * heuristic. This module replaces it with a real LLM-driven analysis:
 *
 *   1. Given the goal text + the candidate skill catalog (descriptions
 *      kept as context only — NOT used to pick a skill), ask the model
 *      whether the goal carries enough scope information for downstream
 *      tool selection to be unambiguous.
 *   2. If yes, return `{ clear: true }` and the runtime proceeds.
 *   3. If no, return up to 3 targeted **scope** questions (about env,
 *      version, AC, out-of-scope, linkage) each with a concrete default.
 *
 * ADR-039 T2 framing pivot: the system prompt was previously "pick a
 * skill" classification. It is now "scope-complete brief, don't pick a
 * skill" — clarify is the *scope-completeness* check, not the *skill-
 * pick* check. The skill ranker runs downstream and consumes the brief
 * this stage produces. Questions never say "wi-X or wi-Y?" — they ask
 * about env / version / success_criteria / out_of_scope / linkage.
 *
 * Bucket: `agents` — classifier-style call, cadence-sensitive, structured
 * output. Same shape as score_severity / orchestrator. Per
 * `.claude/rules/model-config.md`.
 *
 * Hard rules:
 *   - Best-effort: any failure (LLM error, parse error, no DB) returns
 *     `{ clear: true }` so the runtime falls through to the existing
 *     skill-ranker. Cypher must never block on a failed clarification
 *     call — the user can always retry with a sharper goal.
 *   - Bounded: at most 3 questions. The runtime caps `ask` cycles at 1
 *     per session today (the user's answer comes back via /wi <text>
 *     and is treated as a new goal).
 *   - No side-effects: pure function over (goal, catalog). All state
 *     transitions (asked_user, completed, etc.) live in run.ts.
 */

import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { bucketCallParams } from './../model-config.js';

export interface CatalogEntry {
  skill_name: string;
  source: string;        // 'wi' | 'global' | 'plugin'
  description: string;
}

export interface ClarifyQuestion {
  id: string;
  question: string;
  default: string;
}

export type ClarifyResult =
  | { clear: true; reason?: string }
  | { clear: false; questions: ClarifyQuestion[]; reason?: string };

/**
 * Build a compact catalog summary the model can reason over without
 * blowing the context budget. Each line is `<name> [<source>]: <desc>`.
 * Descriptions are clipped to 140 chars — enough to disambiguate intent.
 */
function summarizeCatalog(entries: CatalogEntry[]): string {
  const MAX_DESC = 140;
  return entries
    .map(e => {
      const desc = (e.description ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESC);
      return `- ${e.skill_name} [${e.source}]: ${desc || '(no description)'}`;
    })
    .join('\n');
}

const SYSTEM_PROMPT = `You are Cypher's scope-completeness classifier. Build a scope-complete brief; do NOT pick a skill.

Your job: decide whether the user's goal carries enough scope information that downstream tool selection is unambiguous. You are NOT choosing a skill — the skill ranker runs after you. You are checking that the brief Cypher will hand to that ranker has the fields it needs.

Required scope fields:
- intent       — verb shape: investigate / build / review / analyze / answer
- target       — concrete object: Jira key, PR number, file path, symbol, dashboard, ADR
- env          — where it runs/lives: prod / staging / local / docs / a specific repo
- version      — branch, tag, commit SHA, sprint, or "current head"
- success_criteria — what "done" looks like (one observable thing)
- out_of_scope — what NOT to touch (at least the obvious adjacent surface)
- linkage      — Jira keys / PRs / ADRs / file paths the goal references

Default clear=true. Only return clear=false when a required field is missing AND that absence changes which downstream tool Cypher would pick. If the missing field doesn't shift tool selection (e.g. out_of_scope is missing but the rest of the brief unambiguously points at one tool), return clear=true.

Strong signals the goal IS clear (return clear=true):
- Goal contains a Jira key (JIRA-15702 / ABC-123), PR number (#4167 / PR-4167), or file path (src/foo/bar.ts).
- Verb + target pair with implicit env ("review PR #4167" → env=github, version=PR head).
- Goal names a specific deliverable ("show my action items", "today's digest", "morning brief").
- "test"/"verify"/"check that X works" with a concrete X.

Signals the goal IS NOT clear (return clear=false):
- Pure verb, no target ("do something", "look at things", "help me out").
- Target named but env/version genuinely changes which data source to hit (e.g. "the auth bug" with no Jira/PR/file — different sources for prod vs staging vs a specific branch).
- Success criteria so vague that two reasonable interpretations would call different tools.

When asking questions:
- Maximum 3, each <12 words.
- Ask about scope fields (env / version / success_criteria / out_of_scope / linkage). Never ask "which skill?" or "which tool?" or "use wi-X or wi-Y?".
- Each MUST have a concrete default Cypher would actually use — a real env name, a real version/branch, a real acceptance criterion phrased as one sentence. Never "ask the user", never "you decide", never "tbd".

The reason field: one short sentence on which scope field is missing and why it shifts tool selection. Do not mention skill names.`;

const TOOL_SCHEMA = {
  name: 'classify_clarity',
  description: 'Classify whether the goal is specific enough to dispatch a single skill, and produce clarifying questions if not.',
  input_schema: {
    type: 'object' as const,
    properties: {
      clear: {
        type: 'boolean',
        description: 'True iff one skill is clearly the best fit for this goal.',
      },
      reason: {
        type: 'string',
        description: 'One short sentence on why clear/not-clear (<= 24 words).',
      },
      questions: {
        type: 'array',
        description: 'When clear=false: 1–3 targeted questions with defaults. Empty when clear=true.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'kebab-case slug, e.g. "q-target"' },
            question: { type: 'string' },
            default: { type: 'string', description: 'Concrete fallback Cypher would use.' },
          },
          required: ['id', 'question', 'default'],
        },
        maxItems: 3,
      },
    },
    required: ['clear', 'reason', 'questions'],
  },
};

/**
 * Classify the goal's clarity against the candidate catalog.
 *
 * `db` is required because the bucket-aware Anthropic call reads
 * model+effort from the model_config table. Without it the call falls
 * back to RECOMMENDED defaults (still valid, just not user-tunable).
 *
 * Best-effort: any thrown error → `{ clear: true }`.
 */
export async function classifyClarity(opts: {
  goal: string;
  catalog: CatalogEntry[];
  db: Database.Database;
  client?: Anthropic;
}): Promise<ClarifyResult> {
  const { goal, catalog, db } = opts;

  // Trivial guards — short-circuit before paying for an LLM call.
  if (!goal || goal.trim().length < 4) {
    return {
      clear: false,
      reason: 'goal is empty or too short to disambiguate',
      questions: [
        {
          id: 'q-clarify-goal',
          question: 'What goal should Cypher run? (one short sentence)',
          default: 'investigate the open dispatch',
        },
      ],
    };
  }
  if (catalog.length === 0) {
    return { clear: true, reason: 'no candidates to disambiguate against' };
  }

  const client = opts.client ?? getDefaultClient();
  if (!client) {
    return { clear: true, reason: 'no Anthropic client available; falling through' };
  }

  // Cap catalog at 60 entries so the system prompt stays cache-friendly.
  // Cypher's caller will have ranked + de-duped already, but be defensive.
  const trimmedCatalog = catalog.slice(0, 60);
  const catalogText = summarizeCatalog(trimmedCatalog);

  let params: ReturnType<typeof bucketCallParams>;
  try {
    params = bucketCallParams(db, 'agents');
  } catch {
    return { clear: true, reason: 'bucket lookup failed; falling through' };
  }

  try {
    const response = await client.beta.promptCaching.messages.create({
      ...params,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      tools: [TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: 'classify_clarity' },
      messages: [
        {
          role: 'user',
          content: `User goal:\n${goal}\n\nAvailable skills:\n${catalogText}\n\nClassify clarity.`,
        },
      ],
    });

    const toolUse = response.content.find(b => b.type === 'tool_use') as
      | { type: 'tool_use'; input: unknown } | undefined;
    if (!toolUse) {
      return { clear: true, reason: 'model returned no tool_use; falling through' };
    }
    const parsed = toolUse.input as {
      clear: boolean;
      reason?: string;
      questions?: ClarifyQuestion[];
    };
    if (parsed.clear) {
      return { clear: true, reason: parsed.reason };
    }
    const qs = (parsed.questions ?? []).slice(0, 3).filter(q => q.question && q.default);
    if (qs.length === 0) {
      // Model said unclear but gave no questions — treat as clear so we
      // don't deadlock. The skill ranker will pick something with low
      // confidence, which is correct signaling.
      return { clear: true, reason: 'model flagged unclear but produced no questions' };
    }
    return { clear: false, reason: parsed.reason, questions: qs };
  } catch (err) {
    return { clear: true, reason: `clarify call failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Default Anthropic client construction — mirrors decision-engine.ts pattern.
// ---------------------------------------------------------------------------

function getDefaultClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  return new Anthropic({
    apiKey: baseURL ? 'x-proxy' : apiKey,
    ...(baseURL
      ? { baseURL, defaultHeaders: { Authorization: `Bearer ${apiKey}` } }
      : {}),
  });
}

/**
 * Helper for run.ts: pull catalog entries for the resolved candidate
 * list. Reads name + source + description from `skill_catalog` for any
 * skill in `names`. Skills missing from the catalog are silently skipped
 * (they exist as seeded defaults but have no rich description).
 */
export function fetchCatalogEntries(
  db: Database.Database,
  names: string[],
): CatalogEntry[] {
  if (names.length === 0) return [];
  try {
    const placeholders = names.map(() => '?').join(',');
    const rows = db
      .prepare(`
        SELECT skill_name, source, description
        FROM skill_catalog
        WHERE skill_name IN (${placeholders})
      `)
      .all(...names) as Array<{ skill_name: string; source: string; description: string | null }>;
    return rows.map(r => ({
      skill_name: r.skill_name,
      source: r.source,
      description: r.description ?? '',
    }));
  } catch {
    return [];
  }
}
