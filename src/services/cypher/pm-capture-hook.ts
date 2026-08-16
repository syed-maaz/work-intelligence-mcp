/**
 * PM capture hook — ADR-043 Phase 3 (Shape A), AC-A1.
 *
 * Extracted into its own module so the loop.ts insertion is a minimal,
 * merge-friendly guarded block (loop.ts is co-edited by the ADR-042 Stage 1
 * work; keeping the logic here shrinks the conflict surface to ~10 lines).
 *
 * Contract: after Cypher's Stage 1 refiner produces a `refined_goal`, if its
 * intent classifies as NON-execute (brainstorm | plan | decide), the loop
 * should NOT dispatch Stage 2/3. Instead it files a PM board card and closes
 * the session `outcome='captured_to_board'`. This is the mechanism that fixes
 * the ADR-041-class miscategorization at the source (see ADR-043 § Context).
 *
 * Gating (dormant until ADR-042 lands): the loop calls this ONLY when BOTH
 *   - WI_STAGE1_ENABLED=1   (Stage 1 reliably produces refined_goal.intent), AND
 *   - PM_ORCHESTRATION_ENABLED=1   (PM layer active)
 * are set. Both default off, so master behavior is unchanged. When either is
 * off, `shouldCaptureToBoard()` returns null and the loop proceeds to EXECUTE
 * exactly as today.
 */

import type Database from 'better-sqlite3';
import { capturePmTicket, mapRefinedIntent, type PmIntent } from './task-memory.js';

export interface CaptureDecision {
  /** The non-execute PM intent this goal maps to. */
  intent: Exclude<PmIntent, 'execute'>;
  /** A concise card title derived from the refined goal / raw goal. */
  title: string;
  /** Goal text carried onto the card for later promotion. */
  goal_text: string;
}

/**
 * Decide whether a refined goal should be captured to the PM board instead of
 * dispatched. Pure + side-effect-free — returns the capture decision or null.
 *
 * @param refinedGoalJson  The JSON string SCOPE persisted (may be null).
 * @param rawGoal          The user's original goal (title fallback).
 * @returns CaptureDecision when both flags are on AND intent is non-execute;
 *          null otherwise (→ loop proceeds to EXECUTE).
 */
export function shouldCaptureToBoard(
  refinedGoalJson: string | null,
  rawGoal: string,
): CaptureDecision | null {
  // Dormant unless BOTH flags are on. This is the ADR-042 dependency gate:
  // without reliable Stage 1 intent, we do not silently re-route work.
  if (process.env.WI_STAGE1_ENABLED !== '1') return null;
  if (process.env.PM_ORCHESTRATION_ENABLED !== '1') return null;
  if (!refinedGoalJson) return null;

  let parsed: { intent?: unknown; target?: unknown; success_criteria?: unknown };
  try {
    parsed = JSON.parse(refinedGoalJson) as typeof parsed;
  } catch {
    // Malformed brief → not our concern; let the normal path handle it.
    return null;
  }

  const rawIntent = typeof parsed.intent === 'string' ? parsed.intent : null;
  const pmIntent = mapRefinedIntent(rawIntent);
  if (pmIntent === 'execute') return null; // execute work dispatches — never captured.

  // Title: prefer refined target if present, else the raw goal, capped.
  const target = typeof parsed.target === 'string' ? parsed.target.trim() : '';
  const title = (target || rawGoal).slice(0, 120);

  return { intent: pmIntent, title, goal_text: rawGoal };
}

export interface CaptureToBoardResult {
  /** User-facing surface line per AC-A1. */
  surface: string;
  /** The created card id. */
  task_id: string;
  /** Card number for display, null if unassigned. */
  card_number: number | null;
  intent: Exclude<PmIntent, 'execute'>;
}

/**
 * Execute the capture: file the PM card and produce the AC-A1 surface string
 * ("filed as card #N in ready. /pm next for backlog."). Never dispatches.
 *
 * @param parentTaskId  When set (AC-A2 mid-session capture), links the card to
 *                      the current task without derailing its session.
 */
export function captureToBoard(
  db: Database.Database,
  decision: CaptureDecision,
  parentTaskId?: string,
): CaptureToBoardResult {
  const captured = capturePmTicket(db, {
    title: decision.title,
    intent: decision.intent,
    goal_text: decision.goal_text,
    parent_task_id: parentTaskId,
  });

  const cardRef = captured.card_number != null ? `#${captured.card_number}` : `${captured.id}`;
  const surface =
    `Filed as card ${cardRef} in ready (intent: ${decision.intent}). ` +
    `This is deliberative work — parked on the backlog, not executed. ` +
    `Run \`/pm next\` for the ranked backlog, or \`/pm bump ${captured.id}\` to promote it.`;

  return {
    surface,
    task_id: captured.id,
    card_number: captured.card_number,
    intent: decision.intent,
  };
}
