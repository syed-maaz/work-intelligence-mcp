/**
 * v93 — ADR-040 commit 4.5 (2026-07-06): interaction_tokens table.
 *
 * The token surface that guards POST /api/outcome-evidence — the
 * DoD §2.4 condition (2) mechanism. Every verified_via='user_observed'
 * INSERT must present a valid, unexpired, single-use token issued to
 * a specific task_id + session_id pair. Server-side spoof (a Cypher
 * session writing user_observed without a real UI click) is impossible
 * without a token, which is only issued by POST /api/outcome-evidence/token.
 *
 * # Q-16 resolution
 *
 * ADR-040 §10 Q-16 (Batch 5) asked: dedicated `interaction_tokens`
 * table or reuse existing session-scoped pattern? WI has no
 * express-session middleware wired — reusing a pattern that doesn't
 * exist means installing express-session + cookie handling for one
 * feature. Dedicated table is cheaper: 6 columns, 1 index, single-use
 * enforcement is a plain UPDATE with a WHERE-clause guard.
 *
 * # Single-use enforcement
 *
 * The consumption path runs:
 *   UPDATE interaction_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL
 * If the token is already consumed, the UPDATE affects 0 rows and the
 * endpoint rejects with 403.
 *
 * # TTL
 *
 * Tokens are short-lived (5 min per plan). Callers check
 * `expires_at > now` before consuming. Expired tokens stay in the
 * table for audit; they simply fail the check.
 */

import type Database from 'better-sqlite3';

export default function migrateV93(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS interaction_tokens (
      id           TEXT    PRIMARY KEY,
      task_id      TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id   TEXT    NOT NULL REFERENCES cypher_sessions(session_id) ON DELETE CASCADE,
      issued_at    INTEGER NOT NULL,
      consumed_at  INTEGER NULL,
      expires_at   INTEGER NOT NULL,
      CHECK (expires_at > issued_at)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS interaction_tokens_task_idx ` +
      `ON interaction_tokens(task_id, expires_at DESC)`,
  );
}
