import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/db/schema.js';
import { insertMessage, upsertMessage, getSyncState, updateSyncState, createTopic } from '../../src/db/queries.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeDatabase(db);
});

afterEach(() => {
  db.close();
});

describe('Schema v2 migration', () => {
  it('messages table has source_id column', () => {
    const topic = createTopic(db, { name: 'test' });
    const msg = insertMessage(db, {
      topic_id: topic.id,
      source: 'jira',
      content: 'test content',
      author: 'Alice',
      source_id: 'DEMO-123',
    });
    expect(msg.source_id).toBe('DEMO-123');
  });

  it('messages table has subject column', () => {
    const topic = createTopic(db, { name: 'test' });
    const msg = insertMessage(db, {
      topic_id: topic.id,
      source: 'jira',
      content: 'test content',
      author: 'Alice',
      subject: '[DEMO-123] Fix login bug',
    });
    expect(msg.subject).toBe('[DEMO-123] Fix login bug');
  });

  it('messages table has raw_data column', () => {
    const topic = createTopic(db, { name: 'test' });
    const raw = JSON.stringify({ key: 'DEMO-123', status: 'In Progress' });
    const msg = insertMessage(db, {
      topic_id: topic.id,
      source: 'jira',
      content: 'test content',
      author: 'Alice',
      raw_data: raw,
    });
    expect(msg.raw_data).toBe(raw);
  });

  it('sync_state table exists and can be read/written', () => {
    updateSyncState(db, '1', 'jira', '2026-04-15T10:00:00Z', 42);
    const state = getSyncState(db, '1', 'jira');
    expect(state).not.toBeNull();
    expect(state?.last_synced_at).toBe('2026-04-15T10:00:00Z');
    expect(state?.last_message_count).toBe(42);
  });

  it('updateSyncState is idempotent', () => {
    updateSyncState(db, '1', 'jira', '2026-04-15T10:00:00Z', 10);
    updateSyncState(db, '1', 'jira', '2026-04-15T11:00:00Z', 20);
    const state = getSyncState(db, '1', 'jira');
    expect(state?.last_synced_at).toBe('2026-04-15T11:00:00Z');
    expect(state?.last_message_count).toBe(20);
    // Ensure only one row
    const count = (db.prepare('SELECT COUNT(*) as n FROM sync_state WHERE topic_id = ? AND source = ?').get('1', 'jira') as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('upsertMessage', () => {
  it('inserts a new message', () => {
    const topic = createTopic(db, { name: 'test' });
    const msg = upsertMessage(db, {
      topic_id: topic.id,
      source: 'jira',
      content: 'issue body',
      author: 'Alice',
      source_id: 'DEMO-100',
      subject: '[DEMO-100] Test issue',
    });
    expect(msg.source_id).toBe('DEMO-100');
    expect(msg.subject).toBe('[DEMO-100] Test issue');
  });

  it('replaces existing message with same (source, source_id)', () => {
    const topic = createTopic(db, { name: 'test' });
    upsertMessage(db, {
      topic_id: topic.id,
      source: 'jira',
      content: 'original content',
      author: 'Alice',
      source_id: 'DEMO-200',
    });
    upsertMessage(db, {
      topic_id: topic.id,
      source: 'jira',
      content: 'updated content',
      author: 'Alice',
      source_id: 'DEMO-200',
    });

    // Should only be one row
    const count = (db.prepare('SELECT COUNT(*) as n FROM messages WHERE source = ? AND source_id = ?').get('jira', 'DEMO-200') as { n: number }).n;
    expect(count).toBe(1);

    // Content should be updated
    const row = db.prepare('SELECT content FROM messages WHERE source = ? AND source_id = ?').get('jira', 'DEMO-200') as { content: string };
    expect(row.content).toBe('updated content');
  });

  it('allows different sources to have same source_id without conflict', () => {
    const topic = createTopic(db, { name: 'test' });
    upsertMessage(db, {
      topic_id: topic.id,
      source: 'jira',
      content: 'jira content',
      author: 'Alice',
      source_id: 'ID-001',
    });
    upsertMessage(db, {
      topic_id: topic.id,
      source: 'teams',
      content: 'teams content',
      author: 'Bob',
      source_id: 'ID-001',
    });
    const count = (db.prepare('SELECT COUNT(*) as n FROM messages WHERE source_id = ?').get('ID-001') as { n: number }).n;
    expect(count).toBe(2);
  });
});
