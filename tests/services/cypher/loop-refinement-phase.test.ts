/**
 * ADR-039 AC-7 / AC-16 / AC-20 — runLoop phase parameter + env-flag gate.
 *
 * These tests pin down the contract:
 *
 *   AC-7  — runLoop accepts a `phase` parameter. When omitted (or
 *           when CYPHER_REFINEMENT_ENABLED!=1), the loop runs its
 *           single-pass execute behavior, unchanged. When phase='scope'
 *           AND CYPHER_REFINEMENT_ENABLED=1, the loop enters the SCOPE
 *           entry point and returns verdict='halted' (the SCOPE body
 *           lands in a follow-up; this test verifies the entry-point
 *           contract is observable).
 *
 *   AC-16 — CYPHER_REFINEMENT_ENABLED gates SCOPE. Default off. The
 *           env var is re-read each runLoop call (no module-load
 *           caching), so mid-flight toggle works without restart.
 *
 *   AC-20 — Rollback safety: flipping CYPHER_REFINEMENT_ENABLED=0
 *           between dispatches reverts to single-pass on the NEXT
 *           dispatch.
 *
 * Mocking strategy: re-uses the fresh-DB fixture from loop.test.ts at a
 * bare minimum. The mock Anthropic client is only consulted in the
 * execute branch, so the SCOPE early-return tests never construct one.
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
import migrateV85 from '../../../src/db/migrations/v85_cypher_sessions_refined_goal.js';
import migrateV87 from '../../../src/db/migrations/v87_outcome_check_widen.js';

import {
  runLoop,
  isRefinementEnabled,
  type LoopOptions,
} from '../../../src/services/cypher/loop.js';

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
  overrides: Partial<LoopOptions> = {},
): LoopOptions {
  return {
    db,
    palace: null,
    goal: 'test goal',
    user: 'maaz',
    session_id,
    posture: 'generic',
    // confirm_mode='reject' short-circuits execute so SCOPE-tests that
    // accidentally fall through don't need a mock Anthropic client.
    confirm_mode: 'reject',
    is_interactive: false,
    halt_flag: { value: false },
    ...overrides,
  };
}

describe('ADR-039 AC-16 — isRefinementEnabled', () => {
  const originalEnv = process.env.CYPHER_REFINEMENT_ENABLED;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CYPHER_REFINEMENT_ENABLED;
    else process.env.CYPHER_REFINEMENT_ENABLED = originalEnv;
  });

  it('returns false when env var is unset (default off)', () => {
    delete process.env.CYPHER_REFINEMENT_ENABLED;
    expect(isRefinementEnabled()).toBe(false);
  });

  it('returns false for 0 / "true" / "yes" / "on" — strict 1 match only', () => {
    for (const v of ['0', 'true', 'yes', 'on', 'TRUE', '']) {
      process.env.CYPHER_REFINEMENT_ENABLED = v;
      expect(isRefinementEnabled()).toBe(false);
    }
  });

  it('returns true only when env var is exactly "1"', () => {
    process.env.CYPHER_REFINEMENT_ENABLED = '1';
    expect(isRefinementEnabled()).toBe(true);
  });
});

describe('ADR-039 AC-7 — runLoop phase parameter', () => {
  let db: Database.Database;
  const originalEnv = process.env.CYPHER_REFINEMENT_ENABLED;

  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
    if (originalEnv === undefined) delete process.env.CYPHER_REFINEMENT_ENABLED;
    else process.env.CYPHER_REFINEMENT_ENABLED = originalEnv;
  });

  it('AC-7: omitted phase + flag off → single-pass execute (unchanged)', async () => {
    delete process.env.CYPHER_REFINEMENT_ENABLED;
    seedSession(db, 'cyp_t8_a');
    const r = await runLoop(baseOpts(db, 'cyp_t8_a'));
    // confirm_mode='reject' short-circuits to rejected_non_interactive
    // — this is the existing behavior; the test asserts the SCOPE
    // branch did NOT fire (no 'halted' verdict from the substrate
    // surface message).
    expect(r.verdict).toBe('rejected_non_interactive');
    expect(r.surface).not.toMatch(/ADR-039 SCOPE phase/);
  });

  it('AC-7 + AC-16: phase=scope + flag=1 → SCOPE phase fires and exits with a brief on first iter', async () => {
    process.env.CYPHER_REFINEMENT_ENABLED = '1';
    seedSession(db, 'cyp_t8_b');
    // AC-7 commit 1 (2026-06-29): SCOPE phase now does real work. Stub
    // the Anthropic client so the refiner exits on iter 1 with a
    // valid brief (verdict='success').
    const brief = {
      intent: 'investigate',
      target: 'x',
      constraints: [],
      success_criteria: ['some criterion'],
      out_of_scope: [],
      linkage: { jira: [], prs: [], adrs: [], files: [] },
      expected_output_shape: 'rca',
      evidence_cited: [],
    };
    const stubClient = makeStubAnthropic([{ text: JSON.stringify(brief) }]);
    const r = await runLoop(
      baseOpts(db, 'cyp_t8_b', {
        phase: 'scope',
        anthropic_client: stubClient as never,
        confirm_mode: 'auto',
        is_interactive: true,
      }),
    );
    expect(r.verdict).toBe('success');
    expect(r.phase).toBe(1);
    expect(JSON.parse(r.surface)).toMatchObject({ intent: 'investigate' });
    // cypher_sessions row updated with phase=1 + refined_goal persisted
    const row = db
      .prepare(
        `SELECT phase, engine, refined_goal, scope_iters FROM cypher_sessions WHERE session_id = ?`,
      )
      .get('cyp_t8_b') as {
      phase: number;
      engine: string;
      refined_goal: string;
      scope_iters: number;
    };
    expect(row.phase).toBe(1);
    expect(row.engine).toBe('loop');
    expect(JSON.parse(row.refined_goal)).toMatchObject({ intent: 'investigate' });
    expect(row.scope_iters).toBe(1);
  });

  it('AC-20: phase=scope + flag=0 → falls back to execute (rollback safety)', async () => {
    process.env.CYPHER_REFINEMENT_ENABLED = '0';
    seedSession(db, 'cyp_t8_c');
    const r = await runLoop(baseOpts(db, 'cyp_t8_c', { phase: 'scope' }));
    // SCOPE entry point did NOT fire — fell back to execute (then
    // rejected_non_interactive because confirm_mode='reject').
    expect(r.verdict).toBe('rejected_non_interactive');
    expect(r.surface).not.toMatch(/ADR-039 SCOPE phase/);
  });

  it('AC-20: mid-flight flag flip (1→0) reverts on NEXT dispatch without restart', async () => {
    // First dispatch: flag on, scope phase fires with stubbed client →
    // success with a valid brief.
    process.env.CYPHER_REFINEMENT_ENABLED = '1';
    seedSession(db, 'cyp_t8_d1');
    const brief = {
      intent: 'investigate',
      target: 'x',
      constraints: [],
      success_criteria: ['c'],
      out_of_scope: [],
      linkage: { jira: [], prs: [], adrs: [], files: [] },
      expected_output_shape: 'rca',
      evidence_cited: [],
    };
    const stubClient = makeStubAnthropic([{ text: JSON.stringify(brief) }]);
    const r1 = await runLoop(
      baseOpts(db, 'cyp_t8_d1', {
        phase: 'scope',
        anthropic_client: stubClient as never,
        confirm_mode: 'auto',
        is_interactive: true,
      }),
    );
    expect(r1.verdict).toBe('success');
    expect(JSON.parse(r1.surface)).toMatchObject({ intent: 'investigate' });

    // Flip flag off mid-flight. Second dispatch must observe the flip
    // without any restart or module reload — scope path is bypassed
    // entirely and the loop falls through to the (rejected) execute
    // path because confirm_mode='reject' on the second baseOpts.
    process.env.CYPHER_REFINEMENT_ENABLED = '0';
    seedSession(db, 'cyp_t8_d2');
    const r2 = await runLoop(baseOpts(db, 'cyp_t8_d2', { phase: 'scope' }));
    expect(r2.verdict).toBe('rejected_non_interactive');
    expect(r2.surface).not.toMatch(/intent.*investigate/);
  });
});

/**
 * Lightweight Anthropic client stub for AC-7 tests. Returns the queued
 * sequence of text responses (one per messages.create call). Same
 * shape as the more thorough stub in ac7-scope-refiner.test.ts.
 */
function makeStubAnthropic(
  responses: Array<{ text: string }>,
): unknown {
  let i = 0;
  return {
    beta: {
      promptCaching: {
        messages: {
          create: () => {
            const r = responses[i++] ?? responses[responses.length - 1];
            return Promise.resolve({
              content: r.text ? [{ type: 'text', text: r.text }] : [],
              stop_reason: 'end_turn',
              usage: {
                input_tokens: 50,
                output_tokens: 25,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            });
          },
        },
      },
    },
  };
}
