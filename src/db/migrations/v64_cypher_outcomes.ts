/**
 * v64 — phase 87 / ADR-034 L1.1 (2026-06-15): cypher_outcomes ledger.
 *
 * Net-new table holding **multi-signal weighted outcome rows per Cypher
 * session**, the measurement substrate ADR-033 §10 promised but never
 * provided. Until v64 the only signal feeding `skill_priors` was
 * `cypher_sessions.outcome` — single-source, subjective, post-hoc, often
 * skipped. v64 adds parallel mechanical signals (rerun + thumbs in L1.1;
 * edit_distance + ci reserved for L1.2 / L1.3) so "did this engagement
 * actually help?" can be measured without a single source of truth.
 *
 * The CHECK on `signal_kind` enumerates **all five** signals from
 * ADR-034 Layer 1 even though only `verdict`, `thumbs`, `rerun` are
 * written by L1.1 — `edit_distance` and `ci` are reserved for the
 * future slices that fire when their own triggers pull (L1.2 / L1.3).
 * Listing them now keeps the enum stable; widening it later requires a
 * table rebuild on SQLite.
 *
 * Aggregation is `sum(value * weight) / sum(weight)` clamped to
 * `[-1.0, +1.0]` (ADR-034 §Layer 1 invariant: weighted-aggregated, never
 * single-source). Multiple signals on the same session COMBINE; they do
 * not REPLACE.
 *
 * Verdict backfill: for every existing `cypher_sessions` row where
 * `outcome IS NOT NULL`, write a `signal_kind='verdict'` row with the
 * weight table from ADR-034 §Layer 1:
 *   success → +0.8 (matches the "Tests pass + PR merged with edits" tier)
 *   mixed   →  0.0 (treated as neutral — see ADR §Layer 1 "no signal" row)
 *   failed  → -0.8 (matches the "Smoke fails after a Cypher commit" weight)
 * `created_by` for backfilled rows is `'__backfill'` so they're
 * distinguishable from live writes; `created_at` mirrors the source
 * session's `completed_at` (or `created_at` if completed_at is null).
 *
 * Indexes (hot paths):
 *   - idx_cypher_outcomes_session       — for "show all signals for session X"
 *   - idx_cypher_outcomes_recent_signals — partial, for "recent rerun/thumbs
 *                                           events" surfaces (visibility panel)
 *
 * Idempotent: PRAGMA-checks for the table before creating. Survives
 * parallel-branch schema bumps the same way v62/v63 did.
 *
 * Out of scope (deliberately, per ADR-034 evidence-pull principle):
 *   - No edit-distance writer (L1.2)
 *   - No CI webhook (L1.3)
 *   - No Bayesian/Thompson update from this ledger (L2)
 *   - No model_priors, granted_permissions, sprint DAG (L3 / L5 / L6)
 */

import type Database from 'better-sqlite3';

interface MasterRow { name: string }

export default function migrateV64(db: Database.Database): void {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='cypher_outcomes'`,
  ).all() as MasterRow[];
  if (tables.length > 0) return;

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

  // ── Backfill: one verdict row per existing closed session ──────────────────
  // Single-statement insert with a CASE expression for the value mapping.
  // COALESCE on completed_at → started_at because some early sessions were
  // closed before the started_at default existed; we want every backfill row
  // to carry a real timestamp so downstream "recent signals" queries don't
  // misattribute the backfill to right-now.
  db.exec(`
    INSERT INTO cypher_outcomes (session_id, signal_kind, value, weight, metadata, created_by, created_at)
    SELECT
      session_id,
      'verdict' AS signal_kind,
      CASE outcome
        WHEN 'success' THEN  0.8
        WHEN 'mixed'   THEN  0.0
        WHEN 'failed'  THEN -0.8
      END AS value,
      1.0 AS weight,
      json_object('backfilled', 1, 'source_outcome', outcome) AS metadata,
      '__backfill' AS created_by,
      COALESCE(completed_at, started_at, datetime('now')) AS created_at
    FROM cypher_sessions
    WHERE outcome IS NOT NULL
      AND outcome IN ('success','mixed','failed');
  `);
}
