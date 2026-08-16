/**
 * /dream routes — the Dream Gate bridge surface (see docs: /dream feature).
 *
 *   GET  /api/dream/report  → the latest dream-report.json (pending + applied items)
 *   POST /api/dream/apply   → apply approved / reject items via the shared
 *                             scripts/dream-apply.mjs module. Body:
 *                               { approved?: number[], rejected?: number[], all?: boolean }
 *
 * The WI web UI /dream page reads the report and posts approvals here. The same
 * apply module backs the wi-dream-apply CLI skill, so there is ONE apply path.
 *
 * Read-only generate lives OUTSIDE the bridge (nightly launchd job / wi-dream
 * skill) — the bridge never generates, only serves the report and applies.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { json, readBody } from './_util.js';
import type { RouteHandler } from './_types.js';

const HOME = process.env.HOME || '';
const MEM_DIR =
  process.env.WI_DREAM_MEM_DIR ||
  join(HOME, '.wi', 'memory');
const REPORT_JSON = join(MEM_DIR, '.dream', 'dream-report.json');
// Repo root = two dirs up from dist/routes/. The apply module is a repo-root script.
const APPLY_SCRIPT = join(process.cwd(), 'scripts', 'dream-apply.mjs');

const reportRoute: RouteHandler = {
  method: 'GET',
  path: '/api/dream/report',
  handle(_req, res) {
    if (!existsSync(REPORT_JSON)) {
      json(res, 200, { generated_at: null, window_hours: 24, items: [] });
      return;
    }
    try {
      const report = JSON.parse(readFileSync(REPORT_JSON, 'utf8'));
      json(res, 200, report);
    } catch (err) {
      json(res, 500, { error: 'report_unreadable', detail: err instanceof Error ? err.message : String(err) });
    }
  },
};

const applyRoute: RouteHandler = {
  method: 'POST',
  path: '/api/dream/apply',
  async handle(req, res) {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { error: 'invalid_json' });
      return;
    }
    const b = (body || {}) as { approved?: unknown; rejected?: unknown; all?: unknown };
    const approved = Array.isArray(b.approved) ? b.approved.filter((n) => Number.isInteger(n)) : [];
    const rejected = Array.isArray(b.rejected) ? b.rejected.filter((n) => Number.isInteger(n)) : [];
    const all = b.all === true;

    // Safety gate mirroring /api/pr/create: an empty request is a no-op, not a
    // "apply everything" — you must name ids or pass all:true explicitly.
    if (!all && approved.length === 0 && rejected.length === 0) {
      json(res, 200, { ok: true, noop: true, results: [], detail: 'no ids and all!=true — nothing applied' });
      return;
    }

    const args = [APPLY_SCRIPT];
    if (all) args.push('--all');
    if (approved.length) args.push('--approve', approved.join(','));
    if (rejected.length) args.push('--reject', rejected.join(','));

    execFile('node', args, { cwd: process.cwd(), timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        json(res, 500, { error: 'apply_failed', detail: stderr || err.message });
        return;
      }
      // Each result line from the module is a JSON object; last line is a summary.
      const results = stdout
        .trim()
        .split('\n')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      json(res, 200, { ok: true, results });
    });
  },
};

export const dreamRoutes: RouteHandler[] = [reportRoute, applyRoute];
