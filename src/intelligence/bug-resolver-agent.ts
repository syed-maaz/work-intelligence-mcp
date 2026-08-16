/**
 * BugResolverAgent — ADR-030 Phase C (Phase 76) — local-apply path.
 *
 * Picks up a bug in `'resolving'` status (set by POST /api/bugs/:id/resolve-attempt),
 * runs the strict pre-flight + apply pipeline, and flips the row to either
 * `'auto-resolved'` (success) or `'unable-to-resolve'` (any failure). Writes
 * a `bug_resolutions` audit row on every attempt regardless of outcome.
 *
 * Hard rules (each baked into a code path AND tested):
 *   1. NEVER push from any branch in the WI repo.
 *   2. NEVER touch ./repos/* subdirectories.
 *   3. NEVER touch anywhere outside the WI repo root.
 *   4. NEVER apply a patch that fails `git apply --check`.
 *   5. NEVER ship a change with broken types — typecheck failure → revert.
 *   6. NEVER run when BUG_RESOLVER_ENABLED=0 (agent doesn't register at boot;
 *      endpoint returns 400 with code 'resolver_disabled').
 *   7. NEVER branch-switch — commits land on whatever the current branch is.
 *
 * State machine:
 *
 *   user click → POST /api/bugs/:id/resolve-attempt
 *     route flips status: 'proposed' → 'resolving'
 *     route enqueues bugId for the agent
 *
 *   agent.processQueue() picks up the bugId:
 *     pre-flight (4 gates) → apply (3 steps) → audit + flip
 *
 *   gates (any failure → 'unable-to-resolve' + audit row):
 *     a. latest bug_investigations row exists with non-empty suggested_patch
 *     b. classifyAllTargets(files_to_change) === 'ALLOWED'
 *     c. git apply --check succeeds
 *
 *   apply (in WI repo root):
 *     1. git apply <patch>
 *     2. npm run typecheck (root + web if web files touched)
 *        → fail: git checkout -- . to revert + 'unable-to-resolve'
 *     3. git commit -m "auto-fix: bug #<id> — <root_cause first 60 chars>"
 *        (current branch, NEVER push)
 *
 * Testability — every external interaction is injected:
 *   gitApplyCheck, gitApply, runTypecheck, gitCommit, gitCheckoutHead.
 * The unit suite simulates each pre-flight failure + apply success +
 * revert-on-typecheck-failure without touching disk.
 *
 * Refs: docs/docs/adr/adr-030-self-healing-bug-loop.md § Phase C,
 *       .planning/phases/76-bug-resolver-agent/PLAN.md.
 */
import type Database from 'better-sqlite3';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { captureBug } from '../routes/bugs.js';
import {
  classifyAllTargets,
  getRepoRoot,
} from '../services/bugs/path-classifier.js';
import type {
  BugRow,
  BugInvestigationRow,
  BugResolutionOutcome,
} from '../types/bugs.js';

// ── Injected git/typecheck function shapes ─────────────────────────────────

/** True when `git apply --check <patchPath>` succeeds inside the WI repo root. */
export type GitApplyCheckFn = (patchPath: string, cwd: string) => boolean;

/** Throws on failure (its message becomes failure_reason). */
export type GitApplyFn = (patchPath: string, cwd: string) => void;

/**
 * Runs `npm run typecheck` (root + web if web files were touched).
 * Returns `null` on success, otherwise a string the caller stores in failure_reason.
 */
export type RunTypecheckFn = (touchedWeb: boolean, cwd: string) => string | null;

/** `git checkout -- .` to revert the working tree on typecheck failure. */
export type GitCheckoutHeadFn = (cwd: string) => void;

/**
 * Commit on the CURRENT branch with the supplied message. Never branch-switches.
 * Returns the resulting commit SHA (short or long — caller stores verbatim).
 */
export type GitCommitFn = (message: string, cwd: string) => string;

// ── Options + result types ─────────────────────────────────────────────────

