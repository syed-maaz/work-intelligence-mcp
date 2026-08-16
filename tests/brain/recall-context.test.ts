/**
 * Unit tests for second-brain recall wiring (recall-context.ts).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildRecallPattern,
  formatRecallLine,
  patternFromBrainContext,
  fetchMemoryRelevantStrings,
} from '../../src/services/brain/recall-context.js';
import type { RecallResult } from '../../src/services/brain/recall.js';
import type { BrainContext } from '../../src/services/brain/context-builder.js';

function minimalBrainDb(): Database.Database {
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

describe('buildRecallPattern', () => {
  it('combines sprint, stuck keys, clusters, and question', () => {
    const p = buildRecallPattern({
      sprintName: 'Saturn Sprint 93',
      stuckKeys: ['DEMO-1234', 'DEMO-5678'],
      clusterSignatures: ['teams:sync timeout'],
      question: 'Should we escalate the blocker?',
    });
    expect(p).toContain('Saturn Sprint 93');
    expect(p).toContain('DEMO-1234');
    expect(p).toContain('teams:sync timeout');
    expect(p).toContain('escalate');
  });

  it('falls back when all inputs empty', () => {
    expect(buildRecallPattern({})).toBe('work intelligence sprint jira');
  });
});

describe('formatRecallLine', () => {
  it('formats source, id, snippet, and score', () => {
    const r: RecallResult = {
      source: 'decision',
      id: 'dec_ABC',
      snippet: 'Prior: ship the hotfix first',
      confidence: 0.8,
      score: 0.72,
      created_at: '2026-05-20T12:00:00.000Z',
    };
    const line = formatRecallLine(r);
    expect(line).toMatch(/^\[decision\] dec_ABC:/);
    expect(line).toContain('score 0.72');
  });
});

describe('patternFromBrainContext', () => {
  it('derives pattern from assembled context fields', () => {
    const ctx: BrainContext = {
      sprint: { name: 'Sprint 42', ends: '2026-06-01', fresh: true },
      stuck_jiras: [{ key: 'DEMO-99', days_stuck: 5, cluster: null }],
      noise_clusters: [{ signature: 'jira:stale', count: 3, actionable_root: 'sync' }],
      calendar_today: [],
      open_investigations: [],
      memory_relevant: [],
      stale_warnings: [],
    };
    const p = patternFromBrainContext(ctx);
    expect(p).toContain('Sprint 42');
    expect(p).toContain('DEMO-99');
    expect(p).toContain('jira:stale');
  });
});

describe('fetchMemoryRelevantStrings', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = minimalBrainDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO brain_decisions (
         id, cache_key, question, user, day_iso, decision, rationale, confidence,
         evidence_json, next_actions_json, outcome, consumer, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'pending', 'ui', ?)`,
    ).run(
      'dec_test1',
      'cache1',
      'How do we fix sprint blocker sync?',
      'tester',
      '2026-05-21',
      'Run teams-sync',
      'Prior outage matched this pattern',
      0.85,
      now,
    );
    db.prepare(
      `INSERT INTO brain_action_clusters (signature, count, first_seen, last_seen, root_cause, resolution)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('teams:sync timeout', 4, now - 86400000, now, 'OAuth refresh', 'npm run mcp-setup');
  });

  it('returns formatted decision and cluster lines without palace', async () => {
    // LIKE is substring match — use a token present in both seeded rows
    const lines = await fetchMemoryRelevantStrings({
      db,
      pattern: 'sync',
      palace: null,
      limit: 5,
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.startsWith('[decision]'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[cluster]'))).toBe(true);
  });

  it('returns empty array for blank pattern without throwing', async () => {
    const lines = await fetchMemoryRelevantStrings({ db, pattern: '   ', limit: 5 });
    expect(lines).toEqual([]);
  });
});
