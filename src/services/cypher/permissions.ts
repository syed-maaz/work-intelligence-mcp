/**
 * Cypher v2.5 D5 — permissions ledger accessor module (2026-06-26).
 *
 * Read/write helpers for the `permissions` + `permission_uses` tables
 * introduced by v82. The loop's confirm-gate consults this module
 * before asking the user to approve a tool call:
 *
 *   findActiveMatch(action_pattern, scope) → Permission | null
 *
 * Returning a Permission means "user already approved this; proceed
 * and record the use". Returning null means "ask the user".
 *
 * **Tier 3 safety floor:** this module DOES NOT inspect risk tiers.
 * The caller (loop confirm-gate) MUST reject the ledger lookup for
 * tier-3 tools regardless of what findActiveMatch returns. See
 * src/services/cypher/tool-catalog.ts for tier annotations and the
 * loop integration site.
 *
 * **Pattern matching:** action_pattern uses glob-style wildcards:
 *   - "file.edit:*"         matches any file.edit invocation
 *   - "smoke.run:bridge"    matches only that exact action
 *   - "git.commit:cypher/task_*"  matches branch prefix
 *
 * Today's implementation is a simple prefix + wildcard match with
 * one '*' allowed at the end. Future slices may upgrade to glob.
 *
 * See:
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D5
 *   - src/db/migrations/v82_d5_permissions_ledger.ts
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export type PermissionScopeKind =
  | 'one_shot'
  | 'task'
  | 'project'
  | 'session'
  | 'standing';

export type PermissionStatus = 'active' | 'expired' | 'revoked' | 'consumed';

export interface Permission {
  id: string;
  granted_at: number;
  granted_by: string;
  action_pattern: string;
  scope_kind: PermissionScopeKind;
  scope_id: string | null;
  expires_at: number | null;
  expires_after_n: number | null;
  uses_count: number;
  status: PermissionStatus;
  reason: string | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}

export interface GrantPermissionOpts {
  action_pattern: string;
  scope_kind: PermissionScopeKind;
  scope_id?: string;
  expires_at?: number;
  expires_after_n?: number;
  reason?: string;
  granted_by?: string;
}

export interface PermissionMatchContext {
  /** session_id of the running dispatch — matches scope_kind='session' grants. */
  session_id?: string;
  /** task_id if the dispatch is bound to one — matches scope_kind='task' grants. */
  task_id?: string;
  /** project slug for the dispatch — matches scope_kind='project' grants. */
  project?: string;
}

// ── ID generation ─────────────────────────────────────────────────────────────

function permissionId(): string {
  const rand = createHash('sha256')
    .update(String(Date.now()) + Math.random().toString(36))
    .digest('hex')
    .slice(0, 12);
  return `prm_${rand}`;
}

// ── Pattern matching ─────────────────────────────────────────────────────────

/**
 * Does the granted action_pattern match the action we're about to run?
 *
 * Supports a single trailing '*' wildcard. Exact prefix match otherwise.
 * Case-sensitive.
 *
 *   match("file.edit:*",       "file.edit:src/foo.ts") → true
 *   match("file.edit:src/*",   "file.edit:src/foo.ts") → true
 *   match("file.edit:src/foo", "file.edit:src/foo")    → true
 *   match("file.edit:src/foo", "file.edit:src/bar")    → false
 */
export function matchesPattern(pattern: string, action: string): boolean {
  if (pattern === action) return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return action.startsWith(prefix);
  }
  return false;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function grantPermission(
  db: Database.Database,
  opts: GrantPermissionOpts
): Permission {
  const now = Date.now();
  const id = permissionId();
  const row: Permission = {
    id,
    granted_at: now,
    granted_by: opts.granted_by ?? 'maaz',
    action_pattern: opts.action_pattern,
    scope_kind: opts.scope_kind,
    scope_id: opts.scope_id ?? null,
    expires_at: opts.expires_at ?? null,
    expires_after_n: opts.expires_after_n ?? null,
    uses_count: 0,
    status: 'active',
    reason: opts.reason ?? null,
    revoked_at: null,
    revoked_reason: null,
  };
  db.prepare(`
    INSERT INTO permissions (
      id, granted_at, granted_by, action_pattern,
      scope_kind, scope_id, expires_at, expires_after_n,
      uses_count, status, reason, revoked_at, revoked_reason
    ) VALUES (
      @id, @granted_at, @granted_by, @action_pattern,
      @scope_kind, @scope_id, @expires_at, @expires_after_n,
      @uses_count, @status, @reason, @revoked_at, @revoked_reason
    )
  `).run(row);
  return row;
}

export function getPermission(db: Database.Database, id: string): Permission | null {
  return (db.prepare(`SELECT * FROM permissions WHERE id = ?`).get(id) as Permission) ?? null;
}

