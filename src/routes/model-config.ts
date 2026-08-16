/**
 * Tier 2 — model_config REST endpoints.
 *
 *   GET  /api/model-config        — return all 6 buckets + recommendations + caps
 *   POST /api/model-config        — bulk update one or more bucket rows
 *
 * Validation lives in src/services/model-config.ts:validateBucketConfig —
 * this file is just request parsing, dispatch, and response shaping.
 *
 * Cache is invalidated automatically by upsertBucketConfig() on success
 * so the next analyzer call picks up the new config without a 60s wait.
 */

import { z } from 'zod';
import { json, readBody, parseBody } from './_util.js';
import type { RouteHandler } from './_types.js';
import {
  ALL_BUCKETS,
  ALL_EFFORTS,
  ALL_MODELS,
  ALL_THINKING_MODES,
  EFFORT_MAX_TOKENS,
  MODEL_CAPS,
  RECOMMENDED,
  listBucketConfigs,
  upsertBucketConfig,
} from '../services/model-config.js';
import type { Bucket, Effort, ModelId, ThinkingMode } from '../services/model-config.js';

// ── GET ──────────────────────────────────────────────────────────────────────

const getRoute: RouteHandler = {
  method: 'GET',
  path: '/api/model-config',
  handle(_req, res, ctx) {
    try {
      const rows = listBucketConfigs(ctx.db);
      // Decorate each row with its recommendation + the available efforts for
      // the currently-selected model. The UI uses these to populate dropdowns
      // and render the "(✓ recommended)" badge.
      const buckets = rows.map(r => ({
        bucket: r.bucket,
        model: r.model,
        effort: r.effort,
        thinking_mode: r.thinking_mode,
        recommended: RECOMMENDED[r.bucket],
        available_efforts_for_model: MODEL_CAPS[r.model].effortsAvailable,
        supports_adaptive_thinking: MODEL_CAPS[r.model].supportsAdaptiveThinking,
      }));
      json(res, 200, {
        buckets,
        effortMaxTokens: EFFORT_MAX_TOKENS,
        modelCaps: MODEL_CAPS,
        availableModels: ALL_MODELS,
        availableEfforts: ALL_EFFORTS,
        availableThinkingModes: ALL_THINKING_MODES,
        availableBuckets: ALL_BUCKETS,
      });
    } catch (err) {
      json(res, 500, { error: 'model-config GET failed', detail: (err as Error).message });
    }
  },
};

// ── POST ─────────────────────────────────────────────────────────────────────

const UpdateSchema = z.object({
  updates: z
    .array(
      z.object({
        bucket: z.enum(ALL_BUCKETS as [Bucket, ...Bucket[]]),
        model: z.enum(ALL_MODELS as [ModelId, ...ModelId[]]),
        effort: z.enum(ALL_EFFORTS as [Effort, ...Effort[]]),
        thinking_mode: z.enum(ALL_THINKING_MODES as [ThinkingMode, ...ThinkingMode[]]),
      }),
    )
    .min(1)
    .max(ALL_BUCKETS.length),
});

const postRoute: RouteHandler = {
  method: 'POST',
  path: '/api/model-config',
  async handle(req, res, ctx) {
    const raw = await readBody(req);
    const parsed = parseBody(UpdateSchema, raw);
    if (!parsed.ok) {
      json(res, 400, { error: parsed.error });
      return;
    }

    const { updates } = parsed.data;

    // Validate every update before writing any of them — partial-write
    // semantics across multiple buckets would be confusing for the UI.
    const failures: Array<{ bucket: string; error: string }> = [];
    for (const u of updates) {
      try {
        // upsertBucketConfig validates internally; dry-run by catching here
        // would require a separate validate call. Cheap enough to just do
        // the validation up front via the same path.
        // Re-import the validator to keep this transparent:
        const { validateBucketConfig } = await import('../services/model-config.js');
        const err = validateBucketConfig(u.model, u.effort, u.thinking_mode);
        if (err) failures.push({ bucket: u.bucket, error: err });
      } catch (err) {
        failures.push({ bucket: u.bucket, error: (err as Error).message });
      }
    }
    if (failures.length > 0) {
      json(res, 400, { error: 'validation_failed', failures });
      return;
    }

    // Apply all updates in a single transaction so a mid-write crash leaves
    // the table consistent.
    try {
      ctx.db.transaction(() => {
        for (const u of updates) {
          upsertBucketConfig(ctx.db, {
            bucket: u.bucket,
            model: u.model,
            effort: u.effort,
            thinking_mode: u.thinking_mode,
          });
        }
      })();
    } catch (err) {
      json(res, 500, { error: 'model-config write failed', detail: (err as Error).message });
      return;
    }

    json(res, 200, {
      ok: true,
      updated: updates.length,
      buckets: listBucketConfigs(ctx.db),
    });
  },
};

export const modelConfigRoutes: RouteHandler[] = [getRoute, postRoute];
