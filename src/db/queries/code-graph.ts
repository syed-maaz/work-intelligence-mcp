import type Database from 'better-sqlite3';

export interface BlastRadiusNode {
  repo: string;
  file_path: string;
  ref_type: string;
  depth: number;
}

export function getBlastRadius(
  db: Database.Database,
  repo: string,
  filePath: string,
  maxDepth = 2,
): BlastRadiusNode[] {
  const visited = new Set<string>();
  const result: BlastRadiusNode[] = [];
  const queue: Array<{ repo: string; file: string; depth: number }> = [{ repo, file: filePath, depth: 0 }];

  const stmt = db.prepare<[string, string], { repo: string; file_path: string; ref_type: string }>(
    'SELECT repo, file_path, ref_type FROM code_graph WHERE ref_repo = ? AND ref_file = ?',
  );

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth > maxDepth) continue;
    const key = `${item.repo}:${item.file}`;
    if (visited.has(key)) continue;
    visited.add(key);

    if (item.depth > 0) {
      result.push({ repo: item.repo, file_path: item.file, ref_type: '', depth: item.depth });
    }

    const rows = stmt.all(item.repo, item.file);
    for (const row of rows) {
      result.push({ repo: row.repo, file_path: row.file_path, ref_type: row.ref_type, depth: item.depth + 1 });
      if (item.depth + 1 < maxDepth) {
        queue.push({ repo: row.repo, file: row.file_path, depth: item.depth + 1 });
      }
    }
  }

  // Deduplicate by repo+file_path (keep lowest depth)
  const seen = new Map<string, BlastRadiusNode>();
  for (const node of result) {
    const k = `${node.repo}:${node.file_path}`;
    if (!seen.has(k) || seen.get(k)!.depth > node.depth) {
      seen.set(k, node);
    }
  }
  return Array.from(seen.values());
}

export function getTestCoverage(
  db: Database.Database,
  changedFiles: Array<{ repo: string; file: string }>,
): string[] {
  const testFiles = new Set<string>();
  const stmt = db.prepare<[string, string], { file_path: string }>(
    "SELECT DISTINCT file_path FROM code_graph WHERE ref_type = 'test_covers' AND ref_repo = ? AND ref_file = ?",
  );
  for (const { repo, file } of changedFiles) {
    const rows = stmt.all(repo, file);
    for (const row of rows) {
      testFiles.add(row.file_path);
    }
  }
  return Array.from(testFiles);
}

export function getFileOwners(
  db: Database.Database,
  _repo: string,
  _filePath: string,
): Array<{ github_handle: string; commit_count: number }> {
  // Will be enriched by EP-45 (team_members table). For now return empty.
  void db;
  return [];
}