export interface BugResolverOptions {
  db: Database.Database;
  /** Override the repo root (tests). Defaults to path-classifier's getRepoRoot(). */
  cwd?: string;
  gitApplyCheck?: GitApplyCheckFn;
  gitApply?: GitApplyFn;
  runTypecheck?: RunTypecheckFn;
  gitCheckoutHead?: GitCheckoutHeadFn;
  gitCommit?: GitCommitFn;
}

export type ResolveOutcome =
  | { ok: true; investigationId: number; commitSha: string; filesChanged: string[] }
  | { ok: false; reason: string; filesChanged: string[] };

export interface ResolveResult {
  bugId: number;
  outcome: BugResolutionOutcome;
  reason?: string;
  commitSha?: string;
  filesChanged: string[];
}

// ── Agent ──────────────────────────────────────────────────────────────────

export class BugResolverAgent {
  private db: Database.Database;
  private cwd: string;
  private gitApplyCheck: GitApplyCheckFn;
  private gitApply: GitApplyFn;
  private runTypecheck: RunTypecheckFn;
  private gitCheckoutHead: GitCheckoutHeadFn;
  private gitCommit: GitCommitFn;
  private queue: number[] = [];
  private inFlight = false;

  constructor(opts: BugResolverOptions) {
    this.db = opts.db;
    this.cwd = opts.cwd ?? getRepoRoot();
    this.gitApplyCheck = opts.gitApplyCheck ?? defaultGitApplyCheck;
    this.gitApply = opts.gitApply ?? defaultGitApply;
    this.runTypecheck = opts.runTypecheck ?? defaultRunTypecheck;
    this.gitCheckoutHead = opts.gitCheckoutHead ?? defaultGitCheckoutHead;
    this.gitCommit = opts.gitCommit ?? defaultGitCommit;
  }

  /** Bridge route handler calls this after flipping status='resolving'. */
  enqueue(bugId: number): void {
    if (!this.queue.includes(bugId)) this.queue.push(bugId);
  }

  /**
   * Idempotent health-tick. With no enqueued work this is a no-op so it can
   * be called from the agent registry without bookkeeping. Returns the
   * number of bugs processed this tick (0 or 1; we drain one per tick to
   * keep the agent registry responsive).
   */
  async tick(): Promise<{ processed: number; result?: ResolveResult }> {
    if (process.env.BUG_RESOLVER_ENABLED === '0') return { processed: 0 };
    if (this.inFlight) return { processed: 0 };
    const bugId = this.queue.shift();
    if (bugId === undefined) return { processed: 0 };
    this.inFlight = true;
    try {
      const result = await this.resolveOne(bugId);
      return { processed: 1, result };
    } finally {
      this.inFlight = false;
    }
  }

  /** Test entry point + bridge "process now" trigger. Skips inFlight guard. */
  async resolveOne(bugId: number): Promise<ResolveResult> {
    const bug = this.db.prepare(`SELECT * FROM bugs WHERE id=?`).get(bugId) as
      | BugRow
      | undefined;

    if (!bug) {
      // Nothing to flip; just write an audit row and bail.
      this.writeAuditRow(bugId, 'unable-to-resolve', 'bug not found', null, []);
      return { bugId, outcome: 'unable-to-resolve', reason: 'bug not found', filesChanged: [] };
    }

    // Load latest investigation. Phase 76 reads `bugs.last_investigation_id`
    // (set by Phase 75) — falls back to ORDER BY decided_at DESC if NULL
    // (older bugs that pre-date v54).
    const inv = this.loadLatestInvestigation(bug);
    const outcome = await this.runPipeline(bug, inv);

    // Write the audit row + flip status atomically.
    const filesChanged = outcome.filesChanged;
    if (outcome.ok) {
      this.db.transaction(() => {
        this.writeAuditRow(bug.id, 'auto-resolved', null, outcome.commitSha, filesChanged);
        this.db
          .prepare(`UPDATE bugs SET status='auto-resolved' WHERE id=?`)
          .run(bug.id);
      })();
      process.stderr.write(
        `[BugResolver] resolved #${bug.id} commit=${outcome.commitSha} files=${filesChanged.length}\n`,
      );
      return {
        bugId: bug.id,
        outcome: 'auto-resolved',
        commitSha: outcome.commitSha,
        filesChanged,
      };
    } else {
      this.db.transaction(() => {
        this.writeAuditRow(bug.id, 'unable-to-resolve', outcome.reason, null, filesChanged);
        this.db
          .prepare(`UPDATE bugs SET status='unable-to-resolve' WHERE id=?`)
          .run(bug.id);
      })();
      process.stderr.write(
        `[BugResolver] unable-to-resolve #${bug.id} reason="${outcome.reason}"\n`,
      );
      return {
        bugId: bug.id,
        outcome: 'unable-to-resolve',
        reason: outcome.reason,
        filesChanged,
      };
    }
  }

