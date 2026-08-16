/**
 * ADR-042 Stage 1 single-pass integration test.
 *
 * Load-bearing invariant: when WI_STAGE1_ENABLED=1, the SCOPE refiner
 * makes exactly ONE Anthropic call and never enters the multi-round
 * mini-loop that has been halting on the 60s wall-clock (documented
 * across sessions 18092+).
 *
 * Uses a hand-rolled mock Anthropic client. No network. Tests loop.ts
 * wiring only.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

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
import migrateV85 from '../../../src/db/migrations/v85_cypher_sessions_refined_goal.js';
import migrateV87 from '../../../src/db/migrations/v87_outcome_check_widen.js';
import migrateV89 from '../../../src/db/migrations/v89_cypher_steps_phase.js';

import { runLoop, type LoopOptions } from '../../../src/services/cypher/loop.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  );
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
  migrateV85(db);
  migrateV87(db);
  migrateV89(db);
  return db;
}

function seedSession(db: Database.Database, session_id: string): void {
  db.prepare(
    `INSERT INTO cypher_sessions (session_id, goal, user, status)
     VALUES (?, 'test goal', 'maaz', 'pending')`,
  ).run(session_id);
}

function baseOpts(
  db: Database.Database,
  session_id: string,
  client: Anthropic,
  overrides: Partial<LoopOptions> = {},
): LoopOptions {
  return {
    db,
    palace: null,
    goal: 'test goal',
    user: 'maaz',
    session_id,
    posture: 'generic',
    is_interactive: false,
    confirm_mode: 'auto',
    halt_flag: { value: false },
    phase: 'scope',
    anthropic_client: client,
    ...overrides,
  };
}

const VALID_REFINED_GOAL = {
  intent: 'investigate',
  target: 'the search-provider proxy',
  constraints: [],
  success_criteria: ['identifies the 401 root cause'],
  out_of_scope: [],
  linkage: { jira: [], prs: [], adrs: [], files: [] },
  expected_output_shape: 'brief',
  evidence_cited: [],
};

function buildMockClient(replyText: string) {
  const calls: Array<{ system: unknown; tools: unknown; messages: unknown }> = [];
  const create = vi.fn(async (params: Record<string, unknown>) => {
    calls.push({
      system: params.system,
      tools: params.tools,
      messages: params.messages,
    });
    return {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: 'claude-mock',
      content: [{ type: 'text', text: replyText }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  });
  const client = {
    beta: { promptCaching: { messages: { create } } },
  } as unknown as Anthropic;
  return { client, calls, create };
}

describe('ADR-042 Stage 1 single-pass — WI_STAGE1_ENABLED gate behaviour', () => {
  let db: Database.Database;
  let originalStage1: string | undefined;
  let originalRefinement: string | undefined;

  beforeEach(() => {
    db = freshDb();
    originalStage1 = process.env.WI_STAGE1_ENABLED;
    originalRefinement = process.env.CYPHER_REFINEMENT_ENABLED;
    // Enable the SCOPE phase entry-point so runLoop enters the SCOPE body.
    process.env.CYPHER_REFINEMENT_ENABLED = '1';
  });

  afterEach(() => {
    if (originalStage1 === undefined) delete process.env.WI_STAGE1_ENABLED;
    else process.env.WI_STAGE1_ENABLED = originalStage1;
    if (originalRefinement === undefined) delete process.env.CYPHER_REFINEMENT_ENABLED;
    else process.env.CYPHER_REFINEMENT_ENABLED = originalRefinement;
    db.close();
  });

  it('flag ON: single Anthropic call, refined_goal produced', async () => {
    process.env.WI_STAGE1_ENABLED = '1';
    const session_id = 'sess_stage1_on';
    seedSession(db, session_id);
    const { client, calls } = buildMockClient(JSON.stringify(VALID_REFINED_GOAL));

    const result = await runLoop(baseOpts(db, session_id, client, {
      goal: 'figure out why the search-provider proxy is returning 401',
      posture: 'bug-investigate',
      task_class: 'debug-issue',
    }));

    // Load-bearing invariant (updated 2026-07-15 for multi-intent classifier).
    // When Stage 1 is ON, we now expect at MOST 2 Anthropic calls:
    //   1) The multi-intent classifier (cheap, degrades gracefully)
    //   2) The main single-pass refiner call
    // The multi-round path would take up to CYPHER_SCOPE_MAX_ITERS (default 3)
    // extra rounds, so the invariant we care about is "≤2, not ≥3".
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // The MAIN refiner call (LAST one) must have tools:[] — recognition-only.
    expect(calls[calls.length - 1]!.tools).toEqual([]);
    // Stage 1 evidence block prepended to system prompt on the main call.
    const systemArr = calls[calls.length - 1]!.system as Array<{ text: string }>;
    expect(systemArr[0]!.text).toContain('Stage 1a evidence');

    expect(result.verdict).toBe('success');

    const row = db
      .prepare(`SELECT scope_iters, refined_goal FROM cypher_sessions WHERE session_id = ?`)
      .get(session_id) as { scope_iters: number; refined_goal: string } | undefined;
    expect(row?.scope_iters).toBe(1);
    expect(row?.refined_goal).toBeTruthy();
  });

  it('flag OFF: legacy multi-round path runs', async () => {
    delete process.env.WI_STAGE1_ENABLED;
    const session_id = 'sess_stage1_off';
    seedSession(db, session_id);
    const { client, calls } = buildMockClient(JSON.stringify(VALID_REFINED_GOAL));

    const result = await runLoop(baseOpts(db, session_id, client, {
      goal: 'figure out why the search-provider proxy is returning 401',
      posture: 'bug-investigate',
      task_class: 'debug-issue',
    }));

    // Legacy path: valid-JSON mock lets it exit after iter 1. Observable
    // distinction from single-pass is that here `tools` may be non-empty
    // (scope-eligible catalog); in single-pass it's ALWAYS [].
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(result.verdict).toBe('success');
  });

  it('flag ON + non-JSON response: halts with clarifying question, no retry', async () => {
    process.env.WI_STAGE1_ENABLED = '1';
    const session_id = 'sess_stage1_clarify';
    seedSession(db, session_id);
    const { client, create } = buildMockClient('What environment are you targeting?');

    const result = await runLoop(baseOpts(db, session_id, client, {
      goal: 'do the thing',
      posture: 'generic',
      task_class: 'generic',
    }));

    // ≤2 calls: 1 classifier + 1 main. Halt happens on the MAIN response,
    // no re-round beyond that.
    expect(create.mock.calls.length).toBeLessThanOrEqual(2);
    expect(create.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(result.verdict).toBe('halted');
    expect(result.surface).toContain('environment');
  });
});
