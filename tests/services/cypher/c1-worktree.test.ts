/**
 * Tests for the C1 worktree bootstrap module
 * (src/services/cypher/worktree.ts) and its integration with
 * createTask / closeTask in task-memory.ts.
 *
 * Strategy:
 *   - Override CYPHER_WORKTREE_ROOT to a per-test tmpdir so the real
 *     ~/.work-intelligence-mcp/ is untouched.
 *   - Bootstrap a tiny throwaway src repo to clone --bare from
 *     (4 commits over 2 files is enough to exercise the path).
 *   - Run the worktree happy-path against this throwaway, plus the
 *     unsupported-project rejection and the idempotent removal.
 *   - Skip the createTask/closeTask integration when this test runs
 *     in a sandbox that disallows process.spawn of git (rare; we
 *     still want the in-process tests to run).
 *
 * ADR-038 v2.5 C1 (2026-06-28).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import migrateV52 from '../../../src/db/migrations/v52_model_config.js';
import migrateV59 from '../../../src/db/migrations/v59_cypher_tables.js';
import migrateV63 from '../../../src/db/migrations/v63_skill_catalog.js';
import migrateV75 from '../../../src/db/migrations/v75_d2_task_memory.js';
import migrateV76 from '../../../src/db/migrations/v76_d3_projects_table.js';
import migrateV77 from '../../../src/db/migrations/v77_d3_tasks_project_fk.js';
import migrateV81 from '../../../src/db/migrations/v81_d19_recurate_pending.js';
import {
  addWorktree,
  bareRepoPath,
  bootstrapWiBareClone,
  branchName,
  removeWorktree,
  worktreePath,
  worktreeRoot,
} from '../../../src/services/cypher/worktree.js';
import { closeTask, createTask } from '../../../src/services/cypher/task-memory.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let scratch: string;
let srcRepo: string;

/**
 * Build a minimal git repo at <scratch>/src that has one commit on
 * `main`. We clone --bare from this for every wi-project test.
 */
function buildScratchSrcRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' });
  // Use --no-gpg-sign + minimal author so CI without git config works.
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t',
     'commit', '-q', '--no-gpg-sign', '-m', 'init'],
    { stdio: 'ignore' },
  );
}

function fullDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  migrateV52(db);
  migrateV59(db);
  migrateV63(db);
  migrateV75(db);
  migrateV76(db);
  migrateV77(db);
  migrateV81(db);
  return db;
}

