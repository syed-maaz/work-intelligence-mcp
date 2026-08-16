/**
 * v63 — phase 82b (2026-06-14): skill_catalog table for Cypher's skill discovery.
 *
 * Net-new table holding every SKILL.md the discovery scanner finds across
 * ~/.claude/skills/ (top-level wi-* + globals) and ~/.claude/plugins/
 * marketplaces. Replaces the implicit assumption baked into
 * src/services/cypher/candidates.ts that the wi-* hard-coded list is
 * Cypher's whole world.
 *
 * Columns:
 *   - skill_name      — unique key; matches the SKILL.md frontmatter `name`
 *                       OR the parent directory name when frontmatter is absent.
 *   - source          — 'wi' | 'global' | 'plugin' | 'builtin'. Routing
 *                       hint: wi-* live in ~/.claude/skills/ as symlinks,
 *                       globals are top-level non-wi entries, plugin
 *                       skills live in plugin/marketplace dirs, and the
 *                       builtin bucket is reserved for CLI commands like
 *                       /init that ship in a SKILL.md but aren't really
 *                       skills the agent would invoke.
 *   - source_path     — absolute path to the SKILL.md file. Lets the panel
 *                       deep-link to the file and lets `last_seen_at`
 *                       updates track moves/deletions.
 *   - description     — frontmatter `description`, truncated to 500 chars
 *                       on insert. Drives the keyword-extraction that
 *                       feeds task_classes.
 *   - trigger_phrases — JSON array, optional. Some SKILL.md files declare
 *                       `triggers` or list trigger-phrase examples. Stored
 *                       verbatim for future routing.
 *   - task_classes    — JSON array of strings. Inferred from description
 *                       at scan time via simple keyword extraction. Used
 *                       by resolveCandidates() to merge discovered skills
 *                       into the candidate pool when a dispatch comes in
 *                       with a task_class that matches.
 *   - registered_at   — first-seen timestamp.
 *   - last_seen_at    — updates on every scan; lets the panel surface
 *                       skills that disappeared (uninstalled).
 *
 * Idempotent: PRAGMA-checks for the table before creating. Survives
 * parallel-branch schema bumps the same way v62's ALTER did.
 */

import type Database from 'better-sqlite3';

interface MasterRow { name: string }

export default function migrateV63(db: Database.Database): void {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='skill_catalog'`).all() as MasterRow[];
  if (tables.length > 0) return;

  db.exec(`
    CREATE TABLE skill_catalog (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name      TEXT    NOT NULL UNIQUE,
      source          TEXT    NOT NULL CHECK(source IN ('wi','global','plugin','builtin')),
      source_path     TEXT    NOT NULL,
      description     TEXT,
      trigger_phrases TEXT,
      task_classes    TEXT,
      registered_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      last_seen_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_skill_catalog_source ON skill_catalog(source);
    CREATE INDEX idx_skill_catalog_seen   ON skill_catalog(last_seen_at DESC);
  `);
}
