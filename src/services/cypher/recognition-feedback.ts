/**
 * Recognition-feedback loop — wrong-suggestion → Beta priors (2026-07-17).
 *
 * Closes the learning loop opened by Stage-1's low-confidence recognition
 * flag (see stage1.ts computeRecognitionConfidence + loop.ts SCOPE surface).
 * When recognition was low-confidence, the SCOPE surface asks the user a
 * NON-BLOCKING thumbs question naming the top-1 skill. Their reply lands here.
 *
 * User decision (2026-07-16): feed the feedback into **Beta priors ONLY** —
 * down-weight the wrong skill; DO NOT touch the recognition ranking blend.
 * That means this module's job is:
 *
 *   1. Record the human verdict onto prompt_outcomes.user_verdict (reusing
 *      the ADR-039 v86 substrate) so OPRO's prompt-clarity signal captures it.
 *   2. Move the Beta posterior for the relevant skill(s) via learn.ts —
 *      the SOLE writer of skill_priors (hard-rule-7). 'user_observed' tier
 *      (weight 1.0) because a human explicitly rated it.
 *   3. When the user NAMES a different (right) skill, credit that skill and
 *      record it on cypher_sessions.skill_actually_invoked (the v62 credit-
 *      reassignment column) so future credit assignment is honest.
 *
 * Verdict → priors mapping (chosen_skill is the skill Cypher suggested):
 *   - 'useful'         → chosen_skill 'success'  (the guess was right)
 *   - 'wrong_scope'    → chosen_skill 'failed'   (the guess was wrong)
 *   - 'wrong_question' → chosen_skill 'failed'   (also a miss — the prompt/
 *                        recognition was off; down-weight the guess)
 *   - 'unrated'        → NO prior movement (explicit non-answer)
 *
 * When `skill` is supplied AND differs from chosen_skill, that named skill
 * gets a 'success' increment regardless of the verdict (the user told us
 * what the right skill was). We never DOUBLE-credit: if the named skill
 * equals chosen_skill, only the verdict-mapped update fires.
 *
 * IMPORTANT — this module NEVER changes the ranking blend. It only moves
 * priors + records the verdict. Recall (the scoring axis) is out of scope
 * per the locked decision; this loop makes skill TRUST self-improving.
 */

import type Database from 'better-sqlite3';
import { recordSkillOutcomes } from './learn.js';
import {
  updateUserVerdict,
  isUserVerdict,
  type UserVerdict,
} from '../../db/queries/research-cache.js';

export interface RecognitionFeedbackInput {
  sessionId: string;
  /** The human verdict — one of the v86 prompt_outcomes.user_verdict enums. */
  verdict: UserVerdict;
  /**
   * Optional: the skill the user says is actually right. When present and
   * different from chosen_skill, it gets credited + written to
   * skill_actually_invoked. Free-text; validated only as non-empty.
   */
  skill?: string | null;
}

export interface RecognitionFeedbackResult {
  ok: true;
  session_id: string;
  verdict: UserVerdict;
  /** The skill Cypher had suggested (from cypher_sessions.chosen_skill). */
  chosen_skill: string | null;
  /** The skill the user named as correct, if any (also → skill_actually_invoked). */
  named_skill: string | null;
  /** task_class the priors were updated under. */
  task_class: string;
  /** Per-skill prior movements applied (skill → outcome). Empty when none. */
  prior_updates: Array<{ skill: string; outcome: 'success' | 'failed' }>;
  /** Whether the prompt_outcomes.user_verdict row was found + updated. */
  verdict_row_updated: boolean;
}

export type RecognitionFeedbackError =
  | { ok: false; reason: 'SESSION_NOT_FOUND' }
  | { ok: false; reason: 'INVALID_VERDICT' };

