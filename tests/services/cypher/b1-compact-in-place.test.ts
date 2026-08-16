/**
 * Tests for the B1 in-place compaction helpers in src/services/cypher/loop.ts.
 *
 * These exercise the pure-function contracts of `extractCompactSummary`
 * (parse the tool_result shape) and `compactMessagesInPlace` (mutate
 * the loop's messages array). The full integration — wiring the helpers
 * into the iteration recording pass after a successful
 * cypher_compact_context call — is exercised by smoke when the bridge
 * runs a dispatch that hits the tool. These tests cover the unit
 * contracts so a regression in the helper is caught without booting
 * the loop.
 *
 * ADR-038 v2.5 B1 (2026-06-28).
 */

import { describe, it, expect } from 'vitest';
import {
  compactMessagesInPlace,
  extractCompactSummary,
} from '../../../src/services/cypher/loop.js';
import type Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// extractCompactSummary
// ---------------------------------------------------------------------------

describe('extractCompactSummary', () => {
  it('returns the summary text on a happy-path tool result', () => {
    const out = extractCompactSummary({
      summary: 'old context distilled',
      instruction: 'treat as canonical',
    });
    expect(out).toBe('old context distilled');
  });

  it('returns null on the error-shape tool result', () => {
    const out = extractCompactSummary({
      error: 'compact_failed',
      message: 'no api key',
    });
    expect(out).toBeNull();
  });

  it('returns null on null / non-object input', () => {
    expect(extractCompactSummary(null)).toBeNull();
    expect(extractCompactSummary(undefined)).toBeNull();
    expect(extractCompactSummary('summary as string')).toBeNull();
    expect(extractCompactSummary(42)).toBeNull();
  });

  it('returns null when summary is empty string', () => {
    expect(extractCompactSummary({ summary: '' })).toBeNull();
  });

  it('returns null when summary is non-string', () => {
    expect(extractCompactSummary({ summary: 42 })).toBeNull();
    expect(extractCompactSummary({ summary: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// compactMessagesInPlace
// ---------------------------------------------------------------------------

/**
 * Build a fake messages array shaped like what runLoop accumulates:
 *   index 0:       initial user goal
 *   index 1,3,5..: assistant turns (text + tool_use blocks)
 *   index 2,4,6..: user turns (tool_result blocks)
 */
function buildMessages(iter_pairs: number): Anthropic.Messages.MessageParam[] {
  const msgs: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: 'initial goal' },
  ];
  for (let i = 0; i < iter_pairs; i++) {
    msgs.push({ role: 'assistant', content: `assistant turn ${i}` });
    msgs.push({ role: 'user', content: `tool result ${i}` });
  }
  return msgs;
}

describe('compactMessagesInPlace', () => {
  it('mutates a long messages array and returns true', () => {
    // 1 initial + 10 pairs = 21 entries. Compact should shrink to 8:
    // initial(1) + synthetic(1) + last 3 pairs(6) = 8.
    const msgs = buildMessages(10);
    expect(msgs.length).toBe(21);

    const mutated = compactMessagesInPlace(msgs, 'distilled context');

    expect(mutated).toBe(true);
    expect(msgs.length).toBe(8);
    expect(msgs[0]).toEqual({ role: 'user', content: 'initial goal' });
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toContain('[compacted: distilled context]');
    // Last 6 entries should be the final 3 iteration pairs unchanged.
    expect(msgs[2].content).toBe('assistant turn 7');
    expect(msgs[3].content).toBe('tool result 7');
    expect(msgs[4].content).toBe('assistant turn 8');
    expect(msgs[5].content).toBe('tool result 8');
    expect(msgs[6].content).toBe('assistant turn 9');
    expect(msgs[7].content).toBe('tool result 9');
  });

  it('no-ops on a short messages array (<= 8 entries) and returns false', () => {
    // 1 initial + 3 pairs = 7 entries. Below the threshold; no compaction.
    const msgs = buildMessages(3);
    const before = JSON.stringify(msgs);
    expect(msgs.length).toBe(7);

    const mutated = compactMessagesInPlace(msgs, 'distilled context');

    expect(mutated).toBe(false);
    expect(JSON.stringify(msgs)).toBe(before);
  });

  it('no-ops at the threshold (exactly 8 entries) and returns false', () => {
    // 1 initial + 3 pairs + 1 trailing assistant = 8 entries. The
    // compacted shape would also be 8 entries; running it would just
    // throw away middle content for zero shrinkage. Guard against that.
    const msgs = buildMessages(3);
    msgs.push({ role: 'assistant', content: 'trailing assistant' });
    expect(msgs.length).toBe(8);

    const mutated = compactMessagesInPlace(msgs, 'distilled context');

    expect(mutated).toBe(false);
    expect(msgs.length).toBe(8);
  });

  it('no-ops on empty summary and returns false', () => {
    const msgs = buildMessages(10);
    const before_len = msgs.length;

    const mutated = compactMessagesInPlace(msgs, '');

    expect(mutated).toBe(false);
    expect(msgs.length).toBe(before_len);
  });

  it('truncates the synthetic compaction text at 4000 characters', () => {
    const msgs = buildMessages(10);
    const huge = 'x'.repeat(10_000);

    const mutated = compactMessagesInPlace(msgs, huge);
    expect(mutated).toBe(true);

    const synthetic = msgs[1].content;
    expect(typeof synthetic).toBe('string');
    // The wrapper '[compacted: ]' adds 13 chars on top of the summary slice.
    expect((synthetic as string).length).toBeLessThanOrEqual(4000 + 14);
    expect(synthetic).toMatch(/^\[compacted: x+\]$/);
  });

  it('preserves the initial user goal as message[0] after compaction', () => {
    const msgs = buildMessages(10);
    const initial = msgs[0];

    compactMessagesInPlace(msgs, 'summary');

    expect(msgs[0]).toBe(initial);
  });
});
