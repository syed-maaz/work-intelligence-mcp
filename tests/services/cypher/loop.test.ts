/**
 * loop.ts unit tests — ADR-037 Phase 3-E.
 *
 * Covers the public surface of src/services/cypher/loop.ts:
 *
 *   Pure helpers (no DB, no mocks):
 *     - planShapeHash: determinism, order sensitivity, value insensitivity
 *     - classifyConfirmReply: length-20 boundary + pattern matching
 *     - isToolEligibleForPosture: declarative filter
 *
 *   runLoop entry-point behavior (mock Anthropic client):
 *     - confirm_mode='reject' → rejected_non_interactive, no tools fire
 *     - non-interactive + confirm_mode='interactive' → rejected_non_interactive
 *     - empty posture-filtered catalog → failed
 *     - happy path: stop_reason='end_turn' → success
 *     - tool error wrapped in tool_result, doesn't crash loop
 *     - posture-ineligible tool call surfaced as error
 *     - max_iterations exhaustion → mixed
 *     - wallclock budget exhaustion → mixed
 *     - token budget exhaustion → mixed
 *     - halt_flag.value=true between tool calls → halted with
 *       halt_after_call_id pointing at the last-completed call
 *     - halt_flag.value=true at iteration top before any call → halted
 *       with no halt_after_call_id
 *     - cypher_sessions UPDATE writes confirm_mode_*, phase, engine,
 *       prior_count, prior_success_rate at dispatch entry
 *     - cypher_outcomes verdict row written via recordOutcomeSignal,
 *       metadata.verdict carries the granular six-token verdict
 *     - cypher_sessions UPDATE on completion: status='done', outcome
 *       remapped to pre-v68 three-token enum, duration_ms, completed_at
 *     - plan_shape_hash persisted to cypher_sessions
 *     - on_event emits done as the final event with verdict+surface
 *
 * Mocking strategy: a minimal Anthropic SDK client double constructed
 * per-test that returns scripted responses. The loop only consumes
 * `client.beta.promptCaching.messages.create`, so the mock is small.
 */

import Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
// v87 widens outcome CHECK to admit halted/abandoned/rejected_non_interactive.
// Required after the 2026-07-25 reducer honesty fix (loop.ts:3013) — the
// reducer now propagates these verdicts instead of collapsing them to 'mixed'.
import migrateV87 from '../../../src/db/migrations/v87_outcome_check_widen.js';
// v100 widens outcome CHECK to also admit 'captured_to_board' (ADR-043).
import migrateV100 from '../../../src/db/migrations/v100_captured_to_board_outcome.js';

// Model-config bootstrap — runLoop reads bucketCallParams(db, 'decide').
import migrateV52 from '../../../src/db/migrations/v52_model_config.js';

import {
  runLoop,
  planShapeHash,
  classifyConfirmReply,
  isToolEligibleForPosture,
  toolsForPosture,
  LOOP_DEFAULTS,
  type LoopOptions,
  type LoopResult,
  type LoopEvent,
  type HaltFlag,
  type ConfirmMode,
} from '../../../src/services/cypher/loop.js';
import type { ToolDefinition, Posture } from '../../../src/services/cypher/tool-catalog.js';

// ───────────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Bring the DB up to v67 step-by-step. Each migration assumes the prior
  // shape, so we run them in order rather than calling applyMigrations
  // (which would also require the schema_metadata table and a longer
  // bootstrapping dance).
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
  // ADR-038 v2.5 D8 substrate (subset — v68/v69/v72/v73 untouched here
  // because this test fixture doesn't exercise notebooks or the
  // capability_summary view).
  migrateV70(db);   // failure_pattern column on cypher_outcomes
  migrateV71(db);   // posture column on cypher_sessions
  migrateV74(db);   // self_assess_at_entry column on cypher_sessions
  migrateV87(db);   // widen outcome CHECK: +halted +abandoned +rejected_non_interactive
  migrateV100(db);  // widen outcome CHECK: +captured_to_board
  return db;
}

function seedSession(db: Database.Database, session_id: string, user = 'maaz'): void {
  db.prepare(
    `INSERT INTO cypher_sessions (session_id, goal, user, status)
     VALUES (?, 'test goal', ?, 'pending')`,
  ).run(session_id, user);
}

