/**
 * src/lib/retry.ts — Generic retry with exponential backoff.
 *
 * Designed for wrapping Anthropic API calls that can fail with:
 *   - Rate limit (429 / "rate_limit")
 *   - Overload (529 / "overloaded")
 *   - Bad gateway (502 — corporate proxy blip)
 *   - Service unavailable (503)
 *   - SDK offline-detection wrapping ("network error", "offline or connection")
 *   - Transient socket errors (ECONNRESET, ETIMEDOUT, socket hang up)
 *
 * Terminal errors (4xx auth/validation, malformed request, missing key,
 * etc.) are NOT retried — `defaultShouldRetry` only matches the transient
 * shapes above. Callers that need bespoke classification pass a custom
 * `shouldRetry`.
 */

export interface RetryOpts {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in ms before the first retry (default: 1000) */
  baseDelayMs?: number;
  /** Cap on backoff delay in ms (default: 30_000) */
  maxDelayMs?: number;
  /** Return true to retry on this error. Defaults to retrying on common transient errors. */
  shouldRetry?: (err: unknown) => boolean;
}

function defaultShouldRetry(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes('rate') ||
    msg.includes('limit') ||
    msg.includes('overload') ||
    msg.includes('529') ||
    msg.includes('503') ||
    // 502 Bad Gateway — proxy hiccup; SDK reports it as
    // "502 Network error: you are offline or connection may have changed
    // or been interrupted". Match both the status and the SDK wrapping.
    msg.includes('502') ||
    msg.includes('network error') ||
    msg.includes('offline or connection') ||
    msg.includes('connection may have changed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute `fn`, retrying up to `maxAttempts` times with exponential backoff.
 *
 * @example
 * const result = await withRetry(() => analyzer.generateDigest(...));
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1_000,
    maxDelayMs = 30_000,
    shouldRetry = defaultShouldRetry,
  } = opts;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      if (attempt === maxAttempts || !shouldRetry(err)) {
        throw err;
      }

      const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      process.stderr.write(
        `[retry] attempt ${attempt}/${maxAttempts} failed: ${err instanceof Error ? err.message : String(err)} — retrying in ${delayMs}ms\n`
      );
      await sleep(delayMs);
    }
  }

  // Unreachable but satisfies TypeScript
  throw lastErr;
}
