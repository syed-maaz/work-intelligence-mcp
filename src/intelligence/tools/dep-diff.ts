/**
 * Dependency Diff Tool — Phase 55 Wave 2
 *
 * Compares package.json at a commit SHA vs its parent to surface dependency
 * version changes. Called by gitLogWindow() on any commit that touches
 * package.json / lockfiles.
 */

import { execFileSync } from 'child_process';
import type { GitCommitEntry } from './git-log-window.js';

export interface DepChange {
  packageName: string;
  from:        string | null;
  to:          string | null;
  type:        'added' | 'removed' | 'changed';
}

export async function extractDepChanges(
  commits: GitCommitEntry[],
  repoPath: string,
): Promise<DepChange[]> {
  const depBumpCommits = commits.filter(c => c.isDependencyBump);
  if (depBumpCommits.length === 0) return [];

  const changes: DepChange[] = [];

  for (const commit of depBumpCommits.slice(0, 3)) {  // max 3 commits to keep fast
    try {
      // Get package.json at this commit and its parent
      const current = JSON.parse(
        execFileSync('git', ['-C', repoPath, 'show', `${commit.sha}:package.json`], { encoding: 'utf8' }),
      ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const parent = JSON.parse(
        execFileSync('git', ['-C', repoPath, 'show', `${commit.sha}~1:package.json`], { encoding: 'utf8' }),
      ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

      const allDeps  = { ...current.dependencies,  ...current.devDependencies };
      const prevDeps = { ...parent.dependencies,   ...parent.devDependencies };

      for (const [name, version] of Object.entries(allDeps)) {
        const prev = prevDeps[name];
        if (!prev) {
          changes.push({ packageName: name, from: null, to: version, type: 'added' });
        } else if (prev !== version) {
          changes.push({ packageName: name, from: prev, to: version, type: 'changed' });
        }
      }
      for (const [name] of Object.entries(prevDeps)) {
        if (!allDeps[name]) {
          changes.push({ packageName: name, from: prevDeps[name], to: null, type: 'removed' });
        }
      }
    } catch { /* non-fatal, skip commit */ }
  }

  return changes;
}
