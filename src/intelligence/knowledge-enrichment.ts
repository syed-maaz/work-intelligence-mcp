/**
 * REFACTOR-001 — `enrichKnowledgeFromResearch` moved from web-server.js to a
 * proper TS module so both the legacy bridge AND the extracted route modules
 * (pr, future jira, etc.) share one source of truth.
 *
 * Side-effects only — writes to `codebase_knowledge` and to MemPalace KG.
 * Best-effort: any failure is silently swallowed because this is enrichment,
 * not the primary response path.
 *
 * Originally from `web-server.js` lines 1900–1932. Behaviour is verbatim —
 * same thresholds, same SQL, same KG triples — to keep the 3 call sites
 * (chat, /api/jira/analyze, /api/pr/review) byte-equivalent.
 */

import type Database from 'better-sqlite3';
import { defaultRepoName } from './repo-names.js';

interface ResearchResult {
  confidence: number;
  answer: string;
  filesExamined?: string[] | null;
}

interface PalaceClientLike {
  isConnected: boolean;
  kgAdd: (subject: string, predicate: string, object: string) => Promise<unknown>;
}

export async function enrichKnowledgeFromResearch(
  db: Database.Database,
  palaceClient: PalaceClientLike | null | undefined,
  question: string,
  result: ResearchResult | null | undefined,
): Promise<void> {
  if (!result || result.confidence < 0.6) return;

  // Gap 7: codebase_knowledge upsert for high-confidence structural discoveries
  if (result.confidence >= 0.7 && result.filesExamined && result.filesExamined.length > 0) {
    try {
      const topFile = result.filesExamined[0];
      const area = topFile.split('/').slice(0, 3).join('/');
      db.prepare(`
        INSERT INTO codebase_knowledge (repo, area, type, title, content, source_file, indexed_at)
        VALUES (?, ?, 'pattern', ?, ?, ?, datetime('now'))
        ON CONFLICT(repo, area, type, title) DO UPDATE SET
          content = excluded.content,
          source_file = excluded.source_file,
          indexed_at = datetime('now')
      `).run(defaultRepoName(), area, question.slice(0, 100), result.answer.slice(0, 2000), topFile);
    } catch {
      // codebase_knowledge table may not exist yet on older DBs — non-critical
    }
  }

  // Gap 6: Palace KG triples
  if (palaceClient && palaceClient.isConnected && result.filesExamined) {
    try {
      for (const file of result.filesExamined.slice(0, 5)) {
        const component = file.split('/').slice(-2).join('/');
        await palaceClient.kgAdd(component, 'related_to', question.slice(0, 80));
      }
      const jiraMatch = question.match(/\b([A-Z]+-\d+)\b/);
      if (jiraMatch) {
        for (const file of result.filesExamined.slice(0, 5)) {
          await palaceClient.kgAdd(jiraMatch[1], 'touches', file);
        }
      }
    } catch {
      // palace enrichment non-critical
    }
  }
}
