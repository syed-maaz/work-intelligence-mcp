/**
 * Tests for src/intelligence/tools/call-graph-tracer.ts
 *
 * Closes ADR-027 v2 Path B follow-up #4 — proves the consumer-hint string
 * appended to empty-result summaries reflects sync_state truth.
 *
 * Three branches matter:
 *   1. sync_state has no row for code-graph-<repo>     → "indexer has not run yet"
 *   2. sync_state has a row but last_synced_at > 24h   → "indexer last ran Nh ago — graph may be stale"
 *   3. sync_state has a fresh row (< 24h)              → no hint (empty result is the real answer)
 *
 * Uses an in-memory better-sqlite3 DB seeded with the minimum schema the
 * tracer queries — no full migration, no real connection. Keeps the test
 * cheap (~1ms) and hermetic.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { traceCallGraph, type TraceInput } from '../../src/intelligence/tools/call-graph-tracer.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  // Match src/db/schema.ts:224-231 sync_state shape — only what the tracer
  // queries. Real schema has more columns; an in-memory DB needs none of them.
  db.exec(`
    CREATE TABLE sync_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id TEXT NOT NULL,
      source TEXT NOT NULL,
      last_synced_at TEXT,
      last_message_count INTEGER DEFAULT 0,
      UNIQUE(topic_id, source)
    );
    -- Empty code_graph so all queries return zero nodes/edges and the empty-
    -- summary branch fires; that's the only branch the hint is appended to.
    CREATE TABLE code_graph (
      file_path TEXT,
      ref_file TEXT,
      ref_type TEXT,
      ref_repo TEXT,
      repo TEXT
    );
  `);
  return db;
}

function setSyncState(db: Database.Database, repo: string, isoTs: string | null): void {
  db.prepare(
    `INSERT INTO sync_state (topic_id, source, last_synced_at) VALUES ('0', ?, ?)`
  ).run(`code-graph-${repo}`, isoTs);
}

const baseInput: TraceInput = {
  repo: 'example-service',
  startFile: 'src/no-such-file.ts',
  direction: 'callees',
  maxDepth: 2,
};

// Empty ownership map — irrelevant when nodes is empty.
const ownershipMap = [];

describe('call-graph-tracer indexer hint (ADR-027 Path B item #4)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('says "indexer has not run yet" when sync_state has no row for the repo', () => {
    const result = traceCallGraph(baseInput, db, ownershipMap);
    // Start node is always pushed (line 50); empty code_graph means zero
    // edges, so the "no references found" branch fires.
    expect(result.edges).toHaveLength(0);
    expect(result.summary).toMatch(/indexer has not run yet for this repo/);
    expect(result.summary).toMatch(/\/api\/system-health\.codeGraph/);
  });

  it('says "indexer has not run yet" when sync_state row exists but last_synced_at is null', () => {
    setSyncState(db, 'example-service', null);
    const result = traceCallGraph(baseInput, db, ownershipMap);
    expect(result.summary).toMatch(/indexer has not run yet/);
  });

  it('says "indexer last ran Nh ago" when sync_state is older than 24h', () => {
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    setSyncState(db, 'example-service', fortyEightHoursAgo);
    const result = traceCallGraph(baseInput, db, ownershipMap);
    // Floating-point window — "indexer last ran 47h ago" / "48h ago" both acceptable.
    expect(result.summary).toMatch(/indexer last ran (4[678])h ago — graph may be stale/);
    expect(result.summary).toMatch(/\/api\/system-health\.codeGraph/);
  });

  it('appends NO hint when sync_state is fresh (< 24h)', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    setSyncState(db, 'example-service', oneHourAgo);
    const result = traceCallGraph(baseInput, db, ownershipMap);
    // Empty-result message is still emitted, but with no parenthesized hint
    // appended after it.
    expect(result.summary).toMatch(/code_graph may not be indexed for this repo\.$/);
    expect(result.summary).not.toMatch(/indexer has not run/);
    expect(result.summary).not.toMatch(/graph may be stale/);
  });

  it('uses the right repo in the sentinel lookup (does not bleed across repos)', () => {
    // Fresh row for `ops` but nothing for `example-service` — the tracer
    // queries for example-service, must miss, must say "indexer has not run".
    setSyncState(db, 'ops', new Date().toISOString());
    const result = traceCallGraph({ ...baseInput, repo: 'example-service' }, db, ownershipMap);
    expect(result.summary).toMatch(/indexer has not run yet/);
  });

  it('falls through cleanly when sync_state.last_synced_at is unparseable', () => {
    setSyncState(db, 'example-service', 'not-an-iso-date');
    const result = traceCallGraph(baseInput, db, ownershipMap);
    // Date.parse → NaN → null → "indexer has not run yet" branch. Treating
    // garbage as "no signal" is the right move; the alternative (silently
    // suppressing the hint) hides the data corruption from the operator.
    expect(result.summary).toMatch(/indexer has not run yet/);
  });
});
