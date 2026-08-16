/**
 * REFACTOR-001 — topics route family (Sprint A.3, partial).
 *
 * Extracts the two simple read-only topic endpoints:
 *   GET /api/topics            — list all configured topics
 *   GET /api/topics/health     — health-score-per-topic (EP-41)
 *
 * Deferred to follow-up extraction (each has heavier dependencies):
 *   POST /api/topic-expert     — full topic-expert pipeline (AI + browser session)
 *   POST /api/configure-topic  — topic CRUD + immediate sync trigger
 *
 * These will move once `RouteContext` grows fields for `browserSession` and
 * `triggerSync()` callback — keeping them inline today avoids passing too
 * many ad-hoc closures.
 */

import { getTopicHealthScores } from '../db/queries/topics.js';
import { json } from './_util.js';
import type { RouteHandler } from './_types.js';

// ── GET /api/topics ────────────────────────────────────────────────────────
const listTopicsRoute: RouteHandler = {
  method: 'GET',
  path: '/api/topics',
  handle(_req, res, ctx) {
    const topics = ctx.db.prepare('SELECT * FROM topics ORDER BY name').all();
    json(res, 200, topics);
  },
};

// ── GET /api/topics/health (EP-41) ─────────────────────────────────────────
const healthRoute: RouteHandler = {
  method: 'GET',
  path: '/api/topics/health',
  handle(_req, res, ctx) {
    json(res, 200, { topics: getTopicHealthScores(ctx.db) });
  },
};

export const topicsRoutes: RouteHandler[] = [listTopicsRoute, healthRoute];
