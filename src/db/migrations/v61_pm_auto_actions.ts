/**
 * v61 — PM-AUTO: Cypher PM auto-write audit trail (2026-06-14, slice 81a).
 *
 * One net-new table. Cypher's PM lens (v60) added work_items + work_item_links
 * but kept all writes user-driven. PM-4 (commit 197c5c1) added regex-based
 * auto-link *suggestions* in the dispatch response, but persistence still
 * required a manual /api/cypher/pm/link call.
 *
 * Slice 81a flips that: high-confidence suggestions (prefix-namespaced
 * ids that exist in work_items) auto-write evidence rows; outcome=success
 * on a current-branch session auto-links commits between started_at and
 * completed_at; pending->in_progress and in_progress->shipped transitions
 * fire automatically when their gates pass.
 *
 * `pm_auto_actions` is the audit table for everything Cypher writes
 * autonomously. Every auto-link, every auto-transition. The visibility
 * panel (slice 81b) reads this to render a "Cypher did X automatically"
 * feed; the operator reads it when something looks wrong.
 *
 * Why an audit table not a column on work_item_links:
 *   - Auto-transitions don't produce a link row at all (they flip
 *     work_items.status). A column on links would miss them.
 *   - Auto-actions are append-only; they survive even if the linked
 *     evidence row is later deleted by a human correction.
 *   - One audit shape covers all four action types; columns on links
 *     would need to be NULLable for the transition cases.
 *
 * Action enum:
 *   - 'link_session'           — wrote (work_item, cypher_session_id, session)
 *   - 'link_commit'            — wrote (work_item, commit_sha, sha)
 *   - 'transition_in_progress' — flipped pending -> in_progress
 *   - 'transition_shipped'     — flipped in_progress -> shipped
 *
 * Additive only — no edits to existing tables. Safe to apply on a
 * populated DB.
 */

import type Database from 'better-sqlite3';

export default function migrateV61(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pm_auto_actions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL,
      work_item_id    TEXT    NOT NULL,
      action          TEXT    NOT NULL CHECK(action IN
                       ('link_session','link_commit',
                        'transition_in_progress','transition_shipped')),
      evidence_kind   TEXT,
      evidence_value  TEXT,
      reason          TEXT    NOT NULL,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES cypher_sessions(session_id) ON DELETE CASCADE,
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pm_auto_actions_session
      ON pm_auto_actions(session_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pm_auto_actions_work_item
      ON pm_auto_actions(work_item_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pm_auto_actions_created
      ON pm_auto_actions(created_at DESC);
  `);
}
