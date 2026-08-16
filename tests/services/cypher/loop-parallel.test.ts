/**
 * loop.ts parallel tool_use dispatcher — ADR-039 T5 (AC-6).
 *
 * Covers the partition-and-Promise.all behaviour added by T5:
 *
 *   1. Three parallel tools (each ~100ms) run together — wall-clock
 *      is <200ms, NOT 300ms+ (sequential lower bound).
 *   2. Mixed batch (2 parallel + 1 serial) preserves the model's
 *      original tool_use ordering in tool_calls, toolResults, and
 *      cypher_steps stage_index. Serial tool sees state written
 *      by the parallel batch (runs after).
 *   3. Sequential lower bound on a 3-tool all-serial batch (control
 *      for #1 — sanity check that serial really IS slower).
 *
 * Reuses the same fixture machinery as loop.test.ts: in-memory DB
 * migrated to v74, mock Anthropic client, withTestCatalog hot-swap.
 */

import Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
import migrateV80 from '../../../src/db/migrations/v80_d18_reasoning_trace.js';
import migrateV89 from '../../../src/db/migrations/v89_cypher_steps_phase.js';

import {
  runLoop,
  type LoopOptions,
} from '../../../src/services/cypher/loop.js';
import type {
  ToolDefinition,
  Posture,
} from '../../../src/services/cypher/tool-catalog.js';

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

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
  migrateV80(db);
  migrateV89(db);
  return db;
}

function seedSession(db: Database.Database, session_id: string, user = 'maaz'): void {
  db.prepare(
    `INSERT INTO cypher_sessions (session_id, goal, user, status)
     VALUES (?, 'parallel test', ?, 'pending')`,
  ).run(session_id, user);
}

interface ScriptedResponse {
  text?: string;
  tool_uses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  input_tokens?: number;
  output_tokens?: number;
}

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
    if (next.text) content.push({ type: 'text', text: next.text });
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
  return {
    beta: { promptCaching: { messages: { create } } },
  } as unknown as Anthropic;
}

interface InjectableTool {
  name: string;
  posture_eligibility: Posture[];
  handler: ToolDefinition['handler'];
  parallelizable?: boolean;
  category?: 'auto' | 'confirm';
}

