/**
 * Cypher health/visibility lens (slice 81b, 2026-06-14).
 *
 * Read-only helpers backing the /cypher visibility panel. Three exports:
 *
 *   - getCurrentPriors(db)
 *       Beta(α,β) snapshot per (skill, task_class) plus per-skill
 *       success rate aggregated from cypher_sessions.outcome.
 *
 *   - getRecentSessions(db, limit)
 *       Last N dispatches with goal (truncated to 200 chars),
 *       task_class, user, status, outcome, chosen_skill, and the
 *       complexity verdict pulled from the 'research' stage payload.
 *       Plus an in_flight flag (status='pending' AND started_at
 *       within last 5 min) for the live indicator.
 *
 *   - getSessionDetail(db, session_id)
 *       Single session + ordered cypher_steps array + work_item_links
 *       evidence + pm_auto_actions written for the session. The
 *       drill-down view in the panel.
 *
 * Hard rule 7: this module reads cypher_sessions, cypher_steps,
 * skill_priors, work_item_links, and pm_auto_actions. All those
 * tables sit inside the cypher domain; the read stays in the lens.
 *
 * No HTTP, no LLM. Pure SQL aggregations. Performance:
 *   - getCurrentPriors  — two SELECTs (priors + outcomes), O(rows in
 *                          skill_priors + cypher_sessions)
 *   - getRecentSessions — one SELECT with subqueries for step_count
 *                          and verdict per row. Acceptable at limit≤100.
 *                          If we ever need limit≥1000, batch the
 *                          subqueries; today it's fine.
 *   - getSessionDetail  — four SELECTs: session, steps, links,
 *                          auto_actions. All by indexed key.
 */

import type Database from 'better-sqlite3';

// ─── Section A: Learning ──────────────────────────────────────────────────────

export interface PriorPoint {
  skill_name: string;
  task_class: string;
  alpha: number;
  beta: number;
  /** alpha / (alpha + beta) — stored separately so callers don't recompute. */
  mean: number;
  total_runs: number;
  updated_at: string;
}

export interface PerSkillRate {
  chosen_skill: string;
  successes: number;
  attempts: number;
  /** Computed: successes / attempts when attempts > 0, else null. */
  rate: number | null;
}

export interface PriorsSnapshot {
  current: PriorPoint[];
  success_rate: PerSkillRate[];
  generated_at: string;
}

interface PriorRow {
  skill_name: string;
  task_class: string;
  alpha: number;
  beta: number;
  total_runs: number;
  updated_at: string;
}

interface RateRow {
  chosen_skill: string;
  successes: number;
  attempts: number;
}

export function getCurrentPriors(db: Database.Database): PriorsSnapshot {
  const priors = db.prepare<[], PriorRow>(`
    SELECT skill_name, task_class, alpha, beta, total_runs, updated_at
      FROM skill_priors
     ORDER BY skill_name, task_class
  `).all();

  const rates = db.prepare<[], RateRow>(`
    SELECT chosen_skill,
           SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) AS successes,
           SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) AS attempts
      FROM cypher_sessions
     WHERE chosen_skill IS NOT NULL
     GROUP BY chosen_skill
     ORDER BY chosen_skill
  `).all();

  return {
    current: priors.map(p => {
      const denom = p.alpha + p.beta;
      return {
        ...p,
        mean: denom > 0 ? p.alpha / denom : 0,
      };
    }),
    success_rate: rates.map(r => ({
      ...r,
      rate: r.attempts > 0 ? r.successes / r.attempts : null,
    })),
    generated_at: new Date().toISOString(),
  };
}

// ─── Section B: Activity ──────────────────────────────────────────────────────

export interface SessionSummary {
  session_id: string;
  /** First 200 chars of goal text. */
  goal: string;
  task_class: string | null;
  user: string;
  status: 'pending' | 'done' | 'halted' | 'asked_user';
  /**
   * Full outcome enum matches the cypher_sessions CHECK constraint post-v100:
   *   success | mixed | failed | halted | abandoned | rejected_non_interactive | captured_to_board
   * Before 2026-07-25 the reducer collapsed halted/abandoned/rejected into
   * 'mixed', so consumers only saw the narrow set. Now the honest verdict
   * propagates — UI must handle every enum value.
   */
  outcome:
    | 'success' | 'mixed' | 'failed' | 'halted'
    | 'abandoned' | 'rejected_non_interactive' | 'captured_to_board'
    | null;
  /**
   * Model-emitted human-readable rationale from cypher_record_outcome
   * (loop.ts:2708). Persisted alongside outcome in the same row; null when
   * the model didn't call the tool. Truncated at 4KB by the loop before
   * write. Surface this in the session-detail UI so users can read WHY
   * the model set the verdict it did.
   */
  outcome_note: string | null;
  chosen_skill: string | null;
  /**
   * Slice 82a-2: skill the user reported actually invoking when closing
   * the session. Distinct from chosen_skill (Cypher's recommendation).
   * Null when the session predates the field or the caller didn't supply.
   */
  skill_actually_invoked: string | null;
  /** Pulled from latest 'research' stage payload — null when stage didn't run. */
  complexity_verdict: 'light' | 'heavy' | 'borderline' | null;
  started_at: string;
  completed_at: string | null;
  step_count: number;
  /** True when status='pending' AND started_at within last 5 minutes. */
  in_flight: boolean;
  /** True when status='pending' AND started_at older than the stale threshold (default 2h). */
  stale: boolean;
}

