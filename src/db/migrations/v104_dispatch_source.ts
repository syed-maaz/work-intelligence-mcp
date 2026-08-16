/**
 * v104 — dispatch_source column on cypher_sessions (write-time provenance).
 *
 * # Why
 *
 * Phase 0 of the fault-proof `/WI` loop (ADR-050) discovered that four
 * different agents produced four different M2 executor-success numbers
 * (35%, 50.7%, 66.9%, 70.9%) because none of them could reliably separate
 * real user dispatches from smoke-test / probe / agent-invoked dispatches.
 * All separations were reverse-engineered from `goal` text with LIKE
 * patterns, and every filter leaked in one direction or the other.
 *
 * See GATE-RESOLVED-2026-07-26.md §11 (H-12 → H-17) for the full chain of
 * measurement-filter errors. The debate discipline converged on the same
 * conclusion from three independent angles:
 *   - Agent 001: "add a write-time is_smoke / synthetic flag"
 *   - Agent D: "use task_class column at write time, not goal heuristics"
 *   - Agent H (5 iterations of failed filters): "string-heuristic filters
 *     CANNOT be complete against unlabeled data"
 *
 * The durable fix is a machine-readable provenance column set by the
 * caller at dispatch time. This migration adds it. Callers (smoke scripts,
 * board-worker-agent, agent-invoked-agent paths) are updated in the same
 * commit to set the correct value.
 *
 * # What's added
 *
 * `cypher_sessions.dispatch_source TEXT` with CHECK constraint enum:
 *   - 'user'    — real human dispatch (CLI, UI, direct API call by human)
 *   - 'smoke'   — smoke-test suite dispatch (scripts/smoke-*.sh, tests/**)
 *   - 'test'    — automated test harness dispatch
 *   - 'agent'   — agent-invoked-agent (BoardWorkerAgent, Claude Code Task,
 *                 cron scheduler, delegated tools)
 *   - 'unknown' — legacy rows / unspecified caller (default)
 *
 * NULL is disallowed via NOT NULL + DEFAULT 'unknown'. Legacy rows (all
 * pre-v104 sessions) get 'unknown' — no backfill attempted because that
 * would be another round of string-heuristic pattern-matching, which is
 * exactly the failure mode this migration exists to end. Downstream
 * measurement queries treat legacy rows honestly (as unknown provenance)
 * rather than pretending to have retroactive knowledge.
 *
 * # Callers updated in the same commit
 *
 * - `web-server.js` — 4 INSERT sites accept optional `body.dispatch_source`
 * - `src/services/cypher/run.ts` — INSERT site accepts dispatch_source arg
 *
 * Smoke script rollout is incremental (5 pilot scripts in the same commit;
 * remaining ~22 to be updated as they're touched). Unmarked legacy smoke
 * runs count as 'unknown' — still measurable, just not distinguishable
 * from unknown user rows until the source is patched.
 *
 * # Index
 *
 * Partial index on (dispatch_source, outcome) WHERE dispatch_source != 'unknown'
 * for measurement queries that filter to marked sources.
 *
 * # Idempotency
 *
 * ALTER TABLE ADD COLUMN with DEFAULT is safe to re-run because SQLite
 * detects the column exists and throws — wrapped in a try/catch that
 * treats "duplicate column" as no-op.
 *
 * See:
 *   - GATE-RESOLVED-2026-07-26.md §11 for the correction chain
 *   - ADR-050 §2 for the measurement-first decision
 *   - .planning/wi-fault-proof-loop/DEBATE-RECORD-AND-GATE.md for the debate
 */

import type Database from 'better-sqlite3';

export default function migrateV104(db: Database.Database): void {
  // ALTER TABLE ADD COLUMN — SQLite doesn't support IF NOT EXISTS on ADD COLUMN,
  // so guard idempotency by inspecting pragma_table_info first.
  const columns = db
    .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('cypher_sessions')`)
    .all();
  const hasColumn = columns.some((c) => c.name === 'dispatch_source');

  if (!hasColumn) {
    db.exec(`
      ALTER TABLE cypher_sessions
        ADD COLUMN dispatch_source TEXT NOT NULL DEFAULT 'unknown'
          CHECK(dispatch_source IN ('user','smoke','test','agent','unknown'));
    `);
  }

  // Partial index for measurement queries that filter to marked sources.
  // Idempotent — IF NOT EXISTS is native.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cypher_sessions_dispatch_source
      ON cypher_sessions(dispatch_source, outcome)
      WHERE dispatch_source != 'unknown';
  `);
}
