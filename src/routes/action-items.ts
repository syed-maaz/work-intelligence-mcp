/**
 * REFACTOR-001 — action-items route family.
 *
 * Extracts the two flat-path routes:
 *   GET /api/action-items                        — list + filter (topic / status / assignee)
 *   GET /api/action-items/pending-review         — AI-extracted items awaiting confirmation (EP-35)
 *
 * Dynamic-path routes still live in web-server.js until the dispatcher
 * supports path patterns:
 *   POST /api/action-items/:id/confirm
 *   POST /api/action-items/:id/dismiss
 *
 * These are 4 LOC each; safe to leave inline until the next router upgrade.
 */

import type Database from 'better-sqlite3';
import { getPendingReviewItems } from '../db/queries/action-items.js';

import { json } from './_util.js';
import type { RouteHandler } from './_types.js';

interface ActionItemRow {
  id: number;
  topic_id: number | null;
  title: string;
  description: string | null;
  assignee: string | null;
  status: string;
  due_date: string | null;
  source_message_id: number | null;
  source: string | null;
  created_at: string | null;
}

// ── GET /api/action-items ──────────────────────────────────────────────────
const listRoute: RouteHandler = {
  method: 'GET',
  path: '/api/action-items',
  handle(_req, res, ctx, url) {
    const db = ctx.db;
    const topic = url.searchParams.get('topic') || '';
    const status = url.searchParams.get('status') || 'open';
    const assignee = url.searchParams.get('assignee') || null;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (topic) {
      const topicRow = db.prepare('SELECT id FROM topics WHERE name = ?').get(topic) as
        | { id: number }
        | undefined;
      if (topicRow) {
        conditions.push('a.topic_id = ?');
        params.push(topicRow.id);
      }
    }
    if (status && status !== 'all') {
      conditions.push('a.status = ?');
      params.push(status);
    }
    if (assignee) {
      conditions.push('a.assignee LIKE ?');
      params.push(`%${assignee}%`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = db
      .prepare(
        `SELECT a.id, a.topic_id, a.title, a.description, a.assignee,
                a.status, a.due_date, a.source_message_id,
                m.source, m.timestamp as created_at
         FROM action_items a
         LEFT JOIN messages m ON a.source_message_id = m.id
         ${where}
         ORDER BY a.id DESC LIMIT 200`,
      )
      .all(...params) as ActionItemRow[];
    json(res, 200, rows);
  },
};

// ── GET /api/action-items/pending-review ───────────────────────────────────
// EP-35 — Action Item Confidence Triage. AI-extracted items below the
// auto-confirm threshold land here for human review.
const pendingReviewRoute: RouteHandler = {
  method: 'GET',
  path: '/api/action-items/pending-review',
  handle(_req, res, ctx, url) {
    const db = ctx.db;
    const topicName = url.searchParams.get('topic') ?? null;
    let topicId: number | undefined;
    if (topicName) {
      const row = db.prepare('SELECT id FROM topics WHERE name = ?').get(topicName) as
        | { id: number }
        | undefined;
      topicId = row?.id;
    }
    // `getPendingReviewItems` types `topicId` as `number | undefined`.
    const items = (getPendingReviewItems as (db: Database.Database, topicId?: number) => unknown[])(db, topicId);
    json(res, 200, { items });
  },
};

export const actionItemsRoutes: RouteHandler[] = [listRoute, pendingReviewRoute];
