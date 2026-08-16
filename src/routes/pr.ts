/**
 * REFACTOR-001 — PR route family (Sprint A.1 followup, 2026-05-21).
 *
 * Verbatim port of the 10 `/api/pr/*` route blocks from `web-server.js`
 * (~600 LOC). Behaviour preserved 1:1 — same MCP-then-gh fallback, same
 * Bitbucket PR review pipeline, same dry-run safety gate, same blast-radius
 * + work-context assembly.
 *
 * Routes extracted:
 *   GET    /api/pr/list              — list PRs (MCP primary, gh CLI fallback)
 *   GET    /api/pr/review            — full AI PR review with workContext + caching
 *   GET    /api/pr/enrich            — AI-generated PR description
 *   POST   /api/pr/create            — dry-run-safe PR opener (OP-2)
 *   POST   /api/pr/post-review       — dry-run-safe AI review poster (OP-2)
 *   GET    /api/pr/commits           — commit list + per-file blast radius
 *   GET    /api/pr/watch             — list watched PRs for a repo (EP-54)
 *   POST   /api/pr/watch             — add to watched (EP-54)
 *   DELETE /api/pr/watch             — remove from watched (EP-54)
 *   GET    /api/pr/watched-summary   — all watched PRs across repos with live state
 *
 * Dependencies pulled in directly (vs. the legacy bridge using closure scope):
 *   - ConfigManager / GitHubMcpClient.splitGithubSlug — direct imports
 *   - getBlastRadius — direct db query
 *   - ResearchEngine + DEFAULT_OWNERSHIP_MAP — direct imports for the
 *     EP-67 PR research path (>5 files changed)
 *   - enrichKnowledgeFromResearch — now a shared TS module
 *   - AIAnalyzer instance — passed via RouteContext (ctx.analyzer)
 *   - anthropicApiKey, palaceClient — via RouteContext
 */

import { execFileSync } from 'node:child_process';
import { z } from 'zod';

import type { AIAnalyzer } from '../services/analyzer.js';
import { ConfigManager } from '../services/config.js';
import { GitHubMcpClient, splitGithubSlug } from '../fetcher/sources/github-mcp-client.js';
import { getBlastRadius } from '../db/queries/code-graph.js';
import { ResearchEngine } from '../intelligence/research-engine.js';
import { DEFAULT_OWNERSHIP_MAP } from '../intelligence/ownership-map.js';
import { enrichKnowledgeFromResearch } from '../intelligence/knowledge-enrichment.js';
import { getActivePersonaRules } from '../services/persona/recall.js';

import { json, readBody, parseBody } from './_util.js';
import type { RouteHandler } from './_types.js';
import { defaultRepoName } from '../intelligence/repo-names.js';

// ── env lookups (mirrors the constants in web-server.js) ────────────────────
function primaryRepoPath(): string {
  return process.env.REPO_PATH ?? process.env.CODEBASE_PATH ?? './repos/' + defaultRepoName();
}
function operationsPath(): string {
  return process.env.OPERATIONS_PATH ?? './repos/operations';
}

