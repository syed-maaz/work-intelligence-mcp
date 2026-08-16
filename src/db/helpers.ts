import Database from 'better-sqlite3';
import {
  searchMessages,
  getActionItems,
  getQuestions,
  insertActionItem,
} from './queries.js';
import type { Message, ActionItem, Question } from './schema.js';

/**
 * Get all pending action items across all topics
 */
export function getAllPendingActionItems(db: Database.Database): ActionItem[] {
  return getActionItems(db, { status: 'pending' });
}

/**
 * Get overdue action items
 */
export function getOverdueActionItems(db: Database.Database): ActionItem[] {
  const now = new Date().toISOString();
  return getActionItems(db, {
    status: 'pending',
    due_date_before: now,
  });
}

/**
 * Get action items due soon (within specified days)
 */
export function getUpcomingActionItems(
  db: Database.Database,
  daysAhead: number = 7
): ActionItem[] {
  const now = new Date().toISOString();
  const futureDate = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();

  return getActionItems(db, {
    status: 'pending',
    due_date_after: now,
    due_date_before: futureDate,
  });
}

/**
 * Get all unanswered questions
 */
export function getUnansweredQuestions(db: Database.Database): Question[] {
  return getQuestions(db, { status: 'open' });
}

/**
 * Get recent messages across all topics
 */
export function getRecentMessages(
  db: Database.Database,
  daysBack: number = 7,
  limit: number = 100
): Message[] {
  const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  return searchMessages(db, {
    start_date: startDate,
    limit,
  });
}

/**
 * Get messages by source type
 */
export function getMessagesBySource(
  db: Database.Database,
  source: string,
  limit: number = 100
): Message[] {
  return searchMessages(db, { source, limit });
}

/**
 * Get messages from a specific author
 */
export function getMessagesByAuthor(
  db: Database.Database,
  author: string,
  limit: number = 100
): Message[] {
  return searchMessages(db, { author, limit });
}

/**
 * Get action items assigned to a person
 */
export function getActionItemsByAssignee(
  db: Database.Database,
  assignee: string
): ActionItem[] {
  return getActionItems(db, { assignee });
}

/**
 * Get message statistics for a topic
 */
export function getTopicMessageStats(db: Database.Database, topicId: number) {
  const allMessages = searchMessages(db, { topic_id: topicId });

  const bySource = allMessages.reduce((accumulator: Record<string, number>, message) => {
    accumulator[message.source] = (accumulator[message.source] || 0) + 1;
    return accumulator;
  }, {});

  const byAuthor = allMessages.reduce((accumulator: Record<string, number>, message) => {
    accumulator[message.author] = (accumulator[message.author] || 0) + 1;
    return accumulator;
  }, {});

  return {
    total: allMessages.length,
    bySource,
    byAuthor,
    dateRange: {
      oldest: allMessages[allMessages.length - 1]?.timestamp,
      newest: allMessages[0]?.timestamp,
    },
  };
}

/**
 * Get action item statistics for a topic
 */
export function getTopicActionItemStats(db: Database.Database, topicId: number) {
  const allItems = getActionItems(db, { topic_id: topicId });

  const byStatus = allItems.reduce((accumulator: Record<string, number>, item) => {
    accumulator[item.status] = (accumulator[item.status] || 0) + 1;
    return accumulator;
  }, {});

  const byAssignee = allItems.reduce((accumulator: Record<string, number>, item) => {
    if (item.assignee) {
      accumulator[item.assignee] = (accumulator[item.assignee] || 0) + 1;
    }
    return accumulator;
  }, {});

  const overdue = allItems.filter(
    (item) => item.due_date && item.due_date < new Date().toISOString() && item.status === 'pending'
  ).length;

  return {
    total: allItems.length,
    byStatus,
    byAssignee,
    overdue,
  };
}

/**
 * Search messages with full-text search across all fields
 */
export function fullTextSearch(
  db: Database.Database,
  searchTerm: string,
  options: {
    topicId?: number;
    source?: string;
    limit?: number;
  } = {}
): Message[] {
  return searchMessages(db, {
    topic_id: options.topicId,
    source: options.source,
    search_text: searchTerm,
    limit: options.limit || 100,
  });
}

/**
 * Extract potential action items from messages
 * Returns messages that might indicate action items (contain keywords)
 */
export function findPotentialActionItems(
  db: Database.Database,
  topicId: number,
  daysBack: number = 7
): Message[] {
  const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const messages = searchMessages(db, {
    topic_id: topicId,
    start_date: startDate,
  });

  const actionKeywords = [
    'todo',
    'action item',
    'need to',
    'should',
    'must',
    'fix',
    'bug',
    'issue',
    'task',
    'assigned',
    'deadline',
    'due',
  ];

  return messages.filter((message) =>
    actionKeywords.some((keyword) =>
      message.content.toLowerCase().includes(keyword.toLowerCase())
    )
  );
}

/**
 * Extract potential questions from messages
 * Returns messages that contain question marks
 */
export function findPotentialQuestions(
  db: Database.Database,
  topicId: number,
  daysBack: number = 7
): Message[] {
  const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const messages = searchMessages(db, {
    topic_id: topicId,
    start_date: startDate,
  });

  return messages.filter((message) => message.content.includes('?'));
}

/**
 * Create action items in bulk
 */
export function bulkCreateActionItems(
  db: Database.Database,
  items: Array<{
    topic_id: number;
    title: string;
    description?: string;
    assignee?: string;
    due_date?: string;
    source_message_id?: number;
  }>
): ActionItem[] {
  return items.map((item) =>
    insertActionItem(db, {
      ...item,
      status: 'pending',
    })
  );
}

/**
 * Get topic activity summary
 */
export function getTopicActivitySummary(db: Database.Database, topicId: number, days: number = 7) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const recentMessages = searchMessages(db, {
    topic_id: topicId,
    start_date: startDate,
  });

  const pendingActionItems = getActionItems(db, {
    topic_id: topicId,
    status: 'pending',
  });

  const openQuestions = getQuestions(db, {
    topic_id: topicId,
    status: 'open',
  });

  return {
    timeframe: `Last ${days} days`,
    messages: {
      count: recentMessages.length,
      sources: [...new Set(recentMessages.map((message) => message.source))],
      authors: [...new Set(recentMessages.map((message) => message.author))],
    },
    actionItems: {
      pending: pendingActionItems.length,
      overdue: pendingActionItems.filter(
        (item) => item.due_date && item.due_date < new Date().toISOString()
      ).length,
    },
    questions: {
      open: openQuestions.length,
    },
  };
}
