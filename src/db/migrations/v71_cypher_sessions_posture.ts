/**
 * v71 — cypher_sessions.posture (2026-06-25).
 *
 * Adds a nullable TEXT column to `cypher_sessions` holding the loop
 * posture for each dispatch (pr-review | bug-investigate | pm | generic;
 * see src/services/cypher/tool-catalog.ts).
 *
 * Why a column instead of deriving from plan_shape_hash:
 *   - The hash is computed as sha(canonical_json({posture, tool_sequence}))
 *     — see loop.ts:316–319. Reversing it requires enumerating every
 *     (posture × tool_sequence) combination. Impractical.
 *   - The plan_shape_gap_observed table (v69) does store posture per
 *     hash, but it's sparse — only rows where the recognition gate
 *     fires (rate < 0.3 AND n >= 5). v2.5 D8's T1/T2/T3 aggregation
 *     tiers (Q-2.5.1) need posture on EVERY session, not just the
 *     gap-firing minority.
 *   - A column on cypher_sessions is one ALTER + a one-line write-path
 *     change. Zero ongoing cost; pays back forever.
 *
 * Population is forward-only:
 *   - The loop's session-write path (createSession in run-loop.ts and
 *     wherever the dispatch row is inserted) writes opts.posture when
 *     present.
 *   - Historical rows stay NULL. v2.5 D8's selfAssess() treats
 *     posture IS NULL as ineligible for the T1/T2/T3 warm tiers (they
 *     only contribute to T3's uniform Beta(1,1) prior, which is the
 *     right honest fallback).
 *
 * The composite index supports the warm-tier query:
 *   SELECT ... FROM cypher_sessions
 *   WHERE posture = ? AND task_class = ? AND user = ?
 *
 * which is the T1 read in src/services/cypher/self-assess.ts.
 *
 * See:
 *   - .planning/cypher/v2.5-D8-self-model-design.md § Q-2.5.6 v71
 *   - src/services/cypher/tool-catalog.ts (the Posture type)
 *   - src/services/cypher/loop.ts:316–319 (the plan_shape_hash formula)
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D8
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV71(db: Database.Database): void {
  // Idempotency check — only add column if absent. Survives the case
  // where a parallel branch advanced the schema past v71.
  const cols = db
    .prepare(`PRAGMA table_info(cypher_sessions)`)
    .all() as ColumnInfoRow[];
  const hasPosture = cols.some(c => c.name === 'posture');

  if (!hasPosture) {
    db.exec(`ALTER TABLE cypher_sessions ADD COLUMN posture TEXT NULL`);
  }

  // Index creation is independently idempotent (IF NOT EXISTS).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cypher_sessions_posture
      ON cypher_sessions(posture, task_class, user)
  `);
}
