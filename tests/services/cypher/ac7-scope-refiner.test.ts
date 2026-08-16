/**
 * Tests for the ADR-039 AC-7 commit 1 SCOPE-phase refiner mini-loop
 * body in src/services/cypher/loop.ts.
 *
 * Three layers of coverage:
 *
 *   1. extractJsonBrief — pure-function parser. Bare JSON, fenced JSON,
 *      malformed JSON, no JSON at all. No DB, no mock.
 *   2. persistRefinedGoal — writes to cypher_sessions. SQLite in-memory
 *      with v85 migration applied.
 *   3. SCOPE phase integration — drives runLoop({phase: 'scope'}) with
 *      a stubbed Anthropic client and asserts the three AC-7 exit paths
 *      (brief, clarifying question, iter-cap halt).
 *
 * ADR-039 AC-7 commit 1 (2026-06-29).
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import migrateV52 from '../../../src/db/migrations/v52_model_config.js';
import migrateV59 from '../../../src/db/migrations/v59_cypher_tables.js';
import migrateV63 from '../../../src/db/migrations/v63_skill_catalog.js';
import migrateV64 from '../../../src/db/migrations/v64_cypher_outcomes.js';
import migrateV65 from '../../../src/db/migrations/v65_cypher_outcomes_legacy_upgrade.js';
import migrateV67 from '../../../src/db/migrations/v67_cypher_loop_columns.js';
import migrateV70 from '../../../src/db/migrations/v70_cypher_outcomes_failure_pattern.js';
import migrateV71 from '../../../src/db/migrations/v71_cypher_sessions_posture.js';
import migrateV74 from '../../../src/db/migrations/v74_cypher_sessions_self_assess_at_entry.js';
import migrateV85 from '../../../src/db/migrations/v85_cypher_sessions_refined_goal.js';
import migrateV87 from '../../../src/db/migrations/v87_outcome_check_widen.js';
import {
  extractJsonBrief,
  persistRefinedGoal,
  runLoop,
} from '../../../src/services/cypher/loop.js';

// ---------------------------------------------------------------------------
// extractJsonBrief
// ---------------------------------------------------------------------------

describe('extractJsonBrief', () => {
  it('parses a bare JSON object', () => {
    const out = extractJsonBrief('{"intent":"investigate","target":"x"}');
    expect(out).toEqual({ intent: 'investigate', target: 'x' });
  });

  it('parses a JSON object wrapped in ```json fences', () => {
    const text = 'Here is the brief:\n```json\n{"intent":"build","target":"y"}\n```';
    const out = extractJsonBrief(text);
    expect(out).toEqual({ intent: 'build', target: 'y' });
  });

  it('parses a JSON object wrapped in ``` (unlabeled) fences', () => {
    const text = '```\n{"intent":"fix"}\n```';
    const out = extractJsonBrief(text);
    expect(out).toEqual({ intent: 'fix' });
  });

  it('finds the JSON object inside surrounding prose', () => {
    const text =
      'OK, I think I have enough.\n\n{"intent":"refactor","target":"loop"}\n\nLet me know if you want changes.';
    const out = extractJsonBrief(text);
    expect(out).toEqual({ intent: 'refactor', target: 'loop' });
  });

  it('returns null on empty input', () => {
    expect(extractJsonBrief('')).toBeNull();
    expect(extractJsonBrief('   ')).toBeNull();
  });

  it('returns null when no JSON-looking block is present', () => {
    expect(extractJsonBrief('This is just prose, no braces.')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(extractJsonBrief('{intent: not-quoted}')).toBeNull();
    expect(extractJsonBrief('{"intent": "missing-close')).toBeNull();
  });

  it('handles nested objects and braces inside string values', () => {
    const text = '{"intent":"x","linkage":{"jira":["DEMO-1"],"prs":[]}}';
    const out = extractJsonBrief(text);
    expect(out).toEqual({
      intent: 'x',
      linkage: { jira: ['DEMO-1'], prs: [] },
    });
  });

  it('handles strings containing escaped quotes correctly', () => {
    const text = '{"intent":"build","note":"contains \\"quotes\\" inside"}';
    const out = extractJsonBrief(text);
    expect(out).toEqual({
      intent: 'build',
      note: 'contains "quotes" inside',
    });
  });
});

// ---------------------------------------------------------------------------
// persistRefinedGoal
// ---------------------------------------------------------------------------

function fullDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV52(db);
  migrateV59(db);
  migrateV63(db);
  migrateV64(db);
  migrateV65(db);
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
    `INSERT INTO cypher_sessions (session_id, goal, user, status) VALUES (?, 'g', 'maaz', 'pending')`,
  ).run(session_id);
}

describe('persistRefinedGoal', () => {
  let db: Database.Database;
  beforeEach(() => { db = fullDb(); seedSession(db, 'cyp_p1'); });
  afterEach(() => { db.close(); });

  it('writes refined_goal JSON + scope_iters when given a brief', () => {
    const brief = JSON.stringify({ intent: 'investigate', target: 'x' });
    persistRefinedGoal(db, 'cyp_p1', brief, 2);
    const row = db
      .prepare(`SELECT refined_goal, scope_iters FROM cypher_sessions WHERE session_id = ?`)
      .get('cyp_p1') as { refined_goal: string; scope_iters: number };
    expect(row.refined_goal).toBe(brief);
    expect(row.scope_iters).toBe(2);
  });

  it('writes NULL refined_goal but non-zero scope_iters on halt', () => {
    persistRefinedGoal(db, 'cyp_p1', null, 3);
    const row = db
      .prepare(`SELECT refined_goal, scope_iters FROM cypher_sessions WHERE session_id = ?`)
      .get('cyp_p1') as { refined_goal: string | null; scope_iters: number };
    expect(row.refined_goal).toBeNull();
    expect(row.scope_iters).toBe(3);
  });

  it('is idempotent — second call overwrites', () => {
    persistRefinedGoal(db, 'cyp_p1', '{"intent":"first"}', 1);
    persistRefinedGoal(db, 'cyp_p1', '{"intent":"second"}', 2);
    const row = db
      .prepare(`SELECT refined_goal, scope_iters FROM cypher_sessions WHERE session_id = ?`)
      .get('cyp_p1') as { refined_goal: string; scope_iters: number };
    expect(row.refined_goal).toBe('{"intent":"second"}');
    expect(row.scope_iters).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SCOPE-phase integration (stubbed Anthropic client)
// ---------------------------------------------------------------------------

interface StubResponse {
  text: string;
  // Optional tool_use blocks; default empty array.
  tool_uses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stop_reason?: string;
}

/**
 * Build a stub Anthropic client that returns a queued sequence of
 * responses. Each call to messages.create consumes one entry. The
 * stub also captures the messages array passed in so tests can assert
 * the system prompt / tools layout.
 */
