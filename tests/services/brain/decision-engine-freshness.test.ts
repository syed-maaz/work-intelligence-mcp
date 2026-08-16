/**
 * Phase 79-02 — hasNewerRelatedEvidence freshness guard.
 *
 * Tests the exported helper directly against an in-memory SQLite DB with
 * the same column shapes as the real schema:
 *   - topic_notebooks (topic_name, content, last_updated TEXT)
 *   - brain_verifications (id, claim, checked_at INTEGER)
 *
 * Two-case minimum per plan spec (Task 2.3).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { hasNewerRelatedEvidence } from '../../../src/services/brain/decision-engine.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE topic_notebooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_name TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      last_updated TEXT NOT NULL DEFAULT (datetime('now')),
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_id INTEGER,
      state_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE brain_verifications (
      id TEXT PRIMARY KEY,
      claim TEXT NOT NULL,
      verified INTEGER,
      evidence_json TEXT,
      confidence REAL,
      checked_at INTEGER NOT NULL
    );
  `);
  return db;
}

/** A minimal CacheRow shape matching the decision-engine's internal interface. */
function makeRow(overrides: Partial<{ id: string; question: string; decision: string; created_at: number }> = {}) {
  return {
    id: 'dec_TEST',
    question: 'use search-provider proxy for search integration',
    decision: 'use search-provider proxy for search integration',
    rationale: null,
    confidence: null,
    evidence_json: null,
    next_actions_json: null,
    outcome: 'pending',
    created_at: Date.now() - 60_000, // default: 1 minute ago
    ...overrides,
  };
}

describe('hasNewerRelatedEvidence (phase 79-02)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('returns true when a matching topic_notebook was updated after the cached decision', () => {
    const cachedAt = Date.now() - 30_000; // cached 30s ago
    const row = makeRow({ decision: 'search-provider proxy auth flow', created_at: cachedAt });

    // Insert a notebook that mentions 'search-provider' updated AFTER the cache row.
    const nowIso = new Date(Date.now()).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(
      `INSERT INTO topic_notebooks (topic_name, content, last_updated, message_count)
       VALUES (?, ?, ?, 1)`,
    ).run('search-provider Integration', 'search-provider proxy updated configuration notes', nowIso);

    expect(hasNewerRelatedEvidence(db, row)).toBe(true);
  });

  it('returns false when no matching notebooks or verifications are newer than the cached decision', () => {
    const cachedAt = Date.now(); // cached RIGHT NOW
    const row = makeRow({ decision: 'search-provider proxy auth flow', created_at: cachedAt });

    // Insert a notebook updated BEFORE the cache row (1 minute ago).
    const oldIso = new Date(cachedAt - 60_000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(
      `INSERT INTO topic_notebooks (topic_name, content, last_updated, message_count)
       VALUES (?, ?, ?, 1)`,
    ).run('search-provider Integration', 'search-provider proxy old notes', oldIso);

    expect(hasNewerRelatedEvidence(db, row)).toBe(false);
  });

  it('returns true when a matching brain_verification is newer than the cached decision', () => {
    const cachedAt = Date.now() - 30_000;
    const row = makeRow({ decision: 'search-provider proxy timeout setting', created_at: cachedAt });

    // Insert a verification about 'search-provider' with checked_at AFTER cachedAt.
    db.prepare(
      `INSERT INTO brain_verifications (id, claim, checked_at) VALUES (?, ?, ?)`,
    ).run('ver_001', 'search-provider proxy timeout is 10 seconds', Date.now());

    expect(hasNewerRelatedEvidence(db, row)).toBe(true);
  });

  it('returns false when decision text has no extractable keywords (≥4 chars)', () => {
    const row = makeRow({ decision: 'ok go do it now', created_at: Date.now() - 30_000 });

    // Even with a fresh notebook, no keywords to match.
    const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(
      `INSERT INTO topic_notebooks (topic_name, content, last_updated, message_count)
       VALUES (?, ?, ?, 1)`,
    ).run('anything', 'something relevant', nowIso);

    expect(hasNewerRelatedEvidence(db, row)).toBe(false);
  });

  it('returns false (no throw) when DB tables are empty', () => {
    const row = makeRow({ decision: 'investigate search-provider proxy latency issue' });
    expect(() => hasNewerRelatedEvidence(db, row)).not.toThrow();
    expect(hasNewerRelatedEvidence(db, row)).toBe(false);
  });

  // F4 regression: freshness guard MUST extract keywords from cachedRow.question,
  // not cachedRow.decision. If the LLM produced a generic decision ("Proceed with
  // the recommended approach") for a specific question ("search-provider proxy 401 errors"),
  // keyword extraction on .decision yields nothing domain-specific, and newer
  // search-provider-proxy evidence would not bypass the cache. The fix reads .question.
  it('F4: uses question (not decision) as keyword source for freshness matching', () => {
    // Simulate LLM producing generic decision text for a specific question.
    const cachedAt = Date.now() - 60_000;
    const row = makeRow({
      question: 'what should I do about the search-provider proxy 401 errors',
      decision: 'proceed with the recommended approach',
      created_at: cachedAt,
    });

    // Newer notebook about search-provider — should bypass cache once F4 is applied.
    const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(
      `INSERT INTO topic_notebooks (topic_name, content, last_updated, message_count)
       VALUES (?, ?, ?, 1)`,
    ).run('search-provider proxy investigation', 'new evidence about search-provider proxy retry', nowIso);

    expect(hasNewerRelatedEvidence(db, row)).toBe(true);
  });
});
