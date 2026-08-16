/**
 * v74 — Cypher v2.5 D8 shadow-mode logging column (2026-06-25).
 *
 * Adds a nullable TEXT column to `cypher_sessions` that holds the JSON-
 * serialized SelfAssessment returned by selfAssess() at dispatch entry.
 * Per Q-2.5.7 § Soak protocol, the v1 D8 implementation ships in
 * SHADOW MODE: the loop's system prompt reads the assessment for the
 * model to consume, AND the assessment is persisted on the session row
 * for offline review. The orchestrator (D9) does NOT consume the
 * recommendation as a gate in v1 — promotion happens after a 2-week
 * soak when:
 *   - ≥ 100 dispatches have a non-empty self_assess_at_entry row
 *   - ≥ 5 distinct (posture, task_class) cells have N ≥ 5 warm priors
 *   - Manual review confirms recommendations are intuitive
 *
 * The column is nullable because:
 *   - Historical rows (pre-v74) stay NULL forever
 *   - When CAP13_LITE_ENABLED=0 or selfAssess() throws, the loop
 *     persists NULL rather than a half-formed assessment
 *   - The shadow-mode protocol's success metric is "≥ 100 NON-NULL rows"
 *
 * See:
 *   - .planning/cypher/v2.5-D8-self-model-design.md § Q-2.5.7 Soak
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D8
 *   - src/services/cypher/self-assess.ts (the writer's input shape)
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV74(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(cypher_sessions)`)
    .all() as ColumnInfoRow[];
  const hasCol = cols.some(c => c.name === 'self_assess_at_entry');

  if (!hasCol) {
    db.exec(`ALTER TABLE cypher_sessions ADD COLUMN self_assess_at_entry TEXT NULL`);
  }
}
