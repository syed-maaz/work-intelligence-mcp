/**
 * tests/lib/ai-enrichment.test.ts — unit tests for runWithAIEnrichment.
 *
 * ADR reference: docs/docs/adr/adr-041-ai-optional-enrichment-layer.md
 * Substrate ACs covered: AC-S1.
 */

import { describe, it, expect, vi } from 'vitest';
import { runWithAIEnrichment, ttlForStatus, AI_UNAVAILABLE_BANNER } from '../../src/lib/ai-enrichment.js';

describe('runWithAIEnrichment', () => {
  it('returns status=full when enrichment succeeds', async () => {
    const result = await runWithAIEnrichment(
      () => ({ count: 5 }),
      async (data) => `AI summary: ${data.count} items`,
    );

    expect(result.status).toBe('full');
    expect(result.data).toEqual({ count: 5 });
    expect(result.markdown).toBe('AI summary: 5 items');
    expect(result.aiError).toBeUndefined();
  });

  it('returns status=unavailable when enrichment throws', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await runWithAIEnrichment(
      () => ({ count: 5 }),
      async () => { throw new Error('502 Bad Gateway'); },
      { label: 'test-tool' },
    );

    expect(result.status).toBe('unavailable');
    expect(result.data).toEqual({ count: 5 });
    expect(result.markdown).toBe('');
    expect(result.aiError).toBe('502 Bad Gateway');

    // Deterministic data is still there — the whole point of the ADR
    expect(result.data.count).toBe(5);

    // Failure logged to stderr with label
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[test-tool]'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('502 Bad Gateway'));

    stderr.mockRestore();
  });

  it('returns status=unavailable when enrichment times out', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await runWithAIEnrichment(
      () => ({ count: 5 }),
      () => new Promise<string>((resolve) => setTimeout(() => resolve('too late'), 500)),
      { timeoutMs: 50, label: 'timeout-test' },
    );

    expect(result.status).toBe('unavailable');
    expect(result.data).toEqual({ count: 5 });
    expect(result.markdown).toBe('');
    expect(result.aiError).toMatch(/timeout after 50ms/);

    stderr.mockRestore();
  });

  it('propagates deterministic errors (does NOT catch them)', async () => {
    await expect(
      runWithAIEnrichment(
        () => { throw new Error('SQLite is down'); },
        async () => 'unreachable',
      ),
    ).rejects.toThrow('SQLite is down');
  });

  it('accepts async deterministic functions', async () => {
    const result = await runWithAIEnrichment(
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { async: true };
      },
      async (data) => `got ${JSON.stringify(data)}`,
    );

    expect(result.status).toBe('full');
    expect(result.data).toEqual({ async: true });
  });

  it('never returns an error string as markdown (contract check)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await runWithAIEnrichment(
      () => ({}),
      async () => { throw new Error('anything'); },
    );

    // The critical anti-pattern check: markdown must be empty on failure,
    // NOT "(AI summary unavailable: …)". This is what prevents the
    // cache-poisoning bug from 2026-07-06 05:46.
    expect(result.markdown).toBe('');
    expect(result.markdown).not.toMatch(/AI summary unavailable/);
    expect(result.markdown).not.toMatch(/502/);

    stderr.mockRestore();
  });
});

describe('ttlForStatus', () => {
  it('returns 3600s for full', () => {
    expect(ttlForStatus('full')).toBe(3600);
  });

  it('returns 900s for partial', () => {
    expect(ttlForStatus('partial')).toBe(900);
  });

  it('returns 300s for unavailable', () => {
    expect(ttlForStatus('unavailable')).toBe(300);
  });

  it('encodes "fallback recovers ~5min after proxy returns" as the unavailable TTL', () => {
    // Regression fence: the 2026-07-06 bug cached the error for 1h.
    // If someone raises this back to 3600, they must update the ADR.
    expect(ttlForStatus('unavailable')).toBeLessThanOrEqual(600);
  });
});

describe('AI_UNAVAILABLE_BANNER', () => {
  it('does NOT leak underlying error details', () => {
    // The banner is a stable, reassuring string. Error details go to stderr,
    // not to the user. Regression fence against re-adding "(502: ...)".
    expect(AI_UNAVAILABLE_BANNER).not.toMatch(/502/);
    expect(AI_UNAVAILABLE_BANNER).not.toMatch(/offline/);
    expect(AI_UNAVAILABLE_BANNER).not.toMatch(/error/i);
  });

  it('starts with markdown blockquote so it renders visually distinct', () => {
    expect(AI_UNAVAILABLE_BANNER.startsWith('> ')).toBe(true);
  });

  it('mentions retry so the user knows to wait, not manually fix', () => {
    expect(AI_UNAVAILABLE_BANNER).toMatch(/retry/i);
  });
});
