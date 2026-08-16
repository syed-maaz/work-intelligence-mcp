/**
 * ADR-043 Phase 1 — BoardWorkerAgent intent-filter regression test.
 *
 * Asserts the *filter behavior* the ranker delegates to the DB: only
 * `intent='execute'` cards enter the pick pool, ordered by `priority DESC,
 * created_at ASC`. Doesn't spin up the whole agent — that would need
 * bridge/env plumbing we don't need. Directly runs the same SELECT the
 * agent uses.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      posture         TEXT NOT NULL DEFAULT 'generic',
      status          TEXT NOT NULL DEFAULT 'open',
      goal_text       TEXT,
      kanban_column   TEXT NOT NULL DEFAULT 'ready',
      kanban_order    INTEGER NOT NULL DEFAULT 0,
      assigned_worker_id INTEGER,
      blocked         INTEGER NOT NULL DEFAULT 0,
      blocked_reason  TEXT,
      entered_column_at INTEGER,
      depends_on_json TEXT,
      card_number     INTEGER,
      needs_answer    INTEGER NOT NULL DEFAULT 0,
      stalled         INTEGER NOT NULL DEFAULT 0,
      stalled_reason  TEXT,
      external_ref    TEXT,
      created_at      INTEGER NOT NULL,
      last_touched    INTEGER NOT NULL,
      priority        INTEGER NOT NULL DEFAULT 50,
      effort_points   INTEGER,
      intent          TEXT NOT NULL DEFAULT 'execute'
    );
  `);
  return db;
}

interface Ins {
  id: string;
  intent?: string;
  priority?: number;
  created_at?: number;
  title?: string;
  blocked?: 0 | 1;
  stalled?: 0 | 1;
  goal_text?: string | null;
  external_ref?: string | null;
  kanban_column?: string;
}
function insert(db: Database.Database, o: Ins): void {
  const now = o.created_at ?? Date.now();
  db.prepare(
    `INSERT INTO tasks (id, title, priority, intent, kanban_column, blocked, stalled,
                        goal_text, external_ref, created_at, last_touched)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id,
    o.title ?? o.id,
    o.priority ?? 50,
    o.intent ?? 'execute',
    o.kanban_column ?? 'ready',
    o.blocked ?? 0,
    o.stalled ?? 0,
    o.goal_text ?? 'goal',
    o.external_ref ?? null,
    now,
    now,
  );
}

/** Replica of the SELECT used inside BoardWorkerAgent#pickReadyCard. */
function boardWorkerAgentQuery(db: Database.Database): Array<{ id: string; priority: number }> {
  return db
    .prepare(
      `SELECT id, priority FROM tasks
        WHERE kanban_column = 'ready'
          AND blocked = 0
          AND stalled = 0
          AND intent = 'execute'
          AND goal_text IS NOT NULL
          AND id LIKE 'task_%'
          AND (external_ref IS NULL OR external_ref NOT LIKE 'smoke%')
          AND title NOT LIKE 'adr040-c1-smoke-%'
          AND title NOT LIKE 'Smoke%'
        ORDER BY priority DESC, created_at ASC`,
    )
    .all() as Array<{ id: string; priority: number }>;
}

describe('ADR-043 Phase 1 — BoardWorkerAgent intent filter (AC-S5)', () => {
  let db: Database.Database;
  const NOW = 1_700_000_000_000;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => db.close());

  it('brainstorm/plan/decide cards are NEVER picked by the worker', () => {
    insert(db, { id: 'task_brain', intent: 'brainstorm', priority: 100, created_at: NOW });
    insert(db, { id: 'task_plan',  intent: 'plan',       priority: 100, created_at: NOW });
    insert(db, { id: 'task_dec',   intent: 'decide',     priority: 100, created_at: NOW });
    insert(db, { id: 'task_exec',  intent: 'execute',    priority: 40,  created_at: NOW });

    const picked = boardWorkerAgentQuery(db);
    expect(picked.map((r) => r.id)).toEqual(['task_exec']);
  });

  it('execute cards ordered by priority desc, then created_at asc (tiebreak)', () => {
    insert(db, { id: 'task_low',       intent: 'execute', priority: 20,  created_at: NOW });
    insert(db, { id: 'task_high_new',  intent: 'execute', priority: 90,  created_at: NOW });
    insert(db, { id: 'task_high_old',  intent: 'execute', priority: 90,  created_at: NOW - 1000 });
    insert(db, { id: 'task_mid',       intent: 'execute', priority: 50,  created_at: NOW });

    const picked = boardWorkerAgentQuery(db);
    // Both high cards ahead of mid/low; older high wins the tiebreak.
    expect(picked.map((r) => r.id)).toEqual([
      'task_high_old',
      'task_high_new',
      'task_mid',
      'task_low',
    ]);
  });

  it('blocked and stalled cards are excluded from pickup', () => {
    insert(db, { id: 'task_ok',       intent: 'execute', priority: 50, created_at: NOW });
    insert(db, { id: 'task_blocked',  intent: 'execute', priority: 99, blocked: 1, created_at: NOW });
    insert(db, { id: 'task_stalled',  intent: 'execute', priority: 99, stalled: 1, created_at: NOW });

    const picked = boardWorkerAgentQuery(db);
    expect(picked.map((r) => r.id)).toEqual(['task_ok']);
  });

  it('with default priority=50, ordering collapses to FIFO by created_at (PM_ORCHESTRATION_ENABLED=0 compat)', () => {
    insert(db, { id: 'task_new', created_at: NOW });
    insert(db, { id: 'task_mid', created_at: NOW - 5000 });
    insert(db, { id: 'task_old', created_at: NOW - 10000 });

    const picked = boardWorkerAgentQuery(db);
    // All priority=50 → FIFO by created_at asc = oldest first.
    expect(picked.map((r) => r.id)).toEqual(['task_old', 'task_mid', 'task_new']);
  });
});
