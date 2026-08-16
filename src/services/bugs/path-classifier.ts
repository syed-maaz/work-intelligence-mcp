/**
 * Path classifier for ADR-030 Phase C (Phase 76) BugResolverAgent.
 *
 * Pure functions only — no DB, no fs writes, no network. The only fs read
 * is `realpathSync` for symlink resolution, which is what makes the
 * sibling-repo fence robust: a symlink under `repos/` that points to a
 * legitimate-looking path inside `src/` would otherwise slip through.
 *
 * Binary scope (locked in PLAN.md):
 *
 *   ALLOWED — any path under the WI repo root EXCLUDING workspace repo
 *             subdirectories.
 *
 *   BLOCKED — workspace repo subdirectories, anywhere outside
 *             the WI repo root (~/.claude, /tmp, parent dirs).
 *
 * Why a separate library and not inline in the agent? Three reasons:
 *   1. Pure functions are independently testable — 12+ vitest cases without
 *      a real filesystem (each test seeds tmp dirs + symlinks deliberately).
 *   2. The sibling-repo + outside-repo invariants are the hardest gates in
 *      Phase 76; isolating them means the agent's call site (a single
 *      `classifyAllTargets(...)` call) cannot accidentally bypass them.
 *   3. Mirrors the shape of `src/services/bugs/fingerprint.ts` — a
 *      pure-function library that the agent imports.
 *
 * Repo root detection: prefers process.env.WI_REPO_ROOT_OVERRIDE for tests,
 * otherwise climbs from this file's __dirname (src/services/bugs/ → repo
 * root) using realpathSync to canonicalize. The realpath ensures both the
 * REPO_ROOT and the candidate path are compared in the same canonical form
 * even when /Users/<x> is itself a symlink (macOS, /var → /private/var, etc).
 *
 * Refs: docs/docs/adr/adr-030-self-healing-bug-loop.md § Phase C,
 *       .planning/phases/76-bug-resolver-agent/PLAN.md § "Path classifier".
 */
import { realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWiConfig } from '../wi-config.js';

export type ResolveTarget = 'ALLOWED' | 'BLOCKED';

/**
 * Repo root resolution. Three layers, in order:
 *   1. WI_REPO_ROOT_OVERRIDE env — for tests that need to point at a tmp dir.
 *   2. git rev-parse --git-common-dir: resolves to the main repo's .git even
 *      when running inside a git worktree (where --show-toplevel would return
 *      the worktree dir, not the main repo root). We take the parent of the
 *      .git common dir to get the repo root.
 *   3. Climb from this file: src/services/bugs/path-classifier.ts → ../../..
 *   4. Always realpath the result so symlinks in /Users/* don't break compare.
 */
function detectRepoRoot(): string {
  const override = process.env.WI_REPO_ROOT_OVERRIDE;
  if (override) {
    try { return realpathSync(override); } catch { return override; }
  }
  // git rev-parse --git-common-dir works in both normal repos and worktrees.
  // In a worktree: returns something like /main/repo/.git
  // In the main repo: returns ".git" (relative), so we resolve from cwd.
  try {
    const gitCommonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf8' }).trim();
    const candidate = resolve(process.cwd(), gitCommonDir, '..');
    return realpathSync(candidate);
  } catch {
    // Fall through to file-based climb if git is unavailable.
  }
  // import.meta.url → src/services/bugs/path-classifier.ts (or .js after build)
  // Go up three: bugs → services → src → repo root
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, '..', '..', '..');
  try { return realpathSync(candidate); } catch { return candidate; }
}

const REPO_ROOT = detectRepoRoot();

const SIBLING_REPO_DIRS: readonly string[] = (() => {
  const dirs: string[] = [];
  if (process.env.REPO_PATH) dirs.push('repos/workspace');
  if (process.env.OPERATIONS_PATH) dirs.push('repos/operations');
  try {
    const repos = getWiConfig().repos ?? [];
    for (const r of repos) {
      const dir = `repos/${r.name}`;
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  } catch {
    // wi.config.json missing
  }
  return dirs.length > 0 ? dirs : ['repos/app'];
})();

/**
 * Real (canonical) sibling-repo paths. Computed lazily because they may not
 * exist on disk in tests (symlinks deliberately omitted). When realpath
 * fails we fall back to the resolved-but-not-canonicalized path; the
 * `startsWith` check below still matches the lexical form.
 */
function siblingRepoPaths(): string[] {
  return SIBLING_REPO_DIRS.map(dir => {
    const abs = resolve(REPO_ROOT, dir);
    try { return realpathSync(abs); } catch { return abs; }
  });
}

/**
 * Classify a single path. Resolves symlinks via realpath so a symlinked
 * sibling-repo path can't slip through.
 *
 * ALLOWED: any path under REPO_ROOT EXCLUDING the sibling repos.
 * BLOCKED: workspace repo subdirectories, anywhere outside REPO_ROOT.
 *
 * The path may not exist on disk — the resolver runs against `files_to_change`
 * paths from a Phase B investigation, which may be creating new files. That
 * case still resolves through `resolve(REPO_ROOT, path)` and falls into the
 * "doesn't exist" branch where we use the lexical resolved path.
 */
export function classifyResolveTarget(path: string): ResolveTarget {
  if (typeof path !== 'string' || path.length === 0) return 'BLOCKED';

  const abs = isAbsolute(path) ? path : resolve(REPO_ROOT, path);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    // File doesn't exist yet — fall back to the resolved abs path. The
    // patch may be creating it; that's fine as long as the resolved
    // location passes the scope check.
    real = abs;
  }

  // Sibling-repo fence first — these must beat the repo-root containment
  // check below, since they ARE under REPO_ROOT.
  for (const sibling of siblingRepoPaths()) {
    if (real === sibling || real.startsWith(`${sibling}/`)) return 'BLOCKED';
  }

  // Outside-repo fence — anything not under REPO_ROOT is BLOCKED.
  if (real === REPO_ROOT || real.startsWith(`${REPO_ROOT}/`)) return 'ALLOWED';

  return 'BLOCKED';
}

/**
 * Classify a list of paths. Returns the aggregate decision plus the list
 * of BLOCKED paths so the caller (the resolver agent) can record a
 * meaningful failure_reason like:
 *   "patch touches blocked path: repos/<name>/foo.ts"
 *
 * Aggregate rule: any single BLOCKED path → BLOCKED for the whole apply.
 */
export function classifyAllTargets(paths: string[]): {
  decision: ResolveTarget;
  blocked: string[];
} {
  const blocked = paths.filter(p => classifyResolveTarget(p) === 'BLOCKED');
  return {
    decision: blocked.length > 0 ? 'BLOCKED' : 'ALLOWED',
    blocked,
  };
}

/** Exported for tests + the agent's audit row (so it logs the cwd it ran in). */
export function getRepoRoot(): string {
  return REPO_ROOT;
}