// ── GET /api/pr/list ───────────────────────────────────────────────────────
const listRoute: RouteHandler = {
  method: 'GET',
  path: '/api/pr/list',
  async handle(_req, res, ctx, url) {
    const db = ctx.db;
    const repo = url.searchParams.get('repo') ?? defaultRepoName();
    const stateRaw = url.searchParams.get('state') ?? 'open';
    // Original JS passed arbitrary strings — TS sig is the enum. Coerce
    // unknown values to 'open' to preserve runtime behaviour.
    const state: 'open' | 'closed' | 'all' =
      stateRaw === 'closed' || stateRaw === 'all' ? stateRaw : 'open';
    const config = new ConfigManager();
    const repos = config.getRepos();
    const repoConfig = repos.find((r: { name: string }) => r.name === repo);
    if (!repoConfig) { json(res, 400, { error: `Unknown repo: ${repo}` }); return; }
    try {
      const { owner, repo: repoName } = splitGithubSlug(repoConfig.githubSlug);
      const ghMcp = new GitHubMcpClient(db);
      const prs = await ghMcp.listPRs(owner, repoName, state);
      json(res, 200, { prs, source: 'mcp' });
    } catch (mcpErr) {
      process.stderr.write(`[pr/list] MCP failed, falling back to gh CLI: ${(mcpErr as Error).message}\n`);
      try {
        const raw = execFileSync('gh', ['pr', 'list', '--repo', repoConfig.githubSlug, '--state', state, '--json',
          'number,title,body,headRefName,baseRefName,url,author,createdAt,updatedAt,additions,deletions,files'], { encoding: 'utf8' });
        json(res, 200, { prs: JSON.parse(raw), source: 'gh' });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    }
  },
};

// ── GET /api/pr/review ─────────────────────────────────────────────────────
// Largest route in the file (~150 LOC). Verbatim port of the orchestration in
// web-server.js — cache check → MCP/gh fetch → blast radius → 6-source
// work-context assembly → optional EP-67 research → AIAnalyzer.reviewPR →
// pr_review_cache upsert.
const reviewRoute: RouteHandler = {
  method: 'GET',
  path: '/api/pr/review',
  async handle(_req, res, ctx, url) {
    const db = ctx.db;
    const analyzer = ctx.analyzer as AIAnalyzer | null | undefined;
    if (!analyzer) { json(res, 503, { error: 'analyzer_unavailable', message: 'ANTHROPIC_API_KEY not set' }); return; }
    const repo = url.searchParams.get('repo') ?? defaultRepoName();
    const prNumStr = url.searchParams.get('pr');
    if (!prNumStr) { json(res, 400, { error: 'pr param required' }); return; }
    const prNum = parseInt(prNumStr, 10);
    const config = new ConfigManager();
    const repos = config.getRepos();
    const repoConfig = repos.find((r: { name: string }) => r.name === repo);
    if (!repoConfig) { json(res, 400, { error: `Unknown repo: ${repo}` }); return; }
    try {
      let prTitle = '';
      let prBody = '';
      let headRefName = '';
      let changedFiles: string[] = [];
      let diff = '';
      let headSha = '';

      // MCP path (primary)
      try {
        const { owner, repo: repoName } = splitGithubSlug(repoConfig.githubSlug);
        const ghMcp = new GitHubMcpClient(db);
        const { meta, diff: mcpDiff, files } = await ghMcp.getPRDetail(owner, repoName, prNum);
        prTitle = meta.title;
        prBody = meta.body ?? ''; // GithubPRMcp.body is `string | null`; JS allowed null through
        headRefName = meta.head?.ref ?? '';
        // GithubPRMcp.head is typed as `{ ref: string }` but the MCP server
        // also returns `sha`. The original JS read it via dynamic access so
        // the cache key was populated; preserve that behaviour with a cast
        // until the type is widened upstream.
        headSha = (meta.head as { ref: string; sha?: string })?.sha ?? '';
        changedFiles = files.map((f: { filename: string }) => f.filename);
        diff = mcpDiff.slice(0, 4000);
      } catch (mcpErr) {
        process.stderr.write(`[pr/review] MCP failed, falling back to gh CLI: ${(mcpErr as Error).message}\n`);
        const prMeta = JSON.parse(execFileSync('gh', ['pr', 'view', String(prNum), '--repo', repoConfig.githubSlug,
          '--json', 'number,title,body,headRefName,headRefOid,files,additions,deletions'], { encoding: 'utf8' }));
        prTitle = prMeta.title;
        prBody = prMeta.body;
        headRefName = prMeta.headRefName ?? '';
        headSha = prMeta.headRefOid ?? '';
        changedFiles = (prMeta.files ?? []).map((f: { path: string }) => f.path);
        diff = execFileSync('gh', ['pr', 'diff', String(prNum), '--repo', repoConfig.githubSlug], { encoding: 'utf8' }).slice(0, 4000);
      }

      // Cache check — skip Claude if we already reviewed this exact SHA
      const forceRefresh = url.searchParams.get('refresh') === '1';
      if (!forceRefresh && headSha) {
        const cached = db.prepare(
          'SELECT review_json, work_context_json, created_at FROM pr_review_cache WHERE repo=? AND pr_num=? AND head_sha=?'
        ).get(repo, prNum, headSha) as
          | { review_json: string; work_context_json: string | null; created_at: string }
          | undefined;
        if (cached) {
          json(res, 200, {
            prNum,
            repo,
            review: JSON.parse(cached.review_json),
            blastRadius: [],
            workContext: cached.work_context_json ? JSON.parse(cached.work_context_json) : null,
            cached: true,
            cachedAt: cached.created_at,
          });
          return;
        }
      }

      // Blast radius for changed files
      const blastNodes = changedFiles.flatMap((f) => getBlastRadius(db, repo, f, 2));

      // Work context from DB — rich signals from existing data
      const jiraKey = headRefName.match(/([A-Z]+-\d+)/)?.[1];

      // 1. Jira ticket
      interface JiraRow { key: string; summary: string; status: string; }
      const jiraTickets: JiraRow[] = [];
      if (jiraKey) {
        const row = db.prepare(
          'SELECT key, title as summary, status FROM jira_issues WHERE key = ?'
        ).get(jiraKey) as JiraRow | undefined;
        if (row) jiraTickets.push(row);
      }

      // 2. Teams messages — FTS5 with multiple keywords for higher recall
      const ftsKeywords = [jiraKey, ...prTitle.split(' ').filter((w) => w.length > 3).slice(0, 3)].filter(Boolean) as string[];
      let teamsMessages: string[] = [];
      try {
        const ftsQuery = ftsKeywords.map(() => 'content MATCH ?').join(' OR ');
        const ftsRows = db.prepare(
          `SELECT content, author, timestamp FROM messages_fts WHERE ${ftsQuery} ORDER BY rank LIMIT 10`
        ).all(...ftsKeywords) as Array<{ content: string; author: string; timestamp: string }>;
        teamsMessages = ftsRows.map((r) => `[${r.author}] ${r.content.slice(0, 200)}`);
      } catch {
        // FTS fallback to LIKE on primary keyword
        const kw = jiraKey ?? prTitle.split(' ')[0];
        const likeRows = db.prepare(
          "SELECT content, author FROM messages WHERE content LIKE ? ORDER BY timestamp DESC LIMIT 10"
        ).all(`%${kw}%`) as Array<{ content: string; author: string }>;
        teamsMessages = likeRows.map((r) => `[${r.author}] ${r.content.slice(0, 200)}`);
      }

      // 3. Related meetings — search by Jira key + PR title keywords
      const meetingKw = `%${jiraKey ?? prTitle.split(' ').filter((w) => w.length > 3)[0] ?? ''}%`;
      const meetingRows = db.prepare(`
        SELECT title, COALESCE(summary,'') as summary, COALESCE(decisions,'') as decisions, date
        FROM meetings WHERE (title LIKE ? OR summary LIKE ?) ORDER BY date DESC LIMIT 3
      `).all(meetingKw, meetingKw) as Array<{ title: string; summary: string; decisions: string; date: string }>;
      const relatedMeetings = meetingRows.map((m) => ({ title: m.title, summary: m.summary, decisions: m.decisions, date: m.date }));

      // 4. Open action items linked to Jira key or PR author
      const actionRows = db.prepare(`
        SELECT title as content, COALESCE(assignee,'') as assignee FROM action_items
        WHERE status != 'done' AND (title LIKE ? OR assignee LIKE ?)
        ORDER BY id DESC LIMIT 5
      `).all(`%${jiraKey ?? ''}%`, `%${prTitle.split(' ')[0]}%`) as Array<{ content: string; assignee: string }>;
      const openActionItems = actionRows.map((r) => ({ content: r.content, assignee: r.assignee }));

      // 5. Ticket learnings for the Jira key
      interface TicketLearning { solution: string; traps: string; cycleHours: number | null; }
      const ticketLearnings: TicketLearning[] = [];
      if (jiraKey) {
        const learning = db.prepare(
          'SELECT solution, traps, cycle_time_hours FROM ticket_learnings WHERE issue_key = ?'
        ).get(jiraKey) as { solution: string | null; traps: string | null; cycle_time_hours: number | null } | undefined;
        if (learning) ticketLearnings.push({
          solution: learning.solution ?? '',
          traps: learning.traps ?? '',
          cycleHours: learning.cycle_time_hours,
        });
      }

      // 6. Potential reviewers from team_members — match by recent activity on related keywords
      const reviewerKw = jiraKey ?? prTitle.split(' ').filter((w) => w.length > 3)[0] ?? '';
      interface PotentialReviewer { name: string; relevanceReason: string; }
      const potentialReviewers: PotentialReviewer[] = [];
      if (reviewerKw) {
        const reviewerRows = db.prepare(`
          SELECT DISTINCT tm.name, COUNT(m.id) as msg_count
          FROM team_members tm
          JOIN member_aliases ma ON ma.member_id = tm.id
          JOIN messages m ON m.author = ma.alias
          WHERE m.content LIKE ? AND tm.deleted_at IS NULL
          GROUP BY tm.id ORDER BY msg_count DESC LIMIT 4
        `).all(`%${reviewerKw}%`) as Array<{ name: string; msg_count: number }>;
        for (const r of reviewerRows) {
          potentialReviewers.push({ name: r.name, relevanceReason: `${r.msg_count} messages related to ${reviewerKw}` });
        }
      }

      // ADR-020 Phase 5: Deep research for complex PRs (>5 changed files)
      let prResearchContext = '';
      if (changedFiles.length > 5) {
        try {
          const searchPathsPR: Record<string, string> = {};
          const repoPath = primaryRepoPath();
          const opsPath = operationsPath();
          searchPathsPR[defaultRepoName()] = repoPath;
          if (process.env.OPERATIONS_PATH) searchPathsPR['operations'] = opsPath;
          const prEngine = new ResearchEngine(db, { db, repoPaths: searchPathsPR, searchPaths: searchPathsPR, ownershipMap: DEFAULT_OWNERSHIP_MAP });
          const prResearch = await prEngine.investigate({
            question: `What is the architectural impact of changes in: ${changedFiles.slice(0, 10).join(', ')}`,
            tier: 2,
            additionalContext: `PR: ${prTitle}\n${prBody?.slice(0, 500) ?? ''}`,
          });
          if (prResearch.confidence >= 0.4) {
            prResearchContext = prResearch.answer;
            await enrichKnowledgeFromResearch(db, ctx.palaceClient as Parameters<typeof enrichKnowledgeFromResearch>[1], `PR review: ${prTitle}`, prResearch);
          }
          process.stderr.write(`[pr-research] ${repo}#${prNum} files=${changedFiles.length} conf=${prResearch.confidence.toFixed(2)} ms=${prResearch.durationMs}\n`);
        } catch (prResErr) {
          process.stderr.write(`[pr-research] non-critical: ${(prResErr as Error)?.message?.slice(0, 80)}\n`);
        }
      }

      // Note: the legacy JS passed `researchContext: prResearchContext` here,
      // but `AIAnalyzer.reviewPR` doesn't read it (no match for the symbol
      // anywhere in analyzer.ts). The field was always silently dropped.
      // Dropped during port; no observable change. If we want research
      // context to actually influence the review, that's a separate change
      // to `PRReviewInput` + `reviewPR()`.
      void prResearchContext;

      // Phase 80 wave 77a-01: pull active persona rules via the
      // `getActivePersonaRules` helper in src/services/persona/recall.ts
      // (Hard rule 7: routes never touch rule_cards / lessons_learned /
      // persona_rule_snapshots directly — they go through the persona
      // service helpers). Best-effort; empty array on any failure so
      // review still ships if persona substrate is unavailable. Citation
      // tracking (applied_count++ on rule_cards when the model cites a
      // rule_id) is deferred to wave 77c per PRD.
      let personaRules: Array<{ rule_id: string; body: string }> = [];
      try {
        const changedFiles = blastNodes.map(n => n.file_path);
        const rows = getActivePersonaRules(db, { tier: 0, limit: 10, changedFiles });
        personaRules = rows.map(r => ({ rule_id: r.rule_id, body: r.body }));
      } catch (err) {
        process.stderr.write(`[pr/review] persona rule fetch failed (non-fatal): ${(err as Error).message}\n`);
      }

      const review = await analyzer.reviewPR({
        prTitle,
        prBody,
        diff,
        blastRadius: blastNodes,
        workContext: { jiraTickets, teamsMessages, relatedMeetings, openActionItems, ticketLearnings, potentialReviewers },
        personaRules,
      });
      const workContextSummary = { jiraKey, relatedMeetings, openActionItems, ticketLearnings, teamsCount: teamsMessages.length };
      if (headSha) {
        db.prepare(
          'INSERT OR REPLACE INTO pr_review_cache (repo, pr_num, head_sha, review_json, work_context_json) VALUES (?, ?, ?, ?, ?)'
        ).run(repo, prNum, headSha, JSON.stringify(review), JSON.stringify(workContextSummary));
      }
      json(res, 200, { prNum, repo, review, blastRadius: blastNodes, workContext: workContextSummary, cached: false });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  },
};

// ── GET /api/pr/enrich ─────────────────────────────────────────────────────
const enrichRoute: RouteHandler = {
  method: 'GET',
  path: '/api/pr/enrich',
  async handle(_req, res, ctx, url) {
    const db = ctx.db;
    const analyzer = ctx.analyzer as AIAnalyzer | null | undefined;
    if (!analyzer) { json(res, 503, { error: 'analyzer_unavailable', message: 'ANTHROPIC_API_KEY not set' }); return; }
    const repo = url.searchParams.get('repo') ?? defaultRepoName();
    const prNumStr = url.searchParams.get('pr');
    if (!prNumStr) { json(res, 400, { error: 'pr param required' }); return; }
    const config = new ConfigManager();
    const repos = config.getRepos();
    const repoConfig = repos.find((r: { name: string }) => r.name === repo);
    if (!repoConfig) { json(res, 400, { error: `Unknown repo: ${repo}` }); return; }
    try {
      const prMeta = JSON.parse(execFileSync('gh', ['pr', 'view', prNumStr, '--repo', repoConfig.githubSlug,
        '--json', 'number,title,body,headRefName,files'], { encoding: 'utf8' }));
      const changedFiles: string[] = (prMeta.files ?? []).map((f: { path: string }) => f.path);
      const blastNodes = changedFiles.flatMap((f) => getBlastRadius(db, repo, f, 1));
      const jiraKey = (prMeta.headRefName ?? '').match(/([A-Z]+-\d+)/)?.[1];
      const jiraRow = jiraKey
        ? (db.prepare('SELECT title, status FROM jira_issues WHERE key = ?').get(jiraKey) as
            | { title: string; status: string }
            | undefined)
        : null;

      const description = await analyzer.generatePRDescription({
        branch: prMeta.headRefName ?? '',
        filesChanged: changedFiles,
        jiraContext: jiraRow ? `${jiraKey}: ${jiraRow.title} [${jiraRow.status}]` : undefined,
        blastRadius: blastNodes,
      });
      json(res, 200, { prNum: parseInt(prNumStr, 10), description });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  },
};

// ── POST /api/pr/create (dry-run safe — OP-2) ──────────────────────────────
const createRoute: RouteHandler = {
  method: 'POST',
  path: '/api/pr/create',
  async handle(req, res) {
    const rawBody = await readBody(req);
    const body = parseBody(z.object({
      repo: z.string(),
      branch: z.string(),
      title: z.string(),
      body: z.string().optional(),
      base: z.string().optional(),
      dry_run: z.boolean().optional(),
    }), rawBody);
    if (!body.ok) { json(res, 400, { error: body.error }); return; }
    const { repo, branch, title, body: prBody, base, dry_run } = body.data;
    const isPreview = dry_run !== false;
    const config = new ConfigManager();
    const repos = config.getRepos();
    const repoConfig = repos.find((r: { name: string }) => r.name === repo);
    if (!repoConfig) { json(res, 400, { error: `Unknown repo: ${repo}` }); return; }
    const effectiveBase = base ?? repoConfig.defaultBranch;
    if (isPreview) {
      json(res, 200, {
        dry_run: true,
        preview: {
          repo,
          githubSlug: repoConfig.githubSlug,
          head: branch,
          base: effectiveBase,
          title,
          body: prBody ?? null,
          note: 'No PR opened. Pass dry_run:false to execute.',
        },
      });
      return;
    }
    try {
      const args = ['pr', 'create', '--repo', repoConfig.githubSlug, '--head', branch,
        '--base', effectiveBase, '--title', title];
      if (prBody) args.push('--body', prBody);
      const out = execFileSync('gh', args, { encoding: 'utf8' });
      const ghUrl = out.trim().split('\n').pop() ?? '';
      json(res, 201, { url: ghUrl, repo, branch, dry_run: false });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  },
};

// ── POST /api/pr/post-review (dry-run safe — OP-2) ─────────────────────────
const postReviewRoute: RouteHandler = {
  method: 'POST',
  path: '/api/pr/post-review',
  async handle(req, res, ctx) {
    const rawBody = await readBody(req);
    const parsed = parseBody(z.object({
      repo: z.string(),
      pr: z.number(),
      body: z.string(),
      event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).optional(),
      dry_run: z.boolean().optional(),
    }), rawBody);
    if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
    const { repo, pr: prNum, body: reviewBody, event, dry_run } = parsed.data;
    const isPreview = dry_run !== false;
    const config = new ConfigManager();
    const repos = config.getRepos();
    const repoConfig = repos.find((r: { name: string }) => r.name === repo);
    if (!repoConfig) { json(res, 400, { error: `Unknown repo: ${repo}` }); return; }
    if (isPreview) {
      json(res, 200, {
        dry_run: true,
        preview: {
          repo,
          githubSlug: repoConfig.githubSlug,
          pr: prNum,
          event: event ?? 'COMMENT',
          bodyPreview: reviewBody.slice(0, 500) + (reviewBody.length > 500 ? '…' : ''),
          bodyLength: reviewBody.length,
          note: 'No review posted. Pass dry_run:false to execute.',
        },
      });
      return;
    }
    try {
      const { owner, repo: repoName } = splitGithubSlug(repoConfig.githubSlug);
      const ghMcp = new GitHubMcpClient(ctx.db);
      const result = await ghMcp.postReview(owner, repoName, prNum, reviewBody);
      json(res, 200, { url: result.url, prNum, repo, dry_run: false });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  },
};

// ── GET /api/pr/commits ────────────────────────────────────────────────────
const commitsRoute: RouteHandler = {
  method: 'GET',
  path: '/api/pr/commits',
  handle(_req, res, ctx, url) {
    const db = ctx.db;
    const repo = url.searchParams.get('repo') ?? defaultRepoName();
    const prNumStr = url.searchParams.get('pr');
    if (!prNumStr) { json(res, 400, { error: 'pr param required' }); return; }
    const config = new ConfigManager();
    const repos = config.getRepos();
    const repoConfig = repos.find((r: { name: string }) => r.name === repo);
    if (!repoConfig) { json(res, 400, { error: `Unknown repo: ${repo}` }); return; }
    try {
      const prMeta = JSON.parse(execFileSync('gh', ['pr', 'view', prNumStr, '--repo', repoConfig.githubSlug,
        '--json', 'number,title,headRefName,files,commits'], { encoding: 'utf8' }));
      interface FileMeta { path: string; additions: number; deletions: number; changeType: string; }
      const changedFiles = (prMeta.files ?? []).map((f: FileMeta) => ({
        path: f.path,
        additions: f.additions,
        deletions: f.deletions,
        changeType: f.changeType,
        blastRadius: getBlastRadius(db, repo, f.path, 2),
      }));
      const crossRepoImpact = changedFiles.some((f: { blastRadius: Array<{ repo: string }> }) =>
        f.blastRadius.some((n) => n.repo !== repo)
      );
      json(res, 200, {
        prNum: parseInt(prNumStr, 10),
        repo,
        commits: prMeta.commits ?? [],
        files: changedFiles,
        crossRepoImpact,
        totalImpactedFiles: new Set(changedFiles.flatMap((f: { blastRadius: Array<{ file_path: string }> }) =>
          f.blastRadius.map((n) => n.file_path)
        )).size,
      });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  },
};

// ── EP-54: PR Watch endpoints ──────────────────────────────────────────────

// GET /api/pr/watch?repo=<name>
const watchListRoute: RouteHandler = {
  method: 'GET',
  path: '/api/pr/watch',
  handle(_req, res, ctx, url) {
    const repo = url.searchParams.get('repo') ?? defaultRepoName();
    const rows = ctx.db.prepare(
      'SELECT pr_num FROM watched_prs WHERE repo = ? ORDER BY watched_at DESC'
    ).all(repo) as Array<{ pr_num: number }>;
    json(res, 200, { prs: rows.map((r) => r.pr_num) });
  },
};

// POST /api/pr/watch — body { repo, pr }
const watchAddRoute: RouteHandler = {
  method: 'POST',
  path: '/api/pr/watch',
  async handle(req, res, ctx) {
    const rawBody = await readBody(req);
    const parsed = parseBody(z.object({ repo: z.string(), pr: z.number().int() }), rawBody);
    if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
    const { repo, pr } = parsed.data;
    ctx.db.prepare(
      'INSERT OR IGNORE INTO watched_prs (repo, pr_num, watched_at) VALUES (?, ?, ?)'
    ).run(repo, pr, new Date().toISOString());
    json(res, 201, { ok: true });
  },
};

// DELETE /api/pr/watch?repo=<name>&pr=123
const watchDeleteRoute: RouteHandler = {
  method: 'DELETE',
  path: '/api/pr/watch',
  handle(_req, res, ctx, url) {
    const repo = url.searchParams.get('repo');
    const pr = parseInt(url.searchParams.get('pr') ?? '', 10);
    if (!repo || isNaN(pr)) { json(res, 400, { error: 'repo and pr required' }); return; }
    ctx.db.prepare('DELETE FROM watched_prs WHERE repo = ? AND pr_num = ?').run(repo, pr);
    res.writeHead(204).end();
  },
};

// ── GET /api/pr/watched-summary ────────────────────────────────────────────
// All watched PRs across all repos with current GitHub state. Uses gh CLI
// (10s per-PR timeout) so a slow PR doesn't block the response indefinitely.
const watchedSummaryRoute: RouteHandler = {
  method: 'GET',
  path: '/api/pr/watched-summary',
  handle(_req, res, ctx) {
    const db = ctx.db;
    const rows = db.prepare(
      'SELECT repo, pr_num, watched_at FROM watched_prs ORDER BY watched_at DESC'
    ).all() as Array<{ repo: string; pr_num: number; watched_at: string }>;
    if (rows.length === 0) { json(res, 200, { items: [] }); return; }

    // Group by repo to batch gh calls
    const byRepo: Record<string, number[]> = {};
    for (const r of rows) {
      if (!byRepo[r.repo]) byRepo[r.repo] = [];
      byRepo[r.repo].push(r.pr_num);
    }

    interface WatchedItem {
      repo: string;
      prNum: number;
      title: string;
      headRefName: string | null;
      url: string | null;
      updatedAt: string | null;
      state: string;
      additions: number;
      deletions: number;
      watchedAt: string | null;
    }
    const items: WatchedItem[] = [];
    for (const [repoName, prNums] of Object.entries(byRepo)) {
      const config = new ConfigManager();
      const repoConfig = (config.getRepos() ?? []).find((r: { name: string }) => r.name === repoName);
      if (!repoConfig) continue;
      const slug = repoConfig.githubSlug;

      for (const prNum of prNums) {
        try {
          const raw = execFileSync('gh', [
            'pr', 'view', String(prNum),
            '--repo', slug,
            '--json', 'number,title,headRefName,url,updatedAt,state,additions,deletions',
          ], { encoding: 'utf8', timeout: 10000 });
          const pr = JSON.parse(raw) as {
            number: number; title: string; headRefName: string; url: string;
            updatedAt: string; state: string; additions: number; deletions: number;
          };
          const watchedRow = rows.find((r) => r.repo === repoName && r.pr_num === prNum);
          items.push({
            repo: repoName,
            prNum: pr.number,
            title: pr.title,
            headRefName: pr.headRefName,
            url: pr.url,
            updatedAt: pr.updatedAt,
            state: pr.state,
            additions: pr.additions ?? 0,
            deletions: pr.deletions ?? 0,
            watchedAt: watchedRow?.watched_at ?? null,
          });
        } catch {
          // PR may have been merged/closed/deleted — include stub
          items.push({
            repo: repoName, prNum,
            title: `PR #${prNum}`,
            headRefName: null, url: null,
            updatedAt: null, state: 'UNKNOWN',
            additions: 0, deletions: 0,
            watchedAt: null,
          });
        }
      }
    }
    json(res, 200, { items });
  },
};

export const prRoutes: RouteHandler[] = [
  listRoute,
  reviewRoute,
  enrichRoute,
  createRoute,
  postReviewRoute,
  commitsRoute,
  watchListRoute,
  watchAddRoute,
  watchDeleteRoute,
  watchedSummaryRoute,
];
