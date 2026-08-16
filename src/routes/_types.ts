/**
 * REFACTOR-001 — route module types.
 *
 * Each route family exports a `RouteHandler[]` that the request dispatcher in
 * `web-server.js` walks. This preserves the existing `if (path === ...)` flow
 * while letting us extract handlers into testable, type-checked TS modules.
 *
 * Convention:
 *   - One file per `/api/<family>/*` namespace under `src/routes/<family>.ts`.
 *   - Each route is a `RouteHandler` with explicit method + path.
 *   - Handler signature is `(req, res, ctx, url)`. The context object carries
 *     shared dependencies (db, palaceClient, memoryEnricher, …) so handlers
 *     don't reach into the bridge's module scope.
 *   - Handlers MUST end the response (call `json(res, ...)` or `res.end()`).
 *
 * Migration order (low-risk → high-risk):
 *   1. brain — done (this PR)
 *   2. pr / action-items / topics / digest — pure SQL, no caches
 *   3. jira — has 1 cache (sprintMeta) that needs a ctx field
 *   4. teams / calendar / teammates / code-graph — straightforward
 *   5. brain decide + decide/stream + context — complex (caches + enrichment)
 *   6. sync — long-lived, careful
 */

import type Database from 'better-sqlite3';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Dependencies that route handlers may need. Add fields as new route families
 * get extracted. Each handler explicitly destructures what it uses, so unused
 * deps cost nothing.
 */
export interface RouteContext {
  db: Database.Database;
  /** MemPalace client; may be undefined when palace is not configured. */
  palaceClient?: unknown;
  /** MemoryEnricher; lazy-loaded in some bridges. */
  memoryEnricher?: unknown;
  /** Anthropic API key, threaded through to AI-calling handlers. Empty string when unset. */
  anthropicApiKey?: string;
  /**
   * Shared `AIAnalyzer` instance. Typed loosely as `unknown` here so this
   * file stays import-free (avoids a circular dependency between routes/
   * and services/). Route modules cast it to `AIAnalyzer` at the use site.
   */
  analyzer?: unknown;
  /**
   * BugResolverAgent — Phase 76. Loosely typed as `unknown` for the same
   * no-circular-import reason as `analyzer`. The /api/bugs/:id/resolve-attempt
   * route casts it to BugResolverAgent at the use site to call enqueue().
   * Undefined when BUG_RESOLVER_ENABLED=0 (the route returns 400 with code
   * 'resolver_disabled' in that case).
   */
  bugResolver?: unknown;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RouteHandler {
  method: HttpMethod;
  path: string;
  /**
   * Handle the request. MUST end the response.
   * `url` is pre-parsed from `req.url` for convenience.
   */
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
    url: URL,
  ) => Promise<void> | void;
}
