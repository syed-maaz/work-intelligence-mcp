/**
 * § 23 — Cypher PM drift detector smoke (TS).
 *
 * Verifies the drift detector endpoint:
 *   - GET /api/cypher/pm/drift returns the three-bucket shape
 *   - Counts equal item-array lengths per bucket (no silent truncation)
 *   - total == sum of the three bucket counts
 *   - staleDays query param is honored (compared at two thresholds)
 *
 * Note on DB state: this smoke runs against the live DB. We don't seed
 * fake drift entries — instead we assert structural invariants that
 * hold regardless of what's in the table today. If the live DB has
 * zero drift, the bucket counts are 0 and `total === 0`; that's still
 * a passing assertion because the shape is what we're verifying.
 *
 * If we need stronger assertions (e.g. "PM-4 should never be in
 * shipped_no_commit because it has commit 197c5c1 linked"), those go
 * in §§ 23.2+ as positive checks against known-good seeded data.
 */

import { describe, expect, test, beforeAll } from 'vitest';
import { waitForBridge, pmDrift, type DriftResponse } from './client.js';

beforeAll(async () => {
  const up = await waitForBridge({ maxAttempts: 5, intervalMs: 1_000 });
  if (!up) throw new Error('bridge not reachable on /api/status — start it with `npm run web:bridge`');
});

describe('§ 23 — Cypher PM drift detector', () => {
  describe('§ 23.1 — endpoint shape', () => {
    test('§ 23.1.1 — GET /drift returns three buckets + total + generated_at', async () => {
      const r = await pmDrift();
      expect(r.ok).toBe(true);
      const body = r.body as DriftResponse;
      expect(body.stale_in_progress).toBeDefined();
      expect(body.shipped_no_commit).toBeDefined();
      expect(body.dead_file_path).toBeDefined();
      expect(typeof body.total).toBe('number');
      expect(typeof body.generated_at).toBe('string');
      // generated_at should be a parseable ISO timestamp.
      expect(() => new Date(body.generated_at).toISOString()).not.toThrow();
    });

    test('§ 23.1.2 — bucket count equals items array length (no truncation)', async () => {
      const r = await pmDrift();
      expect(r.ok).toBe(true);
      const body = r.body as DriftResponse;
      expect(body.stale_in_progress.count).toBe(body.stale_in_progress.items.length);
      expect(body.shipped_no_commit.count).toBe(body.shipped_no_commit.items.length);
      expect(body.dead_file_path.count).toBe(body.dead_file_path.items.length);
    });

    test('§ 23.1.3 — total equals sum of bucket counts', async () => {
      const r = await pmDrift();
      expect(r.ok).toBe(true);
      const body = r.body as DriftResponse;
      const sum = body.stale_in_progress.count
                + body.shipped_no_commit.count
                + body.dead_file_path.count;
      expect(body.total).toBe(sum);
    });

    test('§ 23.1.4 — every drift item has the right reason for its bucket', async () => {
      const r = await pmDrift();
      expect(r.ok).toBe(true);
      const body = r.body as DriftResponse;
      for (const it of body.stale_in_progress.items) expect(it.reason).toBe('stale_in_progress');
      for (const it of body.shipped_no_commit.items) expect(it.reason).toBe('shipped_no_commit');
      for (const it of body.dead_file_path.items)    expect(it.reason).toBe('dead_file_path');
    });
  });

  describe('§ 23.2 — staleDays parameter', () => {
    test('§ 23.2.1 — staleDays=1 yields stale bucket >= staleDays=365 (monotonic threshold)', async () => {
      const tight = await pmDrift(1);
      const loose = await pmDrift(365);
      expect(tight.ok).toBe(true);
      expect(loose.ok).toBe(true);
      const tightCount = (tight.body as DriftResponse).stale_in_progress.count;
      const looseCount = (loose.body as DriftResponse).stale_in_progress.count;
      // Lower staleDays => more items qualify. So tight >= loose.
      expect(tightCount).toBeGreaterThanOrEqual(looseCount);
    });

    test('§ 23.2.2 — staleDays does not affect non-stale buckets', async () => {
      const r1 = await pmDrift(1);
      const r2 = await pmDrift(365);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      const b1 = r1.body as DriftResponse;
      const b2 = r2.body as DriftResponse;
      expect(b1.shipped_no_commit.count).toBe(b2.shipped_no_commit.count);
      expect(b1.dead_file_path.count).toBe(b2.dead_file_path.count);
    });
  });

  describe('§ 23.3 — known-good data is NOT in drift', () => {
    test('§ 23.3.1 — PM-4 is not in shipped_no_commit (commit 197c5c1 was linked)', async () => {
      const r = await pmDrift();
      expect(r.ok).toBe(true);
      const body = r.body as DriftResponse;
      const pm4 = body.shipped_no_commit.items.find(i => i.id === 'PM-4');
      expect(pm4).toBeUndefined();
    });

    test('§ 23.3.2 — every item in shipped_no_commit actually has status=shipped', async () => {
      const r = await pmDrift();
      expect(r.ok).toBe(true);
      const body = r.body as DriftResponse;
      for (const it of body.shipped_no_commit.items) {
        expect(it.status).toBe('shipped');
      }
    });
  });
});
