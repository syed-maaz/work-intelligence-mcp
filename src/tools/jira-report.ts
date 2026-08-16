/**
 * Jira Report Tool
 *
 * Scrapes a Jira project board, persists issues to the local DB, and
 * produces a structured markdown report with status grouping, assignee
 * breakdown, Bitbucket PR links, and an AI-generated summary.
 *
 * Used by:
 *  - MCP tool:   get_jira_report
 *  - CLI script: npm run report
 */

import Anthropic from '@anthropic-ai/sdk';
import type { PromptCachingBetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/prompt-caching/messages.js';
import type Database from 'better-sqlite3';
import { bucketCallParams } from '../services/model-config.js';
import {
  createTopic,
  getTopicByName,
  upsertMessage,
  updateSyncState,
} from '../db/queries.js';
import {
  createJiraDataSource,
  type JiraDataSource,
} from '../fetcher/sources/jira-adapter.js';
import {
  type ScrapedPR,
} from '../fetcher/sources/jira-browser.js';
import type { BrowserSessionManager } from '../fetcher/sources/browser-session.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GetJiraReportArgs {
  /** Jira project key, e.g. "PROJ" */
  projectKey: string;
  /** Full board URL — RapidBoard or issue navigator */
  boardUrl: string;
  /** ISO date string — only include issues updated on/after this date. Default: 30 days ago */
  since?: string;
  /** DB topic name for caching. Default: projectKey */
  topicName?: string;
}

