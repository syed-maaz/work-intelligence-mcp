import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import {
  parseArchitectVerdict,
  buildArchitectPrompt,
  architectReviewLive,
} from '../../../src/services/cypher/architect-review-live.js';
import type { PlanDraft, HydratedBrief } from '../../../src/services/cypher/pm-templates/index.js';

function brief(partial: Partial<HydratedBrief> = {}): HydratedBrief {
  return { goal: 'g', intent: 'build', target: 't', affected_repos: ['example-service', 'example-service'], ...partial };
}

function plan(partial: Partial<PlanDraft> = {}): PlanDraft {
  return {
    sub_tasks: [
      { id: 'be', title: 'BE', posture: 'be', depends_on: [] },
      { id: 'fe', title: 'FE', posture: 'fe', depends_on: ['be'] },
      { id: 'ops', title: 'Ops', posture: 'ops', depends_on: ['fe'] },
    ],
    ...partial,
  };
}

/** Fake Anthropic client: returns the given text content for messages.create. */
function fakeClient(text: string) {
  return {
    messages: {
      create: async () => ({ content: [{ type: 'text', text }] }),
    },
  } as any;
}

describe('architect-review-live — verdict parser', () => {
  it('parses fenced JSON verdict', () => {
    const res = parseArchitectVerdict('```json\n{"verdict":"revise","notes":["add DB migration"]}\n```');
    expect(res.verdict).toBe('revise');
    expect(res.notes).toEqual(['add DB migration']);
  });

  it('parses raw JSON with notes omitted', () => {
    const res = parseArchitectVerdict('{"verdict":"approved"}');
    expect(res.verdict).toBe('approved');
    expect(res.notes).toEqual([]);
  });

  it('throws on unparseable output', () => {
    expect(() => parseArchitectVerdict('no json here')).toThrow();
  });

  it('throws on invalid verdict value', () => {
    expect(() => parseArchitectVerdict('{"verdict":"maybe","notes":[]}')).toThrow(/invalid verdict/);
  });
});

describe('architect-review-live — two-tier review', () => {
  it('deterministic gate: structural revise short-circuits — no LLM call', async () => {
    const db = {} as Database.Database;
    const client = fakeClient('should not be called');
    client.messages.create = async () => {
      throw new Error('LLM must not be invoked for structural revise');
    };
    const res = await architectReviewLive(db, { plan: plan({ sub_tasks: [] }), brief: brief() }, { client });
    expect(res.verdict).toBe('revise');
  });

  it('deterministic gate approves, LLM approves → approved', async () => {
    const db = {} as Database.Database;
    const res = await architectReviewLive(
      db,
      { plan: plan(), brief: brief() },
      { client: fakeClient('{"verdict":"approved","notes":[]}') },
    );
    expect(res.verdict).toBe('approved');
  });

  it('deterministic gate approves, LLM revises with notes → revise', async () => {
    const db = {} as Database.Database;
    const res = await architectReviewLive(
      db,
      { plan: plan(), brief: brief() },
      { client: fakeClient('{"verdict":"revise","notes":["tighten BE contract"]}') },
    );
    expect(res.verdict).toBe('revise');
    expect(res.notes).toEqual(['tighten BE contract']);
  });

  it('LLM transport failure degrades to deterministic approval (advisory pass)', async () => {
    const db = {} as Database.Database;
    const res = await architectReviewLive(
      db,
      { plan: plan(), brief: brief() },
      {
        client: {
          messages: {
            create: async () => {
              throw new Error('rate limited');
            },
          },
        } as any,
      },
    );
    expect(res.verdict).toBe('approved');
    expect(res.notes.join(' ')).toMatch(/unavailable/i);
  });

  it('deterministicOnly skips the LLM pass', async () => {
    const db = {} as Database.Database;
    const res = await architectReviewLive(
      db,
      { plan: plan(), brief: brief() },
      { deterministicOnly: true, client: fakeClient('{"verdict":"revise","notes":["x"]}') },
    );
    expect(res.verdict).toBe('approved');
    expect(res.notes).toEqual([]);
  });

  it('prompt includes plan and brief (coverage signal for the LLM)', () => {
    const p = buildArchitectPrompt({ plan: plan(), brief: brief({ goal: 'Build X' }) });
    expect(p).toMatch(/Goal: Build X/);
    expect(p).toMatch(/"sub_tasks"/);
    expect(p).toMatch(/revise/);
  });
});