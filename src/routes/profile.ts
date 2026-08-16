/**
 * Substrate fix #2 — POST /api/profile/observe + GET /api/profile/rolling
 *
 * Closes the "doesn't learn me" gap from the Hermes Agent decline. Every
 * consumer signal (tool call, Jira open, message sent, code edit) writes a
 * row into user_profile_observations. The aggregator (exported from
 * persona.ts as getRollingProfile) builds rolling top-N kinds and top-N
 * targets in a sliding window, which feeds GET /api/persona's synthesis.
 *
 * Fire-and-forget contract:
 *   POST /api/profile/observe { kind, payload, source, ts? }
 *     → 202 { accepted: true, observation_id }
 *     → 400 only on missing/invalid kind|source
 *     → never throws on consumer side; consumer can ignore the response
 *
 * Decay: handled at READ time in getRollingProfile via WHERE ts > date('now', '-N days').
 *
 * Refs: .planning/ADR-REVIEW.md graphify+Hermes decline → substrate fix #2.
 */

import { z } from 'zod';

import { json, readBody } from './_util.js';
import type { RouteHandler } from './_types.js';
import { getRollingProfile } from './persona.js';

const ObserveSchema = z.object({
  kind: z.enum([
    'tool_call',
    'jira_open',
    'message_sent',
    'code_edit',
    'session_start',
    'session_end',
    'feedback_positive',
    'feedback_negative',
    'recall_hit',
    'recall_miss',
    'other',
  ]),
  payload: z.record(z.string(), z.unknown()).default({}),
  source: z.enum(['claude-code', 'atlas', 'mcp', 'ui', 'unknown']).default('unknown'),
  user: z.string().min(1).max(64).default('maaz'),
  consumer: z.string().min(1).max(32).default('unknown'),
  ts: z.string().datetime().optional(),
});

const observeRoute: RouteHandler = {
  method: 'POST',
  path: '/api/profile/observe',
  async handle(req, res, ctx) {
    try {
      const raw = await readBody(req);
      const parse = ObserveSchema.safeParse(raw);
      if (!parse.success) {
        json(res, 400, { error: 'invalid_args', issues: parse.error.issues });
        return;
      }
      const { kind, payload, source, user, consumer, ts } = parse.data;

      // Schema v51 may not yet exist on a freshly-cloned DB before migrations
      // have applied — degrade gracefully so consumers don't fail before boot.
      const tableCheck = ctx.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='user_profile_observations'`,
      ).get();
      if (!tableCheck) {
        json(res, 503, { error: 'schema_not_ready', message: 'user_profile_observations table not present (migration v51 pending)' });
        return;
      }

      const stmt = ctx.db.prepare(`
        INSERT INTO user_profile_observations (ts, user, kind, payload, source, consumer)
        VALUES (COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ','now')), ?, ?, ?, ?, ?)
      `);
      const info = stmt.run(ts ?? null, user, kind, JSON.stringify(payload), source, consumer);

      json(res, 202, {
        accepted: true,
        observation_id: Number(info.lastInsertRowid),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[profile/observe] error:', err);
      // 202 even on internal error — the contract is fire-and-forget; we
      // don't want a transient DB error to break consumer flow.
      json(res, 202, { accepted: false, error: 'internal_error', message: String((err as Error)?.message || err) });
    }
  },
};

const rollingRoute: RouteHandler = {
  method: 'GET',
  path: '/api/profile/rolling',
  handle(_req, res, ctx, url) {
    try {
      const user = (url.searchParams.get('user') || 'maaz').toString().slice(0, 64);
      const windowDaysRaw = url.searchParams.get('windowDays');
      const windowDays = windowDaysRaw ? Math.max(1, Math.min(90, parseInt(windowDaysRaw, 10) || 7)) : 7;
      const profile = getRollingProfile(ctx.db, user, windowDays);
      json(res, 200, { user, windowDays, ...profile });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[profile/rolling] error:', err);
      json(res, 500, { error: 'internal_error', message: String((err as Error)?.message || err) });
    }
  },
};

export const profileRoutes: RouteHandler[] = [observeRoute, rollingRoute];
