/**
 * Phase 71-01 — recordOutcome service for POST /api/brain/learn.
 *
 * Closes the learning loop:
 *   1. Validate the outcome literal.
 *   2. UPDATE brain_decisions SET outcome=?, outcome_recorded_at=? WHERE id=?.
 *   3. SELECT the updated row.
 *   4. Hand the row to MemoryEnricher.enrichDecision (palace 'decisions' wing).
 *   5. Return the updated row to the caller.
 *
 * Errors are surfaced as typed exceptions so the route handler can map them
 * to 400 / 404 / 500 without sniffing strings.
 *
 * ADR-024 Pillar 4 — Memory Decision Loop (learn side).
 */

import type Database from 'better-sqlite3';
import type { MemoryEnricher, BrainDecisionRow } from '../../intelligence/memory-enricher.js';

export type DecisionOutcome = 'success' | 'failed' | 'abandoned';

export const VALID_OUTCOMES: ReadonlyArray<DecisionOutcome> = [
  'success',
  'failed',
  'abandoned',
];

export class InvalidOutcomeError extends Error {
  constructor(public readonly received: unknown) {
    super(
      `outcome must be one of: ${VALID_OUTCOMES.join(', ')} (received: ${String(received)})`,
    );
    this.name = 'InvalidOutcomeError';
  }
}

export class DecisionNotFoundError extends Error {
  constructor(public readonly decisionId: string) {
    super(`brain_decisions row not found: ${decisionId}`);
    this.name = 'DecisionNotFoundError';
  }
}

export interface RecordOutcomeArgs {
  db: Database.Database;
  decisionId: string;
  outcome: string;
  /** Optional palace writer. Omit in tests/SQLite-only contexts. */
  memoryEnricher?: MemoryEnricher | null;
}

export interface RecordOutcomeResult {
  /** Updated brain_decisions row. */
  row: BrainDecisionRow & {
    outcome: DecisionOutcome;
    outcome_recorded_at: number;
  };
  /** True if a palace write was attempted (i.e. memoryEnricher was supplied). */
  palaceUpdated: boolean;
}

/**
 * Validate inputs, mutate SQLite, and replicate to palace.
 *
 * The SQLite UPDATE + SELECT pair runs inside a single `db.transaction` so
 * a concurrent reader never observes the row mid-update.
 */
export async function recordOutcome(args: RecordOutcomeArgs): Promise<RecordOutcomeResult> {
  const { db, decisionId, outcome, memoryEnricher } = args;

  if (typeof decisionId !== 'string' || decisionId.trim().length === 0) {
    throw new InvalidOutcomeError('decision_id_required');
  }
  if (!VALID_OUTCOMES.includes(outcome as DecisionOutcome)) {
    throw new InvalidOutcomeError(outcome);
  }

  const recordedAt = Date.now();

  const txn = db.transaction((id: string, status: DecisionOutcome, ts: number) => {
    const update = db
      .prepare(
        `UPDATE brain_decisions
            SET outcome = ?, outcome_recorded_at = ?
          WHERE id = ?`,
      )
      .run(status, ts, id);
    if (update.changes === 0) {
      // Distinguish "row missing" from "no-op update" — schema enforces id PK,
      // so changes=0 always means the row was not found.
      throw new DecisionNotFoundError(id);
    }
    return db
      .prepare(`SELECT * FROM brain_decisions WHERE id = ?`)
      .get(id) as BrainDecisionRow | undefined;
  });

  let updatedRow: BrainDecisionRow | undefined;
  try {
    updatedRow = txn(decisionId, outcome as DecisionOutcome, recordedAt);
  } catch (err) {
    if (err instanceof DecisionNotFoundError) throw err;
    throw err;
  }

  if (!updatedRow) {
    // Defensive: SELECT after a successful UPDATE on a PK should always return.
    throw new DecisionNotFoundError(decisionId);
  }

  let palaceUpdated = false;
  if (memoryEnricher) {
    // enrichDecision is fire-and-forget internally — never throws — but we
    // still await so callers can rely on best-effort ordering.
    await memoryEnricher.enrichDecision(updatedRow);
    palaceUpdated = true;
  }

  // ── Phase 79-05: auto-populate topic_notebooks from decision outcomes ──
  try {
    const question = (updatedRow.question || '').toLowerCase();
    const kw = question.split(/\W+/).filter((w) => w.length >= 4).slice(0, 5);
    if (kw.length > 0) {
      const clauses = kw.map(() => `lower(name) LIKE ?`).join(' OR ');
      const params = kw.map((k) => `%${k}%`);
      const matchedTopics = db
        .prepare(`SELECT name FROM topics WHERE ${clauses} LIMIT 3`)
        .all(...params) as Array<{ name: string }>;
      for (const t of matchedTopics) {
        const snippet = [
          `## Decision ${new Date(recordedAt).toISOString()}`,
          `**Q:** ${updatedRow.question}`,
          `**Decision:** ${(updatedRow.decision || '').slice(0, 600)}`,
          `**Outcome:** ${outcome}`,
          '',
        ].join('\n');
        const existing = db
          .prepare(`SELECT content, last_message_id, message_count, state_json FROM topic_notebooks WHERE topic_name = ?`)
          .get(t.name) as { content: string; last_message_id: number; message_count: number; state_json: string } | undefined;
        const merged = existing?.content
          ? `${existing.content.slice(0, 40000)}\n\n${snippet}`.slice(0, 45000)
          : snippet;
        db.prepare(
          `INSERT INTO topic_notebooks (topic_name, content, last_message_id, message_count, state_json, last_updated)
           VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(topic_name) DO UPDATE SET
             content = excluded.content,
             last_updated = excluded.last_updated`,
        ).run(
          t.name,
          merged,
          existing?.last_message_id ?? 0,
          existing?.message_count ?? 0,
          existing?.state_json ?? '{}',
        );
      }
    }
  } catch (err) {
    console.error('[brain/learn] notebook auto-populate failed (non-fatal):', err);
  }

  return {
    row: {
      ...updatedRow,
      outcome: outcome as DecisionOutcome,
      outcome_recorded_at: recordedAt,
    },
    palaceUpdated,
  };
}
