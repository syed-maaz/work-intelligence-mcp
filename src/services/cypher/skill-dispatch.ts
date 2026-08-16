/**
 * ADR-040 F4 fix (2026-07-09): rewrite of `runSkillSubagent` to close
 * GAP-001 for real. The v1 (commits 3+4) shape was:
 *   spawn `claude -p '<prompt asking Claude to read SKILL.md and emit JSON>'`
 * which produced the "Claude narrates about the skill instead of running
 * it" pathology visible in the 2026-07-09 audit (subagent_dispatches
 * `sad_ecf5ea8d647e` returned "smoke skipped: wi-pr-review skill read-only
 * analysis — no code was modified" instead of the actual PR review).
 *
 * # G2 Dispatch rewrite (2026-08-06)
 *
 * Root cause of 8-10% success rate: HTTP self-loop fetch to bridge
 * endpoints with blanket 5-min timeout, zero retry, zero reaper.
 *
 * Fix:
 *   1. Per-skill timeouts from dispatch-timeouts.ts (60s default, tuned per skill).
 *   2. Retry x2 with 1s backoff — transient failures recover.
 *   3. DLQ (dead letter queue): after 2 retries → status='timed_out'
 *      with error_text='DLQ after 2 retries: <last error>'.
 *   4. Tool-catalog direct invoke for wi_search / wi_search_all —
 *      calls handlers in-process (no HTTP loopback), the two
 *      highest-volume skills.
 *
 * # Dispatch flow
 *
 *   runSkillSubagent(skillName, args, ctx)
 *     → write pending audit row
 *     → look up route in SKILL_ROUTES
 *     → cli-only? → failed (already handled pre-G2)
 *     → try tool-catalog direct (wi_search, wi_search_all)
 *     → fall through to HTTP fetch with retry x2 + per-skill timeout
 *     → on retry exhaustion → DLQ row (status='timed_out')
 *
 * See:
 *   - ADR-040 §3.5 subagent_dispatches
 *   - docs/planning/MULTIAGENT-EXECUTION-2026-08-06.md § G2
 *   - src/services/cypher/dispatch-timeouts.ts
 */

import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getTimeoutForSkill } from './dispatch-timeouts.js';
import { getWiConfig } from '../wi-config.js';

export interface SkillDispatchArgs {
  goal?: string;
  context?: string;
  [k: string]: unknown;
}

export interface SkillDispatchContext {
  db: Database.Database;
  sessionId: string;
  taskId?: string;
  /** Bridge base URL. Defaults to http://localhost:3132 (self-loop). */
  bridgeBaseUrl?: string;
}

export interface SkillDispatchResult {
  id: string;
  status: 'succeeded' | 'failed' | 'timed_out' | 'dead_lettered';
  output_summary: string;
  result_json?: unknown;
  error?: string;
  tokens_used?: number;
  duration_ms: number;
}

const DEFAULT_BRIDGE = process.env.WI_BRIDGE_URL || 'http://localhost:3132';

const DEFAULT_DISPATCH_REPO: string = (() => {
  try {
    const repos = getWiConfig().repos ?? [];
    if (repos.length > 0) return repos[0].name;
  } catch { /* config missing — fall through */ }
  if (process.env.REPO_PATH) return 'workspace';
  return 'app';
})();

// ── SKILL ROUTES ─────────────────────────────────────────────────────────
// Map each wi-* skill to how it dispatches:
//
//   mode: 'get'        — GET request; `buildQuery` produces the querystring
//   mode: 'post'       — POST JSON; `buildBody` produces the request body
//   mode: 'cli-only'   — skill can't be run from the bridge; dispatch fails
//                        with a named reason (this is honest — better than
//                        pretending it succeeded).
//
// The keys here MUST match the skill directory names in
// ~/.claude/skills/work-intelligence/.
type SkillRoute =
  | { mode: 'get'; path: string; buildQuery: (a: SkillDispatchArgs) => string; summarize?: (r: unknown) => string; timeout_ms?: number }
  | { mode: 'post'; path: string; buildBody: (a: SkillDispatchArgs) => unknown; summarize?: (r: unknown) => string; timeout_ms?: number }
  | { mode: 'cli-only'; reason: string };

