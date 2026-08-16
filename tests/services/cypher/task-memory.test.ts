/**
 * task-memory.ts unit tests — ADR-038 v2.5 D2 (2026-06-26).
 *
 * Coverage:
 *   - createTask / getTask / listTasks / closeTask — CRUD lifecycle
 *   - loadTaskContext — returns null when task missing / not open
 *   - recordTaskDispatch / updateTaskDispatchOutcome — history round-trip
 *   - renderTaskContextBlock — text format invariants
 *   - task_contexts append-only: curateTaskContext() DB writes (DB layer only,
 *     no real Anthropic call — we call the private insert path directly)
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import migrateV59 from '../../../src/db/migrations/v59_cypher_tables.js';
import migrateV75 from '../../../src/db/migrations/v75_d2_task_memory.js';
import migrateV76 from '../../../src/db/migrations/v76_d3_projects_table.js';
import migrateV77 from '../../../src/db/migrations/v77_d3_tasks_project_fk.js';
import migrateV81 from '../../../src/db/migrations/v81_d19_recurate_pending.js';
import {
  createTask,
  getTask,
  listTasks,
  closeTask,
  loadTaskContext,
  recordTaskDispatch,
  updateTaskDispatchOutcome,
  renderTaskContextBlock,
} from '../../../src/services/cypher/task-memory.js';

// ── Test DB setup ────────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV59(db);   // cypher_sessions (required by v75 FK)
  migrateV75(db);   // tasks, task_contexts, task_history
  process.env.REPO_PATH = './repos/workspace';
  migrateV76(db);   // projects (seeds 'wi' + 'workspace' — needed for v77 FK)
  migrateV77(db);   // tasks.project FK constraint
  migrateV81(db);   // tasks.recurate_pending_at (D19)
  return db;
}

// ── createTask ───────────────────────────────────────────────────────────────

describe('createTask', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('returns a task with tsk_ prefix id and status=open', () => {
    const t = createTask(db, { title: 'Fix DEMO-9999', posture: 'bug_investigate' });
    expect(t.id).toMatch(/^tsk_[a-f0-9]{12}$/);
    expect(t.status).toBe('open');
    expect(t.title).toBe('Fix DEMO-9999');
    expect(t.posture).toBe('bug_investigate');
  });

  it('defaults project to "wi" and owner to "maaz"', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    expect(t.project).toBe('wi');
    expect(t.owner_user_id).toBe('maaz');
  });

  it('stores external_ref when provided', () => {
    const t = createTask(db, { title: 'T', posture: 'pr_review', external_ref: 'DEMO-1234' });
    expect(t.external_ref).toBe('DEMO-1234');
  });

  it('stores custom project and owner_user_id', () => {
    const t = createTask(db, { title: 'T', posture: 'pm', project: 'workspace', owner_user_id: 'alice' });
    expect(t.project).toBe('workspace');
    expect(t.owner_user_id).toBe('alice');
  });

  it('persists the row so getTask finds it', () => {
    const t = createTask(db, { title: 'Persisted', posture: 'generic' });
    const found = getTask(db, t.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Persisted');
  });
});

// ── getTask ──────────────────────────────────────────────────────────────────

describe('getTask', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('returns null for unknown id', () => {
    expect(getTask(db, 'tsk_doesnotexist')).toBeNull();
  });

  it('returns the full task row for a known id', () => {
    const t = createTask(db, { title: 'Hello', posture: 'generic' });
    const found = getTask(db, t.id)!;
    expect(found.id).toBe(t.id);
    expect(found.closed_at).toBeNull();
    expect(found.worktree_path).toBeNull();
  });
});

// ── listTasks ─────────────────────────────────────────────────────────────────

describe('listTasks', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('returns empty array when no tasks exist', () => {
    expect(listTasks(db)).toEqual([]);
  });

  it('returns all tasks ordered by last_touched DESC', () => {
    createTask(db, { title: 'A', posture: 'generic' });
    createTask(db, { title: 'B', posture: 'generic' });
    const list = listTasks(db);
    expect(list).toHaveLength(2);
    // Most recently touched is first
    expect(list[0].last_touched).toBeGreaterThanOrEqual(list[1].last_touched);
  });

  it('filters by project', () => {
    createTask(db, { title: 'WI task', posture: 'generic', project: 'wi' });
    createTask(db, { title: 'TB task', posture: 'generic', project: 'workspace' });
    const wi = listTasks(db, { project: 'wi' });
    expect(wi).toHaveLength(1);
    expect(wi[0].title).toBe('WI task');
  });

  it('filters by status', () => {
    const t1 = createTask(db, { title: 'Open', posture: 'generic' });
    const t2 = createTask(db, { title: 'Closed', posture: 'generic' });
    closeTask(db, t2.id, 'done');
    const open = listTasks(db, { status: 'open' });
    expect(open.map(t => t.id)).toContain(t1.id);
    expect(open.map(t => t.id)).not.toContain(t2.id);
    const closed = listTasks(db, { status: 'closed' });
    expect(closed.map(t => t.id)).toContain(t2.id);
  });
});

// ── closeTask ─────────────────────────────────────────────────────────────────

describe('closeTask', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('sets status to closed and records closed_at + reason', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    closeTask(db, t.id, 'shipped');
    const updated = getTask(db, t.id)!;
    expect(updated.status).toBe('closed');
    expect(updated.closed_reason).toBe('shipped');
    expect(updated.closed_at).toBeGreaterThan(0);
  });

  it('closes with null reason when reason is omitted', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    closeTask(db, t.id);
    const updated = getTask(db, t.id)!;
    expect(updated.status).toBe('closed');
    expect(updated.closed_reason).toBeNull();
  });

  it('updates last_touched on close', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    const before = t.last_touched;
    closeTask(db, t.id, 'done');
    const after = getTask(db, t.id)!;
    expect(after.last_touched).toBeGreaterThanOrEqual(before);
  });
});

// ── loadTaskContext ───────────────────────────────────────────────────────────

describe('loadTaskContext', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('returns null for unknown task_id', () => {
    expect(loadTaskContext(db, 'tsk_unknown')).toBeNull();
  });

  it('returns null for a closed task', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    closeTask(db, t.id);
    expect(loadTaskContext(db, t.id)).toBeNull();
  });

  it('returns a TaskContextBlock for an open task with no prior context', () => {
    const t = createTask(db, { title: 'New', posture: 'pr_review' });
    const block = loadTaskContext(db, t.id);
    expect(block).not.toBeNull();
    expect(block!.task.id).toBe(t.id);
    expect(block!.context).toBeNull();
    expect(block!.dispatch_count).toBe(0);
  });

  it('returns dispatch_count matching task_history rows', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    recordTaskDispatch(db, t.id, 'cyp_a000000001');
    recordTaskDispatch(db, t.id, 'cyp_a000000002');
    const block = loadTaskContext(db, t.id)!;
    expect(block.dispatch_count).toBe(2);
  });
});

// ── recordTaskDispatch + updateTaskDispatchOutcome ────────────────────────────

describe('recordTaskDispatch + updateTaskDispatchOutcome', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('inserts a task_history row with outcome=pending', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    recordTaskDispatch(db, t.id, 'cyp_dispatch1');
    const row = db.prepare(`SELECT * FROM task_history WHERE task_id = ? AND dispatch_id = ?`)
      .get(t.id, 'cyp_dispatch1') as { outcome: string; ts: number } | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.outcome).toBe('pending');
    expect(row!.ts).toBeGreaterThan(0);
  });

  it('is idempotent — second insert does not throw (INSERT OR IGNORE)', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    recordTaskDispatch(db, t.id, 'cyp_dup');
    expect(() => recordTaskDispatch(db, t.id, 'cyp_dup')).not.toThrow();
  });

  it('touches last_touched on recordTaskDispatch', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    const before = getTask(db, t.id)!.last_touched;
    recordTaskDispatch(db, t.id, 'cyp_d1');
    const after = getTask(db, t.id)!.last_touched;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('updateTaskDispatchOutcome sets outcome on an existing row', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    recordTaskDispatch(db, t.id, 'cyp_out1');
    updateTaskDispatchOutcome(db, t.id, 'cyp_out1', 'success');
    const row = db.prepare(`SELECT outcome FROM task_history WHERE task_id = ? AND dispatch_id = ?`)
      .get(t.id, 'cyp_out1') as { outcome: string };
    expect(row.outcome).toBe('success');
  });

  it('updateTaskDispatchOutcome touches last_touched', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    recordTaskDispatch(db, t.id, 'cyp_out2');
    const before = getTask(db, t.id)!.last_touched;
    updateTaskDispatchOutcome(db, t.id, 'cyp_out2', 'failed');
    const after = getTask(db, t.id)!.last_touched;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('dispatch_count increments across multiple recordTaskDispatch calls', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    recordTaskDispatch(db, t.id, 'cyp_d_a');
    recordTaskDispatch(db, t.id, 'cyp_d_b');
    recordTaskDispatch(db, t.id, 'cyp_d_c');
    const block = loadTaskContext(db, t.id)!;
    expect(block.dispatch_count).toBe(3);
  });
});

// ── renderTaskContextBlock ────────────────────────────────────────────────────

describe('renderTaskContextBlock', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('starts with [task-context] header', () => {
    const t = createTask(db, { title: 'Review DEMO-9999', posture: 'pr_review', external_ref: 'DEMO-9999' });
    const block = loadTaskContext(db, t.id)!;
    const rendered = renderTaskContextBlock(block);
    expect(rendered).toMatch(/^\[task-context\]/);
  });

  it('includes task id, title, posture in the first line', () => {
    const t = createTask(db, { title: 'My Task', posture: 'bug_investigate' });
    const block = loadTaskContext(db, t.id)!;
    const rendered = renderTaskContextBlock(block);
    expect(rendered).toContain(t.id);
    expect(rendered).toContain('My Task');
    expect(rendered).toContain('bug_investigate');
  });

  it('includes external_ref when set', () => {
    const t = createTask(db, { title: 'T', posture: 'pm', external_ref: 'DEMO-42' });
    const block = loadTaskContext(db, t.id)!;
    const rendered = renderTaskContextBlock(block);
    expect(rendered).toContain('DEMO-42');
  });

  it('shows "(no prior context — first dispatch against this task)" when no context exists', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    const block = loadTaskContext(db, t.id)!;
    expect(renderTaskContextBlock(block)).toContain('no prior context');
  });

  it('includes context_summary when a context row exists', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    // Insert a context row directly (simulating what curateTaskContext writes)
    db.prepare(`
      INSERT INTO task_contexts (task_id, version, context_summary, open_questions, things_tried, curator_dispatch_id, curator_format_version, created_at)
      VALUES (?, 1, 'We found the root cause.', 'Is the fix safe?', 'Tried approach A.', NULL, 1, ?)
    `).run(t.id, Date.now());
    const block = loadTaskContext(db, t.id)!;
    const rendered = renderTaskContextBlock(block);
    expect(rendered).toContain('We found the root cause.');
    expect(rendered).toContain('Is the fix safe?');
    expect(rendered).toContain('Tried approach A.');
  });

  it('includes context version and curator_format_version in footer', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    db.prepare(`
      INSERT INTO task_contexts (task_id, version, context_summary, open_questions, things_tried, curator_dispatch_id, curator_format_version, created_at)
      VALUES (?, 3, 'Summary.', NULL, NULL, NULL, 1, ?)
    `).run(t.id, Date.now());
    const rendered = renderTaskContextBlock(loadTaskContext(db, t.id)!);
    expect(rendered).toContain('context version 3');
  });

  it('shows dispatch count', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    recordTaskDispatch(db, t.id, 'cyp_r001');
    recordTaskDispatch(db, t.id, 'cyp_r002');
    const rendered = renderTaskContextBlock(loadTaskContext(db, t.id)!);
    expect(rendered).toContain('dispatches: 2');
  });
});

// ── createTask project FK validation (D3 slice 2 — v77) ──────────────────────

describe('createTask project FK validation (D3 slice 2)', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('rejects an unknown project with a clear error message', () => {
    expect(() => createTask(db, {
      title: 'T',
      posture: 'generic',
      project: 'doesnotexist_xyz',
    })).toThrow(/does not exist/i);
  });

  it("accepts the seeded 'wi' project", () => {
    expect(() => createTask(db, {
      title: 'WI task',
      posture: 'generic',
      project: 'wi',
    })).not.toThrow();
  });

  it("accepts the seeded 'workspace' project", () => {
    expect(() => createTask(db, {
      title: 'TB task',
      posture: 'generic',
      project: 'workspace',
    })).not.toThrow();
  });

  it("defaulting to 'wi' (no project field) still works because 'wi' is seeded", () => {
    expect(() => createTask(db, {
      title: 'Default project task',
      posture: 'generic',
    })).not.toThrow();
    const tasks = listTasks(db);
    expect(tasks[0].project).toBe('wi');
  });

  it('error message includes the offending project name and a recovery hint', () => {
    try {
      createTask(db, { title: 'T', posture: 'generic', project: 'ghost' });
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('ghost');
      expect(msg).toMatch(/cypher_project_create|wi|workspace/);
    }
  });
});

// ── listTasks cross-project scope (D3 slice 3 backing for cypher_task_list) ──

describe('listTasks scope semantics (D3 slice 3 backing)', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it("listTasks() with no project filter returns tasks across all projects", () => {
    createTask(db, { title: 'A', posture: 'generic', project: 'wi' });
    createTask(db, { title: 'B', posture: 'generic', project: 'workspace' });
    const all = listTasks(db, {}); // no project filter
    expect(all).toHaveLength(2);
    const projects = new Set(all.map(t => t.project));
    expect(projects).toEqual(new Set(['wi', 'workspace']));
  });

  it('listTasks({project}) filters to a single project', () => {
    createTask(db, { title: 'A', posture: 'generic', project: 'wi' });
    createTask(db, { title: 'B', posture: 'generic', project: 'workspace' });
    const wiOnly = listTasks(db, { project: 'wi' });
    expect(wiOnly).toHaveLength(1);
    expect(wiOnly[0].project).toBe('wi');
    const tbOnly = listTasks(db, { project: 'workspace' });
    expect(tbOnly).toHaveLength(1);
    expect(tbOnly[0].project).toBe('workspace');
  });

  it('listTasks({project, status}) combines both filters', () => {
    const a = createTask(db, { title: 'A', posture: 'generic', project: 'wi' });
    createTask(db, { title: 'B', posture: 'generic', project: 'wi' });
    createTask(db, { title: 'C', posture: 'generic', project: 'workspace' });
    closeTask(db, a.id);
    const closedWi = listTasks(db, { project: 'wi', status: 'closed' });
    expect(closedWi).toHaveLength(1);
    expect(closedWi[0].id).toBe(a.id);
    const closedAll = listTasks(db, { status: 'closed' });
    expect(closedAll).toHaveLength(1); // only the wi closed one
  });
});

// ── task_contexts is append-only ──────────────────────────────────────────────

describe('task_contexts append-only invariant', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('each insert increments version and latest context is the highest version', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    const now = Date.now();
    db.prepare(`
      INSERT INTO task_contexts (task_id, version, context_summary, open_questions, things_tried, curator_dispatch_id, curator_format_version, created_at)
      VALUES (?, 1, 'First summary.', NULL, NULL, NULL, 1, ?)
    `).run(t.id, now);
    db.prepare(`
      INSERT INTO task_contexts (task_id, version, context_summary, open_questions, things_tried, curator_dispatch_id, curator_format_version, created_at)
      VALUES (?, 2, 'Second summary.', 'Open Q', 'Tried B', NULL, 1, ?)
    `).run(t.id, now + 1000);
    // loadTaskContext returns the latest context (version=2)
    const block = loadTaskContext(db, t.id)!;
    expect(block.context!.version).toBe(2);
    expect(block.context!.context_summary).toBe('Second summary.');
    // Both rows still exist (append-only, no deletes)
    const rows = db.prepare(`SELECT version FROM task_contexts WHERE task_id = ? ORDER BY version ASC`).all(t.id) as Array<{ version: number }>;
    expect(rows.map(r => r.version)).toEqual([1, 2]);
  });

  it('PRIMARY KEY on (task_id, version) rejects duplicate versions', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    const now = Date.now();
    db.prepare(`
      INSERT INTO task_contexts (task_id, version, context_summary, open_questions, things_tried, curator_dispatch_id, curator_format_version, created_at)
      VALUES (?, 1, 'V1', NULL, NULL, NULL, 1, ?)
    `).run(t.id, now);
    expect(() => db.prepare(`
      INSERT INTO task_contexts (task_id, version, context_summary, open_questions, things_tried, curator_dispatch_id, curator_format_version, created_at)
      VALUES (?, 1, 'Duplicate', NULL, NULL, NULL, 1, ?)
    `).run(t.id, now)).toThrow();
  });
});

// ── cypher_sessions.task_id FK ────────────────────────────────────────────────

describe('cypher_sessions.task_id FK column (v75 additive column)', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('cypher_sessions.task_id column exists after v75 migration', () => {
    const cols = db.prepare(`PRAGMA table_info(cypher_sessions)`).all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('task_id');
  });

  it('accepts a session row with a valid task_id FK', () => {
    const t = createTask(db, { title: 'T', posture: 'generic' });
    expect(() =>
      db.prepare(`INSERT INTO cypher_sessions (session_id, goal, user, status, task_id) VALUES (?, 'g', 'maaz', 'pending', ?)`)
        .run('cyp_fk1', t.id)
    ).not.toThrow();
  });

  it('accepts a session row with NULL task_id', () => {
    expect(() =>
      db.prepare(`INSERT INTO cypher_sessions (session_id, goal, user, status, task_id) VALUES (?, 'g', 'maaz', 'pending', NULL)`)
        .run('cyp_fk2')
    ).not.toThrow();
  });

  it('rejects a task_id pointing to a non-existent task (FK constraint)', () => {
    expect(() =>
      db.prepare(`INSERT INTO cypher_sessions (session_id, goal, user, status, task_id) VALUES (?, 'g', 'maaz', 'pending', 'tsk_ghost123456')`)
        .run('cyp_fk3')
    ).toThrow();
  });
});
