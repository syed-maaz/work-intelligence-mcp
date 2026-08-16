/**
 * Tests for Slack and Linear connectors — normalization, token handling,
 * and fetch-failure isolation (warn + [] pattern).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchSlackMessages,
  mapToUnifiedMessage,
  type SlackChannel,
  type SlackMessage,
} from '../../src/fetcher/sources/slack.js';
import {
  fetchLinearIssues,
  mapToUnifiedMessage as mapLinearMessage,
  type LinearIssueNode,
} from '../../src/fetcher/sources/linear.js';
import { MessageSource } from '../../src/fetcher/sources/types.js';

describe('slack mapToUnifiedMessage', () => {
  const channel: SlackChannel = { id: 'C123', name: 'general' };
  const msg: SlackMessage = {
    type: 'message',
    user: 'U456',
    text: 'hello world',
    ts: '1700000000.000100',
  };

  it('normalizes a plain message with stable dedup id', () => {
    const m = mapToUnifiedMessage(msg, channel);
    expect(m.source).toBe(MessageSource.Slack);
    expect(m.id).toBe('C123:1700000000.000100');
    expect(m.channel).toBe('general');
    expect(m.subject).toBe('hello world');
    expect(m.isReply).toBe(false);
    expect(m.sender.id).toBe('U456');
    expect(m.metadata?.slack?.channelId).toBe('C123');
  });

  it('flags replies with parentId and conversationId = thread ts', () => {
    const reply: SlackMessage = { ...msg, thread_ts: '1700000000.000000' };
    const m = mapToUnifiedMessage(reply, channel);
    expect(m.isReply).toBe(true);
    expect(m.conversationId).toBe('1700000000.000000');
    expect(m.parentId).toBe('C123:1700000000.000000');
  });

  it('falls back to bot_id and truncates subject over 200 chars', () => {
    const bot = {
      type: 'message',
      bot_id: 'B777',
      text: 'x'.repeat(300),
      ts: '1700000001.000200',
    } satisfies SlackMessage;
    const m = mapToUnifiedMessage(bot, channel);
    expect(m.sender.id).toBe('B777');
    expect(m.subject.length).toBe(200);
  });
});

describe('slack fetchSlackMessages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.SLACK_TOKEN;
  });

  it('throws a clear error when no token is set', async () => {
    await expect(fetchSlackMessages({})).rejects.toThrow('SLACK_TOKEN not set');
  });

  it('returns [] and warns on network failure instead of throwing', async () => {
    process.env.SLACK_TOKEN = 'xoxb-test';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network unreachable')),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await fetchSlackMessages({});
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('honors opts.token over env', async () => {
    process.env.SLACK_TOKEN = 'xoxb-env';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'general' }], messages: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchSlackMessages({ token: 'xoxb-opt', limit: 5 });
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer xoxb-opt');
  });
});

describe('linear mapToUnifiedMessage', () => {
  const node: LinearIssueNode = {
    id: 'abc',
    identifier: 'ENG-123',
    title: 'Fix pipeline',
    description: 'Detailed description',
    updatedAt: '2026-01-02T03:04:05.000Z',
    state: { name: 'In Progress' },
    team: { name: 'Platform' },
    assignee: { name: 'Alice' },
  };

  it('normalizes a Linear issue into a UnifiedMessage', () => {
    const m = mapLinearMessage(node);
    expect(m.source).toBe(MessageSource.Linear);
    expect(m.id).toBe('ENG-123');
    expect(m.subject).toBe('Fix pipeline');
    expect(m.content).toContain('Detailed description');
    expect(m.channel).toBe('Platform');
    expect(m.sender.name).toBe('Alice');
    expect(m.metadata?.linear?.state).toBe('In Progress');
  });

  it('handles null state/team/assignee', () => {
    const m = mapLinearMessage({ ...node, state: null, team: null, assignee: null });
    expect(m.sender.name).toBe('Linear');
    expect(m.metadata?.linear?.state).toBeUndefined();
    expect(m.team).toBeUndefined();
  });

  it('builds content = title alone when description is empty', () => {
    const m = mapLinearMessage({ ...node, description: null });
    expect(m.content).toBe('Fix pipeline');
  });
});

describe('linear fetchLinearIssues', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.LINEAR_API_KEY;
  });

  it('throws a clear error when no key is set', async () => {
    await expect(fetchLinearIssues({})).rejects.toThrow('LINEAR_API_KEY not set');
  });

  it('returns [] and warns on GraphQL errors', async () => {
    process.env.LINEAR_API_KEY = 'lin-key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ errors: [{ message: 'Unauthorized' }] }),
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await fetchLinearIssues({});
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns [] and warns on network failure', async () => {
    process.env.LINEAR_API_KEY = 'k-key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await fetchLinearIssues({});
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});