/**
 * D5 permissions ledger tests — ADR-038 v2.5 (2026-06-26).
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import migrateV82 from '../../../src/db/migrations/v82_d5_permissions_ledger.js';
import {
  grantPermission,
  getPermission,
  listPermissions,
  revokePermission,
  recordPermissionUse,
  findActiveMatch,
  matchesPattern,
} from '../../../src/services/cypher/permissions.js';
import {
  TOOL_CATALOG,
  effectiveRiskTier,
  isToolGrantable,
} from '../../../src/services/cypher/tool-catalog.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV82(db);
  return db;
}

describe('v82 migration', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('creates permissions table with expected columns', () => {
    const cols = db.prepare(`PRAGMA table_info(permissions)`).all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    for (const n of ['id', 'granted_at', 'granted_by', 'action_pattern', 'scope_kind', 'scope_id',
                     'expires_at', 'expires_after_n', 'uses_count', 'status', 'reason']) {
      expect(names).toContain(n);
    }
  });

  it('creates permission_uses table with composite PK', () => {
    const cols = db.prepare(`PRAGMA table_info(permission_uses)`).all() as Array<{ name: string; pk: number }>;
    const pks = cols.filter(c => c.pk > 0).map(c => c.name);
    expect(pks).toEqual(expect.arrayContaining(['permission_id', 'dispatch_id', 'step_id']));
  });

  it('CHECK constraint rejects invalid scope_kind', () => {
    expect(() => db.prepare(`
      INSERT INTO permissions (id, granted_at, action_pattern, scope_kind)
      VALUES ('prm_x', 1, 'a', 'bogus')
    `).run()).toThrow();
  });

  it('CHECK constraint rejects invalid status', () => {
    expect(() => db.prepare(`
      INSERT INTO permissions (id, granted_at, action_pattern, scope_kind, status)
      VALUES ('prm_x', 1, 'a', 'one_shot', 'wat')
    `).run()).toThrow();
  });

  it('is idempotent', () => {
    expect(() => migrateV82(db)).not.toThrow();
    expect(() => migrateV82(db)).not.toThrow();
  });
});

describe('matchesPattern', () => {
  it('exact match', () => {
    expect(matchesPattern('file.edit:src/foo', 'file.edit:src/foo')).toBe(true);
    expect(matchesPattern('file.edit:src/foo', 'file.edit:src/bar')).toBe(false);
  });
  it('trailing wildcard matches prefix', () => {
    expect(matchesPattern('file.edit:*', 'file.edit:src/foo.ts')).toBe(true);
    expect(matchesPattern('file.edit:src/*', 'file.edit:src/foo.ts')).toBe(true);
    expect(matchesPattern('file.edit:src/*', 'file.edit:other/foo.ts')).toBe(false);
  });
  it('bare wildcard matches anything', () => {
    expect(matchesPattern('*', 'anything')).toBe(true);
    expect(matchesPattern('*', '')).toBe(true);
  });
});

describe('grant/get/list/revoke lifecycle', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('grantPermission returns prm_ id and status=active', () => {
    const p = grantPermission(db, { action_pattern: 'file.edit:*', scope_kind: 'standing' });
    expect(p.id).toMatch(/^prm_[a-f0-9]{12}$/);
    expect(p.status).toBe('active');
    expect(p.uses_count).toBe(0);
  });

  it('getPermission returns the row', () => {
    const p = grantPermission(db, { action_pattern: 'a', scope_kind: 'standing' });
    expect(getPermission(db, p.id)?.id).toBe(p.id);
    expect(getPermission(db, 'prm_ghost')).toBeNull();
  });

  it('listPermissions returns all rows; filters by status', () => {
    grantPermission(db, { action_pattern: 'a', scope_kind: 'standing' });
    const p2 = grantPermission(db, { action_pattern: 'b', scope_kind: 'standing' });
    revokePermission(db, p2.id, 'test');
    expect(listPermissions(db)).toHaveLength(2);
    expect(listPermissions(db, { status: 'active' })).toHaveLength(1);
    expect(listPermissions(db, { status: 'revoked' })).toHaveLength(1);
  });

  it('revokePermission flips status and returns true', () => {
    const p = grantPermission(db, { action_pattern: 'a', scope_kind: 'standing' });
    expect(revokePermission(db, p.id, 'reason')).toBe(true);
    const after = getPermission(db, p.id)!;
    expect(after.status).toBe('revoked');
    expect(after.revoked_reason).toBe('reason');
  });

  it('revokePermission on already-revoked returns false', () => {
    const p = grantPermission(db, { action_pattern: 'a', scope_kind: 'standing' });
    revokePermission(db, p.id);
    expect(revokePermission(db, p.id)).toBe(false);
  });
});

describe('findActiveMatch scope filtering', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('standing match wins regardless of context', () => {
    grantPermission(db, { action_pattern: 'file.edit:*', scope_kind: 'standing' });
    expect(findActiveMatch(db, 'file.edit:src/foo')).not.toBeNull();
  });

  it('session-scoped match requires matching session_id', () => {
    grantPermission(db, { action_pattern: 'a', scope_kind: 'session', scope_id: 'cyp_A' });
    expect(findActiveMatch(db, 'a', { session_id: 'cyp_A' })).not.toBeNull();
    expect(findActiveMatch(db, 'a', { session_id: 'cyp_B' })).toBeNull();
    expect(findActiveMatch(db, 'a')).toBeNull();
  });

  it('task-scoped match requires matching task_id', () => {
    grantPermission(db, { action_pattern: 'a', scope_kind: 'task', scope_id: 'tsk_A' });
    expect(findActiveMatch(db, 'a', { task_id: 'tsk_A' })).not.toBeNull();
    expect(findActiveMatch(db, 'a', { task_id: 'tsk_B' })).toBeNull();
  });

  it('project-scoped match requires matching project', () => {
    grantPermission(db, { action_pattern: 'a', scope_kind: 'project', scope_id: 'wi' });
    expect(findActiveMatch(db, 'a', { project: 'wi' })).not.toBeNull();
    expect(findActiveMatch(db, 'a', { project: 'example-service' })).toBeNull();
  });

  it('one_shot matches anywhere', () => {
    grantPermission(db, { action_pattern: 'a', scope_kind: 'one_shot' });
    expect(findActiveMatch(db, 'a')).not.toBeNull();
  });

  it('revoked grants are not matched', () => {
    const p = grantPermission(db, { action_pattern: 'a', scope_kind: 'standing' });
    revokePermission(db, p.id);
    expect(findActiveMatch(db, 'a')).toBeNull();
  });
});

describe('findActiveMatch lazy expiration', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('expires_at in the past → no match + status flipped to expired', () => {
    const p = grantPermission(db, {
      action_pattern: 'a',
      scope_kind: 'standing',
      expires_at: Date.now() - 1000,
    });
    expect(findActiveMatch(db, 'a')).toBeNull();
    expect(getPermission(db, p.id)!.status).toBe('expired');
  });

  it('expires_after_n hit → no match + status flipped to expired', () => {
    const p = grantPermission(db, {
      action_pattern: 'a',
      scope_kind: 'standing',
      expires_after_n: 2,
    });
    db.prepare(`UPDATE permissions SET uses_count = 2 WHERE id = ?`).run(p.id);
    expect(findActiveMatch(db, 'a')).toBeNull();
    expect(getPermission(db, p.id)!.status).toBe('expired');
  });

  it('expires_at in the future still matches', () => {
    grantPermission(db, {
      action_pattern: 'a',
      scope_kind: 'standing',
      expires_at: Date.now() + 60_000,
    });
    expect(findActiveMatch(db, 'a')).not.toBeNull();
  });
});

describe('recordPermissionUse', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('inserts permission_uses row and bumps uses_count', () => {
    const p = grantPermission(db, { action_pattern: 'a', scope_kind: 'standing' });
    recordPermissionUse(db, p.id, 'cyp_x', 1);
    expect(getPermission(db, p.id)!.uses_count).toBe(1);
    const audit = db.prepare(`SELECT COUNT(*) AS n FROM permission_uses WHERE permission_id = ?`).get(p.id) as { n: number };
    expect(audit.n).toBe(1);
  });

  it('idempotent on (permission_id, dispatch_id, step_id) — no double bump', () => {
    const p = grantPermission(db, { action_pattern: 'a', scope_kind: 'standing' });
    recordPermissionUse(db, p.id, 'cyp_x', 1);
    recordPermissionUse(db, p.id, 'cyp_x', 1);
    expect(getPermission(db, p.id)!.uses_count).toBe(1);
  });

  it('one_shot flips to consumed on first use', () => {
    const p = grantPermission(db, { action_pattern: 'a', scope_kind: 'one_shot' });
    recordPermissionUse(db, p.id, 'cyp_x', 1);
    expect(getPermission(db, p.id)!.status).toBe('consumed');
  });

  it('expires_after_n flips to expired when cap is hit', () => {
    const p = grantPermission(db, { action_pattern: 'a', scope_kind: 'standing', expires_after_n: 2 });
    recordPermissionUse(db, p.id, 'cyp_a', 1);
    expect(getPermission(db, p.id)!.status).toBe('active');
    recordPermissionUse(db, p.id, 'cyp_b', 1);
    expect(getPermission(db, p.id)!.status).toBe('expired');
  });

  it('standing without cap stays active across many uses', () => {
    const p = grantPermission(db, { action_pattern: 'a', scope_kind: 'standing' });
    for (let i = 1; i <= 5; i++) recordPermissionUse(db, p.id, `cyp_${i}`, 1);
    expect(getPermission(db, p.id)!.uses_count).toBe(5);
    expect(getPermission(db, p.id)!.status).toBe('active');
  });
});

describe('tool-catalog risk_tier integration', () => {
  it('effectiveRiskTier defaults to 1 when not declared', () => {
    const dummy = { name: 'x', description: 'x', category: 'auto' as const, posture_eligibility: [], input_schema: {}, estimated_duration_ms: 1, handler: async () => null };
    expect(effectiveRiskTier(dummy)).toBe(1);
  });

  it('isToolGrantable is false only for tier 3', () => {
    const make = (tier: 1 | 2 | 3 | undefined) => ({
      name: 'x', description: 'x', category: 'auto' as const,
      posture_eligibility: [], input_schema: {}, estimated_duration_ms: 1,
      handler: async () => null,
      risk_tier: tier,
    });
    expect(isToolGrantable(make(1))).toBe(true);
    expect(isToolGrantable(make(2))).toBe(true);
    expect(isToolGrantable(make(3))).toBe(false);
    expect(isToolGrantable(make(undefined))).toBe(true);
  });

  it('wi_bug_resolve_all is annotated as tier 3', () => {
    const t = TOOL_CATALOG.find(x => x.name === 'wi_bug_resolve_all');
    expect(t).toBeDefined();
    expect(t && effectiveRiskTier(t)).toBe(3);
  });

  it('brain_decide is annotated as tier 2', () => {
    const t = TOOL_CATALOG.find(x => x.name === 'brain_decide');
    expect(t && effectiveRiskTier(t)).toBe(2);
  });

  it('most tools default to tier 1', () => {
    const t = TOOL_CATALOG.find(x => x.name === 'brain_recall');
    expect(t && effectiveRiskTier(t)).toBe(1);
  });
});
