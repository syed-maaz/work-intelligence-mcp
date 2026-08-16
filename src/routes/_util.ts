/**
 * REFACTOR-001 — shared route helpers, TS-native.
 *
 * Mirrors the JS helpers that have lived in web-server.js since day 1, with
 * proper types so extracted handlers stop being string-typed. The originals
 * stay where they are; we don't change web-server.js's helpers, we add this
 * sibling for the route modules.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ZodTypeAny, z } from 'zod';

/**
 * `res._corsHeaders` is set per-request by the middleware in web-server.js.
 * We read it through this narrow accessor so the TS types stay clean.
 */
function corsOf(res: ServerResponse): Record<string, string> {
  return (res as unknown as { _corsHeaders?: Record<string, string> })._corsHeaders ?? {};
}

/**
 * Write a JSON response with the request's CORS headers (set by the middleware).
 * Same shape as the json() helper in web-server.js so handlers ported from
 * there behave identically.
 */
export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...corsOf(res),
  });
  res.end(JSON.stringify(data));
}

/**
 * Read the request body as JSON. Returns `{}` on parse error rather than
 * throwing, matching the bridge's existing behaviour. Handlers should
 * validate the shape themselves.
 */
export async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer | string) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
  });
}

/**
 * Zod-validate a request body and return a typed result. Mirrors the
 * `parseBody` helper in web-server.js so handlers ported from there behave
 * identically on validation failure.
 */
export type ParseResult<S extends ZodTypeAny> =
  | { ok: true; data: z.infer<S> }
  | { ok: false; error: string };

export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): ParseResult<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path?.join('.') ?? 'body';
    return { ok: false, error: `${field}: ${issue?.message ?? 'Invalid input'}` };
  }
  return { ok: true, data: result.data };
}
