/**
 * SCOPE guard overrun regression (2026-07-15, cyp_b29a0e6f4870).
 *
 * The SCOPE phase ran 132s despite CYPHER_SCOPE_MAX_WALLCLOCK_MS=60000.
 * Root cause: llmCallTimeoutMs() defaulted to 90_000 (> 60s budget) and
 * toolCallTimeoutMs() to 120_000 (2x budget). The between-iterations
 * wall-clock guard cannot interrupt an in-flight await, so a single stalled
 * call outlived the phase guard. The comment CLAIMED the timeout was "clamped
 * at read time to be safe" but the clamp was never written.
 *
 * Fix: clampToBudget() bounds the per-call timeout to (remaining budget −
 * BUDGET_GUARD_MARGIN_MS) whenever a budget is passed. These tests would have
 * failed the day before the fix: llmCallTimeoutMs(30_000) returned 90_000.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  clampToBudget,
  llmCallTimeoutMs,
  toolCallTimeoutMs,
} from '../../src/services/cypher/loop.js';

const MARGIN = 2_000; // BUDGET_GUARD_MARGIN_MS (module-private mirror)

describe('clampToBudget', () => {
  it('returns configured unchanged when no budget passed', () => {
    expect(clampToBudget(90_000)).toBe(90_000);
    expect(clampToBudget(90_000, undefined)).toBe(90_000);
  });

  it('returns configured unchanged when budget <= 0 (guard disabled)', () => {
    expect(clampToBudget(90_000, 0)).toBe(90_000);
    expect(clampToBudget(90_000, -5)).toBe(90_000);
  });

  it('clamps to budget minus margin when configured exceeds budget', () => {
    // THE regression: 90s call under a 60s budget → clamped to 58s.
    expect(clampToBudget(90_000, 60_000)).toBe(60_000 - MARGIN);
  });

  it('clamps to shrinking remaining budget across iterations', () => {
    // Iter 3 with only 10s left → 8s cap, not the 90s default.
    expect(clampToBudget(90_000, 10_000)).toBe(10_000 - MARGIN);
  });

  it('keeps configured when it is already inside the budget', () => {
    // EXECUTE phase: 90s call under a 600s budget → unchanged.
    expect(clampToBudget(90_000, 600_000)).toBe(90_000);
  });

  it('floors at 1ms when remaining budget is below the margin', () => {
    // Never returns 0/negative (which would DISABLE the timeout).
    expect(clampToBudget(90_000, 1_000)).toBe(1);
    expect(clampToBudget(90_000, MARGIN)).toBe(1);
  });

  it('honors the budget cap even when configured is 0 (unbounded)', () => {
    // configured=0 means "unbounded" but a budget was passed → budget wins.
    expect(clampToBudget(0, 60_000)).toBe(60_000 - MARGIN);
  });
});

describe('llmCallTimeoutMs', () => {
  const orig = process.env.CYPHER_LLM_CALL_TIMEOUT_MS;
  afterEach(() => {
    if (orig === undefined) delete process.env.CYPHER_LLM_CALL_TIMEOUT_MS;
    else process.env.CYPHER_LLM_CALL_TIMEOUT_MS = orig;
  });

  it('defaults to 90_000 with no budget', () => {
    delete process.env.CYPHER_LLM_CALL_TIMEOUT_MS;
    expect(llmCallTimeoutMs()).toBe(90_000);
  });

  it('clamps the 90s default below a 60s SCOPE budget (the fix)', () => {
    delete process.env.CYPHER_LLM_CALL_TIMEOUT_MS;
    const t = llmCallTimeoutMs(60_000);
    expect(t).toBeLessThan(60_000);
    expect(t).toBe(60_000 - MARGIN);
  });
});

describe('toolCallTimeoutMs', () => {
  const orig = process.env.CYPHER_TOOL_TIMEOUT_MS;
  afterEach(() => {
    if (orig === undefined) delete process.env.CYPHER_TOOL_TIMEOUT_MS;
    else process.env.CYPHER_TOOL_TIMEOUT_MS = orig;
  });

  it('defaults to 120_000 with no budget', () => {
    delete process.env.CYPHER_TOOL_TIMEOUT_MS;
    expect(toolCallTimeoutMs()).toBe(120_000);
  });

  it('clamps the 120s default below a 60s SCOPE budget (the fix)', () => {
    delete process.env.CYPHER_TOOL_TIMEOUT_MS;
    const t = toolCallTimeoutMs(60_000);
    expect(t).toBeLessThan(60_000);
    expect(t).toBe(60_000 - MARGIN);
  });
});