const SKILL_ROUTES: Record<string, SkillRoute> = {
  'wi-search': {
    mode: 'post',
    path: '/api/search-all',
    // B3 (2026-07-13 audit): endpoint is heavy (FTS across Jira/Teams/Email/GitHub +
    // Palace embedding join). Global 5-min dispatcher cap let 8/8 dispatches hit
    // full timeout. Cap at 60s per-skill + default limit 10→5. If /api/search-all
    // can't answer in 60s at limit=5, the answer isn't useful anyway.
    buildBody: (a) => ({ query: String(a.query ?? a.goal ?? ''), limit: Number(a.limit ?? 5) }),
    summarize: (r) => summarizeResults(r, 'results'),
    timeout_ms: 60_000,
  },
  'wi-search-all': {
    mode: 'post',
    path: '/api/search-all',
    buildBody: (a) => ({ query: String(a.query ?? a.goal ?? ''), limit: Number(a.limit ?? 5) }),
    summarize: (r) => summarizeResults(r, 'results'),
    timeout_ms: 60_000,
  },
  'wi-investigate': {
    mode: 'post',
    path: '/api/jira/investigate',
    buildBody: (a) => ({ key: String(a.jira_key ?? a.key ?? '') }),
    summarize: (r) => {
      const conf = extractField(r, 'confidence');
      const rc = extractField(r, 'root_cause');
      return `investigation: conf=${conf ?? '?'} rc=${(rc ?? '').slice(0, 60)}`;
    },
  },
  'wi-jira-analyze':  { mode: 'cli-only', reason: 'wi-jira-analyze requires ticket title/status not available in a bare jira_key dispatch; call via slash command from Claude Code where ticket context is loaded.' },
  'wi-jira-report': {
    mode: 'get',
    path: '/api/board/issues',
    buildQuery: () => '',
    summarize: (r) => summarizeResults(r, 'issues'),
  },
  'wi-pr-review': {
    mode: 'post',
    path: '/api/pr/enrich',
    buildBody: (a) => ({ prUrl: String(a.pr_url ?? a.prUrl ?? '') || undefined, pr: a.pr, repo: a.repo }),
    summarize: (r) => `PR enriched — ${extractField(r, 'summary') ?? 'ok'}`,
  },
  'wi-blast-radius': {
    mode: 'get',
    path: '/api/code-graph/blast-radius',
    buildQuery: (a) => `?file=${encodeURIComponent(String(a.file ?? ''))}${a.repo ? `&repo=${encodeURIComponent(String(a.repo))}` : ''}`,
    summarize: (r) => `blast radius: ${extractField(r, 'total_dependents') ?? '?'} dependents`,
  },
  'wi-teammate': {
    mode: 'get',
    path: '/api/teammates',
    buildQuery: (a) => `?q=${encodeURIComponent(String(a.name ?? a.q ?? a.goal ?? ''))}`,
    summarize: (r) => summarizeResults(r, 'teammates'),
  },
  'wi-teams-search': {
    mode: 'get',
    path: '/api/teams-updates',
    buildQuery: (a) => `?query=${encodeURIComponent(String(a.query ?? a.goal ?? ''))}${a.since ? `&since=${encodeURIComponent(String(a.since))}` : ''}`,
    summarize: (r) => summarizeResults(r, 'messages'),
  },
  'wi-action-items': {
    mode: 'get',
    path: '/api/action-items',
    buildQuery: (a) => {
      const p = new URLSearchParams();
      if (a.status) p.set('status', String(a.status));
      if (a.assignee) p.set('assignee', String(a.assignee));
      if (a.topic) p.set('topic', String(a.topic));
      const q = p.toString();
      return q ? `?${q}` : '';
    },
    summarize: (r) => summarizeResults(r, 'action_items'),
  },
  'wi-daily-digest': {
    mode: 'get',
    path: '/api/digest',
    buildQuery: (a) => (a.topic ? `?topic=${encodeURIComponent(String(a.topic))}` : ''),
    summarize: (r) => `digest ready: ${extractField(r, 'summary')?.slice(0, 80) ?? 'ok'}`,
  },
  'wi-palace-query': {
    mode: 'post',
    path: '/api/palace/query',
    buildBody: (a) => ({ query: String(a.query ?? a.goal ?? '') }),
    summarize: (r) => summarizeResults(r, 'entries'),
  },
  'wi-find-expert': {
    mode: 'get',
    path: '/api/teammates',
    buildQuery: (a) => `?q=${encodeURIComponent(String(a.topic ?? a.skill ?? a.goal ?? ''))}`,
    summarize: (r) => summarizeResults(r, 'teammates'),
  },
  'wi-ticket-links': {
    mode: 'get',
    path: '/api/jira/ticket-links',
    buildQuery: (a) => `?key=${encodeURIComponent(String(a.jira_key ?? a.key ?? ''))}`,
    summarize: (r) => summarizeResults(r, 'links'),
  },
  'wi-sync': {
    mode: 'post',
    path: '/api/sync/all',
    buildBody: () => ({}),
    summarize: () => 'sync triggered',
  },
  'wi-health': {
    mode: 'get',
    path: '/api/system-health',
    buildQuery: () => '',
    summarize: (r) => `health: ${extractField(r, 'status') ?? 'ok'}`,
  },
  'wi-status': {
    mode: 'get',
    path: '/api/cypher/status',
    buildQuery: (a) => (a.ac_id ? `?ac=${encodeURIComponent(String(a.ac_id))}` : ''),
    summarize: (r) => `status: ${extractField(r, 'summary') ?? 'ok'}`,
  },
  'wi-morning-brief': {
    mode: 'get',
    path: '/api/morning-brief',
    buildQuery: () => '',
    summarize: () => 'morning brief generated',
  },
  'wi-bis-regression': {
    mode: 'post',
    path: '/api/bis-regression/plan',
    buildBody: (a) => ({ pr: a.pr, repo: a.repo ?? DEFAULT_DISPATCH_REPO, goal: a.goal }),
    summarize: (r) => `bis regression plan: ${extractField(r, 'legs')?.toString() ?? 'planned'}`,
  },
  // ── CLI-only (would need multi-turn agent context to run properly) ─────
  'wi-code-research': { mode: 'cli-only', reason: 'wi-code-research runs `claude code` headless via investigation-orchestrator.ts; call via slash command from Claude Code, not the bridge.' },
  'wi-update-context': { mode: 'cli-only', reason: 'wi-update-context runs a multi-turn discussion flush; call via /wi-update-context from Claude Code, not the bridge.' },
  'wi-bug-report':    { mode: 'cli-only', reason: 'wi-bug-report captures a live bug from Claude Code context; call via slash command.' },
  'wi-save-to-ticket':{ mode: 'cli-only', reason: 'wi-save-to-ticket needs the current chat as context; call via slash command.' },
  'wi-remind':        { mode: 'cli-only', reason: 'wi-remind writes to Apple Reminders via the local remindctl CLI; not exposed via bridge.' },
  'wi-skill-install': { mode: 'cli-only', reason: 'wi-skill-install manipulates local symlinks; run via bash scripts/install-skills.sh.' },
  'wi-check-links':   { mode: 'cli-only', reason: 'wi-check-links walks the local auto-memory dir; not exposed via bridge.' },
  'wi-frontmatter':   { mode: 'cli-only', reason: 'wi-frontmatter reads local auto-memory files; not exposed via bridge.' },
  'wi-disk-audit':    { mode: 'cli-only', reason: 'wi-disk-audit runs system-level df / find commands.' },
  'wi-pr-smoke': { mode: 'cli-only', reason: 'wi-pr-smoke does kubectl port-forwards.' },
};