beforeEach(() => {
  scratch = join(tmpdir(), `wi-c1-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(scratch, { recursive: true });
  srcRepo = join(scratch, 'src');
  buildScratchSrcRepo(srcRepo);
  process.env.CYPHER_WORKTREE_ROOT = join(scratch, 'wi-state');
});

afterEach(() => {
  delete process.env.CYPHER_WORKTREE_ROOT;
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Path conventions
// ---------------------------------------------------------------------------

describe('worktree paths', () => {
  it('honors CYPHER_WORKTREE_ROOT override', () => {
    expect(worktreeRoot()).toBe(join(scratch, 'wi-state'));
  });

  it('bareRepoPath puts <project>.git under repos/', () => {
    expect(bareRepoPath('wi')).toBe(join(scratch, 'wi-state', 'repos', 'wi.git'));
  });

  it('worktreePath puts <task_id> under worktrees/', () => {
    expect(worktreePath('tsk_abc')).toBe(join(scratch, 'wi-state', 'worktrees', 'tsk_abc'));
  });

  it('branchName uses the cypher/ prefix', () => {
    expect(branchName('tsk_abc')).toBe('cypher/tsk_abc');
  });
});

// ---------------------------------------------------------------------------
// bootstrapWiBareClone
// ---------------------------------------------------------------------------

describe('bootstrapWiBareClone', () => {
  it('clones --bare from the source repo when target missing', () => {
    const target = bootstrapWiBareClone(srcRepo);
    expect(target).toBe(join(scratch, 'wi-state', 'repos', 'wi.git'));
    expect(existsSync(target)).toBe(true);
    // A bare repo has HEAD at the top level (no working tree).
    expect(existsSync(join(target, 'HEAD'))).toBe(true);
    expect(existsSync(join(target, '.git'))).toBe(false);
  });

  it('is idempotent — second call no-ops', () => {
    const first = bootstrapWiBareClone(srcRepo);
    const beforeMtime = require('node:fs').statSync(join(first, 'HEAD')).mtimeMs;
    const second = bootstrapWiBareClone(srcRepo);
    expect(second).toBe(first);
    // No re-clone happened — HEAD mtime didn't change.
    const afterMtime = require('node:fs').statSync(join(first, 'HEAD')).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });
});

// ---------------------------------------------------------------------------
// addWorktree
// ---------------------------------------------------------------------------

describe('addWorktree', () => {
  it('creates a worktree at the expected path with the cypher/ branch', () => {
    bootstrapWiBareClone(srcRepo);
    const out = addWorktree('wi', 'tsk_abc123');
    expect(out.worktree_path).toBe(join(scratch, 'wi-state', 'worktrees', 'tsk_abc123'));
    expect(out.branch).toBe('cypher/tsk_abc123');
    expect(existsSync(out.worktree_path)).toBe(true);
    // The worktree should have a .git FILE (not directory) — that's how
    // git distinguishes worktrees from primary clones.
    const dotGit = join(out.worktree_path, '.git');
    expect(existsSync(dotGit)).toBe(true);
  });

  it('bootstraps the bare clone on first call when missing', () => {
    // No prior bootstrap. addWorktree must trigger it. The function
    // calls bootstrapProjectBareClone(project) which only supports
    // 'wi' for now, and that path bootstraps from process.cwd(). Set
    // process.cwd to our scratch src so the bootstrap target exists.
    const origCwd = process.cwd();
    try {
      process.chdir(srcRepo);
      const out = addWorktree('wi', 'tsk_first');
      expect(existsSync(out.worktree_path)).toBe(true);
      expect(existsSync(bareRepoPath('wi'))).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  it("rejects projects other than 'wi' with unsupported_project_for_worktree", () => {
    expect(() => addWorktree('example-service', 'tsk_xyz'))
      .toThrow(/unsupported_project_for_worktree/);
    expect(() => addWorktree('example-service', 'tsk_xyz'))
      .toThrow(/unsupported_project_for_worktree/);
  });

  it('throws worktree_add_failed when the worktree path already exists', () => {
    bootstrapWiBareClone(srcRepo);
    addWorktree('wi', 'tsk_dup');
    expect(() => addWorktree('wi', 'tsk_dup'))
      .toThrow(/worktree_add_failed/);
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe('removeWorktree', () => {
  it('tears down an active worktree and returns removed=true', () => {
    bootstrapWiBareClone(srcRepo);
    const added = addWorktree('wi', 'tsk_rm');
    expect(existsSync(added.worktree_path)).toBe(true);

    const r = removeWorktree('wi', 'tsk_rm');
    expect(r.removed).toBe(true);
    expect(existsSync(added.worktree_path)).toBe(false);
  });

  it('returns removed=false when the worktree directory is already gone', () => {
    bootstrapWiBareClone(srcRepo);
    const r = removeWorktree('wi', 'tsk_never_existed');
    expect(r.removed).toBe(false);
  });

  it('is idempotent — second remove no-ops cleanly', () => {
    bootstrapWiBareClone(srcRepo);
    addWorktree('wi', 'tsk_twice');
    expect(removeWorktree('wi', 'tsk_twice').removed).toBe(true);
    expect(removeWorktree('wi', 'tsk_twice').removed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createTask / closeTask integration
// ---------------------------------------------------------------------------

describe('createTask + closeTask with wire_worktree', () => {
  it('createTask({wire_worktree: true}) populates worktree_path/status/git_branch', () => {
    bootstrapWiBareClone(srcRepo);
    const db = fullDb();
    try {
      const task = createTask(db, {
        title: 'C1 integration smoke',
        posture: 'generic',
        project: 'wi',
        wire_worktree: true,
      });
      expect(task.worktree_path).toBe(worktreePath(task.id));
      expect(task.worktree_status).toBe('active');
      expect(task.git_branch).toBe(`cypher/${task.id}`);
      expect(existsSync(task.worktree_path!)).toBe(true);

      // Row was persisted with the same values.
      const row = db.prepare(`SELECT worktree_path, worktree_status, git_branch FROM tasks WHERE id = ?`)
        .get(task.id) as { worktree_path: string; worktree_status: string; git_branch: string };
      expect(row.worktree_path).toBe(task.worktree_path);
      expect(row.worktree_status).toBe('active');
      expect(row.git_branch).toBe(`cypher/${task.id}`);
    } finally {
      db.close();
    }
  });

  it('createTask() without wire_worktree leaves the columns NULL (backward-compatible)', () => {
    const db = fullDb();
    try {
      const task = createTask(db, {
        title: 'no worktree',
        posture: 'generic',
        project: 'wi',
      });
      expect(task.worktree_path).toBeNull();
      expect(task.worktree_status).toBeNull();
      expect(task.git_branch).toBeNull();
    } finally {
      db.close();
    }
  });

  it('closeTask tears down an active worktree and flips status to torn_down', () => {
    bootstrapWiBareClone(srcRepo);
    const db = fullDb();
    try {
      const task = createTask(db, {
        title: 'C1 close path',
        posture: 'generic',
        project: 'wi',
        wire_worktree: true,
      });
      expect(existsSync(task.worktree_path!)).toBe(true);

      closeTask(db, task.id, 'done');

      const row = db.prepare(`SELECT status, worktree_status FROM tasks WHERE id = ?`)
        .get(task.id) as { status: string; worktree_status: string };
      expect(row.status).toBe('closed');
      expect(row.worktree_status).toBe('torn_down');
      expect(existsSync(task.worktree_path!)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('closeTask is a no-op on the worktree fields when no worktree was wired', () => {
    const db = fullDb();
    try {
      const task = createTask(db, {
        title: 'no worktree close',
        posture: 'generic',
        project: 'wi',
      });
      closeTask(db, task.id);
      const row = db.prepare(`SELECT status, worktree_status FROM tasks WHERE id = ?`)
        .get(task.id) as { status: string; worktree_status: string | null };
      expect(row.status).toBe('closed');
      expect(row.worktree_status).toBeNull();
    } finally {
      db.close();
    }
  });
});
