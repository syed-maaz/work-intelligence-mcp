/**
 * v73 — Cypher v2.5 D8 substrate bugfix: capability_summary view reads
 *       the canonical session-level outcome (2026-06-25).
 *
 * The v72 view incorrectly aggregated `cypher_outcomes.value`, which
 * is REAL-valued (VERDICT_SUCCESS=0.8 / VERDICT_MIXED=0.0 /
 * VERDICT_FAILED=-0.8 — see src/services/cypher/outcomes.ts:35–37).
 * The Q-2.5 design called for string-keyed accounting against
 * `cypher_sessions.outcome` (success | mixed | failed), which is the
 * authoritative human-readable verdict.
 *
 * This migration drops + recreates the view to aggregate on
 * `s.outcome` instead. The shape is identical (posture, task_class,
 * user, plan_shape_hash → n_outcomes, alpha_delta, beta_delta,
 * avg_duration_ms, avg_tokens) — selfAssess() consumers don't need
 * to change.
 *
 * We DROP the prior view (DROP VIEW IF EXISTS) before re-creating
 * because sqlite views aren't ALTER-able. Idempotent.
 *
 * The view no longer joins cypher_outcomes at all — the session row
 * has the verdict we want. This also fixes a counting bug: v72
 * counted `cypher_outcomes` rows via LEFT JOIN, so sessions with
 * multiple outcome rows (e.g. one verdict + several rerun rows)
 * would get over-counted. v73 counts each session exactly once.
 *
 * See:
 *   - src/services/cypher/outcomes.ts § VERDICT_SUCCESS constants
 *   - src/services/cypher/loop.ts § persistOutcome (writes the
 *     string outcome onto cypher_sessions AND the numeric value
 *     onto cypher_outcomes — both, intentionally)
 *   - .planning/cypher/v2.5-D8-self-model-design.md § Q-2.5.6 v72
 *     (the original design — corrected here)
 */

import type Database from 'better-sqlite3';

export default function migrateV73(db: Database.Database): void {
  db.exec(`DROP VIEW IF EXISTS cypher_capability_summary`);
  db.exec(`
    CREATE VIEW cypher_capability_summary AS
    SELECT
      s.posture                                   AS posture,
      s.task_class                                AS task_class,
      s.user                                      AS user,
      s.plan_shape_hash                           AS plan_shape_hash,
      COUNT(*)                                    AS n_outcomes,
      SUM(CASE WHEN s.outcome = 'success' THEN 1.0
               WHEN s.outcome = 'mixed'   THEN 0.5
               ELSE 0.0 END)                      AS alpha_delta,
      SUM(CASE WHEN s.outcome = 'failed' THEN 1.0
               WHEN s.outcome = 'mixed'  THEN 0.5
               ELSE 0.0 END)                      AS beta_delta,
      AVG(s.duration_ms)                          AS avg_duration_ms,
      AVG(s.total_tokens)                         AS avg_tokens
    FROM cypher_sessions s
    WHERE s.engine = 'loop'
      AND s.posture IS NOT NULL
      AND s.outcome IS NOT NULL
    GROUP BY s.posture, s.task_class, s.user, s.plan_shape_hash
  `);
}
