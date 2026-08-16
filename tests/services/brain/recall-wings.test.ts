/**
 * Phase 78a-04 / Task 2 — recallMemory wings filter spec.
 *
 * Asserts the new `wings: string[]` parameter on `recallMemory()`:
 *   1. Backward compat — no `wings` arg → cross-wing baseline behavior
 *      (palace + decisions + clusters all participate; identical to pre-78a).
 *   2. Empty `wings: []` → identical to no-arg case (documented empty-array
 *      semantics).
 *   3. Single-wing filter — `wings: ['decisions']` → only palace hits whose
 *      `metadata.wing === 'decisions'` survive; brain_decisions /
 *      brain_action_clusters merges are dropped (no wing column in 78a).
 *
 * Palace is stubbed via a minimal PalaceClient mock that returns deterministic
 * JSON. brain_decisions / brain_action_clusters use a fresh in-memory SQLite
 * with the same shape as the real schema.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { recallMemory } from '../../../src/services/brain/recall.js';
import type { PalaceClient } from '../../../src/intelligence/palace-client.js';

interface PalaceCall {
  pattern: string;
  topicId: string | undefined;
  limit: number;
}

/**
 * Minimal stub. We only exercise `.search()` and `.isConnected`; the rest of
 * PalaceClient is irrelevant to recallMemory.
 */
function makePalaceStub(rawJson: string): {
  client: PalaceClient;
  calls: PalaceCall[];
} {
  const calls: PalaceCall[] = [];
  const client = {
    isConnected: true,
    async search(pattern: string, topicId: string | undefined, limit: number) {
      calls.push({ pattern, topicId, limit });
      return rawJson;
    },
  } as unknown as PalaceClient;
  return { client, calls };
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
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
  return db;
}

/** Sample palace payload covering two wings: 'decisions' and 'meetings'. */
const PALACE_PAYLOAD = JSON.stringify([
  {
    id: 'p-dec-1',
    snippet: 'Decision: pick X over Y',
    score: 0.9,
    timestamp: 1_700_000_000_000,
    metadata: { wing: 'decisions', room: 'tech' },
  },
  {
    id: 'p-meet-1',
    snippet: 'Meeting note: project sync',
    score: 0.8,
    timestamp: 1_700_000_000_000,
    metadata: { wing: 'meetings', room: 'sync' },
  },
  {
    id: 'p-untagged-1',
    snippet: 'Untagged result',
    score: 0.7,
    timestamp: 1_700_000_000_000,
    // metadata absent — should drop under any non-empty wings filter
  },
]);

describe('recallMemory — wings parameter (78a-04 / Task 2)', () => {
  let db: Database.Database;
  let palace: PalaceClient;
  let palaceCalls: PalaceCall[];

  beforeEach(() => {
    db = freshDb();
    // Seed two brain_decisions rows so the merge has SOMETHING to drop in
    // the wings-active case.
    db.prepare(
      `INSERT INTO brain_decisions
        (id, question, decision, rationale, confidence, created_at)
        VALUES ('dec-1', 'foo decision?', 'foo', 'because foo', 0.8, ?)`,
    ).run(Date.now());
    db.prepare(
      `INSERT INTO brain_decisions
        (id, question, decision, rationale, confidence, created_at)
        VALUES ('dec-2', 'foo other?', 'foo other', 'because', 0.6, ?)`,
    ).run(Date.now());

    const stub = makePalaceStub(PALACE_PAYLOAD);
    palace = stub.client;
    palaceCalls = stub.calls;
  });

  it('backward compat: no wings arg returns cross-wing baseline (palace + decisions merged)', async () => {
    const results = await recallMemory({ db, pattern: 'foo', palace });

    // Palace search invoked once with the trimmed pattern.
    expect(palaceCalls).toHaveLength(1);
    expect(palaceCalls[0].pattern).toBe('foo');

    // Decisions lane participates — at least one `source: 'decision'` row.
    const decisionResults = results.filter((r) => r.source === 'decision');
    expect(decisionResults.length).toBeGreaterThan(0);

    // All three palace hits survive (no wings filter applied).
    const palaceResults = results.filter((r) => r.source === 'palace');
    expect(palaceResults.length).toBe(3);
  });

  it('empty wings: [] is identical to no-arg case', async () => {
    const results = await recallMemory({ db, pattern: 'foo', palace, wings: [] });

    // Decisions lane participates (no wings → cross-wing path).
    const decisionResults = results.filter((r) => r.source === 'decision');
    expect(decisionResults.length).toBeGreaterThan(0);

    // All palace hits pass through unfiltered.
    const palaceResults = results.filter((r) => r.source === 'palace');
    expect(palaceResults.length).toBe(3);
  });

  it("phase 79-01: wings filter no longer drops SQLite lanes by default", async () => {
    const results = await recallMemory({
      db,
      pattern: 'foo',
      palace,
      wings: ['decisions'],
    });

    // Palace lane: wings still filters (unchanged from 78a-04).
    const palaceResults = results.filter((r) => r.source === 'palace');
    expect(palaceResults.length).toBe(1);
    expect(palaceResults[0].id).toBe('p-dec-1');

    // Phase 79-01: SQLite lanes now participate independently of wings.
    const decisionResults = results.filter((r) => r.source === 'decision');
    expect(decisionResults.length).toBeGreaterThan(0);
  });

  it("phase 79-01: sqliteLanes: false explicitly disables SQLite lanes", async () => {
    const results = await recallMemory({
      db,
      pattern: 'foo',
      palace,
      wings: ['decisions'],
      sqliteLanes: false,
    });

    // Palace lane: unchanged.
    const palaceResults = results.filter((r) => r.source === 'palace');
    expect(palaceResults.length).toBe(1);

    // SQLite lanes dropped by explicit opt-out.
    const decisionResults = results.filter((r) => r.source === 'decision');
    const clusterResults = results.filter((r) => r.source === 'cluster');
    expect(decisionResults.length).toBe(0);
    expect(clusterResults.length).toBe(0);
  });

  it("multi-wing filter: wings: ['decisions','meetings'] keeps both palace wings, drops untagged, and includes SQLite lanes", async () => {
    const results = await recallMemory({
      db,
      pattern: 'foo',
      palace,
      wings: ['decisions', 'meetings'],
    });

    const palaceResults = results.filter((r) => r.source === 'palace');
    expect(palaceResults.length).toBe(2);
    const ids = palaceResults.map((r) => r.id).sort();
    expect(ids).toEqual(['p-dec-1', 'p-meet-1']);

    // Phase 79-01: SQLite lanes also participate.
    const decisionResults = results.filter((r) => r.source === 'decision');
    expect(decisionResults.length).toBeGreaterThan(0);
  });

  it('wings filter on a non-matching wing returns zero palace rows but still returns SQLite hits', async () => {
    const results = await recallMemory({
      db,
      pattern: 'foo',
      palace,
      wings: ['life'],
    });
    const palaceResults = results.filter((r) => r.source === 'palace');
    expect(palaceResults.length).toBe(0);

    // Phase 79-01: SQLite lanes still return matches.
    const decisionResults = results.filter((r) => r.source === 'decision');
    expect(decisionResults.length).toBeGreaterThan(0);
  });
});
