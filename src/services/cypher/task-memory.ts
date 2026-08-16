/**
 * Cypher v2.5 D2 — task memory + curator primitive.
 *
 * Ratified by ADR-038 § D2 and the design doc at
 * `.planning/cypher/Q-2.1-D2-task-memory.md`.
 *
 * A `task` is a persistent named unit of work that survives bridge
 * restarts and multi-week timescales. Dispatches operate against tasks.
 * Tasks have curator-distilled context that compounds across dispatches.
 *
 * Key design decisions (Q-2.1):
 *   - task_contexts is append-only (no UPDATE) — curation history is
 *     auditable and required for D19 schema evolution.
 *   - curateTaskContext() is async and fires AFTER the SSE done event —
 *     user is never blocked by the Haiku curation call.
 *   - When task_id is present, curator overwrites cypher_outcomes.failure_pattern
 *     with a more precise tag extracted from the dispatch surface text.
 *     The classifyFailure() heuristic stays as the fallback for task-free dispatches.
 *   - tasks.project defaults to 'wi' — D3 slice 2 (v77) added a FK to
 *     projects(id); createTask validates project exists upfront for a
 *     clear error message rather than the raw SQLite FK violation.
 *   - D4 worktree columns included as NULL — no backfill migration when D4 ships.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { projectExists } from './projects.js';
import { bucketCallParams } from '../model-config.js';
import { addWorktree, removeWorktree } from './worktree.js';

// ── Types ────────────────────────────────────────────────────────────────────

// ADR-053: allow FE/BE/Ops postures for PM-emitted execute cards
export type TaskPosture =
  | 'pr_review'
  | 'bug_investigate'
  | 'pm'
  | 'generic'
  | 'fe'
  | 'be'
  | 'ops';
export type TaskStatus = 'open' | 'paused' | 'blocked' | 'closed';

export interface Task {
  id: string;
  title: string;
  posture: TaskPosture;
  status: TaskStatus;
  parent_task_id: string | null;
  external_ref: string | null;
  project: string;
  owner_user_id: string;
  created_at: number;
  last_touched: number;
  closed_at: number | null;
  closed_reason: string | null;
  git_branch: string | null;
  worktree_path: string | null;
  worktree_status: string | null;
  /**
   * D19 (v2.5): epoch-ms when a recurate was last requested via
   * cypher_task_recurate / PUT /api/cypher/tasks/:id/recurate.
   * NULL = no pending recurate. The curator at next dispatch close
   * runs unconditionally when this is set, then clears it after a
   * successful write.
   */
  recurate_pending_at: number | null;
}

export interface TaskContext {
  task_id: string;
  version: number;
  context_summary: string;
  open_questions: string | null;
  things_tried: string | null;
  curator_dispatch_id: string | null;
  curator_format_version: number;
  created_at: number;
}

export interface TaskContextBlock {
  task: Task;
  context: TaskContext | null;
  dispatch_count: number;
  /**
   * D19 (v2.5): true when context.curator_format_version is below
   * MIN_SUPPORTED_CURATOR_FORMAT_VERSION. Caller should consider
   * forcing re-curation via cypher_task_recurate. False (or absent)
   * when context is current or there is no context yet.
   */
  stale_format?: boolean;
}

export interface CreateTaskOpts {
  title: string;
  posture: TaskPosture;
  external_ref?: string;
  project?: string;
  owner_user_id?: string;
  /**
   * C1 (2026-06-28): ADR-038 § D4 worktree wiring.
   * When true, createTask invokes `git worktree add` on the project's
   * bare clone (bootstrapping if needed) and populates the worktree
   * fields on the returned Task. Defaults to false so existing
   * tool-call signatures stay unchanged; new flows opt in
   * explicitly. Only supported for project='wi' today —
   * other repos throw `unsupported_project_for_worktree`.
   */
  wire_worktree?: boolean;

  // ── ADR-043 Phase 1 — PM Orchestration Layer fields ───────────────────
  /** 0-100 rank input consumed by src/services/board/ranker.ts. Default 50. */
  priority?: number;
  /** Fibonacci story points {1,2,3,5,8,13} or null (unestimated). */
  effort_points?: number | null;
  /** Intent enum from ADR-043. Default 'execute'. */
  intent?: 'brainstorm' | 'plan' | 'execute' | 'decide';
  /** Optional goal text (v90 kanban field). */
  goal_text?: string;
  /** Optional acceptance criteria text (v90 kanban field). */
  acceptance_text?: string;
  /**
   * Optional JSON array of task IDs this card depends on. When any listed
   * card is not in kanban_column='done' the ranker penalises this card.
   */
  depends_on?: string[];
}

