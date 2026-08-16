/**
 * Cypher skill-class catalog + executor — ADR-036 PHASE-86-01 (2026-06-16).
 *
 * **3-way taxonomy (replaces v1's 4-way read|write|cli|unknown).**
 *
 * The category names what happens when Cypher decides this skill is the
 * right answer to the user's goal. The boundary is **does the action
 * stay inside Work Intelligence, or does it leak beyond WI** (to Jira,
 * GitHub, Teams, the user's git worktree, customer code, etc.):
 *
 *   - `auto`    — side-effect-free OR side-effect-only-against-WI-itself.
 *                 Cypher invokes it without confirmation. Examples:
 *                 read-class probes (wi-search, wi-investigate),
 *                 WI-internal writes (wi-update-context, wi-bug-resolve,
 *                 wi-sync — all touch WI's own data.db).
 *   - `confirm` — leaks beyond WI. Cypher renders the intent + asks the
 *                 user to confirm before running. Examples: wi-save-to-
 *                 ticket (Jira write); future PR-creation skills.
 *   - `cli`     — Claude Code skill (deep-research, frontend-design,
 *                 mem-search, etc.). Cypher cannot invoke it via the
 *                 bridge; surfaces it as a recommendation the user types
 *                 themselves. Same depth ≤ 2 invariant from ADR-033 for
 *                 this class — relaxed only for `auto` per ADR-036.
 *
 * **The `unknown` category is removed.** v1's `unknown` was both "we
 * don't know if this writes" AND "no programmatic invocation today" —
 * two distinct concerns. ADR-036 splits them: `confirm` is the safe
 * default for any wi-* skill we haven't audited; `cli` is the explicit
 * surface for non-wi-* skills. There is no longer a "skill we can't
 * categorize" state.
 *
 * **Catalog audit (ADR-036 PHASE-86-01 AC L1.1-A-03/A-04):**
 *
 * | Skill                  | v1 cat   | v2 cat    | Reason                              |
 * |------------------------|----------|-----------|-------------------------------------|
 * | wi-search              | read     | auto      | side-effect-free                    |
 * | wi-investigate         | read     | auto      | side-effect-free                    |
 * | wi-pr-review           | read     | auto      | side-effect-free                    |
 * | wi-blast-radius        | read     | auto      | side-effect-free                    |
 * | wi-update-context      | write    | auto      | writes WI DB only                   |
 * | wi-bug-resolve         | write    | auto      | writes WI DB only                   |
 * | wi-bug-resolve-all     | write    | auto      | writes WI DB only                   |
 * | wi-sync                | write    | auto      | writes WI DB only                   |
 * | wi-save-to-ticket      | write    | confirm   | leaks to Jira                       |
 * | wi-jira-analyze        | unknown  | auto      | audited: writes WI DB only          |
 * | wi-pre-meeting         | unknown  | auto      | read-class                          |
 * | wi-morning-brief       | unknown  | auto      | read-class                          |
 * | wi-action-items        | unknown  | auto      | read-class                          |
 * | wi-search-all          | unknown  | auto      | read-class                          |
 * | wi-teams-search        | unknown  | auto      | read-class                          |
 * | wi-daily-digest        | unknown  | auto      | read-class                          |
 * | wi-check-links         | unknown  | auto      | read-class                          |
 * | wi-bug-report          | unknown  | auto      | writes WI DB only                   |
 * | wi-skill-install       | unknown  | auto      | writes ~/.claude/skills/ symlinks   |
 *
 * (`wi-skill-install` does write outside the WI repo — but only into
 * the user's own ~/.claude/ directory, never to a tracker or PR. Per
 * Maaz's rule: WI-internal-only writes stay `auto`. The skill is
 * idempotent and refuses to clobber drift, so re-runs are safe.)
 *
 * Phase 82c's "unknown" fallback for un-cataloged wi-* skills was a
 * v1 artifact — under ADR-036's stricter taxonomy, an un-cataloged
 * wi-* skill defaults to `confirm` (conservative; surfaces the
 * suggestion + waits for the user) instead. Cataloged skills override.
 *
 * **Hard rule (carries the never-auto-execute-leaks-out invariant):**
 * Only skills explicitly marked `category='auto'` execute without
 * confirmation. `confirm` skills surface their intent + the user
 * confirms before invocation. `cli` skills are surfaced as text the
 * user types themselves. Mirrors `BUG_AUTO_MERGE=0` posture from
 * ADR-030 Phase D.
 *
 * The catalog is hand-maintained (data, not heuristic). New skills
 * land here by hand — same posture as candidates.ts. Future CAP-13
 * self-extension's promote step appends entries here when a new
 * skill is approved for activation.
 */

