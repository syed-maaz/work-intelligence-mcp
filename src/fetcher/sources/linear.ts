/**
 * Linear API Connector
 *
 * Pulls recent issues via the Linear GraphQL API (https://api.linear.app/graphql).
 * No SDK — pure fetch, matching the GitHub connector pattern.
 *
 * Config via options or environment variables:
 *   LINEAR_API_KEY — Linear API key (sent as the Authorization header)
 *
 * Returns UnifiedMessage[] with source: MessageSource.Linear. Result ids are
 * Linear `identifier`s (e.g. ENG-123), so the orchestrator's dedup path
 * (source_id) stays stable across sync cycles.
 *
 * Fetch failures never throw — warn + return []. A missing key throws.
 */

import { MessageSource, type UnifiedMessage } from './types.js';

// ---------------------------------------------------------------------------
// Public options / response shapes
// ---------------------------------------------------------------------------

export interface LinearFetchOptions {
  /** API key — falls back to LINEAR_API_KEY. */
  apiKey?: string;
  /** Limit to a single team by id — falls back to no filter. */
  teamId?: string;
  /** Max issues to fetch (default: 50). */
  limit?: number;
}

export interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  updatedAt: string;
  state: { name: string } | null;
  team: { name: string } | null;
  assignee: { name: string } | null;
}

interface LinearResponse {
  data?: {
    issues: { nodes?: LinearIssueNode[] };
  };
  errors?: Array<{ message?: string }>;
}

const LINEAR_API_URL = 'https://api.linear.app/graphql';
const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * POST a GraphQL query with a bounded AbortController. Throws on
 * network/timeout/non-ok responses; the caller isolates via try/catch.
 */
async function linearGraphql(
  apiKey: string,
  body: {
    query: string;
    variables: Record<string, unknown>;
  },
): Promise<LinearResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Linear GraphQL: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as LinearResponse;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fetch recent Linear issues as UnifiedMessage[].
 *
 * Resolution order: opts.apiKey → process.env.LINEAR_API_KEY.
 * Throws a clear error when no key is configured. Fetch/timeout failures are
 * swallowed — warn + return [] (connector isolation pattern).
 */
export async function fetchLinearIssues(
  opts: LinearFetchOptions = {},
): Promise<UnifiedMessage[]> {
  const apiKey = opts.apiKey ?? process.env.LINEAR_API_KEY;
  const limit = opts.limit ?? 50;

  if (!apiKey) {
    throw new Error('LINEAR_API_KEY not set');
  }

  const teamFilter = opts.teamId
    ? `, filter: { team: { id: { eq: $teamId } } }`
    : '';
  const query = `query IssuesQuery($first: Int!, $teamId: String) {
    issues(first: $first${teamFilter}) {
      nodes { id identifier title description updatedAt state { name } team { name } assignee { name } }
    }
  }`;
  const variables: Record<string, unknown> = { first: limit };
  if (opts.teamId) variables.teamId = opts.teamId;

  try {
    const res = await linearGraphql(apiKey, { query, variables });
    if (res.errors?.length) {
      const msg = res.errors.map((e) => e.message ?? 'unknown').join('; ');
      console.warn(`[LinearConnector] GraphQL errors: ${msg}`);
      return [];
    }
    const nodes = res.data?.issues.nodes ?? [];
    return nodes.map(mapToUnifiedMessage).sort((a, b) => {
      return (b.modifiedAt?.getTime() ?? 0) - (a.modifiedAt?.getTime() ?? 0);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[LinearConnector] fetch failed: ${msg}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export function mapToUnifiedMessage(node: LinearIssueNode): UnifiedMessage {
  const updatedAt = new Date(node.updatedAt);
  const description = node.description ?? '';
  const content = description ? `${node.title}\n\n${description}` : node.title;
  const teamName = node.team?.name;
  const assigneeName = node.assignee?.name;

  return {
    id: node.identifier,
    source: MessageSource.Linear,
    subject: node.title,
    content,
    sender: {
      id: assigneeName ?? 'linear',
      name: assigneeName ?? 'Linear',
    },
    createdAt: updatedAt,
    modifiedAt: updatedAt,
    isReply: false,
    channel: teamName ?? undefined,
    team: teamName ?? undefined,
    metadata: {
      linear: {
        identifier: node.identifier,
        state: node.state?.name ?? undefined,
        team: teamName ?? undefined,
      },
    },
    raw: node,
  };
}