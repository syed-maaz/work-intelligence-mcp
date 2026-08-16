/**
 * Phase 71-02 — Jira verifier adapter.
 *
 * Verifies a claim about a Jira issue's state by calling the configured Jira MCP
 * server's `jira_get_issue` tool. Reuses the existing OAuth token store
 * (`mcp_oauth_tokens`) — no env-var leakage.
 *
 * Inputs:
 *   - `issueKey`: e.g. `JIRA-15257`.
 *   - `expectedField`: dotted path into the JSON response, e.g.
 *     `fields.status.name` or `fields.assignee.name`.
 *   - `expectedValue` (optional): exact value to compare against.
 *
 * Owns its own circuit breaker (3 fails → 30s open) — independent from the
 * github and code-grep adapters (T-71-01 mitigation).
 */

import type Database from 'better-sqlite3';
import { McpClient } from '../../../fetcher/sources/mcp-oauth-client.js';
import { getJiraMcpClientName, getJiraMcpUrl } from '../../wi-config.js';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  type VerifierResult,
} from './circuit-breaker.js';

export interface JiraVerifierInput {
  issueKey: string;
  expectedField: string;
  expectedValue?: unknown;
}

const breaker = new CircuitBreaker('jira');

const JIRA_MCP_URL = (() => {
  try { return getJiraMcpUrl(); } catch { /* fall through */ }
  return process.env.JIRA_MCP_URL ?? 'https://mcp.jira.example.com/mcp';
})();

const JIRA_MCP_CLIENT_NAME = (() => {
  try { return getJiraMcpClientName(); } catch { return 'jira'; }
})();

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

export async function verifyJira(
  db: Database.Database,
  input: JiraVerifierInput,
): Promise<VerifierResult> {
  try {
    return await breaker.run(async () => {
      const client = new McpClient(db, JIRA_MCP_CLIENT_NAME, JIRA_MCP_URL);
      const raw = await client.callTool('jira_get_issue', { issue_key: input.issueKey });
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
      const evidence = `jira ${input.issueKey} → ${input.expectedField}=${JSON.stringify(value)}`;
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
        evidence: `jira verifier circuit open (retry ${new Date(err.retryAt).toISOString()})`,
        confidence: 0,
      };
    }
    return {
      verified: false,
      evidence: `jira verifier error: ${err instanceof Error ? err.message : String(err)}`,
      confidence: 0,
    };
  }
}

/** Test hook — exposes the breaker so tests can assert state without spying. */
export const __jiraBreaker = breaker;
