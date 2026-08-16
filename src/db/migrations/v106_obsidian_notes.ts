/**
 * v105 — obsidian_notes + obsidian_notes_fts (Phase 79-08).
 *
 * Indexes vault .md files in SQLite so recallMemory has a 6th lane.
 * Splits WI-generated body (above separator) from user annotations (below
 * separator) so recall can rank them differently and topic-expert write-back
 * never overwrites user prose.
 *
 * Authority split:
 *   - wi_body: WI-authoritative (above <!-- USER ANNOTATIONS BELOW -->)
 *   - user_annotations: user-authoritative (below the separator)
 *
 * FTS5 shadow kept in sync by AFTER INSERT + AFTER UPDATE triggers.
 * Populated at boot by vault-indexer.ts; updated on file change by chokidar watcher.
 */
import type Database from 'better-sqlite3';

export default function migrateV105(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS obsidian_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      topic_name TEXT,
      frontmatter_json TEXT,
      wi_body TEXT,
      user_annotations TEXT,
      wikilinks_json TEXT,
      tags_json TEXT,
      file_mtime_epoch INTEGER NOT NULL,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_obsidian_topic ON obsidian_notes(topic_name);
    CREATE INDEX IF NOT EXISTS idx_obsidian_mtime ON obsidian_notes(file_mtime_epoch DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS obsidian_notes_fts USING fts5(
      file_name, wi_body, user_annotations, wikilinks_json, tags_json,
      content='obsidian_notes',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS obsidian_notes_ai AFTER INSERT ON obsidian_notes BEGIN
      INSERT INTO obsidian_notes_fts(rowid, file_name, wi_body, user_annotations, wikilinks_json, tags_json)
      VALUES (new.id, new.file_name, new.wi_body, new.user_annotations, new.wikilinks_json, new.tags_json);
    END;

    CREATE TRIGGER IF NOT EXISTS obsidian_notes_au AFTER UPDATE ON obsidian_notes BEGIN
      INSERT INTO obsidian_notes_fts(obsidian_notes_fts, rowid, file_name, wi_body, user_annotations, wikilinks_json, tags_json)
      VALUES ('delete', old.id, old.file_name, old.wi_body, old.user_annotations, old.wikilinks_json, old.tags_json);
      INSERT INTO obsidian_notes_fts(rowid, file_name, wi_body, user_annotations, wikilinks_json, tags_json)
      VALUES (new.id, new.file_name, new.wi_body, new.user_annotations, new.wikilinks_json, new.tags_json);
    END;
  `);
}
