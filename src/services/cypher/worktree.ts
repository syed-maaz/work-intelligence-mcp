/**
 * Cypher v2.5 D4 / C1 — per-task git worktree bootstrap (2026-06-28).
 *
 * ADR-038 § D4 specifies per-task working trees of a project's bare clone:
 *
 *   ~/.work-intelligence-mcp/
 *     repos/                     ← bare clones
 *       wi.git/
 *       app.git/                 (future — config-driven)
 *       ops.git/                 (future — config-driven)
 *     worktrees/                 ← per-task working trees
 *       tsk_<id>/                ← worktree on branch cypher/tsk_<id>
 *
 * This module owns the path conventions and the shell-out to
 * `git worktree add` / `git worktree remove`. It deliberately covers
 * only the `wi` project in this slice — bootstrap of other repos
 * needs upstream clone credentials and is a future
 * slice. Calls with non-'wi' projects currently throw
 * `unsupported_project_for_worktree` with the explanation in the message.
 *
 * # What's wired today (C1, 2026-06-28)
 *
 *   - WORKTREE_ROOT discovery (env override + ~/.work-intelligence-mcp default)
 *   - bareRepoPath(project) / worktreePath(task_id) / branchName(task_id)
 *   - bootstrapWiBareClone() — idempotent, clones the WI source repo if
 *     ~/.work-intelligence-mcp/repos/wi.git is missing
 *   - addWorktree(project, task_id) — bootstrap-then-add, returns path
 *   - removeWorktree(task_id) — git worktree remove, idempotent
 *
 * # What's NOT wired yet (deferred follow-up slices)
 *
 *   - Loop cwd pinning to the dispatched task's worktree (Gap 19 today
 *     uses process.cwd() — that's fine for the foundation tier;
 *     per-task pinning is the always-on-tier upgrade)
 *   - Branch-retention policy on close (success → keep, abandoned → delete)
 *   - Daily branch hygiene cron for stale cypher/* branches
 *   - Config-driven repo bootstrap (needs origin URLs +
 *     credentials; customer repos are working copies, not
 *     reliable origins, and some have no .git at all)
 *
 * # Failure modes are surfaced, not swallowed
 *
 * Every git invocation that fails throws with a `worktree_*` error
 * prefix the caller can grep. The intent is that the calling tool
 * handler (createTask, closeTask) catches the throw and returns
 * { ok: false, error: ... } instead of letting the dispatch wedge.
 *
 * See:
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D4
 *   - src/db/migrations/v84_d4_boundary_audit.ts (substrate)
 *   - src/services/cypher/boundary.ts (Gap 19 predicates)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

/**
 * WORKTREE_ROOT discovery.
 *
 * 1. CYPHER_WORKTREE_ROOT env var (tests override this to point at a
 *    tmpdir so they don't touch the user's real ~/.work-intelligence-mcp/).
 * 2. ~/.work-intelligence-mcp/ — the default that matches the ADR layout.
 *
 * The root must be readable; it does NOT need to exist when this module
 * loads — bootstrapWiBareClone() creates it lazily.
 */
export function worktreeRoot(): string {
  const env = process.env.CYPHER_WORKTREE_ROOT;
  if (env && env.length > 0) return resolve(env);
  return join(homedir(), '.work-intelligence-mcp');
}

/** Path to a project's bare clone under WORKTREE_ROOT/repos/<project>.git */
export function bareRepoPath(project: string): string {
  return join(worktreeRoot(), 'repos', `${project}.git`);
}

/** Path to a task's working tree under WORKTREE_ROOT/worktrees/<task_id> */
export function worktreePath(task_id: string): string {
  return join(worktreeRoot(), 'worktrees', task_id);
}

/** Branch name a task's worktree lives on. Convention from ADR § D4. */
export function branchName(task_id: string): string {
  return `cypher/${task_id}`;
}

/**
 * Idempotently create ~/.work-intelligence-mcp/repos/wi.git as a bare
 * clone of the current WI source repo. Source is process.cwd() (the
 * bridge boots from the repo root). Caller must hold the bootstrap
 * invariant — this function does not lock.
 *
 * Returns the bare repo path. Throws `worktree_bootstrap_failed` on
 * git error (caller handles).
 */
