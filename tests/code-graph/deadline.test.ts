/**
 * Tests for src/services/code-graph/deadline.ts
 *
 * Closes ADR-027 v2 audit finding F-027-1 — hard deadline around
 * indexer.indexRepo / indexer.indexChangedSince so a wedged indexer
 * cannot hold the per-repo lock indefinitely.
 *
 * The contract is:
 *   1. If `inner` resolves before the deadline, the helper resolves to
 *      the inner value (no spurious timeout).
 *   2. If `inner` is still pending when the deadline fires, the helper
 *      rejects with a labelled timeout error so callers can log and
 *      release the surrounding lock.
 *   3. The internal timer is cleared on early resolve so it doesn't
 *      keep the Node event loop pinned.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { withCodeGraphIndexDeadline } from '../../src/services/code-graph/deadline.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('withCodeGraphIndexDeadline', () => {
  it('resolves to the inner value when inner resolves before the deadline', async () => {
    const inner = Promise.resolve(42);
    const result = await withCodeGraphIndexDeadline(inner, 'unit-test fast', 200);
    expect(result).toBe(42);
  });

  it('rejects with a labelled timeout error when inner hangs past the deadline', async () => {
    // 200ms hang vs 50ms deadline → deadline must win.
    const slow = new Promise<number>(resolve => {
      setTimeout(() => resolve(99), 200);
    });

    await expect(
      withCodeGraphIndexDeadline(slow, 'unit-test hang', 50),
    ).rejects.toThrow(/code-graph indexer deadline exceeded \(50ms\): unit-test hang/);
  });

  it('clears the deadline timer when inner resolves early (no leaked timers)', async () => {
    vi.useFakeTimers();

    // Inner resolves synchronously (microtask), so the timer should be
    // scheduled but cleared by the .finally() before it can fire.
    const inner = Promise.resolve('done');

    const promise = withCodeGraphIndexDeadline(inner, 'unit-test cleanup', 10_000);
    const value = await promise;

    expect(value).toBe('done');
    // After the helper has settled, no pending timers should remain.
    // If the timer leaks, vitest would still see it scheduled.
    expect(vi.getTimerCount()).toBe(0);
  });
});