// ── Skills with direct tool-catalog handlers (no HTTP loopback) ─────────
// These skills' tool-catalog entries do the work in-process; their handlers
// do NOT call back to runSkillSubagent, so we can invoke them directly
// without recursion.
const DIRECT_CATALOG_SKILLS = new Set(['wi-search', 'wi-search-all']);

// Map skill names (hyphenated) to tool-catalog names (underscored).
function skillNameToToolName(skillName: string): string {
  return skillName.replace(/-/g, '_');
}

// ── PUBLIC API ───────────────────────────────────────────────────────────

/**
 * Dispatch a wi-* skill. Never throws; failures land in the returned
 * SkillDispatchResult.status and are written to subagent_dispatches.error_text.
 *
 * Retry: up to 2 retries (3 total attempts). On retry exhaustion, writes
 * a DLQ row (status='timed_out', error_text='DLQ after 2 retries: <last error>').
 */
export async function runSkillSubagent(
  skillName: string,
  args: SkillDispatchArgs,
  ctx: SkillDispatchContext,
): Promise<SkillDispatchResult> {
  const started = Date.now();
  const id = `sad_${randomBytes(6).toString('hex')}`;
  const argsJson = JSON.stringify(args);

  // 1. audit row before any I/O
  ctx.db.prepare(
    `INSERT OR IGNORE INTO subagent_dispatches(
       id, session_id, task_id, skill_name, args_json, status, dispatched_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, ctx.sessionId, ctx.taskId ?? null, skillName, argsJson, started);

  const route = SKILL_ROUTES[skillName];
  if (!route) {
    return finalizeFailed(
      ctx.db, id, started,
      `no route for skill '${skillName}' — add an entry to SKILL_ROUTES in src/services/cypher/skill-dispatch.ts`,
    );
  }
  if (route.mode === 'cli-only') {
    return finalizeFailed(ctx.db, id, started, route.reason);
  }

  markRunning(ctx.db, id);

  // ── Rollback lever: SKILL_DISPATCH_V2=false reverts to single-attempt
  //    HTTP without tool-catalog direct invoke or retry (pre-G2 behavior).
  const v2Enabled = process.env.SKILL_DISPATCH_V2 !== 'false';

  // 2. Try tool-catalog direct invoke for skills with in-process handlers.
  //    Avoids the HTTP self-loop entirely for high-volume skills.
  if (v2Enabled && DIRECT_CATALOG_SKILLS.has(skillName)) {
    try {
      const result = await dispatchViaToolCatalog(skillName, args, ctx, id, started);
      if (result) return result;
    } catch {
      // Fall through to HTTP path on tool-catalog failure (e.g. circular
      // import, missing tool definition).
    }
  }

  // 3. HTTP dispatch with retry (single attempt when V2 disabled)
  return dispatchWithRetry(route, skillName, args, ctx, id, started, v2Enabled ? 2 : 0);
}

// ── Tool-catalog direct path ─────────────────────────────────────────────

async function dispatchViaToolCatalog(
  skillName: string,
  args: SkillDispatchArgs,
  ctx: SkillDispatchContext,
  id: string,
  started: number,
): Promise<SkillDispatchResult | null> {
  const { TOOL_CATALOG } = await import('./tool-catalog.js');
  const toolName = skillNameToToolName(skillName);
  const tool = TOOL_CATALOG.find((t) => t.name === toolName);
  if (!tool) return null;

  const timeoutMs = getTimeoutForSkill(skillName);

  const result = await Promise.race([
    tool.handler(args, {
      db: ctx.db,
      user: 'cypher',
      session_id: ctx.sessionId,
      palace: null,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`tool catalog timeout after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);

  const summary = typeof result === 'string'
    ? result.slice(0, 240)
    : `dispatched ${skillName} via tool catalog ok`;

  const now = Date.now();
  ctx.db.prepare(
    `UPDATE subagent_dispatches
        SET status = 'succeeded',
            result_json = ?,
            output_summary = ?,
            completed_at = ?
      WHERE id = ?`,
  ).run(JSON.stringify(result).slice(0, 20000), summary, now, id);

  return {
    id,
    status: 'succeeded',
    output_summary: summary,
    result_json: result,
    duration_ms: now - started,
  };
}

