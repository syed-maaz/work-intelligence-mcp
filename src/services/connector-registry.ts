/**
 * ADR-044 S2.5/S3 — Connector registry.
 *
 * The missing piece that connects wi.config.json connectors to the managed
 * Fetcher facade:
 *   - Reads enabled connectors from wi.config.json via the `enabled` flag
 *     (registry discovery = "enabled-flags", declared in capabilities.json).
 *   - Exposes per-connector capabilities from the root capabilities.json
 *     manifest (loaded once, cached).
 *   - Builds orchestrator SourceSpecs (src/fetcher/orchestrator.ts, slice S2)
 *     for each enabled connector, using the existing source adapters in
 *     src/fetcher/sources/.
 *   - Implements the full ADR-044 Fetcher facade (fetch / fetchStream / syncAll)
 *     by delegating to the orchestrator (wireFetcher). Replaces the old
 *     NOT_WIRED stubs in src/fetcher/index.ts.
 *
 * Safety contract: NEVER crashes for a missing config, a missing adapter, or a
 * bad per-connector setup. Every getWiConfig() call-site is try/catch guarded
 * and every builder emits a console.warn + skip. Connectors with no wired
 * adapter are skipped gracefully until another slice lands one.
 *
 * Source mapping (wi.config connector name → orchestrator FetchSource):
 *   jira    → 'jira'    (jira-adapter: JiraMcpAdapter / JiraBrowserConnector)
 *   github  → 'github'  (github.ts REST API, github-mcp MCP path)
 *   outlook → 'email'   (OutlookBrowserConnector emits MessageSource.Email)
 *   teams   → 'teams'   (teams-chats + teams-meetings browser scrapers)
 *   slack   → 'slack'   (slack.ts Web API adapter)
 *   linear  → 'linear'  (linear.ts GraphQL adapter)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { Fetcher } from '../fetcher/index.js';
import type { FetchOpts, FetchProgress, FetchSource, SyncOpts } from '../fetcher/types.js';
import type { UnifiedMessage } from '../fetcher/sources/types.js';
import { MessageSource } from '../fetcher/sources/types.js';
import {
  fetchOneSource,
  fetchStream as orchestratorFetchStream,
  localSpec,
} from '../fetcher/orchestrator.js';
import type { SourceSpec } from '../fetcher/orchestrator.js';
import { getBrowserSession } from '../fetcher/sources/browser-session.js';
import type { BrowserSessionManager } from '../fetcher/sources/browser-session.js';
import { createJiraDataSource, JiraMcpAdapter } from '../fetcher/sources/jira-adapter.js';
import type { JiraDataSource } from '../fetcher/sources/jira-adapter.js';
import { GitHubConnector } from '../fetcher/sources/github.js';
import { GitHubMcpClient, splitGithubSlug } from '../fetcher/sources/github-mcp-client.js';
import type { GithubPRMcp } from '../fetcher/sources/github-mcp-client.js';
import { OutlookBrowserConnector } from '../fetcher/sources/outlook-browser.js';
import { TeamsChatScraper } from '../fetcher/sources/teams-chats.js';
import type { ScrapedChat } from '../fetcher/sources/teams-chats.js';
import { TeamsMeetingsScraper } from '../fetcher/sources/teams-meetings.js';
import { fetchSlackMessages } from '../fetcher/sources/slack.js';
import { fetchLinearIssues } from '../fetcher/sources/linear.js';
import { getGitHubApiBaseUrl, getGitHubApiToken, getRepos, getWiConfig } from './wi-config.js';
import { ADAPTERS } from '../fetcher/sources/adapter.js';
import type { AdapterContext } from '../fetcher/sources/adapter.js';

// STEP 11 — the ADAPTERS array is the registry's single dispatch table.
export { ADAPTERS };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Per-source wall-clock cap for the orchestrator (90s). */
const DEFAULT_TIMEOUT_MS = 90_000;

/** Root-level capabilities manifest (dist/services/.. / src/services/.. both = repo root). */
const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'capabilities.json');

// ---------------------------------------------------------------------------
// capabilities.json types + loading
// ---------------------------------------------------------------------------

export interface ConnectorCapabilityManifest {
  displayName: string;
  modes: string[];
  capabilities: string[];
  config: {
    enabled?: string;
    mode?: string;
    requiredEnv: string[];
  };
  dataIngested: string[];
}

export interface CapabilitiesManifest {
  version: string;
  registry: { loadsFrom: string; discovery: string };
  connectors: Record<string, ConnectorCapabilityManifest>;
}

const EMPTY_MANIFEST: CapabilitiesManifest = {
  version: '1.0',
  registry: { loadsFrom: 'wi.config.json', discovery: 'enabled-flags' },
  connectors: {},
};

let manifestCache: CapabilitiesManifest | null = null;

