import type Database from 'better-sqlite3';
// TODO: ownership-map.ts is created by parallel agent 55-01; import will resolve once that file exists
import { getOwnership, type OwnershipEntry } from '../ownership-map.js';

export interface TraceInput {
  repo:      string;
  startFile: string;     // relative path, e.g. 'apps/recommended-links/useRecommendedLinks.ts'
  direction: 'callers' | 'callees' | 'both';
  maxDepth:  number;     // default 3, max 5
}

export interface TraceNode {
  file:    string;
  symbol:  string | null;
  repo:    string;
  team:    string | null;   // from ownership map
  isExternal: boolean;
}

export interface TraceEdge {
  from:     string;
  to:       string;
  refType:  string;   // 'call' | 'import' | 'api_call' | 'test_covers'
}

export interface TraceOutput {
  nodes:               TraceNode[];
  edges:               TraceEdge[];
  externalDeps:        string[];    // files/repos not owned by any Saturn team
  crossRepoBoundaries: Array<{ fromRepo: string; toRepo: string; via: string }>;
  maxDepthReached:     boolean;
  summary:             string;      // human-readable for ReAct observation
}

export function traceCallGraph(
  input: TraceInput,
  db: Database.Database,
  ownershipMap: OwnershipEntry[]
): TraceOutput {
  const visited = new Set<string>();
  const nodes: TraceNode[] = [];
  const edges: TraceEdge[] = [];
  const crossRepoBoundaries: Array<{ fromRepo: string; toRepo: string; via: string }> = [];

  function traverse(file: string, repo: string, depth: number): void {
    if (depth > input.maxDepth || visited.has(`${repo}:${file}`)) return;
    visited.add(`${repo}:${file}`);

    const ownership = getOwnership(file, repo, ownershipMap);
    nodes.push({
      file, repo,
      symbol: null,
      team: ownership?.team ?? null,
      isExternal: ownership === null,
    });

    const query = input.direction === 'callers'
      ? `SELECT file_path as src, ref_file as dst, ref_type, ref_repo FROM code_graph
         WHERE ref_file = ? AND repo = ? LIMIT 20`
      : `SELECT file_path as src, ref_file as dst, ref_type, ref_repo FROM code_graph
         WHERE file_path = ? AND repo = ? LIMIT 20`;

    const rows = db.prepare(query).all(file, repo) as Array<{
      src: string;
      dst: string;
      ref_type: string;
      ref_repo: string | null;
    }>;

    for (const row of rows) {
      edges.push({ from: row.src, to: row.dst, refType: row.ref_type });

      const nextFile = input.direction === 'callers' ? row.src : row.dst;
      const nextRepo = row.ref_repo ?? repo;

      if (nextRepo !== repo) {
        crossRepoBoundaries.push({ fromRepo: repo, toRepo: nextRepo, via: nextFile });
      }

      traverse(nextFile, nextRepo, depth + 1);
    }
  }

  traverse(input.startFile, input.repo, 0);

  const externalDeps = nodes
    .filter(n => n.isExternal && n.repo !== input.repo)
    .map(n => n.repo);

  const summary = formatTraceSummary(nodes, edges, crossRepoBoundaries, input.maxDepth, db, input.repo);

  return {
    nodes,
    edges,
    externalDeps: [...new Set(externalDeps)],
    crossRepoBoundaries,
    maxDepthReached: visited.size >= 20 * input.maxDepth,
    summary,
  };
}

/**
 * Look up the indexer's last successful run for `repo` from sync_state.
 * Sentinel row shape: topic_id='0', source='code-graph-<repo>'. Returns
 * `null` if the row doesn't exist (indexer never ran), or `{ lastSyncedAt,
 * staleHours }` otherwise.
 *
 * Pulled from src/tools/code-indexer.ts:101 — same write path that
 * `indexRepo` and `indexChangedSince` use, so this lookup mirrors what
 * /api/system-health.codeGraph reports.
 */
function getIndexerStatusForRepo(db: Database.Database, repo: string): { lastSyncedAt: string; staleHours: number } | null {
  try {
    const row = db.prepare(
      `SELECT last_synced_at FROM sync_state WHERE topic_id = '0' AND source = ?`
    ).get(`code-graph-${repo}`) as { last_synced_at: string | null } | undefined;
    if (!row || !row.last_synced_at) return null;
    const ts = Date.parse(row.last_synced_at);
    if (Number.isNaN(ts)) return null;
    const staleHours = (Date.now() - ts) / (1000 * 60 * 60);
    return { lastSyncedAt: row.last_synced_at, staleHours };
  } catch {
    // Schema gap, missing column, etc. Treat as "no signal" — fall through to
    // the bare empty-result message rather than asserting "indexer has not run".
    return null;
  }
}

/**
 * Append the indexer-status hint to an empty-result summary so a stale or
 * missing graph stops being indistinguishable from "this file genuinely has
 * no references". Closes ADR-027 v2 follow-up #4.
 *
 * - Indexer never ran (no sentinel row)              → "indexer has not run yet"
 * - Indexer last ran > 24h ago                        → "indexer last ran Nh ago (stale)"
 * - Indexer ran recently                              → no hint (the empty result is the real answer)
 */
function indexerHintFor(db: Database.Database, repo: string): string {
  const status = getIndexerStatusForRepo(db, repo);
  if (status === null) {
    return ' (indexer has not run yet for this repo — see /api/system-health.codeGraph for status)';
  }
  if (status.staleHours > 24) {
    const hours = Math.round(status.staleHours);
    return ` (indexer last ran ${hours}h ago — graph may be stale; see /api/system-health.codeGraph for status)`;
  }
  return '';
}

function formatTraceSummary(
  nodes: TraceNode[],
  edges: TraceEdge[],
  boundaries: Array<{ fromRepo: string; toRepo: string; via: string }>,
  _maxDepth: number,
  db: Database.Database,
  repo: string,
): string {
  if (nodes.length === 0) {
    return `No code graph entries found for this file. code_graph may not be indexed for this repo.${indexerHintFor(db, repo)}`;
  }
  if (edges.length === 0) {
    return `Traced ${nodes.length} node(s) through 0 edge(s): no references found. code_graph may not be indexed for this repo.${indexerHintFor(db, repo)}`;
  }

  const lines = [`Traced ${nodes.length} node(s) through ${edges.length} edge(s):`];

  const external = nodes.filter(n => n.isExternal);
  if (external.length > 0) {
    lines.push('', 'External nodes found:');
    external.forEach(n => lines.push(`  ${n.repo}/${n.file} (team: ${n.team ?? 'unknown'})`));
  }

  if (boundaries.length > 0) {
    lines.push('', 'Cross-repo boundaries:');
    boundaries.forEach(b => lines.push(`  ${b.fromRepo} → ${b.toRepo} via ${b.via}`));
  }

  return lines.join('\n');
}