// ── HTTP dispatch with retry ─────────────────────────────────────────────

interface HttpAttemptError extends Error {
  isAbort?: boolean;
  statusCode?: number;
}

async function dispatchWithRetry(
  route: SkillRoute & { mode: 'get' | 'post' },
  skillName: string,
  args: SkillDispatchArgs,
  ctx: SkillDispatchContext,
  id: string,
  started: number,
  maxRetries: number = 2,
): Promise<SkillDispatchResult> {
  const timeoutMs = getTimeoutForSkill(skillName);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await executeHttpDispatch(route, args, ctx, id, started, timeoutMs);
    } catch (err) {
      lastError = err as Error;
      const errMsg = lastError.message ?? String(lastError);

      // Do not retry on 4xx client errors — they won't succeed on retry.
      const statusCode = (err as HttpAttemptError).statusCode;
      if (statusCode && statusCode >= 400 && statusCode < 500) {
        return finalizeFailed(ctx.db, id, started, `HTTP ${statusCode}: ${errMsg}`);
      }

      if (attempt < maxRetries) {
        // Update error_text in-place to record the retry attempt.
        ctx.db.prepare(
          `UPDATE subagent_dispatches SET error_text = ? WHERE id = ?`,
        ).run(`retry ${attempt + 1}/${maxRetries}: ${errMsg}`, id);
        // Backoff before retry.
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  // All retries exhausted → DLQ (dead_lettered, NOT timed_out)
  const dlqMsg = `DLQ after ${maxRetries} retries: ${lastError?.message ?? 'unknown error'}`;
  return finalizeFailed(ctx.db, id, started, dlqMsg, 'dead_lettered');
}

async function executeHttpDispatch(
  route: SkillRoute & { mode: 'get' | 'post' },
  args: SkillDispatchArgs,
  ctx: SkillDispatchContext,
  id: string,
  started: number,
  timeoutMs: number,
): Promise<SkillDispatchResult> {
  const base = (ctx.bridgeBaseUrl || DEFAULT_BRIDGE).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    if (route.mode === 'get') {
      const url = `${base}${route.path}${route.buildQuery(args)}`;
      response = await fetch(url, { signal: controller.signal, headers: { 'X-WI-Consumer': 'cypher' } });
    } else {
      const url = `${base}${route.path}`;
      response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-WI-Consumer': 'cypher' },
        body: JSON.stringify(route.buildBody(args) ?? {}),
      });
    }
    clearTimeout(timer);

    if (!response.ok) {
      const body = await safeReadText(response);
      const err = new Error(`HTTP ${response.status} on ${route.path}: ${body.slice(0, 300)}`) as HttpAttemptError;
      err.statusCode = response.status;
      throw err;
    }

    const contentType = response.headers.get('content-type') ?? '';
    let payload: unknown;
    if (contentType.includes('application/json')) {
      payload = await response.json();
    } else {
      payload = { raw: await safeReadText(response) };
    }

    const summary = route.summarize
      ? safeSummarize(() => route.summarize!(payload), payload)
      : `dispatched ${route.mode === 'get' ? 'GET' : 'POST'} → ${route.path} ok`;

    const now = Date.now();
    ctx.db.prepare(
      `UPDATE subagent_dispatches
          SET status = 'succeeded',
              result_json = ?,
              output_summary = ?,
              completed_at = ?
        WHERE id = ?`,
    ).run(JSON.stringify(payload).slice(0, 20000), summary, now, id);

    return {
      id,
      status: 'succeeded',
      output_summary: summary,
      result_json: payload,
      duration_ms: now - started,
    };
  } catch (err) {
    clearTimeout(timer);
    const isAbort = (err as { name?: string } | null)?.name === 'AbortError';
    if (isAbort) {
      const abortErr = new Error(`dispatch timed out after ${timeoutMs}ms`) as HttpAttemptError;
      abortErr.isAbort = true;
      throw abortErr;
    }
    // Re-throw HttpAttemptError with statusCode intact for retry logic.
    if ((err as HttpAttemptError).statusCode) throw err;
    throw new Error(`fetch error: ${(err as Error).message ?? String(err)}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function markRunning(db: Database.Database, id: string): void {
  db.prepare(`UPDATE subagent_dispatches SET status = 'running' WHERE id = ? AND status = 'pending'`).run(id);
}

function finalizeFailed(
  db: Database.Database,
  id: string,
  started: number,
  errorText: string,
  status: 'failed' | 'timed_out' | 'dead_lettered' = 'failed',
): SkillDispatchResult {
  const now = Date.now();
  db.prepare(
    `UPDATE subagent_dispatches
        SET status = ?, error_text = ?, completed_at = ?
      WHERE id = ?`,
  ).run(status, errorText, now, id);
  return {
    id,
    status,
    output_summary: `dispatch ${status}: ${errorText.slice(0, 200)}`,
    error: errorText,
    duration_ms: now - started,
  };
}

async function safeReadText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return ''; }
}

function safeSummarize(fn: () => string, fallback: unknown): string {
  try { return fn().slice(0, 240); }
  catch { return `ok — ${JSON.stringify(fallback).slice(0, 200)}`; }
}

function summarizeResults(payload: unknown, key: string): string {
  if (payload && typeof payload === 'object') {
    const v = (payload as Record<string, unknown>)[key];
    if (Array.isArray(v)) return `${v.length} ${key}`;
    if (typeof v === 'number') return `${v} ${key}`;
  }
  return `ok — ${key}`;
}

function extractField(payload: unknown, key: string): string | undefined {
  if (payload && typeof payload === 'object') {
    const v = (payload as Record<string, unknown>)[key];
    if (v == null) return undefined;
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (Array.isArray(v)) return `[${v.length}]`;
  }
  return undefined;
}

/** Exposed for tests only. */
export const _internal = { SKILL_ROUTES, DEFAULT_BRIDGE };

/**
 * DISPATCHABLE_SKILLS — the subset of skill names in SKILL_ROUTES that the
 * bridge can dispatch DIRECTLY (mode: 'get' | 'post'). Excludes 'cli-only'
 * routes.
 *
 * Exported for:
 *   1. Stage-1 recall filter (tool-catalog.ts, feature-gated on
 *      STAGE1_DISPATCHABLE_ONLY=1) — narrows the hint corpus from all 150+
 *      skill_catalog rows to only skills the bridge can actually invoke.
 *   2. Phase-0 recall sweep harness (`stage1-recall-sweep.mjs`) — the
 *      controlled variant that isolates the "corpus pollution" hypothesis
 *      from other Stage-1 recall issues.
 *
 * Landed as part of Phase 0 M1 (see ADR-050 + BUILD-PLAN-01-PHASE0.md).
 * Rebuild required after editing SKILL_ROUTES for this set to update.
 */
export const DISPATCHABLE_SKILLS: ReadonlySet<string> = new Set(
  Object.entries(SKILL_ROUTES)
    .filter(([, r]) => r.mode === 'get' || r.mode === 'post')
    .map(([name]) => name),
);
