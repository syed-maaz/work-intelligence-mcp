/**
 * ADR-030 Phase A — bug capture REST API.
 *
 *   POST /api/bugs/report      — single capture entry point. Idempotent via
 *                                ON CONFLICT(fingerprint) DO UPDATE single
 *                                statement. Inline severity recompute against
 *                                the bug_occurrences ring buffer.
 *   GET  /api/bugs             — list bugs (filter by status/source/severity)
 *   GET  /api/bugs/:id         — single bug + last 50 occurrences + (Phase B)
 *                                investigation when present
 *   POST /api/bugs/:id/resolve — close a bug (resolution: resolved | wont-fix)
 *
 * The exported `captureBug(db, payload)` helper lets in-process callers
 * (the bridge's uncaughtException / unhandledRejection / withAgentTick hooks
 * in 74-04) write directly to the DB without going through the HTTP path.
 * That's important because the HTTP path may itself be what crashed.
 *
 * Refs: docs/docs/adr/adr-030-self-healing-bug-loop.md
 *       .planning/phases/74-adr-030-phase-a-self-healing-capture/PLAN.md
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';
import { json, readBody, parseBody } from './_util.js';
import type { RouteHandler } from './_types.js';
import { computeFingerprint } from '../services/bugs/fingerprint.js';
import type {
  BugRow,
  BugSource,
  BugStatus,
  BugSeverity,
  BugReportPayload,
  BugInvestigationRow,
  BugResolutionRow,
} from '../types/bugs.js';

const SOURCES = ['bridge', 'agent', 'web-ui', 'sync', 'bug-investigator'] as const;
const STATUSES = [
  'new', 'investigating', 'proposed', 'auto-merged', 'resolved', 'wont-fix',
  // v56 (Phase 76) — resolver flow.
  'resolving', 'auto-resolved', 'unable-to-resolve',
] as const;
const SEVERITIES = ['low', 'medium', 'high'] as const;

// ── Zod schemas ──────────────────────────────────────────────────────────────

const ReportBody = z.object({
  source: z.enum(SOURCES),
  errorName: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  stack: z.string().max(20_000).optional(),
  file: z.string().max(500).optional(),
  line: z.number().int().nonnegative().optional(),
  context: z.record(z.unknown()).optional(),
  build: z.enum(['dev', 'preview', 'production']).optional(),
});

const ListQuery = z.object({
  status: z.enum(STATUSES).optional(),
  source: z.enum(SOURCES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const ResolveBody = z.object({
  resolution: z.enum(['resolved', 'wont-fix']),
  note: z.string().max(2000).optional(),
});

const ResolveAllBody = z.object({
  status: z.enum(['new', 'investigating', 'proposed']).default('new'),
  source: z.enum(SOURCES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  resolution: z.enum(['resolved', 'wont-fix']).default('resolved'),
  /** Safety cap — refuses if the filter matches more than this. */
  max_matches: z.number().int().positive().max(1000).default(100),
});

// ── Severity recomputation (real query, not a guess) ─────────────────────────

/**
 * Severity is recomputed against bug_occurrences on every UPSERT.
 *   high   — agent crashes ≥5 in 10 min; OR ≥10 occurrences in 1 h
 *   medium — ≥5 occurrences in 24 h
 *   low    — otherwise
 *
 * Per the scope fence (PLAN.md): severity must NEVER be derived from
 * occurrence_count + last_seen_at.
 *
 * Manual override (schema v55): when `bugs.severity_override` is non-null,
 * it takes precedence over the ring-buffer-computed result. The override
 * is the user's escalation signal — preserved across recomputes, cleared
 * only when the user explicitly removes it via DELETE /api/bugs/:id/severity.
 */
