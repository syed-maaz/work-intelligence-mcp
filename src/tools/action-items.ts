/**
 * Get action items tool implementation
 */

import type Database from 'better-sqlite3';
import type { ActionItem } from '../db/schema.js';

export interface GetActionItemsArgs {
  topic: string;
  status?: 'open' | 'in_progress' | 'completed' | 'all';
  assignee?: string;
  limit?: number;
  offset?: number;
}

export interface ActionItemWithContext extends ActionItem {
  sourceMessage?: {
    content: string;
    author: string;
    timestamp: string;
  };
}

export interface GetActionItemsResult {
  actionItems: ActionItemWithContext[];
  total: number;
  hasMore: boolean;
}

export async function getActionItems(
  db: Database.Database,
  args: GetActionItemsArgs
): Promise<GetActionItemsResult> {
  const { topic, status = 'open', assignee, limit = 50, offset = 0 } = args;

  // First, get the topic ID
  const topicRow = db
    .prepare('SELECT id FROM topics WHERE name = ?')
    .get(topic) as { id: number } | undefined;

  if (!topicRow) {
    throw new Error(`Topic "${topic}" not found. Use configure_topic to create it first.`);
  }

  const topicId = topicRow.id;

  // Build the WHERE clause
  const conditions: string[] = ['a.topic_id = ?'];
  const parameters: unknown[] = [topicId];

  // Filter by status
  if (status !== 'all') {
    conditions.push('a.status = ?');
    parameters.push(status);
  }

  // Filter by assignee
  if (assignee) {
    conditions.push('a.assignee LIKE ?');
    parameters.push(`%${assignee}%`);
  }

  const whereClause = conditions.join(' AND ');

  // Get total count
  const countQuery = `SELECT COUNT(*) as count FROM action_items a WHERE ${whereClause}`;
  const countResult = db.prepare(countQuery).get(...parameters) as { count: number };
  const total = countResult.count;

  // Get action items with source message context
  const query = `
    SELECT
      a.id, a.topic_id, a.title, a.description, a.assignee,
      a.status, a.due_date, a.source_message_id,
      m.content as message_content,
      m.author as message_author,
      m.timestamp as message_timestamp
    FROM action_items a
    LEFT JOIN messages m ON a.source_message_id = m.id
    WHERE ${whereClause}
    ORDER BY
      CASE
        WHEN a.due_date IS NOT NULL THEN 0
        ELSE 1
      END,
      a.due_date ASC,
      a.id DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(query).all(...parameters, limit, offset) as Array<
    ActionItem & {
      message_content?: string;
      message_author?: string;
      message_timestamp?: string;
    }
  >;

  // Transform results to include source message context
  const actionItems: ActionItemWithContext[] = rows.map(row => {
    const item: ActionItemWithContext = {
      id: row.id,
      topic_id: row.topic_id,
      title: row.title,
      description: row.description,
      assignee: row.assignee,
      status: row.status,
      due_date: row.due_date,
      source_message_id: row.source_message_id,
      content_hash: row.content_hash ?? null,
    };

    if (row.message_content) {
      item.sourceMessage = {
        content: row.message_content,
        author: row.message_author!,
        timestamp: row.message_timestamp!,
      };
    }

    return item;
  });

  return {
    actionItems,
    total,
    hasMore: offset + actionItems.length < total,
  };
}

export function formatActionItems(result: GetActionItemsResult, args: GetActionItemsArgs): string {
  const { actionItems, total, hasMore } = result;

  if (total === 0) {
    const statusText = args.status === 'all' ? 'any' : args.status;
    return `No ${statusText} action items found for topic "${args.topic}"${args.assignee ? ` assigned to "${args.assignee}"` : ''}.`;
  }

  const statusText = args.status === 'all' ? '' : ` (${args.status})`;
  const assigneeText = args.assignee ? ` for assignee "${args.assignee}"` : '';

  const lines: string[] = [
    `Found ${total} action item${total === 1 ? '' : 's'}${statusText} for topic "${args.topic}"${assigneeText}`,
    '',
    '---',
    '',
  ];

  // Group by status for better visibility
  const grouped = new Map<string, ActionItemWithContext[]>();
  for (const item of actionItems) {
    const statusGroup = grouped.get(item.status) || [];
    statusGroup.push(item);
    grouped.set(item.status, statusGroup);
  }

  const statusOrder = ['open', 'in_progress', 'completed'];
  for (const status of statusOrder) {
    const items = grouped.get(status);
    if (!items || items.length === 0) continue;

    const statusEmoji = status === 'open' ? '🔴' : status === 'in_progress' ? '🟡' : '✅';
    lines.push(`${statusEmoji} ${status.toUpperCase().replace('_', ' ')} (${items.length})`);
    lines.push('');

    for (const [index, item] of items.entries()) {
      const itemNumber = (args.offset || 0) + index + 1;

      lines.push(`${itemNumber}. ${item.title}`);

      if (item.assignee) {
        lines.push(`   Assignee: ${item.assignee}`);
      }

      if (item.due_date) {
        const dueDate = new Date(item.due_date);
        const today = new Date();
        const isOverdue = dueDate < today && item.status !== 'completed';
        const dueDateStr = dueDate.toLocaleDateString();

        lines.push(`   Due date: ${dueDateStr}${isOverdue ? ' ⚠️ OVERDUE' : ''}`);
      }

      if (item.description) {
        const desc = item.description.length > 150 ? `${item.description.slice(0, 150)}...` : item.description;
        lines.push(`   ${desc}`);
      }

      if (item.sourceMessage) {
        const timestamp = new Date(item.sourceMessage.timestamp).toLocaleString();
        lines.push(`   Source: ${item.sourceMessage.author} on ${timestamp}`);
      }

      lines.push('');
    }
  }

  if (hasMore) {
    lines.push('---');
    lines.push(`Showing ${actionItems.length} of ${total} action items. Use offset=${(args.offset || 0) + actionItems.length} to see more.`);
  }

  return lines.join('\n');
}
