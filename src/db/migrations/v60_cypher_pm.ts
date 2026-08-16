/**
 * v60 — PM-1: Cypher project-manager lens (2026-06-13).
 *
 * Two net-new tables that turn the planning markdown into queryable
 * state. Replaces the GSD discipline (dropped 2026-06-12) with a
 * minimal SQL-backed source of truth that the Cypher session log
 * already feeds into.
 *
 *   1. `work_items` — one row per Acceptance Criterion (or coarser
 *      milestone if the phase doesn't have ACs yet). The "what" of
 *      project work: phase + wave + AC id + description + status +
 *      ordering hints (priority, dependencies). Hand-seeded once
 *      from the PRD markdown by an ingestion shim, then maintained
 *      by Cypher (and by humans via /wi-status when we ship PM-3).
 *
 *   2. `work_item_links` — many-to-many evidence map. One row per
 *      (work_item, evidence) pair. Evidence kinds today:
 *      - 'commit_sha'        — git commit advanced this AC
 *      - 'cypher_session_id' — Cypher session worked on this AC
 *      - 'smoke_section'     — smoke § N covers this AC
 *      - 'file_path'         — source/test file implements this AC
 *      - 'pr_url'            — external PR satisfies this AC
 *
 * Why two tables not one JSON column:
 *   - Querying "which ACs touch src/services/cypher/run.ts" needs an
 *     index on file_path; embedding evidence as JSON puts that scan
 *     on every row.
 *   - Many-to-many is the natural shape: one slice can advance
 *     several ACs; one AC can take several slices.
 *   - Append-only evidence preserves history — we never delete a
 *     link, only mark the work_item itself as 'shipped' once the
 *     evidence list is sufficient.
 *
 * What this is NOT:
 *   - It is NOT a replacement for the prose PRD/ROADMAP/ADR — those
 *     stay as human-readable narrative. The SQL is the read model
 *     for status; markdown stays the read model for "why."
 *   - It is NOT a workflow engine. Cypher's run.ts is the executor;
 *     this is the scoreboard.
 *
 * CHECK constraints:
 *   - work_items.status ∈ {'pending','in_progress','shipped','blocked','deferred'}
 *   - work_item_links.evidence_kind ∈ {'commit_sha','cypher_session_id',
 *                                       'smoke_section','file_path','pr_url'}
 *
 * Indexes (hot paths):
 *   - idx_work_items_status_priority — for "what's next" queries
 *   - idx_work_items_phase_wave      — for phase/wave roll-ups
 *   - idx_work_item_links_evidence   — for impact queries (file_path → ACs)
 *   - idx_work_item_links_item       — for "show all evidence for AC X"
 */

import type Database from 'better-sqlite3';

export default function migrateV60(db: Database.Database): void {
  // ── 1. work_items ────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      id              TEXT PRIMARY KEY,
      phase           TEXT NOT NULL,
      wave            TEXT,
      title           TEXT NOT NULL,
      description     TEXT,
      status          TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN
                         ('pending','in_progress','shipped','blocked','deferred')),
      priority        INTEGER NOT NULL DEFAULT 5,
      depends_on      TEXT NOT NULL DEFAULT '[]',
      smoke_section   TEXT,
      blocker_reason  TEXT,
      shipped_at      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_work_items_status_priority
      ON work_items(status, priority, id);
    CREATE INDEX IF NOT EXISTS idx_work_items_phase_wave
      ON work_items(phase, wave, id);
  `);

  // ── 2. work_item_links — evidence map ────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_links (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id    TEXT NOT NULL,
      evidence_kind   TEXT NOT NULL CHECK(evidence_kind IN
                       ('commit_sha','cypher_session_id','smoke_section',
                        'file_path','pr_url')),
      evidence_value  TEXT NOT NULL,
      note            TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
      UNIQUE(work_item_id, evidence_kind, evidence_value)
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_links_evidence
      ON work_item_links(evidence_kind, evidence_value);
    CREATE INDEX IF NOT EXISTS idx_work_item_links_item
      ON work_item_links(work_item_id, evidence_kind);
  `);
}
