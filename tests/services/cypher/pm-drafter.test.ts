import { describe, it, expect, vi, afterEach } from 'vitest';
import { draftPlanViaLLM, parsePlanFromText } from '../../../src/services/cypher/pm-drafter.js';
import type { HydratedBrief } from '../../../src/services/cypher/pm-templates/index.js';

const brief: HydratedBrief = {
  goal: 'Implement new endpoint in lotse (FE + BE + Ops)',
  intent: 'build',
  target: 'lotse endpoint',
  affected_repos: ['example-service', 'example-service'],
};

afterEach(() => vi.restoreAllMocks());

describe('pm-drafter — parsePlanFromText', () => {
  it('parses a fenced JSON plan', () => {
    const text = 'here is the plan:\n```json\n{"sub_tasks":[{"id":"be","title":"BE","posture":"be","depends_on":[]}]}\n```\ndone';
    const plan = parsePlanFromText(text);
    expect(plan.sub_tasks).toHaveLength(1);
    expect(plan.sub_tasks[0].id).toBe('be');
  });

  it('parses raw JSON with no fence', () => {
    const text = '{"sub_tasks":[{"id":"a","title":"A","posture":"generic","depends_on":[]}]}';
    expect(parsePlanFromText(text).sub_tasks[0].posture).toBe('generic');
  });

  it('normalizes missing depends_on to empty array and coerces unknown posture to generic', () => {
    const text = '{"sub_tasks":[{"id":"x","title":"X","posture":"weird"}]}';
    const plan = parsePlanFromText(text);
    expect(plan.sub_tasks[0].depends_on).toEqual([]);
    expect(plan.sub_tasks[0].posture).toBe('generic');
  });

  it('throws on unparseable text', () => {
    expect(() => parsePlanFromText('no json here at all')).toThrow(/no.*plan|parse/i);
  });
});

describe('pm-drafter — draftPlanViaLLM (mocked Ollama)', () => {
  it('calls the Ollama endpoint and returns a parsed plan', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        message: {
          content:
            '```json\n{"sub_tasks":[{"id":"be","title":"BE endpoint","posture":"be","depends_on":[]},{"id":"fe","title":"FE","posture":"fe","depends_on":["be"]}]}\n```',
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const plan = await draftPlanViaLLM(brief, undefined, { model: 'gemma4:26b' });
    expect(plan.sub_tasks).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toContain('11434');
  });

  it('includes revise notes in the prompt on a re-draft', async () => {
    let capturedBody = '';
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      capturedBody = init.body;
      return {
        ok: true,
        json: async () => ({
          message: { content: '{"sub_tasks":[{"id":"be","title":"BE","posture":"be","depends_on":[]}]}' },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    await draftPlanViaLLM(brief, ['add an ops sub-task'], { model: 'gemma4:26b' });
    expect(capturedBody).toContain('add an ops sub-task');
  });
});
