/**
 * ADR-053 Phase 3.2 — PM re-entry (posture='pm-resume').
 *
 * PM does not stay alive during execution (Q7 Option B). Executors emit
 * events into sub_task_events; the user (or a future auto-trigger) fires
 * `/wi resume <parent_goal_id>`, and PM re-enters to read the unresolved
 * events and decide per-event: ack / revise / amend / escalate.
 *
 * This module is the deterministic core: read unresolved rows, resolve them,
 * and drive a decision callback per event. The live LLM decision-maker plugs
 * into `pmResume` via the `decide` callback; unit tests inject a deterministic
 * one so the resolution bookkeeping is provable without a model call.
 *
 * See docs/docs/adr/adr-053-multi-stage-orchestration.md § Q7 / AC-U3.
 */
import type Database from 'better-sqlite3';

export interface SubTaskEvent {
  id: number;
  sub_task_id: string;
  kind: string;
  payload_json: string;
  created_at: string;
}

export type ResumeAction = 'ack' | 'revise' | 'amend' | 'escalate';

export interface ResumeDecision {
  action: ResumeAction;
  note?: string;
}

export interface ResumeResult {
  resolved: number;
  escalated: number;
  decisions: Array<{ event_id: number; action: ResumeAction }>;
}

/** Read all unresolved events for a sub-task, oldest first. */
export function readUnresolvedEvents(db: Database.Database, subTaskId: string): SubTaskEvent[] {
  return db
    .prepare(
      `SELECT id, sub_task_id, kind, payload_json, created_at
         FROM sub_task_events
        WHERE sub_task_id = ? AND resolved_at IS NULL
        ORDER BY id ASC`,
    )
    .all(subTaskId) as SubTaskEvent[];
}

/** Mark an event resolved with a resolver identity + note. */
export function resolveEvent(
  db: Database.Database,
  eventId: number,
  resolvedBy: 'pm' | 'human' | 'auto',
  note?: string,
): void {
  db.prepare(
    `UPDATE sub_task_events
        SET resolved_at = datetime('now'), resolved_by = ?, resolution_note = ?
      WHERE id = ?`,
  ).run(resolvedBy, note ?? null, eventId);
}

/**
 * PM re-entry over a sub-task's unresolved events. For each event the `decide`
 * callback returns an action:
 *   - ack / revise / amend → the event is resolved (resolved_by='pm').
 *   - escalate             → the event is LEFT open (pending human) and counted
 *                            as escalated; PM halts on it.
 *
 * Returns counts + the per-event decisions for the audit trail. The revise /
 * amend follow-up card emission is the caller's responsibility (it has the
 * board-emit handle); this core just does the bookkeeping deterministically.
 */
export function pmResume(
  db: Database.Database,
  subTaskId: string,
  decide: (kind: string, event: SubTaskEvent) => ResumeDecision,
): ResumeResult {
  const open = readUnresolvedEvents(db, subTaskId);
  let resolved = 0;
  let escalated = 0;
  const decisions: Array<{ event_id: number; action: ResumeAction }> = [];

  for (const ev of open) {
    const decision = decide(ev.kind, ev);
    decisions.push({ event_id: ev.id, action: decision.action });
    if (decision.action === 'escalate') {
      escalated++;
      continue; // leave open — pending human
    }
    resolveEvent(db, ev.id, 'pm', decision.note);
    resolved++;
  }

  return { resolved, escalated, decisions };
}
