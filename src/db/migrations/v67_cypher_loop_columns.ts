/**
 * v67 — ADR-037 Phase 3-A (2026-06-22): Cypher tool-use loop columns
 * (D15 + D16 + D17 + D18 + D20) across the three existing cypher_* tables.
 *
 * TODO(synthesis): bump `src/db/schema.ts` CURRENT_SCHEMA_VERSION to 67
 * and add an import + array entry for this migration to the MIGRATIONS
 * table. This file is the migration body only — wiring is a separate
 * one-line edit per the v66 / v65 pattern.
 *
 * **Honest scope correction.** The execution plan
 * `.planning/cypher/11-ADR-037-EXECUTION-PLAN.md` § 3.6 described this
 * deliverable as five fan-out column adds across `cypher_sessions`,
 * `cypher_outcomes`, and `cypher_steps`, plus "widen the verdict CHECK
 * on cypher_outcomes to admit halted/abandoned/rejected_non_interactive".
 * Two corrections after reading the live shapes (v59/v62/v64/v65):
 *
 *   1. `cypher_outcomes` does NOT have a `verdict` column. The PRD-blessed
 *      shape locked in by v64 / v65 is the multi-signal weighted ledger
 *      (signal_kind + value + weight + metadata). The enum the plan calls
 *      "verdict" actually lives on `cypher_sessions.outcome`:
 *      `('success','mixed','failed')`. That is where the widening must
 *      happen — and that is the only table-rebuild this migration does.
 *
 *   2. D17 (halt observability) DOES add `halt_after_call_id` +
 *      `halt_requested_at` to `cypher_outcomes`. Both are plain additive
 *      columns; the existing CHECK on `signal_kind` is left untouched
 *      (halts are observed as `rerun` / `verdict` rows with metadata,
 *      not as a new signal_kind — keeping the enum stable preserves the
 *      L1.1 invariant from ADR-034 §Layer 1).
 *
 * **What this records, per ADR-037 D-series:**
 *
 *   - D15 (cypher_sessions): seven columns capturing per-session loop
 *     metadata that the ranker + post-hoc analytics both need.
 *       - `phase` — which loop phase the session reached (1..N). NOT NULL
 *         DEFAULT 1 so legacy rows read as "phase 1 only" (pre-loop
 *         dispatch behaviour).
 *       - `plan_shape_hash` — stable hash of the plan tree shape; lets
 *         cluster-detection collapse "same plan, different goal text"
 *         duplicates. NOT NULL DEFAULT '' (empty = unknown for legacy).
 *       - `prior_count` / `prior_success_rate` — Beta-posterior snapshot
 *         at dispatch time, frozen so reranker drift doesn't rewrite
 *         history. `prior_count` defaults to 0; `prior_success_rate` is
 *         NULL when no prior exists (distinct from 0.0 = "0% historical
 *         success").
 *       - `confirm_mode_requested` / `confirm_mode_used` — the
 *         interactive-mode contract from D20. *Requested* is what the
 *         caller asked for; *used* is what the loop actually fell back
 *         to (e.g. `interactive` requested → `auto` used when no TTY).
 *         Both NOT NULL DEFAULT 'interactive' so legacy rows read as
 *         the pre-D20 default behaviour.
 *       - `engine` — `'loop'` (ADR-037) vs `'classic'` (pre-ADR-037).
 *         NOT NULL DEFAULT 'loop' because every new session uses the
 *         loop after this migration; legacy rows can be relabelled to
 *         'classic' out-of-band by analytics if needed.
 *
 *   - D16 (cypher_steps): `confirmation_method TEXT NULL` records HOW
 *     the user confirmed a step (`'prompt' | 'auto' | 'preapproved' |
 *     'skipped'`). NULL allowed because legacy step rows have no such
 *     event; the loop writes it on every new step.
 *
 *   - D17 (cypher_outcomes): two NULLable columns observing halts.
 *     `halt_after_call_id` points back to whatever tool-use call_id
 *     triggered the halt; `halt_requested_at` timestamps it. NULL on
 *     every non-halt row (the vast majority) — wasting eight bytes per
 *     row beats coercing every signal kind into a halt-shaped schema.
 *
 *   - D18 (cypher_sessions): covered by `phase` / `plan_shape_hash` /
 *     `prior_count` / `prior_success_rate` above. Listed separately in
 *     the plan because the bullet IDs predate the column groupings.
 *
 *   - D20 (cypher_sessions): covered by `confirm_mode_requested` /
 *     `confirm_mode_used` above.
 *
 * **Verdict widening (cypher_sessions.outcome) — DEFERRED to v68.** The
 * plan called for widening the `outcome` CHECK to admit
 * `'halted' | 'abandoned' | 'rejected_non_interactive'` alongside the
 * existing `'success' | 'mixed' | 'failed'`. SQLite cannot
 * `ALTER ... DROP CONSTRAINT`, and the two documented workarounds both
 * fail on THIS DB inside the current migration runner:
 *
 *   (a) Table-rebuild (CREATE NEW + INSERT + DROP OLD + RENAME):
 *       cypher_outcomes.session_id has ON DELETE CASCADE pointing at
 *       cypher_sessions(session_id). The DROP triggers the cascade and
 *       defer_foreign_keys does not suppress FK enforcement during the
 *       DROP statement.
 *
 *   (b) writable_schema = ON + UPDATE sqlite_master: better-sqlite3
 *       blocks prepare() against sqlite_master regardless of PRAGMA
 *       state.
 *
 * Path forward: a future v68 migration that the runner invokes outside
 * a db.transaction(...) wrapper. That needs a one-line change to
 * applyMigrations in src/db/schema.ts to support a "raw" migration
 * mode — out of scope for Phase 3-A. Until v68 lands, the Phase 3-D
 * loop controller writes verdict tokens as a `verdict` signal row on
 * cypher_outcomes (the multi-signal ledger), NOT to
 * cypher_sessions.outcome. The status column (which already accepts
 * 'halted' per v59) carries the halt signal at session level.
 *
 * The rebuild copies ALL existing columns from `cypher_sessions` at
 * its v62 shape (id, session_id, goal, context, task_class,
 * chosen_skill, user, status, outcome, outcome_note, total_tokens,
 * duration_ms, allow_destructive, started_at, completed_at,
 * skill_actually_invoked) plus the seven new D15/D18/D20 columns in
 * one shot, then re-creates the two indexes from v59
 * (`idx_cypher_sessions_user_started`,
 * `idx_cypher_sessions_outcome`). FK references from `cypher_steps`
 * and `cypher_outcomes` survive the rename because SQLite stores FK
 * targets by name, not by rowid.
 *
 * **Why `halted` / `abandoned` / `rejected_non_interactive` are
 * outcomes, not statuses.** `cypher_sessions.status` already accepts
 * `'halted'` (one of pending/done/halted/asked_user). The new tokens
 * here are *terminal outcome verdicts* — they describe how the session
 * ended from the user's perspective, paralleling success/mixed/failed.
 * Keeping them on the outcome enum lets the Beta-prior writer in
 * ADR-033 §10 distinguish "the loop halted (no learning signal)" from
 * "the loop succeeded" without inspecting `status`.
 *
 * **Idempotency.** PRAGMA `table_info` checks gate each ADD COLUMN; the
 * table rebuild guards on a marker column (`engine`) being absent. Safe
 * to re-run on a DB that's already at v67, and safe to interleave with
 * parallel-branch schema bumps the same way v62 / v64 do.
 *
 * Cross-references:
 *   - ADR-037 D15 / D16 / D17 / D18 / D20
 *     (`docs/docs/adr/adr-037-cypher-tool-use-loop.md`)
 *   - Execution plan § 3.6 (`.planning/cypher/11-ADR-037-EXECUTION-PLAN.md`)
 *   - v2.0 PRD § 6 (`docs/docs/prd/cypher-v2.0.md`)
 *   - ADR-034 §Layer 1 — why cypher_outcomes.signal_kind stays unchanged
 */

