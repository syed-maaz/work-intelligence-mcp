/**
 * Substrate fix #1 — GET /api/persona
 *
 * Returns a synthesized system-prompt block any consumer (Claude Code, Atlas,
 * Hermes if ever adopted, future runtimes) can inject at session start.
 * Closes the "generic voice" gap from the Hermes Agent decline:
 * persona is owned by WI, consumed identically across runtimes.
 *
 * Sources (priority order):
 *   1. ~/.claude/projects/<project>/memory/user_preferences.md — canonical
 *   2. ~/.claude/projects/<project>/memory/MEMORY.md — index of other memory files
 *   3. user_profile_observations rolling 7-day aggregates (kinds + targets)
 *   4. Top recurring Jira keys from messages (last 30d)
 *
 * Pure assembly — no LLM call. Cached 15 min keyed by (user, mode).
 *
 * Phase 78a-03: `?mode=work|life|mixed` query param.
 *   - WORK: existing synthesis (per-mode budget 1500 tokens)
 *   - LIFE: stub fall-through to WORK content + leading marker line
 *           (real life persona ships in 78c with `life_facts` table); budget 1200
 *   - MIXED: WORK + LIFE half-strength concatenation (budget 1800)
 *   - Default (no mode param): WORK — preserves backward compat
 *
 * Refs: .planning/ADR-REVIEW.md graphify+Hermes decline → substrate fix #1.
 *       .planning/phases/78a-chat-fix-only/78a-03-PLAN.md (D-78a-07/08/09).
 */

import type Database from 'better-sqlite3';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

import { json } from './_util.js';
import type { RouteHandler } from './_types.js';

const CACHE_TTL_MS = 15 * 60 * 1000;
const PROFILE_WINDOW_DAYS = 7;
const RECURRING_JIRA_WINDOW_DAYS = 30;
const TOP_N = 5;

/**
 * D-78a-09: Per-mode hard token caps. Truncation runs deterministically when
 * the synthesized body exceeds the budget for the requested mode.
 */
export type PersonaMode = 'work' | 'life' | 'mixed';

export const TOKEN_BUDGETS: Record<PersonaMode, number> = {
  work: 1500,
  life: 1200,
  mixed: 1800,
};

const TRUNCATION_MARKER = '... [persona truncated to fit budget]';
const LIFE_STUB_MARKER = '# Life mode (Phase 78c stub fall-through)';
const TONE_SPLIT_SENTENCE =
  'If the user expresses fatigue or frustration, acknowledge it briefly before answering technically — but do not infer personal context beyond the immediate message.';

interface PersonaCacheEntry {
  result: PersonaResponse;
  expiresAt: number;
}

interface PersonaResponse {
  systemPrompt: string;
  version: string;
  user: string;
  mode: PersonaMode;
  sources: string[];
  generatedAt: string;
}

const cache = new Map<string, PersonaCacheEntry>();

/**
 * Test helper: clear the in-process cache. Exported so unit tests can reset
 * state between cases without re-importing the module.
 */
export function resetPersonaCache(): void {
  cache.clear();
}

/**
 * Locate the project's memory dir under ~/.claude/projects/<slug>/memory/.
 * The slug is the absolute project path with `/` replaced by `-`.
 * Returns the directory if it exists, or null.
 */
export function locateMemoryDir(projectRoot: string): string | null {
  const slug = projectRoot.replaceAll('/', '-');
  const candidate = join(homedir(), '.claude', 'projects', slug, 'memory');
  return existsSync(candidate) ? candidate : null;
}

/**
 * Read a memory file under the project's memory dir; return contents or null.
 * Capped at 8KB to keep persona compact.
 */
function readMemoryFile(memoryDir: string, name: string): string | null {
  const path = join(memoryDir, name);
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (!stat.isFile()) return null;
  const raw = readFileSync(path, 'utf8');
  return raw.slice(0, 8192);
}

interface TopKind { kind: string; count: number }
interface TopTarget { target: string; count: number }

