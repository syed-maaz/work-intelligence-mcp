/**
 * Regression test for the 2026-06-24 loop.ts:624 fix.
 *
 * The bug: pre-fix, `snapshotPriors` was called once at dispatch entry
 * with an empty plan_shape_hash. Since the hash is only knowable AFTER
 * the loop runs (computed from the actual tool invocation sequence),
 * every dispatch wrote `prior_count=0, prior_success_rate=NULL` to
 * `cypher_sessions`, regardless of how many prior dispatches with the
 * same shape existed. 737/737 production sessions had `prior_count=0`
 * at the time of the fix. The loop's posterior signal was broken-on-read.
 *
 * The fix: call `snapshotPriors` again post-loop with the just-computed
 * `planHash`, write the authoritative values into both the LoopResult
 * and the `cypher_sessions` row. The dispatch-entry placeholder still
 * fires (so the session row has zeros during the loop's execution); the
 * post-loop write replaces them.
 *
 * This test proves: when a prior `cypher_sessions` row exists for the
 * same user + plan_shape_hash with a successful outcome, a fresh
 * dispatch with the same shape surfaces `prior_count >= 1` and a
 * non-null `prior_success_rate`. Pre-fix this test would have failed
 * (both fields would be 0 / null).
 *
 * Context: .planning/audits/2026-06-24-adr-037-5-audit.md F2 +
 * .planning/cap-13-redesign/SYNTHESIS.md "Fix loop.ts:624" section.
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

import { runLoop, planShapeHash } from '../../../src/services/cypher/loop.js';
import type { LoopOptions } from '../../../src/services/cypher/loop.js';
import type { ToolDefinition, Posture } from '../../../src/services/cypher/tool-catalog.js';

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
  // ADR-038 v2.5 D8 substrate (subset).
  migrateV70(db);   // failure_pattern column
  migrateV71(db);   // posture column
  migrateV74(db);   // self_assess_at_entry column
  return db;
}

function seedSession(db: Database.Database, session_id: string, user = 'maaz'): void {
  db.prepare(
    `INSERT INTO cypher_sessions (session_id, goal, user, status)
     VALUES (?, 'test goal', ?, 'pending')`,
  ).run(session_id, user);
}

function seedCompletedSession(
  db: Database.Database,
  session_id: string,
  user: string,
  plan_shape_hash: string,
  outcome: 'success' | 'mixed' | 'failed',
): void {
  db.prepare(
    `INSERT INTO cypher_sessions (session_id, goal, user, status, outcome, plan_shape_hash)
     VALUES (?, 'historical goal', ?, 'done', ?, ?)`,
  ).run(session_id, user, outcome, plan_shape_hash);
}

// Minimal Anthropic mock — same shape as loop.test.ts buildMockClient.
function buildMockClient(scripts: Array<{ text?: string; tool_uses?: Array<{ id: string; name: string; input: Record<string, unknown> }>; }>): Anthropic {
  const queue = [...scripts];
  const create = vi.fn(async () => {
    const next = queue.shift();
    if (!next) {
      return {
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    }
    const content: unknown[] = [];
    if (next.text) content.push({ type: 'text', text: next.text });
    for (const tu of next.tool_uses ?? []) {
      content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    }
    return {
      content,
      stop_reason: next.tool_uses && next.tool_uses.length > 0 ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
  });
  return { beta: { promptCaching: { messages: { create } } } } as unknown as Anthropic;
}

// Local tool-catalog stub. Same monkey-patch pattern as loop.test.ts.
async function withTestCatalog<T>(
  defs: ToolDefinition[],
  fn: () => Promise<T>,
): Promise<T> {
  const mod = await import('../../../src/services/cypher/tool-catalog.js');
  const original = [...mod.TOOL_CATALOG];
  mod.TOOL_CATALOG.length = 0;
  for (const d of defs) mod.TOOL_CATALOG.push(d);
  try {
    return await fn();
  } finally {
    mod.TOOL_CATALOG.length = 0;
    for (const d of original) mod.TOOL_CATALOG.push(d);
  }
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
    posture: 'generic' as Posture,
    confirm_mode: 'auto',
    is_interactive: true,
    halt_flag: { value: false },
    anthropic_client: buildMockClient([{ text: 'done' }]),
    ...overrides,
  };
}

describe('loop.ts:624 fix — authoritative posterior post-loop', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('cold-start dispatch (no prior history) writes prior_count=0 to cypher_sessions', async () => {
    seedSession(db, 'cyp_cold');
    const result = await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () => runLoop(baseOpts(db, 'cyp_cold')),
    );
    expect(result.prior_count).toBe(0);
    expect(result.prior_success_rate).toBeNull();
    const row = db
      .prepare(`SELECT prior_count, prior_success_rate FROM cypher_sessions WHERE session_id = ?`)
      .get('cyp_cold') as { prior_count: number; prior_success_rate: number | null };
    expect(row.prior_count).toBe(0);
    expect(row.prior_success_rate).toBeNull();
  });

  it('surfaces prior_count > 0 when a previous session with the same plan_shape_hash exists', async () => {
    // The shape we will produce: posture='generic' with no tool calls →
    // planShapeHash('generic', []). Pre-seed a historical successful session
    // at that shape.
    const expectedHash = planShapeHash('generic', []);
    seedCompletedSession(db, 'cyp_prior_1', 'maaz', expectedHash, 'success');

    seedSession(db, 'cyp_fresh');
    const result = await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () => runLoop(baseOpts(db, 'cyp_fresh')),
    );

    // The loop ran with the same shape (no tool calls + posture='generic').
    // Post-fix: it should see the 1 prior successful session at this shape.
    expect(result.plan_shape_hash).toBe(expectedHash);
    expect(result.prior_count).toBe(1);
    expect(result.prior_success_rate).toBe(1.0);

    const row = db
      .prepare(`SELECT prior_count, prior_success_rate FROM cypher_sessions WHERE session_id = ?`)
      .get('cyp_fresh') as { prior_count: number; prior_success_rate: number | null };
    expect(row.prior_count).toBe(1);
    expect(row.prior_success_rate).toBe(1.0);
  });

  it('mixed prior history reports the right success rate', async () => {
    const expectedHash = planShapeHash('generic', []);
    // 2 successes, 1 failed, 1 mixed = 4 total, all "succeeded" per the
    // outcome IN ('success', 'mixed', 'failed') filter (success=count
    // as success in the rate is only 'success' rows per snapshotPriors).
    seedCompletedSession(db, 'cyp_p1', 'maaz', expectedHash, 'success');
    seedCompletedSession(db, 'cyp_p2', 'maaz', expectedHash, 'success');
    seedCompletedSession(db, 'cyp_p3', 'maaz', expectedHash, 'failed');
    seedCompletedSession(db, 'cyp_p4', 'maaz', expectedHash, 'mixed');

    seedSession(db, 'cyp_fresh');
    const result = await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () => runLoop(baseOpts(db, 'cyp_fresh')),
    );

    expect(result.prior_count).toBe(4);
    expect(result.prior_success_rate).toBe(0.5); // 2 successes / 4 total
  });

  it('does NOT count prior sessions from a different user', async () => {
    const expectedHash = planShapeHash('generic', []);
    seedCompletedSession(db, 'cyp_other_user', 'someone-else', expectedHash, 'success');

    seedSession(db, 'cyp_fresh');
    const result = await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () => runLoop(baseOpts(db, 'cyp_fresh')),
    );

    expect(result.prior_count).toBe(0);
    expect(result.prior_success_rate).toBeNull();
  });

  it('does NOT count prior sessions with a different plan_shape_hash', async () => {
    // Seed at a DIFFERENT shape (posture='pr-review' instead of 'generic').
    const differentHash = planShapeHash('pr-review', []);
    seedCompletedSession(db, 'cyp_diff_shape', 'maaz', differentHash, 'success');

    seedSession(db, 'cyp_fresh');
    const result = await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () => runLoop(baseOpts(db, 'cyp_fresh')),
    );

    expect(result.prior_count).toBe(0);
    expect(result.prior_success_rate).toBeNull();
  });

  it('the LoopResult exposes the same prior_count as cypher_sessions persists', async () => {
    // Invariant: result.prior_count === SELECT prior_count FROM cypher_sessions
    // after the loop completes. Pre-fix, the result carried the placeholder
    // (always 0) while the session row also held 0 — but they agreed via
    // both being broken. Post-fix, both reflect the authoritative read.
    const expectedHash = planShapeHash('generic', []);
    seedCompletedSession(db, 'cyp_seed', 'maaz', expectedHash, 'success');
    seedCompletedSession(db, 'cyp_seed2', 'maaz', expectedHash, 'failed');

    seedSession(db, 'cyp_fresh');
    const result = await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () => runLoop(baseOpts(db, 'cyp_fresh')),
    );

    const row = db
      .prepare(`SELECT prior_count, prior_success_rate FROM cypher_sessions WHERE session_id = ?`)
      .get('cyp_fresh') as { prior_count: number; prior_success_rate: number | null };

    expect(result.prior_count).toBe(row.prior_count);
    expect(result.prior_success_rate).toBe(row.prior_success_rate);
    // And both should be non-trivial.
    expect(result.prior_count).toBe(2);
    expect(result.prior_success_rate).toBe(0.5);
  });
});
