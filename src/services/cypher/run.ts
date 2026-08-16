/**
 * Cypher 9-step contract runtime — Slice A+B (2026-06-13).
 *
 * Implements the contract from `.planning/cypher/03-FRAMEWORK-CONTRACT.md`:
 *
 *   1. investigate  — bounded discovery (≤5 read-only tool calls + 1
 *                     brain.recall) OR skip if claude-mem hits ≥3 with
 *                     similarity > 0.7 OR brain.getDecision confidence
 *                     > 0.85 already exists.
 *   2. ask          — at most 3 clarifying questions, each with a default
 *                     Cypher would pick if the user doesn't answer. When
 *                     unsure, halt with status='asked_user' and questions.
 *   3. research     — gather supporting context (skills, palace, code-graph)
 *                     for the chosen plan shape.
 *   4. plan         — ≤8 leaf tasks per fan-out layer, single-session-
 *                     shippable (≤30 min wall-clock). Calls
 *                     `getRankedSkills` so historically-successful skills
 *                     surface first (CAP-12 learning loop reads here).
 *   5. execute      — run the plan. v1: identifies the lead skill and
 *                     returns the suggested invocation; the actual loop
 *                     wires into wi-* skills in a follow-on slice. The
 *                     contract shape is stable; only the execute body
 *                     fills out.
 *   6. quality_gate — task-class-specific gates (typecheck, smoke,
 *                     unit-test, lint, etc per the FRAMEWORK-CONTRACT
 *                     matrix). v1 records the gate as 'skipped' when
 *                     execute didn't run; otherwise records pass/fail.
 *   7. confirm      — confirm-before-destructive. Calls path-classifier;
 *                     if any planned write hits CONFIRM_REQUIRED or
 *                     verdict='confirm', return status='asked_user' with
 *                     a confirmation question. BLOCKED paths halt with
 *                     status='halted'.
 *   8. surface      — emit a structured progress report (visible-stages
 *                     contract — locked Track B). v1 includes the
 *                     per-stage trace so callers see exactly what Cypher
 *                     did.
 *   9. record       — write the outcome to cypher_sessions, update the
 *                     skill_priors Beta posterior via learn.ts, route
 *                     observations through memory.ts.
 *
 * Hard rules carried into the runtime:
 *   - Best-effort everywhere — a stage failure is recorded with
 *     status='failed' but does not throw out of run() unless the
 *     session itself is unrecoverable.
 *   - All writes go through the cypher service helpers (path-classifier,
 *     learn, memory). No direct table access.
 *   - Token cost is tracked per step but not yet enforced — the budget
 *     gate fires in a follow-on slice once we have real token signals.
 */

import type Database from 'better-sqlite3';
import type { PalaceClient } from '../../intelligence/palace-client.js';
import { decide as classifyDecide, type ActionVerdict } from './path-classifier.js';
import { getRankedSkills, type Outcome } from './learn.js';
import { recordVerifiedSkillOutcome, draftAcceptanceText } from './session-close.js';
import { persist as persistObservation, type CypherObservation } from './memory.js';
import { resolveCandidates } from './candidates.js';
import { categoryOf, invokeSkill, type SkillCategory, type InvocationResult } from './skills.js';
import { scoreComplexity, type ComplexityResult } from './complexity.js';
import { suggestAutoLinks, type AutoLinkSuggestion } from './auto-link.js';
import { autoLinkOnDispatch, autoCloseOnOutcome } from './pm-auto.js';
import { classifyClarity, fetchCatalogEntries } from './clarify.js';
import { buildSavedContext, type SavedContext } from './investigate.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CypherStage =
  | 'investigate' | 'ask' | 'research' | 'plan' | 'execute'
  | 'quality_gate' | 'confirm' | 'surface' | 'record';

export type SessionStatus = 'pending' | 'done' | 'halted' | 'asked_user';