import type Database from 'better-sqlite3';

interface ColumnInfoRow { name: string }

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfoRow[];
  return cols.some(c => c.name === column);
}

export default function migrateV67(db: Database.Database): void {
  // ── 1. cypher_steps (D16) ─────────────────────────────────────────────────
  // Cheapest one first — single nullable column, no rebuild.
  if (!hasColumn(db, 'cypher_steps', 'confirmation_method')) {
    db.exec(`ALTER TABLE cypher_steps ADD COLUMN confirmation_method TEXT;`);
  }

  // ── 2. cypher_outcomes (D17) ──────────────────────────────────────────────
  // Two NULLable columns. The verdict CHECK is on cypher_sessions, not here
  // (see honest-scope correction above) — this table stays additive.
  if (!hasColumn(db, 'cypher_outcomes', 'halt_after_call_id')) {
    db.exec(`ALTER TABLE cypher_outcomes ADD COLUMN halt_after_call_id INTEGER;`);
  }
  if (!hasColumn(db, 'cypher_outcomes', 'halt_requested_at')) {
    db.exec(`ALTER TABLE cypher_outcomes ADD COLUMN halt_requested_at TEXT;`);
  }

  // ── 3. cypher_sessions (D15 + D18 + D20 + outcome CHECK widening) ────────
  // Guard on `engine` — the last column added — so a re-run on an
  // already-v67 DB no-ops cleanly.
  if (hasColumn(db, 'cypher_sessions', 'engine')) return;

  // 3a. Seven additive columns via ALTER TABLE ADD COLUMN. All have NOT
  // NULL DEFAULT clauses so existing rows take the default at add time.
  // No table rebuild needed for the column adds — keeps the 616-row
  // table and the 9,994 cypher_steps + 228 cypher_outcomes FK references
  // untouched.
  db.exec(`
    ALTER TABLE cypher_sessions ADD COLUMN phase                  INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE cypher_sessions ADD COLUMN plan_shape_hash        TEXT    NOT NULL DEFAULT '';
    ALTER TABLE cypher_sessions ADD COLUMN prior_count            INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE cypher_sessions ADD COLUMN prior_success_rate     REAL;
    ALTER TABLE cypher_sessions ADD COLUMN confirm_mode_requested TEXT    NOT NULL DEFAULT 'interactive';
    ALTER TABLE cypher_sessions ADD COLUMN confirm_mode_used      TEXT    NOT NULL DEFAULT 'interactive';
    ALTER TABLE cypher_sessions ADD COLUMN engine                 TEXT    NOT NULL DEFAULT 'loop';
  `);

  // 3b. CHECK constraint widening — DEFERRED to a future v68 migration.
  //
  // Goal: widen cypher_sessions.outcome CHECK from
  //   ('success','mixed','failed')
  // to
  //   ('success','mixed','failed','halted','abandoned','rejected_non_interactive')
  //
  // Why deferred: SQLite cannot `ALTER ... DROP CONSTRAINT`. The two
  // documented workarounds both fail on this DB inside the migration
  // runner:
  //
  //   (a) Table-rebuild (CREATE NEW + INSERT + DROP OLD + RENAME):
  //       `cypher_outcomes.session_id` has `ON DELETE CASCADE` pointing
  //       at `cypher_sessions(session_id)`. The DROP triggers the
  //       cascade and `defer_foreign_keys = ON` does not suppress the
  //       FK enforcement during the DROP statement itself.
  //
  //   (b) `PRAGMA writable_schema = ON` + UPDATE sqlite_master:
  //       better-sqlite3 forbids writes to sqlite_master via prepare()
  //       regardless of the PRAGMA state.
  //
  // The path forward is v68 — a new migration that the runner invokes
  // with `db.exec()` outside any `db.transaction(...)` wrapper. That
  // requires a one-line change to `applyMigrations` in schema.ts to
  // support a "raw" migration mode, which is out of scope for Phase 3-A.
  //
  // Until v68 lands, the Phase 3-D loop controller (the only writer of
  // the new outcome tokens) MUST validate `outcome` at app level before
  // INSERT. Writing `'halted'` / `'abandoned'` /
  // `'rejected_non_interactive'` to cypher_sessions.outcome via raw
  // SQL will fail the CHECK constraint and roll back the transaction.
  //
  // The 7 D15/D18/D20 column adds above are unaffected — they are the
  // load-bearing part of Phase 3-A. Halt observability (D17) lands via
  // the two NULLable columns on cypher_outcomes (above, § 2). The Phase
  // 3-D loop persists the verdict by writing a `verdict` signal row to
  // cypher_outcomes with metadata.outcome = '<wider token>', NOT by
  // writing to cypher_sessions.outcome. This keeps Phase 3 unblocked
  // while v68 catches up.
}
