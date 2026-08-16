/**
 * Phase 69-06 — Smoke + single-consumer baseline test fixtures.
 *
 * Seeds three known-shape rows on `brain_decisions` with `consumer='ui'` ONLY.
 * Per ADR-024 line 311 and the 69-06 plan, this suite proves single-consumer
 * baseline behavior. Cross-consumer parity (UI / Atlas / MCP) is owned by
 * plan 70-05 — fixtures here MUST NOT iterate over the consumer set.
 *
 * Opens the live SQLite DB at the standard path (~/.work-intelligence-mcp/data.db
 * unless DATABASE_PATH is set) using `better-sqlite3` directly. WAL mode (set
 * by the bridge at boot) makes concurrent reads/writes safe — see
 * src/db/connection.ts.
 *
 * Helpers:
 *   - `openBrainTestDb()` — read/write handle on the shared DB.
 *   - `seedFixtures(db, opts?)` — insert 3 fixture rows, each with a unique
 *     `cache_key` so they cannot collide with the live decision-engine cache.
 *     Returns the inserted row metadata so tests can assert round-trip shape.
 *   - `cleanupFixtures(db, ids)` — delete rows by id. Keeps the live DB tidy
 *     between runs.
 *   - `selectFixtureRow(db, id)` — fetch a single row by id (typed) for
 *     round-trip assertions.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

export interface FixtureRow {
  id: string;
  cache_key: string;
  question: string;
  user: string;
  day_iso: string;
  decision: string;
  rationale: string;
  confidence: number;
  evidence_json: string;
  next_actions_json: string;
  outcome: string;
  consumer: string;
  created_at: number;
}

export type BrainTestDb = ReturnType<typeof openBrainTestDb>;

/**
 * Resolves the same default DB path that `src/db/connection.ts` uses.
 * Honors `DATABASE_PATH` (the bridge does too), so tests and the live bridge
 * always operate on the same file.
 */
export function resolveDbPath(): string {
  const envPath = process.env.DATABASE_PATH;
  if (envPath && envPath.trim().length > 0) return envPath;
  return path.join(os.homedir(), '.work-intelligence-mcp', 'data.db');
}

export function dbExists(): boolean {
  return existsSync(resolveDbPath());
}

/**
 * Open the live brain DB. We do NOT call `getDatabase()` from
 * `src/db/connection.ts` because that would re-run migrations on a singleton —
 * the bridge already owns the migration lifecycle. We open with WAL on (the
 * bridge already did this at boot) and a 5s busy timeout to ride out any
 * concurrent writer.
 */
export function openBrainTestDb(): Database.Database {
  const db = new Database(resolveDbPath(), { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  return db;
}

interface SeedOpts {
  /**
   * Embedded into each fixture's question + cache_key so concurrent test
   * runs (or repeat runs in the same UTC day) don't collide on the
   * `brain_decisions.cache_key` UNIQUE index.
   */
  runId?: string;
}

const FIXTURE_USER = 'USR12345-test-69-06';

/**
 * Seed three fixture rows on `brain_decisions`, all with `consumer='ui'`.
 *
 * Cache keys are derived from a synthetic question + a per-run nonce so we
 * never clash with the locked formula used by the decision-engine
 * (sha256(normalize(question)\x1F<user>\x1F<dayIsoUtc>)).
 */
export function seedFixtures(db: Database.Database, opts: SeedOpts = {}): FixtureRow[] {
  const runId = opts.runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dayIso = new Date().toISOString().slice(0, 10);
  const now = Date.now();

  const seeds: Array<Pick<FixtureRow, 'question' | 'decision' | 'rationale' | 'confidence' | 'evidence_json' | 'next_actions_json'>> = [
    {
      question: `[fixture-${runId}] should we ship?`,
      decision: 'Ship the feature today.',
      rationale: 'All blockers resolved and CI is green.',
      confidence: 0.82,
      evidence_json: JSON.stringify(['blocker DEMO-1 closed', 'CI green for 24h']),
      next_actions_json: JSON.stringify(['merge PR #42', 'announce in #releases']),
    },
    {
      question: `[fixture-${runId}] which sprint should pick up X?`,
      decision: 'Defer X to next sprint.',
      rationale: 'Current sprint is over-committed and X is not load-bearing.',
      confidence: 0.66,
      evidence_json: JSON.stringify(['sprint capacity at 110%', 'X has no downstream consumer this week']),
      next_actions_json: JSON.stringify(['add X to next sprint backlog', 'message stakeholder']),
    },
    {
      question: `[fixture-${runId}] is this a real BIS regression?`,
      decision: 'Treat as regression and open hotfix.',
      rationale: 'Reproduces in prod, was working last week, root cause is a feature flag rollout.',
      confidence: 0.91,
      evidence_json: JSON.stringify(['repro on master', 'last green was 2026-05-10', 'FF_X promoted PR #6107']),
      next_actions_json: JSON.stringify(['open BDS hotfix', 'rollback FF_X', 'notify on-call']),
    },
  ];

  const insert = db.prepare(`
    INSERT INTO brain_decisions (
      id, cache_key, question, user, day_iso, decision, rationale, confidence,
      evidence_json, next_actions_json, outcome, consumer, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'ui', ?)
  `);

  const inserted: FixtureRow[] = [];
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    const id = `dec_FIXTURE${runId.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16)}${i}`.slice(0, 30);
    // synthetic cache_key — sha256 of (question + runId + i). NOT the production
    // brainCacheKey() formula; we deliberately keep these distinct so live
    // /api/brain/decide cache_key collisions cannot happen.
    const cacheKey = createHash('sha256').update(`${seed.question}\x1f${runId}\x1f${i}`).digest('hex');
    insert.run(
      id,
      cacheKey,
      seed.question,
      FIXTURE_USER,
      dayIso,
      seed.decision,
      seed.rationale,
      seed.confidence,
      seed.evidence_json,
      seed.next_actions_json,
      now + i,
    );
    inserted.push({
      id,
      cache_key: cacheKey,
      question: seed.question,
      user: FIXTURE_USER,
      day_iso: dayIso,
      decision: seed.decision,
      rationale: seed.rationale,
      confidence: seed.confidence,
      evidence_json: seed.evidence_json,
      next_actions_json: seed.next_actions_json,
      outcome: 'pending',
      consumer: 'ui',
      created_at: now + i,
    });
  }
  return inserted;
}

export function cleanupFixtures(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM brain_decisions WHERE id IN (${placeholders})`).run(...ids);
}

export function selectFixtureRow(db: Database.Database, id: string): FixtureRow | undefined {
  return db
    .prepare(
      `SELECT id, cache_key, question, user, day_iso, decision, rationale, confidence,
              evidence_json, next_actions_json, outcome, consumer, created_at
       FROM brain_decisions WHERE id = ? LIMIT 1`,
    )
    .get(id) as FixtureRow | undefined;
}

export const FIXTURE_USER_ID = FIXTURE_USER;
