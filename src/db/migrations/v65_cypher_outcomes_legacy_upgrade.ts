/**
 * v65 — phase 87 / ADR-034 L1.1 follow-up (2026-06-16): upgrade legacy
 * cypher_outcomes table to the v64 PRD-blessed shape.
 *
 * **Why this exists.** v64 created `cypher_outcomes` with the schema
 * `.planning/phases/87-adr-034-cypher-learning-engine/PRD.md` AC L1.1-C-01
 * locks: `value REAL [-1, 1]`, `weight REAL`, `metadata JSON`,
 * `created_by TEXT`, `created_at TEXT`, signal_kind enum
 * `('verdict','thumbs','rerun','edit_distance','ci')`.
 *
 * The parked phase-83 worktree (commit `a42dd09` on
 * `worktree-phase-83-cypher-preflight`) shipped its own L1.1 attempt at
 * a DIFFERENT, predates-the-PRD shape that was already running on at
 * least one local data.db: `weight REAL`, `captured_at TEXT`,
 * `evidence TEXT` (no `value`, no `metadata`, no `created_by`); and a
 * different signal_kind enum
 * `('verdict','rerun','thumbs_up','thumbs_down','merge_unchanged','merge_with_edits','smoke_break')`.
 *
 * Three cases this migration must handle, idempotently:
 *
 *   1. **Fresh DB** — `cypher_outcomes` already has the v64 shape (created
 *      by my v64 migration on this same migration run). Nothing to do.
 *
 *   2. **Live DB carrying the old worktree shape** — `cypher_outcomes`
 *      exists but lacks the `value` column AND has either `evidence` or
 *      `captured_at`. Rename to `cypher_outcomes_v_old`, recreate the v64
 *      table, translate rows into the new shape:
 *        - 'thumbs_up'   → kind='thumbs',  value=+0.8
 *        - 'thumbs_down' → kind='thumbs',  value=-1.0
 *        - 'rerun'       → kind='rerun',   value=-0.7
 *        - 'verdict'     → kind='verdict', value derived from
 *                          cypher_sessions.outcome (success +0.8,
 *                          mixed 0.0, failed -0.8)
 *      The L1.2/L1.3 placeholder kinds in the old enum
 *      ('merge_unchanged','merge_with_edits','smoke_break') are NOT
 *      translated — the old DB never wrote any of them in practice
 *      (those kinds were placeholders only); they would map to L1.2/L1.3
 *      slots that don't ship until those slices fire. Rows of those
 *      kinds, if present, stay readable on `cypher_outcomes_v_old` for
 *      forensics but are dropped from the live ledger.
 *
 *   3. **Already migrated** — `cypher_outcomes_v_old` already exists
 *      from a prior run. No-op.
 *
 * **Schema-version coordination.** A live DB that ran the parked
 * worktree may report `schema_version > 64` (the worktree's chain went
 * up to 67 or higher). When the host bumps `CURRENT_SCHEMA_VERSION` to
 * 65 and my v65 migration runs, this signature-checks the table directly
 * rather than trusting the version number — that's the only way to
 * survive the worktree's renumber chaos.
 *
 * **Side effect on hosts that need a `version` reset.** If the live DB
 * is ABOVE 65 because of the worktree, the migration ladder won't fire
 * v65 unless the host operator manually drops `schema_version` to 64
 * first. The README and the SUMMARY.md document this. The migration
 * itself is safe to call directly via a one-liner if the ladder skips
 * it.
 */

import type Database from 'better-sqlite3';

interface ColRow { name: string }

/**
 * Detect whether `cypher_outcomes` is in the OLD worktree shape.
 *
 * Signature: lacks the `value` column AND has either `evidence` or
 * `captured_at`. The presence of `evidence` alone is also enough — no
 * v64-shape DB has that column.
 */
function isOldShape(db: Database.Database): boolean {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='cypher_outcomes'`,
  ).all() as ColRow[];
  if (tables.length === 0) return false; // fresh DB w/o v64 yet — caller's problem

  const cols = db.prepare(`PRAGMA table_info(cypher_outcomes)`).all() as ColRow[];
  const colNames = new Set(cols.map(c => c.name));
  const hasValue = colNames.has('value');
  const hasEvidence = colNames.has('evidence');
  const hasCapturedAt = colNames.has('captured_at');
  return !hasValue && (hasEvidence || hasCapturedAt);
}

/** True if the rename target already exists (i.e. v65 already ran). */
function alreadyMigrated(db: Database.Database): boolean {
  const rows = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='cypher_outcomes_v_old'`,
  ).all() as ColRow[];
  return rows.length > 0;
}