/** Load capabilities.json once and cache. Never throws — falls back to empty. */
export function getCapabilitiesManifest(): CapabilitiesManifest {
  if (manifestCache) return manifestCache;
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    manifestCache = JSON.parse(raw) as CapabilitiesManifest;
  } catch (err) {
    console.warn(
      `[registry] capabilities.json unreadable at ${MANIFEST_PATH} — empty manifest: ${err instanceof Error ? err.message : String(err)}`,
    );
    manifestCache = EMPTY_MANIFEST;
  }
  return manifestCache;
}

// ---------------------------------------------------------------------------
// wi.config.json safe access (all getConfig calls guarded)
// ---------------------------------------------------------------------------

type SafeConnectorConfig = { enabled?: boolean; mode?: string };

/** Never throws — missing/unparsable wi.config.json yields {}. */
function getConnectorsSafe(): Record<string, SafeConnectorConfig> {
  try {
    const cfg = getWiConfig();
    return (cfg?.connectors ?? {}) as unknown as Record<string, SafeConnectorConfig>;
  } catch (err) {
    console.warn(`[registry] wi.config.json unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function connectorMode(name: string, fallback: string): string {
  return getConnectorsSafe()[name]?.mode ?? fallback;
}

// ---------------------------------------------------------------------------
// Public registry API
// ---------------------------------------------------------------------------

/**
 * Enabled connectors from wi.config.json (enabled === true), in declaration
 * order. Safe on missing config (returns []).
 */
export function getEnabledConnectors(): string[] {
  const connectors = getConnectorsSafe();
  return Object.keys(connectors).filter((name) => connectors[name]?.enabled === true);
}

/**
 * Capabilities for a connector from the manifest, or null if not declared.
 * @returns e.g. ["prs", "issues", "commits", "search"] for github
 */
export function getConnectorCapabilities(name: string): string[] | null {
  return getCapabilitiesManifest().connectors?.[name]?.capabilities ?? null;
}

export interface ConnectorStatus {
  enabled: boolean;
  mode: string | null;
  hasRequiredEnv: boolean;
}

/**
 * Per-connector status for every connector in the manifest:
 * { enabled, mode, hasRequiredEnv } — used by the /api/connectors surface.
 */
export function getConnectorStatuses(): Record<string, ConnectorStatus> {
  const connectors = getConnectorsSafe();
  const manifest = getCapabilitiesManifest();
  const out: Record<string, ConnectorStatus> = {};
  for (const name of Object.keys(manifest.connectors)) {
    const requiredEnv = manifest.connectors[name].config.requiredEnv ?? [];
    out[name] = {
      enabled: connectors[name]?.enabled === true,
      mode: connectors[name]?.mode ?? null,
      hasRequiredEnv: requiredEnv.every((env) => !!process.env[env]),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// SourceSpec builders (enabled connectors → orchestrator SourceSpecs)
// ---------------------------------------------------------------------------

export interface BuildSpecOpts {
  since?: Date;
  timeoutMs?: number;
}

/**
 * Build orchestrator SourceSpecs for all enabled connectors. Never throws:
 * each connector wires inside its own try/catch and is skipped (with a warn)
 * on any failure.
 *
 * STEP 11 (OSS release): dispatch goes through the ADAPTERS array — there is
 * no switch to edit when a connector is added. Each adapter wraps the real
 * source-spec builder (src/fetcher/sources/adapter.ts).
 */
export function buildSourceSpecs(db: Database.Database, opts?: BuildSpecOpts): SourceSpec[] {
  const specs: SourceSpec[] = [];
  const ctx: AdapterContext = { db, since: opts?.since, config: null };
  for (const name of getEnabledConnectors()) {
    const a = ADAPTERS.find((x) => x.name === name);
    if (!a) {
      console.warn(`no adapter for ${name}, skipping`);
      continue;
    }
    try {
      specs.push(...a.buildSourceSpecs(ctx));
    } catch (err) {
      console.warn(`adapter ${name} failed`, err);
    }
  }
  if (opts?.timeoutMs) {
    for (const spec of specs) spec.timeoutMs = opts.timeoutMs;
  }
  return specs;
}

/** Shared browser singleton; null when BROWSER_PROFILE_PATH is unset. */
function resolveBrowserSession(): BrowserSessionManager | null {
  try {
    return getBrowserSession();
  } catch (err) {
    console.warn(
      `[registry] BROWSER_PROFILE_PATH not configured — browser connectors skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export function jiraSourceSpecs(since?: Date): SourceSpec[] {
  // Mode resolution: wi.config.json connectors.jira.mode wins; otherwise the
  // legacy JIRA_SOURCE env var (mcp | browser | auto); default mcp.
  const mode = connectorMode('jira', process.env.JIRA_SOURCE ?? 'mcp');
  const useBrowser = mode === 'browser' || mode === 'both' || mode === 'auto';
  const session = useBrowser ? resolveBrowserSession() : null;
  if ((mode === 'browser' || mode === 'both') && !session) {
    console.warn('[registry] connector jira asked for browser mode but BROWSER_PROFILE_PATH missing — skipping');
    return [];
  }

  const dataSource: JiraDataSource =
    session
      ? createJiraDataSource(session, mode as 'mcp' | 'browser' | 'auto')
      : new JiraMcpAdapter(); // auto/browser without a session → MCP only

  const config: Record<string, unknown> = {
    boardUrl: process.env.JIRA_BOARD_URL ?? '',
    projectKey: process.env.JIRA_PROJECT_KEY ?? undefined,
  };

  return [
    {
      source: 'jira',
      fetch: (_signal: AbortSignal) => dataSource.fetchMessages(config, since),
      release:
        useBrowser && session
          ? async () => {
              try { await session.releaseBySource('jira'); } catch { /* best-effort */ }
            }
          : undefined,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ];
}

export function githubSourceSpecs(db: Database.Database, since?: Date): SourceSpec[] {
  const mode = connectorMode('github', 'api');
  const wantApi = mode === 'api' || mode === 'both';
  const wantMcp = mode === 'mcp' || mode === 'both';
  const specs: SourceSpec[] = [];

  if (wantApi) {
    try {
      const connector = new GitHubConnector({
        apiUrl: getGitHubApiBaseUrl(),
        token: getGitHubApiToken(),
      });
      const query = buildGitHubQuery();
      specs.push({
        source: 'github',
        fetch: (_signal: AbortSignal) => connector.searchIssues(query, since, 30),
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      console.warn(`[registry] github API path unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (wantMcp) {
    try {
      const mcp = new GitHubMcpClient(db);
      specs.push({
        source: 'github',
        fetch: async (_signal: AbortSignal) => fetchOpenMcpPRs(mcp),
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      console.warn(`[registry] github MCP path unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return specs;
}

/** GitHub search query: configured repos, else the caller's open items. */
function buildGitHubQuery(): string {
  const repos = getReposSafe().filter((r) => r.githubSlug);
  if (repos.length > 0) return repos.map((r) => `repo:${r.githubSlug}`).join(' OR ');
  return 'is:open assignee:@me';
}

function getReposSafe(): Array<{ name: string; githubSlug?: string }> {
  try {
    return getRepos();
  } catch {
    return [];
  }
}

/** GitHub MCP path: open PRs across the configured repos, normalised. */
async function fetchOpenMcpPRs(mcp: GitHubMcpClient): Promise<UnifiedMessage[]> {
  const repos = getReposSafe().filter((r) => r.githubSlug);
  if (repos.length === 0) return [];
  const messages: UnifiedMessage[] = [];
  for (const repo of repos) {
    const slug = repo.githubSlug ?? '';
    const { owner, repo: name } = splitGithubSlug(slug);
    const prs = await mcp.listPRs(owner, name, 'open');
    for (const pr of prs) messages.push(prToUnifiedMessage(pr, slug));
  }
  return messages;
}

function prToUnifiedMessage(pr: GithubPRMcp, slug: string): UnifiedMessage {
  const state: 'open' | 'closed' | 'merged' =
    pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
  return {
    id: `github-pr-${slug}-${pr.number}`,
    source: MessageSource.GitHub,
    subject: `PR #${pr.number}: ${pr.title}`,
    content: pr.body ?? '',
    sender: { id: pr.user?.login ?? 'unknown', name: pr.user?.login ?? 'unknown' },
    createdAt: new Date(pr.created_at),
    modifiedAt: new Date(pr.updated_at),
    isReply: false,
    metadata: {
      github: { number: pr.number, state, isPR: true, url: pr.html_url, labels: [], repository: slug },
    },
    raw: pr,
  };
}

export function outlookSourceSpecs(since?: Date): SourceSpec[] {
  const mode = connectorMode('outlook', 'browser');
  if (mode !== 'browser') {
    console.warn(`[registry] connector outlook mode "${mode}" not implemented yet — skipping`);
    return [];
  }
  const session = resolveBrowserSession();
  if (!session) return [];

  const connector = new OutlookBrowserConnector(session);
  return [
    {
      source: 'email',
      fetch: (signal: AbortSignal) => connector.fetchMessages({ folder: 'inbox' }, since, signal),
      release: async () => {
        try {
          await session.releaseBySource('email');
        } catch { /* best-effort */ }
      },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ];
}

export function teamsSourceSpecs(db: Database.Database, since?: Date): SourceSpec[] {
  const mode = connectorMode('teams', 'browser');
  if (mode !== 'browser') {
    console.warn(`[registry] connector teams mode "${mode}" not implemented yet — skipping`);
    return [];
  }
  const session = resolveBrowserSession();
  if (!session) return [];

  const chatScraper = new TeamsChatScraper(session);
  const meetingScraper = new TeamsMeetingsScraper(session, process.env.ANTHROPIC_API_KEY, db);
  return [
    {
      source: 'teams',
      fetch: async (_signal: AbortSignal) => {
        const chats = await chatScraper.scrapeChats({
          unreadOnly: false,
          sinceDays: sinceDays(since),
          maxChats: 50,
          meetingScraper,
        });
        return chatsToUnifiedMessages(chats);
      },
      release: async () => {
        try {
          await session.releaseBySource('teams');
        } catch { /* best-effort */ }
      },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ];
}

function chatsToUnifiedMessages(chats: ScrapedChat[]): UnifiedMessage[] {
  const out: UnifiedMessage[] = [];
  for (const chat of chats) {
    for (const m of chat.messages) {
      out.push({
        id: m.sourceId,
        source: MessageSource.Teams,
        subject: `[Teams] ${chat.name}`,
        content: m.bodyText,
        sender: { id: m.senderName, name: m.senderName },
        createdAt: m.createdAt,
        isReply: false,
        metadata: { teams: { teamId: '', channelId: chat.name, channelName: chat.name } },
        raw: m,
      });
    }
  }
  return out;
}

function sinceDays(since?: Date): number {
  if (!since) return 7;
  return Math.max(1, Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000)));
}

export function slackSourceSpecs(): SourceSpec[] {
  const mode = connectorMode('slack', 'api');
  if (mode !== 'api') {
    console.warn(`[registry] connector slack mode "${mode}" not implemented yet — skipping`);
    return [];
  }
  if (!process.env.SLACK_TOKEN) {
    console.warn('[registry] connector slack enabled but SLACK_TOKEN not set — skipping');
    return [];
  }
  return [
    {
      source: 'slack',
      fetch: async (_signal: AbortSignal) => fetchSlackMessages({ limit: 50 }),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ];
}

export function linearSourceSpecs(): SourceSpec[] {
  const mode = connectorMode('linear', 'api');
  if (mode !== 'api') {
    console.warn(`[registry] connector linear mode "${mode}" not implemented yet — skipping`);
    return [];
  }
  if (!process.env.LINEAR_API_KEY) {
    console.warn('[registry] connector linear enabled but LINEAR_API_KEY not set — skipping');
    return [];
  }
  return [
    {
      source: 'linear',
      fetch: async (_signal: AbortSignal) => fetchLinearIssues({ limit: 50 }),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ];
}

// ---------------------------------------------------------------------------
// ADR-044 facade — full wire-up
// ---------------------------------------------------------------------------

/**
 * Orchestrator specs for a facade call: the requested sources (all enabled when
 * none), plus a `local` grounding spec when a query or 'local' is requested.
 */
function specsForCall(
  db: Database.Database,
  sources: FetchSource[] | undefined,
  opts?: FetchOpts,
): SourceSpec[] {
  let specs = buildSourceSpecs(db, { since: opts?.since, timeoutMs: opts?.timeoutMs });
  if (sources && sources.length > 0) {
    specs = specs.filter((s) => sources.includes(s.source));
  }
  const wantLocal = (opts?.query != null && opts.query.length > 0) || (sources ?? []).includes('local');
  if (wantLocal && !specs.some((s) => s.source === 'local')) {
    specs.unshift(localSpec(db, opts?.query, 50, 5_000));
  }
  return specs;
}

/**
 * Build the full ADR-044 Fetcher facade bound to a DB handle. Delegates to the
 * orchestrator with registry-built SourceSpecs. Replaces the NOT_WIRED stubs
 * in createFetcher() (src/fetcher/index.ts).
 */
export function wireFetcher(db: Database.Database): Fetcher {
  return {
    async fetch(source: FetchSource, opts?: FetchOpts): Promise<UnifiedMessage[]> {
      if (source === 'local') return [];
      const specs = buildSourceSpecs(db, { since: opts?.since, timeoutMs: opts?.timeoutMs }).filter(
        (s) => s.source === source,
      );
      const messages: UnifiedMessage[] = [];
      for (const spec of specs) {
        const { messages: batch } = await fetchOneSource(spec);
        messages.push(...batch);
      }
      return messages;
    },

    async *fetchStream(sources: FetchSource[], opts?: FetchOpts): AsyncIterable<FetchProgress> {
      yield* orchestratorFetchStream(db, specsForCall(db, sources, opts));
    },

    async *syncAll(opts?: SyncOpts): AsyncIterable<FetchProgress> {
      yield* orchestratorFetchStream(db, specsForCall(db, opts?.sources, opts));
    },
  };
}