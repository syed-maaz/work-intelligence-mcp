/**
 * Cypher task-shape judgment — complexity scorer (2026-06-13).
 *
 * Decides what discipline a goal warrants. Three verdicts:
 *
 *   - 'light'      — small, well-understood, single-session-shippable.
 *                    Cypher records decisions / findings / ACs as a
 *                    task note, executes, ships. No sprint ceremony.
 *   - 'heavy'      — needs planning before execution. Cypher surfaces
 *                    a sprint card with proposed waves, ACs, deps,
 *                    parallel groups, research needs. Halts with
 *                    asked_user. Maaz approves → work_items seeded
 *                    → first slice dispatches.
 *   - 'borderline' — Cypher is uncertain (score within ±0.1 of the
 *                    threshold). Ask one clarifying question.
 *
 * Signal model (additive, capped):
 *   +signal points push toward 'heavy'.
 *   The same dial applies regardless of which repo is touched. WI
 *   self-development and customer-repo work go through the same
 *   classifier; what differs is the path-classifier verdict at the
 *   write stage, NOT the planning discipline.
 *
 * Tunable threshold: HEAVY_THRESHOLD env (default 5). Borderline
 * window: ±1 from threshold. Calibrated against today's session log
 * — first 5-10 real engagements will surface miscalibrations and the
 * threshold gets tuned. Threshold lives in env so it's adjustable
 * without redeploy.
 *
 * This module is pure: input → score + reasoning. The runtime
 * (run.ts) decides what to DO with each verdict in the plan stage.
 */

import type Database from 'better-sqlite3';
import { impactedBy, listWorkItems } from './pm.js';

export type ComplexityVerdict = 'light' | 'heavy' | 'borderline';

export interface ComplexitySignal {
  name: string;
  weight: number;
  /** Plain-English why this signal fired. Goes into reasoning + sprint card. */
  rationale: string;
}

export interface ComplexityResult {
  verdict: ComplexityVerdict;
  score: number;
  threshold: number;
  signals: ComplexitySignal[];
  /** One-paragraph human-readable explanation. */
  reasoning: string;
  /** When verdict='borderline': the clarifying question to ask. */
  clarifying_question?: string;
}

export interface ScoreInput {
  goal: string;
  /** Files the caller knows the work will touch (best-effort hint). */
  hint_files?: string[];
  /** Caller's task_class hint. Helps the scorer pull the right candidates. */
  task_class?: string;
  /** Caller's explicit override — 'force_heavy' or 'force_light' bypass scoring. */
  override?: 'force_heavy' | 'force_light';
}

const DEFAULT_THRESHOLD = 5;

/**
 * Score a goal's complexity. Pure: reads work_items via pm.ts helpers
 * (Hard rule 7 — no direct table access from outside the gateway).
 */
