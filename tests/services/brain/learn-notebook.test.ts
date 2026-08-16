/**
 * Phase 79-05 — learn-notebook tests.
 *
 * Verifies that recordOutcome auto-populates topic_notebooks when the
 * decision question keywords match a topics.name row.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { recordOutcome } from '../../../src/services/brain/learn.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE brain_decisions (
      id TEXT PRIMARY KEY,
      question TEXT,
      decision TEXT NOT NULL,
      confidence REAL,
      rationale TEXT,
      outcome TEXT,
      outcome_recorded_at INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      config TEXT,
      lookback_days INTEGER NOT NULL DEFAULT 30
    );
    CREATE TABLE topic_notebooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_name TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      last_message_id INTEGER,
      last_updated TEXT NOT NULL DEFAULT (datetime('now')),
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_annotation TEXT,
      user_corrections TEXT DEFAULT '[]',
      state_json TEXT
    );
    CREATE INDEX idx_topic_notebooks_name ON topic_notebooks(topic_name);
  `);
  return db;
}

describe('recordOutcome — notebook auto-populate (phase 79-05)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('TC1: creates notebook row when decision question matches a topic name', async () => {
    db.prepare(`INSERT INTO topics (name) VALUES ('search-provider')`).run();
    db.prepare(
      `INSERT INTO brain_decisions (id, question, decision) VALUES ('d-001', 'should I fix the search-provider proxy auth issue?', 'yes, fix it')`,
    ).run();

    await recordOutcome({ db, decisionId: 'd-001', outcome: 'success' });

    const nb = db
      .prepare(`SELECT content FROM topic_notebooks WHERE topic_name='search-provider'`)
      .get() as { content: string } | undefined;

    expect(nb).toBeDefined();
    expect(nb!.content).toContain('search-provider proxy auth issue');
    expect(nb!.content).toContain('success');
    expect(nb!.content).toContain('## Decision');
  });

  it('TC2: extends existing notebook content, does not replace it', async () => {
    db.prepare(`INSERT INTO topics (name) VALUES ('search-provider')`).run();
    db.prepare(
      `INSERT INTO topic_notebooks (topic_name, content) VALUES ('search-provider', 'existing notebook content')`,
    ).run();
    db.prepare(
      `INSERT INTO brain_decisions (id, question, decision) VALUES ('d-002', 'should I update the search-provider token cache?', 'yes update it')`,
    ).run();

    await recordOutcome({ db, decisionId: 'd-002', outcome: 'success' });

    const nb = db
      .prepare(`SELECT content FROM topic_notebooks WHERE topic_name='search-provider'`)
      .get() as { content: string } | undefined;

    expect(nb!.content).toContain('existing notebook content');
    expect(nb!.content).toContain('search-provider token cache');
  });

  it('TC3: no notebook row when question has no matching topic', async () => {
    db.prepare(`INSERT INTO topics (name) VALUES ('search-provider')`).run();
    db.prepare(
      `INSERT INTO brain_decisions (id, question, decision) VALUES ('d-003', 'this question about completely unrelated work', 'nope')`,
    ).run();

    await recordOutcome({ db, decisionId: 'd-003', outcome: 'failed' });

    const nb = db
      .prepare(`SELECT content FROM topic_notebooks WHERE topic_name='search-provider'`)
      .get();

    expect(nb).toBeUndefined();
  });

  it('TC4: upsert failure does NOT throw from recordOutcome', async () => {
    // Drop topic_notebooks so the INSERT fails — but recordOutcome should still succeed.
    db.exec(`DROP TABLE topic_notebooks`);
    db.prepare(`INSERT INTO topics (name) VALUES ('search-provider')`).run();
    db.prepare(
      `INSERT INTO brain_decisions (id, question, decision) VALUES ('d-004', 'search-provider proxy check', 'check it')`,
    ).run();

    // Should not throw even though topic_notebooks is gone.
    await expect(
      recordOutcome({ db, decisionId: 'd-004', outcome: 'success' }),
    ).resolves.not.toThrow();
  });
});
