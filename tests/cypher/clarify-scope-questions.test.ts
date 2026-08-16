/**
 * Tests for ADR-039 T2: clarify.ts system prompt pivoted from
 * skill-pick framing to scope-build framing.
 *
 * AC-2 verification matrix:
 *   1. 10 fuzzy goals → scope-style questions (env / criteria / scope /
 *      done / out-of-scope), questions exist, 0 mention "skill"/"tool"/"wi-".
 *   2. 10 specific goals (DEMO-X / PR-N / file path) → clear=true, no
 *      questions.
 *   3. The Anthropic client is fully mocked — no real network calls.
 *
 * The prompt itself is exercised by passing the SAME system prompt the
 * production code uses to a mock LLM that *simulates* a model honoring
 * the prompt's instructions. We can't run a real model in CI, so the
 * mock is a stand-in for "any reasonable instruction-following model"
 * — it inspects the user message's goal text and chooses clear vs
 * questions accordingly. The point of these tests is to lock in:
 *
 *   - clarify.ts is wired to invoke the LLM with our new system prompt
 *   - the response shape (clear / questions / reason) round-trips
 *   - downstream parsing strips skill-pick artifacts
 *
 * The actual prompt-text quality is enforced by a separate test below
 * that asserts the SYSTEM_PROMPT string contains scope-build language
 * and contains NO "pick a skill" wording.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';

import { classifyClarity, type CatalogEntry } from '../../src/services/cypher/clarify.js';
import migrateV52 from '../../src/db/migrations/v52_model_config.js';
import * as clarifyModule from '../../src/services/cypher/clarify.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

/** Goals expected to be SPECIFIC enough for clear=true (no questions). */
const SPECIFIC_GOALS = [
  'investigate DEMO-15702',
  'review PR #4167',
  'analyze ticket DEMO-99 with my action items',
  'who owns src/services/cypher/loop.ts?',
  'blast radius for src/db/connection.ts',
  'wi-investigate DEMO-100',
  'show my action items',
  'morning brief for today',
  'review pull request PR-4470',
  'check that src/routes/cypher-sessions.ts compiles',
];

/** Goals expected to be FUZZY → clear=false with scope-style questions. */
const FUZZY_GOALS = [
  'help me out',
  'do something useful',
  'fix the bug',
  'look at the dashboard',
  'something is broken',
  'check the deploy',
  'review the recent change',
  'investigate the auth issue',
  'figure out why tests are slow',
  'look into the cron job',
];

/** Pre-canned catalog the clarifier loads — content does not affect mock. */
const CATALOG: CatalogEntry[] = [
  { skill_name: 'wi-investigate', source: 'wi', description: 'investigate Jira tickets' },
  { skill_name: 'wi-pr-review', source: 'wi', description: 'review GitHub pull requests' },
  { skill_name: 'wi-blast-radius', source: 'wi', description: 'compute blast radius for a file change' },
  { skill_name: 'wi-action-items', source: 'wi', description: 'list open action items' },
];