interface SessionRow {
  session_id: string;
  goal: string;
  task_class: string | null;
  user: string;
  status: SessionSummary['status'];
  outcome: SessionSummary['outcome'];
  outcome_note: string | null;
  chosen_skill: string | null;
  skill_actually_invoked: string | null;
  started_at: string;
  completed_at: string | null;
}

interface StepCountRow { n: number }
interface VerdictRow { payload: string | null }

const GOAL_TRUNCATE_CHARS = 200;
const IN_FLIGHT_WINDOW_MIN = 5;
const DEFAULT_STALE_HOURS = 2;

function truncateGoal(g: string): string {
  if (g.length <= GOAL_TRUNCATE_CHARS) return g;
  return g.slice(0, GOAL_TRUNCATE_CHARS - 1) + '…';
}

function startedAtMs(started_at: string): number {
  // started_at is a SQLite 'YYYY-MM-DD HH:MM:SS' UTC string.
  return Date.parse(started_at.replace(' ', 'T') + 'Z');
}

function isInFlight(status: string, started_at: string): boolean {
  if (status !== 'pending') return false;
  const startMs = startedAtMs(started_at);
  if (Number.isNaN(startMs)) return false;
  const ageMin = (Date.now() - startMs) / 60_000;
  return ageMin >= 0 && ageMin <= IN_FLIGHT_WINDOW_MIN;
}

/**
 * Stale = pending session whose start time is older than the threshold
 * (default 2h). Distinct from in_flight (≤5min). Sessions that fall
 * between in_flight and stale are simply "running" — neither flagged.
 */
function isStale(status: string, started_at: string, ageHours: number = DEFAULT_STALE_HOURS): boolean {
  if (status !== 'pending') return false;
  const startMs = startedAtMs(started_at);
  if (Number.isNaN(startMs)) return false;
  const ageHrs = (Date.now() - startMs) / 3_600_000;
  return ageHrs >= ageHours;
}

function extractVerdict(payload: string | null): SessionSummary['complexity_verdict'] {
  if (!payload) return null;
  try {
    const obj = JSON.parse(payload) as { verdict?: string };
    if (obj.verdict === 'light' || obj.verdict === 'heavy' || obj.verdict === 'borderline') {
      return obj.verdict;
    }
    return null;
  } catch {
    return null;
  }
}

export function getRecentSessions(db: Database.Database, limit: number): SessionSummary[] {
  const rows = db.prepare<[number], SessionRow>(`
    SELECT session_id, goal, task_class, user, status, outcome, outcome_note,
           chosen_skill, skill_actually_invoked, started_at, completed_at
      FROM cypher_sessions
     ORDER BY started_at DESC, id DESC
     LIMIT ?
  `).all(limit);

  const stepCountStmt = db.prepare<[string], StepCountRow>(`
    SELECT COUNT(*) AS n FROM cypher_steps WHERE session_id = ?
  `);
  const verdictStmt = db.prepare<[string], VerdictRow>(`
    SELECT payload FROM cypher_steps
     WHERE session_id = ? AND stage = 'research' AND status = 'completed'
     ORDER BY stage_index DESC, id DESC LIMIT 1
  `);

  return rows.map(r => {
    const stepCount = stepCountStmt.get(r.session_id)?.n ?? 0;
    const verdictRow = verdictStmt.get(r.session_id);
    return {
      ...r,
      goal: truncateGoal(r.goal),
      step_count: stepCount,
      complexity_verdict: extractVerdict(verdictRow?.payload ?? null),
      in_flight: isInFlight(r.status, r.started_at),
      stale: isStale(r.status, r.started_at),
    };
  });
}

// ─── Stale-pending sessions (slice 82a-1) ─────────────────────────────────────

export interface StaleSessionsResponse {
  sessions: SessionSummary[];
  total: number;
  threshold_hours: number;
  generated_at: string;
}

/**
 * Sessions older than `ageHours` (default 2) and still status='pending'.
 * Sorted newest-first so the panel shows the most recently-stuck work
 * at the top — matches user mental model ("what did I just leave open").
 * Capped at 100 — the panel pages anything beyond.
 */