export function listPermissions(
  db: Database.Database,
  opts: { status?: PermissionStatus } = {}
): Permission[] {
  let sql = `SELECT * FROM permissions WHERE 1=1`;
  const params: unknown[] = [];
  if (opts.status) { sql += ` AND status = ?`; params.push(opts.status); }
  sql += ` ORDER BY granted_at DESC`;
  return db.prepare(sql).all(...params) as Permission[];
}

export function revokePermission(
  db: Database.Database,
  id: string,
  reason?: string
): boolean {
  const now = Date.now();
  const r = db.prepare(`
    UPDATE permissions SET status = 'revoked', revoked_at = ?, revoked_reason = ?
    WHERE id = ? AND status = 'active'
  `).run(now, reason ?? null, id);
  return r.changes > 0;
}

// ── Match-and-consume ─────────────────────────────────────────────────────────

/**
 * Look up an active permission that matches the action + scope context.
 *
 * Returns the first matching row (most-recently granted; the index on
 * granted_at DESC keeps this cheap). Side-effect-free — the caller
 * MUST call recordPermissionUse() if it decides to proceed under the
 * matched grant; that's what triggers expires_after_n consumption and
 * the one_shot → 'consumed' status flip.
 */
export function findActiveMatch(
  db: Database.Database,
  action: string,
  ctx: PermissionMatchContext = {}
): Permission | null {
  // Pull the candidate active rows ordered newest-first. We don't push
  // pattern matching into SQL because of the wildcard semantics.
  const candidates = db
    .prepare(`SELECT * FROM permissions WHERE status = 'active' ORDER BY granted_at DESC`)
    .all() as Permission[];

  const now = Date.now();

  for (const p of candidates) {
    // Expiration sweep (lazy — D6 GC daemon also runs this nightly).
    if (p.expires_at !== null && p.expires_at <= now) {
      db.prepare(`UPDATE permissions SET status = 'expired' WHERE id = ? AND status = 'active'`)
        .run(p.id);
      continue;
    }
    if (p.expires_after_n !== null && p.uses_count >= p.expires_after_n) {
      db.prepare(`UPDATE permissions SET status = 'expired' WHERE id = ? AND status = 'active'`)
        .run(p.id);
      continue;
    }

    // Scope check.
    if (!scopeMatches(p, ctx)) continue;

    // Pattern check.
    if (!matchesPattern(p.action_pattern, action)) continue;

    return p;
  }
  return null;
}

function scopeMatches(p: Permission, ctx: PermissionMatchContext): boolean {
  switch (p.scope_kind) {
    case 'standing':
      return true;
    case 'session':
      return p.scope_id !== null && p.scope_id === ctx.session_id;
    case 'task':
      return p.scope_id !== null && p.scope_id === ctx.task_id;
    case 'project':
      return p.scope_id !== null && p.scope_id === ctx.project;
    case 'one_shot':
      // one_shot has no extra scope binding — first match anywhere wins.
      // The consumed-status flip in recordPermissionUse prevents reuse.
      return true;
  }
}

/**
 * Record a use of the matched permission. Increments uses_count, then:
 *   - one_shot kind → status flips to 'consumed' immediately
 *   - expires_after_n hit → status flips to 'expired'
 *
 * Also inserts a row in permission_uses for the audit trail.
 * Idempotent on (permission_id, dispatch_id, step_id) — duplicate use
 * recordings are silently ignored.
 */
export function recordPermissionUse(
  db: Database.Database,
  permission_id: string,
  dispatch_id: string,
  step_id: number
): void {
  const now = Date.now();
  // Audit row — idempotent insert.
  db.prepare(`
    INSERT OR IGNORE INTO permission_uses (permission_id, dispatch_id, step_id, used_at)
    VALUES (?, ?, ?, ?)
  `).run(permission_id, dispatch_id, step_id, now);

  // Bump uses_count atomically — but only if the audit row was actually
  // new (changes() > 0 after the IGNORE). better-sqlite3 reports
  // changes per statement, so we read it here.
  const audit_inserted = db.prepare(`SELECT changes() AS c`).get() as { c: number };
  if (audit_inserted.c === 0) return; // idempotent re-call: nothing to do

  db.prepare(`
    UPDATE permissions SET uses_count = uses_count + 1 WHERE id = ?
  `).run(permission_id);

  // Read the row back to apply lifecycle transitions.
  const p = getPermission(db, permission_id);
  if (!p) return;

  if (p.scope_kind === 'one_shot') {
    db.prepare(`UPDATE permissions SET status = 'consumed' WHERE id = ? AND status = 'active'`)
      .run(p.id);
    return;
  }
  if (p.expires_after_n !== null && p.uses_count >= p.expires_after_n) {
    db.prepare(`UPDATE permissions SET status = 'expired' WHERE id = ? AND status = 'active'`)
      .run(p.id);
  }
}