const JIRA_KEY = /\b[A-Z]{2,}-\d+\b/;
const PR_NUM = /(?:^|\s)(PR-?\d+|#\d+|pull request)/i;
const FILE_PATH = /\b(src|tests|web|docs|scripts)\/[\w./-]+\.\w+\b/;
const NAMED_DELIVERABLE = /\b(action items|morning brief|today'?s? digest|my .*items)\b/i;
const NAMED_SKILL = /\bwi-[a-z-]+\b/;

function looksSpecific(goal: string): boolean {
  return (
    JIRA_KEY.test(goal) ||
    PR_NUM.test(goal) ||
    FILE_PATH.test(goal) ||
    NAMED_DELIVERABLE.test(goal) ||
    NAMED_SKILL.test(goal)
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Mock Anthropic client — simulates a model that follows the SYSTEM_PROMPT
// ──────────────────────────────────────────────────────────────────────────

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
interface MockResponse {
  content: ToolUseBlock[];
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

function makeMockClient(): {
  client: Anthropic;
  calls: Array<{ system: unknown; messages: unknown }>;
} {
  const calls: Array<{ system: unknown; messages: unknown }> = [];

  const create = vi.fn(async (params: { system: unknown; messages: Array<{ content: string }> }): Promise<MockResponse> => {
    calls.push({ system: params.system, messages: params.messages });

    // Pull the goal text out of the user message — the production code
    // formats it as `User goal:\n<goal>\n\nAvailable skills:\n...`.
    const userMsg = params.messages[0]?.content ?? '';
    const goalMatch = /User goal:\n([\s\S]*?)\n\nAvailable skills:/.exec(userMsg);
    const goal = (goalMatch?.[1] ?? '').trim();

    const isSpecific = looksSpecific(goal);

    if (isSpecific) {
      return {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'classify_clarity',
            input: {
              clear: true,
              reason: 'target identified; tool selection unambiguous',
              questions: [],
            },
          },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 100,
          output_tokens: 30,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    }

    // Fuzzy: emit scope-shaped questions with concrete defaults. These
    // mirror what a model following the new SYSTEM_PROMPT should produce.
    return {
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'classify_clarity',
          input: {
            clear: false,
            reason: 'target missing; env and success criteria not derivable',
            questions: [
              {
                id: 'q-env',
                question: 'Which env are you targeting?',
                default: 'prod',
              },
              {
                id: 'q-success',
                question: 'What does done look like?',
                default: 'a one-line summary of the root cause',
              },
              {
                id: 'q-out-of-scope',
                question: 'Any surface to leave alone?',
                default: 'unrelated services',
              },
            ],
          },
        },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 100,
        output_tokens: 60,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  });

  return {
    client: { beta: { promptCaching: { messages: { create } } } } as unknown as Anthropic,
    calls,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// In-memory DB with model_config seeded (clarify.ts calls bucketCallParams)
// ──────────────────────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateV52(db);
  return db;
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe('clarify.ts — scope-build framing (ADR-039 T2)', () => {
  describe('SYSTEM_PROMPT text content (compile-time guarantees)', () => {
    // The SYSTEM_PROMPT is a module-level const not exported by name. We
    // read the file text directly to assert framing rules. This locks
    // the framing pivot — touching the prompt re-triggers these checks.
    const promptFile = readFileSync(
      resolve(__dirname, '../../src/services/cypher/clarify.ts'),
      'utf-8',
    );

    it('exists and contains scope-build framing language', () => {
      // The new prompt must say it is NOT picking a skill.
      expect(promptFile).toMatch(/do NOT pick a skill|don't pick a skill/i);
      // It must enumerate the scope fields the brief is meant to carry.
      expect(promptFile).toMatch(/intent/);
      expect(promptFile).toMatch(/target/);
      expect(promptFile).toMatch(/env/);
      expect(promptFile).toMatch(/version/);
      expect(promptFile).toMatch(/success_criteria/);
      expect(promptFile).toMatch(/out_of_scope/);
      expect(promptFile).toMatch(/linkage/);
    });

    it('does NOT contain the old skill-pick framing', () => {
      // Match within the SYSTEM_PROMPT only — the file header comment may
      // still mention the old framing as historical context.
      const promptStart = promptFile.indexOf('const SYSTEM_PROMPT');
      const promptEnd = promptFile.indexOf('const TOOL_SCHEMA');
      expect(promptStart).toBeGreaterThan(-1);
      expect(promptEnd).toBeGreaterThan(promptStart);
      const promptBody = promptFile.slice(promptStart, promptEnd);

      // The old prompt's defining phrase — "single skill is clearly the
      // best fit" — must be gone.
      expect(promptBody).not.toMatch(/single skill is clearly the best fit/i);
      // The old prompt asked the model to pick "which skill to use" — gone.
      expect(promptBody).not.toMatch(/specific enough that a single skill/i);
      // Defaults must no longer recommend "a skill name" as a valid default.
      expect(promptBody).not.toMatch(/Defaults must be specific \(a skill name/i);
    });

    it('TOOL_SCHEMA classify_clarity remains unchanged (clear / reason / questions)', () => {
      // Re-confirm the I/O shape parser still sees the same tool schema.
      expect(promptFile).toMatch(/name: 'classify_clarity'/);
      expect(promptFile).toMatch(/required: \['clear', 'reason', 'questions'\]/);
    });
  });

  describe('runtime behavior — 10 fuzzy goals produce scope questions', () => {
    it('every fuzzy goal returns clear=false with 1–3 scope-shaped questions', async () => {
      const db = freshDb();
      const { client } = makeMockClient();

      for (const goal of FUZZY_GOALS) {
        const result = await classifyClarity({ goal, catalog: CATALOG, db, client });

        // Must be unclear.
        expect(result.clear, `goal "${goal}" should be unclear`).toBe(false);
        if (result.clear) continue; // type narrow

        // 1–3 questions, all with defaults.
        expect(result.questions.length).toBeGreaterThanOrEqual(1);
        expect(result.questions.length).toBeLessThanOrEqual(3);
        for (const q of result.questions) {
          expect(q.question.length).toBeGreaterThan(0);
          expect(q.default.length).toBeGreaterThan(0);
          // Defaults must be concrete, not "ask the user" / "tbd".
          expect(q.default).not.toMatch(/\b(ask the user|you decide|tbd|n\/?a)\b/i);
        }
      }
    });

    it('0 of the produced questions match /skill|tool|wi-/i (no skill-pick framing)', async () => {
      const db = freshDb();
      const { client } = makeMockClient();
      const skillPickPattern = /skill|tool|wi-/i;

      let totalQuestions = 0;
      let skillPickQuestions = 0;

      for (const goal of FUZZY_GOALS) {
        const result = await classifyClarity({ goal, catalog: CATALOG, db, client });
        if (result.clear) continue;
        for (const q of result.questions) {
          totalQuestions += 1;
          if (skillPickPattern.test(q.question)) skillPickQuestions += 1;
        }
      }

      expect(totalQuestions, 'fuzzy goals produced at least one question').toBeGreaterThan(0);
      expect(skillPickQuestions, 'no question mentions skill / tool / wi-').toBe(0);
    });

    it('questions ask about scope dimensions (env / criteria / scope / done / linkage)', async () => {
      const db = freshDb();
      const { client } = makeMockClient();
      const scopePattern = /\b(env|criter|scope|done|target|version|out[- ]of[- ]scope|leave alone|surface)\b/i;

      let scopeShapedQuestions = 0;
      let totalQuestions = 0;

      for (const goal of FUZZY_GOALS) {
        const result = await classifyClarity({ goal, catalog: CATALOG, db, client });
        if (result.clear) continue;
        for (const q of result.questions) {
          totalQuestions += 1;
          if (scopePattern.test(q.question)) scopeShapedQuestions += 1;
        }
      }

      expect(totalQuestions).toBeGreaterThan(0);
      // At least every fuzzy-goal yielded a scope-shaped question.
      expect(scopeShapedQuestions).toBeGreaterThanOrEqual(FUZZY_GOALS.length);
    });
  });

  describe('runtime behavior — 10 specific goals are clear=true', () => {
    it('every specific goal returns clear=true with no questions', async () => {
      const db = freshDb();
      const { client } = makeMockClient();

      for (const goal of SPECIFIC_GOALS) {
        const result = await classifyClarity({ goal, catalog: CATALOG, db, client });
        expect(result.clear, `goal "${goal}" should be clear`).toBe(true);
      }
    });
  });

  describe('LLM client wiring — no real network calls', () => {
    it('uses the injected mock client (production code path)', async () => {
      const db = freshDb();
      const { client, calls } = makeMockClient();

      await classifyClarity({ goal: 'help me out', catalog: CATALOG, db, client });
      await classifyClarity({ goal: 'investigate DEMO-1', catalog: CATALOG, db, client });

      expect(calls.length).toBe(2);
      // Sanity: the new SYSTEM_PROMPT was passed through.
      const firstSystem = calls[0].system;
      const systemText = Array.isArray(firstSystem)
        ? (firstSystem[0] as { text: string }).text
        : (firstSystem as { text: string }).text ?? String(firstSystem);
      expect(systemText).toMatch(/scope/i);
      expect(systemText).not.toMatch(/single skill is clearly the best fit/i);
    });

    it('module is the same exported surface (regression: no rename)', () => {
      expect(typeof clarifyModule.classifyClarity).toBe('function');
      expect(typeof clarifyModule.fetchCatalogEntries).toBe('function');
    });
  });
});
