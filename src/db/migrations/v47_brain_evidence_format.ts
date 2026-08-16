/**
 * v47 — U-10 structured evidence_json (no DDL change).
 * Format is enforced in application code; legacy string[] rows normalize on read.
 */
import type Database from 'better-sqlite3';

export default function migrateV47(_db: Database.Database): void {
  // evidence_json column already exists (v45). Application normalizes on read/write.
}
