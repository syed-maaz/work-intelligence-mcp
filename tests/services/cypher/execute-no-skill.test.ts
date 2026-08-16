/**
 * Regression test for the "EXECUTE returns without a tool_use" bug
 * (formerly bug #814 in the diagram; new failure mode 2026-07-25).
 *
 * Empirical baseline (queried against ~/.work-intelligence-mcp/data.db
 * on 2026-07-25):
 *
 *   - 53 of 78 phase=2 successes had chosen_skill='' and
 *     skill_actually_invoked=''.
 *   - 10 of those 53 sessions had a cypher_record_outcome tool_use with
 *     outcome∈{failed, mixed, halted} — the model correctly said "this
 *     didn't work" and cypher_sessions.outcome was still written as
 *     'success'.
 *
 * Root cause (see .planning/execute-no-skill/00-CANDIDATES.md):
 *
 *   1. src/services/cypher/tool-catalog.ts:2213 — cypher_record_outcome
 *      handler is a phase-2 stub. It returns { deferred: 'phase-3' }
 *      and discards the outcome/note the model emitted.
 *
 *   2. src/services/cypher/loop.ts:2683 — verdict resolution derives
 *      the verdict from stopReason==='end_turn' && surface.length>0.
 *      The model's own cypher_record_outcome call is never consulted.
 *
 * Fix (C1+C2 in candidates): the verdict resolver must prefer the
 * model-emitted outcome from tool_calls[].name==='cypher_record_outcome'
 * when present, falling back to the surface-length heuristic only
 * when the model didn't call the tool.
 *
 * This test scripts the mock Anthropic client to reproduce the acute
 * case: a single execute iteration that emits ONE tool_use for
 * cypher_record_outcome with outcome='failed', then a final end_turn
 * with a valid (non-empty) text surface (mirroring the poster-child
 * repro cyp_8df957e5ba02: the model wrote a lucid handoff paragraph
 * AFTER calling record_outcome with outcome='failed').
 *
 * Expected on master today: cypher_sessions.outcome === 'success'
 * (test FAILS — the bug).
 *
 * Expected after fix: cypher_sessions.outcome === 'failed' (test
 * PASSES — the honest outcome wins).
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
// v87 widens the outcome CHECK to admit 'halted' | 'abandoned' | 'rejected_non_interactive'.
// Without this migration the halted-bucket test hits SQLITE_CONSTRAINT.
import migrateV87 from '../../../src/db/migrations/v87_outcome_check_widen.js';
// v100 widens outcome CHECK to also admit 'captured_to_board' (ADR-043 A1).
import migrateV100 from '../../../src/db/migrations/v100_captured_to_board_outcome.js';

import { runLoop, type LoopOptions } from '../../../src/services/cypher/loop.js';
import type { ToolDefinition, Posture } from '../../../src/services/cypher/tool-catalog.js';

// ---------------------------------------------------------------------------
// Fixtures — copied from loop.test.ts (same shape, same migrations).
// ---------------------------------------------------------------------------

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
  migrateV87(db);
  migrateV100(db);
  return db;
}

function seedSession(db: Database.Database, session_id: string): void {
  db.prepare(
    `INSERT INTO cypher_sessions (session_id, goal, user, status)
     VALUES (?, 'Fix 94 vitest failures on master', 'maaz', 'pending')`,
  ).run(session_id);
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
  category?: 'auto' | 'confirm';
}

/**
 * Hot-swap TOOL_CATALOG for the duration of one runLoop. We inject
 * a stand-in for cypher_record_outcome that mirrors the CURRENT
 * production stub (returns { deferred: 'phase-3' }) so this test
 * exercises the exact bug path. Do NOT change this to "write the row"
 * — that would move the fix into the test.
 */
