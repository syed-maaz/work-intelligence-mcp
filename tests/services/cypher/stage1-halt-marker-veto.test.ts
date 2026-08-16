/**
 * ADR-042 AC-U2 multi-intent halt-marker veto test.
 *
 * Real bug found in the 10-agent 2026-07-15 run: when the LLM emitted a
 * schema-valid refined_goal that ALSO carried self-declared halt markers
 * ("target: unspecified — clarifying-Q halt required" or
 *  "constraints: [compound goal must be split]"), the loop passed it
 * through instead of halting. Fix: veto brief when either marker present,
 * promote to clarify-question halt instead.
 *
 * Mocked Anthropic client — no live network.
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
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV52(db); migrateV59(db); migrateV60(db); migrateV61(db);
  migrateV62(db); migrateV63(db); migrateV64(db); migrateV65(db);
  migrateV66(db); migrateV67(db); migrateV70(db); migrateV71(db);
  migrateV74(db); migrateV85(db); migrateV87(db); migrateV89(db);
  return db;
}

function seed(db: Database.Database, session_id: string): void {
  db.prepare(
    `INSERT INTO cypher_sessions (session_id, goal, user, status) VALUES (?, 'test goal', 'maaz', 'pending')`,
  ).run(session_id);
}

function opts(
  db: Database.Database,
  session_id: string,
  client: Anthropic,
  goal = 'test goal',
): LoopOptions {
  return {
    db, palace: null, goal, user: 'maaz', session_id,
    posture: 'generic', is_interactive: false, confirm_mode: 'auto',
    halt_flag: { value: false }, phase: 'scope', anthropic_client: client,
  };
}

/**
 * Build a mock Anthropic client that returns a fixed JSON payload as text.
 * The single-pass path will pick it up as a refined_goal brief candidate.
 */
function mockClient(replyJson: unknown) {
  const create = vi.fn(async () => ({
    id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-mock',
    content: [{ type: 'text', text: JSON.stringify(replyJson) }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: {
      input_tokens: 100, output_tokens: 50,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    },
  }));
  const client = { beta: { promptCaching: { messages: { create } } } } as unknown as Anthropic;
  return { client, create };
}

const GOOD_BRIEF = {
  intent: 'investigate',
  target: 'DEMO-15702 the search-provider proxy 401',
  constraints: ['read-only investigation'],
  success_criteria: ['identify root cause'],
  out_of_scope: [],
  linkage: { jira: ['DEMO-15702'], prs: [], adrs: [], files: [] },
  expected_output_shape: 'rca',
  evidence_cited: [],
};

const HALT_TARGET_BRIEF = {
  ...GOOD_BRIEF,
  target: 'unspecified — clarifying-Q halt required',
};

const HALT_CONSTRAINTS_BRIEF = {
  ...GOOD_BRIEF,
  target: 'ambitious plan',
  constraints: ['compound goal must be split into single intents'],
};

const HALT_BOTH_BRIEF = {
  ...GOOD_BRIEF,
  target: 'unspecified',
  constraints: ['multi-intent detected', 'goal must be split'],
};

describe('ADR-042 AC-U2 multi-intent halt-marker veto', () => {
  let db: Database.Database;
  let orig: string | undefined;
  let origRef: string | undefined;

  beforeEach(() => {
    db = freshDb();
    orig = process.env.WI_STAGE1_ENABLED;
    origRef = process.env.CYPHER_REFINEMENT_ENABLED;
    process.env.WI_STAGE1_ENABLED = '1';
    process.env.CYPHER_REFINEMENT_ENABLED = '1';
  });

  afterEach(() => {
    if (orig === undefined) delete process.env.WI_STAGE1_ENABLED;
    else process.env.WI_STAGE1_ENABLED = orig;
    if (origRef === undefined) delete process.env.CYPHER_REFINEMENT_ENABLED;
    else process.env.CYPHER_REFINEMENT_ENABLED = origRef;
    db.close();
  });

  it('BASELINE: clean brief passes through as success (control)', async () => {
    const sid = 'sess_baseline';
    seed(db, sid);
    const { client } = mockClient(GOOD_BRIEF);
    const result = await runLoop(opts(db, sid, client));
    expect(result.verdict).toBe('success');
    const row = db.prepare(`SELECT refined_goal FROM cypher_sessions WHERE session_id=?`).get(sid) as { refined_goal: string };
    expect(row.refined_goal).toBeTruthy();
    expect(row.refined_goal).toContain('DEMO-15702');
  });

  it('VETO 1: target="unspecified — clarifying-Q halt required" → halt (not success)', async () => {
    const sid = 'sess_veto_target';
    seed(db, sid);
    const { client } = mockClient(HALT_TARGET_BRIEF);
    const result = await runLoop(opts(db, sid, client, 'do a thing'));
    expect(result.verdict).toBe('halted');
    expect(result.surface).toContain('compound or ambiguous');
    // refined_goal MUST NOT be persisted in this case — the whole point of the veto.
    const row = db.prepare(`SELECT refined_goal FROM cypher_sessions WHERE session_id=?`).get(sid) as { refined_goal: string | null };
    expect(row.refined_goal).toBeNull();
  });

  it('VETO 2: constraints contain "compound goal must be split" → halt', async () => {
    const sid = 'sess_veto_constraints';
    seed(db, sid);
    const { client } = mockClient(HALT_CONSTRAINTS_BRIEF);
    const result = await runLoop(opts(db, sid, client, 'investigate X and refactor Y and ship it'));
    expect(result.verdict).toBe('halted');
    expect(result.surface).toContain('compound or ambiguous');
    const row = db.prepare(`SELECT refined_goal FROM cypher_sessions WHERE session_id=?`).get(sid) as { refined_goal: string | null };
    expect(row.refined_goal).toBeNull();
  });

  it('VETO 3: both markers present → halt (defence in depth)', async () => {
    const sid = 'sess_veto_both';
    seed(db, sid);
    const { client } = mockClient(HALT_BOTH_BRIEF);
    const result = await runLoop(opts(db, sid, client, 'a compound multi-intent goal'));
    expect(result.verdict).toBe('halted');
    expect(result.surface).toContain('compound or ambiguous');
  });

  it('VETO 4: "multi-intent detected" in constraints → halt', async () => {
    const brief = { ...GOOD_BRIEF, constraints: ['multi-intent detected in goal'] };
    const sid = 'sess_veto_multi_intent';
    seed(db, sid);
    const { client } = mockClient(brief);
    const result = await runLoop(opts(db, sid, client));
    expect(result.verdict).toBe('halted');
  });

  it('NEGATIVE: legitimate "unspecified target format" phrase does NOT trigger veto (target starts differently)', async () => {
    const brief = {
      ...GOOD_BRIEF,
      target: 'DEMO-15702 — env unspecified but investigation is clear',
    };
    const sid = 'sess_neg_1';
    seed(db, sid);
    const { client } = mockClient(brief);
    const result = await runLoop(opts(db, sid, client));
    expect(result.verdict).toBe('success');
  });
});