/**
 * Roll up user_profile_observations over the last N days into top-N kinds
 * and top-N targets. Used by persona synthesis and exported for /api/profile.
 *
 * Phase 78a-03: also returns `observations` — the raw rows in append (oldest-first)
 * order so the truncator can drop oldest entries first.
 */
export function getRollingProfile(db: Database.Database, user: string, windowDays = PROFILE_WINDOW_DAYS): {
  topKinds: TopKind[];
  topTargets: TopTarget[];
  totalObservations: number;
  observations: Array<{ ts: string; kind: string; target: string | null }>;
} {
  // Schema v51 may not exist on older DBs — degrade gracefully.
  try {
    const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='user_profile_observations'`).get();
    if (!tableCheck) return { topKinds: [], topTargets: [], totalObservations: 0, observations: [] };

    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM user_profile_observations WHERE user = ? AND ts > ?`).get(user, since) as { n: number };

    const kindRows = db.prepare(`
      SELECT kind, COUNT(*) AS count
      FROM user_profile_observations
      WHERE user = ? AND ts > ?
      GROUP BY kind
      ORDER BY count DESC
      LIMIT ?
    `).all(user, since, TOP_N) as TopKind[];

    // Targets: pull payload.target if present (free-form JSON; null-safe).
    const targetRows = db.prepare(`
      SELECT json_extract(payload, '$.target') AS target, COUNT(*) AS count
      FROM user_profile_observations
      WHERE user = ? AND ts > ? AND json_extract(payload, '$.target') IS NOT NULL
      GROUP BY target
      ORDER BY count DESC
      LIMIT ?
    `).all(user, since, TOP_N) as TopTarget[];

    // Raw rows in oldest-first order — truncator drops from the head (FIFO).
    const obsRows = db.prepare(`
      SELECT ts, kind, json_extract(payload, '$.target') AS target
      FROM user_profile_observations
      WHERE user = ? AND ts > ?
      ORDER BY ts ASC
    `).all(user, since) as Array<{ ts: string; kind: string; target: string | null }>;

    return {
      topKinds: kindRows,
      topTargets: targetRows,
      totalObservations: totalRow.n,
      observations: obsRows,
    };
  } catch {
    return { topKinds: [], topTargets: [], totalObservations: 0, observations: [] };
  }
}

/**
 * Top N Jira keys mentioned in recent messages, with their occurrence counts.
 * Approximates "what Maaz is working on lately" without a separate analyzer call.
 */
interface JiraKeyEntry { key: string; count: number }

