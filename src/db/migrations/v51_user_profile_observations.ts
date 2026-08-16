/**
 * v51 — user_profile_observations table for continuous profile learning.
 *
 * Persistence layer for POST /api/profile/observe. Each row records a kind
 * (tool_call/jira_open/message_sent/code_edit/etc), payload JSON, source
 * consumer (claude-code/atlas), and timestamp. Indexes on (ts) and
 * (user, ts) for rolling-window aggregates that build the user-profile signal
 * feeding GET /api/persona.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS pattern. Decay handled at read time
 * via WHERE ts > date('now', '-N days') in the aggregator query — no separate
 * cleanup job needed.
 *
 * Refs: .planning/ADR-REVIEW.md graphify+Hermes decline → substrate fixes.
 */
import Database from 'better-sqlite3';

export default function migrateV51(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile_observations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      user       TEXT    NOT NULL DEFAULT 'maaz',
      kind       TEXT    NOT NULL,
      payload    TEXT    NOT NULL,
      source     TEXT    NOT NULL,
      consumer   TEXT    NOT NULL DEFAULT 'unknown'
    );

    CREATE INDEX IF NOT EXISTS idx_upo_ts         ON user_profile_observations(ts);
    CREATE INDEX IF NOT EXISTS idx_upo_user_ts    ON user_profile_observations(user, ts);
    CREATE INDEX IF NOT EXISTS idx_upo_kind_ts    ON user_profile_observations(kind, ts);
    CREATE INDEX IF NOT EXISTS idx_upo_consumer   ON user_profile_observations(consumer);
  `);
}