export interface JiraReportResult {
  markdown: string;
  issueCount: number;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type NormalizedStatus = 'Blocked' | 'In Progress' | 'Todo' | 'Done';

interface ReportIssue {
  key: string;
  title: string;
  status: NormalizedStatus;
  rawStatus: string;
  assignee: string;
  issueType: string;
  priority: string;
  updatedAt: Date;
  prs: ScrapedPR[];
}

interface PRWithIssue extends ScrapedPR {
  issueKey: string;
}

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

function normalizeStatus(rawStatus: string, priority: string): NormalizedStatus {
  const s = rawStatus.toLowerCase();
  const p = priority.toLowerCase();

  if (s.includes('block') || p === 'blocker') return 'Blocked';
  if (s.includes('progress') || s.includes('review') || s.includes('active') ||
      s.includes('testing') || s.includes('development') ||
      s.includes('open') || s.includes('reopened')) return 'In Progress';
  if (s.includes('done') || s.includes('closed') || s.includes('resolv') ||
      s.includes('released') || s.includes("won't fix") || s.includes('complete') ||
      s.includes('cancel')) return 'Done';
  return 'Todo';
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function getJiraReport(
  db: Database.Database,
  args: GetJiraReportArgs,
  session: BrowserSessionManager,
  anthropicApiKey?: string
): Promise<JiraReportResult> {
  const { projectKey, boardUrl } = args;
  const topicName = args.topicName ?? projectKey;

  // Ensure topic row exists
  let topic = getTopicByName(db, topicName);
  if (!topic) {
    topic = createTopic(db, { name: topicName });
  }

  // Compute since date — default 30 days
  const sinceDate = args.since
    ? new Date(args.since)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // ---- Fetch ----
  const connector: JiraDataSource = createJiraDataSource(session);
  const messages = await connector.fetchMessages(
    { boardUrl, projectKey } as unknown as Record<string, unknown>,
    sinceDate
  );

  // ---- Persist to DB ----
  for (const msg of messages) {
    if (!msg.metadata.jira?.issueKey) continue;
    upsertMessage(db, {
      topic_id: topic.id,
      source: msg.source,
      source_id: msg.id,
      subject: msg.subject,
      content: msg.content,
      author: msg.sender.name,
      timestamp: msg.createdAt.toISOString(),
      metadata: JSON.stringify(msg.metadata),
      raw_data: JSON.stringify(msg.raw),
    });
  }

  // Update sync state
  updateSyncState(db, String(topic.id), 'jira', new Date().toISOString(), messages.length);

  // ---- Build report issues (issues only, not comments) ----
  const reportIssues: ReportIssue[] = messages
    .filter((m) => !m.isReply && m.metadata.jira?.issueKey)
    .map((m) => {
      const jira = m.metadata.jira!;
      const raw = m.raw as { bitbucketPRs?: ScrapedPR[] } | undefined;
      return {
        key: jira.issueKey,
        title: m.subject.replace(`[${jira.issueKey}] `, ''),
        status: normalizeStatus(jira.status ?? '', jira.priority ?? ''),
        rawStatus: jira.status ?? '',
        assignee: jira.assignee?.name ?? 'Unassigned',
        issueType: jira.issueType ?? 'Unknown',
        priority: jira.priority ?? 'Unknown',
        updatedAt: m.modifiedAt ?? m.createdAt,
        prs: raw?.bitbucketPRs ?? [],
      };
    });

  // ---- Group ----
  const grouped = {
    blocked: reportIssues.filter((i) => i.status === 'Blocked'),
    inProgress: reportIssues.filter((i) => i.status === 'In Progress'),
    todo: reportIssues.filter((i) => i.status === 'Todo'),
    done: reportIssues.filter((i) => i.status === 'Done'),
  };

  // By assignee (exclude Done)
  const byAssignee = new Map<string, ReportIssue[]>();
  for (const issue of [...grouped.blocked, ...grouped.inProgress, ...grouped.todo]) {
    const existing = byAssignee.get(issue.assignee) ?? [];
    existing.push(issue);
    byAssignee.set(issue.assignee, existing);
  }

  // Open PRs across all issues
  const openPRs: PRWithIssue[] = reportIssues
    .flatMap((i) => i.prs.map((pr) => ({ ...pr, issueKey: i.key })))
    .filter((pr) => pr.status === 'OPEN');

  // ---- AI analysis ----
  let aiAnalysis = '_AI analysis skipped — no API key configured._';
  if (anthropicApiKey) {
    try {
      aiAnalysis = await generateAIAnalysis(reportIssues, projectKey, anthropicApiKey, db);
    } catch (err) {
      aiAnalysis = `_AI analysis failed: ${err instanceof Error ? err.message : String(err)}_`;
    }
  }

  // ---- Render ----
  const markdown = renderMarkdown({
    projectKey,
    generatedAt: new Date(),
    sinceDate,
    grouped,
    byAssignee,
    openPRs,
    totalCount: reportIssues.length,
    aiAnalysis,
  });

  return {
    markdown,
    issueCount: reportIssues.length,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// AI analysis
// ---------------------------------------------------------------------------

async function generateAIAnalysis(
  issues: ReportIssue[],
  projectKey: string,
  apiKey: string,
  db?: Database.Database,
): Promise<string> {
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const client = new Anthropic({
    apiKey: baseURL ? 'x-proxy' : apiKey,
    ...(baseURL ? {
      baseURL,
      defaultHeaders: { 'Authorization': `Bearer ${apiKey}` },
    } : {}),
  });

  const bucketParams = db ? bucketCallParams(db, 'digest', 800) : {
    model: 'claude-sonnet-4-6' as const,
    max_tokens: 800,
  };
  const cachedSystem: PromptCachingBetaTextBlockParam[] = [
    { type: 'text', text: 'You are a senior engineering manager analyzing a Jira board. Be concise and specific.', cache_control: { type: 'ephemeral' } },
  ];

  const issueLines = issues
    .map((i) => `${i.key} [${i.status}] [${i.priority}] ${i.title} — ${i.assignee}`)
    .join('\n');

  const prompt = `You are analyzing the Jira board for project ${projectKey}.

Here are the current issues:
${issueLines}

Provide a concise team health analysis (5-8 bullet points) covering:
- Overall progress and momentum
- Blockers or risks that need attention
- Workload distribution concerns
- Any patterns worth flagging (e.g. too many in-progress, stale items)
- Recommendations

Be specific — reference issue keys where relevant. Be brief.`;

  const response = await client.beta.promptCaching.messages.create({
    ...bucketParams,
    system: cachedSystem,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock?.type === 'text' ? textBlock.text : '_No analysis generated._';
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

interface RenderInput {
  projectKey: string;
  generatedAt: Date;
  sinceDate: Date;
  totalCount: number;
  grouped: {
    blocked: ReportIssue[];
    inProgress: ReportIssue[];
    todo: ReportIssue[];
    done: ReportIssue[];
  };
  byAssignee: Map<string, ReportIssue[]>;
  openPRs: PRWithIssue[];
  aiAnalysis: string;
}

function renderIssueRow(issue: ReportIssue): string {
  const prBadge = issue.prs.length > 0
    ? ` | PRs: ${issue.prs.map((p) => `[#${p.id}](${p.url})`).join(', ')}`
    : '';
  return `- **${issue.key}**: ${issue.title} — _${issue.assignee}_${prBadge}`;
}

function renderMarkdown(input: RenderInput): string {
  const { projectKey, generatedAt, sinceDate, grouped, byAssignee, openPRs, totalCount, aiAnalysis } = input;

  const fmt = (d: Date) => d.toISOString().split('T')[0];
  const lines: string[] = [];

  // Header
  lines.push(`# ${projectKey} Team — Jira Report`);
  lines.push(`_Generated: ${fmt(generatedAt)} | Issues: ${totalCount} | Since: ${fmt(sinceDate)}_`);
  lines.push('');

  // Overview
  lines.push('## 📊 Overview');
  lines.push(`| Status | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| 🔴 Blocked | ${grouped.blocked.length} |`);
  lines.push(`| 🔄 In Progress | ${grouped.inProgress.length} |`);
  lines.push(`| 📋 Todo | ${grouped.todo.length} |`);
  lines.push(`| ✅ Done | ${grouped.done.length} |`);
  lines.push('');

  // Blocked
  lines.push('## 🔴 Blocked / Needs Attention');
  if (grouped.blocked.length > 0) {
    for (const i of grouped.blocked) lines.push(renderIssueRow(i));
  } else {
    lines.push('_None_');
  }
  lines.push('');

  // In Progress
  lines.push('## 🔄 In Progress');
  if (grouped.inProgress.length > 0) {
    for (const i of grouped.inProgress) lines.push(renderIssueRow(i));
  } else {
    lines.push('_None_');
  }
  lines.push('');

  // Todo
  lines.push('## 📋 Todo / Backlog');
  if (grouped.todo.length > 0) {
    for (const i of grouped.todo) lines.push(renderIssueRow(i));
  } else {
    lines.push('_None_');
  }
  lines.push('');

  // Done
  lines.push('## ✅ Recently Completed');
  if (grouped.done.length > 0) {
    for (const i of grouped.done) lines.push(renderIssueRow(i));
  } else {
    lines.push('_None_');
  }
  lines.push('');

  // By Assignee
  lines.push('## 👥 By Assignee (active issues)');
  if (byAssignee.size > 0) {
    const sorted = [...byAssignee.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [assignee, issues] of sorted) {
      lines.push(`**${assignee}** (${issues.length})`);
      for (const i of issues) {
        lines.push(`  - ${i.key} [${i.status}]: ${i.title}`);
      }
    }
  } else {
    lines.push('_No active issues_');
  }
  lines.push('');

  // Open PRs
  lines.push('## 🔗 Open PRs (Bitbucket)');
  if (openPRs.length > 0) {
    for (const pr of openPRs) {
      lines.push(`- [PR #${pr.id}](${pr.url}) — ${pr.title || pr.repoSlug} — issue: **${pr.issueKey}** — author: ${pr.author || 'Unknown'}`);
    }
  } else {
    lines.push('_None found (development panel may require manual check)_');
  }
  lines.push('');

  // AI Analysis
  lines.push('## 🤖 AI Analysis');
  lines.push(aiAnalysis);

  return lines.join('\n');
}
