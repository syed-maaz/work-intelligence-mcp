/**
 * projects.ts unit tests — ADR-038 v2.5 D3 slice 1 (2026-06-26).
 *
 * Coverage:
 *   - v76 migration: projects table exists; wi + workspace seed rows present
 *   - getProject / listProjects / createProject / projectExists
 *   - Backfill: any DISTINCT tasks.project values are seeded as projects
 *   - INSERT OR IGNORE idempotency (re-running migration is safe)
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import migrateV59 from '../../../src/db/migrations/v59_cypher_tables.js';
import migrateV75 from '../../../src/db/migrations/v75_d2_task_memory.js';
import migrateV76 from '../../../src/db/migrations/v76_d3_projects_table.js';
import migrateV77 from '../../../src/db/migrations/v77_d3_tasks_project_fk.js';
import migrateV81 from '../../../src/db/migrations/v81_d19_recurate_pending.js';
import {
  getProject,
  listProjects,
  createProject,
  projectExists,
} from '../../../src/services/cypher/projects.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV59(db); // cypher_sessions
  migrateV75(db); // tasks, task_contexts, task_history
  process.env.REPO_PATH = './repos/workspace';
  migrateV76(db); // projects
  migrateV77(db); // tasks.project FK constraint
  migrateV81(db); // tasks.recurate_pending_at (D19, needed for createTask)
  return db;
}

// ── Migration shape ───────────────────────────────────────────────────────────

describe('v76 migration', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('creates the projects table with expected columns', () => {
    const cols = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('id');
    expect(names).toContain('name');
    expect(names).toContain('description');
    expect(names).toContain('default_branch');
    expect(names).toContain('repo_path');
    expect(names).toContain('created_at');
  });

  it('seeds wi project', () => {
    const wi = getProject(db, 'wi');
    expect(wi).not.toBeNull();
    expect(wi!.name).toBe('Work Intelligence MCP');
    expect(wi!.default_branch).toBe('master');
  });

  it('seeds workspace project', () => {
    const tb = getProject(db, 'workspace');
    expect(tb).not.toBeNull();
    expect(tb!.name).toBe('Primary Application');
    expect(tb!.default_branch).toBe('main');
    expect(tb!.repo_path).toBe('./repos/workspace');
  });

  it('is idempotent — re-running does not duplicate or throw', () => {
    expect(() => migrateV76(db)).not.toThrow();
    expect(() => migrateV76(db)).not.toThrow();
    const rows = db.prepare(`SELECT id FROM projects WHERE id IN ('wi','workspace')`).all();
    expect(rows).toHaveLength(2);
  });

  it('backfills any DISTINCT tasks.project values not in the seed list', () => {
    // Reset to a fresh DB at v75 only, insert a custom-project task, then run v76
    delete process.env.REPO_PATH; // no seed for 'workspace' → must backfill placeholder
    const db2 = new Database(':memory:');
    db2.pragma('foreign_keys = ON');
    db2.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    migrateV59(db2);
    migrateV75(db2);
    db2.prepare(`
      INSERT INTO tasks (id, title, posture, status, project, owner_user_id, created_at, last_touched)
      VALUES (?, ?, ?, 'open', ?, 'maaz', ?, ?)
    `).run('tsk_bf1', 'Backfill test', 'generic', 'workspace', Date.now(), Date.now());
    migrateV76(db2);
    const ops = getProject(db2, 'workspace');
    expect(ops).not.toBeNull();
    expect(ops!.description).toContain('Backfilled');
    db2.close();
  });
});

// ── Accessors ─────────────────────────────────────────────────────────────────

describe('getProject', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('returns null for unknown id', () => {
    expect(getProject(db, 'doesnotexist')).toBeNull();
  });

  it('returns the seeded wi row', () => {
    const wi = getProject(db, 'wi');
    expect(wi).not.toBeNull();
    expect(wi!.id).toBe('wi');
  });
});

describe('listProjects', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('returns at least the two seeded projects', () => {
    const all = listProjects(db);
    const ids = all.map(p => p.id);
    expect(ids).toContain('wi');
    expect(ids).toContain('workspace');
  });

  it('returns projects ordered by id ASC', () => {
    const all = listProjects(db);
    const ids = all.map(p => p.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

describe('createProject', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('inserts a new project and returns it', () => {
    const p = createProject(db, { id: 'demo', name: 'Demo Project' });
    expect(p.id).toBe('demo');
    expect(p.name).toBe('Demo Project');
    expect(p.created_at).toBeGreaterThan(0);
  });

  it('stores optional fields when provided', () => {
    const p = createProject(db, {
      id: 'full',
      name: 'Full',
      description: 'Has description',
      default_branch: 'develop',
      repo_path: '/path/to/repo',
    });
    expect(p.description).toBe('Has description');
    expect(p.default_branch).toBe('develop');
    expect(p.repo_path).toBe('/path/to/repo');
  });

  it('is idempotent — second call returns existing row without modification', () => {
    const first = createProject(db, { id: 'idem', name: 'First' });
    const second = createProject(db, { id: 'idem', name: 'Second' });
    expect(second.name).toBe('First'); // INSERT OR IGNORE → original row kept
    expect(second.id).toBe(first.id);
  });
});

describe('projectExists', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('returns true for seeded projects', () => {
    expect(projectExists(db, 'wi')).toBe(true);
    expect(projectExists(db, 'workspace')).toBe(true);
  });

  it('returns false for unknown ids', () => {
    expect(projectExists(db, 'ghost')).toBe(false);
  });

  it('returns true after createProject', () => {
    expect(projectExists(db, 'new1')).toBe(false);
    createProject(db, { id: 'new1', name: 'New' });
    expect(projectExists(db, 'new1')).toBe(true);
  });
});

// ── Slice 1 invariant flipped after slice 2 (v77 lands) ──────────────────────
// Before v77: orphan tasks.project inserts succeeded (no FK).
// After v77:  the FK constraint rejects them. This describes the v77
// post-condition; if a future migration drops the FK or adds a deferred
// constraint, this test catches the regression.

describe('slice 2 invariant (post-v77): FK on tasks.project rejects orphans', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('inserting a task with an unknown project id is rejected by the FK constraint', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO tasks (id, title, posture, status, project, owner_user_id, created_at, last_touched)
        VALUES ('tsk_orphan', 'Orphan task', 'generic', 'open', 'unknown_project_xyz', 'maaz', ?, ?)
      `).run(Date.now(), Date.now());
    }).toThrow(/FOREIGN KEY/i);
  });

  it('inserting a task with a seeded project (wi) succeeds', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO tasks (id, title, posture, status, project, owner_user_id, created_at, last_touched)
        VALUES ('tsk_wi_ok', 'WI task', 'generic', 'open', 'wi', 'maaz', ?, ?)
      `).run(Date.now(), Date.now());
    }).not.toThrow();
  });

  it('inserting a task with a seeded project (workspace) succeeds', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO tasks (id, title, posture, status, project, owner_user_id, created_at, last_touched)
        VALUES ('tsk_tb_ok', 'TB task', 'generic', 'open', 'workspace', 'maaz', ?, ?)
      `).run(Date.now(), Date.now());
    }).not.toThrow();
  });
});

// ── D3 slice 3 — createProject lifecycle integration with tasks FK ───────────

describe('D3 slice 3 — createProject + task FK integration', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); delete process.env.REPO_PATH; });

  it('createProject + then INSERT INTO tasks against that new project succeeds', () => {
    createProject(db, { id: 'my-new-project', name: 'My New' });
    expect(() => {
      db.prepare(`
        INSERT INTO tasks (id, title, posture, status, project, owner_user_id, created_at, last_touched)
        VALUES ('tsk_new1', 'New project task', 'generic', 'open', 'my-new-project', 'maaz', ?, ?)
      `).run(Date.now(), Date.now());
    }).not.toThrow();
  });

  it('createProject idempotency preserves original timestamp even on rapid re-call', () => {
    const first = createProject(db, { id: 'idem2', name: 'First' });
    // Wait a tiny amount; createProject uses Date.now() internally
    const second = createProject(db, { id: 'idem2', name: 'Second' });
    expect(second.created_at).toBe(first.created_at);
    expect(second.name).toBe('First'); // original wins, not overwritten
  });

  it('listProjects returns the new project after createProject', () => {
    const before = listProjects(db).map(p => p.id);
    expect(before).not.toContain('test-new');
    createProject(db, { id: 'test-new', name: 'Test New' });
    const after = listProjects(db).map(p => p.id);
    expect(after).toContain('test-new');
  });

  it('createProject stores all optional fields', () => {
    const p = createProject(db, {
      id: 'with-meta',
      name: 'With Metadata',
      description: 'A project for testing',
      default_branch: 'develop',
      repo_path: './repos/example',
    });
    expect(p.description).toBe('A project for testing');
    expect(p.default_branch).toBe('develop');
    expect(p.repo_path).toBe('./repos/example');
  });
});
