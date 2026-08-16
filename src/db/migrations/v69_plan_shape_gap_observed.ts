/**
 * v69 — CAP-13-LITE plan-shape gap recognition (2026-06-24).
 *
 * Adds `plan_shape_gap_observed` — the new substrate for ADR-037.5 v2's
 * α-LITE recognition step. When a loop dispatch completes with a
 * historical posterior signal (`prior_count >= 5 AND
 * prior_success_rate < 0.3`) on the dispatch's `plan_shape_hash`, the
 * recognition hook in `src/services/cypher/loop.ts` opportunistically
 * writes one row here. The hook is gate-only — no drafter, no
 * proposal lifecycle, no LLM call. Just observation.
 *
 * This table is the **architecturally honest successor** to the
 * pipeline-era `skill_gap_observed` (which lives on the unmerged
 * 2026-06-14 branch — see ADR-037.5 v2 § Context). The loop has no
 * concept of "skill"; its posterior unit is `plan_shape_hash`. This
 * table captures gaps in that unit's natural form.
 *
 * Why the columns:
 *   - `session_id` + `plan_shape_hash` — joint identity. UNIQUE
 *     enforces idempotency: the hook can fire twice for the same
 *     dispatch (e.g. if `persistOutcome` ever retries) without
 *     double-writing.
 *   - `posture`, `tool_sequence_json`, `goal` — human-readable context
 *     for review. `goal` is truncated to 500 chars at write time per
 *     PRD AC P-01.
 *   - `prior_count`, `prior_success_rate` — snapshot at recognition
 *     time. Future updates to the posterior do NOT propagate; the row
 *     is a moment-in-time capture.
 *   - `iterations`, `verdict` — the firing dispatch's own loop result.
 *     Useful for review ("did this specific dispatch fail, or did it
 *     succeed against a historically-bad shape?").
 *   - `status` — review state. α-LITE only writes `'observed'`.
 *     `'reviewed' | 'acted_on' | 'dismissed'` are reserved for
 *     future α-FULL ratification (currently deferred indefinitely).
 *   - `reviewed_at`, `reviewed_by`, `reviewer_note` — populated by
 *     human review when α-FULL ships. Null in v1.
 *
 * Idempotent: PRAGMA `table_info` checks before CREATE TABLE; survives
 * the case where a parallel branch advanced the schema past v69.
 *
 * See:
 *   - docs/docs/adr/adr-037-5-cap13-skill-self-extension.md § Decision D4
 *   - .planning/cap-13-alpha-lite/PRD.md § Schema (S-01 … S-12)
 *   - .planning/cap-13-redesign/SYNTHESIS.md for the α framing
 *   - commit e18f1d4 (the substrate fix this builds on)
 */

import type Database from 'better-sqlite3';

interface TableInfoRow { name: string }

export default function migrateV69(db: Database.Database): void {
  // Idempotency check — only create if absent.
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plan_shape_gap_observed'`)
    .all() as TableInfoRow[];
  if (rows.length > 0) {
    return;
  }

  db.exec(`
    CREATE TABLE plan_shape_gap_observed (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id          TEXT    NOT NULL,
      plan_shape_hash     TEXT    NOT NULL,
      posture             TEXT    NOT NULL,
      tool_sequence_json  TEXT    NOT NULL,
      goal                TEXT    NOT NULL,
      user                TEXT    NOT NULL,
      prior_count         INTEGER NOT NULL,
      prior_success_rate  REAL    NOT NULL,
      iterations          INTEGER NOT NULL,
      verdict             TEXT    NOT NULL,
      status              TEXT    NOT NULL DEFAULT 'observed'
                           CHECK(status IN ('observed','reviewed','acted_on','dismissed')),
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      reviewed_at         TEXT,
      reviewed_by         TEXT,
      reviewer_note       TEXT,
      UNIQUE(session_id, plan_shape_hash),
      FOREIGN KEY (session_id) REFERENCES cypher_sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX idx_plan_shape_gap_observed_status_shape
      ON plan_shape_gap_observed(status, plan_shape_hash, created_at);
  `);
}
