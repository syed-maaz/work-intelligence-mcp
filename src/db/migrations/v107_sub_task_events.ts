/**
 * v107 — sub_task_events table (ADR-053 Q7 Option B).
 *
 * Executors emit structured events during their runs (question | partial |
 * blocker | scope_discovery) into this table. PM does NOT stay alive; events
 * accumulate in DB. PM re-enters (user-triggered, board-triggered, or
 * time-triggered) and reads unresolved events, then resolves them.
 *
 * Partial index on unresolved rows speeds up PM's re-entry query.
 */
import type Database from 'better-sqlite3';

export default function migrateV107(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sub_task_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sub_task_id     TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK(kind IN ('question','partial','blocker','scope_discovery')),
      payload_json    TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at     TEXT,
      resolved_by     TEXT CHECK(resolved_by IS NULL OR resolved_by IN ('pm','human','auto')),
      resolution_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ste_unresolved
      ON sub_task_events(sub_task_id, kind)
      WHERE resolved_at IS NULL;
  `);
}
