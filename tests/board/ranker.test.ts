/**
 * ADR-043 Phase 1 — Ranker invariants + formula verification.
 *
 * Verifies each formula term independently and the load-bearing invariant
 * `sum(reasons[i].contribution) == rank_score` (AC-U2 teeth).
 *
 * Uses a synthetic in-memory DB with just enough of the tasks schema to
 * exercise the ranker's SELECT — no need to run the full v1..v99 migration
 * chain here.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeBacklogRank,
  WEIGHTS,
  _testing,
} from '../../src/services/board/ranker.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  // Minimal tasks-table shape sufficient for the ranker; we're not testing
  // the migrations here, only the ranker's read + scoring logic.
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
      created_at      INTEGER NOT NULL,
      last_touched    INTEGER NOT NULL,
      priority        INTEGER NOT NULL DEFAULT 50,
      effort_points   INTEGER,
      intent          TEXT NOT NULL DEFAULT 'execute'
    );
  `);
  return db;
}

interface InsertOpts {
  id: string;
  title?: string;
  priority?: number;
  effort_points?: number | null;
  intent?: string;
  kanban_column?: string;
  blocked?: 0 | 1;
  depends_on_json?: string | null;
  created_at?: number;
}
function insertTask(db: Database.Database, o: InsertOpts): void {
  const now = o.created_at ?? Date.now();
  db.prepare(
    `INSERT INTO tasks (id, title, priority, effort_points, intent, kanban_column,
                        blocked, depends_on_json, created_at, last_touched)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id,
    o.title ?? o.id,
    o.priority ?? 50,
    o.effort_points ?? null,
    o.intent ?? 'execute',
    o.kanban_column ?? 'ready',
    o.blocked ?? 0,
    o.depends_on_json ?? null,
    now,
    now,
  );
}

describe('ADR-043 ranker — computeBacklogRank', () => {
  let db: Database.Database;
  const NOW = 1_700_000_000_000; // fixed clock, ms
  const DAY = 86_400_000;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => db.close());

  it('AC-S4 invariant: sum(contribution) == rank_score for every returned card', () => {
    insertTask(db, { id: 't1', priority: 80, effort_points: 3, created_at: NOW - 2 * DAY });
    insertTask(db, { id: 't2', priority: 40, effort_points: null, created_at: NOW - 10 * DAY });
    insertTask(db, { id: 't3', priority: 60, effort_points: 8, blocked: 1, created_at: NOW });

    const { backlog } = computeBacklogRank(db, { nowMs: NOW });
    for (const t of backlog) {
      const sum = t.reasons.reduce((s, r) => s + r.contribution, 0);
      expect(Math.abs(sum - t.rank_score)).toBeLessThan(0.01);
    }
  });

  it('priority is the base signal — higher priority ranks higher (all else equal)', () => {
    insertTask(db, { id: 'low', priority: 20, created_at: NOW });
    insertTask(db, { id: 'high', priority: 90, created_at: NOW });
    const { top_task_id, backlog } = computeBacklogRank(db, { nowMs: NOW });
    expect(top_task_id).toBe('high');
    expect(backlog[0]!.id).toBe('high');
    expect(backlog[1]!.id).toBe('low');
  });

  it('blocked cards sink to the bottom regardless of high priority', () => {
    insertTask(db, { id: 'blocked-high', priority: 100, blocked: 1, created_at: NOW });
    insertTask(db, { id: 'clean-low', priority: 10, blocked: 0, created_at: NOW });
    const { top_task_id, backlog } = computeBacklogRank(db, { nowMs: NOW });
    expect(top_task_id).toBe('clean-low');
    const blocked = backlog.find((t) => t.id === 'blocked-high')!;
    // -999 penalty definitively outweighs any realistic priority.
    expect(blocked.rank_score).toBeLessThan(0);
  });

  it('deps_penalty sinks a card whose deps are not done', () => {
    // Put the dep in a non-done column so it counts as unready.
    insertTask(db, { id: 'dep-not-done', priority: 50, kanban_column: 'ready', created_at: NOW });
    insertTask(db, {
      id: 'dependent',
      priority: 90,
      depends_on_json: JSON.stringify(['dep-not-done']),
      created_at: NOW,
    });
    const { backlog } = computeBacklogRank(db, { nowMs: NOW });
    const dep = backlog.find((t) => t.id === 'dependent')!;
    // Should be included but penalised: 90 (priority) - 100 (deps) = -10 (± age).
    expect(dep.rank_score).toBeLessThan(0);
    // And the depFilter reason must reflect exactly 1 unready dep.
    const depsReason = dep.reasons.find((r) => r.signal === 'deps_penalty')!;
    expect(depsReason.value).toBe(1);
    expect(depsReason.contribution).toBe(-WEIGHTS.DEPS_PENALTY_PER_DEP);
  });

  it('deps_penalty NOT applied when all deps are in done column', () => {
    insertTask(db, { id: 'dep-done', priority: 50, kanban_column: 'done', created_at: NOW });
    insertTask(db, {
      id: 'unblocked',
      priority: 60,
      depends_on_json: JSON.stringify(['dep-done']),
      created_at: NOW,
    });
    const { backlog } = computeBacklogRank(db, { nowMs: NOW });
    const unblocked = backlog.find((t) => t.id === 'unblocked')!;
    const depsReason = unblocked.reasons.find((r) => r.signal === 'deps_penalty')!;
    expect(depsReason.value).toBe(0);
    expect(depsReason.contribution).toBe(0);
  });

  it('age_bonus caps at 30 days — older cards do not float further', () => {
    insertTask(db, { id: 'fresh', priority: 50, created_at: NOW });
    insertTask(db, { id: 'ten-day', priority: 50, created_at: NOW - 10 * DAY });
    insertTask(db, { id: 'sixty-day', priority: 50, created_at: NOW - 60 * DAY });

    const { backlog } = computeBacklogRank(db, { nowMs: NOW });
    const fresh = backlog.find((t) => t.id === 'fresh')!.reasons.find((r) => r.signal === 'age_bonus')!;
    const ten = backlog.find((t) => t.id === 'ten-day')!.reasons.find((r) => r.signal === 'age_bonus')!;
    const sixty = backlog.find((t) => t.id === 'sixty-day')!.reasons.find((r) => r.signal === 'age_bonus')!;
    expect(fresh.value).toBeCloseTo(0, 4);
    expect(ten.value).toBeCloseTo(10, 4);
    expect(sixty.value).toBeCloseTo(WEIGHTS.AGE_BONUS_CAP_DAYS, 4); // capped
  });

  it('effort_penalty: NULL effort contributes 0; higher effort penalises more', () => {
    insertTask(db, { id: 'unknown-effort', priority: 50, effort_points: null, created_at: NOW });
    insertTask(db, { id: 'small', priority: 50, effort_points: 1, created_at: NOW });
    insertTask(db, { id: 'big', priority: 50, effort_points: 13, created_at: NOW });

    const { backlog } = computeBacklogRank(db, { nowMs: NOW });
    const unk = backlog.find((t) => t.id === 'unknown-effort')!.reasons.find((r) => r.signal === 'effort_penalty')!;
    const small = backlog.find((t) => t.id === 'small')!.reasons.find((r) => r.signal === 'effort_penalty')!;
    const big = backlog.find((t) => t.id === 'big')!.reasons.find((r) => r.signal === 'effort_penalty')!;

    expect(unk.contribution).toBe(0);
    expect(small.contribution).toBe(-0.5);
    expect(big.contribution).toBe(-6.5);
  });

  it('intent filter: default only returns execute cards; scope=all returns brainstorm too', () => {
    insertTask(db, { id: 'exec', intent: 'execute', priority: 50, created_at: NOW });
    insertTask(db, { id: 'brain', intent: 'brainstorm', priority: 90, created_at: NOW });
    insertTask(db, { id: 'plan', intent: 'plan', priority: 90, created_at: NOW });

    const executeOnly = computeBacklogRank(db, { nowMs: NOW });
    expect(executeOnly.backlog.map((t) => t.id)).toEqual(['exec']);

    const all = computeBacklogRank(db, { nowMs: NOW, intent: 'all' });
    // brain + plan tie at priority=90; exec at 50. Both should appear above exec.
    expect(all.backlog.length).toBe(3);
    expect(all.backlog[0]!.rank_score).toBeGreaterThanOrEqual(all.backlog[2]!.rank_score);
    expect(all.backlog.map((t) => t.id).sort()).toEqual(['brain', 'exec', 'plan']);
  });

  it('scope filter: default ready; open includes in_progress/review/e2e', () => {
    insertTask(db, { id: 'r1', kanban_column: 'ready', created_at: NOW });
    insertTask(db, { id: 'ip1', kanban_column: 'in_progress', created_at: NOW });
    insertTask(db, { id: 'd1', kanban_column: 'done', created_at: NOW });

    const readyOnly = computeBacklogRank(db, { nowMs: NOW });
    expect(readyOnly.backlog.map((t) => t.id).sort()).toEqual(['r1']);

    const openScope = computeBacklogRank(db, { nowMs: NOW, scope: 'open' });
    expect(openScope.backlog.map((t) => t.id).sort()).toEqual(['ip1', 'r1']);
    // 'done' never appears in either — the backlog is not a history log.
  });

  it('empty backlog returns top_task_id=null', () => {
    const { top_task_id, backlog } = computeBacklogRank(db, { nowMs: NOW });
    expect(top_task_id).toBeNull();
    expect(backlog).toEqual([]);
  });

  it('malformed depends_on_json does not throw or silently sink card', () => {
    insertTask(db, { id: 'bad-deps', depends_on_json: 'not-json{{{', priority: 70, created_at: NOW });
    const { backlog } = computeBacklogRank(db, { nowMs: NOW });
    const card = backlog.find((t) => t.id === 'bad-deps')!;
    expect(card).toBeDefined();
    const depsR = card.reasons.find((r) => r.signal === 'deps_penalty')!;
    expect(depsR.value).toBe(0);
    expect(depsR.contribution).toBe(0);
  });

  it('scoreTask exposed via _testing gives deterministic per-row scoring', () => {
    const row = {
      id: 't', title: 'x', intent: 'execute', kanban_column: 'ready',
      priority: 80, effort_points: 5, blocked: 0,
      depends_on_json: null, created_at: NOW - 4 * DAY, card_number: null,
    };
    const scored = _testing.scoreTask(row, 0, NOW);
    // priority=80 + age_bonus=4 - effort=2.5 = 81.5
    expect(scored.rank_score).toBeCloseTo(81.5, 4);
  });

  it('tie-break: on equal rank_score the OLDER card ranks first (FIFO / stale-float)', () => {
    // Regression for the inverted-tiebreak bug found by the ADR-043 multi-agent
    // audit (2026-07-15). Two ready cards, same priority, both past the 30-day
    // age cap → identical rank_score. Before the fix the SELECT was created_at
    // DESC + a 0-returning comparator + stable sort, so the NEWER card won —
    // opposite of the ADR's "stale ready cards float" intent. No prior scenario
    // built an exact tie, so it slipped past 17/17.
    insertTask(db, { id: 'newer', priority: 50, effort_points: null, created_at: NOW - 40 * DAY });
    insertTask(db, { id: 'older', priority: 50, effort_points: null, created_at: NOW - 100 * DAY });

    const { backlog, top_task_id } = computeBacklogRank(db, { nowMs: NOW });
    // Sanity: the two scores really are tied (both hit the 30-day age cap).
    const s = Object.fromEntries(backlog.map((t) => [t.id, t.rank_score]));
    expect(s['older']).toBeCloseTo(s['newer'], 6);
    // The older card must come first and be the top card.
    expect(backlog.map((t) => t.id)).toEqual(['older', 'newer']);
    expect(top_task_id).toBe('older');
  });
});