export function computeSeverity(
  db: Database.Database,
  bugId: number,
  source: BugSource,
): BugSeverity {
  // Manual override wins. Read it first so we don't waste cycles on the
  // ring-buffer queries when the user has explicitly set a value.
  const override = db
    .prepare(`SELECT severity_override FROM bugs WHERE id = ?`)
    .get(bugId) as { severity_override: BugSeverity | null } | undefined;
  if (override?.severity_override) return override.severity_override;

  if (source === 'agent') {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS n FROM bug_occurrences
         WHERE bug_id = ? AND seen_at > datetime('now','-10 minutes')`,
      )
      .get(bugId) as { n: number } | undefined;
    if ((r?.n ?? 0) >= 5) return 'high';
  }

  const oneHour = db
    .prepare(
      `SELECT COUNT(*) AS n FROM bug_occurrences
       WHERE bug_id = ? AND seen_at > datetime('now','-1 hour')`,
    )
    .get(bugId) as { n: number } | undefined;
  if ((oneHour?.n ?? 0) >= 10) return 'high';

  const oneDay = db
    .prepare(
      `SELECT COUNT(*) AS n FROM bug_occurrences
       WHERE bug_id = ? AND seen_at > datetime('now','-1 day')`,
    )
    .get(bugId) as { n: number } | undefined;
  if ((oneDay?.n ?? 0) >= 5) return 'medium';

  return 'low';
}

// ── Capture (single transaction: UPSERT + occurrence insert + severity) ──────

export interface CaptureResult {
  id: number;
  fingerprint: string;
  occurrence_count: number;
  is_new: boolean;
  severity: BugSeverity;
}

/**
 * Persist a captured exception into `bugs` + `bug_occurrences`. Idempotent
 * by fingerprint via ON CONFLICT DO UPDATE in a single statement (no
 * SELECT-then-INSERT race window — Review Finding #2).
 *
 * Safe to call from anywhere: HTTP route, bridge hook, agent tick wrapper.
 * Errors thrown here propagate to the caller; the caller is expected to
 * wrap in try/catch (capture must be best-effort, never crash the
 * originating surface).
 */
export function captureBug(db: Database.Database, payload: BugReportPayload): CaptureResult {
  const fp = computeFingerprint({
    source: payload.source,
    errorName: payload.errorName,
    message: payload.message,
    stack: payload.stack ?? null,
  });
  const now = new Date().toISOString();
  const contextJson = payload.context ? JSON.stringify(payload.context) : null;

  const tx = db.transaction((): { id: number; occurrence_count: number; is_new: boolean } => {
    const upsert = db.prepare(
      `INSERT INTO bugs (
         fingerprint, source, error_name, message, top_frame,
         first_seen_at, last_seen_at, occurrence_count, status, severity,
         context_json, investigation_attempts
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'new', 'low', ?, 0)
       ON CONFLICT(fingerprint) DO UPDATE SET
         occurrence_count = occurrence_count + 1,
         last_seen_at     = excluded.last_seen_at
       RETURNING id, occurrence_count`,
    );
    const row = upsert.get(
      fp.fingerprint,
      payload.source,
      payload.errorName,
      payload.message,
      fp.topFrame,
      now,
      now,
      contextJson,
    ) as { id: number; occurrence_count: number };

    db.prepare(`INSERT INTO bug_occurrences (bug_id, seen_at) VALUES (?, ?)`).run(row.id, now);

    return {
      id: row.id,
      occurrence_count: row.occurrence_count,
      is_new: row.occurrence_count === 1,
    };
  });

  const result = tx();

  // Recompute severity *after* the occurrence insert so the ring-buffer
  // query sees the row we just added. Cheap (3 indexed COUNT(*) at most).
  const severity = computeSeverity(db, result.id, payload.source);
  if (severity !== 'low') {
    db.prepare(`UPDATE bugs SET severity = ? WHERE id = ?`).run(severity, result.id);
  }

  // ── ADR-030 × ADR-040/043: promote the bug to a PM-ranked board card ──────
  // Telemetry chain: error → /bugs → kanban card → PM prioritizes → worker
  // picks. A captured bug that matters (severity >= medium) becomes an
  // execute-intent card so BoardWorkerAgent picks it (ordered by rank_score);
  // priority is derived from severity so a high-severity bug outranks a
  // low-priority feature (ADR-043 computeBacklogRank). Best-effort, gated,
  // deduped by fingerprint — never throws (capture must not break).
  try {
    promoteBugToBoard(db, {
      bugId: result.id,
      fingerprint: fp.fingerprint,
      errorName: payload.errorName,
      message: payload.message,
      severity,
    });
  } catch { /* promotion is best-effort; a failure must not sink capture */ }

  return {
    id: result.id,
    fingerprint: fp.fingerprint,
    occurrence_count: result.occurrence_count,
    is_new: result.is_new,
    severity,
  };
}

/**
 * Promote a captured bug to a PM-ranked kanban card (task #14).
 *
 * Gated on OUTCOME_HONEST_KANBAN_ENABLED=1 (no board → no card) AND severity
 * >= medium (low-severity noise stays in /bugs only). Deduped by
 * external_ref='bug:<fingerprint>' so the same recurring bug never spawns
 * duplicate cards — an idempotent INSERT OR IGNORE. The card is
 * intent='execute' with priority mapped from severity (high=90, medium=65) so
 * ADR-043's computeBacklogRank ranks it against all other work and
 * BoardWorkerAgent picks the top one. Kill-switch: BUG_TO_BOARD_ENABLED=0.
 */
function promoteBugToBoard(
  db: Database.Database,
  bug: { bugId: number; fingerprint: string; errorName: string; message: string; severity: 'low' | 'medium' | 'high' },
): void {
  if (process.env.OUTCOME_HONEST_KANBAN_ENABLED !== '1') return;
  if (process.env.BUG_TO_BOARD_ENABLED === '0') return;
  if (bug.severity === 'low') return; // low-severity bugs stay in /bugs only

  const externalRef = `bug:${bug.fingerprint}`;
  // Dedup: one card per bug fingerprint. If it already exists, do nothing.
  const existing = db
    .prepare(`SELECT id FROM tasks WHERE external_ref = ? LIMIT 1`)
    .get(externalRef) as { id: string } | undefined;
  if (existing) return;

  const priority = bug.severity === 'high' ? 90 : 65; // medium
  const now = Date.now();
  const taskId = `task_bug${bug.bugId}_${bug.fingerprint.slice(0, 8)}`;
  const title = `BUG: ${bug.errorName} — ${bug.message}`.slice(0, 120);
  const goalText =
    `Investigate and resolve captured bug #${bug.bugId} (${bug.severity}). ` +
    `Error: ${bug.errorName}. ${bug.message}`.slice(0, 2000);
  const nextCardNum =
    ((db.prepare(`SELECT COALESCE(MAX(card_number), 0) + 1 AS n FROM tasks`).get() as { n: number } | undefined)?.n) ?? 1;

  db.prepare(
    `INSERT OR IGNORE INTO tasks (
       id, title, posture, project, owner_user_id, external_ref,
       goal_text, kanban_column, kanban_order, entered_column_at,
       created_at, last_touched, card_number, intent, priority
     ) VALUES (?, ?, 'bug-investigate', 'wi', 'maaz', ?, ?, 'ready', 0, ?, ?, ?, ?, 'execute', ?)`,
  ).run(taskId, title, externalRef, goalText, now, now, now, nextCardNum, priority);
}

// ── Routes ───────────────────────────────────────────────────────────────────

const reportRoute: RouteHandler = {
  method: 'POST',
  path: '/api/bugs/report',
  async handle(req, res, ctx) {
    const body = await readBody(req);
    const parsed = parseBody(ReportBody, body);
    if (!parsed.ok) {
      json(res, 400, { ok: false, error: { code: 'invalid_body', message: parsed.error } });
      return;
    }
    try {
      const result = captureBug(ctx.db, parsed.data as BugReportPayload);
      // One stderr line per capture per ADR § "Observability".
      process.stderr.write(
        `[Bugs] capture: source=${parsed.data.source} name=${parsed.data.errorName} ` +
          `fp=${result.fingerprint} (${result.is_new ? 'new' : `+${result.occurrence_count}`})\n`,
      );
      json(res, 200, {
        ok: true,
        fingerprint: result.fingerprint,
        occurrence_count: result.occurrence_count,
        is_new: result.is_new,
        severity: result.severity,
      });
    } catch (err) {
      // Capture must never crash. We've already accepted the body — the
      // worst outcome is a 500 here, which is more useful than a hung response.
      json(res, 500, {
        ok: false,
        error: { code: 'capture_failed', message: (err as Error).message },
      });
    }
  },
};

const listRoute: RouteHandler = {
  method: 'GET',
  path: '/api/bugs',
  handle(_req, res, ctx, url) {
    const params = Object.fromEntries(url.searchParams.entries());
    const parsed = ListQuery.safeParse(params);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      json(res, 400, {
        ok: false,
        error: { code: 'invalid_query', message: `${issue.path.join('.')}: ${issue.message}` },
      });
      return;
    }
    const { status, source, severity, limit, offset } = parsed.data;
    const where: string[] = [];
    const args: unknown[] = [];
    if (status) {
      where.push('status = ?');
      args.push(status);
    }
    if (source) {
      where.push('source = ?');
      args.push(source);
    }
    if (severity) {
      where.push('severity = ?');
      args.push(severity);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const bugs = ctx.db
      .prepare(
        `SELECT * FROM bugs ${whereSql} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as BugRow[];
    const total = (
      ctx.db.prepare(`SELECT COUNT(*) AS n FROM bugs ${whereSql}`).get(...args) as { n: number }
    ).n;
    json(res, 200, { ok: true, bugs, total });
  },
};

function extractIdFromPath(pathname: string): number | null {
  // /api/bugs/<id> or /api/bugs/<id>/resolve
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length < 3) return null;
  const idStr = segs[2];
  if (!/^\d+$/.test(idStr)) return null;
  return Number.parseInt(idStr, 10);
}

const getRoute: RouteHandler = {
  method: 'GET',
  path: '/api/bugs/:id',
  handle(_req, res, ctx, url) {
    const id = extractIdFromPath(url.pathname);
    if (id === null) {
      json(res, 400, { ok: false, error: { code: 'invalid_id', message: 'id must be a positive integer' } });
      return;
    }
    const bug = ctx.db.prepare(`SELECT * FROM bugs WHERE id = ?`).get(id) as BugRow | undefined;
    if (!bug) {
      json(res, 404, { ok: false, error: { code: 'not_found', message: `bug ${id} not found` } });
      return;
    }
    const recent_occurrences = ctx.db
      .prepare(`SELECT seen_at FROM bug_occurrences WHERE bug_id = ? ORDER BY seen_at DESC LIMIT 50`)
      .all(id) as Array<{ seen_at: string }>;
    const investigation = ctx.db
      .prepare(`SELECT * FROM bug_investigations WHERE bug_id = ? ORDER BY decided_at DESC LIMIT 1`)
      .get(id) as BugInvestigationRow | undefined;
    // v56 — latest resolver attempt for this bug. Surfaced inline in the
    // /bugs detail panel when bug.status='auto-resolved' so the user can
    // see the commit SHA + files changed without scrolling to the audit
    // tab. Always returned (null when no attempt yet) so the client can
    // also surface failure_reason on 'unable-to-resolve'.
    const latest_resolution = ctx.db
      .prepare(`SELECT * FROM bug_resolutions WHERE bug_id = ? ORDER BY attempt_at DESC LIMIT 1`)
      .get(id) as BugResolutionRow | undefined;
    json(res, 200, {
      ok: true,
      bug,
      recent_occurrences,
      investigation: investigation ?? null,
      latest_resolution: latest_resolution ?? null,
    });
  },
};

const resolveRoute: RouteHandler = {
  method: 'POST',
  path: '/api/bugs/:id/resolve',
  async handle(req, res, ctx, url) {
    const id = extractIdFromPath(url.pathname);
    if (id === null) {
      json(res, 400, { ok: false, error: { code: 'invalid_id', message: 'id must be a positive integer' } });
      return;
    }
    const body = await readBody(req);
    const parsed = parseBody(ResolveBody, body);
    if (!parsed.ok) {
      json(res, 400, { ok: false, error: { code: 'invalid_body', message: parsed.error } });
      return;
    }
    const status: BugStatus = parsed.data.resolution;
    const result = ctx.db.prepare(`UPDATE bugs SET status = ? WHERE id = ?`).run(status, id);
    if (result.changes === 0) {
      json(res, 404, { ok: false, error: { code: 'not_found', message: `bug ${id} not found` } });
      return;
    }
    const bug = ctx.db.prepare(`SELECT * FROM bugs WHERE id = ?`).get(id) as BugRow;
    json(res, 200, { ok: true, bug });
  },
};

// ── Bulk resolve (Plan 75-07 — wi_bug_resolve_all backing endpoint) ──────────

export interface ResolveAllFilter {
  status: 'new' | 'investigating' | 'proposed';
  source?: BugSource;
  severity?: BugSeverity;
  resolution: 'resolved' | 'wont-fix';
  max_matches: number;
}

export interface ResolveAllResult {
  updated: number;
  skipped_over_cap: boolean;
}

/**
 * Bulk-update `bugs.status` for rows matching the filter. Refuses if the
 * filter matches more than `max_matches` rows (safety cap; default 100,
 * max 1000 enforced at the Zod layer).
 *
 * Pre-counts the match BEFORE running the UPDATE so a giant result set
 * can't sneak in. Single statement otherwise.
 */
export function resolveAllBugs(
  db: Database.Database,
  filter: ResolveAllFilter,
): ResolveAllResult {
  const where: string[] = ['status = ?'];
  const args: unknown[] = [filter.status];
  if (filter.source) {
    where.push('source = ?');
    args.push(filter.source);
  }
  if (filter.severity) {
    where.push('severity = ?');
    args.push(filter.severity);
  }
  const whereSql = where.join(' AND ');

  const matchCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE ${whereSql}`).get(...args) as { n: number }
  ).n;
  if (matchCount > filter.max_matches) {
    return { updated: 0, skipped_over_cap: true };
  }

  const result = db
    .prepare(`UPDATE bugs SET status = ? WHERE ${whereSql}`)
    .run(filter.resolution, ...args);
  return { updated: result.changes, skipped_over_cap: false };
}

const resolveAllRoute: RouteHandler = {
  method: 'POST',
  path: '/api/bugs/resolve-all',
  async handle(req, res, ctx) {
    const body = await readBody(req);
    const parsed = parseBody(ResolveAllBody, body);
    if (!parsed.ok) {
      json(res, 400, { ok: false, error: { code: 'invalid_body', message: parsed.error } });
      return;
    }
    try {
      const result = resolveAllBugs(ctx.db, parsed.data);
      json(res, 200, { ok: true, ...result });
    } catch (err) {
      json(res, 500, {
        ok: false,
        error: { code: 'resolve_all_failed', message: (err as Error).message },
      });
    }
  },
};

// ── Reinvestigate (Plan 75-05) ───────────────────────────────────────────────
//
// Resets a bug back to status='new' so the BugInvestigatorAgent picks it up
// on the next tick. Clears `last_investigation_id` and `investigation_attempts`
// so the attempt cap doesn't immediately push it to 'wont-fix'. The previous
// `bug_investigations` row is preserved (FK on last_investigation_id is
// cleared, but the row itself stays for audit).
const reinvestigateRoute: RouteHandler = {
  method: 'POST',
  path: '/api/bugs/:id/reinvestigate',
  async handle(_req, res, ctx, url) {
    const id = extractIdFromPath(url.pathname);
    if (id === null) {
      json(res, 400, { ok: false, error: { code: 'invalid_id', message: 'id must be a positive integer' } });
      return;
    }
    const result = ctx.db
      .prepare(
        `UPDATE bugs
            SET status='new', last_investigation_id=NULL, investigation_attempts=0
          WHERE id = ?`,
      )
      .run(id);
    if (result.changes === 0) {
      json(res, 404, { ok: false, error: { code: 'not_found', message: `bug ${id} not found` } });
      return;
    }
    const bug = ctx.db.prepare(`SELECT * FROM bugs WHERE id = ?`).get(id) as BugRow;
    json(res, 200, { ok: true, bug });
  },
};

// Schema v55: manual severity override (escalation UX). Body shape:
//   { severity: 'low'|'medium'|'high', reason?: string }
// to set; { severity: null } to clear. Override takes precedence over the
// ring-buffer recompute — see computeSeverity() above.
const severityOverrideSchema = z.object({
  severity: z.enum(SEVERITIES).nullable(),
  reason: z.string().max(2000).optional(),
});

const severityOverrideRoute: RouteHandler = {
  method: 'POST',
  path: '/api/bugs/:id/severity',
  async handle(req, res, ctx, url) {
    const id = extractIdFromPath(url.pathname);
    if (id === null) {
      json(res, 400, { ok: false, error: { code: 'invalid_id', message: 'id must be a positive integer' } });
      return;
    }
    const body = await readBody(req);
    const parsed = parseBody(severityOverrideSchema, body);
    if (!parsed.ok) {
      json(res, 400, { ok: false, error: { code: 'invalid_body', message: parsed.error } });
      return;
    }
    const { severity, reason } = parsed.data;
    const now = new Date().toISOString();
    // Atomic: write the override columns, then keep the legacy `severity`
    // column in sync via COALESCE so lists / filters / system-health
    // rollups always see the effective value (override wins, falls back
    // to existing computed).
    const result = ctx.db
      .prepare(
        `UPDATE bugs
            SET severity_override        = ?,
                severity_override_reason = ?,
                severity_override_at     = CASE WHEN ? IS NULL THEN NULL ELSE ? END,
                severity                 = COALESCE(?, severity)
          WHERE id = ?`,
      )
      .run(severity, severity === null ? null : (reason ?? null), severity, now, severity, id);
    if (result.changes === 0) {
      json(res, 404, { ok: false, error: { code: 'not_found', message: `bug ${id} not found` } });
      return;
    }
    const bug = ctx.db.prepare(`SELECT * FROM bugs WHERE id = ?`).get(id) as BugRow;
    json(res, 200, { ok: true, bug });
  },
};

// ── ADR-030 Phase C (Phase 76-03) — POST /api/bugs/:id/resolve-attempt ─────
//
// Triggers the BugResolverAgent. Body is empty — the bug ID + investigation
// row already on disk drive everything. Returns 202 immediately, flips
// status 'proposed' → 'resolving', and enqueues the agent. The agent's
// tick (called by web-server.js after enqueue) drains the queue.
//
// 400 errors:
//   - 'resolver_disabled' — BUG_RESOLVER_ENABLED=0 (agent not registered)
//   - 'invalid_id' — non-numeric :id
//   - 'invalid_status' — bug is not in 'proposed' state
// 404 — bug doesn't exist

interface BugResolverLike { enqueue(bugId: number): void }

const resolveAttemptRoute: RouteHandler = {
  method: 'POST',
  path: '/api/bugs/:id/resolve-attempt',
  async handle(_req, res, ctx, url) {
    const id = extractIdFromPath(url.pathname);
    if (id === null) {
      json(res, 400, { ok: false, error: { code: 'invalid_id', message: 'id must be a positive integer' } });
      return;
    }
    if (process.env.BUG_RESOLVER_ENABLED === '0' || !ctx.bugResolver) {
      json(res, 400, {
        ok: false,
        error: {
          code: 'resolver_disabled',
          message: 'BUG_RESOLVER_ENABLED=0 — set to 1 and restart the bridge to enable',
        },
      });
      return;
    }
    const bug = ctx.db.prepare(`SELECT id, status FROM bugs WHERE id=?`).get(id) as
      | { id: number; status: string }
      | undefined;
    if (!bug) {
      json(res, 404, { ok: false, error: { code: 'not_found', message: `bug ${id} not found` } });
      return;
    }
    if (bug.status !== 'proposed') {
      json(res, 400, {
        ok: false,
        error: {
          code: 'invalid_status',
          message: `bug ${id} is in '${bug.status}' state — only 'proposed' bugs are resolvable`,
        },
      });
      return;
    }

    // Atomic flip — read-back the row inside the same statement so concurrent
    // double-clicks land at most one 'proposed' → 'resolving' transition.
    const updated = ctx.db
      .prepare(`UPDATE bugs SET status='resolving' WHERE id=? AND status='proposed'`)
      .run(id);
    if (updated.changes === 0) {
      // Race lost — another request flipped first.
      json(res, 400, {
        ok: false,
        error: {
          code: 'race_lost',
          message: `bug ${id} was already picked up by another resolver request`,
        },
      });
      return;
    }
    (ctx.bugResolver as BugResolverLike).enqueue(id);
    const fresh = ctx.db.prepare(`SELECT * FROM bugs WHERE id=?`).get(id) as BugRow;
    json(res, 202, { ok: true, bug: fresh });
  },
};

export const bugsRoutes: RouteHandler[] = [reportRoute, listRoute, getRoute, resolveRoute, resolveAllRoute, reinvestigateRoute, severityOverrideRoute, resolveAttemptRoute];

// ── system-health.bugs block helper ──────────────────────────────────────────

export interface BugsHealthBlock {
  total: number;
  new: number;
  investigating: number;
  proposed: number;
  /** v56 — bugs currently being resolved by the agent. */
  resolving: number;
  /** v56 — bugs that the resolver locally committed in the last 24h. */
  auto_resolved_24h: number;
  /** v56 — bugs the resolver bailed on (terminal). */
  unable_to_resolve: number;
  auto_merged_24h: number;
  resolved_24h: number;
  top_fingerprints: Array<{
    fingerprint: string;
    error_name: string;
    occurrence_count: number;
    severity: BugSeverity;
  }>;
  investigator_status: 'not-implemented' | 'ready' | 'degraded' | 'crashed' | 'disabled';
  /** v56 — Phase 76 BugResolverAgent status. */
  resolver_status: 'not-implemented' | 'ready' | 'degraded' | 'crashed' | 'disabled';
  auto_merge_cooldown_until: string | null;
}

/**
 * Build the `bugs` block for /api/system-health. Phase A returned
 * investigator_status='not-implemented'; Phase B (Plan 75-04) passes a
 * status derived from the agent health snapshot. Phase C (Plan 76-03) adds
 * resolver_status alongside it. The route handler computes both snapshots
 * and threads them in.
 */
export function buildBugsHealthBlock(
  db: Database.Database,
  investigatorStatus?: 'ready' | 'degraded' | 'crashed' | 'disabled',
  resolverStatus?: 'ready' | 'degraded' | 'crashed' | 'disabled',
): BugsHealthBlock {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM bugs`).get() as { n: number }).n;
  const newN = (db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE status='new'`).get() as { n: number }).n;
  const investigating = (
    db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE status='investigating'`).get() as { n: number }
  ).n;
  const proposed = (
    db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE status='proposed'`).get() as { n: number }
  ).n;
  const resolving = (
    db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE status='resolving'`).get() as { n: number }
  ).n;
  const autoResolved24h = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM bugs
         WHERE status='auto-resolved' AND last_seen_at > datetime('now','-1 day')`,
      )
      .get() as { n: number }
  ).n;
  const unableToResolve = (
    db.prepare(`SELECT COUNT(*) AS n FROM bugs WHERE status='unable-to-resolve'`).get() as { n: number }
  ).n;
  const resolved24h = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM bugs
         WHERE status='resolved' AND last_seen_at > datetime('now','-1 day')`,
      )
      .get() as { n: number }
  ).n;
  const top_fingerprints = db
    .prepare(
      `SELECT fingerprint, error_name, occurrence_count, severity
         FROM bugs
        WHERE status NOT IN ('resolved','wont-fix','auto-resolved','unable-to-resolve')
        ORDER BY occurrence_count DESC
        LIMIT 5`,
    )
    .all() as BugsHealthBlock['top_fingerprints'];
  return {
    total,
    new: newN,
    investigating,
    proposed,
    resolving,
    auto_resolved_24h: autoResolved24h,
    unable_to_resolve: unableToResolve,
    auto_merged_24h: 0,
    resolved_24h: resolved24h,
    top_fingerprints,
    investigator_status: investigatorStatus ?? 'not-implemented',
    resolver_status: resolverStatus ?? 'not-implemented',
    auto_merge_cooldown_until: null,
  };
}
