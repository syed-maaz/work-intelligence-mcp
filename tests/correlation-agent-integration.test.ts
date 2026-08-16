/**
 * Integration test for CorrelationAgent wiring logic.
 * Tests the timer/queue pipeline: palace skip, dedup guard, queue insertion, payload structure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { CorrelationAgent } from '../src/services/correlation-agent.js';

// ── Test helpers ────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE topics (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      config TEXT
    );
    CREATE TABLE proactive_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      source_id TEXT,
      type TEXT NOT NULL,
      payload TEXT,
      read_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function createMockPalace(connected: boolean, tripleMap: Record<string, string[]> = {}) {
  return {
    isConnected: connected,
    kgQuery: vi.fn(async (entity: string) => {
      const subjects = tripleMap[entity] || [];
      if (subjects.length === 0) return null;
      return JSON.stringify({
        triples: subjects.map(s => ({ subject: s, predicate: 'related_to', object: entity })),
      });
    }),
    // Satisfy PalaceClient interface minimally
    traverse: vi.fn(),
    search: vi.fn(),
    addDrawer: vi.fn(),
    kgAdd: vi.fn(),
    diaryWrite: vi.fn(),
    callToolRaw: vi.fn(),
    recordQuery: vi.fn(),
    stats: {},
    invalidateGraphCache: vi.fn(),
  } as any;
}

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      beta = {
        promptCaching: {
          messages: {
            create: vi.fn(async () => ({
              content: [
                {
                  type: 'tool_use',
                  id: 'test',
                  name: 'summarize_convergence',
                  input: { summary: 'Both topics share deployment pipeline concerns.' },
                },
              ],
            })),
          },
        },
      };
    },
  };
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('CorrelationAgent integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('skips when palace.isConnected is false (no queue entry created)', async () => {
    const palace = createMockPalace(false);
    db.prepare("INSERT INTO topics (name) VALUES (?)").run('TopicA');
    db.prepare("INSERT INTO topics (name) VALUES (?)").run('TopicB');

    const agent = new CorrelationAgent(db, palace, 'test-key');
    const digest = await agent.generateDigest();

    expect(digest).toBeNull();
    const row = db.prepare("SELECT * FROM proactive_queue WHERE agent = 'CorrelationAgent'").get();
    expect(row).toBeUndefined();
  });

  it('skips when isDuplicateWithin24h returns true', () => {
    const palace = createMockPalace(true);
    // Insert a recent entry
    db.prepare(`
      INSERT INTO proactive_queue (agent, source_id, type, payload, created_at)
      VALUES ('CorrelationAgent', 'correlation-2026-05-03', 'nightly_digest', '{}', datetime('now'))
    `).run();

    const agent = new CorrelationAgent(db, palace, 'test-key');
    expect(agent.isDuplicateWithin24h()).toBe(true);
  });

  it('writes to proactive_queue when digest is non-null', async () => {
    const palace = createMockPalace(true, {
      'TopicA': ['entity1', 'entity2', 'entity3'],
      'TopicB': ['entity2', 'entity3', 'entity4'],
      'TopicC': ['entity5'],
    });
    db.prepare("INSERT INTO topics (name) VALUES (?)").run('TopicA');
    db.prepare("INSERT INTO topics (name) VALUES (?)").run('TopicB');
    db.prepare("INSERT INTO topics (name) VALUES (?)").run('TopicC');

    const agent = new CorrelationAgent(db, palace, 'test-key');
    const digest = await agent.generateDigest();

    expect(digest).not.toBeNull();
    expect(digest!.pairs.length).toBeGreaterThan(0);

    // Simulate the web-server.js queue write
    const payload = JSON.stringify(digest);
    const sourceId = `correlation-${digest!.generated_at.slice(0, 10)}`;
    db.prepare(`
      INSERT INTO proactive_queue (agent, source_id, type, payload)
      VALUES ('CorrelationAgent', ?, 'nightly_digest', ?)
    `).run(sourceId, payload);

    const row = db.prepare("SELECT * FROM proactive_queue WHERE agent = 'CorrelationAgent'").get() as any;
    expect(row).toBeDefined();
    expect(row.type).toBe('nightly_digest');
    expect(row.agent).toBe('CorrelationAgent');
  });

  it('source_id follows date-based pattern (correlation-YYYY-MM-DD)', async () => {
    const palace = createMockPalace(true, {
      'TopicA': ['entity1', 'entity2'],
      'TopicB': ['entity1', 'entity3'],
    });
    db.prepare("INSERT INTO topics (name) VALUES (?)").run('TopicA');
    db.prepare("INSERT INTO topics (name) VALUES (?)").run('TopicB');

    const agent = new CorrelationAgent(db, palace, 'test-key');
    const digest = await agent.generateDigest();
    expect(digest).not.toBeNull();

    const sourceId = `correlation-${digest!.generated_at.slice(0, 10)}`;
    expect(sourceId).toMatch(/^correlation-\d{4}-\d{2}-\d{2}$/);
  });

  it('payload contains pairs array with topic_a, topic_b, shared_entities, summary', async () => {
    const palace = createMockPalace(true, {
      'TopicA': ['shared1', 'shared2', 'onlyA'],
      'TopicB': ['shared1', 'shared2', 'onlyB'],
    });
    db.prepare("INSERT INTO topics (name) VALUES (?)").run('TopicA');
    db.prepare("INSERT INTO topics (name) VALUES (?)").run('TopicB');

    const agent = new CorrelationAgent(db, palace, 'test-key');
    const digest = await agent.generateDigest();
    expect(digest).not.toBeNull();

    const pair = digest!.pairs[0];
    expect(pair).toHaveProperty('topic_a');
    expect(pair).toHaveProperty('topic_b');
    expect(pair).toHaveProperty('shared_entities');
    expect(pair).toHaveProperty('summary');
    expect(Array.isArray(pair.shared_entities)).toBe(true);
    expect(pair.shared_entities.length).toBeGreaterThan(0);
    expect(typeof pair.summary).toBe('string');
    expect(pair.summary.length).toBeGreaterThan(0);
  });
});
