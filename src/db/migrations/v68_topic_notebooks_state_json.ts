/**
 * v68 — Option 3 of updateNotebook cost-reduction (2026-06-23).
 *
 * Adds `topic_notebooks.state_json TEXT NULL`. This holds the structured
 * NotebookState (overview + 6 lists) that the patch_notebook tool returns,
 * letting us re-render the canonical 7-section markdown deterministically
 * instead of asking the model to rewrite the entire notebook every call.
 *
 * Backfill strategy: column starts NULL. On first read after the migration,
 * src/tools/notebook.ts parses the existing `content` markdown back into
 * NotebookState via parseMarkdownToState(). If parsing fails (returns null),
 * the caller falls back to a cold rebuild via buildNotebook — better to
 * pay one extra Sonnet call than ship a corrupt state_json row.
 *
 * Idempotent: PRAGMA check before ADD COLUMN. Survives a parallel branch
 * having advanced the schema past v68.
 *
 * See .planning/updatenotebook-cost-reduction/01-cost-analysis-and-impact-map.md
 * § 7 Option 3 for the full rationale, and src/services/notebook-merge.ts for
 * the merge / render / parse logic.
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

export default function migrateV68(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(topic_notebooks)`).all() as ColumnInfoRow[];
  const has = cols.some(c => c.name === 'state_json');
  if (!has) {
    db.exec(`ALTER TABLE topic_notebooks ADD COLUMN state_json TEXT;`);
  }
}
