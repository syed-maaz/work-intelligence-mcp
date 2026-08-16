import { describe, it, expect } from 'vitest';
import { runPmOrchestrator, type PmDeps } from '../../../src/services/cypher/pm-orchestrator.js';
import type { PlanDraft, HydratedBrief } from '../../../src/services/cypher/pm-templates/index.js';

function brief(partial: Partial<HydratedBrief> = {}): HydratedBrief {
  return {
    goal: 'Implement new endpoint in lotse (FE + BE + Ops)',
    intent: 'build',
    target: 'lotse endpoint',
    affected_repos: ['example-service', 'operations'],
    ...partial,
  };
}

function makeEmitter() {
  const cards: Array<{ id: string; title: string; depends_on: string[] }> = [];
  return {
    cards,
    emit: (card: { id: string; title: string; depends_on: string[] }) => {
      cards.push(card);
      return card.id;
    },
  };
}

describe('PM orchestrator (Phase 2)', () => {
  it('happy path — 3-node cross-repo DAG, architect approves, emits 3 cards', async () => {
    const em = makeEmitter();
    const deps: PmDeps = {
      draftPlan: async () => ({
        sub_tasks: [
          { id: 'be', title: 'BE endpoint', posture: 'be', depends_on: [] },
          { id: 'fe', title: 'FE wiring', posture: 'fe', depends_on: ['be'] },
          { id: 'ops', title: 'Ops deploy', posture: 'ops', depends_on: ['fe'] },
        ],
      }),
      architectReview: () => ({ verdict: 'approved', notes: [] }),
      emitCard: em.emit,
    };
    const res = await runPmOrchestrator(brief(), deps);
    expect(res.ok).toBe(true);
    expect(em.cards).toHaveLength(3);
    const ops = em.cards.find((c) => c.id === 'ops');
    expect(ops?.depends_on).toContain('fe');
  });

  it('cycle in draft → validator rejects → retry succeeds', async () => {
    const em = makeEmitter();
    let call = 0;
    const cyclic: PlanDraft = {
      sub_tasks: [
        { id: 'a', title: 'A', posture: 'be', depends_on: ['b'] },
        { id: 'b', title: 'B', posture: 'fe', depends_on: ['a'] },
        { id: 'ops', title: 'Ops', posture: 'ops', depends_on: [] },
      ],
    };
    const acyclic: PlanDraft = {
      sub_tasks: [
        { id: 'a', title: 'A', posture: 'be', depends_on: [] },
        { id: 'b', title: 'B', posture: 'fe', depends_on: ['a'] },
        { id: 'ops', title: 'Ops', posture: 'ops', depends_on: ['b'] },
      ],
    };
    const deps: PmDeps = {
      draftPlan: async () => (call++ === 0 ? cyclic : acyclic),
      architectReview: () => ({ verdict: 'approved', notes: [] }),
      emitCard: em.emit,
    };
    const res = await runPmOrchestrator(brief(), deps);
    expect(res.ok).toBe(true);
    expect(call).toBeGreaterThanOrEqual(2);
    expect(em.cards).toHaveLength(3);
  });

  it('missing Ops sub-task on cross-repo brief → template rewrites to add one', async () => {
    const em = makeEmitter();
    const deps: PmDeps = {
      draftPlan: async () => ({
        sub_tasks: [
          { id: 'be', title: 'BE', posture: 'be', depends_on: [] },
          { id: 'fe', title: 'FE', posture: 'fe', depends_on: ['be'] },
        ],
      }),
      architectReview: () => ({ verdict: 'approved', notes: [] }),
      emitCard: em.emit,
    };
    const res = await runPmOrchestrator(brief({ affected_repos: ['example-service', 'operations'] }), deps);
    expect(res.ok).toBe(true);
    expect(em.cards.some((c) => /ops/i.test(c.id) || /ops/i.test(c.title))).toBe(true);
  });

  it("architect verdict='revise' with notes → PM re-drafts and re-emits", async () => {
    const em = makeEmitter();
    let drafts = 0;
    let reviews = 0;
    const deps: PmDeps = {
      draftPlan: async () => {
        drafts++;
        return {
          sub_tasks: [
            { id: 'be', title: 'BE', posture: 'be', depends_on: [] },
            { id: 'fe', title: 'FE', posture: 'fe', depends_on: ['be'] },
            { id: 'ops', title: 'Ops', posture: 'ops', depends_on: ['fe'] },
          ],
        };
      },
      architectReview: () => {
        reviews++;
        return reviews === 1
          ? { verdict: 'revise', notes: ['tighten BE contract'] }
          : { verdict: 'approved', notes: [] };
      },
      emitCard: em.emit,
    };
    const res = await runPmOrchestrator(brief(), deps);
    expect(res.ok).toBe(true);
    expect(drafts).toBeGreaterThanOrEqual(2);
    expect(em.cards).toHaveLength(3);
  });

  it('enforces max_cards_per_goal hard stop (nothing committed)', async () => {
    const em = makeEmitter();
    const many: PlanDraft = {
      sub_tasks: Array.from({ length: 12 }, (_, i) => ({
        id: `t${i}`,
        title: `T${i}`,
        posture: 'be' as const,
        depends_on: i === 0 ? [] : [`t${i - 1}`],
      })),
    };
    const deps: PmDeps = {
      draftPlan: async () => many,
      architectReview: () => ({ verdict: 'approved', notes: [] }),
      emitCard: em.emit,
      maxCards: 10,
    };
    const res = await runPmOrchestrator(brief(), deps);
    expect(res.ok).toBe(false);
    expect(res.reason ?? '').toMatch(/max_cards|too many/i);
    expect(em.cards).toHaveLength(0);
  });

  it('commits in topological order and resolves depends_on to committed ids (RADAR emitCard fix)', async () => {
    // The emitter mirrors the bridge: it rewrites the PK to `task_<local-id>`
    // and returns that committed id. Children must reference the committed id
    // of their parent — not the draft-local id.
    const emitted: Array<{ id: string; title: string; depends_on: string[] }> = [];
    const deps: PmDeps = {
      draftPlan: async () => ({
        sub_tasks: [
          { id: 'be', title: 'BE', posture: 'be', depends_on: [] },
          { id: 'fe', title: 'FE', posture: 'fe', depends_on: ['be'] },
          { id: 'ops', title: 'Ops', posture: 'ops', depends_on: ['fe'] },
        ],
      }),
      architectReview: () => ({ verdict: 'approved', notes: [] }),
      emitCard: (card) => {
        emitted.push(card);
        return `task_${card.id}`;
      },
    };
    const res = await runPmOrchestrator(brief(), deps);
    expect(res.ok).toBe(true);
    // Emit order: parents first.
    expect(emitted.map((c) => c.id)).toEqual(['be', 'fe', 'ops']);
    // Children reference committed parent ids.
    const fe = emitted.find((c) => c.id === 'fe');
    const ops = emitted.find((c) => c.id === 'ops');
    expect(fe?.depends_on).toEqual(['task_be']);
    expect(ops?.depends_on).toEqual(['task_fe']);
    // Result cards carry the committed ids.
    expect(res.cards?.map((c) => c.id)).toEqual(['task_be', 'task_fe', 'task_ops']);
  });

  it('emitCard failure fails the whole plan instead of committing a broken DAG (RADAR emitCard fix)', async () => {
    const deps: PmDeps = {
      draftPlan: async () => ({
        sub_tasks: [
          { id: 'be', title: 'BE', posture: 'be', depends_on: [] },
          { id: 'fe', title: 'FE', posture: 'fe', depends_on: ['be'] },
        ],
      }),
      architectReview: () => ({ verdict: 'approved', notes: [] }),
      emitCard: () => {
        throw new Error('UNIQUE constraint failed: tasks.id');
      },
    };
    const res = await runPmOrchestrator(brief(), deps);
    expect(res.ok).toBe(false);
    expect(res.reason ?? '').toMatch(/card emit failed/i);
    expect(res.cards).toBeUndefined();
  });
});
