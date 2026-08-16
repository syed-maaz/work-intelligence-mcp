/**
 * Cypher path classifier — Slice A (2026-06-13).
 *
 * Decides whether Cypher may write/commit/push at a given path WITHOUT
 * asking, must ask first, or is hard-blocked. Same shape as ADR-030
 * Phase C BugResolverAgent's path classifier — re-implemented in the
 * Cypher service layer so Cypher's logic doesn't reach into bug-loop
 * internals (Hard rule 7).
 *
 * Three categories:
 *   ALLOWED          — write/commit OK without asking; push asks
 *   CONFIRM_REQUIRED — write/commit asks; push always asks
 *   BLOCKED          — refuse, never even ask
 *
 * Path categorisation:
 *   ALLOWED:           any path under the WI repo root (this repo)
 *   CONFIRM_REQUIRED:  any path under configured repo checkouts
 *   BLOCKED:           anywhere else — system paths, ~/Desktop, /tmp,
 *                      sibling clones outside ./repos/, etc.
 *
 * Per-action policy (matches the user's locked spec):
 *   Action  | ALLOWED | CONFIRM_REQUIRED | BLOCKED
 *   write   | OK      | confirm          | refuse
 *   commit  | OK      | confirm          | refuse
 *   push    | confirm | confirm          | refuse
 *
 * Why push always confirms even in ALLOWED:
 *   The hard rule from CLAUDE.md ("Never push to main/master. Other
 *   branches: confirm before push") binds Cypher too. WI's own repo
 *   isn't a free pass on outbound publication.
 */

import { resolve, normalize } from 'node:path';
import { getWiConfig } from '../wi-config.js';

export type PathCategory = 'ALLOWED' | 'CONFIRM_REQUIRED' | 'BLOCKED';
export type PathAction = 'write' | 'commit' | 'push';
export type ActionVerdict = 'allow' | 'confirm' | 'refuse';

export interface ClassifyOptions {
  /** Absolute path of the WI repo. Defaults to process.cwd(). */
  wiRoot?: string;
  /** Customer-repo paths that require confirmation. Defaults to configured repos from wi.config.json, env-gated fallback. */
  customerRepos?: string[];
}

export interface ClassifyResult {
  category: PathCategory;
  /** Resolved absolute path that was classified. */
  resolvedPath: string;
  /** Which root matched (or null for BLOCKED). */
  matchedRoot: string | null;
  /** Human-readable reason — surfaced in confirmation prompts and audit logs. */
  reason: string;
}

/**
 * Classify an arbitrary path string against Cypher's write boundaries.
 * Pure: no FS access, no DB. The caller resolves symlinks (or doesn't);
 * we treat the input as authoritative after node:path normalisation.
 *
 * Symlink-escape attacks: not handled here. Callers that want symlink-
 * safety should `fs.realpathSync` first. The classifier's job is to
 * categorise the path the caller intends to write, not to verify
 * intent matches reality.
 */
export function classifyPath(
  targetPath: string,
  opts: ClassifyOptions = {},
): ClassifyResult {
  const wiRoot = opts.wiRoot ?? process.cwd();
  const customerRepos = opts.customerRepos ?? (() => {
    const paths: string[] = [];
    try {
      for (const r of (getWiConfig().repos ?? [])) {
        paths.push(resolve(wiRoot, r.localPath));
      }
    } catch { /* config missing — fall through to env */ }
    if (paths.length === 0) {
      if (process.env.REPO_PATH) paths.push(resolve(wiRoot, 'repos/workspace'));
      if (process.env.OPERATIONS_PATH) paths.push(resolve(wiRoot, 'repos/operations'));
    }
    return paths.length > 0 ? paths : [resolve(wiRoot, 'repos/app'), resolve(wiRoot, 'repos/ops')];
  })();

  const resolvedTarget = normalize(resolve(targetPath));
  const resolvedWiRoot = normalize(resolve(wiRoot));

  // CONFIRM_REQUIRED check first — customer repos live UNDER wiRoot, so we
  // need to match them before the wiRoot containment check.
  for (const repo of customerRepos) {
    const resolvedRepo = normalize(resolve(repo));
    if (resolvedTarget === resolvedRepo || resolvedTarget.startsWith(resolvedRepo + '/')) {
      return {
        category: 'CONFIRM_REQUIRED',
        resolvedPath: resolvedTarget,
        matchedRoot: resolvedRepo,
        reason: `path is inside customer repo ${resolvedRepo}`,
      };
    }
  }

  if (resolvedTarget === resolvedWiRoot || resolvedTarget.startsWith(resolvedWiRoot + '/')) {
    return {
      category: 'ALLOWED',
      resolvedPath: resolvedTarget,
      matchedRoot: resolvedWiRoot,
      reason: "path is inside WI's own repo",
    };
  }

  return {
    category: 'BLOCKED',
    resolvedPath: resolvedTarget,
    matchedRoot: null,
    reason: 'path is outside WI repo and customer-repo allowlist',
  };
}

/**
 * Per-action verdict given a classification. Centralises the policy
 * matrix so callers don't reinvent it.
 */
export function actionVerdict(
  category: PathCategory,
  action: PathAction,
): ActionVerdict {
  if (category === 'BLOCKED') return 'refuse';
  if (category === 'CONFIRM_REQUIRED') return 'confirm';
  // ALLOWED:
  if (action === 'push') return 'confirm';
  return 'allow';
}

/**
 * Combined classify + verdict in one call — the shape Cypher's confirm
 * stage usually wants.
 */
export function decide(
  targetPath: string,
  action: PathAction,
  opts: ClassifyOptions = {},
): { verdict: ActionVerdict; classification: ClassifyResult } {
  const classification = classifyPath(targetPath, opts);
  return {
    verdict: actionVerdict(classification.category, action),
    classification,
  };
}
