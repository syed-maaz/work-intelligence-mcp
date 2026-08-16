import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { defaultRepoName } from '../repo-names.js';

// GitCommitEntry interface mirrors the shape from dep-diff.ts (plan 55-02)
export interface GitCommitEntry {
  sha:              string;
  date:             string;
  author:           string;
  message:          string;
  filesChanged:     string[];
  isDependencyBump: boolean;
}

export interface ReadFileInput {
  file:     string;
  repo:     string;
  maxLines: number;   // default 400, hard cap 500
}

export interface ReadFileOutput {
  content:   string;
  lineCount: number;
  truncated: boolean;
  filePath:  string;
}

export function readFile(
  input: ReadFileInput,
  repoPaths: Record<string, string>
): ReadFileOutput {
  const repoPath = repoPaths[input.repo];
  if (!repoPath) throw new Error(`Unknown repo: ${input.repo}`);

  const fullPath = join(repoPath, input.file);
  if (!existsSync(fullPath)) throw new Error(`File not found: ${input.file}`);

  const lines = readFileSync(fullPath, 'utf8').split('\n');
  const cap = Math.min(input.maxLines ?? 400, 500);
  const truncated = lines.length > cap;
  const content = lines.slice(0, cap).join('\n');

  return { content, lineCount: lines.length, truncated, filePath: input.file };
}

// Read multiple changed files from a git window result
export function readChangedFiles(
  commits: GitCommitEntry[],
  repoPaths: Record<string, string>,
  maxFiles = 5
): ReadFileOutput[] {
  const allFiles = new Set<string>();
  for (const commit of commits) {
    for (const f of commit.filesChanged) {
      // Skip tests, lock files, generated files
      if (!f.match(/\.(test|spec)\.|package-lock\.json|\.generated\.|dist\/|build\//)) {
        allFiles.add(f);
      }
    }
  }

  return Array.from(allFiles)
    .slice(0, maxFiles)
    .map(f => {
      try { return readFile({ file: f, repo: defaultRepoName(), maxLines: 400 }, repoPaths); }
      catch { return null; }
    })
    .filter((r): r is ReadFileOutput => r !== null);
}
