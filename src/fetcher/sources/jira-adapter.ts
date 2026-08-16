/**
 * Jira Data Source Adapter (EP-46)
 *
 * Introduces a `JiraDataSource` abstraction over two implementations:
 *   - `JiraMcpAdapter`  — primary; calls a config-driven Jira MCP server via McpClient
 *   - `JiraBrowserConnector` — fallback; existing Playwright scraper (unchanged)
 *
 * Selection is controlled by the JIRA_SOURCE env var:
 *   JIRA_SOURCE=mcp        → only MCP
 *   JIRA_SOURCE=browser    → only browser scraper
 *   JIRA_SOURCE=auto       → try MCP first, fall back to browser on any error (default)
 *
 * Client name and URL are driven by wi.config.json (connectors.jira.mcp).
 * After that, McpClient handles all OAuth token refreshes automatically.
 * No Claude Code session required, no subprocess, no browser profile needed.
 */

import { MessageSource } from './types.js';
import type { UnifiedMessage } from './types.js';
import { JiraBrowserConnector } from './jira-browser.js';
import type { BrowserSessionManager } from './browser-session.js';
import type { DataSource } from '../types.js';
import { McpClient } from './mcp-oauth-client.js';
import { getDatabase } from '../../db/connection.js';
import { getJiraMcpClientName, getJiraMcpUrl, getJiraBrowseUrl } from '../../services/wi-config.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

function getClientName(): string { try { return getJiraMcpClientName(); } catch { return 'jira'; } }
function getMcpUrl(): string { try { return getJiraMcpUrl(); } catch { return process.env.JIRA_MCP_URL ?? 'https://mcp.jira.example.com/mcp'; } }
function buildBrowseUrl(key: string): string { try { return getJiraBrowseUrl(key); } catch { return `https://${process.env.JIRA_DOMAIN ?? 'jira.example.com'}/browse/${key}`; } }

// EP-48-1: child issue shape returned by fetchEpicChildren
export interface EpicChildIssue {
  key: string;
  title: string;
  status: string;
  issueType: string;
  assignee: string | null;
  url: string;
}

export interface JiraDataSource {
  fetchMessages(
    config: Record<string, unknown>,
    since?: Date
  ): Promise<UnifiedMessage[]>;
}

/**
 * EP-48-1: Fetch child issues of an epic.
 * Uses MCP (jira_search with JQL `parent = epicKey`) when JIRA_SOURCE != 'browser',
 * falls back to the browser scraper otherwise.
 */
