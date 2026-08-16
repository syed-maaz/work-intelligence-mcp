/**
 * D17 contract evolution tests — ADR-038 v2.5 (2026-06-26).
 *
 * The wi_dispatch tool input/output schemas are defined in
 * src/tools/manifest.ts (zod). These tests verify the schemas accept
 * the new optional fields (taskId, project, surface_tier,
 * contract_version) and validate the result_meta envelope shape.
 *
 * Bridge-level integration (the actual buildResultMeta behaviour) is
 * smoke-tested at § 31.
 */

import { describe, it, expect } from 'vitest';
import { TOOL_MANIFEST } from '../../src/tools/manifest.js';

const wiDispatch = TOOL_MANIFEST.find(t => t.name === 'wi_dispatch')!;

describe('D17 wi_dispatch inputSchema accepts new optional fields', () => {
  it('accepts a v2.0 caller (no new fields)', () => {
    const parsed = wiDispatch.inputSchema.parse({ goal: 'test' });
    expect(parsed.goal).toBe('test');
    expect((parsed as { contract_version?: string }).contract_version).toBeUndefined();
  });

  it('accepts contract_version=2.0', () => {
    const parsed = wiDispatch.inputSchema.parse({ goal: 'test', contract_version: '2.0' });
    expect((parsed as { contract_version?: string }).contract_version).toBe('2.0');
  });

  it('accepts contract_version=2.5', () => {
    const parsed = wiDispatch.inputSchema.parse({ goal: 'test', contract_version: '2.5' });
    expect((parsed as { contract_version?: string }).contract_version).toBe('2.5');
  });

  it('rejects unknown contract_version', () => {
    expect(() => wiDispatch.inputSchema.parse({ goal: 'test', contract_version: '3.0' })).toThrow();
    expect(() => wiDispatch.inputSchema.parse({ goal: 'test', contract_version: 'v2' })).toThrow();
  });

  it('accepts taskId', () => {
    const parsed = wiDispatch.inputSchema.parse({ goal: 'test', taskId: 'tsk_abc123' });
    expect((parsed as { taskId?: string }).taskId).toBe('tsk_abc123');
  });

  it('accepts project', () => {
    const parsed = wiDispatch.inputSchema.parse({ goal: 'test', project: 'example-service' });
    expect((parsed as { project?: string }).project).toBe('example-service');
  });

  it('accepts surface_tier as 0/1/2/3', () => {
    for (const tier of [0, 1, 2, 3] as const) {
      const parsed = wiDispatch.inputSchema.parse({ goal: 'test', surface_tier: tier });
      expect((parsed as { surface_tier?: number }).surface_tier).toBe(tier);
    }
  });

  it('rejects out-of-range surface_tier', () => {
    expect(() => wiDispatch.inputSchema.parse({ goal: 'test', surface_tier: 4 })).toThrow();
    expect(() => wiDispatch.inputSchema.parse({ goal: 'test', surface_tier: -1 })).toThrow();
  });

  it('accepts all v2.5 fields together', () => {
    const parsed = wiDispatch.inputSchema.parse({
      goal: 'test',
      taskId: 'tsk_xyz',
      project: 'wi',
      surface_tier: 2,
      contract_version: '2.5',
    });
    const p = parsed as { taskId?: string; project?: string; surface_tier?: number; contract_version?: string };
    expect(p.taskId).toBe('tsk_xyz');
    expect(p.project).toBe('wi');
    expect(p.surface_tier).toBe(2);
    expect(p.contract_version).toBe('2.5');
  });

  it('still rejects truly unknown fields (.strict() preserved)', () => {
    expect(() => wiDispatch.inputSchema.parse({ goal: 'test', not_a_real_field: 'x' })).toThrow();
  });
});

describe('D17 wi_dispatch outputSchema permits result_meta envelope', () => {
  it('accepts a v2.0-shaped response (no result_meta)', () => {
    const parsed = wiDispatch.outputSchema.parse({
      session_id: 'cyp_x',
      status: 'done',
      goal: 'test',
      task_class: 'generic',
      ranked_skills: [],
      trace: [],
      summary: '',
      memory_actions: [],
    });
    expect((parsed as { result_meta?: unknown }).result_meta).toBeUndefined();
  });

  it('accepts a v2.5-shaped response with result_meta', () => {
    const parsed = wiDispatch.outputSchema.parse({
      session_id: 'cyp_x',
      status: 'done',
      goal: 'test',
      task_class: 'generic',
      ranked_skills: [],
      trace: [],
      summary: '',
      memory_actions: [],
      result_meta: {
        outcome: 'success',
        cypher_session_id: 'cyp_x',
        taskId: 'tsk_y',
        contract_version: '2.5',
      },
    });
    const p = parsed as { result_meta?: { contract_version?: string; taskId?: string } };
    expect(p.result_meta?.contract_version).toBe('2.5');
    expect(p.result_meta?.taskId).toBe('tsk_y');
  });

  it('rejects result_meta with wrong contract_version', () => {
    expect(() => wiDispatch.outputSchema.parse({
      session_id: 'cyp_x',
      status: 'done',
      goal: 'test',
      task_class: 'generic',
      ranked_skills: [],
      trace: [],
      summary: '',
      memory_actions: [],
      result_meta: {
        cypher_session_id: 'cyp_x',
        contract_version: '2.0',  // result_meta is v2.5-only
      },
    })).toThrow();
  });

  it('result_meta cypher_session_id is required', () => {
    expect(() => wiDispatch.outputSchema.parse({
      session_id: 'cyp_x',
      status: 'done',
      goal: 'test',
      task_class: 'generic',
      ranked_skills: [],
      trace: [],
      summary: '',
      memory_actions: [],
      result_meta: {
        contract_version: '2.5',
      },
    })).toThrow();
  });

  it('result_meta accepts all D17 optional fields', () => {
    const parsed = wiDispatch.outputSchema.parse({
      session_id: 'cyp_x',
      status: 'done',
      goal: 'test',
      task_class: 'generic',
      ranked_skills: [],
      trace: [],
      summary: '',
      memory_actions: [],
      result_meta: {
        outcome: 'success',
        cypher_session_id: 'cyp_x',
        taskId: 'tsk_y',
        worktree_path: '/path/to/wt',
        self_assessment: { confidence: 0.9 },
        suspended_dispatch_id: 'cyp_z',
        surface_tier_used: 2,
        contract_version: '2.5',
      },
    });
    expect((parsed as { result_meta?: unknown }).result_meta).toBeDefined();
  });
});
