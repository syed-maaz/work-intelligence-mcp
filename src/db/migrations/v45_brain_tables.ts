import type Database from 'better-sqlite3';

/**
 * Schema v45 — Unified Brain API tables (ADR-024, Phase 69-01).
 *
 * Adds three new tables (brain_decisions, brain_action_clusters, brain_verifications)
 * and four indexes that back POST /api/brain/decide, GET /api/brain/context, and
 * the verify/learn pillars. The DDL below is reproduced byte-for-byte from
 * docs/docs/adr/adr-024-unified-brain.md (lines 200–240). Column lists, types,
 * NOT NULL constraints, the UNIQUE constraint on cache_key, and all four index
 * definitions are locked.
 *
 * Idempotent: every CREATE uses IF NOT EXISTS, so re-running on an already-v45
 * database is a no-op. Wrapped in a single transaction so a partial failure
 * leaves the database unchanged.
 */
export default function up(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS brain_decisions (
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

      CREATE TABLE IF NOT EXISTS brain_action_clusters (
        signature TEXT PRIMARY KEY,
        count INTEGER,
        first_seen INTEGER,
        last_seen INTEGER,
        root_cause TEXT,
        resolution TEXT
      );

      CREATE TABLE IF NOT EXISTS brain_verifications (
        id TEXT PRIMARY KEY,
        claim TEXT NOT NULL,
        verified INTEGER,
        evidence_json TEXT,
        confidence REAL,
        checked_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_brain_decisions_outcome ON brain_decisions(outcome);
      CREATE INDEX IF NOT EXISTS idx_brain_decisions_created ON brain_decisions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_brain_decisions_user_day ON brain_decisions(user, day_iso);
      CREATE INDEX IF NOT EXISTS idx_brain_clusters_count ON brain_action_clusters(count DESC);

      -- Per-user daily budget ledger (T-69-01 mitigation, Phase 69-05).
      -- Tracks call count + token spend per (user, UTC day) to enforce the
      -- BRAIN_USER_DAILY_CALLS / BRAIN_USER_DAILY_INPUT_TOKENS caps. Idempotent
      -- (CREATE IF NOT EXISTS) so already-migrated v45 databases gain the
      -- table on next startup; fresh databases get it directly.
      CREATE TABLE IF NOT EXISTS brain_user_budget_ledger (
        user TEXT NOT NULL,
        day_iso TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user, day_iso)
      );
    `);
  })();
}

/**
 * Emergency rollback for v45 (ADR-024 Phase 69-01).
 *
 * NOT auto-invoked by the migrations registry — exported only so an operator
 * (or future reverse-migration tooling) can call it explicitly when a v45
 * deployment must be reversed. Drops indexes first, then tables, in
 * reverse-dependency order. Idempotent: every DROP uses IF EXISTS, so calling
 * `down()` on a database that was never migrated to v45 is a safe no-op.
 *
 * This function does NOT decrement `schema_metadata.schema_version`; the
 * operator is responsible for resetting that row to '44' after a successful
 * rollback if downstream code asserts on it.
 */
export function down(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS brain_user_budget_ledger;
      DROP INDEX IF EXISTS idx_brain_clusters_count;
      DROP INDEX IF EXISTS idx_brain_decisions_user_day;
      DROP INDEX IF EXISTS idx_brain_decisions_created;
      DROP INDEX IF EXISTS idx_brain_decisions_outcome;
      DROP TABLE IF EXISTS brain_verifications;
      DROP TABLE IF EXISTS brain_action_clusters;
      DROP TABLE IF EXISTS brain_decisions;
    `);
  })();
}