export async function fetchEpicChildren(
  epicKey: string,
  session: BrowserSessionManager,
): Promise<EpicChildIssue[]> {
  const mode = (process.env.JIRA_SOURCE as 'mcp' | 'browser' | 'auto' | undefined) ?? 'auto';
  if (mode === 'browser') {
    const browser = new JiraBrowserConnector(session);
    return browser.scrapeEpicChildren(epicKey);
  }
  // MCP path (auto or mcp)
  try {
    const db = getDatabase();
    const client = new McpClient(db, getClientName(), getMcpUrl());
    const jql = `parent = "${epicKey}" ORDER BY updated DESC`;
    const raw = await client.callTool('jira_search', {
      jql,
      limit: 50,
      start_at: 0,
      fields: 'summary,status,issuetype,assignee',
    });
    const parsed = JSON.parse(raw) as { issues?: JiraIssue[] } | JiraIssue[];
    const issues: JiraIssue[] = Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
    return issues.map(issue => ({
      key: issue.key,
      title: issue.fields.summary ?? '',
      status: issue.fields.status?.name ?? 'Unknown',
      issueType: issue.fields.issuetype?.name ?? 'Story',
      assignee: issue.fields.assignee?.displayName ?? null,
      url: buildBrowseUrl(issue.key),
    }));
  } catch (err) {
    if (mode === 'mcp') throw err;
    // auto: fall back to browser
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[fetchEpicChildren] MCP failed, falling back to browser: ${msg}\n`);
    const browser = new JiraBrowserConnector(session);
    return browser.scrapeEpicChildren(epicKey);
  }
}

type JiraSourceMode = 'mcp' | 'browser' | 'auto';

/**
 * Factory — reads JIRA_SOURCE env var and returns the right implementation.
 */
export function createJiraDataSource(
  session: BrowserSessionManager,
  mode?: JiraSourceMode
): JiraDataSource {
  const resolved = (mode ?? (process.env.JIRA_SOURCE as JiraSourceMode | undefined) ?? 'auto');

  switch (resolved) {
    case 'mcp':
      return new JiraMcpAdapter();
    case 'browser':
      return new JiraBrowserConnector(session);
    default: // 'auto'
      return new JiraAutoAdapter(session);
  }
}

// ---------------------------------------------------------------------------
// MCP response types (Jira REST API shape returned by jira_search)
// ---------------------------------------------------------------------------

interface JiraIssueFields {
  summary?: string | null;
  description?: string | null;
  status?: { name: string } | null;
  priority?: { name: string } | null;
  assignee?: { displayName: string; emailAddress?: string } | null;
  reporter?: { displayName: string; emailAddress?: string } | null;
  created?: string | null;
  updated?: string | null;
  issuetype?: { name: string } | null;
  project?: { key: string } | null;
  customfield_10014?: string | null;  // epic key
  labels?: string[];
  comment?: { comments: JiraComment[] };
}

interface JiraIssue {
  id: string;
  key: string;
  fields: JiraIssueFields;
}

interface JiraSearchResult {
  issues: JiraIssue[];
  total?: number;
}

interface JiraComment {
  id: string;
  author?: { displayName: string; emailAddress?: string };
  body?: string;
  created?: string;
}

// ---------------------------------------------------------------------------
// JiraMcpAdapter — uses McpClient for headless OAuth
// ---------------------------------------------------------------------------

export class JiraMcpAdapter implements JiraDataSource {
  private getClient(): McpClient {
    const db = getDatabase();
    return new McpClient(db, getClientName(), getMcpUrl());
  }

  async fetchMessages(
    config: Record<string, unknown>,
    since?: Date
  ): Promise<UnifiedMessage[]> {
    const boardUrl = String(config.boardUrl ?? '');
    const isMyIssues = boardUrl.includes('filter=-1') || boardUrl.includes('filter=myfavorite');

    if (!isMyIssues && !config.projectKey && !boardUrl) {
      throw new Error('JiraMcpAdapter: config.projectKey or config.boardUrl is required');
    }

    const key = isMyIssues ? '' : this.extractProjectKey(config);
    const cutoff = since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sinceDateStr = cutoff.toISOString().slice(0, 10);

    const myUsername = process.env.JIRA_MY_USERNAME;
    const assigneeClause = myUsername ? `assignee = "${myUsername}"` : `assignee = currentUser()`;
    const jql = isMyIssues
      ? `${assigneeClause} AND statusCategory != Done ORDER BY updated DESC`
      : `project = "${key}" AND updated >= "${sinceDateStr}" ORDER BY updated DESC`;

    process.stderr.write(`[JiraMcpAdapter] Fetching: ${jql}\n`);

    const client = this.getClient();

    // Fetch in pages of 50 (MCP server max) until we have up to 100 issues
    const allIssues: JiraIssue[] = [];
    let startAt = 0;
    const pageSize = 50;
    const maxIssues = 100;

    while (allIssues.length < maxIssues) {
      const raw = await client.callTool('jira_search', {
        jql,
        limit: pageSize,
        start_at: startAt,
        fields: 'summary,status,priority,assignee,reporter,created,updated,issuetype,project,customfield_10014,labels',
      });

      const parsed = JSON.parse(raw) as JiraSearchResult | JiraIssue[];
      const page = Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
      allIssues.push(...page);

      if (page.length < pageSize) break; // last page
      startAt += pageSize;
    }

    process.stderr.write(`[JiraMcpAdapter] Fetched ${allIssues.length} issues\n`);

    const messages: UnifiedMessage[] = [];
    let skipped = 0;
    for (const issue of allIssues) {
      // Guard: a malformed issue in the batch (missing `fields`) must NOT crash
      // the whole MCP parse. Before this guard, one such issue threw
      // "Cannot read properties of undefined (reading 'created')", the entire
      // MCP fetch failed, and JiraAutoAdapter fell back to the browser scraper —
      // which opens ~100 detail pages sequentially (~40 min). Skip the bad issue,
      // keep the fast API path alive. (See fix/jira-mcp-guard-and-telemetry.)
      // Guard: skip a genuinely empty issue (no usable shape at all). The MCP
      // server returns fields FLAT (top-level), the REST/browser path nests them
      // under `.fields` — issueToMessage normalizes both, so we only skip when
      // NEITHER a key nor any field data is present. (Bug #792.)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ai = issue as any;
      if (!ai || !ai.key) {
        skipped++;
        continue;
      }
      messages.push(this.issueToMessage(issue));
      // Comments: MCP flat has no nested comment array; REST nests under fields.
      for (const comment of ai.fields?.comment?.comments ?? ai.comment?.comments ?? []) {
        messages.push(this.commentToMessage(comment, issue));
      }
    }
    if (skipped > 0) {
      process.stderr.write(`[JiraMcpAdapter] Skipped ${skipped}/${allIssues.length} malformed issue(s) (no fields)\n`);
    }
    return messages;
  }

  private extractProjectKey(config: Record<string, unknown>): string {
    if (config.projectKey) return String(config.projectKey);
    const boardUrl = String(config.boardUrl ?? '');
    try {
      const url = new URL(boardUrl);
      const pk = url.searchParams.get('projectKey');
      if (pk) return pk;
    } catch { /* not a URL */ }
    return process.env.JIRA_PROJECT_KEY ?? 'JIRA';
  }

  private issueToMessage(issue: JiraIssue): UnifiedMessage {
    // Bug #792 fix (2026-07-15): the Jira MCP server returns issues in a
    // FLATTENED snake_case shape (fields at top level: issue.summary,
    // issue.status, issue.created, issue.issue_type, issue.assignee.display_name)
    // — NOT the standard Jira REST `issue.fields.*` camelCase wrapper this code
    // was written for. Normalize both shapes into `f` so either source (MCP flat
    // or browser/REST nested) maps correctly. Before this, `issue.fields` was
    // undefined for every MCP issue → 0/N parsed (masked for weeks by the
    // crash→browser-fallback, now guarded).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyIssue = issue as any;
    const nested = anyIssue.fields; // standard REST shape
    const flat = nested ?? anyIssue; // MCP flat shape falls back to the issue itself
    const person = (p: any) =>
      p ? { name: p.displayName ?? p.display_name ?? p.name ?? 'Unknown', email: p.emailAddress ?? p.email } : null;
    const rep = person(flat.reporter);
    const asg = person(flat.assignee);
    const createdRaw = flat.created;
    const updatedRaw = flat.updated;
    const createdAt = createdRaw ? new Date(createdRaw) : new Date();
    const updatedAt = updatedRaw ? new Date(updatedRaw) : createdAt;
    return {
      id: issue.key,
      source: MessageSource.Jira,
      subject: `[${issue.key}] ${flat.summary ?? ''}`,
      content: flat.description ?? '',
      sender: {
        id: rep?.name ?? 'Unknown',
        name: rep?.name ?? 'Unknown',
        email: rep?.email,
      },
      createdAt,
      modifiedAt: updatedAt,
      isReply: false,
      metadata: {
        jira: {
          issueKey: issue.key,
          projectKey: flat.project?.key ?? issue.key.split('-')[0] ?? '',
          // MCP: issue_type.name; REST: issuetype.name
          issueType: flat.issue_type?.name ?? flat.issuetype?.name ?? undefined,
          labels: Array.isArray(flat.labels) ? flat.labels : [],
          status: flat.status?.name ?? undefined,
          priority: flat.priority?.name ?? undefined,
          assignee: asg
            ? { id: asg.name, name: asg.name, email: asg.email }
            : undefined,
          epicKey: flat.customfield_10014 ?? undefined,
        },
      },
      raw: issue,
    };
  }

  private commentToMessage(comment: JiraComment, issue: JiraIssue): UnifiedMessage {
    return {
      id: `${issue.key}-comment-${comment.id}`,
      source: MessageSource.Jira,
      subject: `Comment on ${issue.key}`,
      content: comment.body ?? '',
      sender: {
        id: comment.author?.displayName ?? 'Unknown',
        name: comment.author?.displayName ?? 'Unknown',
        email: comment.author?.emailAddress,
      },
      createdAt: new Date(comment.created ?? Date.now()),
      parentId: issue.key,
      isReply: true,
      metadata: {
        jira: {
          issueKey: issue.key,
          projectKey: issue.key.split('-')[0] ?? '',
        },
      },
      raw: comment,
    };
  }
}

// ---------------------------------------------------------------------------
// JiraAutoAdapter — try MCP, fall back to browser
// ---------------------------------------------------------------------------

class JiraAutoAdapter implements JiraDataSource {
  constructor(private readonly session: BrowserSessionManager) {}

  async fetchMessages(
    config: Record<string, unknown>,
    since?: Date
  ): Promise<UnifiedMessage[]> {
    try {
      const mcp = new JiraMcpAdapter();
      return await mcp.fetchMessages(config, since);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Fail-fast on AUTH-class MCP failures (bug #819). When the OAuth token
      // is missing/expired (`invalid_client`, 401, no stored token), the
      // browser fallback is pointless — the Playwright scraper needs the same
      // auth that just failed, so it hangs on the login wall until the
      // orchestrator's 90s timeout fires (that was #819: status=timed_out,
      // count=0, 90003ms). Skip the doomed fallback and surface an actionable
      // error in ~1s instead of a 90s silent hang. Non-auth failures (network
      // blip, MCP 5xx) still fall through to the browser — that IS worth a try.
      if (isAuthFailure(msg)) {
        process.stderr.write(
          `[jira-adapter] MCP auth failed — skipping browser fallback (would hit same login wall): ${msg}\n`,
        );
        try {
          const { getDatabase } = await import('../../db/connection.js');
          const { captureBug } = await import('../../routes/bugs.js');
          captureBug(getDatabase(), {
            source: 'sync',
            errorName: 'JiraMcpAuthFailure',
            message:
              `Jira MCP auth failed (token missing/expired) — run MCP setup for your configured Jira client: ${msg}`.slice(
                0,
                2000,
              ),
            stack: err instanceof Error ? (err.stack ?? undefined) : undefined,
            context: { adapter: 'JiraAutoAdapter', degradation: 'auth_fail_fast' },
          });
        } catch { /* capture is best-effort — never let it break the throw */ }
        throw new Error(
          `Jira MCP auth failed (token missing/expired). Run MCP setup for your configured Jira client — original: ${msg}`,
        );
      }

      process.stderr.write(`[jira-adapter] MCP failed, falling back to browser: ${msg}\n`);
      // Telemetry (2026-07-15): a caught-and-degraded exception like this MCP→
      // browser fallback used to be invisible to /bugs (global capture only
      // hooks uncaughtException + explicit captureBug). This IS a bug worth
      // reporting — the MCP path failing means a ~40min browser scrape instead
      // of a ~1s API call. Capture it (best-effort; capture must NEVER throw or
      // we'd sink the fallback that's keeping the fetch alive).
      try {
        const { getDatabase } = await import('../../db/connection.js');
        const { captureBug } = await import('../../routes/bugs.js');
        captureBug(getDatabase(), {
          source: 'sync',
          errorName: 'JiraMcpFallbackToBrowser',
          message: `Jira MCP fetch failed → degraded to browser scrape (~40min vs ~1s): ${msg}`.slice(0, 2000),
          stack: err instanceof Error ? err.stack ?? undefined : undefined,
          context: { adapter: 'JiraAutoAdapter', degradation: 'mcp_to_browser' },
        });
      } catch { /* capture is best-effort — never let it break the fallback */ }
      const browser = new JiraBrowserConnector(this.session);
      return browser.fetchMessages(config, since);
    }
  }
}

/**
 * Classify an MCP error message as auth-class (token missing/expired/401/
 * invalid_client) vs transient (network, 5xx). Auth failures make the browser
 * fallback pointless — it needs the same auth — so we fail fast instead of
 * hanging 90s on the login wall. Bug #819.
 * @returns true when the failure is an auth/token problem
 */
function isAuthFailure(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('invalid_client') ||
    m.includes('invalid_grant') ||
    m.includes('unauthorized') ||
    m.includes('401') ||
    m.includes('403') ||
    m.includes('no stored token') ||
    m.includes('token missing') ||
    m.includes('token expired') ||
    m.includes('authentication') ||
    m.includes('run mcp-setup')
  );
}

// Re-export for callers that need the DataSource-compatible type
export type { DataSource };