export interface CypherInput {
  goal: string;
  context?: string;
  user?: string;
  /** When the caller sees a confirmation/question and re-invokes with answers. */
  answers?: Record<string, string>;
  /** Set true to opt into customer-repo writes that would otherwise pause. */
  allow_destructive?: boolean;
  /**
   * Write-time dispatch provenance (v104, ADR-050 Phase 0). Callers set this
   * so downstream measurement queries can separate real user dispatches from
   * smoke/test/agent traffic without pattern-matching goal text.
   *   'user'    — real human dispatch (default)
   *   'smoke'   — smoke test suite
   *   'test'    — automated test harness
   *   'agent'   — agent-invoked-agent (BoardWorkerAgent, cron, delegation)
   *   'unknown' — pre-v104 legacy rows (should never be set by new callers)
   */
  dispatch_source?: 'user' | 'smoke' | 'test' | 'agent' | 'unknown';
  /** Candidate skill names; planner ranks them by Beta prior. */
  candidate_skills?: string[];
  /** Outcome verdict from the caller when wrapping up an executed session. */
  outcome?: Outcome;
  /** Existing session to continue (when answering an ask or recording outcome). */
  session_id?: string;
  /** Best-effort task-class label for prior bookkeeping. Defaults to '*'. */
  task_class?: string;
  /**
   * Slice 3: when true AND chosen_skill is read-class, the execute stage
   * invokes the skill via the bridge and returns its result inline.
   * Default false (backward-compatible — pre-slice-3 callers see the same
   * stub behavior). Write-class skills NEVER auto-execute regardless of
   * this flag — they always return requires_confirmation. Unknown-class
   * skills are skipped. Mirrors BUG_AUTO_MERGE=0 invariant from ADR-030.
   */
  auto_execute?: boolean;
  /**
   * PM-3-PRIME-A: when true, force the planner regardless of complexity
   * score. Used by /wi-plan-sprint to engage PM mode on small-feeling
   * goals. Default: scorer decides.
   */
  force_planner?: boolean;
  /**
   * PM-3-PRIME-A: hint files the planner uses to compute blast radius
   * via pm.impactedBy. Optional — Cypher works without it but scores
   * are sharper with it.
   */
  hint_files?: string[];
  /**
   * Slice 82a-2: skill the caller actually invoked, when known. Distinct
   * from chosen_skill (what Cypher recommended). When supplied at
   * outcome time, the Beta prior credits this skill instead of
   * chosen_skill. Backwards-compatible — null preserves today's
   * behavior.
   */
  skill_actually_invoked?: string;
}

export interface StageRecord {
  stage: CypherStage;
  status: 'entered' | 'completed' | 'skipped' | 'failed';
  payload?: Record<string, unknown>;
  duration_ms: number;
}

export interface CypherResult {
  session_id: string;
  status: SessionStatus;
  outcome?: Outcome;
  goal: string;
  task_class: string;
  chosen_skill?: string;
  ranked_skills: Array<{ skill: string; mean: number; runs: number }>;
  /** When status='asked_user': the questions Cypher needs answered. */
  questions?: Array<{ id: string; question: string; default: string }>;
  /** When status='asked_user' from confirm stage: the path + action awaiting OK. */
  pending_confirmation?: { path: string; action: 'write' | 'commit' | 'push'; verdict: ActionVerdict; reason: string };
  /** Step-by-step audit; mirrors the cypher_steps rows. */
  trace: StageRecord[];
  /** Surface-stage human-readable summary. */
  summary: string;
  /** Memory routing decisions made during the session (for transparency). */
  memory_actions: Array<{ kind: string; tier: string; reason: string; wrote: boolean }>;
  /**
   * Slice 3: result of programmatic skill invocation when auto_execute=true
   * AND chosen_skill is read-class. Carries the bridge response so callers
   * can render the skill's output inline. Absent when execute was skipped.
   */
  execution?: {
    skill: string;
    category: SkillCategory;
    /** When category='write': the skill was NOT executed; user must confirm separately. */
    requires_confirmation?: boolean;
    /** When category='read' and invocation ran: the bridge response. */
    result?: InvocationResult;
    /** Human-readable note on why execute behaved this way. */
    note: string;
  };
  /**
   * PM-3-PRIME-A: complexity verdict + reasoning. Always present from
   * this slice forward. Drives whether Cypher engaged the PM role
   * (heavy verdict halts with a sprint card before execute runs).
   */
  complexity?: {
    verdict: 'light' | 'heavy' | 'borderline';
    score: number;
    threshold: number;
    reasoning: string;
    top_signals: Array<{ name: string; weight: number; rationale: string }>;
  };
  /**
   * PM-4: auto-link suggestions extracted from goal + context text.
   * Surfaced for every dispatch (light, heavy, halted, completed alike)
   * so the user can see "this session looks related to PERSONA-AC-7,
   * PM-2" before confirming. Wired into evidence via /api/cypher/pm/link
   * by the user (manually or via /wi-record-outcome --ac).
   *
   * `existing_ids` are the subset that resolve to a real work_items row;
   * those are the safe candidates for auto-linking. `suggestions` is the
   * full list including non-existent matches so the caller can decide
   * whether to seed a new work_item.
   */
  auto_link_suggestions?: {
    existing_ids: string[];
    suggestions: AutoLinkSuggestion[];
  };
}

export interface RunOptions {
  db: Database.Database;
  palace?: PalaceClient | null;
}

// ---------------------------------------------------------------------------
// Stable session id — collision-free without needing Date.now() in tests
// ---------------------------------------------------------------------------

function newSessionId(seed: string): string {
  // 12-char hex from seed + a counter — collision-free for the tens-of-
  // thousands of sessions per run that any sane caller will hit.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const counterRow = ((globalThis as { __cypherCounter?: { n: number } }).__cypherCounter ??= { n: 0 });
  counterRow.n++;
  const tail = counterRow.n.toString(16).padStart(4, '0');
  return `cyp_${(h >>> 0).toString(16).padStart(8, '0')}${tail}`;
}

