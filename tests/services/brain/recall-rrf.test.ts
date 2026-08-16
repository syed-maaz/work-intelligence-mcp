/**
 * Phase 79-5b — RRF merge + cosine recall integration tests.
 *
 * Tests:
 * 1. rrfMerge deduplication and score accumulation.
 * 2. rrfMerge respects limit.
 * 3. recallMemory with queryBlob=null falls back to LIKE-only (no cosine lanes).
 * 4. recallMemory with queryBlob fires cosine lanes and merges via RRF.
 * 5. cosine lanes are non-throwing on missing table / unregistered UDF.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { rrfMerge } from '../../../src/services/brain/rrf-merge.js';
import {
  queryMessageCosine,
  queryPromptMemoryCosine,
  queryDocCosine,
} from '../../../src/services/brain/recall-embeddings.js';
import { recallMemory } from '../../../src/services/brain/recall.js';
import { registerCosineUDF, float32ArrayToBlob } from '../../../src/services/brain/cosine-udf.js';

// ── rrfMerge unit tests ───────────────────────────────────────────────────

describe('rrfMerge', () => {
  it('single lane — scores as 1/(k+rank+1)', () => {
    const lane = [
      { id: 'a', score: 0.9, source: 's', snippet: 'A' },
      { id: 'b', score: 0.8, source: 's', snippet: 'B' },
    ];
    const result = rrfMerge([lane], 60, 5);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('b');
    // a: 1/(60+0+1) = 1/61 ≈ 0.01639
    expect(result[0].score).toBeCloseTo(1 / 61, 5);
  });

  it('cross-lane dedup accumulates contributions', () => {
    const lane1 = [{ id: 'x', score: 0.9, source: 'l1', snippet: 'X' }];
    const lane2 = [{ id: 'x', score: 0.7, source: 'l2', snippet: 'X' }];
    const [result] = rrfMerge([lane1, lane2], 60, 5);
    // x appears in rank 0 of both lanes: 1/61 + 1/61 = 2/61
    expect(result.id).toBe('x');
    expect(result.score).toBeCloseTo(2 / 61, 5);
  });

  it('respects limit', () => {
    const lane = Array.from({ length: 10 }, (_, i) => ({
      id: String(i), score: 1 - i * 0.1, source: 's', snippet: '',
    }));
    expect(rrfMerge([lane], 60, 3)).toHaveLength(3);
  });

  it('empty lanes return []', () => {
    expect(rrfMerge([], 60, 5)).toEqual([]);
    expect(rrfMerge([[]], 60, 5)).toEqual([]);
  });
});

// ── cosine query helpers — non-throwing on missing tables ─────────────────

describe('cosine query helpers — graceful degradation', () => {
  it('queryMessageCosine returns [] on empty DB (no table)', () => {
    const db = new Database(':memory:');
    const blob = Buffer.alloc(16); // dummy blob
    expect(queryMessageCosine(db, blob, 5)).toEqual([]);
  });

  it('queryPromptMemoryCosine returns [] on empty DB', () => {
    const db = new Database(':memory:');
    const blob = Buffer.alloc(16);
    expect(queryPromptMemoryCosine(db, blob, 5)).toEqual([]);
  });

  it('queryDocCosine returns [] on empty DB', () => {
    const db = new Database(':memory:');
    const blob = Buffer.alloc(16);
    expect(queryDocCosine(db, blob, 5)).toEqual([]);
  });
});

// ── cosine query with registered UDF + seeded data ────────────────────────

function makeVec(val: number, dim = 768): Float32Array {
  const arr = new Float32Array(dim);
  arr.fill(val);
  // Normalize so cosine = correlation of the fill values
  const norm = Math.sqrt(dim) * Math.abs(val);
  if (norm > 0) for (let i = 0; i < dim; i++) arr[i] = arr[i] / norm;
  return arr;
}

describe('cosine query helpers — with UDF and seeded data', () => {
  let db: Database.Database;
  let queryBlob: Buffer;

  beforeEach(() => {
    db = new Database(':memory:');
    registerCosineUDF(db);

    // Seed message_embeddings + messages
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE message_embeddings (
        message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL DEFAULT 'nomic-embed-text',
        embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Insert two messages with embeddings
    const vec1 = makeVec(1.0); // will be similar to query (all positive)
    const vec2 = makeVec(-1.0); // dissimilar (all negative)
    db.prepare('INSERT INTO messages VALUES (1, ?, 1700000000000)').run('search-provider proxy fix');
    db.prepare('INSERT INTO messages VALUES (2, ?, 1700000000000)').run('unrelated content');
    db.prepare('INSERT INTO message_embeddings VALUES (1, ?, ?, ?)').run(float32ArrayToBlob(vec1), 'nomic-embed-text', '2026-01-01');
    db.prepare('INSERT INTO message_embeddings VALUES (2, ?, ?, ?)').run(float32ArrayToBlob(vec2), 'nomic-embed-text', '2026-01-01');

    queryBlob = float32ArrayToBlob(makeVec(1.0));
  });

  it('returns the higher-cosine message first', () => {
    const results = queryMessageCosine(db, queryBlob, 5);
    expect(results.length).toBeGreaterThan(0);
    // message 1 (vec all-positive) should rank higher than message 2 (all-negative)
    expect(results[0].id).toBe('1');
    expect(results[0].score).toBeGreaterThan(0.9);
  });

  it('queryPromptMemoryCosine returns success/completed rows only', () => {
    db.exec(`
      CREATE TABLE cypher_sessions (session_id TEXT PRIMARY KEY);
      CREATE TABLE prompt_memory (
        session_id TEXT PRIMARY KEY REFERENCES cypher_sessions(session_id) ON DELETE CASCADE,
        goal TEXT NOT NULL,
        chosen_skill TEXT NOT NULL,
        outcome TEXT NOT NULL,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL DEFAULT 'nomic-embed-text',
        embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare('INSERT INTO cypher_sessions VALUES (?)').run('s1');
    db.prepare('INSERT INTO cypher_sessions VALUES (?)').run('s2');
    db.prepare('INSERT INTO prompt_memory VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      's1', 'fix search-provider proxy', 'wi-investigate', 'success', float32ArrayToBlob(makeVec(1.0)), 'nomic-embed-text', '2026-01-01',
    );
    db.prepare('INSERT INTO prompt_memory VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      's2', 'abandon task', 'wi-search', 'failed', float32ArrayToBlob(makeVec(1.0)), 'nomic-embed-text', '2026-01-01',
    );
    const results = queryPromptMemoryCosine(db, queryBlob, 5);
    expect(results).toHaveLength(1); // only 'success' row
    expect(results[0].id).toBe('s1');
    expect(results[0].snippet).toContain('→');
  });
});

// ── recallMemory with queryBlob=null falls back to LIKE ───────────────────

describe('recallMemory — queryBlob integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE brain_decisions (
        id TEXT PRIMARY KEY,
        cache_key TEXT,
        question TEXT,
        user TEXT,
        day_iso TEXT,
        decision TEXT,
        rationale TEXT,
        confidence REAL,
        evidence_json TEXT,
        next_actions_json TEXT,
        outcome TEXT,
        consumer TEXT,
        created_at INTEGER
      );
      CREATE TABLE brain_action_clusters (
        signature TEXT PRIMARY KEY,
        count INTEGER,
        first_seen INTEGER,
        last_seen INTEGER,
        root_cause TEXT,
        resolution TEXT
      );
    `);
    db.prepare(
      `INSERT INTO brain_decisions (id, question, decision, rationale, confidence, created_at)
       VALUES ('d1', 'search-provider proxy issue', 'fix it', 'because', 0.8, ?)`,
    ).run(Date.now());
  });

  it('queryBlob=null: cosine lanes skipped, LIKE still fires', async () => {
    const results = await recallMemory({
      db,
      pattern: 'search-provider',
      queryBlob: null,
    });
    const decisionHits = results.filter((r) => r.source === 'decision');
    expect(decisionHits.length).toBeGreaterThan(0);
    // No cosine sources present
    const cosineSources = results.filter((r) =>
      ['message_cosine', 'prompt_memory_cosine', 'doc_cosine'].includes(r.source),
    );
    expect(cosineSources).toHaveLength(0);
  });

  it('queryBlob provided: cosine helpers run (return [] gracefully on missing tables)', async () => {
    registerCosineUDF(db);
    const dummyBlob = float32ArrayToBlob(new Float32Array(768).fill(0.1));
    // Tables missing → cosine helpers return [], LIKE lanes still work
    const results = await recallMemory({
      db,
      pattern: 'search-provider',
      queryBlob: dummyBlob,
    });
    const decisionHits = results.filter((r) => r.source === 'decision');
    expect(decisionHits.length).toBeGreaterThan(0);
    // No crash
  });
});
