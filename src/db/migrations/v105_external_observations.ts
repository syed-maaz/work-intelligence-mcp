/**
 * Phase 79-07 — external_observations table for mem-claude ingest.
 *
 * One-shot backfill target for mem-claude's ~20k curated `observations` rows.
 * Preserves source schema fidelity so recall can join by project, type,
 * files_read/modified, or concept.
 *
 * NOT a live sidecar table — no incremental sync, no cron. Populated once by
 * scripts/ingest-mem-claude.ts, then mem-claude is retired.
 */
import type Database from 'better-sqlite3';

export default function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT 'mem-claude',
      source_row_id INTEGER NOT NULL,
      memory_session_id TEXT,
      project TEXT NOT NULL,
      observation_type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      text TEXT,
      facts_json TEXT,
      narrative TEXT,
      concepts_json TEXT,
      files_read_json TEXT,
      files_modified_json TEXT,
      prompt_number INTEGER,
      content_hash TEXT,
      generated_by_model TEXT,
      observation_created_at TEXT NOT NULL,
      observation_created_at_epoch INTEGER NOT NULL,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source, source_row_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ext_obs_project ON external_observations(project, observation_created_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_ext_obs_type ON external_observations(observation_type, observation_created_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_ext_obs_hash ON external_observations(content_hash);

    CREATE VIRTUAL TABLE IF NOT EXISTS external_observations_fts USING fts5(
      title, subtitle, narrative, facts_json, concepts_json,
      content='external_observations',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS external_observations_ai AFTER INSERT ON external_observations BEGIN
      INSERT INTO external_observations_fts(rowid, title, subtitle, narrative, facts_json, concepts_json)
      VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts_json, new.concepts_json);
    END;
  `);
}