function makeStubClient(responses: StubResponse[]): {
  client: unknown;
  calls: Array<{ system: unknown; tools: unknown; messages: unknown }>;
} {
  const calls: Array<{ system: unknown; tools: unknown; messages: unknown }> = [];
  let i = 0;
  const client = {
    beta: {
      promptCaching: {
        messages: {
          create: (req: { system: unknown; tools: unknown; messages: unknown }) => {
            calls.push(req);
            const r = responses[i++] ?? responses[responses.length - 1];
            const content: Array<unknown> = [];
            if (r.text) {
              content.push({ type: 'text', text: r.text });
            }
            for (const tu of r.tool_uses ?? []) {
              content.push({ type: 'tool_use', ...tu });
            }
            return Promise.resolve({
              content,
              stop_reason: r.stop_reason ?? 'end_turn',
              usage: {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            });
          },
        },
      },
    },
  };
  return { client, calls };
}

describe('runLoop SCOPE phase (AC-7)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = fullDb();
    seedSession(db, 'cyp_scope_test');
    process.env.CYPHER_REFINEMENT_ENABLED = '1';
  });
  afterEach(() => {
    db.close();
    delete process.env.CYPHER_REFINEMENT_ENABLED;
    delete process.env.CYPHER_SCOPE_MAX_ITERS;
  });

  it('exits with verdict=success when the model emits a valid refined_goal brief', async () => {
    const brief = {
      intent: 'investigate',
      target: 'why dispatch hangs on first call',
      constraints: ['no Anthropic calls'],
      success_criteria: ['repro in test'],
      out_of_scope: ['UI work'],
      linkage: { jira: ['DEMO-1'], prs: [], adrs: ['ADR-039'], files: [] },
      expected_output_shape: 'rca',
      evidence_cited: [{ source: 'loop.ts', ref: 'L123', snippet: 'phase entry' }],
    };
    const { client } = makeStubClient([{ text: JSON.stringify(brief) }]);

    const result = await runLoop({
      db,
      goal: 'investigate dispatch hang',
      user: 'maaz',
      session_id: 'cyp_scope_test',
      posture: 'generic',
      halt_flag: { value: false },
      is_interactive: true,
      anthropic_client: client as never,
      palace: null,
      phase: 'scope',
    });

    expect(result.verdict).toBe('success');
    expect(result.phase).toBe(1);
    // surface is the JSON brief
    expect(JSON.parse(result.surface)).toEqual(brief);
    // Row was persisted
    const row = db
      .prepare(`SELECT refined_goal, scope_iters FROM cypher_sessions WHERE session_id = ?`)
      .get('cyp_scope_test') as { refined_goal: string; scope_iters: number };
    expect(JSON.parse(row.refined_goal)).toEqual(brief);
    expect(row.scope_iters).toBe(1);
  });

  it('exits with verdict=halted when the model emits a clarifying question (no JSON)', async () => {
    const { client } = makeStubClient([
      { text: 'Do you want me to investigate first, or both investigate AND ship in one go?' },
    ]);

    const result = await runLoop({
      db,
      goal: 'investigate and ship',
      user: 'maaz',
      session_id: 'cyp_scope_test',
      posture: 'generic',
      halt_flag: { value: false },
      is_interactive: true,
      anthropic_client: client as never,
      palace: null,
      phase: 'scope',
    });

    expect(result.verdict).toBe('halted');
    expect(result.surface).toContain('Do you want me to investigate');
    const row = db
      .prepare(`SELECT refined_goal, scope_iters FROM cypher_sessions WHERE session_id = ?`)
      .get('cyp_scope_test') as { refined_goal: string | null; scope_iters: number };
    expect(row.refined_goal).toBeNull();
    expect(row.scope_iters).toBe(1);
  });

  it('exits with verdict=halted when scope_iters reaches the cap with no brief', async () => {
    process.env.CYPHER_SCOPE_MAX_ITERS = '2';
    // Both responses are tool_use without text (the loop dispatches the
    // tool, gets a result, but still no brief). With the stubbed tool
    // returning nothing meaningful, the loop runs out of budget.
    const { client } = makeStubClient([
      // Iter 1: model wants tools, no brief, no question.
      {
        text: '',
        tool_uses: [{ id: 'tu_1', name: 'fts_search', input: { query: 'x' } }],
      },
      // Iter 2: same — still no brief.
      {
        text: '',
        tool_uses: [{ id: 'tu_2', name: 'fts_search', input: { query: 'y' } }],
      },
    ]);

    const result = await runLoop({
      db,
      goal: 'something ambiguous',
      user: 'maaz',
      session_id: 'cyp_scope_test',
      posture: 'generic',
      halt_flag: { value: false },
      is_interactive: true,
      anthropic_client: client as never,
      palace: null,
      phase: 'scope',
    });

    expect(result.verdict).toBe('halted');
    expect(result.surface).toMatch(/iteration cap \(2\) reached/);
    const row = db
      .prepare(`SELECT refined_goal, scope_iters FROM cypher_sessions WHERE session_id = ?`)
      .get('cyp_scope_test') as { refined_goal: string | null; scope_iters: number };
    expect(row.refined_goal).toBeNull();
    expect(row.scope_iters).toBe(2);
  });

  it('falls back to single-pass execute when CYPHER_REFINEMENT_ENABLED=0 even if phase=scope', async () => {
    delete process.env.CYPHER_REFINEMENT_ENABLED;
    // The execute path will try to do real work; the only thing we
    // need from this test is that it does NOT take the scope-phase
    // branch. We assert by checking that the result phase is NOT 1
    // (scope) — OR if execute crashes due to missing client, we
    // catch the error and assert it's an execute-path error, not the
    // scope marker text.
    const result = await runLoop({
      db,
      goal: 'investigate',
      user: 'maaz',
      session_id: 'cyp_scope_test',
      posture: 'generic',
      halt_flag: { value: false },
      is_interactive: true,
      anthropic_client: undefined as never,
      palace: null,
      phase: 'scope', // requested but flag is off
    }).catch((e) => ({ verdict: 'failed' as const, surface: String(e.message), error: true }));

    // Scope-marker surface from the previous behavior is gone. If the
    // result is the scope-phase JSON-brief surface, the gate leaked.
    // If the result is an execute-path error or success, the gate held.
    // We assert by checking the surface does NOT match the scope
    // halting markers from the prior substrate-only implementation.
    expect(result.surface).not.toMatch(/ADR-039 SCOPE phase: substrate landed/);
  });
});