function getRecurringJiraKeys(db: Database.Database, windowDays = RECURRING_JIRA_WINDOW_DAYS): JiraKeyEntry[] {
  try {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT content FROM messages WHERE timestamp > ? LIMIT 5000
    `).all(since) as { content: string }[];
    const counts = new Map<string, number>();
    const re = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
    for (const row of rows) {
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(row.content || '')) !== null) {
        const key = m[1];
        if (seen.has(key)) continue;
        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([key, count]) => ({ key, count }));
  } catch {
    return [];
  }
}

/**
 * Synthesizer input — kept as a mutable shape so the truncator can drop
 * sources in priority order (D-78a-09) without re-fetching from the DB.
 */
interface SynthInput {
  user: string;
  preferences: string | null;
  memoryIndex: string | null;
  vaultAnnotations: string | null;
  topKinds: TopKind[];
  topTargets: TopTarget[];
  totalObservations: number;
  observations: Array<{ ts: string; kind: string; target: string | null }>;
  recurringJiraKeys: JiraKeyEntry[];
  toneSplit: boolean; // include the persona/tone-split sentence (WORK + MIXED)
  stubMarker: boolean; // prepend the LIFE/MIXED stub marker line
  halfStrength: boolean; // MIXED — halve observation + jira lists before synthesis
}

/**
 * Synthesize the persona system prompt block from collected sources.
 * Pure assembly — keeps output deterministic and cheap.
 */
function synthesizePersonaPrompt(args: SynthInput): { prompt: string; sources: string[] } {
  const sources: string[] = [];
  const lines: string[] = [];

  if (args.stubMarker) {
    lines.push(LIFE_STUB_MARKER);
  }

  lines.push(`# WI Persona — assembled by GET /api/persona`);
  lines.push(`# user: ${args.user}`);
  lines.push('');

  if (args.preferences) {
    sources.push('memory/user_preferences.md');
    lines.push('## User preferences (canonical)');
    lines.push(args.preferences.trim());
    lines.push('');
  }

  if (args.memoryIndex) {
    sources.push('memory/MEMORY.md');
    lines.push('## Memory index (use as reference)');
    lines.push(args.memoryIndex.trim());
    lines.push('');
  }

  // §6 (Obsidian vault bridge, 2026-07-18): the user's own vault annotations —
  // human corrections to what WI auto-wrote about live topics. Highest-trust
  // signal in the persona (the user typed it), so it renders right after the
  // memory index and is protected above the observation lists in the budget
  // trim order. Exported to memory/vault_annotations.md by obsidian-export.ts
  // on each sync; read here symmetrically with the other memory files.
  if (args.vaultAnnotations) {
    sources.push('memory/vault_annotations.md');
    lines.push('## Vault annotations (your recent human corrections — high trust)');
    lines.push(args.vaultAnnotations.trim());
    lines.push('');
  }

  // MIXED half-strength: trim observation/jira lists to half before rendering.
  // Truncation step uses the same input shape so MIXED already starts smaller.
  let observations = args.observations;
  let topKinds = args.topKinds;
  let topTargets = args.topTargets;
  let recurringJiraKeys = args.recurringJiraKeys;
  if (args.halfStrength) {
    observations = observations.slice(Math.floor(observations.length / 2));
    topKinds = topKinds.slice(0, Math.ceil(topKinds.length / 2));
    topTargets = topTargets.slice(0, Math.ceil(topTargets.length / 2));
    recurringJiraKeys = recurringJiraKeys.slice(0, Math.ceil(recurringJiraKeys.length / 2));
  }

  if (args.totalObservations > 0 && (topKinds.length > 0 || topTargets.length > 0)) {
    sources.push('user_profile_observations (rolling 7d)');
    lines.push(`## Recent activity (last 7d, ${observations.length} of ${args.totalObservations} observations shown)`);
    if (topKinds.length > 0) {
      lines.push(`- Top actions: ${topKinds.map(k => `${k.kind} (${k.count})`).join(', ')}`);
    }
    if (topTargets.length > 0) {
      lines.push(`- Top targets: ${topTargets.map(t => `${t.target} (${t.count})`).join(', ')}`);
    }
    lines.push('');
  }

  if (recurringJiraKeys.length > 0) {
    sources.push('messages (Jira-key extraction, last 30d)');
    lines.push(`## Active Jira tickets (last 30d): ${recurringJiraKeys.map(j => j.key).join(', ')}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('Use this context to ground your responses. Prefer specific, concrete answers over generic helpfulness. Match Maaz\'s reflexes (smoke-test before declaring done, save investigation findings to ticket, etc.) when applicable.');

  if (args.toneSplit) {
    lines.push('');
    lines.push(TONE_SPLIT_SENTENCE);
  }

  return { prompt: lines.join('\n'), sources };
}

/**
 * D-78a-09 token counting.
 * Anthropic's `client.messages.countTokens()` is not in scope for this route
 * (no analyzer dependency) — fall back to the documented ~4-chars-per-token
 * English heuristic. Deterministic; cache-friendly.
 */
async function countTokens(s: string): Promise<number> {
  return Math.ceil(s.length / 4);
}

/**
 * D-78a-09 priority-ordered truncation. Drops in this order:
 *   1. Oldest user_profile_observations rows (FIFO from head)
 *   2. Lowest-recurrence Jira keys (sort ASC, drop from bottom)
 *   3. Longest MEMORY.md section header + body block
 * Then appends the literal marker on its own line.
 *
 * Returns the new prompt + sources + a `truncated` flag so the caller can
 * decide whether to emit the marker (only when something was actually trimmed).
 */
async function enforceBudget(
  initial: SynthInput,
  budget: number,
): Promise<{ prompt: string; sources: string[]; truncated: boolean }> {
  let synth = synthesizePersonaPrompt(initial);
  if ((await countTokens(synth.prompt)) <= budget) {
    return { ...synth, truncated: false };
  }

  // Mutable working copy.
  const work: SynthInput = {
    ...initial,
    observations: [...initial.observations],
    topKinds: [...initial.topKinds],
    topTargets: [...initial.topTargets],
    // Drop lowest-recurrence (ASC) entries from the bottom of this list.
    recurringJiraKeys: [...initial.recurringJiraKeys].sort((a, b) => b.count - a.count),
  };

  // Step 1: drop oldest observations one at a time (FIFO).
  while (work.observations.length > 0) {
    work.observations.shift();
    // Top kinds/targets aggregate from the same source; recompute proportionally.
    // We're being conservative: only the body lists "shown" observations, so
    // resynthesize and check.
    synth = synthesizePersonaPrompt(work);
    if ((await countTokens(synth.prompt)) <= budget) {
      return { ...synth, truncated: true, prompt: synth.prompt + '\n' + TRUNCATION_MARKER };
    }
  }
  // After exhausting obs rows, drop topKinds/topTargets too.
  while (work.topKinds.length > 0 || work.topTargets.length > 0) {
    if (work.topKinds.length > 0) work.topKinds.pop();
    if (work.topTargets.length > 0) work.topTargets.pop();
    synth = synthesizePersonaPrompt(work);
    if ((await countTokens(synth.prompt)) <= budget) {
      return { ...synth, truncated: true, prompt: synth.prompt + '\n' + TRUNCATION_MARKER };
    }
  }

  // Step 2: drop lowest-recurrence Jira keys from the bottom of the
  // recurrence-DESC list (i.e. the lowest counts go first).
  while (work.recurringJiraKeys.length > 0) {
    work.recurringJiraKeys.pop();
    synth = synthesizePersonaPrompt(work);
    if ((await countTokens(synth.prompt)) <= budget) {
      return { ...synth, truncated: true, prompt: synth.prompt + '\n' + TRUNCATION_MARKER };
    }
  }

  // Step 3: drop the longest MEMORY.md section header + body block. We model
  // MEMORY.md as a sequence of `## ...` sections; drop the longest until under
  // budget OR the field is empty. memoryIndex is a single string — split on
  // `\n## ` and drop the longest chunk.
  if (work.memoryIndex) {
    const parts = splitMemorySections(work.memoryIndex);
    while (parts.length > 0) {
      // Find longest by char length (approximates token length).
      let longestIdx = 0;
      for (let i = 1; i < parts.length; i++) {
        if (parts[i].length > parts[longestIdx].length) longestIdx = i;
      }
      parts.splice(longestIdx, 1);
      work.memoryIndex = parts.length > 0 ? parts.join('\n## ').replace(/^/, parts[0].startsWith('# ') ? '' : '## ') : null;
      synth = synthesizePersonaPrompt(work);
      if ((await countTokens(synth.prompt)) <= budget) {
        return { ...synth, truncated: true, prompt: synth.prompt + '\n' + TRUNCATION_MARKER };
      }
    }
    work.memoryIndex = null;
  }

  // If we're still over budget after exhausting all three sources, also drop
  // preferences (last-resort) so we don't return an over-budget body.
  if (work.preferences) {
    work.preferences = null;
    synth = synthesizePersonaPrompt(work);
    if ((await countTokens(synth.prompt)) <= budget) {
      return { ...synth, truncated: true, prompt: synth.prompt + '\n' + TRUNCATION_MARKER };
    }
  }

  // All sources exhausted. Return whatever we have with the marker.
  return { ...synth, truncated: true, prompt: synth.prompt + '\n' + TRUNCATION_MARKER };
}

/**
 * Split a MEMORY.md-style document into top-level sections. The first chunk
 * may include the `# Title` line; subsequent chunks each start at a `## `
 * section header. Used by the truncator's step 3.
 */
function splitMemorySections(memoryIndex: string): string[] {
  // Split on lines starting with `## `. The first chunk is whatever precedes
  // the first `## ` (could be the document title).
  const parts = memoryIndex.split(/\n## /g);
  // Reattach the `## ` prefix to every chunk after the first so the section
  // shape survives a re-join.
  return parts.map((p, i) => (i === 0 ? p : '## ' + p));
}

/**
 * Parse and validate the `?mode=` query param. Returns the parsed mode or
 * `null` for an explicit invalid value (caller emits HTTP 400). Missing param
 * defaults to 'work' (D-78a-09 backward-compat).
 */
function parseMode(raw: string | null): PersonaMode | null {
  if (raw === null || raw === '') return 'work';
  if (raw === 'work' || raw === 'life' || raw === 'mixed') return raw;
  return null; // invalid sentinel
}

const personaRoute: RouteHandler = {
  method: 'GET',
  path: '/api/persona',
  async handle(_req, res, ctx, url) {
    try {
      const user = (url.searchParams.get('user') || 'maaz').toString().slice(0, 64);
      const refresh = url.searchParams.get('refresh') === '1';
      const modeRaw = url.searchParams.get('mode');
      const mode = parseMode(modeRaw);
      if (mode === null) {
        json(res, 400, { error: "mode must be 'work', 'life', or 'mixed'" });
        return;
      }

      // D-78a-08: cache key is `${user}:${mode}` so the three modes have
      // independent 15-min cache slots.
      const cacheKey = `${user}:${mode}`;

      if (!refresh) {
        const hit = cache.get(cacheKey);
        if (hit && hit.expiresAt > Date.now()) {
          json(res, 200, { ...hit.result, cached: true });
          return;
        }
      }

      const projectRoot = process.cwd();
      const memoryDir = locateMemoryDir(projectRoot);
      const preferences = memoryDir ? readMemoryFile(memoryDir, 'user_preferences.md') : null;
      const memoryIndex = memoryDir ? readMemoryFile(memoryDir, 'MEMORY.md') : null;
      const vaultAnnotations = memoryDir ? readMemoryFile(memoryDir, 'vault_annotations.md') : null;
      const rollingProfile = getRollingProfile(ctx.db, user, PROFILE_WINDOW_DAYS);
      const recurringJiraKeys = getRecurringJiraKeys(ctx.db, RECURRING_JIRA_WINDOW_DAYS);

      // D-78a-07: branch synthesis by mode. WORK is the existing path; LIFE
      // falls through to WORK content with a leading stub marker (78c
      // ships the real life persona); MIXED is half-strength concatenation
      // with the same stub marker so its version hash differs from WORK.
      const baseInput: SynthInput = {
        user,
        preferences,
        memoryIndex,
        vaultAnnotations,
        topKinds: rollingProfile.topKinds,
        topTargets: rollingProfile.topTargets,
        totalObservations: rollingProfile.totalObservations,
        observations: rollingProfile.observations,
        recurringJiraKeys,
        toneSplit: mode !== 'life',  // WORK + MIXED include CHAT-04 tone split
        stubMarker: mode !== 'work', // LIFE + MIXED include the 78c stub marker
        halfStrength: mode === 'mixed',
      };

      const startedAt = Date.now();
      const { prompt, sources } = await enforceBudget(baseInput, TOKEN_BUDGETS[mode]);
      const freshSynthesisMs = Date.now() - startedAt;

      // Version hash includes (user, mode, body) — content-derived, no time
      // component. Stable within (user, mode); differs across modes because
      // body differs (LIFE/MIXED include the stub marker; WORK doesn't).
      const version = createHash('sha256')
        .update(user + ':' + mode + ':' + prompt)
        .digest('hex')
        .slice(0, 12);

      const result: PersonaResponse = {
        systemPrompt: prompt,
        version,
        user,
        mode,
        sources,
        generatedAt: new Date().toISOString(),
      };

      cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      json(res, 200, { ...result, cached: false, freshSynthesisMs });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[persona] error:', err);
      json(res, 500, { error: 'internal_error', message: String((err as Error)?.message || err) });
    }
  },
};

export const personaRoutes: RouteHandler[] = [personaRoute];

/**
 * Phase 78a-04: in-process persona synthesis helper. Factored out of the
 * `_testSynthesizePersona` test helper so `web-server.js` can call into the
 * persona pipeline without going over HTTP. Same code path, same cache, same
 * 15-min TTL keyed by `(user, mode)`.
 *
 * Used by POST /api/chat (78a-04 / Task 3) to inject a per-mode cached
 * system block into `analyzer.chatWithContext`. Caller is responsible for
 * mapping the mode-detect result onto `'work' | 'life' | 'mixed'` (in 78a
 * `'work'` and `'life'` are the only outputs from the detector; AMBIGUOUS
 * short-circuits before reaching this helper).
 *
 * No new bucket / no new Anthropic call — pure local synthesis. Reuses the
 * existing budget enforcement + version hashing.
 */
export async function getPersonaForMode(args: {
  db: Database.Database;
  user: string;
  mode: PersonaMode;
  refresh?: boolean;
}): Promise<{
  systemPrompt: string;
  version: string;
  user: string;
  mode: PersonaMode;
  sources: string[];
  cached: boolean;
  freshSynthesisMs: number;
}> {
  return _testSynthesizePersona(args);
}

/**
 * Test helper: execute the persona route synthesis path directly without a
 * full HTTP req/res. Returns the same response shape the HTTP route emits.
 *
 * Used by tests/routes/persona-mode.test.ts; not used by web-server.js.
 */
export async function _testSynthesizePersona(args: {
  db: Database.Database;
  user: string;
  mode: PersonaMode;
  refresh?: boolean;
}): Promise<{
  systemPrompt: string;
  version: string;
  user: string;
  mode: PersonaMode;
  sources: string[];
  cached: boolean;
  freshSynthesisMs: number;
}> {
  const cacheKey = `${args.user}:${args.mode}`;
  if (!args.refresh) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return { ...hit.result, cached: true, freshSynthesisMs: 0 };
    }
  }

  const projectRoot = process.cwd();
  const memoryDir = locateMemoryDir(projectRoot);
  const preferences = memoryDir ? readMemoryFile(memoryDir, 'user_preferences.md') : null;
  const memoryIndex = memoryDir ? readMemoryFile(memoryDir, 'MEMORY.md') : null;
  const vaultAnnotations = memoryDir ? readMemoryFile(memoryDir, 'vault_annotations.md') : null;
  const rollingProfile = getRollingProfile(args.db, args.user, PROFILE_WINDOW_DAYS);
  const recurringJiraKeys = getRecurringJiraKeys(args.db, RECURRING_JIRA_WINDOW_DAYS);

  const baseInput: SynthInput = {
    user: args.user,
    preferences,
    memoryIndex,
    vaultAnnotations,
    topKinds: rollingProfile.topKinds,
    topTargets: rollingProfile.topTargets,
    totalObservations: rollingProfile.totalObservations,
    observations: rollingProfile.observations,
    recurringJiraKeys,
    toneSplit: args.mode !== 'life',
    stubMarker: args.mode !== 'work',
    halfStrength: args.mode === 'mixed',
  };

  const startedAt = Date.now();
  const { prompt, sources } = await enforceBudget(baseInput, TOKEN_BUDGETS[args.mode]);
  const freshSynthesisMs = Date.now() - startedAt;

  const version = createHash('sha256')
    .update(args.user + ':' + args.mode + ':' + prompt)
    .digest('hex')
    .slice(0, 12);

  const result: PersonaResponse = {
    systemPrompt: prompt,
    version,
    user: args.user,
    mode: args.mode,
    sources,
    generatedAt: new Date().toISOString(),
  };

  cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return { ...result, cached: false, freshSynthesisMs };
}
