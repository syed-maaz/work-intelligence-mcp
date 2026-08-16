/**
 * Substrate fix #4 — GET /api/system-health/tokens
 *
 * Honest measurement before optimization. Aggregates brain_user_budget_ledger
 * by user × bucket × day; returns rolling 7d/30d totals plus a daily series
 * for charting. Without this, every "we saved X% tokens" claim is a guess.
 *
 * The graphify decline (.planning/ADR-REVIEW.md) noted that token-saving
 * wins must be measurable before they earn integration time. This endpoint
 * is Phase 1 of the post-graphify token strategy: instrument first, optimize
 * second.
 *
 * Cost estimates use Anthropic public pricing as of 2026-05:
 *   claude-sonnet-4-6:   $3.00/M in,  $15.00/M out
 *   claude-haiku-4-5:    $0.80/M in,   $4.00/M out
 *
 * Note: brain_user_budget_ledger does not store the model used, so the cost
 * estimate is a midpoint blend (60% Sonnet / 40% Haiku — rough WI default).
 * For more precise cost accounting, future migrations should add a `model`
 * column to the ledger.
 *
 * Endpoint:
 *   GET /api/system-health/tokens
 *     ?user=<string>     (optional; default = aggregate across all users)
 *     ?windowDays=N      (default 30, max 365)
 *
 * Response:
 *   {
 *     windowDays, generatedAt,
 *     totals: { calls, input_tokens, output_tokens, est_cost_usd },
 *     byBucket: [{ bucket, calls, input_tokens, output_tokens }],
 *     byUser:   [{ user, calls, input_tokens, output_tokens }],
 *     byDay:    [{ day_iso, calls, input_tokens, output_tokens }]
 *   }
 *
 * Refs: .planning/ADR-REVIEW.md graphify+Hermes decline → token strategy phase 1.
 */

import { json } from './_util.js';
import type { RouteHandler } from './_types.js';

const SONNET_IN_USD_PER_M = 3.0;
const SONNET_OUT_USD_PER_M = 15.0;
const HAIKU_IN_USD_PER_M = 0.80;
const HAIKU_OUT_USD_PER_M = 4.0;
// Rough WI default: 60% Sonnet (digest, decide), 40% Haiku (extract).
const SONNET_FRACTION = 0.6;

function blendedCostUsd(inputTokens: number, outputTokens: number): number {
  const inUsd =
    (inputTokens / 1_000_000) * (SONNET_FRACTION * SONNET_IN_USD_PER_M + (1 - SONNET_FRACTION) * HAIKU_IN_USD_PER_M);
  const outUsd =
    (outputTokens / 1_000_000) * (SONNET_FRACTION * SONNET_OUT_USD_PER_M + (1 - SONNET_FRACTION) * HAIKU_OUT_USD_PER_M);
  return Math.round((inUsd + outUsd) * 10000) / 10000; // 4-decimal precision
}

function isoDayNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const tokensRoute: RouteHandler = {
  method: 'GET',
  path: '/api/system-health/tokens',
  handle(_req, res, ctx, url) {
    try {
      const user = url.searchParams.get('user');
      const windowDaysRaw = url.searchParams.get('windowDays');
      const windowDays = windowDaysRaw
        ? Math.max(1, Math.min(365, parseInt(windowDaysRaw, 10) || 30))
        : 30;

      // Schema check — ledger may not exist on a freshly-cloned DB before
      // migrations have applied. Degrade gracefully so dashboards don't crash.
      const tableCheck = ctx.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='brain_user_budget_ledger'`,
      ).get();
      if (!tableCheck) {
        json(res, 200, {
          windowDays,
          generatedAt: new Date().toISOString(),
          totals: { calls: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: 0 },
          byBucket: [],
          byUser: [],
          byDay: [],
          warning: 'brain_user_budget_ledger table not present (migration v45 pending)',
        });
        return;
      }

      // Detect bucket column (added by v46) — older DBs may not have it.
      const cols = ctx.db.prepare(`PRAGMA table_info(brain_user_budget_ledger)`).all() as { name: string }[];
      const hasBucket = cols.some(c => c.name === 'bucket');
      const bucketSelect = hasBucket ? 'COALESCE(bucket, \'brain\') AS bucket' : '\'brain\' AS bucket';

      const sinceDay = isoDayNDaysAgo(windowDays);
      const userFilter = user ? 'AND user = ?' : '';
      const userParam = user ? [user] : [];

      // Totals
      const totalsRow = ctx.db.prepare(`
        SELECT
          COALESCE(SUM(calls), 0)         AS calls,
          COALESCE(SUM(input_tokens), 0)  AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens
        FROM brain_user_budget_ledger
        WHERE day_iso >= ? ${userFilter}
      `).get(sinceDay, ...userParam) as { calls: number; input_tokens: number; output_tokens: number };

      // By bucket
      const byBucket = ctx.db.prepare(`
        SELECT
          ${bucketSelect},
          SUM(calls)         AS calls,
          SUM(input_tokens)  AS input_tokens,
          SUM(output_tokens) AS output_tokens
        FROM brain_user_budget_ledger
        WHERE day_iso >= ? ${userFilter}
        GROUP BY bucket
        ORDER BY input_tokens DESC
      `).all(sinceDay, ...userParam);

      // By user
      const byUser = ctx.db.prepare(`
        SELECT
          user,
          SUM(calls)         AS calls,
          SUM(input_tokens)  AS input_tokens,
          SUM(output_tokens) AS output_tokens
        FROM brain_user_budget_ledger
        WHERE day_iso >= ?
        GROUP BY user
        ORDER BY input_tokens DESC
      `).all(sinceDay);

      // By day (time series)
      const byDay = ctx.db.prepare(`
        SELECT
          day_iso,
          SUM(calls)         AS calls,
          SUM(input_tokens)  AS input_tokens,
          SUM(output_tokens) AS output_tokens
        FROM brain_user_budget_ledger
        WHERE day_iso >= ? ${userFilter}
        GROUP BY day_iso
        ORDER BY day_iso ASC
      `).all(sinceDay, ...userParam);

      json(res, 200, {
        windowDays,
        generatedAt: new Date().toISOString(),
        totals: {
          ...totalsRow,
          est_cost_usd: blendedCostUsd(totalsRow.input_tokens, totalsRow.output_tokens),
        },
        byBucket,
        byUser,
        byDay,
        notes: {
          cost_model: `blended ${SONNET_FRACTION * 100}% Sonnet 4.6 + ${(1 - SONNET_FRACTION) * 100}% Haiku 4.5`,
          schema_caveat: hasBucket ? null : 'bucket column missing (v46 not applied) — all rows attributed to "brain"',
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[system-health/tokens] error:', err);
      json(res, 500, { error: 'internal_error', message: String((err as Error)?.message || err) });
    }
  },
};

export const systemHealthTokensRoutes: RouteHandler[] = [tokensRoute];
