/**
 * v70 — cypher_outcomes.failure_pattern (2026-06-25).
 *
 * Adds a nullable TEXT column to `cypher_outcomes` that holds a coarse
 * failure-mode tag classified at verdict-write time. v2.5 D8's
 * `cypher.self_assess` returns the top-3 failure modes for the winning
 * aggregation tier; this column is the source of those tags.
 *
 * v1 tags (Q-2.5.3 heuristic in src/services/cypher/self-assess.ts):
 *   - 'budget_exhaustion'  — outcome_note matches /budget/i
 *   - 'timeout'            — outcome_note matches /timeout/i OR duration_ms > 600000
 *   - 'iteration_cap'      — outcome='failed' AND iterations >= MAX_ITER
 *   - 'user_halt'          — outcome_note matches /halted|user stopped/i
 *   - 'unknown_failure'    — outcome='failed' and none of the above
 *
 * Population is forward-only:
 *   - The loop's verdict-write path (recordSkillOutcomes) calls
 *     classifyFailure() on verdict='failed' outcomes and writes the tag.
 *   - Historical rows stay NULL. self_assess() applies the heuristic
 *     on the fly when reading them — cheaper than a one-time backfill
 *     that locks the table on a 753-row corpus.
 *
 * When D2 (task memory; Gap 2 of ADR-038) ships its curator-driven
 * failure tagger, the curator simply writes to the same column. The
 * heuristic in self-assess.ts stays as the fallback for outcomes the
 * curator hasn't seen yet. Back-compatible upgrade — no API change.
 *
 * The partial index speeds up the top-3 failure-mode aggregation in
 * self_assess() without indexing the dominant NULL rows.
 *
 * See:
 *   - .planning/cypher/v2.5-D8-self-model-design.md § Q-2.5.3
 *   - .planning/cypher/v2.5-D8-self-model-design.md § Q-2.5.6 v70
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D8
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV70(db: Database.Database): void {
  // Idempotency check — only add column if absent. Survives the case
  // where a parallel branch advanced the schema past v70.
  const cols = db
    .prepare(`PRAGMA table_info(cypher_outcomes)`)
    .all() as ColumnInfoRow[];
  const hasFailurePattern = cols.some(c => c.name === 'failure_pattern');

  if (!hasFailurePattern) {
    db.exec(`ALTER TABLE cypher_outcomes ADD COLUMN failure_pattern TEXT NULL`);
  }

  // Index creation is independently idempotent (IF NOT EXISTS).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cypher_outcomes_failure_pattern
      ON cypher_outcomes(failure_pattern)
      WHERE failure_pattern IS NOT NULL
  `);
}
