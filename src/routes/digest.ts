/**
 * REFACTOR-001 — digest route family (Sprint A.4, partial).
 *
 * Extracts the simpler digest endpoints:
 *   GET /api/daily-summary   — cached daily-summary (1h TTL)
 *   GET /api/digests         — list stored digests (EP-19)
 *
 * Deferred to follow-up extraction (heavier coupling):
 *   POST /api/digest         — uses `withStaleFallback` + shared `DigestSchema`
 *   GET /api/morning-brief   — uses scheduler hooks
 *   GET /api/weekly-report   — uses weekly-report module + stats aggregation
 *
 * These will move once `withStaleFallback` is generalized into a shared
 * helper module — keeping them inline today avoids duplicating that logic.
 */

import { getCachedDigest, listDigests } from '../db/queries/digests.js';
import { json } from './_util.js';
import type { RouteHandler } from './_types.js';

// ── GET /api/daily-summary ─────────────────────────────────────────────────
// EP-23: AI-generated dashboard hero. Cached 1h in the digests table under
// the synthetic topic name `__daily_summary__`.
const dailySummaryRoute: RouteHandler = {
  method: 'GET',
  path: '/api/daily-summary',
  async handle(_req, res, ctx, url) {
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    const forceRefresh = url.searchParams.get('refresh') === 'true';

    const cached = getCachedDigest(ctx.db, '__daily_summary__', date);
    const poisoned = cached?.markdown?.includes('(AI summary unavailable:');
    if (cached && !forceRefresh && !poisoned) {
      json(res, 200, {
        markdown: cached.markdown,
        cached: true,
        generatedAt: cached.generated_at,
      });
      return;
    }

    if (!ctx.anthropicApiKey) {
      json(res, 400, { error: 'ANTHROPIC_API_KEY not set' });
      return;
    }

    const { generateDailySummary } = await import('../tools/daily-summary.js');
    const result = await generateDailySummary(ctx.db, { date, refresh: forceRefresh }, ctx.anthropicApiKey);
    // Note: original web-server.js had `sections: result.sections` here, but
    // `DailySummaryResult` has no such field — the value was always
    // `undefined` at runtime. Dropped during port; no observable change.
    json(res, 200, {
      markdown: result.markdown,
      cached: false,
      generatedAt: result.generatedAt,
    });
  },
};

// ── GET /api/digests (EP-19) ───────────────────────────────────────────────
const listDigestsRoute: RouteHandler = {
  method: 'GET',
  path: '/api/digests',
  handle(_req, res, ctx, url) {
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const digests = listDigests(ctx.db, limit);
    json(res, 200, { digests, count: digests.length });
  },
};

export const digestRoutes: RouteHandler[] = [dailySummaryRoute, listDigestsRoute];