export function bootstrapWiBareClone(srcRepo?: string): string {
  const target = bareRepoPath('wi');
  if (existsSync(target)) return target;

  const reposDir = join(worktreeRoot(), 'repos');
  mkdirSync(reposDir, { recursive: true });

  const source = srcRepo ?? process.cwd();

  try {
    execFileSync(
      'git',
      ['clone', '--bare', source, target],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    const stderr = e.stderr?.toString() ?? '';
    throw new Error(
      `worktree_bootstrap_failed: git clone --bare ${source} → ${target}: ${stderr || e.message}`,
    );
  }

  return target;
}

/**
 * Project bootstrap dispatch. wi is the only supported project today;
 * other projects throw `unsupported_project_for_worktree` until the
 * upstream-clone wiring lands in a future slice.
 */
export function bootstrapProjectBareClone(project: string): string {
  if (project === 'wi') return bootstrapWiBareClone();
  throw new Error(
    `unsupported_project_for_worktree: project='${project}' has no bare clone configured. ` +
      `Only 'wi' is supported today. Configured repo wiring is a ` +
      `future slice once their upstream origins + credentials are configured.`,
  );
}

/**
 * Create a worktree for a task. Bootstraps the project's bare clone
 * if needed, then runs `git worktree add <path> -b <branch>`.
 *
 * Returns the worktree path on success. Throws `worktree_add_failed`
 * on git error.
 *
 * Idempotency: if the worktree already exists at the target path,
 * git's own check fires (`fatal: '<path>' already exists`) and we
 * surface that. Callers that need re-entrant safety should check
 * existsSync(worktreePath(task_id)) first.
 */
export function addWorktree(project: string, task_id: string): {
  worktree_path: string;
  branch: string;
} {
  bootstrapProjectBareClone(project);

  const target = worktreePath(task_id);
  const worktreesDir = join(worktreeRoot(), 'worktrees');
  mkdirSync(worktreesDir, { recursive: true });

  const branch = branchName(task_id);
  const bare = bareRepoPath(project);

  try {
    execFileSync(
      'git',
      ['--git-dir', bare, 'worktree', 'add', target, '-b', branch],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    const stderr = e.stderr?.toString() ?? '';
    throw new Error(
      `worktree_add_failed: project=${project} task_id=${task_id}: ${stderr || e.message}`,
    );
  }

  return { worktree_path: target, branch };
}

/**
 * Tear down a task's worktree. Calls `git worktree remove` against the
 * `wi` bare clone (the only project with worktrees today). Idempotent:
 * if the worktree directory is gone, the function silently no-ops.
 *
 * Branch is NOT deleted here — branch retention policy (keep on
 * success, delete on abandoned) is a future slice. Worktree removal
 * alone unblocks task closure without forfeiting the branch's history.
 *
 * Throws `worktree_remove_failed` on git error EXCEPT for the
 * "not a working tree" case which is treated as already-removed.
 */
export function removeWorktree(project: string, task_id: string): {
  removed: boolean;
} {
  const target = worktreePath(task_id);
  if (!existsSync(target)) return { removed: false };

  const bare = bareRepoPath(project);
  if (!existsSync(bare)) {
    // No bare clone → no metadata to update. Just rm -rf the dir.
    rmSync(target, { recursive: true, force: true });
    return { removed: true };
  }

  try {
    execFileSync(
      'git',
      ['--git-dir', bare, 'worktree', 'remove', '--force', target],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    const stderr = e.stderr?.toString() ?? '';
    // "is not a working tree" → already removed in a prior call.
    // Treat as success rather than throw.
    if (/not a working tree|not a valid path|does not exist/i.test(stderr)) {
      // Best-effort cleanup if the dir is still there but git doesn't
      // know about it.
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
      }
      return { removed: true };
    }
    throw new Error(
      `worktree_remove_failed: project=${project} task_id=${task_id}: ${stderr || e.message}`,
    );
  }

  return { removed: true };
}
