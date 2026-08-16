/**
 * ADR-043 Phase 3 AC-A1 — end-to-end wiring regression.
 *
 * Locks the contract that a session closed `outcome='captured_to_board'`
 * MUST link to a real `tasks` row via `cypher_sessions.task_id`.
 *
 * Failure mode this test guards against: the 2026-07-17 silent-fail bug
 * where 3 sessions closed captured_to_board with `task_id IS NULL` and
 * the `tasks` table held zero rows with a non-execute intent — the AC-A1
 * surface string was emitted, but no card actually landed on the board.
 * Root cause: `LoopResult` had no `task_id` slot, so `captureToBoard()`'s
 * return dropped on the floor; `persistOutcome()` never wrote task_id.
 *
 * This test exercises the real modules (pm-capture-hook + persistOutcome)
 * end to end against an in-memory sqlite instance seeded from v52 → v100.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import migrateV52 from '../../../src/db/migrations/v52_model_config.js';
import migrateV59 from '../../../src/db/migrations/v59_cypher_tables.js';
import migrateV60 from '../../../src/db/migrations/v60_cypher_pm.js';
import migrateV61 from '../../../src/db/migrations/v61_pm_auto_actions.js';
import migrateV62 from '../../../src/db/migrations/v62_skill_actually_invoked.js';
import migrateV63 from '../../../src/db/migrations/v63_skill_catalog.js';
import migrateV64 from '../../../src/db/migrations/v64_cypher_outcomes.js';
import migrateV65 from '../../../src/db/migrations/v65_cypher_outcomes_legacy_upgrade.js';
import migrateV66 from '../../../src/db/migrations/v66_cap13_birth_decisions.js';
import migrateV67 from '../../../src/db/migrations/v67_cypher_loop_columns.js';
import migrateV70 from '../../../src/db/migrations/v70_cypher_outcomes_failure_pattern.js';
import migrateV71 from '../../../src/db/migrations/v71_cypher_sessions_posture.js';
import migrateV74 from '../../../src/db/migrations/v74_cypher_sessions_self_assess_at_entry.js';
import migrateV75 from '../../../src/db/migrations/v75_d2_task_memory.js';
import migrateV76 from '../../../src/db/migrations/v76_d3_projects_table.js';
import migrateV77 from '../../../src/db/migrations/v77_d3_tasks_project_fk.js';
import migrateV78 from '../../../src/db/migrations/v78_d3_repair_task_history_fk.js';
import migrateV79 from '../../../src/db/migrations/v79_d3_repair_cypher_sessions_task_id_fk.js';
import migrateV81 from '../../../src/db/migrations/v81_d19_recurate_pending.js';
import migrateV85 from '../../../src/db/migrations/v85_cypher_sessions_refined_goal.js';
import migrateV87 from '../../../src/db/migrations/v87_outcome_check_widen.js';
import migrateV90 from '../../../src/db/migrations/v90_adr040_tasks_kanban.js';
import migrateV91 from '../../../src/db/migrations/v91_adr040_outcome_evidence.js';
import migrateV92 from '../../../src/db/migrations/v92_adr040_subagent_dispatches.js';
import migrateV93 from '../../../src/db/migrations/v93_adr040_interaction_tokens.js';
import migrateV94 from '../../../src/db/migrations/v94_adr040_card_number.js';
import migrateV95 from '../../../src/db/migrations/v95_adr040_card_comments.js';
import migrateV97 from '../../../src/db/migrations/v97_adr040_task_stalled.js';
import migrateV98 from '../../../src/db/migrations/v98_prompt_memory.js';
import migrateV99 from '../../../src/db/migrations/v99_adr043_pm_layer.js';
import migrateV100 from '../../../src/db/migrations/v100_captured_to_board_outcome.js';

import { shouldCaptureToBoard, captureToBoard } from '../../../src/services/cypher/pm-capture-hook.js';
import { persistOutcome, type LoopResult } from '../../../src/services/cypher/loop.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  );
  // Migration sequence mirrors tests/board/pm-phase3.test.ts (proven fixture for
  // capturePmTicket + captureToBoard against v100). Extra migrations added
  // (v60-v67, v70-v74) so cypher_sessions has the shape persistOutcome expects
  // (posture, self_assess_at_entry, etc.) and so recordOutcomeSignal can write.
  migrateV52(db);
  migrateV59(db);
  migrateV60(db);
  migrateV61(db);
  migrateV62(db);
  migrateV63(db);
  migrateV64(db);
  migrateV65(db);
  migrateV66(db);
  migrateV67(db);
  migrateV70(db);
  migrateV71(db);
  migrateV74(db);
  migrateV75(db);
  migrateV76(db);
  migrateV77(db);
  migrateV78(db);
  migrateV79(db);
  migrateV81(db);
  migrateV85(db);
  migrateV87(db);
  migrateV90(db);
  migrateV91(db);
  migrateV92(db);
  migrateV93(db);
  migrateV94(db);
  migrateV95(db);
  migrateV97(db);
  migrateV98(db);
  migrateV99(db);
  migrateV100(db);
  return db;
}

function seedSession(db: Database.Database, session_id: string, goal: string, refined_goal: unknown): void {
  db.prepare(
    `INSERT INTO cypher_sessions (session_id, goal, user, status, refined_goal)
     VALUES (?, ?, 'test-user', 'pending', ?)`,
  ).run(session_id, goal, JSON.stringify(refined_goal));
}

describe('AC-A1 capture — end-to-end wiring (ADR-043 Phase 3)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
    process.env.WI_STAGE1_ENABLED = '1';
    process.env.PM_ORCHESTRATION_ENABLED = '1';
  });

  afterEach(() => {
    delete process.env.WI_STAGE1_ENABLED;
    delete process.env.PM_ORCHESTRATION_ENABLED;
    db.close();
  });

  it('captured_to_board session MUST link to a real tasks row', () => {
    const sessionId = 'cyp_test_capture_wiring';
    const goal = 'plan the smoke-outcome test suite rollout';
    const refined = {
      intent: 'plan',
      target: 'smoke-outcome test suite rollout',
      constraints: [],
      success_criteria: [],
    };
    seedSession(db, sessionId, goal, refined);

    // ── Exercise the real hook path ─────────────────────────────────────
    const refinedJson = JSON.stringify(refined);
    const decision = shouldCaptureToBoard(refinedJson, goal);
    expect(decision).not.toBeNull();
    expect(decision!.intent).toBe('plan');

    const cap = captureToBoard(db, decision!);
    expect(cap.task_id).toMatch(/^tsk_/);

    // Build the LoopResult exactly as loop.ts does on the captured branch.
    const result: LoopResult = {
      verdict: 'captured_to_board',
      surface: cap.surface,
      session_id: sessionId,
      phase: 1,
      plan_shape_hash: '',
      prior_count: 0,
      prior_success_rate: null,
      confirm_mode_used: 'auto',
      engine: 'loop',
      tool_calls: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
      duration_ms: 42,
      task_id: cap.task_id,
      card_number: cap.card_number,
    };

    persistOutcome(db, sessionId, result, 'test-user');

    // ── Load-bearing assertion #1: task_id round-trips to cypher_sessions.
    const sess = db
      .prepare(`SELECT task_id, outcome, status FROM cypher_sessions WHERE session_id = ?`)
      .get(sessionId) as { task_id: string | null; outcome: string; status: string };
    expect(sess).toBeTruthy();
    expect(sess.status).toBe('done');
    expect(sess.outcome).toBe('captured_to_board');
    expect(sess.task_id).toMatch(/^tsk_/); // ← the regression guard

    // ── Load-bearing assertion #2: the tasks row exists with the right shape.
    const task = db
      .prepare(`SELECT id, intent, kanban_column FROM tasks WHERE id = ?`)
      .get(sess.task_id) as { id: string; intent: string; kanban_column: string } | undefined;
    expect(task).toBeTruthy();
    expect(task!.intent).toBe('plan');
    expect(task!.kanban_column).toBe('ready');
  });

  it('preserves an existing task_id (COALESCE guard) when persistOutcome runs on a mid-session capture', () => {
    // AC-A2 case: a task_id was set at session start (parent link), the
    // captured card is a follow-up. persistOutcome must NOT overwrite the
    // parent link on non-null result.task_id.
    const sessionId = 'cyp_test_capture_coalesce';
    const goal = 'decide caching strategy for search-provider tokens';
    const refined = { intent: 'decide', target: 'search-provider token cache strategy' };
    seedSession(db, sessionId, goal, refined);

    // Pre-existing parent task on the session.
    db.prepare(`INSERT INTO projects(id, name, created_at) VALUES ('wi','wi',0) ON CONFLICT DO NOTHING`).run();
    const parentIns = db.prepare(
      `INSERT INTO tasks (id, title, posture, status, project, owner_user_id, created_at, last_touched)
       VALUES ('tsk_parent000', 'parent', 'pm', 'open', 'wi', 'test-user', 0, 0)`,
    );
    parentIns.run();
    db.prepare(`UPDATE cypher_sessions SET task_id = 'tsk_parent000' WHERE session_id = ?`).run(sessionId);

    const decision = shouldCaptureToBoard(JSON.stringify(refined), goal);
    expect(decision).not.toBeNull();
    const cap = captureToBoard(db, decision!, 'tsk_parent000');

    const result: LoopResult = {
      verdict: 'captured_to_board',
      surface: cap.surface,
      session_id: sessionId,
      phase: 1,
      plan_shape_hash: '',
      prior_count: 0,
      prior_success_rate: null,
      confirm_mode_used: 'auto',
      engine: 'loop',
      tool_calls: [],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      duration_ms: 42,
      task_id: cap.task_id,
      card_number: cap.card_number,
    };
    persistOutcome(db, sessionId, result, 'test-user');

    // Existing parent task_id survives — COALESCE preserves it.
    const sess = db
      .prepare(`SELECT task_id FROM cypher_sessions WHERE session_id = ?`)
      .get(sessionId) as { task_id: string };
    expect(sess.task_id).toBe('tsk_parent000');
  });
});