export type SkillCategory = 'auto' | 'confirm' | 'cli';

import { defaultRepoName } from '../../intelligence/repo-names.js';

export interface SkillSpec {
  /** auto = invoke without confirmation. confirm = surface + ask. cli = user types. */
  category: SkillCategory;
  /** Bridge endpoint path. When null/absent, the skill has no programmatic invocation today (Claude-Code-only); runtime leaves it 'skipped'. */
  endpoint?: string;
  /** HTTP method. Default GET for read, POST for write. */
  method?: 'GET' | 'POST';
  /**
   * Builds the request body/query from the engagement's goal + context.
   * Pure: takes goal+context, returns either a JSON body (for POST) or
   * URL search params (for GET). Returns null when the build fails —
   * runtime treats null as "cannot programmatically invoke; skip".
   */
  buildRequest?: (goal: string, context: unknown) => { body?: unknown; query?: Record<string, string> } | null;
}

/**
 * Catalog of skills with programmatic invocation.
 *
 * Today only a handful have buildRequest wired — the ones with stable,
 * well-documented bridge endpoints with clear input shapes. Other auto
 * skills (e.g. wi-pre-meeting, wi-morning-brief) are catalogued without
 * an endpoint; the runtime leaves them 'skipped' with a /skill-name
 * recommendation until their endpoints are mapped.
 */
export const SKILL_CATALOG: Record<string, SkillSpec> = {
  // ─── auto class — invoke without confirmation ─────────────────────────────
  // Read-class probes (no side effects):
  'wi-search': {
    category: 'auto',
    endpoint: '/api/search-all',
    method: 'POST',
    buildRequest: (goal: string) => ({ body: { query: goal, limit: 10 } }),
  },
  'wi-investigate': {
    // Investigation triggers an async investigation engine; no
    // side-effects on customer code. The bridge call signature requires
    // a Jira key — buildRequest extracts the first JIRA-shaped
    // token from the goal; if none, returns null.
    category: 'auto',
    endpoint: '/api/jira/investigate',
    method: 'POST',
    buildRequest: (goal: string) => {
      const m = goal.match(/\b([A-Z][A-Z0-9_]+-\d+)\b/);
      if (!m) return null;
      return { body: { key: m[1] } };
    },
  },
  'wi-pr-review': {
    category: 'auto',
    endpoint: '/api/pr/review',
    method: 'GET',
    buildRequest: (goal: string) => {
      // PR number — try several shapes, take the first match.
      // Note: `\b` matches at word-char boundaries; `#` is not a word char,
      // so we use `(^|\s)` as the leading anchor on the prefixed shapes.
      const prMatch =
        goal.match(/(?:^|\s)(?:PR[-\s]+|pull\/|#)(\d{2,6})\b/i)
        ?? goal.match(/\bPR(\d{2,6})\b/i);
      if (!prMatch) return null;
      const pr = prMatch[1];
      const repoMatch = goal.match(/\brepo:([a-z0-9_-]+)\b/i);
      const repo = repoMatch ? repoMatch[1] : defaultRepoName();
      return { query: { repo, pr } };
    },
  },
  'wi-blast-radius': {
    category: 'auto',
    endpoint: '/api/code-graph/blast-radius',
    method: 'GET',
    buildRequest: (goal: string) => {
      // Look for a path-shaped substring with at least one separator AND
      // a recognized source extension.
      const m = goal.match(/\b([\w./-]+\/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sh|py|sql))\b/);
      if (!m) return null;
      const file = m[1];
      const repoMatch = goal.match(/\brepo:([a-z0-9_-]+)\b/i);
      const repo = repoMatch ? repoMatch[1] : defaultRepoName();
      return { query: { repo, file } };
    },
  },

  // WI-internal writes (per Maaz's rule — DB-only writes stay auto):
  'wi-update-context':   { category: 'auto' },
  'wi-bug-resolve':      { category: 'auto' },
  'wi-bug-resolve-all':  { category: 'auto' },
  'wi-sync':             { category: 'auto' },

  // Auto-class skills without buildRequest (cataloged but no bridge
  // endpoint mapped today — runtime suggests /skill-name and stops):
  // wi-jira-analyze stays auto: /api/jira/analyze writes only to WI's
  // own data.db (saveJiraAnalysis); audited per AC L1.1-A-06.
  // Wiring the buildRequest needs a 2-step probe (fetch /api/jira/get?key=X
  // first, then POST /analyze) — out of scope for the single-fetch
  // invokeSkill model; future "compound buildRequest" mechanism unblocks.
  'wi-jira-analyze':     { category: 'auto' },
  'wi-pre-meeting':      { category: 'auto' },
  'wi-morning-brief':    { category: 'auto' },
  'wi-action-items':     { category: 'auto' },
  'wi-bug-report':       { category: 'auto' },
  'wi-search-all':       { category: 'auto' },
  'wi-teams-search':     { category: 'auto' },
  'wi-daily-digest':     { category: 'auto' },
  'wi-check-links':      { category: 'auto' },
  'wi-skill-install':    { category: 'auto' },

  // ─── confirm class — leaks beyond WI; ask first ───────────────────────────
  'wi-save-to-ticket':   { category: 'confirm' },
};

/**
 * Look up a skill's category.
 *
 * Defaults (when not in SKILL_CATALOG):
 *   - non-wi-* skills → 'cli' (Claude Code skills like deep-research,
 *     frontend-design, mem-search). Cypher cannot invoke these via the
 *     bridge; surfaces them as a `/skill-name` recommendation.
 *   - wi-* skills not in the catalog → 'confirm' (conservative — the
 *     cataloger missed it; surface + wait for the user). Replaces v1's
 *     'unknown' fallback. Per ADR-036 PHASE-86-01 AC L1.1-A-02.
 *
 * Same depth ≤ 2 invariant from ADR-033 § Surfaces & dispatch holds for
 * `cli` and `confirm`; relaxed only for `auto` per ADR-036.
 */
export function categoryOf(skillName: string): SkillCategory {
  const explicit = SKILL_CATALOG[skillName]?.category;
  if (explicit) return explicit;
  if (skillName.startsWith('wi-')) return 'confirm';
  return 'cli';
}

/**
 * Result of an attempted programmatic invocation.
 */
export interface InvocationResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
  duration_ms: number;
}

