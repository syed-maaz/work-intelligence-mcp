/**
 * v108 — add CHECK constraint to cypher_sessions.posture.
 *
 * posture TEXT NULL was added in v71 without a CHECK. ADR-053 Q2 introduces
 * 'architect' and Q7 introduces 'pm-resume'. This migration uses the copy-table
 * pattern to add the CHECK for the first time, covering all valid values
 * (including legacy NULL rows which are preserved).
 *
 * Idempotent: probes whether 'bogus' is already rejected; skips if so.
 */
import type Database from 'better-sqlite3';

export default function migrateV108(db: Database.Database): void {
  // Idempotency probe: if a bogus posture insert already fails, the CHECK exists.
  try {
    db.prepare(
      `INSERT INTO cypher_sessions (session_id, goal, posture) VALUES ('__probe_v108__', 'p', 'bogus')`,
    ).run();
    db.prepare(`DELETE FROM cypher_sessions WHERE session_id = '__probe_v108__'`).run();
  } catch {
    return; // CHECK already present — migration already applied.
  }

  // Follow v100 pattern — stash values, drop dependent index, DROP COLUMN, ADD COLUMN with CHECK, restore, clean up.
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = 1');
  try {
    // Clean up from a prior failed attempt, if any.
    const cols = db
      .prepare(`PRAGMA table_info(cypher_sessions)`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === '__posture_temp_v108')) {
      db.exec(`ALTER TABLE cypher_sessions DROP COLUMN __posture_temp_v108`);
    }

    db.exec(`
      ALTER TABLE cypher_sessions ADD COLUMN __posture_temp_v108 TEXT NULL;
      UPDATE cypher_sessions SET __posture_temp_v108 = posture WHERE posture IS NOT NULL;

      -- Drop dependent index before dropping the column it references
      DROP INDEX IF EXISTS idx_cypher_sessions_posture;

      -- Drop the original posture column (no CHECK)
      ALTER TABLE cypher_sessions DROP COLUMN posture;

      -- Re-add posture with the new CHECK constraint
      ALTER TABLE cypher_sessions ADD COLUMN posture TEXT
        CHECK(posture IS NULL OR posture IN ('pr-review','bug-investigate','pm','generic','architect','pm-resume'));

      -- Restore values
      UPDATE cypher_sessions SET posture = __posture_temp_v108 WHERE __posture_temp_v108 IS NOT NULL;

      -- Clean up temp column
      ALTER TABLE cypher_sessions DROP COLUMN __posture_temp_v108;
    `);
    const colsAfter = db
      .prepare(`PRAGMA table_info(cypher_sessions)`).all() as Array<{ name: string }>;
    const hasTaskClass = colsAfter.some((c) => c.name === 'task_class');
    const hasUser = colsAfter.some((c) => c.name === 'user');
    if (hasTaskClass && hasUser) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_cypher_sessions_posture
          ON cypher_sessions(posture, task_class, user);
      `);
    }
  } finally {
    db.pragma('legacy_alter_table = 0');
    db.pragma('foreign_keys = ON');
  }
}
