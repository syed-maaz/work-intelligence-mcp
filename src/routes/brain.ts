/**
 * REFACTOR-001 — Brain route family (opening pass).
 *
 * Extracts the 3 *simplest* brain routes from web-server.js so the pattern is
 * proven without touching the more complex ones (decide, decide/stream,
 * context — those have local caches + past_outcome enrichment and will move
 * in a follow-up commit).
 *
 * Extracted in this PR:
 *   POST /api/brain/learn   — Pillar 4 (record_outcome)
 *   POST /api/brain/verify  — Pillar 5 (verify_claim)
 *   POST /api/brain/recall  — Pillar 4 (recall_memory)
 *
 * Each handler is a verbatim port: same behaviour, same response shapes,
 * same error codes. See ADR-024 for the route contracts.
 */

import { recordOutcome, InvalidOutcomeError, DecisionNotFoundError, VALID_OUTCOMES } from '../services/brain/learn.js';
import { verifyClaim, InvalidVerifyArgsError } from '../services/brain/verify.js';
import { recallMemory, InvalidRecallArgsError } from '../services/brain/recall.js';
import { listBrainDecisions } from '../db/queries/brain-decisions-list.js';

import { json, readBody } from './_util.js';
import type { RouteHandler } from './_types.js';

// ── POST /api/brain/learn — close the learning loop ─────────────────────────
const learnRoute: RouteHandler = {
  method: 'POST',
  path: '/api/brain/learn',
  async handle(req, res, ctx) {
    try {
      const body = (await readBody(req)) as { decision_id?: unknown; outcome?: unknown } | null;
      const decisionId = typeof body?.decision_id === 'string' ? body.decision_id : '';
      const outcome = typeof body?.outcome === 'string' ? body.outcome : '';

      if (!decisionId.trim()) {
        json(res, 400, { error: 'decision_id_required' });
        return;
      }

      try {
        const result = await recordOutcome({
          db: ctx.db,
          decisionId,
          outcome,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          memoryEnricher: ctx.memoryEnricher as any,
        });
        json(res, 200, {
          decision_id: result.row.id,
          outcome: result.row.outcome,
          outcome_recorded_at: new Date(result.row.outcome_recorded_at).toISOString(),
          palace_updated: result.palaceUpdated,
          row: result.row,
        });
      } catch (innerErr) {
        if (innerErr instanceof InvalidOutcomeError) {
          json(res, 400, {
            error: 'invalid_outcome',
            allowed: VALID_OUTCOMES,
            received: innerErr.received ?? null,
          });
          return;
        }
        if (innerErr instanceof DecisionNotFoundError) {
          json(res, 404, {
            error: 'decision_not_found',
            decision_id: innerErr.decisionId,
          });
          return;
        }
        throw innerErr;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[brain/learn] error:', err);
      json(res, 500, { error: 'internal_error', message: String((err as Error)?.message || err) });
    }
  },
};

// ── POST /api/brain/verify — Pillar 5 ───────────────────────────────────────
const verifyRoute: RouteHandler = {
  method: 'POST',
  path: '/api/brain/verify',
  async handle(req, res, ctx) {
    try {
      const body = (await readBody(req)) as { claim?: unknown; evidence_needed?: unknown } | null;
      const claim = typeof body?.claim === 'string' ? body.claim : '';
      const evidenceNeeded = Array.isArray(body?.evidence_needed) ? (body.evidence_needed as string[]) : null;

      if (!claim.trim()) {
        json(res, 400, { error: 'claim_required' });
        return;
      }
      if (!evidenceNeeded || evidenceNeeded.length === 0) {
        json(res, 400, { error: 'evidence_needed_required' });
        return;
      }

      try {
        const result = await verifyClaim({ db: ctx.db, claim, evidence_needed: evidenceNeeded });
        json(res, 200, {
          id: result.id,
          claim: result.claim,
          verified: result.verified,
          evidence: result.evidence,
          confidence: result.confidence,
          checked_at: new Date(result.checked_at).toISOString(),
          results: result.results,
        });
      } catch (innerErr) {
        if (innerErr instanceof InvalidVerifyArgsError) {
          json(res, 400, { error: 'invalid_args', message: innerErr.message });
          return;
        }
        throw innerErr;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[brain/verify] error:', err);
      json(res, 500, { error: 'internal_error', message: String((err as Error)?.message || err) });
    }
  },
};

// ── POST /api/brain/recall — Pillar 4 ───────────────────────────────────────
const recallRoute: RouteHandler = {
  method: 'POST',
  path: '/api/brain/recall',
  async handle(req, res, ctx) {
    try {
      const body = (await readBody(req)) as { pattern?: unknown; limit?: unknown } | null;
      const pattern = typeof body?.pattern === 'string' ? body.pattern.trim() : '';
      const limitRaw = body?.limit;
      const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(100, Math.floor(limitRaw)))
        : 10;

      if (!pattern) {
        json(res, 400, { error: 'pattern_required' });
        return;
      }

      try {
        const results = await recallMemory({
          db: ctx.db,
          pattern,
          limit,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          palace: ctx.palaceClient as any,
        });
        json(res, 200, { results });
      } catch (innerErr) {
        if (innerErr instanceof InvalidRecallArgsError) {
          json(res, 400, { error: 'invalid_args', message: innerErr.message });
          return;
        }
        throw innerErr;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[brain/recall] error:', err);
      json(res, 500, { error: 'internal_error', message: String((err as Error)?.message || err) });
    }
  },
};

// ── GET /api/brain/decisions — decision audit trail (GAP-004) ───────────────
const decisionsHistoryRoute: RouteHandler = {
  method: 'GET',
  path: '/api/brain/decisions',
  handle(_req, res, ctx, url) {
    const user = (url.searchParams.get('user') || 'anon').toString();
    const since = url.searchParams.get('since') ?? undefined;
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

    const result = listBrainDecisions(ctx.db, { user, since, limit });
    json(res, 200, {
      decisions: result.decisions.map(row => ({
        ...row,
        created_at_iso: new Date(row.created_at).toISOString(),
      })),
      total: result.total,
    });
  },
};

export const brainRoutes: RouteHandler[] = [
  learnRoute,
  verifyRoute,
  recallRoute,
  decisionsHistoryRoute,
];