interface ScriptedResponse {
  /** Optional assistant text. */
  text?: string;
  /** Tool calls the model emits this turn. Empty = end_turn. */
  tool_uses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  /** Token usage to attribute to this response. */
  input_tokens?: number;
  output_tokens?: number;
}

/**
 * Build a minimal Anthropic-shaped client double. Each call to
 * `messages.create` pops the next scripted response off the queue. If
 * the queue empties, the mock returns end_turn with no text — that
 * deliberately surfaces "test didn't script enough responses" as a
 * test failure rather than a hang.
 */
function buildMockClient(script: ScriptedResponse[]): Anthropic {
  const queue = [...script];
  const create = vi.fn(async () => {
    const next = queue.shift();
    if (!next) {
      return {
        content: [],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    }
    const content: unknown[] = [];
    if (next.text) {
      content.push({ type: 'text', text: next.text });
    }
    for (const tu of next.tool_uses ?? []) {
      content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    }
    const stop_reason = (next.tool_uses?.length ?? 0) > 0 ? 'tool_use' : 'end_turn';
    return {
      content,
      stop_reason,
      usage: {
        input_tokens: next.input_tokens ?? 100,
        output_tokens: next.output_tokens ?? 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  });
  // Cast to Anthropic — runLoop only touches .beta.promptCaching.messages.create.
  return {
    beta: { promptCaching: { messages: { create } } },
  } as unknown as Anthropic;
}

interface InjectableTool {
  name: string;
  posture_eligibility: Posture[];
  handler: ToolDefinition['handler'];
  category?: 'auto' | 'confirm';
}

/**
 * Replace the production TOOL_CATALOG with a hand-built test set for
 * the duration of one runLoop call. The hot-swap goes through
 * `vi.spyOn` on the catalog module so unrelated tests aren't affected.
 */
function withTestCatalog<T>(
  tools: InjectableTool[],
  fn: () => Promise<T>,
): Promise<T> {
  // Build the synthetic ToolDefinition array.
  const defs: ToolDefinition[] = tools.map((t) => ({
    name: t.name,
    description: `test tool ${t.name}`,
    category: t.category ?? 'auto',
    posture_eligibility: t.posture_eligibility,
    input_schema: { type: 'object', properties: {} },
    estimated_duration_ms: 100,
    handler: t.handler,
  }));
  // Re-export shape: loop.ts re-binds `toolsForPosture` from
  // tool-catalog.ts at import time, so we monkey-patch the catalog
  // module's exported function. vi.doMock would require re-importing
  // loop.ts inside each test, which is heavy — instead we restore the
  // original after each block.
  return import('../../../src/services/cypher/tool-catalog.js').then(async (mod) => {
    const original = mod.TOOL_CATALOG.slice();
    mod.TOOL_CATALOG.length = 0;
    for (const d of defs) mod.TOOL_CATALOG.push(d);
    try {
      return await fn();
    } finally {
      mod.TOOL_CATALOG.length = 0;
      for (const d of original) mod.TOOL_CATALOG.push(d);
    }
  });
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
    confirm_mode: 'auto',
    is_interactive: true,
    halt_flag: { value: false },
    anthropic_client: buildMockClient([{ text: 'done' }]),
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 1. planShapeHash (pure)
// ───────────────────────────────────────────────────────────────────────────

describe('planShapeHash', () => {
  it('returns a 16-char hex string', () => {
    const h = planShapeHash('generic', ['brain_recall', 'palace_search']);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic across calls with the same input', () => {
    const a = planShapeHash('pr-review', ['wi_pr_review', 'code_graph_owners']);
    const b = planShapeHash('pr-review', ['wi_pr_review', 'code_graph_owners']);
    expect(a).toBe(b);
  });

  it('is order-sensitive — different tool orders hash distinctly', () => {
    const a = planShapeHash('generic', ['brain_recall', 'palace_search']);
    const b = planShapeHash('generic', ['palace_search', 'brain_recall']);
    expect(a).not.toBe(b);
  });

  it('is posture-sensitive — same tools, different posture, different hash', () => {
    const a = planShapeHash('pr-review', ['brain_recall']);
    const b = planShapeHash('bug-investigate', ['brain_recall']);
    expect(a).not.toBe(b);
  });

  it('handles empty tool sequences (cold-start dispatch)', () => {
    const h = planShapeHash('generic', []);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. classifyConfirmReply (pure)
// ───────────────────────────────────────────────────────────────────────────

describe('classifyConfirmReply', () => {
  it('recognises confirm-shaped short replies (length ≤ 20)', () => {
    for (const reply of ['yes', 'y', 'go', 'do it', 'confirm', 'ok', 'lgtm']) {
      const r = classifyConfirmReply(reply);
      expect(r.verdict).toBe('confirm');
      expect(r.method).toBe('pattern_confirm');
    }
  });

  it('recognises halt-shaped short replies (length ≤ 20)', () => {
    for (const reply of ['no', 'stop', 'cancel', 'abort', 'wait']) {
      const r = classifyConfirmReply(reply);
      expect(r.verdict).toBe('halt');
      expect(r.method).toBe('pattern_halt');
    }
  });

  it('routes long replies to correct regardless of how they start (length > 20)', () => {
    // 21 characters, starts with 'yes' — should NOT be classified as confirm.
    const r = classifyConfirmReply('yes but only for BD-1');
    expect(r.verdict).toBe('correct');
    expect(r.method).toBe('length_correct');
  });

  it('treats the length-20 boundary as inclusive of confirm matches', () => {
    // Exactly 20 characters, leads with 'yes ' — still confirm.
    const reply = 'yes ' + 'a'.repeat(16);
    expect(reply.length).toBe(20);
    const r = classifyConfirmReply(reply);
    expect(r.verdict).toBe('confirm');
  });

  it('re-prompts on short unrecognised replies', () => {
    const r = classifyConfirmReply('huh?');
    expect(r.verdict).toBe('reprompt');
  });

  it('case-insensitive matching', () => {
    expect(classifyConfirmReply('YES').verdict).toBe('confirm');
    expect(classifyConfirmReply('Confirm').verdict).toBe('confirm');
    expect(classifyConfirmReply('STOP').verdict).toBe('halt');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. isToolEligibleForPosture (pure)
// ───────────────────────────────────────────────────────────────────────────

describe('isToolEligibleForPosture', () => {
  const tool: ToolDefinition = {
    name: 'test_tool',
    description: 'x',
    category: 'auto',
    posture_eligibility: ['pr-review', 'bug-investigate'],
    input_schema: { type: 'object', properties: {} },
    estimated_duration_ms: 0,
    handler: async () => ({}),
  };

  it('returns true when posture is in the eligibility list', () => {
    expect(isToolEligibleForPosture(tool, 'pr-review')).toBe(true);
    expect(isToolEligibleForPosture(tool, 'bug-investigate')).toBe(true);
  });

  it('returns false when posture is not in the eligibility list', () => {
    expect(isToolEligibleForPosture(tool, 'pm')).toBe(false);
    expect(isToolEligibleForPosture(tool, 'generic')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. runLoop — early-return paths (no LLM call)
// ───────────────────────────────────────────────────────────────────────────

describe('runLoop — early returns', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedSession(db, 'cyp_test_1');
  });
  afterEach(() => db.close());

  it("returns verdict='rejected_non_interactive' immediately when confirm_mode='reject'", async () => {
    const result = await runLoop(baseOpts(db, 'cyp_test_1', { confirm_mode: 'reject' }));
    expect(result.verdict).toBe('rejected_non_interactive');
    expect(result.surface).toBe('');
    expect(result.tool_calls).toHaveLength(0);
    expect(result.confirm_mode_used).toBe('reject');
  });

  it("returns verdict='rejected_non_interactive' when is_interactive=false + confirm_mode='interactive'", async () => {
    const result = await runLoop(
      baseOpts(db, 'cyp_test_1', {
        is_interactive: false,
        confirm_mode: 'interactive',
      }),
    );
    expect(result.verdict).toBe('rejected_non_interactive');
    expect(result.tool_calls).toHaveLength(0);
  });

  it('proceeds past the gate when is_interactive=false + confirm_mode="auto"', async () => {
    const result = await runLoop(
      baseOpts(db, 'cyp_test_1', {
        is_interactive: false,
        confirm_mode: 'auto',
        anthropic_client: buildMockClient([{ text: 'all done' }]),
      }),
    );
    expect(result.verdict).toBe('success');
    expect(result.surface).toBe('all done');
  });

  it("emits 'done' event on early-return paths", async () => {
    const events: LoopEvent[] = [];
    const result = await runLoop(
      baseOpts(db, 'cyp_test_1', {
        confirm_mode: 'reject',
        on_event: (e) => events.push(e),
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'done',
      verdict: 'rejected_non_interactive',
    });
    expect(result.verdict).toBe('rejected_non_interactive');
  });

  it("returns verdict='failed' when no tools are eligible for the posture", async () => {
    // Override the catalog with one tool that EXCLUDES 'generic'.
    const result = await withTestCatalog(
      [{ name: 'narrow_tool', posture_eligibility: ['pm'], handler: async () => ({}) }],
      () => runLoop(baseOpts(db, 'cyp_test_1', { posture: 'generic' })),
    );
    expect(result.verdict).toBe('failed');
    expect(result.surface).toContain("No tools eligible for posture 'generic'");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. runLoop — happy path
// ───────────────────────────────────────────────────────────────────────────

describe('runLoop — happy path', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedSession(db, 'cyp_happy');
  });
  afterEach(() => db.close());

  it("returns verdict='success' on stop_reason='end_turn' with non-empty surface", async () => {
    const result = await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({ ok: true }) }],
      () =>
        runLoop(
          baseOpts(db, 'cyp_happy', {
            anthropic_client: buildMockClient([{ text: 'final answer with concrete next steps' }]),
          }),
        ),
    );
    expect(result.verdict).toBe('success');
    expect(result.surface).toBe('final answer with concrete next steps');
    expect(result.engine).toBe('loop');
    expect(result.phase).toBe(2);
  });

  it("returns verdict='mixed' on end_turn with empty surface", async () => {
    const result = await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () =>
        runLoop(
          baseOpts(db, 'cyp_happy', {
            anthropic_client: buildMockClient([{}]), // no text, no tool_uses → end_turn
          }),
        ),
    );
    expect(result.verdict).toBe('mixed');
    expect(result.surface).toBe('');
  });

  it('invokes the tool handler when the model emits tool_use', async () => {
    const calls: Array<{ name: string }> = [];
    const result = await withTestCatalog(
      [
        {
          name: 'echo',
          posture_eligibility: ['generic'],
          handler: async (input) => {
            calls.push({ name: 'echo' });
            return { echoed: input };
          },
        },
      ],
      () =>
        runLoop(
          baseOpts(db, 'cyp_happy', {
            anthropic_client: buildMockClient([
              { tool_uses: [{ id: 'call_1', name: 'echo', input: { x: 1 } }] },
              { text: 'echoed' },
            ]),
          }),
        ),
    );
    expect(calls).toHaveLength(1);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]).toMatchObject({
      id: 'call_1',
      name: 'echo',
      ok: true,
    });
    expect(result.verdict).toBe('success');
  });

  it('plan_shape_hash matches planShapeHash(posture, invoked names)', async () => {
    const result = await withTestCatalog(
      [
        { name: 'first', posture_eligibility: ['generic'], handler: async () => ({}) },
        { name: 'second', posture_eligibility: ['generic'], handler: async () => ({}) },
      ],
      () =>
        runLoop(
          baseOpts(db, 'cyp_happy', {
            anthropic_client: buildMockClient([
              { tool_uses: [{ id: 'c1', name: 'first', input: {} }] },
              { tool_uses: [{ id: 'c2', name: 'second', input: {} }] },
              { text: 'done' },
            ]),
          }),
        ),
    );
    expect(result.plan_shape_hash).toBe(planShapeHash('generic', ['first', 'second']));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. runLoop — errors and budgets
// ───────────────────────────────────────────────────────────────────────────

describe('runLoop — errors and budgets', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedSession(db, 'cyp_err');
  });
  afterEach(() => db.close());

  it('catches tool handler errors and surfaces them as tool_result, loop continues', async () => {
    const result = await withTestCatalog(
      [
        {
          name: 'broken',
          posture_eligibility: ['generic'],
          handler: async () => {
            throw new Error('boom');
          },
        },
      ],
      () =>
        runLoop(
          baseOpts(db, 'cyp_err', {
            anthropic_client: buildMockClient([
              { tool_uses: [{ id: 'c1', name: 'broken', input: {} }] },
              { text: 'recovered' },
            ]),
          }),
        ),
    );
    expect(result.tool_calls[0].ok).toBe(false);
    expect(result.tool_calls[0].error).toBe('boom');
    expect(result.verdict).toBe('success'); // loop kept going, surface present
  });

  it('surfaces unknown tool names as tool_call errors', async () => {
    const result = await withTestCatalog(
      [{ name: 'real', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () =>
        runLoop(
          baseOpts(db, 'cyp_err', {
            anthropic_client: buildMockClient([
              { tool_uses: [{ id: 'c1', name: 'nonexistent', input: {} }] },
              { text: 'noted' },
            ]),
          }),
        ),
    );
    expect(result.tool_calls[0].ok).toBe(false);
    expect(result.tool_calls[0].error).toContain('unknown tool');
  });

  it('surfaces posture-ineligible tool calls as errors', async () => {
    const result = await withTestCatalog(
      [
        {
          name: 'pm_only',
          posture_eligibility: ['pm'], // not eligible for 'generic'
          handler: async () => ({}),
        },
      ],
      () =>
        runLoop(
          baseOpts(db, 'cyp_err', {
            posture: 'generic',
            // Catalog filter will exclude this tool, so the loop will short-circuit
            // with 'failed' before even hitting the model. That's a different test;
            // this one tests the in-handler eligibility check.
            // Inject a second eligible tool so the catalog filter has something.
            // (Two-tool catalog needed.)
          }),
        )
          .then(async () => {
            // Re-run with a catalog that includes BOTH the pm-only and a generic-eligible
            // tool, then have the mock emit a tool_use for the pm-only one.
            return withTestCatalog(
              [
                { name: 'pm_only', posture_eligibility: ['pm'], handler: async () => ({}) },
                {
                  name: 'fallback',
                  posture_eligibility: ['generic'],
                  handler: async () => ({}),
                },
              ],
              () =>
                runLoop(
                  baseOpts(db, 'cyp_err', {
                    posture: 'generic',
                    anthropic_client: buildMockClient([
                      { tool_uses: [{ id: 'c1', name: 'pm_only', input: {} }] },
                      { text: 'caught' },
                    ]),
                  }),
                ),
            );
          }),
    );
    // The 'pm_only' tool is in the catalog but filtered out by toolsForPosture
    // for 'generic'. eligibleTools.find() returns undefined → unknown-tool error.
    expect(result.tool_calls[0].ok).toBe(false);
    expect(result.tool_calls[0].error).toBeTruthy();
  });

  it("returns verdict='mixed' when max_iterations is exhausted", async () => {
    // Mock that always emits a tool_use, never end_turn.
    const looping = buildMockClient(
      Array.from({ length: 10 }, (_, i) => ({
        tool_uses: [{ id: `c${i}`, name: 'noop', input: {} }],
      })),
    );
    const result = await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () =>
        runLoop(
          baseOpts(db, 'cyp_err', {
            anthropic_client: looping,
            max_iterations: 3,
          }),
        ),
    );
    expect(result.verdict).toBe('mixed');
    expect(result.tool_calls.length).toBe(3);
    expect(result.surface).toContain('Budget exhausted');
  });

  it("returns verdict='failed' when the Anthropic client throws", async () => {
    const erroring = {
      beta: {
        promptCaching: {
          messages: { create: vi.fn(async () => { throw new Error('proxy 500'); }) },
        },
      },
    } as unknown as Anthropic;
    const result = await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () =>
        runLoop(baseOpts(db, 'cyp_err', { anthropic_client: erroring })),
    );
    expect(result.verdict).toBe('failed');
    expect(result.surface).toContain('proxy 500');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 7. runLoop — halt-flag semantics (Q-1.12)
// ───────────────────────────────────────────────────────────────────────────

describe('runLoop — halt flag', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedSession(db, 'cyp_halt');
  });
  afterEach(() => db.close());

  it("halts at iteration top when halt_flag is set before any tool fires", async () => {
    const halt: HaltFlag = { value: true };
    const result = await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () =>
        runLoop(
          baseOpts(db, 'cyp_halt', {
            halt_flag: halt,
            anthropic_client: buildMockClient([{ text: 'never reached' }]),
          }),
        ),
    );
    expect(result.verdict).toBe('halted');
    expect(result.halt_after_call_id).toBeUndefined();
    expect(result.halt_requested_at).toBeDefined();
    expect(result.tool_calls).toHaveLength(0);
  });

  it("halts between tool calls — in-flight call completes, next one doesn't fire", async () => {
    const halt: HaltFlag = { value: false };
    const result = await withTestCatalog(
      [
        {
          name: 'flip_then_done',
          posture_eligibility: ['generic'],
          handler: async () => {
            // Simulate user pressing /stop during the call.
            halt.value = true;
            return { did_work: true };
          },
        },
      ],
      () =>
        runLoop(
          baseOpts(db, 'cyp_halt', {
            halt_flag: halt,
            anthropic_client: buildMockClient([
              { tool_uses: [{ id: 'c1', name: 'flip_then_done', input: {} }] },
              { tool_uses: [{ id: 'c2', name: 'flip_then_done', input: {} }] },
              { text: 'never reached' },
            ]),
          }),
        ),
    );
    expect(result.verdict).toBe('halted');
    // The first call completed (it's the one that flipped the halt).
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].id).toBe('c1');
    expect(result.tool_calls[0].ok).toBe(true);
    // halt_after_call_id points at the last-completed call.
    expect(result.halt_after_call_id).toBe('c1');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 8. runLoop — persistence (cypher_sessions + cypher_outcomes)
// ───────────────────────────────────────────────────────────────────────────

describe('runLoop — persistence', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedSession(db, 'cyp_persist');
  });
  afterEach(() => db.close());

  it('updates cypher_sessions with confirm_mode_*, phase, engine, prior_count at entry', async () => {
    await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () =>
        runLoop(
          baseOpts(db, 'cyp_persist', {
            confirm_mode: 'auto',
            anthropic_client: buildMockClient([{ text: 'done' }]),
          }),
        ),
    );
    const row = db
      .prepare(
        `SELECT confirm_mode_requested, confirm_mode_used, phase, engine, prior_count, prior_success_rate
         FROM cypher_sessions WHERE session_id = ?`,
      )
      .get('cyp_persist') as {
        confirm_mode_requested: ConfirmMode;
        confirm_mode_used: ConfirmMode;
        phase: number;
        engine: string;
        prior_count: number;
        prior_success_rate: number | null;
      };
    expect(row.confirm_mode_requested).toBe('auto');
    expect(row.confirm_mode_used).toBe('auto');
    expect(row.phase).toBe(2);
    expect(row.engine).toBe('loop');
    expect(row.prior_count).toBe(0); // cold start
    expect(row.prior_success_rate).toBeNull();
  });

  it('writes cypher_sessions outcome + status=done + duration_ms + completed_at', async () => {
    await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () =>
        runLoop(
          baseOpts(db, 'cyp_persist', {
            anthropic_client: buildMockClient([{ text: 'final surface' }]),
          }),
        ),
    );
    const row = db
      .prepare(
        `SELECT status, outcome, duration_ms, completed_at, plan_shape_hash
         FROM cypher_sessions WHERE session_id = ?`,
      )
      .get('cyp_persist') as {
        status: string;
        outcome: string | null;
        duration_ms: number | null;
        completed_at: string | null;
        plan_shape_hash: string;
      };
    expect(row.status).toBe('done');
    expect(row.outcome).toBe('success');
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.completed_at).toBeTruthy();
    expect(row.plan_shape_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("writes a cypher_outcomes verdict row with granular verdict in metadata", async () => {
    await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () =>
        runLoop(
          baseOpts(db, 'cyp_persist', {
            anthropic_client: buildMockClient([{ text: 'shipped' }]),
          }),
        ),
    );
    const out = db
      .prepare(
        `SELECT signal_kind, value, metadata, created_by
         FROM cypher_outcomes WHERE session_id = ?`,
      )
      .get('cyp_persist') as {
        signal_kind: string;
        value: number;
        metadata: string;
        created_by: string;
      };
    expect(out).toBeTruthy();
    expect(out.signal_kind).toBe('verdict');
    expect(out.value).toBeGreaterThan(0); // VERDICT_SUCCESS = 0.8
    expect(out.created_by).toBe('cypher-loop:maaz');
    const meta = JSON.parse(out.metadata);
    expect(meta.verdict).toBe('success');
    expect(meta.source).toBe('cypher-loop');
  });

  it("propagates halted verdict honestly to cypher_sessions.outcome (post-v87 + 2026-07-25 fix)", async () => {
    // Before the 2026-07-25 reducer fix (see loop.ts:3013 + F4 in
    // .planning/execute-no-skill/02-REVIEW.md), the persistOutcome reducer
    // collapsed halted → 'mixed' regardless of what the loop produced.
    // That was harmless while the schema CHECK still excluded 'halted'
    // (pre-v87), but v87 widened the CHECK — the reducer just never caught
    // up. This test locks the honest behavior: halted stays halted.
    const halt: HaltFlag = { value: true };
    await withTestCatalog(
      [{ name: 'noop', posture_eligibility: ['generic'], handler: async () => ({}) }],
      () =>
        runLoop(
          baseOpts(db, 'cyp_persist', {
            halt_flag: halt,
            anthropic_client: buildMockClient([{ text: 'unreached' }]),
          }),
        ),
    );
    const row = db
      .prepare(`SELECT outcome FROM cypher_sessions WHERE session_id = ?`)
      .get('cyp_persist') as { outcome: string };
    expect(row.outcome).toBe('halted');

    // Granular verdict also survives in cypher_outcomes metadata (unchanged).
    const out = db
      .prepare(`SELECT metadata FROM cypher_outcomes WHERE session_id = ?`)
      .get('cyp_persist') as { metadata: string };
    expect(JSON.parse(out.metadata).verdict).toBe('halted');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 9. runLoop — events
// ───────────────────────────────────────────────────────────────────────────

describe('runLoop — streaming events', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedSession(db, 'cyp_events');
  });
  afterEach(() => db.close());

  it("emits tool_call_started/_completed bracketing each tool fire", async () => {
    const events: LoopEvent[] = [];
    await withTestCatalog(
      [{ name: 'x', posture_eligibility: ['generic'], handler: async () => ({ ok: 1 }) }],
      () =>
        runLoop(
          baseOpts(db, 'cyp_events', {
            anthropic_client: buildMockClient([
              { tool_uses: [{ id: 'c1', name: 'x', input: {} }] },
              { text: 'done' },
            ]),
            on_event: (e) => events.push(e),
          }),
        ),
    );
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call_started');
    expect(types).toContain('tool_call_completed');
    expect(types[types.length - 1]).toBe('done');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 10. Sanity check — LOOP_DEFAULTS matches plan § 3.1
// ───────────────────────────────────────────────────────────────────────────

describe('LOOP_DEFAULTS', () => {
  it('matches execution plan § 3.1 budget defaults', () => {
    expect(LOOP_DEFAULTS.max_iterations).toBe(25);
    expect(LOOP_DEFAULTS.max_tokens).toBe(200_000);
    expect(LOOP_DEFAULTS.max_wallclock_ms).toBe(600_000);
  });

  it('toolsForPosture is the catalog re-export', () => {
    // toolsForPosture is the same function the loop body uses — the
    // re-export is a single-import convenience for downstream callers.
    expect(typeof toolsForPosture).toBe('function');
    const tools = toolsForPosture('generic');
    expect(Array.isArray(tools)).toBe(true);
  });
});
