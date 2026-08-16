/**
 * Search messages tool implementation
 */

import type Database from 'better-sqlite3';
import type { Message } from '../db/schema.js';

export interface SearchMessagesArgs {
  topic: string;
  keywords?: string;
  source?: 'teams' | 'email' | 'jira' | 'all';
  dateRange?: {
    from?: string;
    to?: string;
  };
  limit?: number;
  offset?: number;
}

export interface SearchMessagesResult {
  messages: Message[];
  total: number;
  hasMore: boolean;
}

export async function searchMessages(
  db: Database.Database,
  args: SearchMessagesArgs
): Promise<SearchMessagesResult> {
  const { topic, keywords, source = 'all', dateRange, limit = 50, offset = 0 } = args;

  // First, get the topic ID
  const topicRow = db
    .prepare('SELECT id FROM topics WHERE name = ?')
    .get(topic) as { id: number } | undefined;

  if (!topicRow) {
    throw new Error(`Topic "${topic}" not found. Use configure_topic to create it first.`);
  }

  const topicId = topicRow.id;

  // Build the WHERE clause
  const conditions: string[] = ['topic_id = ?'];
  const parameters: unknown[] = [topicId];

  // Filter by source
  if (source !== 'all') {
    conditions.push('source = ?');
    parameters.push(source);
  }

  // Filter by keywords (search in subject and content)
  if (keywords) {
    conditions.push('(subject LIKE ? OR content LIKE ?)');
    const keywordPattern = `%${keywords}%`;
    parameters.push(keywordPattern, keywordPattern);
  }

  // Filter by date range
  if (dateRange?.from) {
    conditions.push('timestamp >= ?');
    parameters.push(dateRange.from);
  }

  if (dateRange?.to) {
    conditions.push('timestamp <= ?');
    parameters.push(dateRange.to);
  }

  const whereClause = conditions.join(' AND ');

  // Get total count
  const countQuery = `SELECT COUNT(*) as count FROM messages WHERE ${whereClause}`;
  const countResult = db.prepare(countQuery).get(...parameters) as { count: number };
  const total = countResult.count;

  // Get messages with pagination
  const query = `
    SELECT
      id, topic_id, source, content, author,
      timestamp, metadata
    FROM messages
    WHERE ${whereClause}
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `;

  const messages = db.prepare(query).all(...parameters, limit, offset) as Message[];

  // Parse metadata JSON strings
  const parsedMessages = messages.map(message => ({
    ...message,
    metadata: message.metadata ? JSON.parse(message.metadata as string) : {},
  }));

  return {
    messages: parsedMessages,
    total,
    hasMore: offset + messages.length < total,
  };
}

export function formatSearchResults(result: SearchMessagesResult, args: SearchMessagesArgs): string {
  const { messages, total, hasMore } = result;

  if (total === 0) {
    return `No messages found for topic "${args.topic}"${args.keywords ? ` with keywords "${args.keywords}"` : ''}.`;
  }

  const lines: string[] = [
    `Found ${total} message${total === 1 ? '' : 's'} for topic "${args.topic}"`,
    args.keywords ? `Keywords: "${args.keywords}"` : '',
    args.source && args.source !== 'all' ? `Source: ${args.source}` : '',
    args.dateRange?.from || args.dateRange?.to
      ? `Date range: ${args.dateRange.from || 'beginning'} to ${args.dateRange.to || 'now'}`
      : '',
    '',
    '---',
    '',
  ].filter(Boolean);

  for (const [index, message] of messages.entries()) {
    const messageNumber = (args.offset || 0) + index + 1;
    const timestamp = new Date(message.timestamp).toLocaleString();
    const preview = message.content.length > 200 ? `${message.content.slice(0, 200)}...` : message.content;

    lines.push(`${messageNumber}. [${message.source.toUpperCase()}] ${timestamp}`);
    lines.push(`   From: ${message.author}`);

    if (message.metadata) {
      const metadata = typeof message.metadata === 'string' ? JSON.parse(message.metadata) : message.metadata;

      if (metadata.teams?.channelName) {
        lines.push(`   Channel: ${metadata.teams.channelName}`);
      }

      if (metadata.email?.importance && metadata.email.importance !== 'normal') {
        lines.push(`   Importance: ${metadata.email.importance}`);
      }

      if (metadata.jira?.issueKey) {
        lines.push(`   Issue: ${metadata.jira.issueKey} (${metadata.jira.status})`);
      }
    }

    lines.push(`   ${preview}`);
    lines.push('');
  }

  if (hasMore) {
    lines.push('---');
    lines.push(`Showing ${messages.length} of ${total} messages. Use offset=${(args.offset || 0) + messages.length} to see more.`);
  }

  return lines.join('\n');
}
