/**
 * Cypher v2.5 D4 — tool-layer boundary check predicates (2026-06-26).
 *
 * Pure functions that determine whether a file-touching tool call's
 * path argument is safe to execute under a given worktree root.
 * Used by the loop's tool dispatcher (slice 2 — not yet wired) to
 * reject path-escape attempts before the tool's handler runs.
 *
 * **Why a separate module:** these predicates are stateless and
 * heavily testable. Keeping them out of the loop body lets the test
 * suite hammer the edge cases (absolute paths, symlink games,
 * `..` traversal, NUL bytes, Windows paths on a unix host, etc.)
 * without spinning up the whole loop.
 *
 * **Four reasons a path can be rejected:**
 *
 *   absolute_path_outside_root   — caller passed `/etc/passwd` and
 *                                  worktree_root is `/some/path/wt`
 *   path_traversal               — relative path resolves outside
 *                                  worktree_root via `..` segments
 *   symlink_escape               — path resolves through a symlink
 *                                  whose target is outside worktree_root
 *   subprocess_cwd_mismatch      — only used at subprocess invocation
 *                                  site; not produced by checkBoundary
 *                                  directly (subprocess gate is its
 *                                  own concern, slice 2)
 *
 * **Important: this module does NOT call `path.resolve()` against the
 * process cwd.** It explicitly anchors everything to worktree_root.
 * The loop is expected to NEVER trust the process cwd for path
 * resolution — boundary enforcement must be deterministic.
 *
 * See:
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D4
 *   - src/db/migrations/v84_d4_boundary_audit.ts (audit columns)
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

// ── Types ────────────────────────────────────────────────────────────────────

export type BoundaryViolation =
  | 'absolute_path_outside_root'
  | 'path_traversal'
  | 'symlink_escape'
  | 'subprocess_cwd_mismatch';

export interface BoundaryCheckOk {
  ok: true;
  /** Absolute, canonicalized (real-path-resolved) target path. */
  resolved: string;
}

export interface BoundaryCheckRejected {
  ok: false;
  reason: BoundaryViolation;
  /** The input path the caller tried (verbatim, for audit). */
  input: string;
  /** Detail message — what specifically failed. */
  detail?: string;
}

export type BoundaryCheckResult = BoundaryCheckOk | BoundaryCheckRejected;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve a path under worktree_root WITHOUT consulting the filesystem.
 * Returns an absolute path. Used for the cheap "lexical" check before
 * the more expensive `fs.realpathSync` lookup.
 */
function lexicalResolve(p: string, worktree_root: string): string {
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.resolve(worktree_root, p);
}

/**
 * Does `candidate` sit at or under `root`? Both must already be
 * absolute paths. Uses path.relative — when `candidate` is at or
 * inside `root`, the relative path will NOT start with '..' (it'd
 * either be '' for equal, or 'subdir/...' for inside).
 */
function isAtOrUnder(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

// ── checkBoundary ────────────────────────────────────────────────────────────

/**
 * Determine whether a path is safe to access under worktree_root.
 *
 * Algorithm:
 *   1. Reject NUL bytes outright (defense against C-string truncation
 *      attacks if a path leaks into a subprocess argv).
 *   2. Lexical resolve. If absolute and not under root → reject
 *      with absolute_path_outside_root.
 *   3. After lexical resolve, check `..` escape → reject with
 *      path_traversal.
 *   4. If `existsOnDisk` is true, `fs.realpathSync` the lexical path
 *      to canonicalize symlinks. If the realpath is outside root →
 *      reject with symlink_escape.
 *
 * The realpath step is optional because tool calls often target paths
 * that don't exist yet (e.g. file.write to a new file). Callers that
 * want strict symlink-escape protection set existsOnDisk=true after
 * verifying the path exists.
 *
 * Returns the canonicalized resolved path on success — the loop
 * persists this to cypher_steps.path_arg for the audit trail.
 */
export function checkBoundary(
  inputPath: string,
  worktree_root: string,
  opts: { existsOnDisk?: boolean } = {}
): BoundaryCheckResult {
  // Step 1: NUL byte defense.
  if (inputPath.indexOf('\0') !== -1) {
    return {
      ok: false,
      reason: 'path_traversal',
      input: inputPath,
      detail: 'path contains NUL byte',
    };
  }

  // Worktree root MUST be absolute. If the caller passed a relative
  // root, that's a programming error — we want to fail loudly.
  if (!path.isAbsolute(worktree_root)) {
    return {
      ok: false,
      reason: 'absolute_path_outside_root',
      input: inputPath,
      detail: `worktree_root must be absolute; got '${worktree_root}'`,
    };
  }

  // Normalize the root once so the comparisons below are consistent.
  const root = path.normalize(worktree_root);

  // Step 2 + 3: lexical resolve and at-or-under check. Catches both
  // absolute-outside-root AND relative-with-`..`-escape with one
  // comparison.
  const lex = lexicalResolve(inputPath, root);
  if (!isAtOrUnder(lex, root)) {
    return {
      ok: false,
      reason: path.isAbsolute(inputPath) ? 'absolute_path_outside_root' : 'path_traversal',
      input: inputPath,
      detail: `resolved '${lex}' is outside '${root}'`,
    };
  }

  // Step 4: realpath canonicalization (only if the caller wants it
  // AND the path actually exists). fs.realpathSync throws on
  // non-existent paths; we treat that as "lexical resolve is fine,
  // no symlink to chase" rather than a failure.
  if (opts.existsOnDisk) {
    try {
      const real = fs.realpathSync(lex);
      if (!isAtOrUnder(real, root)) {
        return {
          ok: false,
          reason: 'symlink_escape',
          input: inputPath,
          detail: `realpath '${real}' is outside '${root}'`,
        };
      }
      return { ok: true, resolved: real };
    } catch {
      // realpath failed (likely ENOENT). Fall through to the lexical
      // result — the path doesn't exist yet, so there's nothing to
      // canonicalize. The caller is responsible for repeating the
      // check after creating the file if symlink safety matters
      // post-creation.
    }
  }

  return { ok: true, resolved: lex };
}
