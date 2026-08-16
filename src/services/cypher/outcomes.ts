/**
 * src/services/cypher/outcomes.ts — phase 87 / ADR-034 L1.1 (2026-06-15).
 *
 * The aggregation + write helpers for the `cypher_outcomes` ledger
 * landed by migration v64. Three concerns live here:
 *
 *   1. **aggregateOutcome(db, session_id)** — read all signals for a
 *      session and return one weighted-mean number plus the raw signals
 *      array for the visibility panel to render.
 *
 *   2. **recordOutcomeSignal(db, ...)** — single point-of-write that
 *      validates the signal_kind / value pair, idempotently writes a
 *      `cypher_outcomes` row, and respects the kill switches
 *      (CYPHER_OUTCOMES_DISABLED, the kind-specific ones).
 *
 *   3. **detectRerun(db, new_session_id)** — pure-SQL "did the user
 *      dispatch this same goal in the last 24h?" check, called from the
 *      dispatch path in C2. (Lives here so the ledger writes stay
 *      colocated with the read helper; the dispatch path imports a
 *      single module.)
 *
 * **No LLM call in this module.** AC L1.1-X-03 requires this — a vitest
 * grep enforces it. ADR-034 §Layer 1: "no LLM judges outcomes —
 * measurement is mechanical."
 */

import type Database from 'better-sqlite3';

// ── ADR-034 §Layer 1 weights ──────────────────────────────────────────────
// Pinned in code so a future tuning is a deliberate edit, not an env var.
// AC L1.1-A-05 enforces the thumbs allowlist server-side.
export const THUMBS_UP_VALUE = 0.8;
export const THUMBS_DOWN_VALUE = -1.0;
export const RERUN_VALUE = -0.7;
export const VERDICT_SUCCESS = 0.8;
export const VERDICT_MIXED = 0.0;
export const VERDICT_FAILED = -0.8;

// Allowed signal_kinds. Mirrors the v64 CHECK constraint exactly so a
// caller passing an unknown kind fails at the validator layer with a
// clearer error than SQLite's CHECK rejection would give.
export const SIGNAL_KINDS = ['verdict', 'thumbs', 'rerun', 'edit_distance', 'ci'] as const;
export type SignalKind = typeof SIGNAL_KINDS[number];

