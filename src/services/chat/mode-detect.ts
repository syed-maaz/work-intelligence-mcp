/**
 * Heuristic chat-mode detector (78a-02 / SPEC item 1).
 *
 * Pure function. NO I/O, NO LLM, NO async, NO env reads. Maps a single
 * message (plus optional history + manual override) to a `ModeDetection`
 * verdict consumed by `/api/chat` (78a-03).
 *
 * Adversarial fixes baked in:
 *   #1  Imperative-verb signal at +8 ensures the canary
 *       `"I'm exhausted, investigate JIRA-15702"` routes WORK with
 *       confidence ≥ 0.7 (jira5 + imperative8 = 13 / 15 ≈ 0.87).
 *   #2  Persistence boost (+2) only stacks when the prior turn's
 *       confidence ≥ 0.7 — low-confidence chains do not compound.
 *   #3  AMBIGUOUS only fires when there is no explicit referent
 *       (no slash command, no Jira key, no file path, no PR ref).
 */

import {
  WEIGHTS,
  findFamilySignals,
  findFileRefSignals,
  findImperativeSignals,
  findJiraSignals,
  findMoodSignals,
  findPRRefSignals,
  findSlashSignals,
  findWorkContextSignals,
  hasExplicitReferent,
} from './mode-detect.signals.js';

export type Mode = 'work' | 'life' | 'ambiguous';
export type ModeSource = 'auto' | 'manual';

export interface ModeDetection {
  mode: Mode;
  /** 0..1 — `min(1, max(workScore, lifeScore) / 15)` on the heuristic path. */
  confidence: number;
  /** Labelled signals, e.g. `["jira:JIRA-15702", "imperative:investigate"]`. */
  signals: string[];
  modeSource: ModeSource;
  /** Present iff `mode === 'ambiguous'`. */
  clarifyingPrompt?: string;
}

export interface PriorTurn {
  mode: Mode;
  confidence: number;
}

export interface DetectModeArgs {
  message: string;
  /** Last few turns; only `history[history.length - 1]` is read in 78a. */
  history?: PriorTurn[];
  /** User chip override; `auto` is sent as `undefined`. */
  manualMode?: 'work' | 'life';
}

/** Yesterday's design payload baseline (CONTEXT.md § Claude's Discretion). */
const AMBIGUOUS_PROMPT =
  'Looks like a quick check-in — quick technical thing or want to talk?';

const CONFIDENCE_DENOMINATOR = 15;
const PRIOR_TURN_CONFIDENCE_THRESHOLD = 0.7;
const CLOSE_CALL_MARGIN = 4;

/**
 * Sum the per-kind weight for each signal in `signals`. The signal label
 * prefix (`"slash:"`, `"jira:"`, etc.) determines its weight bucket.
 */
function scoreSignals(signals: string[]): number {
  let score = 0;
  for (const sig of signals) {
    const colon = sig.indexOf(':');
    const kind = colon === -1 ? sig : sig.slice(0, colon);
    switch (kind) {
      case 'slash':
        score += WEIGHTS.slash;
        break;
      case 'jira':
        score += WEIGHTS.jira;
        break;
      case 'fileRef':
        score += WEIGHTS.fileRef;
        break;
      case 'prRef':
        score += WEIGHTS.prRef;
        break;
      case 'imperative':
        score += WEIGHTS.imperative;
        break;
      case 'mood':
        score += WEIGHTS.mood;
        break;
      case 'family':
        score += WEIGHTS.family;
        break;
      case 'workContext':
        score += WEIGHTS.workContext;
        break;
      case 'persistence':
        score += WEIGHTS.persistence;
        break;
      default:
        // Unknown kind — ignore. Keeps the function total over its inputs.
        break;
    }
  }
  return score;
}

export function detectMode(args: DetectModeArgs): ModeDetection {
  // 1. Manual override short-circuit (CHAT-06).
  if (args.manualMode === 'work' || args.manualMode === 'life') {
    return {
      mode: args.manualMode,
      confidence: 1.0,
      signals: [`manual:${args.manualMode}`],
      modeSource: 'manual',
    };
  }

  const { message } = args;

  // 2. Collect signals.
  const workSignals: string[] = [
    ...findSlashSignals(message),
    ...findJiraSignals(message),
    ...findFileRefSignals(message),
    ...findPRRefSignals(message),
    ...findImperativeSignals(message),
    ...findWorkContextSignals(message),
  ];
  const lifeSignals: string[] = [
    ...findMoodSignals(message),
    ...findFamilySignals(message),
  ];

  // 3. Persistence boost — gated on prior turn confidence ≥ 0.7
  //    (adversarial fix #2). Only WORK or LIFE prior modes contribute.
  const prior =
    args.history && args.history.length > 0
      ? args.history[args.history.length - 1]
      : undefined;
  if (
    prior &&
    prior.confidence >= PRIOR_TURN_CONFIDENCE_THRESHOLD &&
    (prior.mode === 'work' || prior.mode === 'life')
  ) {
    const label = `persistence:${prior.mode}`;
    if (prior.mode === 'work') {
      workSignals.push(label);
    } else {
      lifeSignals.push(label);
    }
  }

  // 4. Score.
  const workScore = scoreSignals(workSignals);
  const lifeScore = scoreSignals(lifeSignals);

  // 5. Empty-signals AMBIGUOUS short-circuit.
  if (workScore === 0 && lifeScore === 0) {
    return {
      mode: 'ambiguous',
      confidence: 0,
      signals: [],
      modeSource: 'auto',
      clarifyingPrompt: AMBIGUOUS_PROMPT,
    };
  }

  // 6. AMBIGUOUS gate (CHAT-05 / adversarial fix #3).
  //    Fires ONLY when no explicit referent (Jira key, slash, file, PR) is
  //    present AND one of:
  //      a) both sides scored AND scores are within `CLOSE_CALL_MARGIN`
  //         (close call — genuinely uncertain), or
  //      b) only the life side scored AND the message ends in a clarifying
  //         question (mood + open invitation — "exhausted and stressed,
  //         can we talk?" is the canonical case from the SPEC AC list).
  //    Per SPEC item 6, the gate requires zero explicit referents — that
  //    invariant is preserved here.
  if (!hasExplicitReferent(message)) {
    const bothSidesScored = workScore > 0 && lifeScore > 0;
    const close = Math.abs(workScore - lifeScore) < CLOSE_CALL_MARGIN;
    const moodOnlyOpenQuestion =
      workScore === 0 && lifeScore > 0 && /\?/.test(message);
    if ((bothSidesScored && close) || moodOnlyOpenQuestion) {
      return {
        mode: 'ambiguous',
        confidence: Math.min(
          1,
          Math.max(workScore, lifeScore) / CONFIDENCE_DENOMINATOR
        ),
        signals: [...workSignals, ...lifeSignals],
        modeSource: 'auto',
        clarifyingPrompt: AMBIGUOUS_PROMPT,
      };
    }
  }

  // 7. Decide WORK vs LIFE — preserve full evidence (winner ∪ loser).
  const mode: Mode = workScore >= lifeScore ? 'work' : 'life';
  const confidence = Math.min(
    1,
    Math.max(workScore, lifeScore) / CONFIDENCE_DENOMINATOR
  );

  return {
    mode,
    confidence,
    signals: [...workSignals, ...lifeSignals],
    modeSource: 'auto',
  };
}
