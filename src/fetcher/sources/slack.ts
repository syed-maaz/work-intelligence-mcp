/**
 * Slack Web API Connector
 *
 * Pulls recent messages from public/private channels via the Slack Web API
 * (https://slack.com/api/conversations.list → conversations.history).
 * No SDK — pure HTTP fetch, matching the GitHub connector pattern.
 *
 * Config via options or environment variables:
 *   SLACK_TOKEN    — bot/user OAuth token (xoxb-... / xoxp-...)
 *   SLACK_TEAM_ID  — optional team id filter for conversations.list
 *
 * Returns UnifiedMessage[] with source: MessageSource.Slack. Result ids are
 * `channel_id:ts`, so the orchestrator's dedup path (source_id) stays stable
 * across sync cycles.
 *
 * Fetch failures never throw — warn + return []. A missing token throws.
 */

import { MessageSource, type UnifiedMessage } from './types.js';

// ---------------------------------------------------------------------------
// Public options / response shapes
// ---------------------------------------------------------------------------

export interface SlackFetchOptions {
  /** Bot/user OAuth token — falls back to SLACK_TOKEN. */
  token?: string;
  /** Team id filter — falls back to SLACK_TEAM_ID. */
  teamId?: string;
  /** Max history messages per channel (default: 50). */
  limit?: number;
  /** Optional single channel name or id to limit history to. */
  channel?: string;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_archived?: boolean;
}

export interface SlackMessage {
  type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

interface SlackListResponse {
  ok?: boolean;
  error?: string;
  channels?: SlackChannel[];
}

interface SlackHistoryResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
}

const SLACK_API_BASE = 'https://slack.com/api';
const DEFAULT_TIMEOUT_MS = 30_000;
const HISTORY_LIMIT_MAX = 200; // bound the relationship between channels * limit

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * GET a Slack Web API endpoint with a bounded AbortController. Throws on
 * network/timeout/non-ok responses; the caller isolates via try/catch.
 */
async function slackGet<T>(
  token: string,
  method: string,
  params: URLSearchParams,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${SLACK_API_BASE}/${method}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Slack API ${method}: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { ok?: boolean; error?: string } & T;
    if (body.ok === false) {
      throw new Error(`Slack API ${method}: ${body.error ?? 'unknown error'}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fetch recent Slack messages as UnifiedMessage[].
 *
 * Resolution order: opts → process.env.SLACK_TOKEN → SLACK_TEAM_ID.
 * Throws a clear error when no token is configured. Fetch/timeout failures
 * are swallowed — warn + return [] (connector isolation pattern).
 */
export async function fetchSlackMessages(
  opts: SlackFetchOptions = {},
): Promise<UnifiedMessage[]> {
  const token = opts.token ?? process.env.SLACK_TOKEN;
  const teamId = opts.teamId ?? process.env.SLACK_TEAM_ID;
  const limit = Math.min(opts.limit ?? 50, HISTORY_LIMIT_MAX);

  if (!token) {
    throw new Error('SLACK_TOKEN not set — configure in .env or wi.config.json');
  }

  try {
    const listParams = new URLSearchParams({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200',
    });
    if (teamId) listParams.set('team_id', teamId);

    const list = await slackGet<SlackListResponse>(token, 'conversations.list', listParams);
    const channels = (list.channels ?? []).filter((c) => !c.is_archived);
    const target = opts.channel
      ? channels.find((c) => c.id === opts.channel || c.name === opts.channel)
      : undefined;
    if (opts.channel && !target) {
      console.warn(`[SlackConnector] channel "${opts.channel}" not found — returning [] (no fetch)`);
      return [];
    }
    const toFetch = target ? [target] : channels;

    const messages: UnifiedMessage[] = [];
    for (const channel of toFetch) {
      try {
        const historyParams = new URLSearchParams({
          channel: channel.id,
          limit: String(limit),
        });
        const history = await slackGet<SlackHistoryResponse>(token, 'conversations.history', historyParams);
        for (const m of history.messages ?? []) {
          messages.push(mapToUnifiedMessage(m, channel, teamId));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[SlackConnector] history failed for #${channel.name}: ${msg}`);
      }
    }

    return messages.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SlackConnector] fetch failed: ${msg}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export function mapToUnifiedMessage(
  m: SlackMessage,
  channel: SlackChannel,
  teamId?: string,
): UnifiedMessage {
  const user = m.user ?? m.bot_id ?? 'unknown';
  const text = m.text ?? '';
  const threadTs = m.thread_ts;
  const messageId = `${channel.id}:${m.ts}`;

  return {
    id: messageId,
    source: MessageSource.Slack,
    subject: text.slice(0, 200) || '(no text)',
    content: text,
    sender: { id: user, name: user },
    createdAt: new Date(Number(m.ts) * 1000),
    modifiedAt: new Date(Number(m.ts) * 1000),
    conversationId: threadTs ?? m.ts,
    parentId: threadTs ? `${channel.id}:${threadTs}` : undefined,
    isReply: threadTs != null,
    channel: channel.name,
    team: teamId,
    metadata: {
      slack: {
        channelId: channel.id,
        channelName: channel.name,
        threadTs,
      },
    },
    raw: m,
  };
}