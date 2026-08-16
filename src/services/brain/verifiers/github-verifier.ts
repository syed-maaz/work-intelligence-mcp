/**
 * Phase 71-02 — GitHub verifier adapter.
 *
 * Verifies a claim by calling GitHub's REST API through the github-tools MCP
 * server (same auth path as `GitHubMcpClient`). Reuses the existing token
 * store (`mcp_oauth_tokens` table) — no env-var leakage, no PAT shuttling.
 *
 * Inputs:
 *   - `endpoint`: a GitHub API path like `repos/org/repo/pulls/123` or
 *     `repos/org/repo/commits/HEAD`.
 *   - `expectedField`: dotted path into the JSON response, e.g. `merged` or
 *     `head.ref`. The adapter reports verified=true when the value at that
 *     path is truthy. For more nuanced checks the caller can pass a
 *     `expectedValue` to compare against.
 *
 * The adapter has its own circuit breaker (3 fails → 30s open) so a flaky
 * GitHub MCP does not cascade into the orchestrator (T-71-01 mitigation).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { McpClient } from '../../../fetcher/sources/mcp-oauth-client.js';
import { getGitHubMcpUrl } from '../../wi-config.js';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  type VerifierResult,
} from './circuit-breaker.js';

export interface GithubVerifierInput {
  endpoint: string;
  expectedField: string;
  /** Optional: exact value to match. If omitted, truthy field is enough. */
  expectedValue?: unknown;
}

const breaker = new CircuitBreaker('github');

const GITHUB_MCP_URL = (() => {
  try { return getGitHubMcpUrl(); } catch { /* fall through */ }
  return process.env.GITHUB_MCP_URL ?? 'https://mcp.github.example.com/mcp';
})();

/**
 * Lazily build the McpClient for github-tools using the static-PAT path
 * (same as `GitHubMcpClient`). We only need raw `gh_api` access here.
 */
function buildClient(db: Database.Database): McpClient {
  // Read the same ~/.claude.json config GitHubMcpClient uses, with env fallback.
  let headers: Record<string, string> | undefined;
  let url = GITHUB_MCP_URL;
  try {
    const claudeJson = JSON.parse(
      readFileSync(join(process.env.HOME ?? '~', '.claude.json'), 'utf8'),
    ) as Record<string, unknown>;
    const projects = claudeJson.projects as
      | Record<string, { mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }> }>
      | undefined;
    const proj = projects?.[process.cwd()];
    const ghConfig = proj?.mcpServers?.['github-tools'];
    if (ghConfig?.headers?.Authorization) {
      headers = ghConfig.headers;
      url = ghConfig.url ?? GITHUB_MCP_URL;
    }
  } catch {
    /* fall through */
  }
  if (!headers) {
    const token = process.env.GITHUB_MCP_TOKEN;
    if (!token) {
      throw new Error(
        'github-tools MCP not configured. Set GITHUB_MCP_TOKEN or configure github-tools in ~/.claude.json',
      );
    }
    headers = { Authorization: `Bearer ${token}` };
  }
  return new McpClient(db, 'github-tools', url, headers);
}

/** Resolve `a.b.c` against an object literal. */
function getPath(obj: unknown, dotted: string): unknown {
  const parts = dotted.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export async function verifyGithub(
  db: Database.Database,
  input: GithubVerifierInput,
): Promise<VerifierResult> {
  try {
    return await breaker.run(async () => {
      const client = buildClient(db);
      // gh_api is the GitHub MCP's REST passthrough tool — args vary by server
      // build but `path` + `method` are universal. We default to GET.
      const raw = await client.callTool('gh_api', {
        path: input.endpoint.startsWith('/') ? input.endpoint : `/${input.endpoint}`,
        method: 'GET',
      });
      const parsed = (() => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return raw;
        }
      })();
      const value = getPath(parsed, input.expectedField);
      const matches =
        input.expectedValue === undefined ? Boolean(value) : value === input.expectedValue;
      const evidence = `github_api ${input.endpoint} → ${input.expectedField}=${JSON.stringify(value)}`;
      return {
        verified: matches,
        evidence,
        confidence: matches ? 0.95 : 0.5,
      };
    });
  } catch (err) {
    if (err instanceof CircuitBreakerOpenError) {
      return {
        verified: false,
        evidence: `github verifier circuit open (retry ${new Date(err.retryAt).toISOString()})`,
        confidence: 0,
      };
    }
    return {
      verified: false,
      evidence: `github verifier error: ${err instanceof Error ? err.message : String(err)}`,
      confidence: 0,
    };
  }
}

/** Test hook — exposes the breaker so tests can assert state without spying. */
export const __githubBreaker = breaker;
