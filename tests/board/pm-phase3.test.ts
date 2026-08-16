/**
 * ADR-043 Phase 3 (Shape A) — capturePmTicket + PM capture hook + PMAgent.
 *
 * Covers:
 *   - AC-A1: shouldCaptureToBoard flag-gating + non-execute routing decision;
 *     mapRefinedIntent verb→enum bridge.
 *   - AC-A2: capturePmTicket files a card (tsk_ prefix, lands in ready, intent
 *     preserved); parent_task_id linkage for mid-session follow-up; execute
 *     intent is rejected (routing error).
 *   - AC-A3: PMAgent tick refreshes rank (observability) + flags stalled cards
 *     in ready > stall window + un-stalls re-touched cards.
 *   - AC-A4: PMAgent tick no-ops when PM_AGENT_ENABLED != 1.
 *   - AC-R2: a captured non-execute card is never eligible for the worker's
 *     pickReadyCard filter.
 *
 * Builds the real schema by applying the migration chain (v59→v100) onto an
 * in-memory DB, so createTask's project-FK validation + the PM columns +
 * kanban defaults all behave exactly as production.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import migrateV59 from '../../src/db/migrations/v59_cypher_tables.js';
import migrateV75 from '../../src/db/migrations/v75_d2_task_memory.js';
import migrateV76 from '../../src/db/migrations/v76_d3_projects_table.js';
import migrateV77 from '../../src/db/migrations/v77_d3_tasks_project_fk.js';
import migrateV81 from '../../src/db/migrations/v81_d19_recurate_pending.js';
import migrateV90 from '../../src/db/migrations/v90_adr040_tasks_kanban.js';
import migrateV91 from '../../src/db/migrations/v91_adr040_outcome_evidence.js';
import migrateV92 from '../../src/db/migrations/v92_adr040_subagent_dispatches.js';
import migrateV93 from '../../src/db/migrations/v93_adr040_interaction_tokens.js';
import migrateV94 from '../../src/db/migrations/v94_adr040_card_number.js';
import migrateV95 from '../../src/db/migrations/v95_adr040_card_comments.js';
import migrateV97 from '../../src/db/migrations/v97_adr040_task_stalled.js';
import migrateV98 from '../../src/db/migrations/v98_prompt_memory.js';
import migrateV99 from '../../src/db/migrations/v99_adr043_pm_layer.js';
import migrateV100 from '../../src/db/migrations/v100_captured_to_board_outcome.js';
import {
  capturePmTicket,
  mapRefinedIntent,
  getTask,
} from '../../src/services/cypher/task-memory.js';
import { shouldCaptureToBoard, captureToBoard } from '../../src/services/cypher/pm-capture-hook.js';
import { PMAgent } from '../../src/intelligence/pm-agent.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV59(db); // cypher_sessions (v75 FK + AC-A1 session close)
  migrateV75(db); // tasks, task_contexts, task_history
  migrateV76(db); // projects (seeds 'wi')
  migrateV77(db); // tasks.project FK
  migrateV81(db); // recurate_pending_at
  migrateV90(db); // kanban_column + board columns (default 'ready')
  migrateV91(db); // outcome_evidence
  migrateV92(db); // subagent_dispatches
  migrateV93(db); // interaction_tokens
  migrateV94(db); // card_number
  migrateV95(db); // card_comments
  migrateV97(db); // tasks.stalled + stalled_reason
  migrateV98(db); // prompt_memory
  migrateV99(db); // priority / effort_points / intent
  migrateV100(db); // outcome CHECK widened for captured_to_board
  return db;
}

const DAY = 24 * 60 * 60 * 1000;

// ── mapRefinedIntent (AC-A1 bridge) ────────────────────────────────────────

describe('mapRefinedIntent — free-form verb → 4-value enum', () => {
  it('maps deliberative verbs to their PM intent', () => {
    expect(mapRefinedIntent('brainstorm')).toBe('brainstorm');
    expect(mapRefinedIntent('plan')).toBe('plan');
    expect(mapRefinedIntent('decide')).toBe('decide');
    expect(mapRefinedIntent('design the migration')).toBe('plan');
    expect(mapRefinedIntent('evaluate the options')).toBe('decide');
    expect(mapRefinedIntent('explore approaches')).toBe('brainstorm');
  });

  it('collapses doing-verbs to execute', () => {
    for (const v of ['investigate', 'build', 'fix', 'refactor', 'ship', 'review', 'research']) {
      expect(mapRefinedIntent(v)).toBe('execute');
    }
  });

  it('defaults unknown/empty/null intent to execute (fail-safe)', () => {
    expect(mapRefinedIntent(null)).toBe('execute');
    expect(mapRefinedIntent(undefined)).toBe('execute');
    expect(mapRefinedIntent('')).toBe('execute');
    expect(mapRefinedIntent('frobnicate')).toBe('execute');
  });

  it('is case-insensitive and takes the first word', () => {
    expect(mapRefinedIntent('PLAN the sprint')).toBe('plan');
    expect(mapRefinedIntent('  Decide  between A and B')).toBe('decide');
  });
});

// ── capturePmTicket (AC-A2) ─────────────────────────────────────────────────

describe('capturePmTicket', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('files a non-execute card that lands in ready with a tsk_ id and preserved intent', () => {
    const cap = capturePmTicket(db, {
      title: 'Rate-limit the search-provider proxy',
      intent: 'plan',
      priority: 70,
      goal_text: 'we should add rate limiting to the search-provider proxy',
    });
    expect(cap.id).toMatch(/^tsk_[a-f0-9]{12}$/);
    expect(cap.intent).toBe('plan');
    expect(cap.priority).toBe(70);
    expect(cap.kanban_column).toBe('ready');

    const row = getTask(db, cap.id);
    expect(row).not.toBeNull();
    expect(row!.title).toBe('Rate-limit the search-provider proxy');
  });

  it('rejects intent=execute (execute work dispatches, is not captured)', () => {
    expect(() =>
      // @ts-expect-error — deliberately passing the forbidden value
      capturePmTicket(db, { title: 'do the thing', intent: 'execute' }),
    ).toThrow(/not capturable/);
  });

  it('rejects a missing/undefined intent (would default column to execute — audit gap #7)', () => {
    expect(() =>
      // @ts-expect-error — intent omitted; must NOT silently default to execute
      capturePmTicket(db, { title: 'no intent given' }),
    ).toThrow(/not capturable/);
    // No orphan row lands.
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('rejects an empty / whitespace-only title (audit gap #6)', () => {
    expect(() => capturePmTicket(db, { title: '', intent: 'plan' })).toThrow(/title is required/);
    expect(() => capturePmTicket(db, { title: '   ', intent: 'plan' })).toThrow(/title is required/);
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('AC-A2 — parent_task_id links a mid-session follow-up card without derailing the parent', () => {
    const parent = capturePmTicket(db, { title: 'Parent brainstorm', intent: 'brainstorm' });
    const child = capturePmTicket(db, {
      title: 'Follow-up: benchmark alternatives',
      intent: 'decide',
      parent_task_id: parent.id,
    });
    const childRow = db
      .prepare(`SELECT parent_task_id FROM tasks WHERE id = ?`)
      .get(child.id) as { parent_task_id: string | null };
    expect(childRow.parent_task_id).toBe(parent.id);
  });

  it('clamps priority to 0..100 and defaults to 50', () => {
    const hi = capturePmTicket(db, { title: 'a', intent: 'plan', priority: 200 });
    expect(hi.priority).toBe(100);
    const lo = capturePmTicket(db, { title: 'b', intent: 'plan', priority: -5 });
    expect(lo.priority).toBe(0);
    const def = capturePmTicket(db, { title: 'c', intent: 'plan' });
    expect(def.priority).toBe(50);
  });

  it('AC-R2 — a captured non-execute card is never eligible for the worker pick filter', () => {
    const cap = capturePmTicket(db, { title: 'Plan sprint', intent: 'plan', priority: 100 });
    // Replica of BoardWorkerAgent#pickReadyCard eligibility.
    const eligible = db
      .prepare(
        `SELECT id FROM tasks
          WHERE kanban_column = 'ready' AND blocked = 0 AND stalled = 0
            AND intent = 'execute' AND id LIKE 'task_%'`,
      )
      .all() as Array<{ id: string }>;
    expect(eligible.map((r) => r.id)).not.toContain(cap.id);
    // Double guarantee: it's non-execute AND tsk_-prefixed.
    expect(cap.intent).not.toBe('execute');
    expect(cap.id.startsWith('tsk_')).toBe(true);
  });
});

// ── shouldCaptureToBoard + captureToBoard (AC-A1) ───────────────────────────

describe('shouldCaptureToBoard — flag gating + routing decision', () => {
  const RG = (intent: string) =>
    JSON.stringify({ intent, target: 'the search-provider proxy', success_criteria: 'x' });

  afterEach(() => {
    delete process.env.WI_STAGE1_ENABLED;
    delete process.env.PM_ORCHESTRATION_ENABLED;
  });

  it('returns null when flags are off (dormant — loop proceeds to EXECUTE)', () => {
    delete process.env.WI_STAGE1_ENABLED;
    delete process.env.PM_ORCHESTRATION_ENABLED;
    expect(shouldCaptureToBoard(RG('plan'), 'raw goal')).toBeNull();

    process.env.WI_STAGE1_ENABLED = '1'; // only one flag on
    expect(shouldCaptureToBoard(RG('plan'), 'raw goal')).toBeNull();
  });

  it('returns a decision for non-execute intent when both flags are on', () => {
    process.env.WI_STAGE1_ENABLED = '1';
    process.env.PM_ORCHESTRATION_ENABLED = '1';
    const d = shouldCaptureToBoard(RG('brainstorm'), 'raw goal');
    expect(d).not.toBeNull();
    expect(d!.intent).toBe('brainstorm');
    expect(d!.title).toBe('the search-provider proxy'); // prefers refined target
  });

  it('returns null for execute intent even with both flags on', () => {
    process.env.WI_STAGE1_ENABLED = '1';
    process.env.PM_ORCHESTRATION_ENABLED = '1';
    expect(shouldCaptureToBoard(RG('investigate'), 'raw goal')).toBeNull();
    expect(shouldCaptureToBoard(RG('build'), 'raw goal')).toBeNull();
  });

  it('returns null for null / malformed refined goal', () => {
    process.env.WI_STAGE1_ENABLED = '1';
    process.env.PM_ORCHESTRATION_ENABLED = '1';
    expect(shouldCaptureToBoard(null, 'raw')).toBeNull();
    expect(shouldCaptureToBoard('{not json', 'raw')).toBeNull();
  });

  it('captureToBoard files the card and produces the AC-A1 surface', () => {
    const db = freshDb();
    try {
      const res = captureToBoard(db, { intent: 'plan', title: 'Plan X', goal_text: 'plan X please' });
      expect(res.task_id).toMatch(/^tsk_/);
      expect(res.intent).toBe('plan');
      expect(res.surface).toMatch(/Filed as card/);
      expect(res.surface).toMatch(/\/pm next/);
      const row = getTask(db, res.task_id);
      expect(row!.title).toBe('Plan X');
    } finally {
      db.close();
    }
  });
});

// ── PMAgent (AC-A3 / AC-A4) ─────────────────────────────────────────────────

describe('PMAgent tick', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    process.env.PM_AGENT_ENABLED = '1';
  });
  afterEach(() => {
    delete process.env.PM_AGENT_ENABLED;
    db.close();
  });

  it('AC-A4 — no-ops (skipped=disabled) when PM_AGENT_ENABLED != 1', async () => {
    delete process.env.PM_AGENT_ENABLED;
    const agent = new PMAgent({ db });
    const r = await agent.tick();
    expect(r.skipped).toBe('disabled');
    expect(r.stalled_flagged).toBe(0);
  });

  it('AC-A3 — flags cards in ready older than the stall window', async () => {
    const now = 1_800_000_000_000;
    // old: 20 days in ready → should stall (window 14d)
    capturePmTicket(db, { title: 'old plan', intent: 'plan' });
    // Backdate its entered_column_at + created_at.
    const oldId = (db.prepare(`SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1`).get() as { id: string }).id;
    db.prepare(`UPDATE tasks SET created_at = ?, entered_column_at = ?, last_touched = ? WHERE id = ?`)
      .run(now - 20 * DAY, now - 20 * DAY, now - 20 * DAY, oldId);
    // fresh: just created → should NOT stall
    const fresh = capturePmTicket(db, { title: 'fresh plan', intent: 'plan' });
    db.prepare(`UPDATE tasks SET created_at = ?, entered_column_at = ?, last_touched = ? WHERE id = ?`)
      .run(now - 1 * DAY, now - 1 * DAY, now - 1 * DAY, fresh.id);

    const agent = new PMAgent({ db, nowMs: now, stallMs: 14 * DAY });
    const r = await agent.tick();
    expect(r.stalled_flagged).toBe(1);

    const oldRow = db.prepare(`SELECT stalled FROM tasks WHERE id = ?`).get(oldId) as { stalled: number };
    const freshRow = db.prepare(`SELECT stalled FROM tasks WHERE id = ?`).get(fresh.id) as { stalled: number };
    expect(oldRow.stalled).toBe(1);
    expect(freshRow.stalled).toBe(0);
  });

  // tsk_aa2abe3414c5 — the stall gate previously watched ONLY `ready`, so a
  // multi-day in_progress / e2e pileup (worker assigned, no advance) was never
  // flagged. These two cases lock in the extended coverage.
  it('tsk_aa2abe3414c5 — flags cards stuck in in_progress older than the window', async () => {
    const now = 1_800_000_000_000;
    capturePmTicket(db, { title: 'stuck wip', intent: 'plan' });
    const id = (db.prepare(`SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1`).get() as { id: string }).id;
    // Move to in_progress and backdate 20d (> injected 14d window).
    db.prepare(`UPDATE tasks SET kanban_column='in_progress', created_at=?, entered_column_at=?, last_touched=? WHERE id=?`)
      .run(now - 20 * DAY, now - 20 * DAY, now - 20 * DAY, id);

    const agent = new PMAgent({ db, nowMs: now, stallMs: 14 * DAY });
    const r = await agent.tick();
    expect(r.stalled_flagged).toBe(1);
    const row = db.prepare(`SELECT stalled, stalled_reason FROM tasks WHERE id = ?`).get(id) as { stalled: number; stalled_reason: string };
    expect(row.stalled).toBe(1);
    expect(row.stalled_reason).toContain('in_progress');
  });

  it('tsk_aa2abe3414c5 — flags cards stuck in e2e older than the window', async () => {
    const now = 1_800_000_000_000;
    capturePmTicket(db, { title: 'stuck e2e', intent: 'plan' });
    const id = (db.prepare(`SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1`).get() as { id: string }).id;
    db.prepare(`UPDATE tasks SET kanban_column='e2e', created_at=?, entered_column_at=?, last_touched=? WHERE id=?`)
      .run(now - 20 * DAY, now - 20 * DAY, now - 20 * DAY, id);

    const agent = new PMAgent({ db, nowMs: now, stallMs: 14 * DAY });
    const r = await agent.tick();
    expect(r.stalled_flagged).toBe(1);
    const row = db.prepare(`SELECT stalled, stalled_reason FROM tasks WHERE id = ?`).get(id) as { stalled: number; stalled_reason: string };
    expect(row.stalled).toBe(1);
    expect(row.stalled_reason).toContain('e2e');
  });

  it('AC-A3 — recomputes the backlog rank for observability (ranked count reflects open cards)', async () => {
    capturePmTicket(db, { title: 'p1', intent: 'plan' });
    capturePmTicket(db, { title: 'p2', intent: 'decide' });
    const agent = new PMAgent({ db });
    const r = await agent.tick();
    // scope:'open' + intent:'all' counts both non-execute cards.
    expect(r.ranked).toBeGreaterThanOrEqual(2);
    expect(r.errors).toEqual([]);
  });

  it('AC-A3 — un-stalls a card that was re-touched after being flagged', async () => {
    const now = 1_800_000_000_000;
    const cap = capturePmTicket(db, { title: 'stale then poked', intent: 'plan' });
    // Pre-stall it, but with a RECENT last_touched (user poked it just now).
    db.prepare(`UPDATE tasks SET stalled = 1, created_at = ?, entered_column_at = ?, last_touched = ? WHERE id = ?`)
      .run(now - 30 * DAY, now - 30 * DAY, now, cap.id);
    const agent = new PMAgent({ db, nowMs: now, stallMs: 14 * DAY });
    const r = await agent.tick();
    expect(r.stalled_cleared).toBe(1);
    const row = db.prepare(`SELECT stalled FROM tasks WHERE id = ?`).get(cap.id) as { stalled: number };
    expect(row.stalled).toBe(0);
  });
});
