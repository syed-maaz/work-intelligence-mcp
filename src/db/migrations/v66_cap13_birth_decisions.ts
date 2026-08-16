/**
 * v66 — ADR-037 Phase 2 / D21 (2026-06-22): create `cap13_birth_decisions`
 * ledger table for CAP-13 birth-gate friction instrumentation.
 *
 * **Honest scope correction.** The execution plan
 * `.planning/cypher/11-ADR-037-EXECUTION-PLAN.md` § 2 described this
 * deliverable as "Schema deliverable for D21 friction instrumentation:
 * `cap13_birth_decisions.skipped_reason TEXT NULL` ledger column. One-line
 * additive migration." The plan assumed the table existed and only the
 * column was new. At v65 there is no `cap13_birth_decisions` table — this
 * migration creates the whole table including `skipped_reason` from day 1
 * rather than an ALTER on a non-existent target.
 *
 * **What this records.** Per ADR-037 D21, CAP-13 (skill birth) decisions
 * have two outcome paths today and one in v2.5+: approved (the skill
 * registers as a tool), rejected (gate blocked it), or skipped (Maaz saw
 * the prompt and declined to register — "the slog wasn't worth it").
 * Without the `skipped_reason` column, the "no candidates qualified" case
 * and the "Maaz skipped because the slog wasn't worth it" case look
 * identical in telemetry, and the latter is CAP-13 dying silently. This
 * table makes that distinction queryable so v2.5 W2's codegen acceptance
 * gate is evidence-based rather than vibes-based.
 *
 * **Schema:**
 *   - `id` — autoincrement primary key
 *   - `proposed_at` — when CAP-13 surfaced the candidate
 *   - `proposed_skill_name` — the slug CAP-13 wanted to register
 *   - `verdict` — `'approved' | 'rejected' | 'skipped'`. Approved =
 *     skill landed in catalog. Rejected = gate logic blocked it.
 *     Skipped = user (Maaz) saw the prompt and declined.
 *   - `skipped_reason` — NULL unless verdict='skipped'; captures the
 *     plain-text reason for the skip (D21 friction signal). The column
 *     ADR-037 D21 explicitly calls out.
 *   - `mechanism` — which CAP-13 mechanism surfaced this: 'codegen' (Option
 *     B, v2.5 W2) or 'handwrite' (Option A, v2.0). 'runtime' reserved for
 *     v2.5 Option C if it ever ships.
 *   - `evidence_payload` — JSON blob of whatever context CAP-13 surfaced
 *     (similar skills already in catalog, prior usage, etc.)
 *   - `created_at` — row insertion timestamp
 *
 * **Why no FK to cypher_sessions.** CAP-13 birth decisions are
 * surface-level events tied to user attention, not loop dispatches. A
 * dispatch may surface a candidate but the user-decision happens
 * out-of-band (or never). Keeping the table session-independent matches
 * how CAP-13 actually fires.
 *
 * Idempotent: `IF NOT EXISTS` on the CREATE; safe to re-run on a fresh DB
 * or on a DB that was bumped to v66 by a previous migration pass.
 *
 * Cross-references:
 *   - ADR-037 D21 (`docs/docs/adr/adr-037-cypher-tool-use-loop.md`)
 *   - Execution plan § 2 (`.planning/cypher/11-ADR-037-EXECUTION-PLAN.md`)
 *   - v2.0 PRD § 4.5 (`docs/docs/prd/cypher-v2.0.md`)
 */

import type Database from 'better-sqlite3';

export default function migrateV66(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cap13_birth_decisions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      proposed_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      proposed_skill_name TEXT    NOT NULL,
      verdict             TEXT    NOT NULL CHECK (verdict IN ('approved', 'rejected', 'skipped')),
      skipped_reason      TEXT    NULL,
      mechanism           TEXT    NOT NULL CHECK (mechanism IN ('codegen', 'handwrite', 'runtime')),
      evidence_payload    TEXT    NULL,
      created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cap13_birth_proposed
      ON cap13_birth_decisions (proposed_at DESC);

    CREATE INDEX IF NOT EXISTS idx_cap13_birth_verdict
      ON cap13_birth_decisions (verdict, proposed_at DESC);
  `);
}
