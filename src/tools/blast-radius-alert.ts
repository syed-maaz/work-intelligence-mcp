/**
 * EP-48-3: Blast Radius Alerts
 *
 * Utilities for surfacing the impact of changes to a set of files:
 *   - checkTestCoverage: which files have test coverage in code_graph
 *   - checkBlastRadius:  which files depend on the changed files (BFS via code_graph)
 *
 * ADR-027 v2 item #1 (2026-05-30) — phantom-column fix
 *
 * The previous implementation queried `dependent_file` and `file` — neither
 * column exists in the `code_graph` table. The catch swallowed the resulting
 * SQLITE_ERROR and returned `{impactedCount: 0, files: []}` for every call,
 * regardless of how many real edges were stored. This was a silent-zero bug
 * live in production.
 *
 * Real schema (per `src/db/schema.ts` migration v24, kept current at v51):
 *
 *   code_graph(
 *     id, repo, file_path, symbol,
 *     ref_repo, ref_file, ref_symbol, ref_type, line_number, indexed_at
 *   )
 *
 *   `file_path` is the file holding the dependency.
 *   `ref_file`  is the file it depends on.
 *   `ref_type ∈ ('import','call','type','api_call','env_var',
 *               'test_covers','config_ref',
 *               'docker_base_image','helm_chart_dep','shell_env_ref')`.
 *
 * Blast radius asks "if X.ts changed, who breaks?" — i.e. who imports/refs X?
 * That is `WHERE ref_file = X` returning `file_path`. The narrowed catch only
 * swallows "no such table" so a fresh DB before code-graph migrations still
 * degrades gracefully, but a real query bug surfaces instead of being hidden.
 */

import { existsSync } from 'fs';
import { relative } from 'path';
import type Database from 'better-sqlite3';

/**
 * Check whether each file has a co-located test file.
 * Looks for <base>.test.ts, <base>.spec.ts, <base>.test.tsx, <base>.spec.tsx.
 */
export function checkTestCoverage(
  filePaths: string[],
): { file: string; hasTest: boolean }[] {
  return filePaths.map(file => {
    const base = file.replace(/\.(ts|tsx|js|jsx)$/, '');
    const hasTest =
      existsSync(`${base}.test.ts`) ||
      existsSync(`${base}.spec.ts`) ||
      existsSync(`${base}.test.tsx`) ||
      existsSync(`${base}.spec.tsx`);
    return { file, hasTest };
  });
}

/**
 * Query the code_graph table for all files that depend on (reference) any of
 * the given filePaths. Returns up to 50 dependent files.
 *
 * Considers ref_type ∈ {'import','test_covers'} as the dependency edge — the
 * other ref_types ('config_ref', 'env_var', etc.) are not blast-radius-shaped.
 *
 * Gracefully returns empty results when the code_graph table doesn't exist yet
 * (e.g. before EP-43 code indexing has run on a fresh clone). Any other error
 * is logged to stderr and re-thrown so smoke catches schema regressions.
 */
export function checkBlastRadius(
  filePaths: string[],
  db: Database.Database,
): { impactedCount: number; files: string[] } {
  if (filePaths.length === 0) return { impactedCount: 0, files: [] };
  try {
    const placeholders = filePaths.map(() => '?').join(',');
    const stmt = db.prepare(
      `SELECT DISTINCT file_path
         FROM code_graph
        WHERE ref_file IN (${placeholders})
          AND ref_type IN ('import','test_covers')
        LIMIT 50`,
    );
    const rows = stmt.all(...filePaths) as { file_path: string }[];
    const cwd = process.cwd();
    return {
      impactedCount: rows.length,
      files: rows.map(r => relative(cwd, r.file_path)),
    };
  } catch (err) {
    // Narrow catch — only swallow the legitimate "table not present yet" case.
    // Anything else is a real bug we want surfaced (the previous over-broad
    // catch hid the phantom-column bug in production for weeks).
    const msg = String((err as Error)?.message || err);
    if (/no such table/i.test(msg)) {
      return { impactedCount: 0, files: [] };
    }
    // eslint-disable-next-line no-console
    console.error('[blast-radius] unexpected SQL error:', msg);
    throw err;
  }
}
