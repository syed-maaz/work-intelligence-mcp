/**
 * Phase 71-03 — proactive-scan unit tests.
 *
 * Asserts the locked acceptance criteria from 71-03-PLAN.md:
 *   - Cooldown logic: same cluster pushed twice within 1h → only first pushes.
 *   - Threshold:      confidence=0.84 row not pushed; 0.85 row pushed.
 *   - Cluster signature derivation prefers evidence_json[0].signature, then .id,
 *     then row.id.
 *
 * In-memory SQLite — no bridge process, no Anthropic. Schema mirrors v45
 * brain_decisions + v38 proactive_queue exactly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  CONFIDENCE_THRESHOLD,
  COOLDOWN_MS,
  deriveClusterSignature,
  runProactiveScanOnce,
  type ProactiveScanState,
} from '../../src/services/brain/proactive-scan.js';

function freshState(): ProactiveScanState {
  return {
    lastPushedAt: new Map<string, number>(),
    ticks: 0,
    pushed: 0,
    skippedCooldown: 0,
    scanned: 0,
  };
}

function makeRow(
  db: Database.Database,
  args: {
    id: string;
    confidence: number;
    outcome?: string;
    created_at?: number;
    evidence?: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO brain_decisions
       (id, cache_key, question, user, day_iso, decision, rationale,
        confidence, evidence_json, next_actions_json, outcome,
        outcome_recorded_at, consumer, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    args.id,
    `cache_${args.id}`,
    `question_${args.id}`,
    'tester',
    '2026-05-18',
    `decision_${args.id}`,
    'rationale',
    args.confidence,
    args.evidence === undefined ? null : JSON.stringify(args.evidence),
    JSON.stringify([]),
    args.outcome ?? 'pending',
    'ui',
    args.created_at ?? Date.now(),
  );
}

describe('proactive-scan', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE brain_decisions (
        id TEXT PRIMARY KEY,
        cache_key TEXT NOT NULL UNIQUE,
        question TEXT NOT NULL,
        user TEXT NOT NULL,
        day_iso TEXT NOT NULL,
        decision TEXT NOT NULL,
        rationale TEXT,
        confidence REAL,
        evidence_json TEXT,
        next_actions_json TEXT,
        outcome TEXT,
        outcome_recorded_at INTEGER,
        consumer TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE proactive_queue (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent       TEXT NOT NULL,
        source_id   TEXT,
        type        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        read_at     TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe('threshold gate', () => {
    it('rejects rows with confidence below 0.85', () => {
      makeRow(db, { id: 'dec_low', confidence: 0.84 });

      const state = freshState();
      const pushed = runProactiveScanOnce(db, state);

      expect(pushed).toBe(0);
      expect(state.scanned).toBe(0); // SQL filters before iteration
      const queue = db.prepare(`SELECT * FROM proactive_queue`).all();
      expect(queue).toHaveLength(0);
    });

    it('accepts rows with confidence at exactly 0.85', () => {
      makeRow(db, { id: 'dec_edge', confidence: CONFIDENCE_THRESHOLD });

      const state = freshState();
      const pushed = runProactiveScanOnce(db, state);

      expect(pushed).toBe(1);
      expect(state.scanned).toBe(1);
      expect(state.pushed).toBe(1);
    });

    it('accepts rows with confidence above threshold', () => {
      makeRow(db, { id: 'dec_high', confidence: 0.92 });

      const state = freshState();
      const pushed = runProactiveScanOnce(db, state);

      expect(pushed).toBe(1);
      const queue = db
        .prepare(`SELECT agent, type, source_id FROM proactive_queue`)
        .all() as Array<{ agent: string; type: string; source_id: string }>;
      expect(queue).toHaveLength(1);
      expect(queue[0].agent).toBe('brain');
      expect(queue[0].type).toBe('brain_decision');
      expect(queue[0].source_id).toBe('dec_high');
    });

    it('skips rows where outcome is not pending', () => {
      makeRow(db, {
        id: 'dec_done',
        confidence: 0.99,
        outcome: 'accepted',
      });

      const state = freshState();
      const pushed = runProactiveScanOnce(db, state);

      expect(pushed).toBe(0);
      expect(state.scanned).toBe(0);
    });

    it('skips rows older than 7 days', () => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      makeRow(db, {
        id: 'dec_old',
        confidence: 0.99,
        created_at: eightDaysAgo,
      });

      const state = freshState();
      const pushed = runProactiveScanOnce(db, state);

      expect(pushed).toBe(0);
    });
  });

  describe('cooldown gate (T-71-02 mitigation)', () => {
    it('same cluster within 1h is pushed once and skipped on second tick', () => {
      const t0 = 1_700_000_000_000;
      makeRow(db, {
        id: 'dec_cluster',
        confidence: 0.9,
        evidence: [{ signature: 'cluster_alpha', id: 'evt-1' }],
        created_at: t0 - 1000,
      });

      const state = freshState();

      const first = runProactiveScanOnce(db, state, { now: () => t0 });
      expect(first).toBe(1);

      // Insert another decision in the SAME cluster (signature == cluster_alpha).
      makeRow(db, {
        id: 'dec_cluster_2',
        confidence: 0.95,
        evidence: [{ signature: 'cluster_alpha', id: 'evt-2' }],
        created_at: t0 + 1000,
      });

      // 1h later — still inside the 24h cooldown.
      const second = runProactiveScanOnce(db, state, {
        now: () => t0 + 60 * 60 * 1000,
      });
      expect(second).toBe(0);
      // Both `dec_cluster` and `dec_cluster_2` are still 'pending' so both
      // are scanned and both skipped on this tick.
      expect(state.skippedCooldown).toBe(2);

      // Queue saw exactly the first push.
      const queue = db
        .prepare(`SELECT source_id FROM proactive_queue ORDER BY id`)
        .all() as Array<{ source_id: string }>;
      expect(queue).toHaveLength(1);
      expect(queue[0].source_id).toBe('cluster_alpha');
    });

    it('same cluster after 24h cooldown is pushed again', () => {
      const t0 = 1_700_000_000_000;
      makeRow(db, {
        id: 'dec_recur',
        confidence: 0.9,
        evidence: [{ signature: 'cluster_beta' }],
        created_at: t0 - 1000,
      });

      const state = freshState();

      runProactiveScanOnce(db, state, { now: () => t0 });

      // Just past the 24h cooldown.
      const second = runProactiveScanOnce(db, state, {
        now: () => t0 + COOLDOWN_MS + 1,
      });
      expect(second).toBe(1);

      const queue = db.prepare(`SELECT id FROM proactive_queue`).all();
      expect(queue).toHaveLength(2);
    });

    it('different clusters in same tick all push', () => {
      makeRow(db, {
        id: 'dec_a',
        confidence: 0.9,
        evidence: [{ signature: 'cluster_a' }],
      });
      makeRow(db, {
        id: 'dec_b',
        confidence: 0.9,
        evidence: [{ signature: 'cluster_b' }],
      });
      makeRow(db, {
        id: 'dec_c',
        confidence: 0.9,
        evidence: [{ signature: 'cluster_c' }],
      });

      const state = freshState();
      const pushed = runProactiveScanOnce(db, state);

      expect(pushed).toBe(3);
      expect(state.lastPushedAt.size).toBe(3);
    });
  });

  describe('deriveClusterSignature', () => {
    const baseRow = {
      id: 'dec_xyz',
      decision: 'd',
      rationale: null,
      confidence: 0.9,
      next_actions_json: null,
      created_at: Date.now(),
    };

    it('prefers evidence_json[0].signature', () => {
      const sig = deriveClusterSignature({
        ...baseRow,
        evidence_json: JSON.stringify([
          { signature: 'sig-explicit', id: 'evt-1' },
        ]),
      });
      expect(sig).toBe('sig-explicit');
    });

    it('falls back to evidence_json[0].id', () => {
      const sig = deriveClusterSignature({
        ...baseRow,
        evidence_json: JSON.stringify([{ id: 'evt-only' }]),
      });
      expect(sig).toBe('evt-only');
    });

    it('falls back to row.id when evidence_json is null', () => {
      const sig = deriveClusterSignature({
        ...baseRow,
        evidence_json: null,
      });
      expect(sig).toBe('dec_xyz');
    });

    it('falls back to row.id when evidence_json is malformed', () => {
      const sig = deriveClusterSignature({
        ...baseRow,
        evidence_json: '{not json',
      });
      expect(sig).toBe('dec_xyz');
    });

    it('falls back to row.id when evidence_json is an empty array', () => {
      const sig = deriveClusterSignature({
        ...baseRow,
        evidence_json: '[]',
      });
      expect(sig).toBe('dec_xyz');
    });

    it('accepts a string evidence entry as the signature', () => {
      const sig = deriveClusterSignature({
        ...baseRow,
        evidence_json: JSON.stringify(['plain-string-evt']),
      });
      expect(sig).toBe('plain-string-evt');
    });
  });

  describe('payload shape', () => {
    it('serializes decision fields into proactive_queue.payload', () => {
      makeRow(db, {
        id: 'dec_payload',
        confidence: 0.91,
        evidence: [{ signature: 'cluster_payload', summary: 'foo' }],
      });

      const state = freshState();
      runProactiveScanOnce(db, state);

      const row = db
        .prepare(`SELECT payload FROM proactive_queue WHERE source_id = ?`)
        .get('cluster_payload') as { payload: string } | undefined;
      expect(row).toBeDefined();
      const parsed = JSON.parse(row!.payload);
      expect(parsed.decision_id).toBe('dec_payload');
      expect(parsed.confidence).toBeCloseTo(0.91);
      expect(parsed.cluster_signature).toBe('cluster_payload');
      expect(Array.isArray(parsed.evidence)).toBe(true);
      expect(parsed.evidence[0].summary).toBe('foo');
      expect(Array.isArray(parsed.next_actions)).toBe(true);
    });
  });
});
