/**
 * Cypher PM lens — work_items + work_item_links helpers (PM-1, 2026-06-13).
 *
 * Sole gateway for reading/writing project status. Routes, tools, and
 * the Cypher runtime call these helpers; they MUST NOT touch
 * work_items or work_item_links directly (Hard rule 7 — same posture
 * as the persona helpers in src/services/persona/recall.ts).
 *
 * What this is: the SQL face of the planning artifacts. PRDs and
 * ROADMAPs stay as markdown narrative; this module is the read model
 * for status, the write model for evidence linking.
 */

import type Database from 'better-sqlite3';

export type WorkItemStatus = 'pending' | 'in_progress' | 'shipped' | 'blocked' | 'deferred';

export type EvidenceKind =
  | 'commit_sha'
  | 'cypher_session_id'
  | 'smoke_section'
  | 'file_path'
  | 'pr_url';

export interface WorkItem {
  id: string;
  phase: string;
  wave: string | null;
  title: string;
  description: string | null;
  status: WorkItemStatus;
  priority: number;
  depends_on: string[];
  smoke_section: string | null;
  blocker_reason: string | null;
  shipped_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkItemLink {
  id: number;
  work_item_id: string;
  evidence_kind: EvidenceKind;
  evidence_value: string;
  note: string | null;
  created_at: string;
}

export interface WorkItemUpsert {
  id: string;
  phase: string;
  wave?: string | null;
  title: string;
  description?: string | null;
  status?: WorkItemStatus;
  priority?: number;
  depends_on?: string[];
  smoke_section?: string | null;
  blocker_reason?: string | null;
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  phase: string;
  wave: string | null;
  title: string;
  description: string | null;
  status: WorkItemStatus;
  priority: number;
  depends_on: string;
  smoke_section: string | null;
  blocker_reason: string | null;
  shipped_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToItem(r: RawRow): WorkItem {
  let deps: string[] = [];
  try {
    deps = JSON.parse(r.depends_on || '[]');
    if (!Array.isArray(deps)) deps = [];
  } catch { /* swallow */ }
  return { ...r, depends_on: deps };
}

/**
 * Look up a single work item by id. Returns null when missing.
 */
export function getWorkItem(db: Database.Database, id: string): WorkItem | null {
  const row = db.prepare<[string], RawRow | undefined>(
    `SELECT id, phase, wave, title, description, status, priority, depends_on,
            smoke_section, blocker_reason, shipped_at, created_at, updated_at
       FROM work_items WHERE id = ?`,
  ).get(id);
  return row ? rowToItem(row) : null;
}

export interface ListOptions {
  phase?: string;
  wave?: string;
  status?: WorkItemStatus;
  /** Only return items whose `depends_on` is empty OR all listed deps are 'shipped'. */
  unblocked_only?: boolean;
  limit?: number;
}

/**
 * List work items by phase / wave / status, optionally only the
 * unblocked ones (every dep already 'shipped'). Sort: priority ASC,
 * id ASC. Used by /wi-status next.
 */
export function listWorkItems(db: Database.Database, opts: ListOptions = {}): WorkItem[] {
  const where: string[] = ['1=1'];
  const params: Array<string | number> = [];
  if (opts.phase) { where.push('phase = ?'); params.push(opts.phase); }
  if (opts.wave)  { where.push('wave = ?');  params.push(opts.wave); }
  if (opts.status) { where.push('status = ?'); params.push(opts.status); }
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const sql = `
    SELECT id, phase, wave, title, description, status, priority, depends_on,
           smoke_section, blocker_reason, shipped_at, created_at, updated_at
      FROM work_items
     WHERE ${where.join(' AND ')}
     ORDER BY priority ASC, id ASC
     LIMIT ${limit}
  `;
  const rows = db.prepare<typeof params, RawRow>(sql).all(...params);
  let items = rows.map(rowToItem);

  if (opts.unblocked_only) {
    // Build a quick status lookup for the dependency check.
    const allRows = db.prepare<[], { id: string; status: WorkItemStatus }>(
      `SELECT id, status FROM work_items`,
    ).all();
    const statusById: Record<string, WorkItemStatus> = {};
    for (const r of allRows) statusById[r.id] = r.status;
    items = items.filter(it =>
      it.depends_on.length === 0 ||
      it.depends_on.every(d => statusById[d] === 'shipped'),
    );
  }
  return items;
}

/**
 * "What's next?" — pending items, unblocked only, top N by priority.
 * The hot read for /wi-status next.
 */
export function nextItems(db: Database.Database, limit: number = 5): WorkItem[] {
  return listWorkItems(db, { status: 'pending', unblocked_only: true, limit });
}

/**
 * Roll-up: status counts per phase/wave. The hot read for the
 * dashboard tile and the /wi-status overview.
 */
export interface StatusRollup {
  phase: string;
  wave: string | null;
  pending: number;
  in_progress: number;
  shipped: number;
  blocked: number;
  deferred: number;
  total: number;
}
export function statusRollup(db: Database.Database): StatusRollup[] {
  return db.prepare<[], StatusRollup>(`
    SELECT phase, wave,
           SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
           SUM(CASE WHEN status='shipped' THEN 1 ELSE 0 END) AS shipped,
           SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked,
           SUM(CASE WHEN status='deferred' THEN 1 ELSE 0 END) AS deferred,
           COUNT(*) AS total
      FROM work_items
     GROUP BY phase, wave
     ORDER BY phase, wave
  `).all();
}

/**
 * Evidence list for a work item.
 */
export function evidenceFor(db: Database.Database, workItemId: string): WorkItemLink[] {
  return db.prepare<[string], WorkItemLink>(`
    SELECT id, work_item_id, evidence_kind, evidence_value, note, created_at
      FROM work_item_links
     WHERE work_item_id = ?
     ORDER BY created_at ASC
  `).all(workItemId);
}

/**
 * Impact map: which work items reference this evidence value? E.g. given
 * a file path, returns the ACs that touch it. The hot read for the
 * /wi-status impact <path> query.
 */
export function impactedBy(db: Database.Database, kind: EvidenceKind, value: string): WorkItem[] {
  const rows = db.prepare<[string, string], RawRow>(`
    SELECT wi.id, wi.phase, wi.wave, wi.title, wi.description, wi.status,
           wi.priority, wi.depends_on, wi.smoke_section, wi.blocker_reason,
           wi.shipped_at, wi.created_at, wi.updated_at
      FROM work_items wi
      JOIN work_item_links l ON l.work_item_id = wi.id
     WHERE l.evidence_kind = ? AND l.evidence_value = ?
     ORDER BY wi.priority ASC, wi.id ASC
  `).all(kind, value);
  return rows.map(rowToItem);
}

// ---------------------------------------------------------------------------
// Write API
// ---------------------------------------------------------------------------

/**
 * UPSERT a work item. Used by the ingestion shim and by /api/cypher/pm.
 * Idempotent on `id`; preserves `created_at` on update.
 */
export function upsertWorkItem(db: Database.Database, item: WorkItemUpsert): void {
  const depsJson = JSON.stringify(item.depends_on ?? []);
  db.prepare(`
    INSERT INTO work_items (id, phase, wave, title, description, status, priority,
                            depends_on, smoke_section, blocker_reason, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      phase = excluded.phase,
      wave = excluded.wave,
      title = excluded.title,
      description = excluded.description,
      status = excluded.status,
      priority = excluded.priority,
      depends_on = excluded.depends_on,
      smoke_section = excluded.smoke_section,
      blocker_reason = excluded.blocker_reason,
      updated_at = datetime('now')
  `).run(
    item.id, item.phase, item.wave ?? null, item.title, item.description ?? null,
    item.status ?? 'pending', item.priority ?? 5, depsJson,
    item.smoke_section ?? null, item.blocker_reason ?? null,
  );
}

/**
 * Move a work item to a new status. Sets shipped_at when transitioning
 * to 'shipped'. No-op if the new status equals the old.
 */
export function setStatus(
  db: Database.Database,
  id: string,
  status: WorkItemStatus,
  blockerReason?: string,
): void {
  const setShipped = status === 'shipped' ? `, shipped_at = datetime('now')` : '';
  db.prepare(`
    UPDATE work_items
       SET status = ?, blocker_reason = ?, updated_at = datetime('now')${setShipped}
     WHERE id = ?
  `).run(status, blockerReason ?? null, id);
}

/**
 * Append evidence linking a work item to a commit/session/file/etc.
 * UNIQUE(work_item_id, evidence_kind, evidence_value) keeps it
 * idempotent — re-recording the same evidence is a no-op.
 */
export function linkEvidence(
  db: Database.Database,
  workItemId: string,
  kind: EvidenceKind,
  value: string,
  note?: string,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO work_item_links (work_item_id, evidence_kind, evidence_value, note)
    VALUES (?, ?, ?, ?)
  `).run(workItemId, kind, value, note ?? null);
}

/**
 * Bulk link helper — one evidence value linked to many work items.
 * Used by the Cypher session auto-linker (when a session goal mentions
 * several AC ids, each gets the session_id as evidence).
 */
export function linkMany(
  db: Database.Database,
  workItemIds: string[],
  kind: EvidenceKind,
  value: string,
  note?: string,
): number {
  let n = 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO work_item_links (work_item_id, evidence_kind, evidence_value, note)
    VALUES (?, ?, ?, ?)
  `);
  for (const id of workItemIds) {
    const r = stmt.run(id, kind, value, note ?? null);
    if (r.changes > 0) n++;
  }
  return n;
}
