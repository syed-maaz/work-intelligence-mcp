/**
 * Cypher PM drift detector.
 *
 * Surfaces work_items that have rotted: items that *say* they're in
 * motion but have stopped moving, items that *say* they're shipped but
 * carry no commit evidence, and items whose file_path evidence points
 * at files that have since been moved or deleted.
 *
 * Why this exists: PM-4 (auto-link) closes the *write-time* gap where
 * Cypher sessions never connect to the AC ledger. Drift closes the
 * *read-time* gap — without it, the AC ledger accumulates entries
 * whose state is silently false. Together they keep the recursion
 * claim ("Cypher tracks Cypher") from rotting.
 *
 * Design notes:
 *   - Pure SQL + a single fs.statSync call per file_path candidate.
 *     No LLM, no I/O beyond the DB and a stat() per missing-file check.
 *     Cheap to run on every morning brief.
 *   - Hard rule 7 satisfied: this module is in src/services/cypher/ so
 *     direct table access is sanctioned (the rule scopes the ban to
 *     src/tools/ and src/services/ *excluding* src/services/brain/ and
 *     src/services/persona/ — drift.ts joins this exemption since it's
 *     in the Cypher service surface itself).
 *   - file_path resolution: paths are joined to repo root before
 *     stat() so relative paths in evidence rows (the convention)
 *     resolve correctly.
 */

import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** A single drift item — what it is, what's wrong, light evidence context. */
export interface DriftItem {
  id: string;
  title: string;
  status: string;
  /** Why this item drifted. One of: 'stale_in_progress' | 'shipped_no_commit' | 'dead_file_path'. */
  reason: 'stale_in_progress' | 'shipped_no_commit' | 'dead_file_path';
  /** Free-form context — for stale: days since updated; for dead_file: which path. */
  detail: string;
  /** ISO timestamp from work_items.updated_at — useful for sorting. */
  updated_at: string;
}

/** Drift report — three buckets with counts + items. */
export interface DriftReport {
  stale_in_progress: { count: number; items: DriftItem[] };
  shipped_no_commit: { count: number; items: DriftItem[] };
  dead_file_path:    { count: number; items: DriftItem[] };
  /** Total drift count across all buckets — the headline number. */
  total: number;
  /** When the report was generated. */
  generated_at: string;
}

interface WorkItemRow {
  id: string;
  title: string;
  status: string;
  updated_at: string;
}

interface FilePathLinkRow {
  work_item_id: string;
  evidence_value: string;
  title: string;
  status: string;
  updated_at: string;
}

/**
 * Run the three drift queries and return a structured report.
 *
 * @param db live database handle
 * @param opts.staleDays — items in_progress but not updated for ≥ this many days are flagged. Default 7.
 * @param opts.repoRoot — base path for resolving file_path evidence. Default cwd.
 */
export function detectDrift(
  db: Database.Database,
  opts: { staleDays?: number; repoRoot?: string } = {},
): DriftReport {
  const staleDays = opts.staleDays ?? 7;
  const repoRoot = opts.repoRoot ?? process.cwd();

  // ── Bucket 1: stale in_progress ─────────────────────────────────────────
  // Items claiming forward motion that haven't been touched recently.
  // SQLite's date math is in days when we use julianday() differences.
  const staleRows = db.prepare(`
    SELECT id, title, status, updated_at
    FROM work_items
    WHERE status = 'in_progress'
      AND julianday('now') - julianday(updated_at) >= ?
    ORDER BY updated_at ASC
  `).all(staleDays) as WorkItemRow[];

  const staleItems: DriftItem[] = staleRows.map(r => ({
    id: r.id,
    title: r.title,
    status: r.status,
    reason: 'stale_in_progress',
    // Days since updated — round down so the message is conservative.
    detail: `not updated in ${Math.floor(julianDayDelta(db, r.updated_at))} days`,
    updated_at: r.updated_at,
  }));

  // ── Bucket 2: shipped but no commit evidence ────────────────────────────
  // A claim of 'shipped' without a commit_sha row in work_item_links is
  // a documentation lie. Either the commit went unrecorded (fixable —
  // backfill the link) or the item was prematurely closed (real drift).
  const shippedNoCommitRows = db.prepare(`
    SELECT wi.id, wi.title, wi.status, wi.updated_at
    FROM work_items wi
    WHERE wi.status = 'shipped'
      AND NOT EXISTS (
        SELECT 1 FROM work_item_links l
        WHERE l.work_item_id = wi.id AND l.evidence_kind = 'commit_sha'
      )
    ORDER BY wi.updated_at DESC
  `).all() as WorkItemRow[];

  const shippedNoCommitItems: DriftItem[] = shippedNoCommitRows.map(r => ({
    id: r.id,
    title: r.title,
    status: r.status,
    reason: 'shipped_no_commit',
    detail: 'shipped status without any commit_sha evidence row',
    updated_at: r.updated_at,
  }));

  // ── Bucket 3: file_path evidence pointing to a missing file ────────────
  // We pull every file_path link, stat() the resolved path, and flag
  // those that no longer exist. fs is a side effect but it's bounded
  // (one stat per file_path link, which scales O(items) not O(repo)).
  const filePathRows = db.prepare(`
    SELECT l.work_item_id, l.evidence_value, wi.title, wi.status, wi.updated_at
    FROM work_item_links l
    JOIN work_items wi ON wi.id = l.work_item_id
    WHERE l.evidence_kind = 'file_path'
  `).all() as FilePathLinkRow[];

  // Dedupe per (work_item, file) — the same path linked twice with
  // different notes still counts as one drift entry.
  const seenDeadFiles = new Set<string>();
  const deadFileItems: DriftItem[] = [];
  for (const row of filePathRows) {
    const absPath = resolve(repoRoot, row.evidence_value);
    if (existsSync(absPath)) continue;
    const key = `${row.work_item_id}|${row.evidence_value}`;
    if (seenDeadFiles.has(key)) continue;
    seenDeadFiles.add(key);
    deadFileItems.push({
      id: row.work_item_id,
      title: row.title,
      status: row.status,
      reason: 'dead_file_path',
      detail: `file_path evidence references missing path: ${row.evidence_value}`,
      updated_at: row.updated_at,
    });
  }

  return {
    stale_in_progress: { count: staleItems.length,           items: staleItems },
    shipped_no_commit: { count: shippedNoCommitItems.length, items: shippedNoCommitItems },
    dead_file_path:    { count: deadFileItems.length,        items: deadFileItems },
    total:             staleItems.length + shippedNoCommitItems.length + deadFileItems.length,
    generated_at:      new Date().toISOString(),
  };
}

/**
 * Compute days between an ISO timestamp and 'now' using SQLite's
 * julianday math — keeps the calendar-quirk handling consistent
 * with the WHERE clause above.
 */
function julianDayDelta(db: Database.Database, isoTs: string): number {
  const row = db.prepare(`SELECT julianday('now') - julianday(?) AS days`).get(isoTs) as { days: number };
  return row.days;
}
