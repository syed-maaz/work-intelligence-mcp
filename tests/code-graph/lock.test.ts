/**
 * Tests for src/services/code-graph/lock.ts
 *
 * Closes ADR-027 v2 Path B item #3 — deterministic race closure for the
 * code-graph indexer lock. Smoke § 10c probes this with two parallel HTTP
 * POSTs but the gate is timing-dependent; the smoke can't tell a (202, 202)
 * timing miss from a (202, 202) genuine regression. This test calls the
 * lock function twice synchronously inside one event-loop turn and asserts
 * the expected (ok, busy) contract.
 *
 * The contract is: when N concurrent callers attempt to claim the lock for
 * overlapping repo sets, exactly ONE caller can win each repo. Anyone who
 * touches `tryAcquireCodeGraphLock` and breaks that — by reordering the
 * read-pass and write-pass into one loop, by adding an `await` between
 * them, by switching the data structure without preserving the
 * synchronous semantic — must see this test fail loudly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  tryAcquireCodeGraphLock,
  releaseCodeGraphLock,
  isCodeGraphBusy,
  withCodeGraphLock,
  recordCodeGraphBusyRejection,
  getCodeGraphBusyRejections,
  _resetCodeGraphLockForTesting,
} from '../../src/services/code-graph/lock.js';

beforeEach(() => {
  _resetCodeGraphLockForTesting();
});

describe('tryAcquireCodeGraphLock — synchronous all-or-none claim (ADR-027 Path B item #3)', () => {
  it('first call wins; second concurrent call rejects with the busy repo name', () => {
    // The race-fix invariant: TWO synchronous calls in one event-loop turn
    // CANNOT both succeed. The previous (broken) shape allowed exactly that.
    const first = tryAcquireCodeGraphLock(['example-service']);
    const second = tryAcquireCodeGraphLock(['example-service']);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, busy: 'example-service' });
  });

  it('second call gets the lock once the first releases it', () => {
    expect(tryAcquireCodeGraphLock(['example-service'])).toEqual({ ok: true });
    releaseCodeGraphLock(['example-service']);
    expect(tryAcquireCodeGraphLock(['example-service'])).toEqual({ ok: true });
  });

  it('multi-repo claim is atomic — partial overlap rejects without claiming any new repos', () => {
    // First: claim ['example-service']. Second: claim ['example-service', 'ops'].
    // The second MUST reject AND must NOT have set the lock for 'ops'
    // — that's the all-or-none guarantee. If it claimed 'ops' on
    // partial success, a third caller for 'ops' alone would
    // wrongly get rejected.
    expect(tryAcquireCodeGraphLock(['example-service'])).toEqual({ ok: true });

    const partial = tryAcquireCodeGraphLock(['example-service', 'ops']);
    expect(partial).toEqual({ ok: false, busy: 'example-service' });

    // Verification: 'ops' is still free.
    expect(isCodeGraphBusy('ops')).toBe(false);
    expect(tryAcquireCodeGraphLock(['ops'])).toEqual({ ok: true });
  });

  it('multi-repo claim is atomic — claims ALL repos on success', () => {
    expect(tryAcquireCodeGraphLock(['example-service', 'example-service'])).toEqual({ ok: true });
    expect(isCodeGraphBusy('example-service')).toBe(true);
    expect(isCodeGraphBusy('example-service')).toBe(true);

    // Either repo individually now rejects.
    expect(tryAcquireCodeGraphLock(['example-service'])).toEqual({ ok: false, busy: 'example-service' });
    expect(tryAcquireCodeGraphLock(['example-service'])).toEqual({ ok: false, busy: 'example-service' });
  });

  it('releaseCodeGraphLock is idempotent — releasing a non-held repo is a no-op', () => {
    // Claim example-service, release ['example-service', 'example-service']. Should not throw,
    // example-service becomes free, operations stays free.
    tryAcquireCodeGraphLock(['example-service']);
    expect(() => releaseCodeGraphLock(['example-service', 'example-service'])).not.toThrow();
    expect(isCodeGraphBusy('example-service')).toBe(false);
    expect(isCodeGraphBusy('example-service')).toBe(false);
  });

  it('100-way contention: only one caller succeeds when all claim the same repo synchronously', () => {
    // The "100 callers in one tick" stress case. JS is single-threaded so
    // these all run sequentially, but the PROPERTY we're asserting — that
    // only one of N synchronous claimants wins — is what protects us
    // against a multi-handler race in a future world (e.g. someone
    // accidentally adding `await` between read-pass and write-pass).
    const results = Array.from({ length: 100 }, () => tryAcquireCodeGraphLock(['example-service']));
    const successes = results.filter(r => r.ok).length;
    const failures = results.filter(r => !r.ok).length;

    expect(successes).toBe(1);
    expect(failures).toBe(99);
    // Every failure names the right repo.
    for (const r of results) {
      if (!r.ok) expect(r.busy).toBe('example-service');
    }
  });
});

describe('withCodeGraphLock — single-repo wrapper used by the agent tick', () => {
  it('runs the function and releases the lock on success', async () => {
    let ran = false;
    const result = await withCodeGraphLock('example-service', async () => {
      ran = true;
      // Inside the lock, the repo is busy.
      expect(isCodeGraphBusy('example-service')).toBe(true);
      return 42;
    });
    expect(ran).toBe(true);
    expect(result).toBe(42);
    // After the lock returns, repo is free again.
    expect(isCodeGraphBusy('example-service')).toBe(false);
  });

  it('releases the lock on exception', async () => {
    await expect(
      withCodeGraphLock('example-service', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(isCodeGraphBusy('example-service')).toBe(false);
  });

  it('throws if the lock is already held', async () => {
    expect(tryAcquireCodeGraphLock(['example-service'])).toEqual({ ok: true });
    await expect(
      withCodeGraphLock('example-service', async () => 'should not run')
    ).rejects.toThrow(/code-graph busy for repo=example-service/);
  });

  it('shares state with tryAcquireCodeGraphLock — they both use the same Map', () => {
    // The bug we explicitly engineered AGAINST: web-server.js used to define
    // both functions with their own Maps, which would have made
    // tryAcquireCodeGraphLock and withCodeGraphLock invisible to each other.
    // Extracting them into one module forces a single registry.
    expect(tryAcquireCodeGraphLock(['example-service'])).toEqual({ ok: true });
    // withCodeGraphLock must see the lock as held.
    expect(isCodeGraphBusy('example-service')).toBe(true);
    return expect(
      withCodeGraphLock('example-service', async () => 'unreachable')
    ).rejects.toThrow(/code-graph busy/);
  });
});

describe('busy-rejection ring buffer — bounded to 1000 entries', () => {
  it('records each rejection with timestamp and repo', () => {
    recordCodeGraphBusyRejection('example-service');
    recordCodeGraphBusyRejection('example-service');
    const rejections = getCodeGraphBusyRejections();
    expect(rejections).toHaveLength(2);
    expect(rejections[0].repo).toBe('example-service');
    expect(rejections[1].repo).toBe('example-service');
    // ts must be a recent millisecond timestamp.
    expect(rejections[0].ts).toBeGreaterThan(Date.now() - 1000);
    expect(rejections[0].ts).toBeLessThanOrEqual(Date.now());
  });

  it('caps the buffer at 1000 entries (oldest evicted)', () => {
    for (let i = 0; i < 1500; i++) {
      recordCodeGraphBusyRejection(`repo-${i}`);
    }
    const rejections = getCodeGraphBusyRejections();
    expect(rejections).toHaveLength(1000);
    // FIFO eviction — oldest 500 are gone, newest 1000 remain.
    expect(rejections[0].repo).toBe('repo-500');
    expect(rejections[999].repo).toBe('repo-1499');
  });

  it('returns a defensive copy — caller cannot mutate internal state', () => {
    recordCodeGraphBusyRejection('example-service');
    const snapshot = getCodeGraphBusyRejections();
    expect(snapshot).toHaveLength(1);
    // Mutate the returned array — should not affect future reads.
    (snapshot as Array<unknown>).push({ ts: 0, repo: 'pwned' });
    expect(getCodeGraphBusyRejections()).toHaveLength(1);
  });
});
