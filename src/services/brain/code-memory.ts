/**
 * Phase 79-06 — code-memory recall pillar.
 *
 * Detects coding-shaped queries and returns file/symbol-anchored context from
 * codebase_knowledge + code_graph (1-hop expansion). Wired into
 * buildPreflightContext and askTopicExpert.
 *
 * Non-throwing: errors are logged; callers receive [] on any failure.
 */

import type Database from 'better-sqlite3';

export interface CodeMemoryHit {
  source: 'codebase_knowledge' | 'code_graph';
  id: string;
  title: string;
  content: string;
  repo: string;
  file?: string;
  symbol?: string;
}

// ---------------------------------------------------------------------------
// Coding-shape heuristic
// ---------------------------------------------------------------------------

const FILE_EXT_RE = /\.\w{2,5}(?:\s|$|[,;)])/;
const CODING_VERBS_RE =
  /\b(implement|refactor|fix bug|debug|rewrite|migrate|rename|extract|inject|import|export|compile|build|lint|test|deploy|scaffold|wire|hook up|plug in)\b/i;
const CODING_SIGNAL_RE = /[`<>{}[\]()]/;
const CODE_EXT_LIST_RE = /\.(ts|tsx|js|jsx|py|go|java|cs|rb|rs|kt|swift|sh|yml|yaml|json|sql|md)\b/i;

/**
 * Returns true when the query looks like it's asking about code.
 * Heuristic — false-negatives preferred over false-positives (avoids
 * polluting non-coding chat with code-graph noise).
 */
export function isCodingQuery(query: string): boolean {
  if (FILE_EXT_RE.test(query) || CODE_EXT_LIST_RE.test(query)) return true;
  if (CODING_SIGNAL_RE.test(query)) return true;
  if (CODING_VERBS_RE.test(query)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// codebase_knowledge query
// ---------------------------------------------------------------------------

interface KnowledgeRow {
  id: number;
  repo: string;
  area: string;
  type: string;
  title: string;
  content: string;
  source_file: string | null;
}

function queryCodebaseKnowledge(
  db: Database.Database,
  keywords: string[],
  limit: number,
): CodeMemoryHit[] {
  if (keywords.length === 0) return [];
  try {
    const clauses = keywords
      .map(() => `(lower(title) LIKE ? OR lower(content) LIKE ? OR lower(area) LIKE ?)`)
      .join(' OR ');
    const params = keywords.flatMap((k) => [`%${k}%`, `%${k}%`, `%${k}%`]);
    const rows = db
      .prepare(
        `SELECT id, repo, area, type, title, content, source_file
           FROM codebase_knowledge
          WHERE ${clauses}
          ORDER BY rowid DESC
          LIMIT ?`,
      )
      .all(...params, limit) as KnowledgeRow[];
    return rows.map((r) => ({
      source: 'codebase_knowledge' as const,
      id: String(r.id),
      title: `[${r.repo}/${r.area}] ${r.title}`,
      content: r.content.slice(0, 800),
      repo: r.repo,
      file: r.source_file ?? undefined,
    }));
  } catch (err) {
    console.error('[code-memory] codebase_knowledge query failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// code_graph 1-hop expansion
// ---------------------------------------------------------------------------

interface GraphRow {
  file_path: string;
  symbol: string | null;
  ref_file: string;
  ref_symbol: string | null;
  ref_type: string;
  repo: string;
}

function queryCodeGraph(
  db: Database.Database,
  keywords: string[],
  limit: number,
): CodeMemoryHit[] {
  if (keywords.length === 0) return [];
  try {
    const clauses = keywords
      .map(
        () =>
          `(lower(file_path) LIKE ? OR lower(ref_file) LIKE ? OR lower(symbol) LIKE ? OR lower(ref_symbol) LIKE ?)`,
      )
      .join(' OR ');
    const params = keywords.flatMap((k) => [`%${k}%`, `%${k}%`, `%${k}%`, `%${k}%`]);
    const rows = db
      .prepare(
        `SELECT file_path, symbol, ref_file, ref_symbol, ref_type, repo
           FROM code_graph
          WHERE ${clauses}
          ORDER BY rowid DESC
          LIMIT ?`,
      )
      .all(...params, limit) as GraphRow[];
    return rows.map((r) => {
      const fromLabel = r.symbol ? `${r.file_path}::${r.symbol}` : r.file_path;
      const toLabel = r.ref_symbol ? `${r.ref_file}::${r.ref_symbol}` : r.ref_file;
      return {
        source: 'code_graph' as const,
        id: `${r.file_path}|${r.ref_file}|${r.ref_type}`,
        title: `${r.ref_type}: ${fromLabel} → ${toLabel}`,
        content: `${r.ref_type} from ${fromLabel} to ${toLabel}`,
        repo: r.repo,
        file: r.file_path,
        symbol: r.symbol ?? undefined,
      };
    });
  } catch (err) {
    console.error('[code-memory] code_graph query failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Returns code-memory hits for a query, or [] if the query is not
 * coding-shaped or if both tables are empty / error.
 *
 * Safe to call unconditionally — the heuristic gate ensures non-coding
 * queries return [] quickly without DB cost.
 */
export function queryCodeMemory(
  db: Database.Database,
  query: string,
  limit = 8,
): CodeMemoryHit[] {
  if (!isCodingQuery(query)) return [];

  const keywords = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 3)
    .slice(0, 6);

  if (keywords.length === 0) return [];

  const knowledgeHits = queryCodebaseKnowledge(db, keywords, Math.ceil(limit / 2));
  const graphHits = queryCodeGraph(db, keywords, Math.ceil(limit / 2));

  // knowledge rows first (richer content), then graph edges for cross-file links
  return [...knowledgeHits, ...graphHits].slice(0, limit);
}
