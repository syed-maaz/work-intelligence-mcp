/**
 * GitHub REST API Connector
 *
 * Searches issues and pull requests on an internal GitHub instance
 * using the GitHub Search API. No Playwright — pure HTTP fetch.
 *
 * Config via environment variables:
 *   GITHUB_API_URL  — base URL, e.g. https://github.example.com/api/v3
 *   GITHUB_TOKEN    — personal access token
 *
 * Returns UnifiedMessage[] with source: MessageSource.GitHub.
 * Results are not persisted to the DB — fetched fresh per call.
 */

import { MessageSource, type UnifiedMessage } from './types.js';

// ---------------------------------------------------------------------------
// Public config type
// ---------------------------------------------------------------------------

export interface GitHubConfig {
  /** Base API URL, e.g. https://github.example.com/api/v3 */
  apiUrl: string;
  /** Personal access token */
  token: string;
}

// ---------------------------------------------------------------------------
// Internal GitHub API response shapes
// ---------------------------------------------------------------------------

interface GitHubSearchItem {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  pull_request?: { merged_at: string | null };
  user: { login: string };
  assignee?: { login: string } | null;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  repository_url: string;
}

interface GitHubSearchResponse {
  total_count: number;
  items: GitHubSearchItem[];
}

// ---------------------------------------------------------------------------
// Connector class
// ---------------------------------------------------------------------------

export class GitHubConnector {
  private apiUrl: string;
  private token: string;

  constructor(config: GitHubConfig) {
    // Normalize: strip trailing slash
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.token = config.token;
  }

  /**
   * Search GitHub issues and PRs matching the query.
   * Uses GET /search/issues?q={query}&sort=updated&order=desc
   *
   * @param query    Keywords to search (passed verbatim to GitHub q= param)
   * @param since    Optional — filter to items updated after this date
   * @param limit    Max results to return (default: 30)
   */
  async searchIssues(
    query: string,
    since?: Date,
    limit = 30
  ): Promise<UnifiedMessage[]> {
    // Build GitHub search query string
    // If since is provided, append updated:>YYYY-MM-DD
    const dateClause = since
      ? ` updated:>${since.toISOString().slice(0, 10)}`
      : '';
    const fullQuery = encodeURIComponent(`${query}${dateClause}`);
    const url = `${this.apiUrl}/search/issues?q=${fullQuery}&sort=updated&order=desc&per_page=${limit}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `token ${this.token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'work-intelligence-mcp/0.1.0',
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      process.stderr.write(
        `[GitHubConnector] Search failed: ${response.status} ${response.statusText} — ${text.slice(0, 200)}\n`
      );
      return [];
    }

    const data = (await response.json()) as GitHubSearchResponse;
    return data.items.map((item) => this.mapToUnifiedMessage(item));
  }

  private mapToUnifiedMessage(item: GitHubSearchItem): UnifiedMessage {
    const isPR = 'pull_request' in item;
    const isMerged = isPR && item.pull_request?.merged_at != null;
    const state: 'open' | 'closed' | 'merged' = isMerged
      ? 'merged'
      : item.state;

    // Extract repo name from repository_url
    // e.g. https://github.example.com/api/v3/repos/org/repo-name
    const repoMatch = item.repository_url.match(/\/repos\/(.+)$/);
    const repository = repoMatch?.[1] ?? 'unknown';

    const id = isPR
      ? `github-pr-${repository}-${item.number}`
      : `github-issue-${repository}-${item.number}`;

    const subject = isPR
      ? `PR #${item.number}: ${item.title}`
      : `Issue #${item.number}: ${item.title}`;

    return {
      id,
      source: MessageSource.GitHub,
      subject,
      content: item.body ?? '',
      sender: {
        id: item.user.login,
        name: item.user.login,
      },
      createdAt: new Date(item.created_at),
      modifiedAt: new Date(item.updated_at),
      isReply: false,
      metadata: {
        github: {
          number: item.number,
          state,
          isPR,
          url: item.html_url,
          labels: item.labels.map((l) => l.name),
          repository,
        },
      },
      raw: item,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a GitHubConnector from environment variables.
 * Returns null if GITHUB_API_URL or GITHUB_TOKEN are not set.
 * The caller should check for null and add a fetch note when absent.
 */
export function createGitHubConnector(): GitHubConnector | null {
  const apiUrl = process.env.GITHUB_API_URL;
  const token = process.env.GITHUB_TOKEN;
  if (!apiUrl || !token) {
    return null;
  }
  return new GitHubConnector({ apiUrl, token });
}
