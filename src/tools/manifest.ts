/**
 * wi-tools manifest — single source of truth for all wi_* operational tools.
 *
 * Architecture constraints (ADR-025):
 *   D-01: Each manifest entry is declarative-only — no `handler:` field
 *   D-02: TOOL_MANIFEST is a flat array (not nested, not keyed)
 *   D-03: Plugin imports via direct relative path `../../../tools/manifest.js`
 *   D-04: `buildHandler` is colocated in manifest.ts (not in a separate file)
 *
 * Pitfall 6 guard: this file ONLY imports from 'zod'. No src/db, src/services,
 * imports — server-only modules cannot be loaded from external sandboxes.
 */

import { z } from 'zod';

// ─── Exported types ──────────────────────────────────────────────────────────

export interface ToolEntry {
  name: string;
  description: string;
  endpoint: string | ((input: unknown) => string);
  method:
    | 'GET'
    | 'POST'
    | 'PUT'
    | 'DELETE'
    | ((input: unknown) => 'GET' | 'POST' | 'PUT' | 'DELETE');
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  timeoutMs?: number;
}

export type Consumer = 'atlas' | 'mcp' | 'ui';

export interface BuildHandlerOpts {
  consumer: Consumer;
  getUser: () => string;
  bridgeUrl?: string;
  defaultTimeoutMs?: number;
  budgetCheck?: () => { allowed: boolean; message?: string };
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

// ─── TOOL_MANIFEST ───────────────────────────────────────────────────────────

export const TOOL_MANIFEST: ToolEntry[] = [
  // 1. wi_search
  {
    name: 'wi_search',
    description:
      'Search across Jira, Teams, email, and GitHub. Use when the user asks what is happening with a topic, project, or person.',
    endpoint: '/api/search-all',
    method: 'POST',
    inputSchema: z
      .object({
        query: z.string(),
        sources: z.array(z.string()).optional(),
        limit: z.number().optional(),
      })
      .strict(),
    outputSchema: z
      .object({
        markdown: z.string().optional(),
      })
      .passthrough(),
  },

  // 2. wi_jira_get
  {
    name: 'wi_jira_get',
    description:
      "Retrieve Jira issues by kind: 'issues' (project), 'my_issues' (assigned to me), 'board' (sprint board; 'saturn' is deprecated).",
    endpoint: (input: unknown) => {
      const { kind } = input as { kind: string };
      const map: Record<string, string> = {
        issues: '/api/jira/issues',
        my_issues: '/api/jira/my-issues',
        saturn: '/api/board/issues',
        board: '/api/board/issues',
      };
      return map[kind] ?? '/api/jira/issues';
    },
    method: (_input: unknown) => 'GET' as const,
    inputSchema: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('issues'), project: z.string().optional() }).strict(),
      z.object({ kind: z.literal('my_issues') }).strict(),
      z.object({ kind: z.literal('saturn') }).strict(),
      z.object({ kind: z.literal('board'), project: z.string().optional() }).strict(),
    ]),
    outputSchema: z
      .object({
        issues: z.array(z.object({}).passthrough()).optional(),
        cachedAt: z.string().optional(),
        isRefreshing: z.boolean().optional(),
      })
      .passthrough(),
  },

  // 3. wi_jira_stuck
  {
    name: 'wi_jira_stuck',
    description:
      'List Jira tickets that have been stuck in their current status. Use when the user asks what is blocked or stuck.',
    endpoint: '/api/jira/stuck',
    method: 'GET',
    inputSchema: z
      .object({
        project: z.string().optional(),
        days: z.number().min(1).max(30).optional(),
      })
      .strict(),
    outputSchema: z
      .object({
        stuck: z.array(z.object({}).passthrough()).optional(),
        count: z.number().optional(),
        days: z.number().optional(),
        project: z.string().optional(),
      })
      .passthrough(),
  },

  // 4. wi_jira_analyze
  {
    name: 'wi_jira_analyze',
    description:
      "Analyze or investigate a Jira issue. Use 'analyze' for fast root-cause analysis, 'investigate' for a deep async investigation (returns 202).",
    endpoint: (input: unknown) => {
      const { kind } = input as { kind: string };
      return kind === 'investigate' ? '/api/jira/investigate' : '/api/jira/analyze';
    },
    method: (_input: unknown) => 'POST' as const,
    timeoutMs: 30000,
    inputSchema: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('analyze'),
          key: z.string(),
          context: z.string().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('investigate'),
          key: z.string(),
          context: z.string().optional(),
        })
        .strict(),
    ]),
    outputSchema: z
      .object({
        analysis: z.string().optional(),
        sessionId: z.string().optional(),
      })
      .passthrough(),
  },

  // 5. wi_jira_metrics
  {
    name: 'wi_jira_metrics',
    description:
      'Retrieve Jira delivery metrics: cycle time, velocity, or past learnings from completed issues.',
    endpoint: (input: unknown) => {
      const { kind } = input as { kind: string };
      const map: Record<string, string> = {
        cycle_time: '/api/jira/cycle-time',
        velocity: '/api/jira/velocity',
        learnings: '/api/jira/learnings',
      };
      return map[kind] ?? '/api/jira/cycle-time';
    },
    method: (_input: unknown) => 'GET' as const,
    inputSchema: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('cycle_time'), project: z.string().optional() })
        .strict(),
      z
        .object({ kind: z.literal('velocity'), project: z.string().optional() })
        .strict(),
      z.object({ kind: z.literal('learnings'), limit: z.number().optional() }).strict(),
    ]),
    // velocity: { project, weeks, stats[] }
    // cycle_time: { issue, cycle_time_hours, cycle_time_days }
    // learnings: bridge-specific shape; passthrough covers variance
    outputSchema: z
      .object({
        project: z.string().optional(),
        weeks: z.number().optional(),
        stats: z.array(z.object({}).passthrough()).optional(),
        issue: z.string().optional(),
        cycle_time_hours: z.number().nullable().optional(),
        cycle_time_days: z.number().nullable().optional(),
      })
      .passthrough(),
  },

  // 6. wi_pr_list
  {
    name: 'wi_pr_list',
    description:
      "List pull requests by kind: 'list' (open PRs), 'watched' (watched-repo summary), 'review' (pending review).",
    endpoint: (input: unknown) => {
      const { kind } = input as { kind: string };
      const map: Record<string, string> = {
        list: '/api/pr/list',
        watched: '/api/pr/watched-summary',
        review: '/api/pr/review',
      };
      return map[kind] ?? '/api/pr/list';
    },
    method: (_input: unknown) => 'GET' as const,
    inputSchema: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('list'), repo: z.string().optional() }).strict(),
      z.object({ kind: z.literal('watched') }).strict(),
      z.object({ kind: z.literal('review') }).strict(),
    ]),
    outputSchema: z
      .object({
        prs: z.array(z.object({}).passthrough()).optional(),
        source: z.string().optional(),
      })
      .passthrough(),
  },

  // 7. wi_pr_create
  {
    name: 'wi_pr_create',
    description:
      "Create a pull request or post a PR review comment. SAFETY: dry_run defaults to true — returns a preview only. The caller MUST set dry_run=false (and only after explicit user confirmation) to actually open the PR or submit the review. Use 'create' to open a PR, 'post_review' to submit review feedback.",
    endpoint: (input: unknown) => {
      const { kind } = input as { kind: string };
      return kind === 'post_review' ? '/api/pr/post-review' : '/api/pr/create';
    },
    method: (_input: unknown) => 'POST' as const,
    inputSchema: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('create'),
          repo: z.string(),
          title: z.string(),
          body: z.string().optional(),
          branch: z.string().optional(),
          base: z.string().optional(),
          dry_run: z.boolean().default(true),
        })
        .strict(),
      z
        .object({
          kind: z.literal('post_review'),
          repo: z.string(),
          pr: z.number(),
          body: z.string(),
          event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).optional(),
          dry_run: z.boolean().default(true),
        })
        .strict(),
    ]),
    outputSchema: z
      .object({
        url: z.string().optional(),
        number: z.number().optional(),
        dry_run: z.boolean().optional(),
        preview: z.object({}).passthrough().optional(),
      })
      .passthrough(),
  },

  // 8. wi_action_items
  {
    name: 'wi_action_items',
    description:
      "Retrieve action items: 'all' for all open items, 'pending_review' for items awaiting review.",
    endpoint: (input: unknown) => {
      const { kind } = input as { kind: string };
      return kind === 'pending_review'
        ? '/api/action-items/pending-review'
        : '/api/action-items';
    },
    method: (_input: unknown) => 'GET' as const,
    inputSchema: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('all'), topic: z.string().optional() }).strict(),
      z.object({ kind: z.literal('pending_review') }).strict(),
    ]),
    outputSchema: z.array(z.object({}).passthrough()),
  },

  // 9. wi_topics
  {
    name: 'wi_topics',
    description:
      "Manage monitored topics: 'list' all topics, 'expert' for a topic deep-dive, 'configure' to add or update a topic.",
    endpoint: (input: unknown) => {
      const { kind } = input as { kind: string };
      const map: Record<string, string> = {
        list: '/api/topics',
        expert: '/api/topic-expert',
        configure: '/api/configure-topic',
      };
      return map[kind] ?? '/api/topics';
    },
    method: (input: unknown) => {
      const { kind } = input as { kind: string };
      return kind === 'list' ? 'GET' : 'POST';
    },
    inputSchema: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('list') }).strict(),
      z
        .object({ kind: z.literal('expert'), topic: z.string(), depth: z.string().optional() })
        .strict(),
      z
        .object({
          kind: z.literal('configure'),
          name: z.string(),
          keywords: z.array(z.string()).optional(),
        })
        .strict(),
    ]),
    // 'list' returns array directly; 'expert'/'configure' return objects
    outputSchema: z.union([
      z.array(z.object({}).passthrough()),
      z.object({}).passthrough(),
    ]),
  },

  // 10. wi_teams
  {
    name: 'wi_teams',
    description:
      "Query Teams activity: 'updates' to search messages (POST), 'chats' for active chat list, 'meetings' for recent meetings.",
    endpoint: (input: unknown) => {
      const { kind } = input as { kind: string };
      const map: Record<string, string> = {
        updates: '/api/teams-updates',
        chats: '/api/teams/chats',
        meetings: '/api/meetings/recent',
      };
      return map[kind] ?? '/api/teams-updates';
    },
    method: (input: unknown) => {
      const { kind } = input as { kind: string };
      return kind === 'updates' ? 'POST' : 'GET';
    },
    inputSchema: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('updates'), query: z.string(), limit: z.number().optional() })
        .strict(),
      z.object({ kind: z.literal('chats') }).strict(),
      z.object({ kind: z.literal('meetings'), limit: z.number().optional() }).strict(),
    ]),
    outputSchema: z
      // Output shape varies by kind: chats→{chats}, meetings→{meetings}, updates→{summary,...}
      .object({
        chats: z.array(z.object({}).passthrough()).optional(),
        meetings: z.array(z.object({}).passthrough()).optional(),
        summary: z.string().optional(),
      })
      .passthrough(),
  },

  // 11. wi_calendar
  {
    name: 'wi_calendar',
    description:
      'List upcoming calendar events. Use when the user asks about their schedule or what is coming up.',
    endpoint: '/api/calendar/upcoming',
    method: 'GET',
    inputSchema: z.object({ days: z.number().optional() }).strict(),
    outputSchema: z
      .object({
        events: z.array(z.object({}).passthrough()).optional(),
        count: z.number().optional(),
      })
      .passthrough(),
  },

  // 12. wi_digest
  {
    name: 'wi_digest',
    description:
      "Retrieve AI-generated digests: 'morning' for daily brief, 'daily' for end-of-day summary, 'weekly' for week-in-review.",
    timeoutMs: 30000,
    endpoint: (input: unknown) => {
      const { kind } = input as { kind: string };
      const map: Record<string, string> = {
        morning: '/api/morning-brief',
        daily: '/api/daily-summary',
        weekly: '/api/weekly-report',
      };
      return map[kind] ?? '/api/morning-brief';
    },
    method: (_input: unknown) => 'GET' as const,
    inputSchema: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('morning') }).strict(),
      z.object({ kind: z.literal('daily') }).strict(),
      z.object({ kind: z.literal('weekly') }).strict(),
    ]),
    outputSchema: z
      .object({
        // morning-brief: { date, cached, generatedAt, sections, slackMarkdown }
        // daily-summary: { markdown, cached } or { markdown, cached: bool }
        // weekly-report: bridge-specific
        date: z.string().optional(),
        cached: z.boolean().optional(),
        generatedAt: z.string().optional(),
        sections: z.object({}).passthrough().optional(),
        slackMarkdown: z.string().optional(),
        markdown: z.string().optional(),
        content: z.string().optional(),
      })
      .passthrough(),
  },

  // 13. wi_code_graph
  {
    name: 'wi_code_graph',
    description:
      "Explore the code graph: 'blast_radius' for change impact, 'owners' for file ownership, 'test_coverage' for coverage status.",
    timeoutMs: 15000,
    endpoint: (input: unknown) => {
      const { kind } = input as { kind: string };
      const map: Record<string, string> = {
        blast_radius: '/api/code-graph/blast-radius',
        owners: '/api/code-graph/owners',
        test_coverage: '/api/code-graph/test-coverage',
      };
      return map[kind] ?? '/api/code-graph/blast-radius';
    },
    method: (_input: unknown) => 'GET' as const,
    inputSchema: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('blast_radius'),
          repo: z.string(),
          file: z.string(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('owners'),
          repo: z.string(),
          file: z.string(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('test_coverage'),
          repo: z.string(),
          file: z.string(),
        })
        .strict(),
    ]),
    outputSchema: z
      .object({
        // owners: { owners: [] }
        // blast_radius: { nodes: [], edges: [] } (if implemented)
        // test_coverage: { coverage: ... } (if implemented)
        owners: z.array(z.string()).optional(),
        data: z.unknown().optional(),
      })
      .passthrough(),
  },
  {
    name: 'wi_teammates',
    description:
      "Query teammate data: 'list' all known teammates, 'expert' to find subject matter experts for a file or topic.",
    endpoint: (input: unknown) => {
      const { kind } = input as { kind: string };
      return kind === 'expert' ? '/api/teammates/expert' : '/api/teammates';
    },
    method: (_input: unknown) => 'GET' as const,
    inputSchema: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('list') }).strict(),
      z
        .object({
          kind: z.literal('expert'),
          topic: z.string().optional(),
          file: z.string().optional(),
        })
        .strict(),
    ]),
    // 'list' returns array directly; 'expert' returns { experts: [] } or { teammates: [] }
    outputSchema: z.union([
      z.array(z.object({}).passthrough()),
      z
        .object({
          teammates: z.array(z.object({}).passthrough()).optional(),
          experts: z.array(z.object({}).passthrough()).optional(),
        })
        .passthrough(),
    ]),
  },

  // 15. wi_sync
  {
    name: 'wi_sync',
    description:
      "Control data synchronization: 'all' to trigger a full sync (POST, slow), 'status' to check sync state.",
    endpoint: (input: unknown) => {
      const { kind } = input as { kind: string };
      return kind === 'all' ? '/api/sync/all' : '/api/sync/status';
    },
    method: (input: unknown) => {
      const { kind } = input as { kind: string };
      return kind === 'all' ? 'POST' : 'GET';
    },
    timeoutMs: 30000,
    inputSchema: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('all') }).strict(),
      z.object({ kind: z.literal('status') }).strict(),
    ]),
    outputSchema: z
      .object({
        // sync/status response: { running, currentTopic, completedTopics, startedAt, completedAt, error, watcher }
        // sync/all response: { started: true }
        running: z.boolean().optional(),
        currentTopic: z.string().nullable().optional(),
        completedTopics: z.array(z.string()).optional(),
        startedAt: z.string().nullable().optional(),
        completedAt: z.string().nullable().optional(),
        error: z.string().nullable().optional(),
        watcher: z.object({}).passthrough().optional(),
        started: z.boolean().optional(),
        status: z.string().optional(),
      })
      .passthrough(),
  },

  // 16. wi_brain_context
  {
    name: 'wi_brain_context',
    description:
      'Retrieve the unified brain context: sprint status, stuck Jiras, noise clusters, open investigations. Use as the starting point for daily planning.',
    endpoint: '/api/brain/context',
    method: 'GET',
    inputSchema: z
      .object({
        topic: z.string().optional(),
        limit: z.number().optional(),
      })
      .strict(),
    outputSchema: z
      .object({
        // Actual keys from /api/brain/context: sprint, stuck_jiras, noise_clusters,
        // calendar_today, open_investigations, memory_relevant, stale_warnings
        sprint: z.object({}).passthrough().nullable().optional(),
        stuck_jiras: z.array(z.object({}).passthrough()).optional(),
        noise_clusters: z.array(z.object({}).passthrough()).optional(),
        calendar_today: z.array(z.object({}).passthrough()).optional(),
        open_investigations: z.array(z.object({}).passthrough()).optional(),
        memory_relevant: z.array(z.unknown()).optional(),
        stale_warnings: z.array(z.string()).optional(),
      })
      .passthrough(),
  },

  // 17. wi_brain_learn
  {
    name: 'wi_brain_learn',
    description:
      'Record the outcome of a brain decision to close the learning loop. Requires a decision_id from a prior get_decision call.',
    endpoint: '/api/brain/learn',
    method: 'POST',
    inputSchema: z
      .object({
        decision_id: z.string(),
        outcome: z.enum(['success', 'failed', 'abandoned']),
        confidence: z.number().optional(),
        notes: z.string().optional(),
      })
      .strict(),
    outputSchema: z
      .object({
        recorded: z.boolean().optional(),
      })
      .passthrough(),
  },

  // 18. wi_decisions_history (GAP-004)
  {
    name: 'wi_decisions_history',
    description:
      'List past brain decisions with rationale and confidence. Use to audit what the brain recommended and when (e.g. "what did you tell me this week?").',
    endpoint: '/api/brain/decisions',
    method: 'GET',
    inputSchema: z
      .object({
        user: z.string().optional(),
        since: z.string().optional(),
        limit: z.number().optional(),
      })
      .strict(),
    outputSchema: z
      .object({
        decisions: z.array(z.object({
          id: z.string(),
          question: z.string(),
          decision: z.string(),
          rationale: z.string().nullable().optional(),
          confidence: z.number().nullable().optional(),
          outcome: z.string().nullable().optional(),
          created_at_iso: z.string().optional(),
        }).passthrough()),
        total: z.number(),
      })
      .passthrough(),
  },

  // 19. wi_bug_report — ADR-030 Phase B (Plan 75-07)
  // Capture a bug into the WI bugs table from outside the bridge process.
  // Idempotent via fingerprint UPSERT — same payload twice produces one row
  // with occurrence_count=2.
  // NOTE: source enum is 4 values, NOT 5. The schema's `bug-investigator`
  // value is reserved for the investigator agent itself; an external
  // caller spoofing it would break the recursion guard.
  {
    name: 'wi_bug_report',
    description:
      "Capture a bug into the WI bugs table. Use when the user describes a bug verbally or when an external tool wants to log a WI-relevant error. Idempotent — same payload twice increments occurrence_count instead of creating a duplicate row.",
    endpoint: '/api/bugs/report',
    method: 'POST',
    inputSchema: z
      .object({
        source: z.enum(['bridge', 'agent', 'web-ui', 'sync']).default('agent'),
        errorName: z.string().min(1).max(200),
        message: z.string().min(1).max(2000),
        stack: z.string().max(20_000).optional(),
        context: z.record(z.unknown()).optional(),
      })
      .strict(),
    outputSchema: z
      .object({
        ok: z.literal(true),
        fingerprint: z.string(),
        occurrence_count: z.number(),
        is_new: z.boolean(),
        severity: z.enum(['low', 'medium', 'high']),
      })
      .passthrough(),
  },

  // 20. wi_bug_resolve — ADR-030 Phase B (Plan 75-07)
  // Mark a single bug as resolved or wont-fix. Path-param dispatch via
  // dynamic endpoint(input) → /api/bugs/${bug_id}/resolve.
  {
    name: 'wi_bug_resolve',
    description:
      "Mark a single bug as resolved or wont-fix. Updates status; preserves occurrence_count so future captures of the same fingerprint still increment but stay in the resolved status until manually reopened.",
    endpoint: (input: unknown) => {
      const { bug_id } = input as { bug_id: number };
      return `/api/bugs/${bug_id}/resolve`;
    },
    method: 'POST',
    inputSchema: z
      .object({
        bug_id: z.number().int().positive(),
        resolution: z.enum(['resolved', 'wont-fix']).default('resolved'),
        note: z.string().max(2000).optional(),
      })
      .strict(),
    outputSchema: z
      .object({
        ok: z.literal(true),
        bug: z.object({}).passthrough(),
      })
      .passthrough(),
  },

  // 21. wi_bug_resolve_all — ADR-030 Phase B (Plan 75-07)
  // Bulk-resolve with mandatory max_matches safety cap. If the filter
  // matches more rows than max_matches, returns updated:0 +
  // skipped_over_cap:true so the caller has to narrow the filter.
  {
    name: 'wi_bug_resolve_all',
    description:
      "Bulk-resolve captured bugs by filter. Defaults to status='new' (close out the new-bug queue). Refuses if the filter matches more than max_matches (default 100, max 1000) — forces the caller to acknowledge the scope before bulk-closing.",
    endpoint: '/api/bugs/resolve-all',
    method: 'POST',
    inputSchema: z
      .object({
        status: z.enum(['new', 'investigating', 'proposed']).default('new'),
        source: z.enum(['bridge', 'agent', 'web-ui', 'sync', 'bug-investigator']).optional(),
        severity: z.enum(['low', 'medium', 'high']).optional(),
        resolution: z.enum(['resolved', 'wont-fix']).default('resolved'),
        max_matches: z.number().int().positive().max(1000).default(100),
      })
      .strict(),
    outputSchema: z
      .object({
        ok: z.literal(true),
        updated: z.number(),
        skipped_over_cap: z.boolean(),
      })
      .passthrough(),
  },
  {
    name: 'wi_dispatch',
    description:
      "Engage Cypher — WI's senior-engineer agent. Cypher takes a goal, runs the 9-step contract (investigate → ask → research → plan → execute → quality_gate → confirm → surface → record), picks the right wi-* skill via Beta(α,β) learning, and returns a structured session result. v1 returns the chosen skill + invocation suggestion; v2 wires per-skill execution. Read .planning/cypher/03-FRAMEWORK-CONTRACT.md for the full contract spec. WRITE actions are gated: WI's own repo allows local edits/commits without asking, customer repos under ./repos/ require confirmation, anywhere else is blocked.",
    endpoint: '/api/wi/dispatch',
    method: 'POST',
    inputSchema: z
      .object({
        goal: z.string(),
        context: z.string().optional(),
        user: z.string().optional(),
        answers: z.record(z.string(), z.string()).optional(),
        allow_destructive: z.boolean().optional(),
        candidate_skills: z.array(z.string()).optional(),
        outcome: z.enum(['success', 'mixed', 'failed']).optional(),
        session_id: z.string().optional(),
        task_class: z.string().optional(),
        auto_execute: z.boolean().optional(),
        // ADR-038 v2.5 D17 — contract evolution. New fields are
        // OPTIONAL — v2.0 callers omit them and get the v2.0 shape
        // back; v2.5 callers pass them and get result_meta on top.
        taskId: z.string().optional(),
        project: z.string().optional(),
        surface_tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
        contract_version: z.enum(['2.0', '2.5']).optional(),
      })
      .strict(),
    outputSchema: z
      .object({
        session_id: z.string(),
        status: z.enum(['pending', 'done', 'halted', 'asked_user']),
        outcome: z.enum(['success', 'mixed', 'failed']).optional(),
        goal: z.string(),
        task_class: z.string(),
        chosen_skill: z.string().optional(),
        ranked_skills: z.array(z.object({ skill: z.string(), mean: z.number(), runs: z.number() })),
        questions: z.array(z.object({ id: z.string(), question: z.string(), default: z.string() })).optional(),
        pending_confirmation: z.object({}).passthrough().optional(),
        trace: z.array(z.object({}).passthrough()),
        summary: z.string(),
        memory_actions: z.array(z.object({}).passthrough()),
        // ADR-038 v2.5 D17 — result_meta. Suppressed for v2.0 callers
        // (absent on response when contract_version !== '2.5'). v2.5
        // callers always receive contract_version: '2.5' back so the
        // client can detect whether it actually got the upgraded shape.
        result_meta: z
          .object({
            outcome: z.enum(['success', 'mixed', 'failed', 'halted', 'abandoned', 'rejected_non_interactive']).optional(),
            cypher_session_id: z.string(),
            taskId: z.string().optional(),
            worktree_path: z.string().optional(),
            self_assessment: z.object({}).passthrough().optional(),
            suspended_dispatch_id: z.string().optional(),
            surface_tier_used: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
            contract_version: z.literal('2.5'),
          })
          .optional(),
      })
      .passthrough(),
  },
];

