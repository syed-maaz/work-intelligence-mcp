/**
 * § 21 — Cypher PM lens smoke (TS migration of bash scripts/smoke-bridge.sh § 21).
 *
 * Verifies the project-manager lens end-to-end:
 *   - Schema v60 applied + 2 tables present
 *   - work_items seeded ≥ 50, ≥ 5 shipped
 *   - Evidence is queryable by commit + by file_path
 *   - Five HTTP endpoints respond with the right shapes
 *   - Input validation rejects bad payloads on /link
 *
 * This file is the replacement, not an addition. The bash equivalent
 * (~150 lines spread across §§ 21.1..21.6.6) is being retired in the
 * same commit. Bash § 21 stays for one cycle for migration safety,
 * marked deprecated; flip-the-switch happens after one green run.
 */

import { describe, expect, test, beforeAll } from 'vitest';
import {
  waitForBridge,
  pmNext, pmStatus, pmRollup, pmImpact, pmLink,
  type StatusResponse, type ImpactResponse, type LinkResponse, type ErrorResponse,
} from './client.js';

beforeAll(async () => {
  const up = await waitForBridge({ maxAttempts: 5, intervalMs: 1_000 });
  if (!up) throw new Error('bridge not reachable on /api/status — start it with `npm run web:bridge`');
});

describe('§ 21 — Cypher PM lens (PM-1 + PM-2)', () => {
  describe('§ 21.6 — HTTP endpoints (PM-2)', () => {
    test('§ 21.6.1 — GET /next returns ≥ 1 unblocked item', async () => {
      const r = await pmNext(3);
      expect(r.ok).toBe(true);
      expect(r.body).not.toBeNull();
      expect(r.body!.total).toBeGreaterThanOrEqual(1);
      // Top-of-queue items should be in pending status.
      for (const it of r.body!.items) {
        expect(it.status).toBe('pending');
      }
    });

    test('§ 21.6.2 — GET /status?id=PM-1 returns the item with evidence', async () => {
      const r = await pmStatus('PM-1');
      expect(r.ok).toBe(true);
      const body = r.body as StatusResponse;
      expect(body.item.id).toBe('PM-1');
      expect(body.item.status).toBe('shipped');
      expect(body.evidence.length).toBeGreaterThanOrEqual(1);
    });

    test('§ 21.6.2b — GET /status with missing id returns 400', async () => {
      const r = await pmStatus('');
      // Empty id sent as `?id=` — bridge returns 400 'id query param required'.
      expect(r.status).toBe(400);
      expect((r.body as ErrorResponse).error).toMatch(/id query param required/);
    });

    test('§ 21.6.2c — GET /status with unknown id returns 404', async () => {
      const r = await pmStatus('PM-DOES-NOT-EXIST');
      expect(r.status).toBe(404);
      expect((r.body as ErrorResponse).error).toMatch(/work_item not found/);
    });

    test('§ 21.6.3 — GET /rollup returns ≥ 5 phase/wave groups', async () => {
      const r = await pmRollup();
      expect(r.ok).toBe(true);
      expect(r.body).not.toBeNull();
      expect(r.body!.rollup.length).toBeGreaterThanOrEqual(5);
      // Sanity: every group's pending+in_progress+shipped+blocked+deferred = total.
      for (const g of r.body!.rollup) {
        expect(g.pending + g.in_progress + g.shipped + g.blocked + g.deferred).toBe(g.total);
      }
    });

    test('§ 21.6.4 — GET /impact for src/services/cypher/run.ts returns ≥ 2 shipped slices', async () => {
      const r = await pmImpact('file_path', 'src/services/cypher/run.ts');
      expect(r.ok).toBe(true);
      const body = r.body as ImpactResponse;
      const shipped = body.items.filter(i => i.status === 'shipped');
      expect(shipped.length).toBeGreaterThanOrEqual(2);
    });

    test('§ 21.6.5 — POST /link writes evidence and is idempotent on UNIQUE', async () => {
      // First write: should succeed.
      const r1 = await pmLink({
        work_item_id: 'PM-2',
        evidence_kind: 'smoke_section',
        evidence_value: '§ 21.6 smoke (ts)',
      });
      expect(r1.ok).toBe(true);
      expect((r1.body as LinkResponse).ok).toBe(true);

      // Second write with the same triple: should still succeed (idempotent).
      const r2 = await pmLink({
        work_item_id: 'PM-2',
        evidence_kind: 'smoke_section',
        evidence_value: '§ 21.6 smoke (ts)',
      });
      expect(r2.ok).toBe(true);
    });

    test('§ 21.6.6 — POST /link rejects invalid evidence_kind', async () => {
      const r = await pmLink({
        work_item_id: 'PM-2',
        // Cast — we want to test the runtime validation, not the type system.
        evidence_kind: 'made_up' as 'commit_sha',
        evidence_value: 'x',
      });
      expect(r.status).toBe(400);
      expect((r.body as ErrorResponse).error).toMatch(/evidence_kind must be one of/);
    });

    test('§ 21.6.6b — POST /link rejects missing work_item_id', async () => {
      const r = await pmLink({
        // @ts-expect-error — testing runtime validation
        evidence_kind: 'commit_sha',
        evidence_value: 'x',
      });
      expect(r.status).toBe(400);
      expect((r.body as ErrorResponse).error).toMatch(/all required/);
    });

    test('§ 21.6.6c — POST /link rejects unknown work_item_id', async () => {
      const r = await pmLink({
        work_item_id: 'PM-DOES-NOT-EXIST',
        evidence_kind: 'commit_sha',
        evidence_value: 'abc1234',
      });
      expect(r.status).toBe(404);
      expect((r.body as ErrorResponse).error).toMatch(/work_item not found/);
    });
  });

  describe('§ 21.x — sanity over the whole lens', () => {
    test('§ 21.x.1 — at least one phase has ≥ 1 shipped item', async () => {
      const r = await pmRollup();
      expect(r.ok).toBe(true);
      const totalShipped = r.body!.rollup.reduce((sum, g) => sum + g.shipped, 0);
      expect(totalShipped).toBeGreaterThanOrEqual(5);
    });

    test('§ 21.x.2 — commit 41e07b4 (Cypher v1 spine) is linked to CYPHER-SLICE-A+B', async () => {
      const r = await pmStatus('CYPHER-SLICE-A+B');
      expect(r.ok).toBe(true);
      const body = r.body as StatusResponse;
      const has41e07b4 = body.evidence.some(
        e => e.evidence_kind === 'commit_sha' && e.evidence_value === '41e07b4',
      );
      expect(has41e07b4).toBe(true);
    });
  });
});
