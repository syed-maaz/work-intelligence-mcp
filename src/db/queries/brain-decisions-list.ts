import type Database from 'better-sqlite3';

export interface BrainDecisionRow {
  id: string;
  question: string;
  decision: string;
  rationale: string | null;
  confidence: number | null;
  outcome: string | null;
  user: string;
  day_iso: string;
  created_at: number;
}

export interface ListBrainDecisionsOpts {
  user: string;
  since?: string;
  limit?: number;
}

export interface ListBrainDecisionsResult {
  decisions: BrainDecisionRow[];
  total: number;
}

/**
 * List brain_decisions for audit / Atlas "what did you decide this week?"
 * GAP-004 (2026-05-21).
 */
export function listBrainDecisions(
  db: Database.Database,
  opts: ListBrainDecisionsOpts,
): ListBrainDecisionsResult {
  const user = opts.user.trim() || 'anon';
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 20)));

  let sinceMs: number | undefined;
  if (opts.since?.trim()) {
    const parsed = Date.parse(opts.since.trim());
    if (!Number.isNaN(parsed)) sinceMs = parsed;
  }

  const countRow = sinceMs !== undefined
    ? db.prepare(
        `SELECT COUNT(*) AS c FROM brain_decisions WHERE user = ? AND created_at >= ?`,
      ).get(user, sinceMs) as { c: number }
    : db.prepare(
        `SELECT COUNT(*) AS c FROM brain_decisions WHERE user = ?`,
      ).get(user) as { c: number };

  const rows = sinceMs !== undefined
    ? db.prepare(
        `SELECT id, question, decision, rationale, confidence, outcome, user, day_iso, created_at
         FROM brain_decisions
         WHERE user = ? AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT ?`,
      ).all(user, sinceMs, limit) as BrainDecisionRow[]
    : db.prepare(
        `SELECT id, question, decision, rationale, confidence, outcome, user, day_iso, created_at
         FROM brain_decisions
         WHERE user = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      ).all(user, limit) as BrainDecisionRow[];

  return { decisions: rows, total: countRow.c };
}