export function getStaleSessions(
  db: Database.Database,
  ageHours: number = DEFAULT_STALE_HOURS,
  limit: number = 100,
): StaleSessionsResponse {
  // Compute the cutoff in JS so we can use SQLite's datetime() comparison
  // without touching wall-clock inside the SQL — keeps the test seedable.
  const cutoffMs = Date.now() - ageHours * 3_600_000;
  const cutoff = new Date(cutoffMs).toISOString().replace('T', ' ').replace(/\..+$/, '');

  const rows = db.prepare<[string, number], SessionRow>(`
    SELECT session_id, goal, task_class, user, status, outcome, outcome_note,
           chosen_skill, skill_actually_invoked, started_at, completed_at
      FROM cypher_sessions
     WHERE status = 'pending' AND started_at < ?
     ORDER BY started_at DESC
     LIMIT ?
  `).all(cutoff, limit);

  const stepCountStmt = db.prepare<[string], StepCountRow>(`
    SELECT COUNT(*) AS n FROM cypher_steps WHERE session_id = ?
  `);
  const verdictStmt = db.prepare<[string], VerdictRow>(`
    SELECT payload FROM cypher_steps
     WHERE session_id = ? AND stage = 'research' AND status = 'completed'
     ORDER BY stage_index DESC, id DESC LIMIT 1
  `);

  const sessions = rows.map(r => ({
    ...r,
    goal: truncateGoal(r.goal),
    step_count: stepCountStmt.get(r.session_id)?.n ?? 0,
    complexity_verdict: extractVerdict(verdictStmt.get(r.session_id)?.payload ?? null),
    in_flight: false,
    stale: true,
  }));

  return {
    sessions,
    total: sessions.length,
    threshold_hours: ageHours,
    generated_at: new Date().toISOString(),
  };
}

// ─── Section drill-down: single session detail ────────────────────────────────

export interface StepRow {
  stage: string;
  stage_index: number;
  status: string;
  payload: unknown;
  duration_ms: number | null;
  created_at: string;
}

export interface LinkRow {
  work_item_id: string;
  evidence_kind: string;
  evidence_value: string;
  note: string | null;
  created_at: string;
}

export interface AutoActionRow {
  action: string;
  work_item_id: string;
  evidence_kind: string | null;
  evidence_value: string | null;
  reason: string;
  created_at: string;
}

export interface SessionDetail {
  session: SessionSummary;
  steps: StepRow[];
  links: LinkRow[];
  auto_actions: AutoActionRow[];
}

export function getSessionDetail(
  db: Database.Database,
  session_id: string,
): SessionDetail | null {
  const sessionRow = db.prepare<[string], SessionRow>(`
    SELECT session_id, goal, task_class, user, status, outcome, outcome_note,
           chosen_skill, skill_actually_invoked, started_at, completed_at
      FROM cypher_sessions WHERE session_id = ?
  `).get(session_id);
  if (!sessionRow) return null;

  const stepCount = db.prepare<[string], StepCountRow>(
    `SELECT COUNT(*) AS n FROM cypher_steps WHERE session_id = ?`,
  ).get(session_id)?.n ?? 0;

  const verdictRow = db.prepare<[string], VerdictRow>(`
    SELECT payload FROM cypher_steps
     WHERE session_id = ? AND stage = 'research' AND status = 'completed'
     ORDER BY stage_index DESC, id DESC LIMIT 1
  `).get(session_id);

  const session: SessionSummary = {
    ...sessionRow,
    goal: truncateGoal(sessionRow.goal),
    step_count: stepCount,
    complexity_verdict: extractVerdict(verdictRow?.payload ?? null),
    in_flight: isInFlight(sessionRow.status, sessionRow.started_at),
    stale: isStale(sessionRow.status, sessionRow.started_at),
  };

  interface RawStepRow {
    stage: string;
    stage_index: number;
    status: string;
    payload: string | null;
    duration_ms: number | null;
    created_at: string;
  }

  const steps = db.prepare<[string], RawStepRow>(`
    SELECT stage, stage_index, status, payload, duration_ms, created_at
      FROM cypher_steps WHERE session_id = ?
     ORDER BY stage_index ASC, id ASC
  `).all(session_id).map(s => ({
    ...s,
    payload: s.payload ? safeJsonParse(s.payload) : null,
  }));

  const links = db.prepare<[string], LinkRow>(`
    SELECT work_item_id, evidence_kind, evidence_value, note, created_at
      FROM work_item_links
     WHERE evidence_kind = 'cypher_session_id' AND evidence_value = ?
     ORDER BY created_at ASC
  `).all(session_id);

  const auto_actions = db.prepare<[string], AutoActionRow>(`
    SELECT action, work_item_id, evidence_kind, evidence_value, reason, created_at
      FROM pm_auto_actions WHERE session_id = ?
     ORDER BY created_at ASC, id ASC
  `).all(session_id);

  return { session, steps, links, auto_actions };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
