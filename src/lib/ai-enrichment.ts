/**
 * src/lib/ai-enrichment.ts — Run AI enrichment on top of deterministic data
 * with structural fallback on failure.
 *
 * Contract:
 *   Every WI tool that generates user-facing content follows a three-tier model:
 *     Tier 1 — deterministic data (SQLite) ALWAYS renders
 *     Tier 2 — AI narrative renders ON TOP when available
 *     Tier 3 — visible banner declares degraded mode when AI unavailable
 *
 *   `runWithAIEnrichment` is the enforcement point. Callers pass a
 *   deterministic data computer + an AI enrichment function; the helper
 *   guarantees the deterministic data is always returned, and reports the
 *   enrichment status to the caller so it can render appropriately + set
 *   the cache TTL.
 *
 *   AI helpers MUST throw on failure. Never return error strings — that's
 *   in-band signaling and produces cache-poisoning (see ADR-041 § Failure
 *   mode 2). This helper enforces the boundary: it catches, the AI helper
 *   propagates.
 *
 * ADR reference: docs/docs/adr/adr-041-ai-optional-enrichment-layer.md
 * Bug that triggered this: 2026-07-06 05:46 UTC dashboard poison-cache.
 */

/** Status of the enrichment attempt. */
export type EnrichmentStatus = 'full' | 'partial' | 'unavailable';

/** Result carrier — deterministic data always present; markdown/status describe the AI layer. */
export interface EnrichmentResult<T> {
  /** Deterministic data — always present regardless of AI outcome. */
  data: T;
  /** AI-generated markdown. Empty string when status !== 'full'. */
  markdown: string;
  /** Whether AI enrichment succeeded, partially succeeded, or failed. */
  status: EnrichmentStatus;
  /** When status === 'unavailable', the underlying error message (for stderr / observability, NOT for user rendering). */
  aiError?: string;
}

export interface EnrichmentOpts {
  /** Hard deadline on the AI call in ms (default: 30_000). Ensures a hung Anthropic call cannot block the request handler indefinitely — companion to the "bridge must never block" rule. */
  timeoutMs?: number;
  /** Optional label for stderr logging on failure (e.g. 'daily-summary', 'teams-updates'). */
  label?: string;
}

/**
 * Run deterministic data + AI enrichment with structural fallback.
 *
 * @param deterministic  Function that computes the tier-1 data (from SQLite). Never throws under normal operation; if it does, the error propagates to the caller (deterministic failures are real bugs, not enrichment failures).
 * @param enrich         Function that takes the deterministic data and produces AI markdown. MUST throw on Anthropic/proxy errors — do NOT return error strings.
 * @param opts           Timeout + logging.
 *
 * @returns `{ data, markdown, status, aiError? }`. Always resolves — never rejects for enrichment failures. Only rejects if `deterministic()` itself throws.
 *
 * @example
 *   const result = await runWithAIEnrichment(
 *     () => computeDailySummaryData(db, today, yesterday),
 *     (data) => enrichDailySummary(data, apiKey),
 *     { timeoutMs: 30_000, label: 'daily-summary' },
 *   );
 *   const ttl = result.status === 'full' ? 3600 : 300;
 *   // render tier 1 always; render tier 2 markdown only when status === 'full'; show banner otherwise
 */
export async function runWithAIEnrichment<T>(
  deterministic: () => T | Promise<T>,
  enrich: (data: T) => Promise<string>,
  opts: EnrichmentOpts = {},
): Promise<EnrichmentResult<T>> {
  const { timeoutMs = 30_000, label = 'ai-enrichment' } = opts;

  // Tier 1 — deterministic. Errors here are real bugs; let them propagate.
  const data = await deterministic();

  // Tier 2 — AI enrichment with hard deadline. On any failure (throw or
  // timeout), fall through to unavailable + let caller render Tier 1 alone.
  let timer: NodeJS.Timeout | undefined;
  try {
    const markdown = await Promise.race([
      enrich(data),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`ai enrichment timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { data, markdown, status: 'full' };
  } catch (err) {
    const aiError = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[${label}] AI enrichment unavailable, falling back to deterministic: ${aiError}\n`);
    return { data, markdown: '', status: 'unavailable', aiError };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Banner text to prepend to Tier 1 markdown when status !== 'full'.
 *
 * Deliberately generic — does NOT embed the underlying error message (that
 * goes to stderr / observability). Deliberately reassuring — "retrying
 * automatically" is true because callers set a short cache TTL on fallback.
 */
export const AI_UNAVAILABLE_BANNER =
  '> _AI enrichment temporarily unavailable — showing raw data. Retrying automatically._\n';

/**
 * Recommended cache TTL in seconds based on enrichment status.
 * Callers pass this to their cache layer.
 *
 * Rationale:
 *   - 'full'        → 1h  (matches pre-ADR-041 behavior; AI cost is real, results are good)
 *   - 'partial'     → 15min (short-ish; some sections may recover on retry)
 *   - 'unavailable' → 5min (short; auto-recover ~5min after the proxy returns)
 */
export function ttlForStatus(status: EnrichmentStatus): number {
  switch (status) {
    case 'full': return 3600;
    case 'partial': return 900;
    case 'unavailable': return 300;
  }
}