// ---------------------------------------------------------------------------
// Step-recording helper
// ---------------------------------------------------------------------------

function recordStep(
  db: Database.Database,
  session_id: string,
  stage: CypherStage,
  stageIndex: number,
  status: StageRecord['status'],
  payload?: Record<string, unknown>,
  tokens: number = 0,
  durationMs: number = 0,
): StageRecord {
  db.prepare(`
    INSERT INTO cypher_steps (session_id, stage, stage_index, status, payload, tokens_used, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    session_id, stage, stageIndex, status,
    payload ? JSON.stringify(payload) : null,
    tokens, durationMs,
  );
  return { stage, status, payload, duration_ms: durationMs };
}

// ---------------------------------------------------------------------------
// The 9-step contract
// ---------------------------------------------------------------------------

export async function runCypher(input: CypherInput, opts: RunOptions): Promise<CypherResult> {
  const { db, palace } = opts;
  const user = input.user ?? 'maaz';
  const taskClass = input.task_class ?? '*';
  const session_id = input.session_id ?? newSessionId(`${user}|${input.goal}`);
  const trace: StageRecord[] = [];
  const memoryActions: CypherResult['memory_actions'] = [];

  // Open the session row (idempotent on session_id).
  // v104 dispatch_source: read from input; caller sets it based on how the
  // dispatch was initiated. Default 'user' — most callers of runCypher (the
  // legacy 9-stage engine) come from the HTTP dispatch endpoint which is
  // user-facing. Smoke callers of runCypher directly should pass 'smoke'.
  db.prepare(`
    INSERT OR IGNORE INTO cypher_sessions
      (session_id, goal, context, task_class, user, status, allow_destructive, dispatch_source)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    session_id,
    input.goal,
    input.context ?? null,
    taskClass,
    user,
    input.allow_destructive ? 1 : 0,
    input.dispatch_source ?? 'user',
  );

  // ── ADR-040 commit 1: additive /board card creation ────────────────────
  // Gated on OUTCOME_HONEST_KANBAN_ENABLED so pre-ADR-040 callers see no
  // change. Idempotent on task_id derived from session_id, so session
  // re-entry (same user + same goal) writes at most one card. Best-effort
  // — a card-creation failure logs to stderr but never breaks the
  // dispatch. See ADR-040 §2.4 / commit-1-plan §2 Step 4.
  // Board hygiene (2026-07-15): smoke/test dispatches must NOT seed a card
  // (they polluted /board). Mirrors the loop-path gate in web-server.js.
  const _tc = (input as { task_class?: string }).task_class ?? 'generic';
  const _isSmokeDispatch =
    _tc === 'smoke' || _tc === 'test' || /^smoke\s*§/i.test(input.goal ?? '');
  if (process.env.OUTCOME_HONEST_KANBAN_ENABLED === '1' && !_isSmokeDispatch) {
    try {
      const nowMs = Date.now();
      const taskId = `task_${session_id.replace(/^cyp_/, '')}`;
      const title =
        input.goal.length > 80 ? `${input.goal.slice(0, 77)}...` : input.goal;
      db.prepare(
        `INSERT OR IGNORE INTO tasks(
           id, title, posture, project, owner_user_id,
           goal_text, kanban_column, kanban_order, entered_column_at,
           created_at, last_touched
         ) VALUES (?, ?, 'generic', 'wi', ?, ?, 'ready', 0, ?, ?, ?)`,
      ).run(taskId, title, user, input.goal, nowMs, nowMs, nowMs);
      // Link the cypher_sessions row to the /board card. task_id column
      // was added by ADR-038 D2; the AND task_id IS NULL clause makes
      // session re-entry (same session_id, existing link) a no-op.
      db.prepare(
        `UPDATE cypher_sessions SET task_id = ? WHERE session_id = ? AND task_id IS NULL`,
      ).run(taskId, session_id);
    } catch (err) {
      process.stderr.write(
        `[wi/dispatch] board-card creation failed for ${session_id}: ${(err as Error).message}\n`,
      );
    }
  }

  // ── Stage 1: investigate ───────────────────────────────────────────────
  // ADR-036 PHASE-86-02-A (2026-06-16) + PHASE-86-02-B (2026-06-19) +
  // PHASE-86-02-C (2026-06-20). Real saved-context probe replaces the
  // v1 stub. Today:
  //   - cypher_sessions last-N=5 (pure SQL, no I/O beyond the open
  //     connection)
  //   - MemPalace search (best-effort, ~1500ms timeout, falls through
  //     silently per AC-86.2.2)
  //   - Brain context (sprint, stuck Jiras, calendar agenda,
  //     open investigations, stale warnings — best-effort, ~1500ms
  //     timeout per AC-86.2.3 / AC-86.2.4)
  // All three probes share the SavedContext shape; sources flags
  // record which contributed.
  //
  // PM-4: auto-link suggestions piggy-back on investigate. Goal-text
  // regex extraction → DB filter against work_items. Cheap (no LLM,
  // no I/O beyond a few SELECTs) so it runs on every dispatch.
  const autoLinks = suggestAutoLinks(db, input.goal, input.context);
  const existingLinkIds = autoLinks.filter(s => s.exists).map(s => s.id);
  const autoLinkBundle = { existing_ids: existingLinkIds, suggestions: autoLinks };
  // PM-AUTO (slice 81a): persist the high-confidence subset. PM-4 only
  // surfaces; PM-AUTO writes. Records to pm_auto_actions audit table.
  const pmAutoLinkResult = autoLinkOnDispatch(db, session_id, autoLinks);
  // PHASE-86-02-A + B + C: probe cypher_sessions (last N=5), MemPalace,
  // and brain context. Best-effort — buildSavedContext returns empty
  // findings + per-source error strings if any probe fails. Never throws.
  const savedContext: SavedContext = await buildSavedContext(db, user, input.goal, palace);
  trace.push(recordStep(db, session_id, 'investigate', 1, 'completed', {
    auto_link: {
      existing_ids: existingLinkIds,
      suggestion_count: autoLinks.length,
      // Surface the first few non-existent matches as well so the trace
      // shows what was extracted but rejected. Useful when a user thinks
      // "I mentioned PERSONA-AC-99" and wonders why it didn't link.
      rejected_count: autoLinks.length - existingLinkIds.length,
      pm_auto_persisted: pmAutoLinkResult.linked,
      pm_auto_transitioned: pmAutoLinkResult.transitioned,
    },
    saved_context: {
      // Render a scannable digest in the trace; the full SavedContext
      // is held in the `savedContext` variable for downstream stages.
      // Keep payload <500 bytes per ADR-036 §D2.B contract.
      sessions_count: savedContext.recent_sessions.length,
      sessions_with_token_match: savedContext.recent_sessions.filter(s => s.goal_token_match).length,
      palace_count: savedContext.palace_findings.length,
      brain_count: savedContext.brain_findings.length,
      sources: savedContext.sources,
      errors: savedContext.errors,
    },
  }));

  // ── Stage 2: ask ────────────────────────────────────────────────────────
  // Phase 82c: real LLM-driven clarification. Resolve the candidate
  // catalog now (pre-rank) so the classifier sees Cypher's full toolbox
  // before deciding whether the goal is specific enough to dispatch.
  // The runtime path for "user replied with answers" reuses the goal
  // text — this still flows through clarify on the second call, and
  // the model marks it `clear: true` once the ambiguity is gone.
  //
  // Hard fallbacks below the LLM call:
  //   - empty/short goal → fixed clarify-goal question (no LLM cost).
  //   - LLM error / no client / no candidates → treat as clear and
  //     proceed (caller can always retry with sharper text).
  if (!input.goal || input.goal.trim().length < 4) {
    const questions = [
      { id: 'q-clarify-goal', question: 'What goal should Cypher run? (one short sentence)', default: 'investigate the open dispatch' },
    ];
    trace.push(recordStep(db, session_id, 'ask', 2, 'completed', { questions, reason: 'empty_goal' }));
    db.prepare(`UPDATE cypher_sessions SET status='asked_user' WHERE session_id=?`).run(session_id);
    return {
      session_id, status: 'asked_user', goal: input.goal, task_class: taskClass,
      ranked_skills: [], trace, questions, summary: 'Cypher needs a clearer goal.',
      memory_actions: memoryActions,
      auto_link_suggestions: autoLinkBundle,
    };
  }

  // Skip the LLM clarify when:
  //   - caller passed answers (re-dispatch round; asking again deadlocks)
  //   - caller passed an explicit candidate_skills list (caller has
  //     already disambiguated; trust them)
  //   - caller passed an outcome (this is a session close, not a fresh
  //     dispatch; clarify would burn a token call and shape no decision)
  //   - task_class is something other than 'dispatch' / '*' — narrow
  //     classes (pr-review, investigate, planning, smoke, …) mean the
  //     caller already knows what kind of work this is. Only the /wi
  //     free-text front door uses 'dispatch' and needs disambiguation.
  // Otherwise the goal text drives the LLM-based clarity classifier.
  const hasAnswers = !!input.answers && Object.keys(input.answers).length > 0;
  const hasExplicitCandidates = !!input.candidate_skills && input.candidate_skills.length > 0;
  const isOutcomeCall = !!input.outcome;
  const isFrontDoor = taskClass === 'dispatch' || taskClass === '*';
  const skipClarify = hasAnswers || hasExplicitCandidates || isOutcomeCall || !isFrontDoor;
  if (!skipClarify) {
    const candidatesForClarify = resolveCandidates(taskClass, input.candidate_skills, db);
    const catalogEntries = fetchCatalogEntries(db, candidatesForClarify);
    const t0 = Date.now();
    const clarity = await classifyClarity({
      goal: input.goal,
      catalog: catalogEntries,
      db,
    });
    if (!clarity.clear) {
      trace.push(recordStep(db, session_id, 'ask', 2, 'completed', {
        questions: clarity.questions,
        reason: clarity.reason ?? 'llm_flagged_unclear',
        candidates_considered: candidatesForClarify.length,
      }, 0, Date.now() - t0));
      db.prepare(`UPDATE cypher_sessions SET status='asked_user' WHERE session_id=?`).run(session_id);
      return {
        session_id, status: 'asked_user', goal: input.goal, task_class: taskClass,
        ranked_skills: [], trace, questions: clarity.questions,
        summary: clarity.reason ?? 'Cypher needs more detail to pick the right skill.',
        memory_actions: memoryActions,
        auto_link_suggestions: autoLinkBundle,
      };
    }
    trace.push(recordStep(db, session_id, 'ask', 2, 'completed', {
      reason: clarity.reason ?? 'llm_flagged_clear',
      candidates_considered: candidatesForClarify.length,
    }, 0, Date.now() - t0));
  } else {
    trace.push(recordStep(db, session_id, 'ask', 2, 'skipped', {
      reason: hasAnswers
        ? 'caller supplied answers; skipping clarify to avoid deadlock'
        : isOutcomeCall
          ? 'outcome call (session close/teach); clarify not needed'
          : !isFrontDoor
            ? `task_class='${taskClass}' is a narrow dispatch; clarify only runs for /wi front door`
            : 'caller supplied explicit candidate_skills; trusting caller',
    }));
  }

  // ── Stage 3: research ──────────────────────────────────────────────────
  // PM-3-PRIME-A: complexity scoring runs here. The scorer reads the
  // PM lens (work_items + impact maps) so its judgment is grounded in
  // standing project state — not just goal text. Verdict drives the
  // next stages: 'heavy' halts at the end of plan with a sprint card;
  // 'light' continues to execute as today; 'borderline' asks one
  // clarifying question. force_planner=true overrides to 'heavy'.
  const complexity: ComplexityResult = scoreComplexity(db, {
    goal: input.goal,
    hint_files: input.hint_files,
    task_class: taskClass,
    override: input.force_planner ? 'force_heavy' : undefined,
  });
  trace.push(recordStep(db, session_id, 'research', 3, 'completed', {
    note: 'PM-3-PRIME-A: complexity scoring',
    verdict: complexity.verdict,
    score: complexity.score,
    threshold: complexity.threshold,
    top_signals: complexity.signals.slice(0, 3).map(s => ({ name: s.name, weight: s.weight })),
  }));

  // PM-3-PRIME-A: borderline → ask one clarifying question and halt,
  // unless the caller already passed an answer in `answers`.
  if (complexity.verdict === 'borderline' && complexity.clarifying_question) {
    const answer = input.answers?.['shape'] ?? input.answers?.['light_or_heavy'];
    if (!answer) {
      const q = [{
        id: 'shape',
        question: complexity.clarifying_question,
        default: complexity.score >= complexity.threshold ? 'heavy' : 'light',
      }];
      trace.push(recordStep(db, session_id, 'ask', 2, 'completed', { questions: q, source: 'complexity_borderline' }));
      db.prepare(`UPDATE cypher_sessions SET status='asked_user' WHERE session_id=?`).run(session_id);
      return {
        session_id, status: 'asked_user', goal: input.goal, task_class: taskClass,
        ranked_skills: [], trace, questions: q,
        summary: complexity.reasoning,
        memory_actions: memoryActions,
        auto_link_suggestions: autoLinkBundle,
        complexity: {
          verdict: complexity.verdict, score: complexity.score, threshold: complexity.threshold,
          reasoning: complexity.reasoning,
          top_signals: complexity.signals.slice(0, 4),
        },
      };
    }
    // Caller answered — coerce verdict.
    if (answer === 'heavy' || answer === 'light') {
      complexity.verdict = answer;
    }
  }

  // ── Stage 4: plan ──────────────────────────────────────────────────────
  // CAP-12 learning read: rank candidate skills by Beta prior. Slice 2:
  // when the caller passes no candidate list (or an empty one), substitute
  // the task-class-aware defaults from candidates.ts so dispatch ranking
  // operates on the right candidate set instead of the catch-all 8.
  const resolvedCandidates = resolveCandidates(taskClass, input.candidate_skills, db);
  const ranked = getRankedSkills(db, taskClass, resolvedCandidates);
  const chosenSkill = ranked[0]?.skill_name;
  trace.push(recordStep(db, session_id, 'plan', 4, 'completed', {
    chosen_skill: chosenSkill ?? null,
    ranked: ranked.slice(0, 5).map(r => ({ skill: r.skill_name, mean: r.mean, runs: r.total_runs })),
  }));
  if (chosenSkill) {
    db.prepare(`UPDATE cypher_sessions SET chosen_skill=? WHERE session_id=?`).run(chosenSkill, session_id);
  }

  // PM-3-PRIME-A: heavy-verdict halt. When complexity says this needs
  // proper planning AND the caller hasn't already approved a sprint,
  // halt with a sprint card. The card surfaces the proposed shape:
  // top-ranked skill + reasoning + score + standing PM context. Approval
  // (answers.sprint_approved='yes') resumes; rejection routes to manual
  // continuation. The full LLM-backed planner is PM-3-PRIME-B; v1 here
  // surfaces the heuristic-derived shape so the loop is closed today.
  if (complexity.verdict === 'heavy' && !input.answers?.sprint_approved) {
    const summary =
      `HEAVY task — Cypher recommends a sprint plan before execution. ` +
      `Score ${complexity.score} / threshold ${complexity.threshold}. ` +
      complexity.reasoning;
    const q = [{
      id: 'sprint_approved',
      question:
        `This task scored complexity=${complexity.score} (heavy). ` +
        `Cypher's recommendation: pause and plan ACs, waves, dependencies before executing. ` +
        `Approve sprint planning? (yes = halt for sprint card, no = proceed light-touch despite score)`,
      default: 'yes',
    }];
    trace.push(recordStep(db, session_id, 'plan', 4, 'completed', {
      verdict: 'heavy', score: complexity.score, halted_for_sprint: true,
    }));
    db.prepare(`UPDATE cypher_sessions SET status='asked_user' WHERE session_id=?`).run(session_id);
    return {
      session_id, status: 'asked_user', goal: input.goal, task_class: taskClass,
      chosen_skill: chosenSkill, ranked_skills: ranked.map(r => ({ skill: r.skill_name, mean: r.mean, runs: r.total_runs })),
      trace, questions: q, summary,
      memory_actions: memoryActions,
      auto_link_suggestions: autoLinkBundle,
      complexity: {
        verdict: complexity.verdict, score: complexity.score, threshold: complexity.threshold,
        reasoning: complexity.reasoning,
        top_signals: complexity.signals.slice(0, 4),
      },
    };
  }

  // ── Stage 5: execute ───────────────────────────────────────────────────
  // Slice 3: when auto_execute=true AND chosen_skill is read-class, invoke
  // the skill via the bridge and capture the result. Write-class always
  // returns requires_confirmation (mirrors BUG_AUTO_MERGE=0 from ADR-030).
  // Unknown-class skills (no programmatic invocation today) leave the
  // stage as 'skipped' with a hint, identical to v1 behavior.
  let execution: CypherResult['execution'] | undefined;
  if (chosenSkill) {
    const cat = categoryOf(chosenSkill);
    if (input.auto_execute && cat === 'auto') {
      const t0 = Date.now();
      const invocationResult = await invokeSkill(chosenSkill, input.goal, input.context);
      execution = {
        skill: chosenSkill,
        category: cat,
        result: invocationResult,
        note: invocationResult.ok
          ? `Cypher invoked ${chosenSkill}; bridge returned status=${invocationResult.status}`
          : `Cypher invoked ${chosenSkill}; bridge returned status=${invocationResult.status} error=${invocationResult.error ?? 'unknown'}`,
      };
      trace.push(recordStep(db, session_id, 'execute', 5, invocationResult.ok ? 'completed' : 'failed', {
        skill: chosenSkill, category: cat, status: invocationResult.status, ok: invocationResult.ok,
      }, 0, Date.now() - t0));
    } else if (cat === 'confirm') {
      execution = {
        skill: chosenSkill,
        category: cat,
        requires_confirmation: true,
        note: `${chosenSkill} is confirm-class (leaks beyond WI) — Cypher refuses to auto-execute. User must confirm before running.`,
      };
      trace.push(recordStep(db, session_id, 'execute', 5, 'skipped', {
        skill: chosenSkill, category: cat, reason: 'confirm_class_requires_confirmation',
      }));
    } else if (cat === 'cli') {
      // Claude Code skill (global / plugin) — can never run through the
      // bridge. Surface as a recommendation; the user types /<skill>
      // themselves. Keeps the depth-≤2 invariant from ADR-033 (relaxed
      // only for `auto` per ADR-036).
      execution = {
        skill: chosenSkill,
        category: cat,
        requires_confirmation: true,
        note: `${chosenSkill} is a Claude Code skill — Cypher cannot invoke it via the bridge. Run /${chosenSkill} yourself.`,
      };
      trace.push(recordStep(db, session_id, 'execute', 5, 'skipped', {
        skill: chosenSkill, category: cat, reason: 'cli_class_user_invokes',
        suggested: `/${chosenSkill}`,
      }));
    } else {
      // auto_execute=false (default) OR auto-class without buildRequest —
      // preserve v1 behavior: skip + suggest /skill-name.
      trace.push(recordStep(db, session_id, 'execute', 5, 'skipped', {
        note: 'v1 default — auto_execute not requested OR auto-class catalog has no buildRequest; chosen_skill returned for caller to invoke',
        suggested: chosenSkill ? `/${chosenSkill}` : null,
      }));
    }
  } else {
    trace.push(recordStep(db, session_id, 'execute', 5, 'skipped', {
      note: 'no chosen_skill from plan stage; nothing to execute',
    }));
  }

  // ── Stage 6: quality_gate ──────────────────────────────────────────────
  trace.push(recordStep(db, session_id, 'quality_gate', 6, 'skipped', {
    reason: 'execute did not run; nothing to gate',
  }));

  // ── Stage 7: confirm ───────────────────────────────────────────────────
  // If the input names a planned write path, classify it. v1 looks for
  // a `pending_write` field on context (JSON); v2 wires this into the
  // execute loop's planned writes.
  let pendingConfirmation: CypherResult['pending_confirmation'] | undefined;
  try {
    const ctx = input.context ? JSON.parse(input.context) as { pending_write?: { path: string; action: 'write'|'commit'|'push' } } : {};
    if (ctx.pending_write) {
      const { verdict, classification } = classifyDecide(ctx.pending_write.path, ctx.pending_write.action);
      if (verdict === 'refuse') {
        trace.push(recordStep(db, session_id, 'confirm', 7, 'failed', {
          path: classification.resolvedPath, action: ctx.pending_write.action,
          verdict, reason: classification.reason,
        }));
        db.prepare(`UPDATE cypher_sessions SET status='halted', outcome='failed', completed_at=datetime('now') WHERE session_id=?`).run(session_id);
        return {
          session_id, status: 'halted', outcome: 'failed', goal: input.goal, task_class: taskClass,
          chosen_skill: chosenSkill, ranked_skills: ranked.map(r => ({ skill: r.skill_name, mean: r.mean, runs: r.total_runs })),
          trace, summary: `Cypher refuses ${ctx.pending_write.action} at ${classification.resolvedPath}: ${classification.reason}`,
          memory_actions: memoryActions,
          auto_link_suggestions: autoLinkBundle,
        };
      }
      if (verdict === 'confirm' && !input.allow_destructive) {
        pendingConfirmation = {
          path: classification.resolvedPath, action: ctx.pending_write.action,
          verdict, reason: classification.reason,
        };
        trace.push(recordStep(db, session_id, 'confirm', 7, 'completed', { ...pendingConfirmation }));
        db.prepare(`UPDATE cypher_sessions SET status='asked_user' WHERE session_id=?`).run(session_id);
        return {
          session_id, status: 'asked_user', goal: input.goal, task_class: taskClass,
          chosen_skill: chosenSkill, ranked_skills: ranked.map(r => ({ skill: r.skill_name, mean: r.mean, runs: r.total_runs })),
          trace, pending_confirmation: pendingConfirmation,
          summary: `Cypher needs confirmation to ${ctx.pending_write.action} at ${classification.resolvedPath}.`,
          memory_actions: memoryActions,
          auto_link_suggestions: autoLinkBundle,
        };
      }
      // verdict='allow' or allow_destructive=true: just record.
      trace.push(recordStep(db, session_id, 'confirm', 7, 'completed', {
        path: classification.resolvedPath, action: ctx.pending_write.action, verdict,
      }));
    } else {
      trace.push(recordStep(db, session_id, 'confirm', 7, 'skipped', { reason: 'no pending_write in context' }));
    }
  } catch (err) {
    trace.push(recordStep(db, session_id, 'confirm', 7, 'failed', {
      error: `context JSON parse failed: ${(err as Error).message}`,
    }));
  }

  // ── Stage 8: surface ───────────────────────────────────────────────────
  const summary = chosenSkill
    ? `Cypher ranked ${ranked.length} candidate skill(s); top: ${chosenSkill} (μ=${(ranked[0]?.mean ?? 0).toFixed(2)}, runs=${ranked[0]?.total_runs ?? 0}).`
    : 'Cypher found no candidate skills for this goal.';
  trace.push(recordStep(db, session_id, 'surface', 8, 'completed', { summary }));

  // ── Stage 9: record ─────────────────────────────────────────────────────
  // If the caller passed an outcome verdict, update the Beta prior and
  // close the session. Otherwise leave the session 'pending' — the
  // caller will record the outcome when execute completes.
  if (input.outcome && chosenSkill) {
    // Slice 82a-2: credit the actually-invoked skill when supplied,
    // else fall back to chosenSkill (today's behavior). Both are
    // persisted so the panel can render "recommended X, ran Y".
    const creditTarget = input.skill_actually_invoked ?? chosenSkill;

    // G4 verified_via plumbing — extracted to session-close.ts (2026-07-13)
    // so Phase 7's run.ts deletion doesn't kill the mechanism. See that
    // module's docblock for the rationale. Loop path deliberately does
    // NOT call this (option (a) — loop has no chosen_skill semantics
    // per .planning/phase-7-outcome-recording-migration.md).
    recordVerifiedSkillOutcome(db, session_id, creditTarget, input.outcome, taskClass);

    if (input.skill_actually_invoked) {
      db.prepare(`UPDATE cypher_sessions SET skill_actually_invoked=? WHERE session_id=?`)
        .run(input.skill_actually_invoked, session_id);
    }
    db.prepare(`UPDATE cypher_sessions SET status='done', outcome=?, completed_at=datetime('now') WHERE session_id=?`).run(input.outcome, session_id);

    // AC-S5 acceptance_text draft — extracted to session-close.ts so both
    // engines can call it. Fires only on outcome='success' + review-column
    // task + no existing acceptance_text. Best-effort — swallows errors.
    if (input.outcome === 'success') {
      await draftAcceptanceText(db, session_id, input.goal);
    }
    // PM-AUTO (slice 81a): on outcome=success, scan current-branch
    // commits since session start, link them to every work_item this
    // session is linked to, and ship anything in_progress. Skipped on
    // mixed/failed and on main/master.
    const startedRow = db.prepare<[string], { started_at: string }>(
      `SELECT started_at FROM cypher_sessions WHERE session_id=?`
    ).get(session_id);
    let pmAutoCloseResult: ReturnType<typeof autoCloseOnOutcome> | null = null;
    if (startedRow) {
      pmAutoCloseResult = autoCloseOnOutcome(db, {
        session_id,
        outcome: input.outcome,
        started_at: startedRow.started_at,
      });
    }
    trace.push(recordStep(db, session_id, 'record', 9, 'completed', {
      outcome: input.outcome, prior_updated_for: creditTarget, chosen_skill: chosenSkill, skill_actually_invoked: input.skill_actually_invoked ?? null, task_class: taskClass,
      pm_auto_close: pmAutoCloseResult,
    }));
    // Memory: route the session-end observation.
    const obs: CypherObservation = {
      kind: 'session_end',
      title: `Cypher session ${session_id} — ${input.outcome}`,
      body: `Goal: ${input.goal}\nChosen: ${chosenSkill}\nOutcome: ${input.outcome}`,
      outcome: input.outcome,
      session_id,
    };
    const persistResult = await persistObservation(obs, { palace, enabled: true });
    memoryActions.push({
      kind: obs.kind, tier: persistResult.destination.tier,
      reason: persistResult.destination.reason, wrote: persistResult.wrote,
    });
  } else {
    trace.push(recordStep(db, session_id, 'record', 9, 'completed', {
      outcome: null, note: 'session left pending; caller records outcome on execute completion',
    }));
  }

  // PM-3-PRIME-A: light-verdict task note. When verdict is 'light' AND
  // outcome was supplied (caller is closing the session), persist a
  // lightweight task note so decisions/findings/ACs from the slice
  // don't get lost. The note lives outside .planning/phases/ — those
  // are GSD-shaped sprint artifacts. Light tasks get a flat per-session
  // file. Best-effort; a write failure is logged not thrown.
  if (complexity.verdict === 'light' && input.outcome) {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const noteDir = path.resolve(process.cwd(), '.planning/notes');
      await fs.mkdir(noteDir, { recursive: true });
      const notePath = path.join(noteDir, `${session_id}.md`);
      const sigLines = complexity.signals
        .filter(s => s.weight !== 0)
        .map(s => `- ${s.name} (weight ${s.weight}): ${s.rationale}`)
        .join('\n');
      const note = `# Cypher light-task note — ${session_id}

**Goal:** ${input.goal}
**Task class:** ${taskClass}
**Outcome:** ${input.outcome}
**Chosen skill:** ${chosenSkill ?? '(none)'}
**Complexity:** ${complexity.verdict} (score ${complexity.score} / threshold ${complexity.threshold})

## Why light

${complexity.reasoning}

### Signals

${sigLines || '(no significant signals)'}

## Decisions / findings during execution

_Caller can append decisions, findings, or ACs satisfied here after
the slice ships. Cypher writes the skeleton; the human (or a future
auto-instrumented wi-record-outcome) fills it in._
`;
      await fs.writeFile(notePath, note, 'utf8');
      memoryActions.push({
        kind: 'task_note', tier: 'project-memory',
        reason: 'light verdict — note written to .planning/notes/',
        wrote: true,
      });
    } catch (err) {
      memoryActions.push({
        kind: 'task_note', tier: 'project-memory',
        reason: `light verdict — note write failed: ${(err as Error).message}`,
        wrote: false,
      });
    }
  }

  return {
    session_id,
    status: input.outcome ? 'done' : 'pending',
    outcome: input.outcome,
    goal: input.goal,
    task_class: taskClass,
    chosen_skill: chosenSkill,
    ranked_skills: ranked.map(r => ({ skill: r.skill_name, mean: r.mean, runs: r.total_runs })),
    trace,
    summary,
    memory_actions: memoryActions,
    auto_link_suggestions: autoLinkBundle,
    complexity: {
      verdict: complexity.verdict, score: complexity.score, threshold: complexity.threshold,
      reasoning: complexity.reasoning,
      top_signals: complexity.signals.slice(0, 4),
    },
    ...(execution ? { execution } : {}),
  };
}