export interface OutcomeSignal {
  kind: SignalKind;
  value: number;
  weight: number;
  created_at: string;
  created_by: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AggregatedOutcome {
  aggregate: number;
  signals: OutcomeSignal[];
}

// ── kill-switch helpers ────────────────────────────────────────────────────
// Re-read each call so a runtime env edit + bridge restart takes effect
// without a deeper code change. Cheap (env access is fast); avoids a
// stale module-level cache surviving a bridge restart.
function isOutcomesDisabled(): boolean {
  return process.env.CYPHER_OUTCOMES_DISABLED === '1';
}
function isThumbsDisabled(): boolean {
  return isOutcomesDisabled() || process.env.CYPHER_OUTCOMES_THUMBS_DISABLED === '1';
}
function isRerunDisabled(): boolean {
  return isOutcomesDisabled() || process.env.CYPHER_OUTCOMES_RERUN_DISABLED === '1';
}

/**
 * Aggregate every signal on a session into one weighted-mean score.
 *
 * Formula: `sum(value * weight) / sum(weight)`, clamped to [-1.0, +1.0].
 * (The clamp is defensive — every individual `value` is already bounded
 * by the v64 CHECK, so a math result outside the range would only
 * happen with a future buggy writer.)
 *
 * Returns `{aggregate: 0, signals: []}` for an unknown session_id —
 * the caller is responsible for distinguishing "no signals" from
 * "neutral signals" (AC L1.1-C-06). Never throws on missing session.
 */
export function aggregateOutcome(
  db: Database.Database,
  session_id: string,
): AggregatedOutcome {
  type Row = {
    signal_kind: SignalKind;
    value: number;
    weight: number;
    created_at: string;
    created_by: string | null;
    metadata: string | null;
  };
  const rows = db.prepare(`
    SELECT signal_kind, value, weight, created_at, created_by, metadata
    FROM cypher_outcomes
    WHERE session_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(session_id) as Row[];

  if (rows.length === 0) {
    return { aggregate: 0, signals: [] };
  }

  let weightedSum = 0;
  let weightTotal = 0;
  const signals: OutcomeSignal[] = [];
  for (const row of rows) {
    weightedSum += row.value * row.weight;
    weightTotal += row.weight;
    signals.push({
      kind: row.signal_kind,
      value: row.value,
      weight: row.weight,
      created_at: row.created_at,
      created_by: row.created_by,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    });
  }

  const raw = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const aggregate = Math.max(-1.0, Math.min(1.0, raw));
  return { aggregate, signals };
}

// ── recordOutcomeSignal ────────────────────────────────────────────────────
export interface RecordSignalInput {
  session_id: string;
  signal_kind: SignalKind;
  value: number;
  weight?: number;
  metadata?: Record<string, unknown> | null;
  created_by?: string | null;
  /**
   * ADR-038 v2.5 D8 (v70 column). Coarse failure-mode tag written
   * alongside `signal_kind='verdict' AND value=VERDICT_FAILED` rows.
   * Optional; ignored when null. Population is forward-only — the loop
   * writes it at verdict-write time via `classifyFailure()`; D2's
   * curator will write the same column with smarter tags when shipped.
   */
  failure_pattern?: string | null;
}

export interface RecordSignalResult {
  ok: boolean;
  /** True when an existing row was updated rather than inserted. */
  upserted: boolean;
  /** The cypher_outcomes.id of the row written. Null when disabled. */
  id: number | null;
  /** Set when ok=false to explain why. */
  error?: string;
}

/**
 * Validated, idempotent write to cypher_outcomes.
 *
 * Idempotency model: a `(session_id, signal_kind, created_by)` triple
 * has at most one live row. A repeat write with the same triple
 * UPSERTs in place — value/weight/metadata are overwritten,
 * `created_at` updates to now. This matches AC L1.1-A-03 (re-clicking
 * the same thumbs is a no-op) and AC L1.1-A-04 (clicking the opposite
 * thumbs flips the row in place, no new row).
 *
 * For `signal_kind='rerun'` and `signal_kind='verdict'` we DO want
 * multiple rows possible (different `created_by` values, different
 * mechanical events) — the unique key includes `created_by` so this
 * works correctly: the rerun-detector writes against a session it
 * didn't itself create, with `created_by` = the trigger session id.
 */
export function recordOutcomeSignal(
  db: Database.Database,
  input: RecordSignalInput,
): RecordSignalResult {
  // Kill-switch routing — kind-specific gates layered on top of the
  // global gate.
  if (input.signal_kind === 'thumbs' && isThumbsDisabled()) {
    return { ok: false, upserted: false, id: null, error: 'OUTCOMES_DISABLED' };
  }
  if (input.signal_kind === 'rerun' && isRerunDisabled()) {
    return { ok: false, upserted: false, id: null, error: 'OUTCOMES_DISABLED' };
  }
  if (isOutcomesDisabled() && input.signal_kind !== 'thumbs' && input.signal_kind !== 'rerun') {
    return { ok: false, upserted: false, id: null, error: 'OUTCOMES_DISABLED' };
  }

  // Validation — fail fast with a structured error before SQL.
  if (!SIGNAL_KINDS.includes(input.signal_kind)) {
    return { ok: false, upserted: false, id: null, error: 'INVALID_SIGNAL_KIND' };
  }
  if (!Number.isFinite(input.value) || input.value < -1.0 || input.value > 1.0) {
    return { ok: false, upserted: false, id: null, error: 'INVALID_VALUE_RANGE' };
  }
  // Thumbs allowlist — AC L1.1-A-05. Other kinds tolerate the full
  // [-1,1] range so future writers (edit_distance, CI) don't have to
  // touch this validator.
  if (input.signal_kind === 'thumbs') {
    if (input.value !== THUMBS_UP_VALUE && input.value !== THUMBS_DOWN_VALUE) {
      return { ok: false, upserted: false, id: null, error: 'INVALID_THUMBS_VALUE' };
    }
  }

  const weight = input.weight ?? 1.0;
  if (!Number.isFinite(weight) || weight <= 0) {
    return { ok: false, upserted: false, id: null, error: 'INVALID_WEIGHT' };
  }

  const session = db.prepare(
    `SELECT 1 FROM cypher_sessions WHERE session_id = ?`,
  ).get(input.session_id);
  if (!session) {
    return { ok: false, upserted: false, id: null, error: 'SESSION_NOT_FOUND' };
  }

  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
  const createdBy = input.created_by ?? null;

  // UPSERT on (session_id, signal_kind, created_by) — there's no UNIQUE
  // constraint at the table level (we want multiple rerun rows from
  // distinct trigger sessions to coexist), so we model the idempotency
  // in the writer: SELECT first, UPDATE if found, INSERT otherwise.
  // Wrapped in a transaction so concurrent dispatches on the same
  // session row don't race-double-insert.
  const result = db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM cypher_outcomes
      WHERE session_id = ? AND signal_kind = ?
        AND ((created_by IS NULL AND ? IS NULL) OR created_by = ?)
    `).get(input.session_id, input.signal_kind, createdBy, createdBy) as { id: number } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE cypher_outcomes
        SET value = ?, weight = ?, metadata = ?, failure_pattern = ?,
            created_at = datetime('now')
        WHERE id = ?
      `).run(
        input.value,
        weight,
        metadataJson,
        input.failure_pattern ?? null,
        existing.id,
      );
      return { id: existing.id, upserted: true };
    }
    const insert = db.prepare(`
      INSERT INTO cypher_outcomes
        (session_id, signal_kind, value, weight, metadata, created_by, failure_pattern)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.session_id,
      input.signal_kind,
      input.value,
      weight,
      metadataJson,
      createdBy,
      input.failure_pattern ?? null,
    );
    return { id: Number(insert.lastInsertRowid), upserted: false };
  })();

  return { ok: true, upserted: result.upserted, id: result.id };
}

