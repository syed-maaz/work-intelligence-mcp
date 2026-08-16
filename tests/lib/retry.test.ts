/**
 * tests/lib/retry.test.ts — withRetry classifier + behavior.
 *
 * Covers the transient-vs-terminal classification table and the
 * single-retry contract callers depend on (daily-summary.ts,
 * teams-updates.ts, search-all.ts):
 *
 *   - 502 / 503 / 529 → retry
 *   - SDK "offline or connection" wrapping → retry
 *   - rate / limit / overload → retry
 *   - ECONNRESET / ETIMEDOUT / socket hang up → retry
 *   - 4xx auth / validation → do NOT retry (terminal)
 *   - retry exactly once when maxAttempts=2 (callers' chosen config)
 *   - rethrows the last error when retries are exhausted
 */
import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../../src/lib/retry.js';

describe('withRetry — defaultShouldRetry classifier', () => {
  // Each row: [label, errorMessage, expectedAttempts]
  // maxAttempts=2 means: 1 initial + 1 retry = 2 attempts total on transient.
  const transientCases: Array<[string, string]> = [
    ['502 Bad Gateway', '502 Bad Gateway'],
    ['SDK offline wrapping', '502 Network error: you are offline or connection may have changed or been interrupted'],
    ['"connection may have changed"', 'connection may have changed'],
    ['503 Service Unavailable', '503 Service Unavailable'],
    ['529 Overloaded', '529 overloaded_error'],
    ['rate_limit_error', 'rate_limit_error from upstream'],
    ['ECONNRESET', 'request to api.anthropic.com failed, reason: ECONNRESET'],
    ['ETIMEDOUT', 'fetch failed: ETIMEDOUT'],
    ['socket hang up', 'socket hang up'],
  ];

  for (const [label, message] of transientCases) {
    it(`retries on transient: ${label}`, async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        throw new Error(message);
      });
      await expect(
        withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 }),
      ).rejects.toThrow(message);
      expect(attempts).toBe(2); // 1 initial + 1 retry
    });
  }

  const terminalCases: Array<[string, string]> = [
    ['401 unauthorized', '401 authentication_error: invalid x-api-key'],
    ['400 bad request', '400 invalid_request_error: messages.0.content is required'],
    ['403 forbidden', '403 permission_error'],
    ['404 not found', '404 not_found_error'],
    ['JSON parse', 'Unexpected token < in JSON at position 0'],
    ['no api key', 'ANTHROPIC_API_KEY is not set'],
  ];

  for (const [label, message] of terminalCases) {
    it(`does NOT retry on terminal: ${label}`, async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        throw new Error(message);
      });
      await expect(
        withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 }),
      ).rejects.toThrow(message);
      expect(attempts).toBe(1); // no retry on terminal
    });
  }
});

describe('withRetry — behavior contract', () => {
  it('returns the value on first success without retrying', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns the value when the first call fails transiently and the retry succeeds', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error('502 Bad Gateway');
      return 'ok-after-retry';
    });
    const result = await withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 });
    expect(result).toBe('ok-after-retry');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rethrows the LAST error when retries are exhausted (callers can read err.message in their catch)', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      throw new Error(`502 attempt ${attempts}`);
    });
    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 }),
    ).rejects.toThrow('502 attempt 2');
    expect(attempts).toBe(2);
  });

  it('respects a custom shouldRetry predicate', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      throw new Error('custom-transient-marker');
    });
    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 1,
        shouldRetry: (err) => String((err as Error).message).includes('custom-transient-marker'),
      }),
    ).rejects.toThrow('custom-transient-marker');
    expect(attempts).toBe(3); // 1 initial + 2 retries
  });

  it('case-insensitive message matching ("OFFLINE OR CONNECTION" works)', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      throw new Error('OFFLINE OR CONNECTION dropped');
    });
    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 }),
    ).rejects.toThrow();
    expect(attempts).toBe(2);
  });
});
