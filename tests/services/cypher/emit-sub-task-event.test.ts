import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import migrateV107 from '../../../src/db/migrations/v107_sub_task_events.js';
import { TOOL_CATALOG, toolsForPosture } from '../../../src/services/cypher/tool-catalog.js';

function findTool(name: string) {
  return TOOL_CATALOG.find((t) => t.name === name);
}

describe('emit_sub_task_event tool (ADR-053 Phase 3, Q7 / AC-S6+S7)', () => {
  it('is present in the catalog with phase=execute', () => {
    const t = findTool('emit_sub_task_event');
    expect(t).toBeDefined();
    expect(t?.phase).toBe('execute');
  });

  it('writes a row for a valid kind', async () => {
    const db = new Database(':memory:');
    migrateV107(db);
    const t = findTool('emit_sub_task_event');
    const res = (await t!.handler(
      { sub_task_id: 'tsk_1', kind: 'blocker', payload: { why: 'stuck on API contract' } },
      { db, user: 'maaz', session_id: 'cyp_x', palace: null },
    )) as { ok: boolean; id?: number };
    expect(res.ok).toBe(true);
    const row = db
      .prepare(`SELECT sub_task_id, kind FROM sub_task_events WHERE sub_task_id = 'tsk_1'`)
      .get() as { sub_task_id: string; kind: string };
    expect(row.kind).toBe('blocker');
  });

  it('rejects an invalid kind (returns error, no row)', async () => {
    const db = new Database(':memory:');
    migrateV107(db);
    const t = findTool('emit_sub_task_event');
    const res = (await t!.handler(
      { sub_task_id: 'tsk_2', kind: 'bogus', payload: {} },
      { db, user: 'maaz', session_id: 'cyp_x', palace: null },
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM sub_task_events WHERE sub_task_id = 'tsk_2'`)
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('is NOT eligible for the architect posture (write-tool discipline)', () => {
    const architectTools = toolsForPosture('architect').map((t) => t.name);
    expect(architectTools).not.toContain('emit_sub_task_event');
  });
});