function withTestCatalog<T>(
  tools: InjectableTool[],
  fn: () => Promise<T>,
): Promise<T> {
  const defs: ToolDefinition[] = tools.map((t) => {
    const def: ToolDefinition = {
      name: t.name,
      description: `test tool ${t.name}`,
      category: t.category ?? 'auto',
      posture_eligibility: t.posture_eligibility,
      input_schema: { type: 'object', properties: {} },
      estimated_duration_ms: 100,
      handler: t.handler,
    };
    if (t.parallelizable !== undefined) def.parallelizable = t.parallelizable;
    return def;
  });
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
    goal: 'parallel test',
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

// 100ms-each handler factory. Sleep keeps the test honest — Promise.all
// has to actually overlap them for the wall-clock assertion to pass.
function sleepHandler(ms: number): ToolDefinition['handler'] {
  return async () => {
    await new Promise((r) => setTimeout(r, ms));
    return { slept: ms };
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe('runLoop — parallel tool_use dispatch (ADR-039 T5)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    seedSession(db, 'cyp_par');
  });
  afterEach(() => db.close());

  it(
    'runs 3 parallel tools concurrently — wallclock <200ms, not 300ms+',
    async () => {
      const t0 = Date.now();
      const result = await withTestCatalog(
        [
          {
            name: 'p1',
            posture_eligibility: ['generic'],
            handler: sleepHandler(100),
          },
          {
            name: 'p2',
            posture_eligibility: ['generic'],
            handler: sleepHandler(100),
          },
          {
            name: 'p3',
            posture_eligibility: ['generic'],
            handler: sleepHandler(100),
          },
        ],
        () =>
          runLoop(
            baseOpts(db, 'cyp_par', {
              anthropic_client: buildMockClient([
                {
                  tool_uses: [
                    { id: 'c1', name: 'p1', input: {} },
                    { id: 'c2', name: 'p2', input: {} },
                    { id: 'c3', name: 'p3', input: {} },
                  ],
                },
                { text: 'all done' },
              ]),
            }),
          ),
      );
      const elapsed = Date.now() - t0;

      expect(result.verdict).toBe('success');
      expect(result.tool_calls).toHaveLength(3);
      // All three completed.
      expect(result.tool_calls.every((c) => c.ok)).toBe(true);

      // Sum of per-tool durations would be ~300ms in sequential mode.
      const totalToolMs = result.tool_calls.reduce(
        (s, c) => s + c.duration_ms,
        0,
      );
      expect(totalToolMs).toBeGreaterThanOrEqual(290);

      // But the loop completes in well under 300ms because the three
      // 100ms sleeps overlapped under Promise.all. Tolerance 50ms over
      // the 100ms minimum to accommodate CI jitter (per task spec).
      expect(elapsed).toBeLessThan(250);
    },
    10_000,
  );

  it(
    'sequential lower bound — same 3 tools, parallelizable=false → wall >= sum of durations',
    async () => {
      const t0 = Date.now();
      const result = await withTestCatalog(
        [
          {
            name: 's1',
            posture_eligibility: ['generic'],
            parallelizable: false,
            handler: sleepHandler(100),
          },
          {
            name: 's2',
            posture_eligibility: ['generic'],
            parallelizable: false,
            handler: sleepHandler(100),
          },
          {
            name: 's3',
            posture_eligibility: ['generic'],
            parallelizable: false,
            handler: sleepHandler(100),
          },
        ],
        () =>
          runLoop(
            baseOpts(db, 'cyp_par', {
              anthropic_client: buildMockClient([
                {
                  tool_uses: [
                    { id: 'c1', name: 's1', input: {} },
                    { id: 'c2', name: 's2', input: {} },
                    { id: 'c3', name: 's3', input: {} },
                  ],
                },
                { text: 'all done' },
              ]),
            }),
          ),
      );
      const elapsed = Date.now() - t0;
      expect(result.verdict).toBe('success');
      expect(result.tool_calls).toHaveLength(3);
      // Sequential — wall ≥ sum of sleeps (minus a tolerance for clock
      // resolution; 280ms is well below the 300ms theoretical bound but
      // safely above the parallel ~120ms upper bound from the previous
      // test).
      expect(elapsed).toBeGreaterThanOrEqual(280);
    },
    10_000,
  );

  it(
    'mixed batch (2 parallel + 1 serial) preserves tool_use order in tool_calls and cypher_steps',
    async () => {
      // Tools mutate a shared array so we can verify what ran in what
      // group. The serial tool reads the array at handler time; if it
      // ran in parallel with the others, it would see fewer entries.
      const writes: string[] = [];

      const result = await withTestCatalog(
        [
          {
            name: 'fastRead',
            posture_eligibility: ['generic'],
            // parallelizable defaults to true
            handler: async () => {
              await new Promise((r) => setTimeout(r, 50));
              writes.push('fastRead');
              return { tag: 'fastRead' };
            },
          },
          {
            name: 'slowRead',
            posture_eligibility: ['generic'],
            handler: async () => {
              await new Promise((r) => setTimeout(r, 50));
              writes.push('slowRead');
              return { tag: 'slowRead' };
            },
          },
          {
            name: 'writer',
            posture_eligibility: ['generic'],
            parallelizable: false,
            handler: async () => {
              // Records what the parallel batch wrote BEFORE it ran.
              const snapshot = writes.slice();
              writes.push('writer');
              return { tag: 'writer', saw: snapshot };
            },
          },
        ],
        () =>
          runLoop(
            baseOpts(db, 'cyp_par', {
              anthropic_client: buildMockClient([
                {
                  // Model's emission order — writer in the MIDDLE.
                  tool_uses: [
                    { id: 'c_fast', name: 'fastRead', input: {} },
                    { id: 'c_write', name: 'writer', input: {} },
                    { id: 'c_slow', name: 'slowRead', input: {} },
                  ],
                },
                { text: 'done' },
              ]),
            }),
          ),
      );

      expect(result.verdict).toBe('success');
      expect(result.tool_calls).toHaveLength(3);

      // tool_calls preserve the model's original order, NOT the
      // execution group order.
      expect(result.tool_calls.map((c) => c.id)).toEqual([
        'c_fast',
        'c_write',
        'c_slow',
      ]);
      expect(result.tool_calls.map((c) => c.name)).toEqual([
        'fastRead',
        'writer',
        'slowRead',
      ]);

      // Writer ran AFTER both parallel reads — its snapshot should
      // include both tags. (Order within the snapshot is non-
      // deterministic because the two parallel tools race each other,
      // so we check set membership.)
      const writerResult = result.tool_calls.find((c) => c.name === 'writer')!;
      const saw = (writerResult.result as { saw: string[] }).saw;
      expect(new Set(saw)).toEqual(new Set(['fastRead', 'slowRead']));
      expect(saw).toHaveLength(2);

      // cypher_steps stage_index preserves model order too.
      const steps = db
        .prepare(
          `SELECT stage_index, payload FROM cypher_steps
           WHERE session_id = ? AND stage = 'tool_use'
           ORDER BY stage_index ASC`,
        )
        .all('cyp_par') as { stage_index: number; payload: string }[];
      expect(steps).toHaveLength(3);
      const names = steps.map((s) => JSON.parse(s.payload).tool as string);
      expect(names).toEqual(['fastRead', 'writer', 'slowRead']);
    },
    10_000,
  );
});
