/**
 * v72 — cypher_capability_summary VIEW (2026-06-25).
 *
 * Creates a read-only view that aggregates cypher_sessions joined to
 * cypher_outcomes (verdict signals only) for v2.5 D8's self_assess
 * tiered lookup. Each row is a wide aggregation slice keyed by
 * (posture, task_class, user, plan_shape_hash) with alpha/beta-style
 * counts plus iteration / token averages.
 *
 * The view is NOT materialized in v1 (Q-2.5.6 decision). At current
 * corpus size (~750 sessions, ~30 with plan_shape_hash), the aggregation
 * runs in single-digit ms. Materialization is a v2 upgrade when /
 * if the view ever crosses ~50 ms. SQLite views recompute on every
 * SELECT — for this corpus that's fine.
 *
 * Why filter on engine='loop':
 *   - v2.5 D8 only reasons about the tool-use loop's track record.
 *   - Legacy pipeline rows (engine='pipeline') are end-of-life per
 *     ADR-037 Phase 7 (landing 2026-07-21) — including them would
 *     pollute the posterior with shapes the loop will never see again.
 *
 * Why filter on posture IS NOT NULL:
 *   - v71 added the column; historical rows are NULL. NULL posture
 *     can't participate in the T1/T2 warm-tier aggregations
 *     (Q-2.5.1). Excluding them at the view level keeps T0 / T3
 *     fallback logic clean in selfAssess().
 *
 * Half-credit accounting for mixed outcomes (alpha_delta / beta_delta
 * each get 0.5) mirrors the pattern already in cap13-lite.ts.
 *
 * The avg_iterations / avg_tokens subqueries pull from cypher_sessions
 * via FK on session_id — the join column. SQLite optimizes the
 * correlated subquery fine for this corpus size.
 *
 * See:
 *   - .planning/cypher/v2.5-D8-self-model-design.md § Q-2.5.6 v72
 *   - src/services/cypher/cap13-lite.ts (mixed-outcome half-credit)
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D8
 */

import type Database from 'better-sqlite3';

interface ViewInfoRow { name: string }

export default function migrateV72(db: Database.Database): void {
  // Idempotency check — only create the view if absent. CREATE VIEW IF
  // NOT EXISTS is supported but explicit detection keeps the migration
  // symmetric with v70/v71 and lets us upgrade the view body in a
  // future migration by dropping-and-recreating (not done in v72).
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'cypher_capability_summary'`)
    .all() as ViewInfoRow[];
  if (rows.length > 0) {
    return;
  }

  db.exec(`
    CREATE VIEW cypher_capability_summary AS
    SELECT
      s.posture                                   AS posture,
      s.task_class                                AS task_class,
      s.user                                      AS user,
      s.plan_shape_hash                           AS plan_shape_hash,
      COUNT(o.id)                                 AS n_outcomes,
      SUM(CASE WHEN o.value = 'success' THEN 1.0
               WHEN o.value = 'mixed'   THEN 0.5
               ELSE 0.0 END)                      AS alpha_delta,
      SUM(CASE WHEN o.value = 'failed' THEN 1.0
               WHEN o.value = 'mixed'  THEN 0.5
               ELSE 0.0 END)                      AS beta_delta,
      AVG(s.duration_ms)                          AS avg_duration_ms,
      AVG(s.total_tokens)                         AS avg_tokens
    FROM cypher_sessions s
    LEFT JOIN cypher_outcomes o
      ON o.session_id = s.session_id
     AND o.signal_kind = 'verdict'
    WHERE s.engine = 'loop'
      AND s.posture IS NOT NULL
    GROUP BY s.posture, s.task_class, s.user, s.plan_shape_hash
  `);
}
