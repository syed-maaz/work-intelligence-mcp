/**
 * Phase 71-02 — Per-adapter circuit breaker (T-71-01 mitigation).
 *
 * Prevents external API failures (GitHub MCP, jira MCP, code-grep child
 * process) from cascading into the verify orchestrator. Each adapter owns its
 * own breaker instance — the breaker state is NOT shared across adapters, so
 * a flaky GitHub MCP cannot trip Jira or code-grep.
 *
 * Behavior:
 *   - 3 consecutive failures → breaker opens for 30s.
 *   - While open, calls fail fast with `CircuitBreakerOpenError` (no fetch).
 *   - First call after the 30s cooldown is a probe; success closes the breaker,
 *     failure restarts the 30s cooldown (but does NOT increment the failure
 *     count beyond the trip threshold — we only need to know it's still bad).
 *   - Successful calls in the closed state reset the consecutive-failure count.
 *
 * The breaker is purely in-process. Restarting web-server.js resets all
 * breakers — this is intentional: a process restart is the operator's signal
 * that they want a fresh attempt.
 */

export const CIRCUIT_FAIL_THRESHOLD = 3;
export const CIRCUIT_OPEN_MS = 30_000;

export class CircuitBreakerOpenError extends Error {
  constructor(public readonly adapterName: string, public readonly retryAt: number) {
    super(
      `circuit breaker open for "${adapterName}" — retry after ${new Date(retryAt).toISOString()}`,
    );
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(public readonly name: string) {}

  /** True iff the breaker is currently open (calls would fail fast). */
  isOpen(now: number = Date.now()): boolean {
    return this.openUntil > now;
  }

  /**
   * Wrap an async fn with the breaker. Throws `CircuitBreakerOpenError` if
   * the breaker is open. Records success/failure on completion.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (this.isOpen(now)) {
      throw new CircuitBreakerOpenError(this.name, this.openUntil);
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_FAIL_THRESHOLD) {
      this.openUntil = Date.now() + CIRCUIT_OPEN_MS;
    }
  }

  /** Test/diagnostic helper. */
  snapshot(): { name: string; consecutiveFailures: number; openUntil: number } {
    return {
      name: this.name,
      consecutiveFailures: this.consecutiveFailures,
      openUntil: this.openUntil,
    };
  }
}

/**
 * Shared verifier result shape. Every adapter returns this, regardless of
 * underlying transport. `evidence` is human-readable; `confidence` is in
 * [0, 1] where 0 = unknown / hard fail and 1 = direct match.
 */
export interface VerifierResult {
  verified: boolean;
  evidence: string;
  confidence: number;
}