/**
 * Invoke an auto-class skill against the local bridge. Best-effort —
 * any failure is captured in the result, never thrown out of Cypher's
 * runtime. Caller decides outcome=mixed/failed based on `ok`.
 *
 * Refuses to invoke confirm-class or cli-class skills; returns
 * `ok: false, error: 'category_blocked'`. The execute stage handles
 * those cases via different code paths (requires_confirmation for
 * confirm; user-types-it for cli).
 *
 * Bridge port defaults to 3132 (matches WI's web-server.js); override
 * via env CYPHER_BRIDGE_PORT for test isolation.
 */
export async function invokeSkill(
  skillName: string,
  goal: string,
  context: unknown,
): Promise<InvocationResult> {
  const start = Date.now();
  const spec = SKILL_CATALOG[skillName];
  if (!spec || spec.category !== 'auto' || !spec.endpoint || !spec.buildRequest) {
    return {
      ok: false, status: 0, error: 'category_blocked_or_no_endpoint',
      duration_ms: Date.now() - start,
    };
  }

  const req = spec.buildRequest(goal, context);
  if (!req) {
    return {
      ok: false, status: 0, error: 'buildRequest_returned_null',
      duration_ms: Date.now() - start,
    };
  }

  const port = process.env.CYPHER_BRIDGE_PORT ?? '3132';
  let url = `http://localhost:${port}${spec.endpoint}`;
  const method = spec.method ?? 'POST';
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (req.query) {
    const qs = new URLSearchParams(req.query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  if (req.body !== undefined && method !== 'GET') {
    init.body = JSON.stringify(req.body);
  }

  try {
    const resp = await fetch(url, init);
    let body: unknown = null;
    try {
      body = await resp.json();
    } catch {
      body = await resp.text();
    }
    return {
      ok: resp.ok,
      status: resp.status,
      body,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false, status: 0,
      error: `fetch_failed: ${(err as Error).message}`,
      duration_ms: Date.now() - start,
    };
  }
}
