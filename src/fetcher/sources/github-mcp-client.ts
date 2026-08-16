/**
 * GitHub MCP Client (EP-44 extension)
 *
 * Wraps McpClient for the github-tools MCP server which uses a static PAT
 * Bearer token (not OAuth DCR). Reads credentials from ~/.claude.json project
 * config, falling back to GITHUB_MCP_TOKEN env var.
 *
 * Exposes typed methods for PR operations used by web-server.js PR endpoints.
 *
 * ## Setup
 * No setup script needed — github-tools uses a static PAT already configured
 * in ~/.claude.json. As long as that PAT is valid, this client works immediately.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { McpClient } from './mcp-oauth-client.js';
import { getGitHubMcpUrl } from '../../services/wi-config.js';

const GITHUB_MCP_URL = (() => {
  try { return getGitHubMcpUrl(); } catch { /* fall through */ }
  return process.env.GITHUB_MCP_URL ?? 'https://mcp.github.example.com/mcp';
})();

// ---------------------------------------------------------------------------
// Config reader
// ---------------------------------------------------------------------------

interface GitHubMcpConfig {
  url: string;
  headers: Record<string, string>;
}

function readGitHubMcpConfig(): GitHubMcpConfig {
  try {
    const claudeJson = JSON.parse(
      readFileSync(join(process.env.HOME ?? '~', '.claude.json'), 'utf8')
    ) as Record<string, unknown>;

    const projects = claudeJson.projects as Record<string, { mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }> }> | undefined;
    const proj = projects?.[process.cwd()];
    const ghConfig = proj?.mcpServers?.['github-tools'];

    if (ghConfig?.headers?.Authorization) {
      return {
        url: ghConfig.url ?? GITHUB_MCP_URL,
        headers: ghConfig.headers,
      };
    }
  } catch {
    // fall through to env var fallback
  }

  // Fallback: GITHUB_MCP_TOKEN env var
  const token = process.env.GITHUB_MCP_TOKEN;
  if (token) {
    return {
      url: GITHUB_MCP_URL,
      headers: { Authorization: `Bearer ${token}` },
    };
  }

  throw new Error(
    'github-tools MCP not configured. Set GITHUB_MCP_TOKEN env var or configure github-tools in ~/.claude.json'
  );
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface GithubPRMcp {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string };
  base: { ref: string };
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  updated_at: string;
}

export interface GithubPRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

// ---------------------------------------------------------------------------
// GitHubMcpClient
// ---------------------------------------------------------------------------

export class GitHubMcpClient {
  private readonly client: McpClient;

  constructor(db: Database.Database) {
    const config = readGitHubMcpConfig();
    this.client = new McpClient(db, 'github-tools', config.url, config.headers);
  }

  /**
   * List pull requests for a repo.
   * owner/repo come from splitting ConfigManager's githubSlug on '/'.
   */
  async listPRs(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open'
  ): Promise<GithubPRMcp[]> {
    const raw = await this.client.callTool('list_pull_requests', { owner, repo, state });
    const parsed = JSON.parse(raw) as GithubPRMcp[] | { items?: GithubPRMcp[] };
    return Array.isArray(parsed) ? parsed : (parsed.items ?? []);
  }

  /**
   * Get PR metadata and diff for a specific PR number.
   * Uses pull_request_read with method='get' for metadata and method='get_diff' for diff.
   */
  async getPRDetail(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<{ meta: GithubPRMcp; diff: string; files: GithubPRFile[] }> {
    const [metaRaw, diffRaw, filesRaw] = await Promise.all([
      this.client.callTool('pull_request_read', { method: 'get', owner, repo, pullNumber }),
      this.client.callTool('pull_request_read', { method: 'get_diff', owner, repo, pullNumber }).catch(() => ''),
      this.client.callTool('pull_request_read', { method: 'get_files', owner, repo, pullNumber }).catch(() => '[]'),
    ]);

    const meta = JSON.parse(metaRaw) as GithubPRMcp;
    const files = (() => {
      try { return JSON.parse(filesRaw) as GithubPRFile[]; } catch { return []; }
    })();

    return { meta, diff: diffRaw, files };
  }

  /**
   * Post an AI-generated review as a GitHub PR comment.
   * Uses pull_request_review_write with method='create' and event='COMMENT'.
   */
  async postReview(
    owner: string,
    repo: string,
    pullNumber: number,
    body: string
  ): Promise<{ url: string }> {
    const raw = await this.client.callTool('pull_request_review_write', {
      method: 'create',
      event: 'COMMENT',
      owner,
      repo,
      pullNumber,
      body,
    });

    try {
      const parsed = JSON.parse(raw) as { html_url?: string; url?: string };
      return { url: parsed.html_url ?? parsed.url ?? '' };
    } catch {
      return { url: '' };
    }
  }
}

/**
 * Split a githubSlug ("owner/repo") into { owner, repo }.
 * Throws if the slug doesn't contain a '/'.
 */
export function splitGithubSlug(slug: string): { owner: string; repo: string } {
  const idx = slug.indexOf('/');
  if (idx === -1) throw new Error(`Invalid githubSlug "${slug}" — expected "owner/repo" format`);
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}