  // ── Pipeline ─────────────────────────────────────────────────────────────

  private async runPipeline(bug: BugRow, inv: BugInvestigationRow | null): Promise<ResolveOutcome> {
    // Gate 1 — investigation row + non-empty patch.
    if (!inv) {
      return { ok: false, reason: 'no investigation row for this bug', filesChanged: [] };
    }
    const patch = inv.suggested_patch;
    if (!patch || patch.trim().length === 0) {
      return { ok: false, reason: 'investigation has no suggested_patch', filesChanged: [] };
    }

    // Parse files_to_change. The DB stores it as JSON string per Phase B.
    let files: string[];
    try {
      const parsed = JSON.parse(inv.files_to_change);
      files = Array.isArray(parsed) ? parsed.filter(f => typeof f === 'string') : [];
    } catch {
      files = [];
    }

    // Gate 2 — path classifier (binary ALLOWED/BLOCKED).
    const classification = classifyAllTargets(files);
    if (classification.decision === 'BLOCKED') {
      return {
        ok: false,
        reason: `patch touches blocked path: ${classification.blocked.join(', ')}`,
        filesChanged: files,
      };
    }

    // Stage the patch on disk in a tmp file so git apply has a real path.
    let patchPath: string | null = null;
    try {
      const tmp = mkdtempSync(pathJoin(tmpdir(), 'wi-resolver-'));
      patchPath = pathJoin(tmp, `bug-${bug.id}.patch`);
      writeFileSync(patchPath, patch.endsWith('\n') ? patch : `${patch}\n`, 'utf8');
    } catch (err) {
      return {
        ok: false,
        reason: `tmp patch staging failed: ${err instanceof Error ? err.message : String(err)}`,
        filesChanged: files,
      };
    }

    try {
      // Gate 3 — git apply --check.
      let canApply: boolean;
      try {
        canApply = this.gitApplyCheck(patchPath, this.cwd);
      } catch (err) {
        return {
          ok: false,
          reason: `git apply --check threw: ${err instanceof Error ? err.message : String(err)}`,
          filesChanged: files,
        };
      }
      if (!canApply) {
        return { ok: false, reason: 'git apply --check failed', filesChanged: files };
      }

      // Apply step 1 — git apply.
      try {
        this.gitApply(patchPath, this.cwd);
      } catch (err) {
        return {
          ok: false,
          reason: `git apply failed: ${err instanceof Error ? err.message : String(err)}`,
          filesChanged: files,
        };
      }

      // Apply step 2 — typecheck. On failure, revert and bail.
      const touchedWeb = files.some(f => f.startsWith('web/'));
      const tcError = this.runTypecheck(touchedWeb, this.cwd);
      if (tcError !== null) {
        try { this.gitCheckoutHead(this.cwd); } catch {
          /* if revert itself fails the working tree is dirty; the failure_reason still records it */
        }
        return {
          ok: false,
          reason: `typecheck failed: ${tcError}`,
          filesChanged: files,
        };
      }

      // Apply step 3 — commit.
      const subject = `auto-fix: bug #${bug.id} — ${truncate(inv.root_cause ?? bug.error_name, 60)}`;
      let commitSha: string;
      try {
        commitSha = this.gitCommit(subject, this.cwd);
      } catch (err) {
        // Don't try to revert here — the working tree is clean (typecheck
        // passed) and the user can `git status` to inspect. Record the
        // failure and exit.
        return {
          ok: false,
          reason: `git commit failed: ${err instanceof Error ? err.message : String(err)}`,
          filesChanged: files,
        };
      }

      return { ok: true, investigationId: inv.id, commitSha, filesChanged: files };
    } finally {
      if (patchPath) {
        try { unlinkSync(patchPath); } catch { /* best-effort cleanup */ }
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private loadLatestInvestigation(bug: BugRow): BugInvestigationRow | null {
    if (bug.last_investigation_id !== null) {
      const row = this.db
        .prepare(`SELECT * FROM bug_investigations WHERE id=?`)
        .get(bug.last_investigation_id) as BugInvestigationRow | undefined;
      if (row) return row;
    }
    // Fallback for pre-v54 bugs.
    const row = this.db
      .prepare(
        `SELECT * FROM bug_investigations WHERE bug_id=? ORDER BY decided_at DESC LIMIT 1`,
      )
      .get(bug.id) as BugInvestigationRow | undefined;
    return row ?? null;
  }

  private writeAuditRow(
    bugId: number,
    outcome: BugResolutionOutcome,
    failureReason: string | null,
    commitSha: string | null,
    filesChanged: string[],
  ): void {
    const now = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO bug_resolutions
             (bug_id, attempt_at, outcome, cwd, files_changed, commit_sha, failure_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bugId,
          now,
          outcome,
          this.cwd,
          filesChanged.length > 0 ? JSON.stringify(filesChanged) : null,
          commitSha,
          failureReason,
        );
    } catch (err) {
      // The bug may have been deleted (FK cascade) or the bugs.id doesn't
      // match (caller passed a non-existent id). Self-capture so the issue
      // surfaces in /bugs but don't escalate.
      try {
        captureBug(this.db, {
          source: 'agent',
          errorName: err instanceof Error ? err.name : 'BugResolverAuditError',
          message: err instanceof Error ? err.message : String(err),
          stack: (err instanceof Error && err.stack) ? err.stack : undefined,
          context: { bugId, outcome },
        });
      } catch { /* swallow */ }
    }
  }
}

// ── Defaults — real git / npm calls ────────────────────────────────────────

const EXEC_OPTS: ExecFileSyncOptions = {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
};

function defaultGitApplyCheck(patchPath: string, cwd: string): boolean {
  try {
    execFileSync('git', ['apply', '--check', patchPath], { ...EXEC_OPTS, cwd });
    return true;
  } catch {
    return false;
  }
}

function defaultGitApply(patchPath: string, cwd: string): void {
  execFileSync('git', ['apply', patchPath], { ...EXEC_OPTS, cwd });
}

function defaultRunTypecheck(touchedWeb: boolean, cwd: string): string | null {
  try {
    execFileSync('npm', ['run', 'typecheck'], { ...EXEC_OPTS, cwd });
  } catch (err) {
    return err instanceof Error ? truncate(err.message, 400) : 'typecheck failed';
  }
  if (touchedWeb) {
    try {
      execFileSync('npx', ['tsc', '--noEmit'], { ...EXEC_OPTS, cwd: pathJoin(cwd, 'web') });
    } catch (err) {
      return err instanceof Error ? truncate(`web/ tsc: ${err.message}`, 400) : 'web/ tsc failed';
    }
  }
  return null;
}

function defaultGitCheckoutHead(cwd: string): void {
  execFileSync('git', ['checkout', '--', '.'], { ...EXEC_OPTS, cwd });
}

function defaultGitCommit(message: string, cwd: string): string {
  // -a is intentional — git apply touched the working tree but not the
  // index. -a stages tracked-file modifications + deletions, which is what
  // a unified-diff patch produces. New files added by the patch are also
  // tracked once `git apply` runs (it stages them in the index).
  execFileSync('git', ['commit', '-a', '-m', message], { ...EXEC_OPTS, cwd });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { ...EXEC_OPTS, cwd })
    .toString()
    .trim();
  return sha;
}

// ── tiny string helper (no DB / fs / clock) ────────────────────────────────

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n);
}