// ─── buildHandler ─────────────────────────────────────────────────────────────

export function buildHandler(
  entry: ToolEntry,
  opts: BuildHandlerOpts,
): (rawInput: unknown) => Promise<ToolResult> {
  return async (rawInput: unknown): Promise<ToolResult> => {
    // Step 1: Input validation
    const parsed = entry.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: 'invalid_input', message: parsed.error.message },
      };
    }
    const input = parsed.data as Record<string, unknown>;

    // Step 2: Budget check
    if (opts.budgetCheck) {
      const budget = opts.budgetCheck();
      if (!budget.allowed) {
        return {
          ok: false,
          error: {
            code: 'budget_exceeded',
            message: budget.message ?? 'Tool call budget exceeded for this session',
          },
        };
      }
    }

    // Step 3: Resolve path
    const path =
      typeof entry.endpoint === 'function' ? entry.endpoint(input) : entry.endpoint;

    // Step 4: Resolve method
    const method =
      typeof entry.method === 'function' ? entry.method(input) : entry.method;

    // Step 5: Build URL + params
    const baseUrl =
      opts.bridgeUrl ?? process.env['WI_BRIDGE_URL'] ?? 'http://127.0.0.1:3132';
    const envTimeout = process.env['WI_TOOL_TIMEOUT_MS']
      ? Number(process.env['WI_TOOL_TIMEOUT_MS'])
      : undefined;
    const timeoutMs =
      entry.timeoutMs ?? envTimeout ?? opts.defaultTimeoutMs ?? 8000;

    const url = new URL(path, baseUrl);
    url.searchParams.set('user', opts.getUser());

    let body: string | undefined;
    if (method === 'GET') {
      for (const [k, v] of Object.entries(input)) {
        if (k !== 'kind' && v !== undefined) {
          url.searchParams.set(k, String(v));
        }
      }
    } else {
      body = JSON.stringify(input);
    }

    // Step 6: Fetch with timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-WI-Consumer': opts.consumer,
        },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        let errJson: { error?: string; detail?: string } = {};
        try {
          errJson = (await res.json()) as { error?: string; detail?: string };
        } catch {
          // non-JSON error body — leave errJson empty
        }
        return {
          ok: false,
          error: {
            code: errJson.error ?? `http_${res.status}`,
            message:
              errJson.detail ?? `${method} ${path} returned ${res.status}`,
          },
        };
      }

      const data: unknown = await res.json();
      const outParsed = entry.outputSchema.safeParse(data);
      if (!outParsed.success) {
        console.warn(
          `[wi-tools] ${entry.name}: output schema mismatch — ${outParsed.error.message}`,
        );
      }
      return { ok: true, data };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' ||
          msg.includes('aborted') ||
          msg.includes('timeout'));
      return {
        ok: false,
        error: {
          code: isAbort ? 'timeout' : 'network_error',
          message: msg,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