// ── D19 schema evolution policy ───────────────────────────────────────────────

/**
 * ADR-038 v2.5 D19 — current curator output format version.
 *
 * Every row written to `task_contexts` is tagged with this number in
 * `curator_format_version`. When the curator's output shape changes
 * (e.g. new field added, semantics of an existing field shift),
 * bump this constant in the SAME commit that ships the new shape.
 *
 * Reader policy (see loadTaskContext + renderTaskContextBlock):
 *   - context.curator_format_version === CURRENT  → render normally
 *   - context.curator_format_version >= MIN_SUPPORTED  → render with
 *     a "(stale curator format)" footer; the model can still use the
 *     content but knows it predates a curator change
 *   - context.curator_format_version <  MIN_SUPPORTED → flagged as
 *     `stale: true` on the TaskContextBlock; caller (loop dispatch
 *     entry, recurate tool, HTTP endpoint) decides whether to force
 *     re-curation via the cypher_task_recurate tool
 *
 * Format change procedure:
 *   1. Bump CURRENT_CURATOR_FORMAT_VERSION here.
 *   2. If the new shape is backward-readable (extra field added but
 *      old fields unchanged), leave MIN_SUPPORTED untouched — reader
 *      gracefully tolerates the gap and just renders without the new
 *      field for old rows.
 *   3. If the new shape removes/renames a field, bump MIN_SUPPORTED to
 *      CURRENT so all older rows are flagged stale and force recurate.
 *
 * v1 (current shape): { context_summary, open_questions, things_tried }
 * (defined in CurationResult / TaskContext interfaces above).
 */
export const CURRENT_CURATOR_FORMAT_VERSION = 1;

/**
 * Minimum curator_format_version the reader will accept without
 * flagging the context as stale. Default equals CURRENT — i.e. ANY
 * older format is stale-but-readable. Bump in lockstep with CURRENT
 * when a format change is non-backward-compatible.
 */
export const MIN_SUPPORTED_CURATOR_FORMAT_VERSION = 1;