/**
 * Record a human recognition-feedback verdict for a Cypher session.
 *
 * Idempotent-ish: re-recording the same verdict re-updates the
 * prompt_outcomes row (no-op on value) but WILL move the prior again —
 * callers should record once per human answer. The endpoint layer is the
 * natural throttle (one POST per thumbs click).
 *
 * Returns a structured result the endpoint can map to JSON. Never throws on
 * a missing prompt_outcomes row (that's a soft miss — priors still move).
 */
export function recordRecognitionFeedback(
  db: Database.Database,
  input: RecognitionFeedbackInput,
): RecognitionFeedbackResult | RecognitionFeedbackError {
  if (!isUserVerdict(input.verdict)) {
    return { ok: false, reason: 'INVALID_VERDICT' };
  }

  const session = db
    .prepare(
      `SELECT chosen_skill, task_class FROM cypher_sessions WHERE session_id = ?`,
    )
    .get(input.sessionId) as
    | { chosen_skill: string | null; task_class: string | null }
    | undefined;
  if (!session) {
    return { ok: false, reason: 'SESSION_NOT_FOUND' };
  }

  const chosenSkill = session.chosen_skill ?? null;
  const taskClass = session.task_class || '*';
  const namedSkill =
    typeof input.skill === 'string' && input.skill.trim().length > 0
      ? input.skill.trim()
      : null;

  const priorUpdates: Array<{ skill: string; outcome: 'success' | 'failed' }> = [];

  // ── 1. Record the verdict onto prompt_outcomes (best-effort). ──────────
  // Miss is non-fatal: scoreRefinedGoal() is fire-and-forget, so the row may
  // not exist yet — and on a fresh/partial DB the table itself may be absent.
  // Priors still move — that's the load-bearing signal. Any error here is
  // swallowed so a missing outcomes row never blocks the learning update.
  let verdictRowUpdated = false;
  if (input.verdict !== 'unrated') {
    try {
      const vr = updateUserVerdict(db, input.sessionId, input.verdict);
      verdictRowUpdated = vr.ok;
    } catch {
      verdictRowUpdated = false;
    }
  }

  // ── 2. Move the Beta prior for the SUGGESTED skill per the verdict. ────
  // 'unrated' is an explicit non-answer → no prior movement.
  if (chosenSkill && input.verdict !== 'unrated') {
    const chosenOutcome: 'success' | 'failed' =
      input.verdict === 'useful' ? 'success' : 'failed';
    // Only move the chosen skill's prior here when the user did NOT name a
    // different right skill for a 'success'-implying verdict — otherwise the
    // named-skill branch below owns the 'success' credit. But a 'wrong'
    // verdict ALWAYS down-weights the chosen skill (it was wrong regardless
    // of whether the user named the alternative).
    const namedDiffers = namedSkill !== null && namedSkill !== chosenSkill;
    if (chosenOutcome === 'failed' || !namedDiffers) {
      recordSkillOutcomes(db, chosenSkill, chosenOutcome, taskClass, 'user_observed');
      priorUpdates.push({ skill: chosenSkill, outcome: chosenOutcome });
    }
  }

  // ── 3. Credit the NAMED right skill + record it as actually-invoked. ───
  if (namedSkill && namedSkill !== chosenSkill) {
    recordSkillOutcomes(db, namedSkill, 'success', taskClass, 'user_observed');
    priorUpdates.push({ skill: namedSkill, outcome: 'success' });
    // Reassign credit: the user told us the RIGHT skill. Writing
    // skill_actually_invoked keeps future credit-assignment honest (the v62
    // column feeds CAP-12-FIX's clean-priors reader).
    db.prepare(
      `UPDATE cypher_sessions SET skill_actually_invoked = ? WHERE session_id = ?`,
    ).run(namedSkill, input.sessionId);
  }

  return {
    ok: true,
    session_id: input.sessionId,
    verdict: input.verdict,
    chosen_skill: chosenSkill,
    named_skill: namedSkill,
    task_class: taskClass,
    prior_updates: priorUpdates,
    verdict_row_updated: verdictRowUpdated,
  };
}
