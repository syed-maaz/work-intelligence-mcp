/**
 * Shared filesystem-walk helpers for the code-graph indexer.
 *
 * Extracted from `src/tools/code-indexer.ts` so both the main-thread class
 * (`CodeIndexer`) and the worker entrypoint (`src/tools/code-indexer-worker.ts`)
 * can call them without dragging the entire indexer module (and its
 * better-sqlite3 import) into the worker bundle.
 *
 * Pure functions. No DB access. No ts-morph. Safe to import from either
 * thread. The CodeIndexer class re-exports these via thin private methods
 * for source-stability — existing call sites do not need to change.
 *
 * History:
 *   - 2026-06-24: extracted from code-indexer.ts during worker-thread
 *     migration (closes the residual event-loop block on POST
 *     /api/code-graph/index, per CLAUDE.md § Bridge MUST never be blocked).
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const TS_EXCLUDED = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
const FS_EXCLUDED = new Set(['node_modules', 'dist', 'build', '.git']);

/**
 * Recursively walk `dir`, returning absolute paths of every `.ts` / `.tsx`
 * file outside the standard ignore set (node_modules, dist, build, .git,
 * coverage). Behaviour matches the previous private `findTsFiles` on
 * `CodeIndexer` verbatim.
 */
export function findTsFiles(dir: string): string[] {
  const results: string[] = [];

  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (TS_EXCLUDED.has(entry)) continue;
      const full = join(current, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
          results.push(full);
        }
      } catch {
        // skip
      }
    }
  };
  walk(dir);
  return results;
}

/**
 * Walk `dir`, returning absolute paths of files whose extension is in
 * `exts`. Excludes node_modules / dist / build / .git (NOT coverage —
 * non-TS scanners may want to include that dir, though in practice it's
 * always empty of scannable files).
 */
export function findFilesByExt(dir: string, exts: readonly string[]): string[] {
  const results: string[] = [];

  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (FS_EXCLUDED.has(entry)) continue;
      const full = join(current, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (exts.includes(extname(entry))) {
          results.push(full);
        }
      } catch {
        // skip
      }
    }
  };
  walk(dir);
  return results;
}

/**
 * Walk `dir`, returning absolute paths whose basename matches any of the
 * regex `patterns`. Used for files without a stable extension (Dockerfile)
 * or where the extension is too coarse (Chart.yaml — we don't want to
 * scan all .yaml files as Helm charts).
 */
export function findFilesByName(dir: string, patterns: readonly RegExp[]): string[] {
  const results: string[] = [];

  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (FS_EXCLUDED.has(entry)) continue;
      const full = join(current, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (patterns.some((re) => re.test(entry))) {
          results.push(full);
        }
      } catch {
        // skip
      }
    }
  };
  walk(dir);
  return results;
}

/**
 * Locate a top-level `tsconfig.json` in `dir`. Returns the absolute path
 * or `null`. The ts-morph Project constructor takes the path verbatim —
 * a null value tells it to use compiler defaults.
 */
export function findTsConfig(dir: string): string | null {
  const candidate = join(dir, 'tsconfig.json');
  return existsSync(candidate) ? candidate : null;
}