export default function migrateV65(db: Database.Database): void {
  if (alreadyMigrated(db)) return;
  if (!isOldShape(db)) return; // fresh DB or already-new — nothing to translate

  // 1. Rename old → _v_old (preserves rows for forensics).
  db.exec(`ALTER TABLE cypher_outcomes RENAME TO cypher_outcomes_v_old;`);

  // The old indexes followed the table on rename — drop them
  // explicitly (they'd otherwise prevent the create-on-original-name
  // because their auto-named indexes might collide on edge schemas).
  // Use IF EXISTS so this is safe whether the indexes were on the old
  // or already-new schema.
  db.exec(`DROP INDEX IF EXISTS idx_cypher_outcomes_session;`);
  db.exec(`DROP INDEX IF EXISTS idx_cypher_outcomes_kind_captured;`);

  // 2. Create the new v64-shape table. Same DDL as v64's migration —
  //    duplicated here intentionally so v65 is self-contained and can
  //    be invoked manually on a live DB without depending on v64
  //    having been re-run (which it wouldn't, since the version
  //    counter is past 64).
  db.exec(`
    CREATE TABLE cypher_outcomes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT    NOT NULL REFERENCES cypher_sessions(session_id) ON DELETE CASCADE,
      signal_kind   TEXT    NOT NULL CHECK(signal_kind IN
                     ('verdict','thumbs','rerun','edit_distance','ci')),
      value         REAL    NOT NULL CHECK(value >= -1.0 AND value <= 1.0),
      weight        REAL    NOT NULL DEFAULT 1.0 CHECK(weight > 0),
      metadata      TEXT,
      created_by    TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_cypher_outcomes_session
      ON cypher_outcomes(session_id);

    CREATE INDEX idx_cypher_outcomes_recent_signals
      ON cypher_outcomes(created_at DESC)
      WHERE signal_kind IN ('rerun','thumbs');
  `);

  // 3. Translate old rows into the new shape.
  //
  //    **Crucial discovery (2026-06-16):** the parked worktree's
  //    `weight` column actually held the SIGNAL VALUE (not a
  //    multiplier). Live data showed weights like -0.7 for rerun,
  //    +0.8 for thumbs_up, ±1.0 for verdict — those are values, not
  //    weights. The old shape conflated the two; the v64 PRD shape
  //    separates them.
  //
  //    Translation rule:
  //      - For each old row: new.value = old.weight (the actual
  //        signal score); new.weight = 1.0 (uniform multiplier).
  //      - Old kind 'thumbs_up'   → new kind='thumbs' (the value
  //        already encodes up vs down).
  //      - Old kind 'thumbs_down' → new kind='thumbs'.
  //      - Old 'rerun', 'verdict' → kind unchanged.
  //      - Old 'merge_unchanged' / 'merge_with_edits' / 'smoke_break'
  //        → SKIPPED. Those were placeholder kinds in the old enum;
  //        L1.2/L1.3 will write their own rows when their triggers
  //        fire.
  //
  //    The v64 CHECK constraint enforces value ∈ [-1, +1]. Old rows
  //    with weight outside that range (none observed in real data,
  //    but defensive) are filtered out.
  //
  //    metadata carries forward the original `evidence` column under
  //    `legacy_evidence`, the original `signal_kind` under
  //    `legacy_kind`, plus a `migrated_from_v_old=1` marker so a
  //    forensics query can find every translated row.
  //
  //    created_at uses the old `captured_at` value verbatim (correct —
  //    that's when the signal was actually recorded). created_by is
  //    set to '__migrated' so it's distinguishable from live writes.
  //
  //    A non-cascading FK on the old shape means orphan rows could
  //    exist. The EXISTS guard filters them out — no point translating
  //    a row whose session no longer exists (and the new FK with
  //    CASCADE would reject the insert anyway).
  db.exec(`
    INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight, metadata, created_by, created_at)
    SELECT
      v.session_id,
      'thumbs' AS signal_kind,
      v.weight AS value,
      1.0 AS weight,
      json_object('migrated_from_v_old', 1, 'legacy_kind', v.signal_kind, 'legacy_evidence', v.evidence) AS metadata,
      '__migrated' AS created_by,
      v.captured_at AS created_at
    FROM cypher_outcomes_v_old v
    WHERE v.signal_kind IN ('thumbs_up','thumbs_down')
      AND v.weight >= -1.0 AND v.weight <= 1.0
      AND EXISTS (SELECT 1 FROM cypher_sessions s WHERE s.session_id = v.session_id);

    INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight, metadata, created_by, created_at)
    SELECT
      v.session_id,
      v.signal_kind AS signal_kind,
      v.weight AS value,
      1.0 AS weight,
      json_object('migrated_from_v_old', 1, 'legacy_evidence', v.evidence) AS metadata,
      '__migrated' AS created_by,
      v.captured_at AS created_at
    FROM cypher_outcomes_v_old v
    WHERE v.signal_kind IN ('rerun','verdict')
      AND v.weight >= -1.0 AND v.weight <= 1.0
      AND EXISTS (SELECT 1 FROM cypher_sessions s WHERE s.session_id = v.session_id);
  `);
}
