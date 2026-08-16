/**
 * Sprint 6 unit tests:
 * - context-ranker (EP-34)
 * - quality-checks (EP-33)
 * - relationship-detector (EP-39)
 * - ResourceCache (EP-31)
 * - logger (EP-31)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// ── context-ranker ─────────────────────────────────────────────────────────

import { rankContextItems, normalizeFtsRank } from '../../src/tools/context-ranker.js';
import type { ContextItem } from '../../src/services/analyzer.js';

describe('rankContextItems', () => {
  it('returns empty array for empty input', () => {
    expect(rankContextItems([])).toEqual([]);
  });

  it('preserves all items when count <= maxItems', () => {
    const items: ContextItem[] = [
      { source: 'a', title: 'A', content: 'hello' },
      { source: 'b', title: 'B', content: 'world' },
    ];
    const ranked = rankContextItems(items, { maxItems: 10 });
    expect(ranked).toHaveLength(2);
  });

  it('truncates to maxItems', () => {
    const items: ContextItem[] = Array.from({ length: 25 }, (_, i) => ({
      source: 'x',
      title: `Item ${i}`,
      content: `content ${i}`,
    }));
    const ranked = rankContextItems(items, { maxItems: 10 });
    expect(ranked).toHaveLength(10);
  });

  it('boosts recent items when timestamps provided', () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days ago
    const items: ContextItem[] = [
      { source: 'a', title: 'Old', content: 'old content', timestamp: old },
      { source: 'b', title: 'Recent', content: 'recent content', timestamp: recent },
    ];
    // With semanticWeight=0 (pure recency), recent should rank first
    const ranked = rankContextItems(items, { semanticWeight: 0 });
    expect(ranked[0].title).toBe('Recent');
  });

  it('uses BM25 position when semanticWeight=1', () => {
    const items: ContextItem[] = [
      { source: 'a', title: 'First', content: 'first' },
      { source: 'b', title: 'Second', content: 'second' },
      { source: 'c', title: 'Third', content: 'third' },
    ];
    // Position 0 (First) has highest BM25 proxy
    const ranked = rankContextItems(items, { semanticWeight: 1 });
    expect(ranked[0].title).toBe('First');
  });
});

describe('normalizeFtsRank', () => {
  it('returns 1 for rank 0', () => {
    expect(normalizeFtsRank(0)).toBe(1);
  });

  it('returns value between 0 and 1 for negative ranks', () => {
    const score = normalizeFtsRank(-5);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('more negative rank gives lower score', () => {
    expect(normalizeFtsRank(-100)).toBeLessThan(normalizeFtsRank(-1));
  });
});

// ── quality-checks ─────────────────────────────────────────────────────────

import { checkMessage, checkMeeting, checkActionItem } from '../../src/lib/quality-checks.js';
import type { MessageRow, MeetingRow, ActionItemRow } from '../../src/lib/quality-checks.js';

describe('checkMessage', () => {
  const baseMsg: MessageRow = {
    id: 1, content: 'Hello world, this is a normal message.',
    author: 'User', source_id: 'abc123',
  };

  it('returns no issues for a clean message', () => {
    expect(checkMessage(baseMsg)).toEqual([]);
  });

  it('flags null/empty content as garbled_content', () => {
    const issues = checkMessage({ ...baseMsg, content: '' });
    expect(issues.some(i => i.rule === 'garbled_content')).toBe(true);
  });

  it('flags content ending with ellipsis as truncated', () => {
    const issues = checkMessage({ ...baseMsg, content: 'Some message…' });
    expect(issues.some(i => i.rule === 'content_truncated')).toBe(true);
  });

  it('flags missing source_id', () => {
    const issues = checkMessage({ ...baseMsg, source_id: null });
    expect(issues.some(i => i.rule === 'missing_source_id')).toBe(true);
  });

  it('flags bot noise authors', () => {
    const issues = checkMessage({ ...baseMsg, author: 'serviceuser' });
    expect(issues.some(i => i.rule === 'bot_noise')).toBe(true);
  });
});

describe('checkMeeting', () => {
  const baseMeeting: MeetingRow = {
    id: 1,
    transcript: 'This is a long enough transcript. '.repeat(10),
    summary: 'Good meeting.',
  };

  it('returns no issues for a clean meeting', () => {
    expect(checkMeeting(baseMeeting)).toEqual([]);
  });

  it('flags short transcript', () => {
    const issues = checkMeeting({ ...baseMeeting, transcript: 'Too short' });
    expect(issues.some(i => i.rule === 'short_transcript')).toBe(true);
  });

  it('flags null transcript', () => {
    const issues = checkMeeting({ ...baseMeeting, transcript: null });
    expect(issues.some(i => i.rule === 'short_transcript')).toBe(true);
  });
});

describe('checkActionItem', () => {
  const baseItem: ActionItemRow = {
    id: 1, assignee: 'Alice',
  };

  it('returns no issues for a clean action item', () => {
    expect(checkActionItem(baseItem)).toEqual([]);
  });

  it('flags null assignee', () => {
    const issues = checkActionItem({ ...baseItem, assignee: null });
    expect(issues.some(i => i.rule === 'null_assignee')).toBe(true);
  });
});

// ── ResourceCache ──────────────────────────────────────────────────────────

import { ResourceCache } from '../../src/lib/resource-cache.js';

describe('ResourceCache', () => {
  let cache: ResourceCache<string>;

  beforeEach(() => {
    cache = new ResourceCache<string>(100); // 100ms TTL
  });

  it('returns null for missing key', () => {
    expect(cache.get('nope')).toBeNull();
  });

  it('stores and retrieves a value', () => {
    cache.set('k', 'hello');
    expect(cache.get('k')).toBe('hello');
  });

  it('reports has() correctly', () => {
    cache.set('k', 'v');
    expect(cache.has('k')).toBe(true);
    expect(cache.has('other')).toBe(false);
  });

  it('expires entries after TTL', async () => {
    cache.set('k', 'value');
    await new Promise(r => setTimeout(r, 120)); // wait > 100ms TTL
    expect(cache.get('k')).toBeNull();
  });

  it('invalidate removes specific key', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    cache.invalidate('a');
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe('2');
  });

  it('invalidateAll clears everything', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    cache.invalidateAll();
    expect(cache.size()).toBe(0);
  });

  it('getAge returns elapsed ms for valid entry', () => {
    cache.set('k', 'v');
    const age = cache.getAge('k');
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
  });

  it('getAge returns null for missing key', () => {
    expect(cache.getAge('nope')).toBeNull();
  });
});

// ── relationship-detector ─────────────────────────────────────────────────

import {
  detectJiraOverlaps,
  detectSharedPeople,
  saveRelationships,
  getRelationshipsForTopic,
} from '../../src/tools/relationship-detector.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE topics (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, topic_id INTEGER, content TEXT, subject TEXT);
    CREATE TABLE topic_notebooks (topic_name TEXT PRIMARY KEY, content TEXT);
    CREATE TABLE topic_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_a TEXT NOT NULL,
      topic_b TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      strength REAL NOT NULL,
      evidence TEXT,
      detected_at TEXT,
      UNIQUE(topic_a, topic_b, relationship_type)
    );
  `);
  return db;
}

describe('detectJiraOverlaps', () => {
  it('returns empty when no topics', () => {
    const db = makeDb();
    expect(detectJiraOverlaps(db)).toEqual([]);
  });

  it('detects overlap between two topics sharing Jira keys', () => {
    const db = makeDb();
    db.prepare('INSERT INTO topics (id, name) VALUES (?, ?)').run(1, 'Alpha');
    db.prepare('INSERT INTO topics (id, name) VALUES (?, ?)').run(2, 'Beta');
    db.prepare('INSERT INTO messages (id, topic_id, content, subject) VALUES (?, ?, ?, ?)').run(1, 1, 'Fixed DEMO-123 today', null);
    db.prepare('INSERT INTO messages (id, topic_id, content, subject) VALUES (?, ?, ?, ?)').run(2, 2, 'See DEMO-123 for details', null);
    const rels = detectJiraOverlaps(db);
    expect(rels.length).toBeGreaterThan(0);
    expect(rels[0].type).toBe('jira_overlap');
  });

  it('does not flag topics with no shared keys', () => {
    const db = makeDb();
    db.prepare('INSERT INTO topics (id, name) VALUES (?, ?)').run(1, 'Alpha');
    db.prepare('INSERT INTO topics (id, name) VALUES (?, ?)').run(2, 'Beta');
    db.prepare('INSERT INTO messages (id, topic_id, content, subject) VALUES (?, ?, ?, ?)').run(1, 1, 'See DEMO-001', null);
    db.prepare('INSERT INTO messages (id, topic_id, content, subject) VALUES (?, ?, ?, ?)').run(2, 2, 'See DEMO-999', null);
    const rels = detectJiraOverlaps(db);
    expect(rels).toEqual([]);
  });
});

describe('detectSharedPeople', () => {
  it('returns empty when no notebooks', () => {
    const db = makeDb();
    expect(detectSharedPeople(db)).toEqual([]);
  });

  it('detects shared people between notebooks', () => {
    const db = makeDb();
    const nbA = `## Key People\n- Smith, John — Engineer\n- Doe, Jane — Manager\n`;
    const nbB = `## Key People\n- Smith, John — Engineer\n- Brown, Bob — Designer\n`;
    db.prepare('INSERT INTO topic_notebooks (topic_name, content) VALUES (?, ?)').run('Alpha', nbA);
    db.prepare('INSERT INTO topic_notebooks (topic_name, content) VALUES (?, ?)').run('Beta', nbB);
    const rels = detectSharedPeople(db);
    expect(rels.length).toBeGreaterThan(0);
    expect(rels[0].type).toBe('shared_people');
  });
});

describe('saveRelationships and getRelationshipsForTopic', () => {
  it('round-trips relationships through the DB', () => {
    const db = makeDb();
    saveRelationships(db, [
      { topicA: 'Alpha', topicB: 'Beta', type: 'jira_overlap', strength: 0.5, evidence: 'DEMO-1' },
    ]);
    const rels = getRelationshipsForTopic(db, 'Alpha');
    expect(rels).toHaveLength(1);
    expect(rels[0].other).toBe('Beta');
    expect(rels[0].strength).toBe(0.5);
  });

  it('upserts on conflict', () => {
    const db = makeDb();
    saveRelationships(db, [{ topicA: 'A', topicB: 'B', type: 'jira_overlap', strength: 0.3, evidence: 'x' }]);
    saveRelationships(db, [{ topicA: 'A', topicB: 'B', type: 'jira_overlap', strength: 0.9, evidence: 'y' }]);
    const rels = getRelationshipsForTopic(db, 'A');
    expect(rels).toHaveLength(1);
    expect(rels[0].strength).toBe(0.9);
  });
});

// ── logger ─────────────────────────────────────────────────────────────────

import { logger } from '../../src/lib/logger.js';

describe('logger', () => {
  it('writes valid JSON to stderr for info', () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    logger.info('test message', { extra: 'data' });
    process.stderr.write = orig;
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('test message');
    expect(parsed.extra).toBe('data');
    expect(typeof parsed.ts).toBe('string');
  });

  it('includes level=error for error()', () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    logger.error('something broke');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('error');
  });
});
