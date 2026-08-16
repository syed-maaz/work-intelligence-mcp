import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/db/schema.js';
import {
  createTopic,
  getTopic,
  getTopicByName,
  listTopics,
  deleteTopic,
  insertMessage,
  searchMessages,
  getMessagesByTopic,
  getMessage,
  insertActionItem,
  updateActionItem,
  getActionItems,
  getActionItem,
  deleteActionItem,
  insertMeeting,
  getMeeting,
  getMeetingsByTopic,
  deleteMeeting,
} from '../../src/db/queries.js';
import { transaction } from '../../src/db/connection.js';

describe('Database Queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('Topic Operations', () => {
    it('should create a topic', () => {
      const topic = createTopic(db, {
        name: 'Test Topic',
        config: JSON.stringify({ key: 'value' }),
      });

      expect(topic.id).toBeDefined();
      expect(topic.name).toBe('Test Topic');
      expect(topic.config).toBe(JSON.stringify({ key: 'value' }));
      expect(topic.created_at).toBeDefined();
    });

    it('should get a topic by id', () => {
      const created = createTopic(db, { name: 'Test Topic' });
      const retrieved = getTopic(db, created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.name).toBe('Test Topic');
    });

    it('should get a topic by name', () => {
      createTopic(db, { name: 'Unique Topic' });
      const retrieved = getTopicByName(db, 'Unique Topic');

      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Unique Topic');
    });

    it('should list all topics', () => {
      createTopic(db, { name: 'Topic 1' });
      createTopic(db, { name: 'Topic 2' });
      createTopic(db, { name: 'Topic 3' });

      const topics = listTopics(db);
      expect(topics).toHaveLength(3);
    });

    it('should delete a topic', () => {
      const topic = createTopic(db, { name: 'To Delete' });
      const deleted = deleteTopic(db, topic.id);

      expect(deleted).toBe(true);
      expect(getTopic(db, topic.id)).toBeNull();
    });

    it('should enforce unique topic names', () => {
      createTopic(db, { name: 'Duplicate' });
      expect(() => createTopic(db, { name: 'Duplicate' })).toThrow();
    });
  });

  describe('Message Operations', () => {
    let topicId: number;

    beforeEach(() => {
      const topic = createTopic(db, { name: 'Message Topic' });
      topicId = topic.id;
    });

    it('should insert a message', () => {
      const message = insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'Test message',
        author: 'user@example.com',
      });

      expect(message.id).toBeDefined();
      expect(message.content).toBe('Test message');
      expect(message.source).toBe('slack');
      expect(message.author).toBe('user@example.com');
      expect(message.timestamp).toBeDefined();
    });

    it('should insert a message with custom timestamp', () => {
      const customTime = '2024-01-01T12:00:00Z';
      const message = insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'Test message',
        author: 'user@example.com',
        timestamp: customTime,
      });

      expect(message.timestamp).toBe(customTime);
    });

    it('should search messages by topic', () => {
      insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'Message 1',
        author: 'user1@example.com',
      });
      insertMessage(db, {
        topic_id: topicId,
        source: 'teams',
        content: 'Message 2',
        author: 'user2@example.com',
      });

      const messages = searchMessages(db, { topic_id: topicId });
      expect(messages).toHaveLength(2);
    });

    it('should search messages by source', () => {
      insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'Slack message',
        author: 'user@example.com',
      });
      insertMessage(db, {
        topic_id: topicId,
        source: 'teams',
        content: 'Teams message',
        author: 'user@example.com',
      });

      const slackMessages = searchMessages(db, { source: 'slack' });
      expect(slackMessages).toHaveLength(1);
      expect(slackMessages[0]?.source).toBe('slack');
    });

    it('should search messages by author', () => {
      insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'Message 1',
        author: 'alice@example.com',
      });
      insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'Message 2',
        author: 'bob@example.com',
      });

      const aliceMessages = searchMessages(db, { author: 'alice@example.com' });
      expect(aliceMessages).toHaveLength(1);
      expect(aliceMessages[0]?.author).toBe('alice@example.com');
    });

    it('should search messages by text content', () => {
      insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'The bug is fixed',
        author: 'user@example.com',
      });
      insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'New feature deployed',
        author: 'user@example.com',
      });

      const bugMessages = searchMessages(db, { search_text: 'bug' });
      expect(bugMessages).toHaveLength(1);
      expect(bugMessages[0]?.content).toContain('bug');
    });

    it('should search messages by date range', () => {
      insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'Old message',
        author: 'user@example.com',
        timestamp: '2024-01-01T10:00:00Z',
      });
      insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'New message',
        author: 'user@example.com',
        timestamp: '2024-02-01T10:00:00Z',
      });

      const messages = searchMessages(db, {
        start_date: '2024-01-15T00:00:00Z',
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe('New message');
    });

    it('should get messages by topic with date range', () => {
      insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'Message 1',
        author: 'user@example.com',
        timestamp: '2024-01-01T10:00:00Z',
      });
      insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'Message 2',
        author: 'user@example.com',
        timestamp: '2024-02-01T10:00:00Z',
      });

      const messages = getMessagesByTopic(db, topicId, {
        start: '2024-01-15T00:00:00Z',
        end: '2024-02-15T00:00:00Z',
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe('Message 2');
    });

    it('should get a message by id', () => {
      const created = insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'Test message',
        author: 'user@example.com',
      });

      const retrieved = getMessage(db, created.id);
      expect(retrieved?.id).toBe(created.id);
    });

    it('should limit and offset search results', () => {
      for (let index = 0; index < 10; index++) {
        insertMessage(db, {
          topic_id: topicId,
          source: 'slack',
          content: `Message ${index}`,
          author: 'user@example.com',
        });
      }

      const page1 = searchMessages(db, { topic_id: topicId, limit: 5 });
      const page2 = searchMessages(db, { topic_id: topicId, limit: 5, offset: 5 });

      expect(page1).toHaveLength(5);
      expect(page2).toHaveLength(5);
      expect(page1[0]?.id).not.toBe(page2[0]?.id);
    });
  });

  describe('Action Item Operations', () => {
    let topicId: number;

    beforeEach(() => {
      const topic = createTopic(db, { name: 'Action Topic' });
      topicId = topic.id;
    });

    it('should insert an action item', () => {
      const actionItem = insertActionItem(db, {
        topic_id: topicId,
        title: 'Fix bug',
        description: 'Fix the authentication bug',
        assignee: 'dev@example.com',
        status: 'pending',
        due_date: '2024-12-31',
      });

      expect(actionItem.id).toBeDefined();
      expect(actionItem.title).toBe('Fix bug');
      expect(actionItem.assignee).toBe('dev@example.com');
      expect(actionItem.status).toBe('pending');
    });

    it('should update an action item', () => {
      const actionItem = insertActionItem(db, {
        topic_id: topicId,
        title: 'Original title',
        status: 'pending',
      });

      const updated = updateActionItem(db, actionItem.id, {
        title: 'Updated title',
        status: 'completed',
      });

      expect(updated?.title).toBe('Updated title');
      expect(updated?.status).toBe('completed');
    });

    it('should get action items by topic', () => {
      insertActionItem(db, {
        topic_id: topicId,
        title: 'Task 1',
        status: 'pending',
      });
      insertActionItem(db, {
        topic_id: topicId,
        title: 'Task 2',
        status: 'completed',
      });

      const items = getActionItems(db, { topic_id: topicId });
      expect(items).toHaveLength(2);
    });

    it('should get action items by status', () => {
      insertActionItem(db, {
        topic_id: topicId,
        title: 'Task 1',
        status: 'pending',
      });
      insertActionItem(db, {
        topic_id: topicId,
        title: 'Task 2',
        status: 'completed',
      });

      const pending = getActionItems(db, { status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.status).toBe('pending');
    });

    it('should get action items by assignee', () => {
      insertActionItem(db, {
        topic_id: topicId,
        title: 'Task 1',
        assignee: 'alice@example.com',
        status: 'pending',
      });
      insertActionItem(db, {
        topic_id: topicId,
        title: 'Task 2',
        assignee: 'bob@example.com',
        status: 'pending',
      });

      const aliceItems = getActionItems(db, { assignee: 'alice@example.com' });
      expect(aliceItems).toHaveLength(1);
      expect(aliceItems[0]?.assignee).toBe('alice@example.com');
    });

    it('should get action items by due date range', () => {
      insertActionItem(db, {
        topic_id: topicId,
        title: 'Task 1',
        status: 'pending',
        due_date: '2024-01-15',
      });
      insertActionItem(db, {
        topic_id: topicId,
        title: 'Task 2',
        status: 'pending',
        due_date: '2024-02-15',
      });

      const items = getActionItems(db, {
        due_date_before: '2024-01-20',
      });
      expect(items).toHaveLength(1);
      expect(items[0]?.title).toBe('Task 1');
    });

    it('should delete an action item', () => {
      const actionItem = insertActionItem(db, {
        topic_id: topicId,
        title: 'To delete',
        status: 'pending',
      });

      const deleted = deleteActionItem(db, actionItem.id);
      expect(deleted).toBe(true);
      expect(getActionItem(db, actionItem.id)).toBeNull();
    });

    it('should link action item to source message', () => {
      const message = insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'We need to fix the bug',
        author: 'user@example.com',
      });

      const actionItem = insertActionItem(db, {
        topic_id: topicId,
        title: 'Fix bug',
        status: 'pending',
        source_message_id: message.id,
      });

      expect(actionItem.source_message_id).toBe(message.id);
    });
  });

  describe('Meeting Operations', () => {
    let topicId: number;

    beforeEach(() => {
      const topic = createTopic(db, { name: 'Meeting Topic' });
      topicId = topic.id;
    });

    it('should insert a meeting', () => {
      const meeting = insertMeeting(db, {
        topic_id: topicId,
        title: 'Sprint Planning',
        date: '2024-01-15T10:00:00Z',
        attendees: JSON.stringify(['alice@example.com', 'bob@example.com']),
        notes: 'Discussed sprint goals',
      });

      expect(meeting.id).toBeDefined();
      expect(meeting.title).toBe('Sprint Planning');
      expect(meeting.date).toBe('2024-01-15T10:00:00Z');
    });

    it('should get a meeting by id', () => {
      const created = insertMeeting(db, {
        topic_id: topicId,
        title: 'Daily Standup',
        date: '2024-01-15T09:00:00Z',
      });

      const retrieved = getMeeting(db, created.id);
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.title).toBe('Daily Standup');
    });

    it('should get meetings by topic', () => {
      insertMeeting(db, {
        topic_id: topicId,
        title: 'Meeting 1',
        date: '2024-01-15T10:00:00Z',
      });
      insertMeeting(db, {
        topic_id: topicId,
        title: 'Meeting 2',
        date: '2024-01-16T10:00:00Z',
      });

      const meetings = getMeetingsByTopic(db, topicId);
      expect(meetings).toHaveLength(2);
    });

    it('should delete a meeting', () => {
      const meeting = insertMeeting(db, {
        topic_id: topicId,
        title: 'To delete',
        date: '2024-01-15T10:00:00Z',
      });

      const deleted = deleteMeeting(db, meeting.id);
      expect(deleted).toBe(true);
      expect(getMeeting(db, meeting.id)).toBeNull();
    });
  });

  // Decision Operations and Question Operations tests removed:
  // Both tables were dropped by migration v103 (storage audit 2026-07-18).
  // decisions superseded by brain_decisions (ADR-024);
  // questions superseded by notebook-chat.
  // See src/db/migrations/v103_drop_dead_tables.ts.

  describe('Data Integrity', () => {
    it('should cascade delete messages when topic is deleted', () => {
      const topic = createTopic(db, { name: 'Test Topic' });
      insertMessage(db, {
        topic_id: topic.id,
        source: 'slack',
        content: 'Test message',
        author: 'user@example.com',
      });

      deleteTopic(db, topic.id);

      const messages = searchMessages(db, { topic_id: topic.id });
      expect(messages).toHaveLength(0);
    });

    it('should cascade delete action items when topic is deleted', () => {
      const topic = createTopic(db, { name: 'Test Topic' });
      insertActionItem(db, {
        topic_id: topic.id,
        title: 'Test task',
        status: 'pending',
      });

      deleteTopic(db, topic.id);

      const items = getActionItems(db, { topic_id: topic.id });
      expect(items).toHaveLength(0);
    });

    it('should set source_message_id to null when message is deleted', () => {
      const topic = createTopic(db, { name: 'Test Topic' });
      const message = insertMessage(db, {
        topic_id: topic.id,
        source: 'slack',
        content: 'Test message',
        author: 'user@example.com',
      });

      const actionItem = insertActionItem(db, {
        topic_id: topic.id,
        title: 'Test task',
        status: 'pending',
        source_message_id: message.id,
      });

      // Delete the message directly via SQL to test ON DELETE SET NULL
      db.prepare('DELETE FROM messages WHERE id = ?').run(message.id);

      const retrieved = getActionItem(db, actionItem.id);
      expect(retrieved?.source_message_id).toBeNull();
    });
  });

  describe('Transaction Support', () => {
    it('should commit transaction on success', () => {
      const result = transaction(db, () => {
        const topic = createTopic(db, { name: 'Transaction Topic' });
        insertMessage(db, {
          topic_id: topic.id,
          source: 'slack',
          content: 'Test message',
          author: 'user@example.com',
        });
        return topic;
      });

      expect(result.id).toBeDefined();
      const messages = searchMessages(db, { topic_id: result.id });
      expect(messages).toHaveLength(1);
    });

    it('should rollback transaction on error', () => {
      expect(() => {
        transaction(db, () => {
          createTopic(db, { name: 'Transaction Topic' });
          throw new Error('Simulated error');
        });
      }).toThrow('Simulated error');

      const topics = listTopics(db);
      expect(topics).toHaveLength(0);
    });

    it('should handle nested operations in transaction', () => {
      const result = transaction(db, () => {
        const topic = createTopic(db, { name: 'Nested Topic' });

        const message = insertMessage(db, {
          topic_id: topic.id,
          source: 'slack',
          content: 'Test message',
          author: 'user@example.com',
        });

        insertActionItem(db, {
          topic_id: topic.id,
          title: 'Task from message',
          status: 'pending',
          source_message_id: message.id,
        });

        return topic;
      });

      const actionItems = getActionItems(db, { topic_id: result.id });
      expect(actionItems).toHaveLength(1);
      expect(actionItems[0]?.source_message_id).toBeDefined();
    });
  });

  describe('Search Functionality', () => {
    let topicId: number;

    beforeEach(() => {
      const topic = createTopic(db, { name: 'Search Topic' });
      topicId = topic.id;

      // Insert test data
      insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'Bug in authentication module',
        author: 'alice@example.com',
        timestamp: '2024-01-10T10:00:00Z',
      });
      insertMessage(db, {
        topic_id: topicId,
        source: 'teams',
        content: 'New feature request for dashboard',
        author: 'bob@example.com',
        timestamp: '2024-01-15T10:00:00Z',
      });
      insertMessage(db, {
        topic_id: topicId,
        source: 'slack',
        content: 'Bug fix deployed to production',
        author: 'alice@example.com',
        timestamp: '2024-01-20T10:00:00Z',
      });
    });

    it('should search with multiple filters', () => {
      const results = searchMessages(db, {
        topic_id: topicId,
        source: 'slack',
        author: 'alice@example.com',
        search_text: 'Bug',
      });

      expect(results).toHaveLength(2);
    });

    it('should return results in reverse chronological order', () => {
      const results = searchMessages(db, { topic_id: topicId });

      expect(results).toHaveLength(3);
      expect(results[0]!.timestamp > results[1]!.timestamp).toBe(true);
      expect(results[1]!.timestamp > results[2]!.timestamp).toBe(true);
    });
  });
});
