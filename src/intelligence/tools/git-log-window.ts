/**
 * Git Log Window Tool — Phase 55 Wave 2
 *
 * Fetches git commit history within a date range for a given repo and
 * surfaces dependency bumps. Designed to be used as a ReAct tool step.
 */

import { execFileSync } from 'child_process';
import type { DepChange } from './dep-diff.js';
import { extractDepChanges } from './dep-diff.js';

export interface GitLogWindowInput {
  repo:  string;
  since: string;  // YYYY-MM-DD
  until: string;  // YYYY-MM-DD
}

export interface GitCommitEntry {
  sha:              string;
  date:             string;
  author:           string;
  message:          string;
  filesChanged:     string[];
  isDependencyBump: boolean;  // any package.json / lockfile in filesChanged
}

export interface GitLogWindowOutput {
  commits:            GitCommitEntry[];
  dependencyChanges:  DepChange[];
  summary:            string;  // human-readable for ReAct observation
}

export async function gitLogWindow(
  input: GitLogWindowInput,
  repoPaths: Record<string, string>,  // { [repo: string]: string }
): Promise<GitLogWindowOutput> {
  const repoPath = repoPaths[input.repo];
  if (!repoPath) throw new Error(`Unknown repo: ${input.repo}`);

  // git log --since --until --name-status --format="%H|%ai|%an|%s"
  let rawLog: string;
  try {
    rawLog = execFileSync('git', [
      '-C', repoPath,
      'log',
      `--since=${input.since}`,
      `--until=${input.until}T23:59:59`,
      '--name-status',
      '--format=%H|%ai|%an|%s',
      '--no-merges',
    ], { encoding: 'utf8', timeout: 15_000 });
  } catch {
    return { commits: [], dependencyChanges: [], summary: 'No git history available or repo not accessible.' };
  }

  const commits = parseGitLog(rawLog);
  const dependencyChanges = await extractDepChanges(commits, repoPath);

  const summary = formatGitSummary(commits, dependencyChanges);
  return { commits, dependencyChanges, summary };
}

export function formatGitSummary(commits: GitCommitEntry[], deps: DepChange[]): string {
  if (commits.length === 0) return 'No commits found in this date range.';

  const lines = [
    `Found ${commits.length} commit(s) in range:`,
    ...commits.map(c => `  ${c.sha.slice(0, 8)} [${c.date.split('T')[0]}] ${c.author}: ${c.message}`),
  ];

  if (deps.length > 0) {
    lines.push('', 'Dependency changes:');
    deps.forEach(d => lines.push(`  ${d.packageName}: ${d.from} → ${d.to}`));
  }

  const bumpCommits = commits.filter(c => c.isDependencyBump);
  if (bumpCommits.length > 0) {
    lines.push('', `⚠️  ${bumpCommits.length} dependency bump commit(s) detected — investigate these first.`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEP_FILES = new Set(['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

export function parseGitLog(rawLog: string): GitCommitEntry[] {
  const commits: GitCommitEntry[] = [];
  if (!rawLog.trim()) return commits;

  // git outputs blocks separated by empty lines when using --name-status + --format
  // Each block looks like:
  //   <hash>|<date>|<author>|<subject>
  //   (empty line from --format)
  //   M\tfile1.ts
  //   A\tfile2.ts
  //   (blank line before next commit)
  const blocks = rawLog.split(/\n(?=[\da-f]{40}\|)/);

  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (lines.length === 0) continue;

    const headerLine = lines[0];
    const parts = headerLine.split('|');
    if (parts.length < 4) continue;

    const [sha, date, author, ...msgParts] = parts;
    const message = msgParts.join('|').trim();

    // Remaining lines are file status lines: "M\tpath/to/file"
    const filesChanged: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const fileLine = lines[i];
      // Skip lines that look like another commit header
      if (/^[\da-f]{40}\|/.test(fileLine)) break;
      const tabIdx = fileLine.indexOf('\t');
      if (tabIdx >= 0) {
        filesChanged.push(fileLine.substring(tabIdx + 1));
      }
    }

    const isDependencyBump = filesChanged.some(f => {
      const base = f.split('/').pop() ?? f;
      return DEP_FILES.has(base);
    });

    commits.push({
      sha: sha.trim(),
      date: date.trim(),
      author: author.trim(),
      message,
      filesChanged,
      isDependencyBump,
    });
  }

  return commits;
}