function taskId(): string {
  const rand = createHash('sha256')
    .update(String(Date.now()) + Math.random().toString(36))
    .digest('hex')
    .slice(0, 12);
  return `tsk_${rand}`;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function createTask(db: Database.Database, opts: CreateTaskOpts): Task {
  const now = Date.now();
  const id = taskId();
  const project = opts.project ?? 'wi';

  // D3 slice 2 (v77): project must exist in the `projects` table or the
  // FK constraint rejects the INSERT with a cryptic SQLite error.
  // Validate upfront so the caller (cypher_task_create handler, HTTP
  // endpoint, test) gets a clear actionable message instead.
  if (!projectExists(db, project)) {
    throw new Error(
      `createTask: project '${project}' does not exist in projects table. ` +
        `Use cypher_project_create to register it first, or pass an ` +
        `existing project slug (e.g. 'wi', or a configured repo name).`,
    );
  }

  const task: Task = {
    id,
    title: opts.title,
    posture: opts.posture,
    status: 'open',
    parent_task_id: null,
    external_ref: opts.external_ref ?? null,
    project,
    owner_user_id: opts.owner_user_id ?? 'maaz',
    created_at: now,
    last_touched: now,
    closed_at: null,
    closed_reason: null,
    git_branch: null,
    worktree_path: null,
    worktree_status: null,
    recurate_pending_at: null,
  };

  // C1 (2026-06-28): ADR-038 § D4 worktree wiring. Opt-in via
  // opts.wire_worktree. The worktree is created BEFORE the INSERT so
  // a worktree_add_failed throw aborts the whole createTask call —
  // the caller sees the worktree error and no orphan task row lands
  // in the DB. If the wiring succeeds, the columns are populated and
  // the INSERT records them.
  if (opts.wire_worktree) {
    const wt = addWorktree(project, id);
    task.worktree_path = wt.worktree_path;
    task.worktree_status = 'active';
    task.git_branch = wt.branch;
  }

  db.prepare(`
    INSERT INTO tasks (
      id, title, posture, status, parent_task_id, external_ref,
      project, owner_user_id, created_at, last_touched,
      closed_at, closed_reason, git_branch, worktree_path, worktree_status,
      recurate_pending_at
    ) VALUES (
      @id, @title, @posture, @status, @parent_task_id, @external_ref,
      @project, @owner_user_id, @created_at, @last_touched,
      @closed_at, @closed_reason, @git_branch, @worktree_path, @worktree_status,
      @recurate_pending_at
    )
  `).run(task);

  // ── ADR-043 Phase 1 — set PM fields when supplied ─────────────────────
  // Base INSERT stays identical to the pre-v99 shape so any test fixture
  // that runs only v59+v75-77+v81 continues to work. When the caller
  // supplied PM opts AND those columns exist (v90+v99 applied), UPDATE
  // them in a follow-up statement. Silent no-op when columns are missing —
  // fixture tests never opt in to these fields, so no functional loss.
  const hasPmFields =
    opts.goal_text !== undefined ||
    opts.acceptance_text !== undefined ||
    opts.depends_on !== undefined ||
    opts.priority !== undefined ||
    opts.effort_points !== undefined ||
    opts.intent !== undefined;
  if (hasPmFields) {
    interface ColInfoRow { name: string }
    const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as ColInfoRow[];
    const colSet = new Set(cols.map((c) => c.name));
    const sets: string[] = [];
    const vals: Array<unknown> = [];
    const pushIf = (col: string, val: unknown) => {
      if (colSet.has(col)) { sets.push(`${col} = ?`); vals.push(val); }
    };
    if (opts.goal_text !== undefined) pushIf('goal_text', opts.goal_text ?? null);
    if (opts.acceptance_text !== undefined) pushIf('acceptance_text', opts.acceptance_text ?? null);
    if (opts.depends_on !== undefined) {
      pushIf('depends_on_json',
        opts.depends_on.length > 0 ? JSON.stringify(opts.depends_on) : null);
    }
    if (opts.priority !== undefined) pushIf('priority', opts.priority);
    if (opts.effort_points !== undefined) pushIf('effort_points', opts.effort_points ?? null);
    if (opts.intent !== undefined) pushIf('intent', opts.intent);
    if (sets.length > 0) {
      vals.push(task.id);
      db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
  }
  return task;
}

export function getTask(db: Database.Database, id: string): Task | null {
  return (db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Task) ?? null;
}

// ── ADR-043 Phase 3 (Shape A) — PM capture ────────────────────────────────────

/**
 * ADR-043 Shape A intent bridge.
 *
 * Cypher's Stage 1 refiner (ADR-042) emits `refined_goal.intent` as a
 * FREE-FORM imperative verb phrase — the REFINER_FALLBACK_PROMPT in loop.ts
 * advertises `investigate | build | fix | refactor | ship | review | research`,
 * and the model may emit near-synonyms. ADR-043's `tasks.intent` column, by
 * contrast, is a fixed 4-value CHECK enum (`brainstorm | plan | execute |
 * decide`). This map bridges the two vocabularies.
 *
 * Everything that is *doing* work — investigate/build/fix/refactor/ship/review/
 * research — collapses to `execute` (Cypher dispatches it; it is NOT captured).
 * Only the three deliberative verbs route to the backlog as non-execute cards.
 * Unknown verbs default to `execute` (fail safe: a mystery goal is dispatched,
 * not silently parked on a board the user may not check).
 */
const REFINED_INTENT_TO_PM_INTENT: Record<string, PmIntent> = {
  brainstorm: 'brainstorm',
  ideate: 'brainstorm',
  explore: 'brainstorm',
  plan: 'plan',
  design: 'plan',
  scope: 'plan',
  decide: 'decide',
  choose: 'decide',
  evaluate: 'decide',
};

export type PmIntent = 'brainstorm' | 'plan' | 'execute' | 'decide';

/**
 * Map a free-form Stage-1 intent verb to the ADR-043 4-value enum.
 * Case-insensitive; takes the FIRST word so "plan the migration" → 'plan'.
 * Exported for the loop.ts AC-A1 hook + unit tests.
 */
export function mapRefinedIntent(refinedIntent: string | null | undefined): PmIntent {
  if (!refinedIntent) return 'execute';
  const firstWord = refinedIntent.trim().toLowerCase().split(/\s+/)[0] ?? '';
  return REFINED_INTENT_TO_PM_INTENT[firstWord] ?? 'execute';
}

export interface CapturePmTicketOpts {
  /** Card title (≤120 chars). Required. */
  title: string;
  /**
   * PM intent. MUST be non-execute (brainstorm|plan|decide) — capturing an
   * `execute` card is a routing error (execute work dispatches to Stage 2/3,
   * it is not parked on the backlog). capturePmTicket throws on 'execute'.
   */
  intent: 'brainstorm' | 'plan' | 'decide';
  /** 0-100 rank input. Default 50 (clamped to range). */
  priority?: number;
  /** Fibonacci story points {1,2,3,5,8,13} or null (unestimated). */
  effort_points?: number | null;
  /** Optional goal text carried onto the card. */
  goal_text?: string;
  /** Optional acceptance criteria text. */
  acceptance_text?: string;
  /**
   * AC-A2 — mid-session follow-up. When set, links the new card to a parent
   * task without derailing the parent's session. createTask hardcodes
   * parent_task_id=null, so we patch it in a follow-up UPDATE.
   */
  parent_task_id?: string;
  /** Project slug. Default 'wi'. Must exist in the projects table. */
  project?: string;
  /** Optional external reference (Jira key, PR ref, etc.). */
  external_ref?: string;
}

export interface CapturedPmTicket {
  /** The created task id (tsk_ prefix — deliberately NON-dispatchable). */
  id: string;
  /** Board card number (#N) for the user-facing surface, null if unassigned. */
  card_number: number | null;
  intent: PmIntent;
  priority: number;
  kanban_column: string;
}

/**
 * ADR-043 Shape A / AC-A1 + AC-A2 — file conversation work as a PM board card.
 *
 * This is the single primitive both PM capture paths converge on:
 *   - AC-A1: Cypher's Stage 1 hook calls this when refined_goal.intent is
 *     non-execute, then closes the session `outcome='captured_to_board'`.
 *   - AC-A2: a running Cypher session (Stage 3) calls this with
 *     `parent_task_id` to file follow-up work without derailing itself.
 *
 * Guarantees:
 *   - The card lands in `kanban_column='ready'` (createTask default) with a
 *     NON-execute intent, so the BoardWorkerAgent's pickReadyCard filter
 *     (`intent='execute'`) NEVER auto-dispatches it (AC-R2). It sits until the
 *     user promotes it via `/pm bump` / PATCH intent='execute'.
 *   - The `tsk_` id prefix from createTask reinforces this: even if a future
 *     bug set intent='execute', the worker's `id LIKE 'task_%'` filter would
 *     still skip it. Capture is intentionally a dead-end for the worker.
 *   - Rejects `intent='execute'` — that is a routing error, surfaced loudly
 *     rather than silently parking dispatchable work where no worker looks.
 *
 * Read-only w.r.t. execution: this NEVER triggers dispatch. It only writes a
 * row. Reversible via closeTask / delete.
 */
export function capturePmTicket(
  db: Database.Database,
  opts: CapturePmTicketOpts,
): CapturedPmTicket {
  // Guard #1 — title must be non-empty. A blank-titled card is a
  // data-quality hole (it lands in `ready` unreadable); fail as loudly as
  // the intent guard rather than silently filing garbage.
  if (!opts.title || !opts.title.trim()) {
    throw new Error(`capturePmTicket: title is required and must be non-empty.`);
  }

  // Guard #2 — only the three deliberative intents are capturable. This
  // rejects both literal intent='execute' (execute work dispatches, it is
  // not parked on the backlog) AND any missing/unknown value (undefined
  // would otherwise fall through to createTask's column default of
  // 'execute', silently smuggling a non-capturable intent onto the board).
  // Fail loud: a mis-routed card is invisible to the worker's pick filter
  // AND absent from the dispatch path, so it drops real work silently.
  const CAPTURABLE = new Set(['brainstorm', 'plan', 'decide']);
  if (!CAPTURABLE.has(opts.intent as string)) {
    throw new Error(
      `capturePmTicket: intent='${String(opts.intent)}' is not capturable — ` +
        `only brainstorm | plan | decide route to the backlog. Execute work ` +
        `is dispatched to Cypher's execute path, not parked on the board.`,
    );
  }

  const priority = Number.isInteger(opts.priority)
    ? Math.max(0, Math.min(100, opts.priority as number))
    : 50;

  const task = createTask(db, {
    title: opts.title.slice(0, 120),
    posture: 'pm',
    project: opts.project,
    external_ref: opts.external_ref,
    goal_text: opts.goal_text,
    acceptance_text: opts.acceptance_text,
    intent: opts.intent,
    priority,
    effort_points: opts.effort_points ?? null,
  });

  // AC-A2 — link to parent AFTER insert (createTask hardcodes null). Mirrors
  // the POST /api/board/tasks handler's parent_task_id follow-up UPDATE.
  if (opts.parent_task_id) {
    db.prepare(`UPDATE tasks SET parent_task_id = ? WHERE id = ?`).run(
      opts.parent_task_id,
      task.id,
    );
  }

  const row = db
    .prepare(
      `SELECT card_number, kanban_column, intent, priority FROM tasks WHERE id = ?`,
    )
    .get(task.id) as {
    card_number: number | null;
    kanban_column: string;
    intent: PmIntent;
    priority: number;
  };

  return {
    id: task.id,
    card_number: row.card_number ?? null,
    intent: row.intent,
    priority: row.priority,
    kanban_column: row.kanban_column,
  };
}


export function listTasks(
  db: Database.Database,
  opts: { project?: string; status?: TaskStatus } = {}
): Task[] {
  let sql = `SELECT * FROM tasks WHERE 1=1`;
  const params: unknown[] = [];
  if (opts.project) { sql += ` AND project = ?`; params.push(opts.project); }
  if (opts.status)  { sql += ` AND status = ?`;  params.push(opts.status); }
  sql += ` ORDER BY last_touched DESC`;
  return db.prepare(sql).all(...params) as Task[];
}

export function closeTask(
  db: Database.Database,
  id: string,
  reason?: string
): void {
  const now = Date.now();

  // C1 (2026-06-28): tear down the worktree if one was wired. The
  // SELECT-then-update pattern keeps the failure mode clean: if the
  // worktree removal throws, the row stays open (status='open') so the
  // caller can investigate and re-try. We could swallow the error and
  // close anyway, but then worktree_status would lie. Surfacing the
  // throw is honest. The DB update below runs ONLY when removal
  // succeeded (or there was nothing to remove).
  const existing = db
    .prepare(`SELECT project, worktree_status FROM tasks WHERE id = ?`)
    .get(id) as { project: string; worktree_status: string | null } | undefined;
  let worktreeFieldsUpdate = '';
  if (existing && existing.worktree_status === 'active') {
    removeWorktree(existing.project, id);
    worktreeFieldsUpdate = `, worktree_status = 'torn_down'`;
  }

  db.prepare(`
    UPDATE tasks SET status = 'closed', closed_at = ?, closed_reason = ?, last_touched = ?
    ${worktreeFieldsUpdate}
    WHERE id = ?
  `).run(now, reason ?? null, now, id);
}

function touchTask(db: Database.Database, id: string): void {
  db.prepare(`UPDATE tasks SET last_touched = ? WHERE id = ?`).run(Date.now(), id);
}

// ── Task context read/write ───────────────────────────────────────────────────

function getLatestContext(db: Database.Database, task_id: string): TaskContext | null {
  return (db
    .prepare(`SELECT * FROM task_contexts WHERE task_id = ? ORDER BY version DESC LIMIT 1`)
    .get(task_id) as TaskContext) ?? null;
}

function getDispatchCount(db: Database.Database, task_id: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM task_history WHERE task_id = ?`)
    .get(task_id) as { n: number };
  return row.n;
}

// ── D19 recurate trigger ─────────────────────────────────────────────────────

/**
 * D19 — request that the next dispatch's curator re-curate this task's
 * context, regardless of the format-version check. Sets
 * tasks.recurate_pending_at = now; cleared by the curator after a
 * successful write that produces a row with curator_format_version =
 * CURRENT_CURATOR_FORMAT_VERSION.
 *
 * Idempotent — calling twice in quick succession just bumps the
 * timestamp; the next dispatch will still run the curator exactly
 * once and clear the flag.
 *
 * Returns true if the task exists and was flagged, false if the task
 * id is unknown. Closed tasks are still flag-able (next time they
 * reopen, the curator runs); callers should validate task.status
 * upstream if that's not desired.
 */
export function recurateTaskContext(
  db: Database.Database,
  task_id: string
): boolean {
  const result = db.prepare(`
    UPDATE tasks SET recurate_pending_at = ?, last_touched = ? WHERE id = ?
  `).run(Date.now(), Date.now(), task_id);
  return result.changes > 0;
}

/**
 * Read accessor for the curator. Returns true when this task has a
 * pending recurate request that the curator should honor by running
 * unconditionally.
 */
export function hasRecuratePending(
  db: Database.Database,
  task_id: string
): boolean {
  const row = db.prepare(`SELECT recurate_pending_at FROM tasks WHERE id = ?`)
    .get(task_id) as { recurate_pending_at: number | null } | undefined;
  return !!(row && row.recurate_pending_at);
}

/**
 * Clear the recurate-pending flag after a successful curation that
 * wrote a row at the current format version. Called from
 * curateTaskContext after the INSERT into task_contexts succeeds.
 */
function clearRecuratePending(db: Database.Database, task_id: string): void {
  db.prepare(`UPDATE tasks SET recurate_pending_at = NULL WHERE id = ?`).run(task_id);
}

// ── Dispatch entry ───────────────────────────────────────────────────────────

/**
 * Load a TaskContextBlock for system-prompt injection at dispatch entry.
 * Returns null if the task doesn't exist or isn't open.
 */
export function loadTaskContext(
  db: Database.Database,
  task_id: string
): TaskContextBlock | null {
  const task = getTask(db, task_id);
  if (!task || task.status !== 'open') return null;
  const context = getLatestContext(db, task_id);
  const dispatch_count = getDispatchCount(db, task_id);
  const stale_format = context !== null
    && context.curator_format_version < MIN_SUPPORTED_CURATOR_FORMAT_VERSION;
  return { task, context, dispatch_count, stale_format };
}

/**
 * Record a task_history row at dispatch entry (outcome='pending' — updated at close).
 * Also touches last_touched on the task.
 */
export function recordTaskDispatch(
  db: Database.Database,
  task_id: string,
  dispatch_id: string
): void {
  db.prepare(`
    INSERT OR IGNORE INTO task_history (task_id, dispatch_id, outcome, ts)
    VALUES (?, ?, 'pending', ?)
  `).run(task_id, dispatch_id, Date.now());
  touchTask(db, task_id);
}

/**
 * Update the task_history outcome row at dispatch close.
 */
export function updateTaskDispatchOutcome(
  db: Database.Database,
  task_id: string,
  dispatch_id: string,
  outcome: string
): void {
  db.prepare(`
    UPDATE task_history SET outcome = ? WHERE task_id = ? AND dispatch_id = ?
  `).run(outcome, task_id, dispatch_id);
  touchTask(db, task_id);
}

// ── Render ───────────────────────────────────────────────────────────────────

/**
 * Render a TaskContextBlock into a system-prompt text block.
 * Injected after [self-assessment] block, before the first iteration.
 */
export function renderTaskContextBlock(block: TaskContextBlock): string {
  const { task, context, dispatch_count } = block;
  const age = task.last_touched
    ? Math.round((Date.now() - task.last_touched) / 1000 / 60)
    : 0;

  let text = `[task-context]\n`;
  text += `task: ${task.id} | ${task.title} | posture: ${task.posture}\n`;
  text += `status: ${task.status} | dispatches: ${dispatch_count} | last_touched: ${age}m ago\n`;
  if (task.external_ref) text += `ref: ${task.external_ref}\n`;

  if (context) {
    text += `\ncontext_summary:\n${context.context_summary}\n`;
    if (context.open_questions) {
      text += `\nopen_questions:\n${context.open_questions}\n`;
    }
    if (context.things_tried) {
      text += `\nthings_tried:\n${context.things_tried}\n`;
    }
    text += `\n(context version ${context.version}, curator_format_version ${context.curator_format_version})`;
    // D19: warn when the stored format predates the running build's
    // curator. The reader still renders the content — context is
    // information, not contract — but flags the gap so the model can
    // request a re-curation via cypher_task_recurate.
    if (context.curator_format_version < CURRENT_CURATOR_FORMAT_VERSION) {
      text += `\n[note] curator format v${context.curator_format_version} < current v${CURRENT_CURATOR_FORMAT_VERSION}`;
      if (block.stale_format) {
        text += ` — STALE (below MIN_SUPPORTED v${MIN_SUPPORTED_CURATOR_FORMAT_VERSION}); consider cypher_task_recurate`;
      } else {
        text += ` (still readable, but newer fields may be missing)`;
      }
    }
  } else {
    text += `\n(no prior context — first dispatch against this task)`;
  }

  return text;
}

// ── Curator ───────────────────────────────────────────────────────────────────

export interface CurationResult {
  context_summary: string;
  open_questions: string | null;
  things_tried: string | null;
  failure_pattern?: string;
}

interface CuratorOpts {
  task_id: string;
  dispatch_id: string;
  surface: string;
  verdict: string;
  existing_context: TaskContext | null;
  anthropic_api_key: string;
  base_url?: string;
}

/**
 * Async post-done curation call (Haiku, ~$0.005).
 * Fires AFTER the SSE done event — never blocks the user.
 *
 * When verdict='failed', also extracts failure_pattern for
 * cypher_outcomes.failure_pattern (D2 curator overrides D8 heuristic).
 */
export async function curateTaskContext(
  db: Database.Database,
  opts: CuratorOpts
): Promise<void> {
  const { task_id, dispatch_id, surface, verdict, existing_context } = opts;

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({
      apiKey: opts.anthropic_api_key,
      ...(opts.base_url ? { baseURL: opts.base_url } : {}),
    });

    const existingBlock = existing_context
      ? `EXISTING CONTEXT (version ${existing_context.version}):\n` +
        `context_summary: ${existing_context.context_summary}\n` +
        (existing_context.open_questions ? `open_questions: ${existing_context.open_questions}\n` : '') +
        (existing_context.things_tried ? `things_tried: ${existing_context.things_tried}\n` : '')
      : `EXISTING CONTEXT: none (first dispatch)`;

    const failureLine = verdict === 'failed'
      ? `\nAlso extract a short failure_pattern tag (one of: budget_exhaustion, iteration_cap, tool_error, scope_too_large, ambiguous_goal, blocked_external, other).`
      : '';

    const prompt = `You are a task memory curator. Update the task context based on this dispatch.

${existingBlock}

DISPATCH SURFACE TEXT:
${surface.slice(0, 4000)}

VERDICT: ${verdict}

Produce an updated context in JSON with these exact fields:
- context_summary: What we know, what was decided, current state (~2KB max)
- open_questions: Unresolved questions the next dispatch should answer (null if none)
- things_tried: Approaches that failed and brief why (null if none)${failureLine}

Return ONLY valid JSON, no commentary.`;

    // Route through the per-bucket model registry (ADR-031) so the
    // user's /setup/models admin UI can swap the curator's model + max
    // tokens without a code change. 'agents' bucket fits — same shape
    // as correlation-agent + orchestrator-agent (Haiku-class summaries).
    const bucketParams = bucketCallParams(db, 'agents', 1024);
    const response = await client.messages.create({
      ...bucketParams,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const result: CurationResult = JSON.parse(jsonMatch[0]);

    // Get next version number
    const latest = getLatestContext(db, task_id);
    const nextVersion = (latest?.version ?? 0) + 1;

    db.prepare(`
      INSERT INTO task_contexts (
        task_id, version, context_summary, open_questions, things_tried,
        curator_dispatch_id, curator_format_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task_id,
      nextVersion,
      result.context_summary,
      result.open_questions ?? null,
      result.things_tried ?? null,
      dispatch_id,
      CURRENT_CURATOR_FORMAT_VERSION,
      Date.now()
    );

    // D19 — successful curation at the current format version satisfies
    // any pending recurate request. Clearing the flag is idempotent
    // (no-op when nothing was pending) and keeps the flag's semantics
    // honest: "set" → "pending"; "cleared" → "current format on disk".
    clearRecuratePending(db, task_id);

    // Override heuristic failure_pattern when curator extracted one
    if (verdict === 'failed' && result.failure_pattern) {
      db.prepare(`
        UPDATE cypher_outcomes SET failure_pattern = ? WHERE dispatch_id = ?
      `).run(result.failure_pattern, dispatch_id);
    }
  } catch (err) {
    // Curation failure must never crash the bridge or block the user
    console.warn(`[task-memory] curateTaskContext failed for ${task_id}:`, (err as Error).message);
  }
}