function withTestCatalog<T>(
  tools: InjectableTool[],
  fn: () => Promise<T>,
): Promise<T> {
  const defs: ToolDefinition[] = tools.map((t) => ({
    name: t.name,
    description: `test tool ${t.name}`,
    category: t.category ?? 'auto',
    posture_eligibility: t.posture_eligibility,
    input_schema: { type: 'object', properties: {} },
    estimated_duration_ms: 100,
    handler: t.handler,
  }));
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
    goal: 'Fix 94 vitest failures on master',
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

// ---------------------------------------------------------------------------
// The regression test.
// ---------------------------------------------------------------------------

describe('EXECUTE returns without a tool_use — false-success write-path bug', () => {
  let db: Database.Database;
  const SESSION_ID = 'cyp_repro_no_skill';

  beforeEach(() => {
    db = freshDb();
    seedSession(db, SESSION_ID);
  });
  afterEach(() => db.close());

  // ── Parametrized over Group A sub-buckets (F4 in 02-REVIEW.md) ────────────
  // The original single test pinned outcome='failed' only. The verdict
  // resolver branch that reads modelVerdict handles all three non-success
  // codes the same way, but the reviewer flagged this as a coverage gap:
  //   B4a_failed  — 1 session in the 30d corpus
  //   B4b_mixed   — 6 sessions (biggest B4 sub-bucket)
  //   B4c_halted  — 3 sessions (interesting — has to WIN over the halt
  //                 heuristic's fall-through when no real halt fired)
  // A parametrized case per sub-bucket locks the branch-ordering so a
  // future refactor can't silently invert error/halt/budget vs modelVerdict.
  const B4_CASES: Array<{
    outcome: 'failed' | 'mixed' | 'halted';
    bucket: string;
    note: string;
  }> = [
    {
      outcome: 'failed',
      bucket: 'B4a',
      note:
        'Goal requires hands-on execution — git worktree creation, running ' +
        'vitest to reproduce 94 failures, editing 18 test files, and multiple ' +
        "git commits. Cypher's tool catalog is read-only investigation. " +
        'Cannot produce the patch without fabricating. Correct venue is ' +
        'Claude Code with shell+edit+git access.',
    },
    {
      outcome: 'mixed',
      bucket: 'B4b',
      note:
        'Investigation surfaced two candidate root causes but only one had ' +
        'reproducible evidence in the tool catalog available here. Partial ' +
        'result recorded; full triage needs shell + vitest access.',
    },
    {
      outcome: 'halted',
      bucket: 'B4c',
      note:
        'Cannot proceed without user confirmation on the destructive branch ' +
        '(git reset --hard). Halting for clarification rather than guessing ' +
        'at intent.',
    },
  ];

  it.each(B4_CASES)(
    "honours model-emitted outcome='$outcome' (bucket $bucket) over the stopReason heuristic",
    async ({ outcome, note }) => {
      // Script mirrors the real cyp_8df957e5ba02 shape:
      //   iter 1: model emits cypher_record_outcome{outcome:<X>, note:<...>}
      //           preceded by a reasoning text block (matches real
      //           Anthropic responses: text+tool_use in one content array).
      //   iter 2: final text + end_turn. Non-empty surface would trip
      //           the surface.length>0 → 'success' fallback on master
      //           BEFORE the fix.
      //
      // The critical assertion is that modelVerdict wins over the
      // heuristic fallback. This is the SAME code path for all three
      // outcomes — the parametrization guards the branch ordering, not
      // three independent bugs.

      await withTestCatalog(
        [
          {
            name: 'cypher_record_outcome',
            posture_eligibility: ['generic', 'pr-review', 'bug-investigate', 'pm'],
            handler: async (input) => ({
              deferred: 'phase-3',
              session_id: String(input.session_id ?? ''),
              outcome: String(input.outcome ?? ''),
              note: input.note != null ? String(input.note).slice(0, 400) : undefined,
              recommendation: 'phase-3 loop controller writes the real row',
            }),
          },
        ],
        () =>
          runLoop(
            baseOpts(db, SESSION_ID, {
              anthropic_client: buildMockClient([
                {
                  text: `This goal can't be completed cleanly here — recording ${outcome}.`,
                  tool_uses: [
                    {
                      id: 'call_record_1',
                      name: 'cypher_record_outcome',
                      input: {
                        session_id: 'cyp_current', // placeholder — loop ignores this
                        outcome,
                        note,
                      },
                    },
                  ],
                },
                {
                  text:
                    'Handoff: (1) verify environment access, (2) re-dispatch ' +
                    'in the correct venue, (3) resume with the recorded ' +
                    'context. Prose is non-empty so surface.length>0 would ' +
                    "trigger the pre-fix 'success' path.",
                },
              ]),
            }),
          ),
      );

      const row = db
        .prepare(
          `SELECT outcome, chosen_skill, skill_actually_invoked, status
             FROM cypher_sessions WHERE session_id = ?`,
        )
        .get(SESSION_ID) as {
        outcome: string;
        chosen_skill: string | null;
        skill_actually_invoked: string | null;
        status: string;
      };

      expect(row.status).toBe('done');

      // Same predicate the single-case test used: EITHER a skill was
      // dispatched OR the outcome isn't the false 'success'. All B4 cases
      // land in the second clause.
      const dispatchedASkill =
        row.chosen_skill != null && row.chosen_skill !== '';
      const didNotClaimSuccess = row.outcome !== 'success';
      expect(
        dispatchedASkill || didNotClaimSuccess,
        `Regression: session declared outcome='${row.outcome}' with ` +
          `chosen_skill='${row.chosen_skill ?? ''}' despite the model ` +
          `emitting cypher_record_outcome{outcome:'${outcome}'}.`,
      ).toBe(true);

      // Stronger post-fix assertion: the model's exact verdict lands on
      // the row (not just "anything except success").
      expect(row.outcome).toBe(outcome);
    },
  );

  // ── Branch-ordering guard: real halt beats model claim ────────────────────
  // The halt branch at loop.ts:2727 sits ABOVE modelVerdict in the resolution
  // chain. If a real halt fires (haltRequestedAt !== undefined) while the
  // model ALSO calls record_outcome with a different outcome, the halt must
  // win. This is a safety property — a future refactor could invert the
  // ordering unnoticed without a specific test.
  //
  // Note: we cannot easily simulate haltRequestedAt from a mock without
  // reaching into loop internals. This case is deferred to a follow-up
  // that either exposes a test hook OR uses the real halt_flag mechanism.
  // Documented here as an intentional gap rather than a silent one.
  it.skip(
    'real halt beats model-claimed outcome (BRANCH ORDERING — needs halt_flag plumbing)',
    async () => {
      // Placeholder — see comment above.
    },
  );
});
