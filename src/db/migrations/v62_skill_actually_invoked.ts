/**
 * v62 — slice 82a-2 (2026-06-14): skill_actually_invoked credit-assignment fix.
 *
 * Adds `cypher_sessions.skill_actually_invoked TEXT NULL` so callers can
 * declare the skill they actually invoked when closing a session — distinct
 * from `chosen_skill` which records what Cypher *recommended*. The Beta
 * prior update credits the actual skill when supplied; falls back to
 * chosen_skill when null (backwards-compatible).
 *
 * Idempotent: checks for the column via PRAGMA before adding it. Survives
 * the case where a parallel branch advanced the schema past v62 without
 * running this migration.
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV62(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(cypher_sessions)`).all() as ColumnInfoRow[];
  const has = cols.some(c => c.name === 'skill_actually_invoked');
  if (!has) {
    db.exec(`ALTER TABLE cypher_sessions ADD COLUMN skill_actually_invoked TEXT;`);
  }
}

