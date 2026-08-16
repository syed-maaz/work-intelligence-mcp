/**
 * Palace direct write routes — supports `wi-update-context` skill v2 (Step 4g).
 *
 * `MemoryEnricher` already writes to palace transitively (decisions, conversations,
 * meetings, entities, topics wings). This route exposes a thin direct-write surface
 * for the skill's "topic-mode" path: capture an architectural conclusion / design
 * discussion / persona insight as an explicit `topics` drawer, so
 * `wi_palace_query` finds it semantically.
 *
 * Contract:
 *   POST /api/palace/drawer
 *     body: { wing: string, room: string, content: string, label?: string }
 *     200:  { ok: true, wing, room, written: true }
 *     400:  { error: 'invalid_args' | 'wing_not_allowed' }
 *     503:  { error: 'palace_disabled' } when palaceClient is null/disconnected
 *
 * Hard rules:
 *   - `wing` is restricted to a small allowlist (`topics`, `decisions`,
 *     `annotations`). Other wings already have dedicated write paths via
 *     MemoryEnricher and shouldn't be reachable from a generic endpoint.
 *   - `room` must be ≤ 200 chars; ASCII-printable + `[a-z0-9_\-./]` only
 *     (palace room ids end up in filesystem-shaped paths inside ChromaDB).
 *   - `content` is capped at 64KB to prevent accidental dump-the-conversation
 *     calls. Real session summaries are well under 4KB.
 *   - `label` (optional) ≤ 200 chars.
 *
 * Idempotency: PalaceClient.addDrawer is idempotent on (wing, room) — same
 * (wing, room) overwrites the prior content. The skill picks a stable
 * room name from `--topic <slug>` so re-runs are safe no-ops.
 */

import { json, readBody } from './_util.js';
import type { RouteHandler } from './_types.js';

interface PalaceLike {
  isConnected: boolean;
  addDrawer(wing: string, room: string, content: string, label?: string): Promise<void>;
}

const ALLOWED_WINGS = new Set(['topics', 'decisions', 'annotations']);
const ROOM_RE = /^[a-zA-Z0-9_\-./]{1,200}$/;
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_LABEL_LEN = 200;

const drawerRoute: RouteHandler = {
  method: 'POST',
  path: '/api/palace/drawer',
  async handle(req, res, ctx) {
    const palace = ctx.palaceClient as PalaceLike | null | undefined;
    if (!palace || !palace.isConnected) {
      json(res, 503, { error: 'palace_disabled', detail: 'palaceClient is null or disconnected — set MEMPALACE_PATH and restart bridge' });
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { error: 'invalid_json' });
      return;
    }

    const b = body as Record<string, unknown> | null;
    const wing = typeof b?.wing === 'string' ? b.wing.trim() : '';
    const room = typeof b?.room === 'string' ? b.room.trim() : '';
    const content = typeof b?.content === 'string' ? b.content : '';
    const label = typeof b?.label === 'string' ? b.label.trim() : undefined;

    if (!wing || !room || !content) {
      json(res, 400, { error: 'invalid_args', detail: 'wing, room, content are all required non-empty strings' });
      return;
    }

    if (!ALLOWED_WINGS.has(wing)) {
      json(res, 400, { error: 'wing_not_allowed', detail: `allowed wings: ${Array.from(ALLOWED_WINGS).join(', ')}` });
      return;
    }

    if (!ROOM_RE.test(room)) {
      json(res, 400, { error: 'invalid_room', detail: 'room must match /^[a-zA-Z0-9_\\-./]{1,200}$/' });
      return;
    }

    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      json(res, 400, { error: 'content_too_large', detail: `content exceeds ${MAX_CONTENT_BYTES} bytes` });
      return;
    }

    if (label !== undefined && label.length > MAX_LABEL_LEN) {
      json(res, 400, { error: 'label_too_long', detail: `label exceeds ${MAX_LABEL_LEN} chars` });
      return;
    }

    try {
      await palace.addDrawer(wing, room, content, label);
      json(res, 200, { ok: true, wing, room, written: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: 'palace_write_failed', detail });
    }
  },
};

export const palaceRoutes: RouteHandler[] = [drawerRoute];