// ── detectRerun ────────────────────────────────────────────────────────────
//
// Wired into the dispatch path in C2; lives in this module so the
// ledger writers and the rerun detector share their imports cleanly.
// Pure SQL, no LLM, idempotent at the row level (writes one rerun row
// per matching prior session).

/** v1 normalization per AC L1.1-B-02: lowercase, trim, collapse whitespace. */
function normalizeGoal(goal: string): string {
  return goal.toLowerCase().trim().replace(/\s+/g, ' ');
}

export interface RerunDetection {
  matched_sessions: string[];
  rerun_rows_written: number;
}

/**
 * Look for prior sessions in the last 24h with the same normalized
 * goal text and the same `created_by` user. For each match, write one
 * `cypher_outcomes` row keyed against the EARLIER session (AC
 * L1.1-X-05 — never the new session) with `signal_kind='rerun'`,
 * `value=-0.7`. Returns the list of matched prior session ids and
 * the count of rows actually written.
 *
 * Best-effort: any failure logs to stderr and returns an empty
 * detection (AC L1.1-B-06). The caller treats this as instrumentation,
 * not a load-bearing path.
 */
export function detectRerun(
  db: Database.Database,
  new_session_id: string,
): RerunDetection {
  if (isRerunDisabled()) {
    return { matched_sessions: [], rerun_rows_written: 0 };
  }
  try {
    type SessRow = { goal: string; user: string | null; started_at: string };
    const sess = db.prepare(`
      SELECT goal, user, started_at FROM cypher_sessions WHERE session_id = ?
    `).get(new_session_id) as SessRow | undefined;
    if (!sess) return { matched_sessions: [], rerun_rows_written: 0 };

    const normalized = normalizeGoal(sess.goal);
    if (normalized.length === 0) return { matched_sessions: [], rerun_rows_written: 0 };

    // Match on the same normalized goal + same user, started in the 24h
    // before the new session, EXCLUDING the new session itself.
    type Match = { session_id: string };
    const matches = db.prepare(`
      SELECT session_id FROM cypher_sessions
      WHERE session_id != ?
        AND user = ?
        AND lower(trim(goal)) = ?
        AND started_at >= datetime(?, '-24 hours')
        AND started_at < ?
    `).all(
      new_session_id,
      sess.user,
      normalized,
      sess.started_at,
      sess.started_at,
    ) as Match[];

    let written = 0;
    for (const m of matches) {
      const r = recordOutcomeSignal(db, {
        session_id: m.session_id,
        signal_kind: 'rerun',
        value: RERUN_VALUE,
        weight: 1.0,
        metadata: { trigger_session_id: new_session_id, similarity: 'exact_lowercase' },
        created_by: new_session_id,
      });
      if (r.ok) written += 1;
    }
    return {
      matched_sessions: matches.map(m => m.session_id),
      rerun_rows_written: written,
    };
  } catch (err) {
    // Best-effort; never fail the dispatch.
    process.stderr.write(`[outcomes.detectRerun] ${(err as Error)?.message ?? String(err)}\n`);
    return { matched_sessions: [], rerun_rows_written: 0 };
  }
}
