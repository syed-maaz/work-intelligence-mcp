/**
 * D4 boundary check tests — ADR-038 v2.5 (2026-06-26).
 *
 * Hammer the boundary predicates with the kind of edge cases the
 * loop's tool dispatcher will face in production: absolute paths,
 * `..` escape, NUL bytes, symlink games (when existsOnDisk=true),
 * empty strings, trailing slashes.
 */

import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import migrateV52 from '../../../src/db/migrations/v52_model_config.js';
import migrateV59 from '../../../src/db/migrations/v59_cypher_tables.js';
import migrateV60 from '../../../src/db/migrations/v60_cypher_pm.js';
import migrateV61 from '../../../src/db/migrations/v61_pm_auto_actions.js';
import migrateV62 from '../../../src/db/migrations/v62_skill_actually_invoked.js';
import migrateV63 from '../../../src/db/migrations/v63_skill_catalog.js';
import migrateV64 from '../../../src/db/migrations/v64_cypher_outcomes.js';
import migrateV65 from '../../../src/db/migrations/v65_cypher_outcomes_legacy_upgrade.js';
import migrateV66 from '../../../src/db/migrations/v66_cap13_birth_decisions.js';
import migrateV67 from '../../../src/db/migrations/v67_cypher_loop_columns.js';
import migrateV80 from '../../../src/db/migrations/v80_d18_reasoning_trace.js';
import migrateV84 from '../../../src/db/migrations/v84_d4_boundary_audit.js';
import { checkBoundary } from '../../../src/services/cypher/boundary.js';

// ── Migration shape ──────────────────────────────────────────────────────────

describe('v84 migration', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    migrateV52(db);
    migrateV59(db);
    migrateV60(db);
    migrateV61(db);
    migrateV62(db);
    migrateV63(db);
    migrateV64(db);
    migrateV65(db);
    migrateV66(db);
    migrateV67(db);
    migrateV80(db);
    migrateV84(db);
  });
  afterEach(() => { db.close(); });

  it('adds path_arg + boundary_violation columns to cypher_steps', () => {
    const cols = db.prepare(`PRAGMA table_info(cypher_steps)`).all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('path_arg');
    expect(names).toContain('boundary_violation');
  });

  it('is idempotent', () => {
    expect(() => migrateV84(db)).not.toThrow();
    expect(() => migrateV84(db)).not.toThrow();
  });

  it('does not break existing cypher_steps inserts', () => {
    db.prepare(`INSERT INTO cypher_sessions (session_id, goal, user, status) VALUES ('cyp_v84', 'g', 'maaz', 'pending')`).run();
    expect(() => db.prepare(`
      INSERT INTO cypher_steps (session_id, stage, stage_index, status, payload)
      VALUES ('cyp_v84', 'tool_use', 0, 'completed', '{}')
    `).run()).not.toThrow();
  });
});

// ── checkBoundary basic behavior ─────────────────────────────────────────────

describe('checkBoundary — lexical checks (no fs)', () => {
  const ROOT = '/some/root';

  it('accepts a relative path that stays inside', () => {
    const r = checkBoundary('src/foo.ts', ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe('/some/root/src/foo.ts');
  });

  it('accepts a nested relative path', () => {
    const r = checkBoundary('src/a/b/c/d.ts', ROOT);
    expect(r.ok).toBe(true);
  });

  it('accepts the root itself (empty relative)', () => {
    const r = checkBoundary('.', ROOT);
    expect(r.ok).toBe(true);
  });

  it('rejects absolute path outside root', () => {
    const r = checkBoundary('/etc/passwd', ROOT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('absolute_path_outside_root');
  });

  it('rejects relative path with `..` that escapes', () => {
    const r = checkBoundary('../etc/passwd', ROOT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('path_traversal');
  });

  it('rejects deeply-traversed `..` escape', () => {
    const r = checkBoundary('a/b/../../../escape', ROOT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('path_traversal');
  });

  it('accepts `..` that stays inside (normalized)', () => {
    const r = checkBoundary('a/b/../c.ts', ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe('/some/root/a/c.ts');
  });

  it('rejects path containing NUL byte', () => {
    const r = checkBoundary('src/foo\0.ts', ROOT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('path_traversal');
  });

  it('rejects absolute path under sibling root', () => {
    const r = checkBoundary('/some/other_root/foo.ts', ROOT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('absolute_path_outside_root');
  });

  it('accepts absolute path inside root', () => {
    const r = checkBoundary('/some/root/src/foo.ts', ROOT);
    expect(r.ok).toBe(true);
  });

  it('rejects when worktree_root is not absolute', () => {
    const r = checkBoundary('foo.ts', 'relative/root');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('absolute_path_outside_root');
      expect(r.detail).toMatch(/must be absolute/);
    }
  });
});

// ── checkBoundary with realpath (existsOnDisk=true) ──────────────────────────

describe('checkBoundary — realpath canonicalization', () => {
  let tmpRoot: string;
  let symlinkTarget: string;

  beforeEach(() => {
    // macOS /tmp is itself a symlink to /private/tmp, so we
    // realpathSync the temp dirs once up-front; both worktree_root and
    // the symlink target need to live in the same realpath universe
    // for the boundary check to mean what we want it to mean.
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd4-boundary-')));
    symlinkTarget = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd4-outside-')));
    fs.writeFileSync(path.join(symlinkTarget, 'secret.txt'), 'leaked');
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(symlinkTarget, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('accepts a real file inside the root when existsOnDisk=true', () => {
    fs.writeFileSync(path.join(tmpRoot, 'inside.txt'), 'ok');
    const r = checkBoundary('inside.txt', tmpRoot, { existsOnDisk: true });
    expect(r.ok).toBe(true);
  });

  it('rejects a symlink that points outside the root (existsOnDisk=true)', () => {
    // Create a symlink inside tmpRoot pointing to a file outside.
    const linkPath = path.join(tmpRoot, 'escape-link.txt');
    fs.symlinkSync(path.join(symlinkTarget, 'secret.txt'), linkPath);
    const r = checkBoundary('escape-link.txt', tmpRoot, { existsOnDisk: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('symlink_escape');
  });

  it('non-existent path with existsOnDisk=true falls through to lexical check', () => {
    // Path doesn't exist; realpath would throw ENOENT. Result should
    // still be ok=true (lexical OK).
    const r = checkBoundary('does-not-exist-yet.txt', tmpRoot, { existsOnDisk: true });
    expect(r.ok).toBe(true);
  });
});