export function scoreComplexity(db: Database.Database, input: ScoreInput): ComplexityResult {
  const threshold = parseInt(process.env.CYPHER_HEAVY_THRESHOLD ?? String(DEFAULT_THRESHOLD), 10);
  const signals: ComplexitySignal[] = [];

  // ── Override paths ──────────────────────────────────────────────────────
  if (input.override === 'force_heavy') {
    signals.push({ name: 'override', weight: 99, rationale: 'caller passed override=force_heavy' });
    return makeResult(threshold, signals, input.goal, 'forced heavy by caller');
  }
  if (input.override === 'force_light') {
    return {
      verdict: 'light', score: 0, threshold, signals: [
        { name: 'override', weight: 0, rationale: 'caller passed override=force_light' },
      ],
      reasoning: 'forced light by caller',
    };
  }

  const goal = input.goal || '';

  // ── Signal 1: goal length ───────────────────────────────────────────────
  // Long goals tend to be multi-step. Cap so a 3-paragraph rant doesn't
  // dominate the score.
  if (goal.length > 200) {
    signals.push({ name: 'long_goal', weight: 2, rationale: `goal is ${goal.length} chars — long-form goals usually have multiple parts` });
  } else if (goal.length > 100) {
    signals.push({ name: 'medium_goal', weight: 1, rationale: `goal is ${goal.length} chars — moderate description length` });
  }

  // ── Signal 2: multi-part conjunctions ───────────────────────────────────
  // "Build X and Y and Z" → 3 parts → heavy. Threshold: ≥ 2 conjunctions.
  const conjunctionMatches = goal.match(/\b(and|plus|then|also)\b/gi) ?? [];
  if (conjunctionMatches.length >= 3) {
    signals.push({ name: 'multi_part', weight: 3, rationale: `${conjunctionMatches.length} conjunction(s) — goal has multiple distinct parts` });
  } else if (conjunctionMatches.length === 2) {
    signals.push({ name: 'two_part', weight: 1, rationale: `2 conjunctions — small multi-part work` });
  }

  // ── Signal 3: planning keywords ─────────────────────────────────────────
  // Words that signal the user already thinks this is sprint-shaped.
  const PLANNING_KEYWORDS = /\b(sprint|wave|adr|prd|architecture|migration|refactor|backfill|cluster|pipeline|consolidat|propose-then-approve|blast.radius|parallel|fan.out)\b/gi;
  const planningHits = goal.match(PLANNING_KEYWORDS) ?? [];
  if (planningHits.length >= 2) {
    signals.push({ name: 'planning_lang', weight: 3, rationale: `planning vocabulary: ${planningHits.slice(0, 3).map(s => s.toLowerCase()).join(', ')}` });
  } else if (planningHits.length === 1) {
    signals.push({ name: 'planning_lang_light', weight: 1, rationale: `one planning keyword: "${planningHits[0]}"` });
  }

  // ── Signal 4: AC ids referenced ─────────────────────────────────────────
  const acIds = extractAcIds(goal);
  if (acIds.length >= 3) {
    signals.push({ name: 'multi_ac', weight: 3, rationale: `goal references ${acIds.length} AC ids: ${acIds.slice(0, 5).join(', ')}` });
  } else if (acIds.length >= 1) {
    signals.push({ name: 'has_ac', weight: 1, rationale: `goal references AC(s): ${acIds.join(', ')}` });
  }

  // ── Signal 5: hint_files map to many shipped slices ─────────────────────
  // If the user hints at touching critical files, check the impact map.
  if (input.hint_files && input.hint_files.length > 0) {
    let totalImpacted = 0;
    for (const f of input.hint_files) {
      try {
        totalImpacted += impactedBy(db, 'file_path', f).length;
      } catch { /* swallow — table might not exist on fresh DB */ }
    }
    if (totalImpacted >= 5) {
      signals.push({ name: 'critical_path_files', weight: 3, rationale: `hint_files touch ${totalImpacted} prior slice(s) — high blast radius` });
    } else if (totalImpacted >= 2) {
      signals.push({ name: 'shared_files', weight: 1, rationale: `hint_files touch ${totalImpacted} prior slice(s)` });
    }
  }

  // ── Signal 6: existing in-progress work in adjacent area ────────────────
  // Don't start heavy parallel work in a phase that's already mid-sprint.
  if (input.task_class) {
    try {
      const inProgress = listWorkItems(db, { status: 'in_progress', limit: 10 });
      if (inProgress.length >= 3) {
        signals.push({
          name: 'busy_workboard',
          weight: 1,
          rationale: `${inProgress.length} work items already in_progress — adding heavy work compounds load`,
        });
      }
    } catch { /* swallow */ }
  }

  // ── Signal 7: research/spike keywords ───────────────────────────────────
  const RESEARCH_KEYWORDS = /\b(research|spike|investigate.+architecture|design|figure.out|explore|propose)\b/gi;
  const researchHits = goal.match(RESEARCH_KEYWORDS) ?? [];
  if (researchHits.length >= 1) {
    signals.push({ name: 'research_shape', weight: 2, rationale: `research/design vocabulary: ${researchHits[0]}` });
  }

  // ── Signal 8: trivial-shape keywords (NEGATIVE weight) ──────────────────
  // Keywords that strongly signal a small, well-understood task.
  const TRIVIAL_KEYWORDS = /\b(typo|fix.typo|rename|update.copy|add.console\.log|tweak|nudge|small.fix|one.liner)\b/gi;
  const trivialHits = goal.match(TRIVIAL_KEYWORDS) ?? [];
  if (trivialHits.length >= 1) {
    signals.push({ name: 'trivial_shape', weight: -3, rationale: `trivial-shape keyword: ${trivialHits[0]}` });
  }

  return makeResult(threshold, signals, goal, '');
}

function makeResult(
  threshold: number,
  signals: ComplexitySignal[],
  _goal: string,
  preReason: string,
): ComplexityResult {
  const score = signals.reduce((sum, s) => sum + s.weight, 0);
  const borderlineWindow = 1;

  let verdict: ComplexityVerdict;
  let clarifying_question: string | undefined;

  if (score >= threshold + borderlineWindow) {
    verdict = 'heavy';
  } else if (score <= threshold - borderlineWindow - 1) {
    verdict = 'light';
  } else {
    verdict = 'borderline';
    clarifying_question = `This task scores ${score} on complexity (threshold ${threshold}). ` +
      `Is this a quick implementation where I can just record decisions + ACs as I go ` +
      `(reply 'light'), or does it need a proper sprint plan with waves and parallel groups ` +
      `(reply 'heavy')?`;
  }

  const top = [...signals]
    .filter(s => s.weight !== 0)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 4);
  const reasoning = preReason || (
    `Complexity score = ${score} (threshold ${threshold}). ` +
    (verdict === 'heavy'
      ? `Verdict: HEAVY — proper planning recommended. Top signals: ${top.map(s => s.name + '(+' + s.weight + ')').join(', ')}.`
      : verdict === 'light'
        ? `Verdict: LIGHT — single-session execution, record decisions + ACs as a task note. Top signals: ${top.map(s => s.name + '(' + (s.weight > 0 ? '+' : '') + s.weight + ')').join(', ') || 'few signals'}.`
        : `Verdict: BORDERLINE — score is within ±${borderlineWindow} of threshold ${threshold}. Asking for clarification.`)
  );

  return { verdict, score, threshold, signals, reasoning, clarifying_question };
}

/**
 * Extract AC-style identifiers from goal text.
 * Matches PERSONA-AC-7, PERSONA-A-07, JIRA-15702, CYPHER-SLICE-2, PM-3, etc.
 */
function extractAcIds(goal: string): string[] {
  const matches = goal.match(/\b[A-Z][A-Z0-9_]*-(?:[A-Z]+-)?\d+(?:\.\d+)?\b/g) ?? [];
  return Array.from(new Set(matches));
}
