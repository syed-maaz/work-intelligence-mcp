/**
 * Unit tests for CorrelationAgent — Phase 65 Plan 01
 *
 * Tests KG traversal, pairwise scoring, Haiku summarization, and 24h dedup guard.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CorrelationAgent } from '../../src/services/correlation-agent.js';

// Mock Anthropic SDK
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: vi.fn().mockImplementation(function(this: any) {
    this.beta = { promptCaching: { messages: { create: mockCreate } } };
  }),
}));

// Mock PalaceClient
function createMockPalace(connected: boolean, kgResponses: Record<string, string> = {}) {
  return {
    get isConnected() { return connected; },
    kgQuery: vi.fn(async (entity: string) => kgResponses[entity] ?? '{"triples":[]}'),
    traverse: vi.fn(),
    search: vi.fn(),
  };
}

// Sample KG responses with shared entities
const KG_TOPIC_A = JSON.stringify({
  triples: [
    { subject: 'entity-auth', predicate: 'relates_to', object: 'TopicA' },
    { subject: 'entity-shared', predicate: 'relates_to', object: 'TopicA' },
    { subject: 'entity-only-a', predicate: 'relates_to', object: 'TopicA' },
  ],
});

const KG_TOPIC_B = JSON.stringify({
  triples: [
    { subject: 'entity-shared', predicate: 'relates_to', object: 'TopicB' },
    { subject: 'entity-auth', predicate: 'relates_to', object: 'TopicB' },
    { subject: 'entity-only-b', predicate: 'relates_to', object: 'TopicB' },
  ],
});

const KG_TOPIC_C = JSON.stringify({
  triples: [
    { subject: 'entity-shared', predicate: 'relates_to', object: 'TopicC' },
    { subject: 'entity-only-c', predicate: 'relates_to', object: 'TopicC' },
  ],
});

describe('CorrelationAgent', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();

    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        config TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE proactive_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        source_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        read_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe('findCorrelations', () => {
    it('returns empty array when palace is disconnected', async () => {
      const palace = createMockPalace(false);
      const agent = new CorrelationAgent(db, palace as any, 'test-key');
      const result = await agent.findCorrelations();
      expect(result).toEqual([]);
      expect(palace.kgQuery).not.toHaveBeenCalled();
    });

    it('returns empty array when fewer than 2 topics exist', async () => {
      db.prepare('INSERT INTO topics (name) VALUES (?)').run('OnlyOne');
      const palace = createMockPalace(true);
      const agent = new CorrelationAgent(db, palace as any, 'test-key');
      const result = await agent.findCorrelations();
      expect(result).toEqual([]);
    });

    it('returns pairs sorted by shared entity count descending', async () => {
      db.prepare('INSERT INTO topics (name) VALUES (?)').run('TopicA');
      db.prepare('INSERT INTO topics (name) VALUES (?)').run('TopicB');
      db.prepare('INSERT INTO topics (name) VALUES (?)').run('TopicC');

      const palace = createMockPalace(true, {
        TopicA: KG_TOPIC_A,
        TopicB: KG_TOPIC_B,
        TopicC: KG_TOPIC_C,
      });

      const agent = new CorrelationAgent(db, palace as any, 'test-key');
      const result = await agent.findCorrelations();

      // TopicA-TopicB share 2 entities (entity-auth, entity-shared)
      // TopicA-TopicC share 1 entity (entity-shared)
      // TopicB-TopicC share 1 entity (entity-shared)
      expect(result[0].topic_a).toBe('TopicA');
      expect(result[0].topic_b).toBe('TopicB');
      expect(result[0].shared_entities).toHaveLength(2);
      expect(result[0].shared_entities).toContain('entity-auth');
      expect(result[0].shared_entities).toContain('entity-shared');
    });

    it('defaults topN to 3 and respects configurable limit', async () => {
      // Insert 5 topics with overlapping entities to get > 3 pairs
      for (let i = 1; i <= 5; i++) {
        db.prepare('INSERT INTO topics (name) VALUES (?)').run(`T${i}`);
      }

      const kgResponses: Record<string, string> = {};
      for (let i = 1; i <= 5; i++) {
        kgResponses[`T${i}`] = JSON.stringify({
          triples: [
            { subject: 'common-entity', predicate: 'relates_to', object: `T${i}` },
            { subject: `unique-${i}`, predicate: 'relates_to', object: `T${i}` },
          ],
        });
      }

      const palace = createMockPalace(true, kgResponses);
      const agent = new CorrelationAgent(db, palace as any, 'test-key');

      // Default topN = 3
      const resultDefault = await agent.findCorrelations();
      expect(resultDefault.length).toBeLessThanOrEqual(3);

      // Custom topN = 2
      const resultCustom = await agent.findCorrelations(2);
      expect(resultCustom.length).toBeLessThanOrEqual(2);
    });

    it('excludes pairs with zero shared entities', async () => {
      db.prepare('INSERT INTO topics (name) VALUES (?)').run('Isolated1');
      db.prepare('INSERT INTO topics (name) VALUES (?)').run('Isolated2');

      const palace = createMockPalace(true, {
        Isolated1: JSON.stringify({ triples: [{ subject: 'only-1', predicate: 'r', object: 'Isolated1' }] }),
        Isolated2: JSON.stringify({ triples: [{ subject: 'only-2', predicate: 'r', object: 'Isolated2' }] }),
      });

      const agent = new CorrelationAgent(db, palace as any, 'test-key');
      const result = await agent.findCorrelations();
      expect(result).toEqual([]);
    });
  });

  describe('generateDigest', () => {
    it('returns null when no correlations found', async () => {
      const palace = createMockPalace(false);
      const agent = new CorrelationAgent(db, palace as any, 'test-key');
      const result = await agent.generateDigest();
      expect(result).toBeNull();
    });

    it('calls Haiku and returns structured payload with pairs array', async () => {
      db.prepare('INSERT INTO topics (name) VALUES (?)').run('TopicA');
      db.prepare('INSERT INTO topics (name) VALUES (?)').run('TopicB');

      const palace = createMockPalace(true, {
        TopicA: KG_TOPIC_A,
        TopicB: KG_TOPIC_B,
      });

      mockCreate.mockResolvedValue({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_test',
            name: 'summarize_convergence',
            input: { summary: 'Both topics share auth and shared entities suggesting convergence.' },
          },
        ],
      });

      const agent = new CorrelationAgent(db, palace as any, 'test-key');
      const result = await agent.generateDigest();

      expect(result).not.toBeNull();
      expect(result!.pairs).toHaveLength(1);
      expect(result!.pairs[0].summary).toContain('convergence');
      expect(result!.pairs[0].topic_a).toBe('TopicA');
      expect(result!.pairs[0].topic_b).toBe('TopicB');
      expect(result!.generated_at).toBeDefined();
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('isDuplicateWithin24h', () => {
    it('returns true when recent entry exists in proactive_queue', () => {
      db.prepare(
        `INSERT INTO proactive_queue (agent, type, payload) VALUES (?, ?, ?)`
      ).run('CorrelationAgent', 'nightly_digest', '{}');

      const palace = createMockPalace(false);
      const agent = new CorrelationAgent(db, palace as any, 'test-key');
      expect(agent.isDuplicateWithin24h()).toBe(true);
    });

    it('returns false when no recent entry exists', () => {
      const palace = createMockPalace(false);
      const agent = new CorrelationAgent(db, palace as any, 'test-key');
      expect(agent.isDuplicateWithin24h()).toBe(false);
    });
  });
});
