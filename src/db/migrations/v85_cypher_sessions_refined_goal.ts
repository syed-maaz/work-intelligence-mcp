/**
 * v85 — ADR-039 AC-3 (2026-06-26): cypher_sessions.refined_goal + scope_iters.
 *
 * ADR-039 ("Cypher Refinement Phase — Two-Pass Loop for Goal Scope Before
 * Execution") splits today's single-phase `runLoop` into two phases:
 *
 *   raw goal → SCOPE phase ──→ refined_goal (structured) ──→ EXECUTE phase
 *                  │                       │
 *                  └─→ scope_iters         │
 *                                          ▼
 *                             cypher_sessions.refined_goal
 *
 * This migration adds the persistence substrate for the SCOPE phase output:
 *
 *   - `refined_goal TEXT`        — JSON blob holding the structured brief
 *     (intent / target / constraints / success_criteria / out_of_scope /
 *      linkage / expected_output_shape / evidence_cited). Nullable because
 *     historical rows pre-date the SCOPE phase, and because the phase can
 *     halt with a clarifying question before the brief is complete (in
 *     which case the row stays NULL and re-dispatches on user reply).
 *
 *   - `scope_iters INTEGER DEFAULT 0` — refinement loop counter. The
 *     SCOPE phase exits when (a) the refiner emits a complete brief,
 *     OR (b) `scope_iters` reaches `CYPHER_SCOPE_MAX_ITERS` (default 3),
 *     OR (c) a clarifying-Q halt fires. Default 0 covers both new rows
 *     written by the loop AND legacy rows where the SCOPE phase never
 *     ran — the SQLite ALTER on an existing column sets the default for
 *     newly-inserted rows only; existing rows get NULL, which the loop
 *     reads as "no scope phase ran here" (equivalent to 0 for telemetry).
 *
 * Why this is v85 and not the v64 some early planning notes mention:
 *   v64 was taken by `v64_cypher_outcomes.ts` (ADR-034 L1.1 cypher_outcomes
 *   ledger, 2026-06-15), v65 by `v65_cypher_outcomes_legacy_upgrade.ts`.
 *   `CURRENT_SCHEMA_VERSION` is at 84 on master `b6d4454`. ADR-039 § AC-3
 *   pins this migration to v85 (next free slot). The card body's "v64"
 *   wording is stale; AC-3 is the binding contract.
 *
 * Idempotent: PRAGMA-checks `cypher_sessions` for each column before
 * issuing the ALTER. Survives the case where a parallel worktree
 * advanced the schema past v85 (same defense as v71 posture migration).
 *
 * Forward-only population: the loop's session-write path (in
 * src/services/cypher/loop.ts, wired by T6 + T7) writes `refined_goal`
 * when the SCOPE phase produced one and bumps `scope_iters` per
 * refinement round. Historical rows keep refined_goal=NULL,
 * scope_iters=NULL — both are treated by downstream queries as
 * "no scope phase observed for this session".
 *
 * No new indexes: refined_goal is read by session-id (already the
 * primary lookup) and scope_iters is only ever read for the dispatched
 * session's own row, so the existing `cypher_sessions` PK index covers
 * every query.
 *
 * See:
 *   - docs/docs/adr/adr-039-cypher-refinement-phase.md § AC-3
 *   - src/services/cypher/loop.ts (T6 wires the refined_goal write)
 *   - tests/cypher/refined-goal-schema.test.ts (AC-8 validates JSON shape)
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV85(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(cypher_sessions)`)
    .all() as ColumnInfoRow[];

  const hasRefinedGoal = cols.some(c => c.name === 'refined_goal');
  const hasScopeIters = cols.some(c => c.name === 'scope_iters');

  if (!hasRefinedGoal) {
    db.exec(`ALTER TABLE cypher_sessions ADD COLUMN refined_goal TEXT`);
  }

  if (!hasScopeIters) {
    // DEFAULT 0 applies to newly-inserted rows; existing rows get NULL.
    // Downstream queries treat both NULL and 0 as "no scope phase ran".
    db.exec(`ALTER TABLE cypher_sessions ADD COLUMN scope_iters INTEGER DEFAULT 0`);
  }
}
