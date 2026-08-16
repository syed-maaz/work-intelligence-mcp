import PQueue from 'p-queue';
import type Database from 'better-sqlite3';
import type { ExtractedLink } from './link-extractor.js';
import { extractMarkdownFromHtml } from './content-extractor.js';
import { getCachedContent, upsertWebCache } from '../db/queries/web-cache.js';
import { getGitHubEnterpriseHost } from './wi-config.js';

export interface FetchedLink extends ExtractedLink {
  content: string;
  strategy: 'jira-mcp' | 'github-mcp' | 'cache' | 'http' | 'failed';
  fetchedAt: string;
}

export interface LinkFetcherDeps {
  db: Database.Database;
  jiraMcpCallTool?: (toolName: string, args: Record<string, unknown>) => Promise<string>;
  githubMcpCallTool?: (toolName: string, args: Record<string, unknown>) => Promise<string>;
}

const FETCH_TIMEOUT = 15_000;

export class LinkFetcher {
  private queue: PQueue;
  private deps: LinkFetcherDeps;

  constructor(deps: LinkFetcherDeps) {
    this.deps = deps;
    this.queue = new PQueue({ concurrency: 2 });
  }

  async fetchAll(links: ExtractedLink[]): Promise<FetchedLink[]> {
    const results = await Promise.allSettled(
      links.map(link => this.queue.add(() => this.fetchOne(link)))
    );

    return results
      .filter((r): r is PromiseFulfilledResult<FetchedLink> => r.status === 'fulfilled' && r.value != null)
      .map(r => r.value);
  }

  private async fetchOne(link: ExtractedLink): Promise<FetchedLink> {
    const base = { ...link, fetchedAt: new Date().toISOString() };

    const cached = getCachedContent(this.deps.db, link.url);
    if (cached) {
      return { ...base, content: cached.content, strategy: 'cache' };
    }

    try {
      const content = await this.fetchByStrategy(link);
      if (content) {
        upsertWebCache(this.deps.db, link.url, content, link.type);
        return { ...base, content, strategy: this.getStrategy(link) };
      }
    } catch {
      // fall through to failed
    }

    return { ...base, content: '', strategy: 'failed' };
  }

  private async fetchByStrategy(link: ExtractedLink): Promise<string | null> {
    if (link.type === 'jira' && this.deps.jiraMcpCallTool) {
      return this.fetchViaJiraMcp(link.url);
    }
    if (link.type === 'github' && this.deps.githubMcpCallTool) {
      return this.fetchViaGithubMcp(link.url);
    }
    return this.fetchViaHttp(link.url);
  }

  private getStrategy(link: ExtractedLink): FetchedLink['strategy'] {
    if (link.type === 'jira' && this.deps.jiraMcpCallTool) return 'jira-mcp';
    if (link.type === 'github' && this.deps.githubMcpCallTool) return 'github-mcp';
    return 'http';
  }

  private async fetchViaJiraMcp(url: string): Promise<string | null> {
    const match = url.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
    if (!match) return this.fetchViaHttp(url);

    const issueKey = match[1];
    try {
      const result = await this.deps.jiraMcpCallTool!('jira_get_issue', {
        issue_key: issueKey,
        fields: 'summary,description,status,priority,assignee',
        comment_limit: 5,
      });
      const parsed = JSON.parse(result);
      const fields = parsed.fields || parsed;
      const parts = [
        `# ${fields.summary || issueKey}`,
        `Status: ${fields.status?.name || 'Unknown'}`,
        fields.description || '',
      ];
      return parts.join('\n\n');
    } catch {
      return this.fetchViaHttp(url);
    }
  }

  private async fetchViaGithubMcp(url: string): Promise<string | null> {
    const host = getGitHubEnterpriseHost();
    const hostAlts = host ? `${host.replace(/\./g, '\\.')}|github\\.com` : 'github\\.com';
    const prRe = new RegExp(`(?:${hostAlts})\\/([^/]+)\\/([^/]+)\\/pull\\/(\\d+)`);
    const prMatch = url.match(prRe);
    if (prMatch && this.deps.githubMcpCallTool) {
      try {
        const result = await this.deps.githubMcpCallTool('pull_request_read', {
          method: 'get',
          owner: prMatch[1],
          repo: prMatch[2],
          pullNumber: parseInt(prMatch[3]),
        });
        const parsed = JSON.parse(result);
        return `# PR: ${parsed.title}\n\n${parsed.body || ''}\n\nState: ${parsed.state}`;
      } catch {
        return this.fetchViaHttp(url);
      }
    }

    const issueRe = new RegExp(`(?:${hostAlts})\\/([^/]+)\\/([^/]+)\\/issues\\/(\\d+)`);
    const issueMatch = url.match(issueRe);
    if (issueMatch && this.deps.githubMcpCallTool) {
      try {
        const result = await this.deps.githubMcpCallTool('issue_read', {
          method: 'get',
          owner: issueMatch[1],
          repo: issueMatch[2],
          issue_number: parseInt(issueMatch[3]),
        });
        const parsed = JSON.parse(result);
        return `# Issue: ${parsed.title}\n\n${parsed.body || ''}\n\nState: ${parsed.state}`;
      } catch {
        return this.fetchViaHttp(url);
      }
    }

    return this.fetchViaHttp(url);
  }

  private async fetchViaHttp(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'WorkIntelligence/1.0' },
        redirect: 'follow',
      });

      if (!response.ok) return null;

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/json')) {
        return null;
      }

      const html = await response.text();

      if (contentType.includes('application/json')) {
        return JSON.stringify(JSON.parse(html), null, 2).slice(0, 3000);
      }

      return extractMarkdownFromHtml(html, url);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
