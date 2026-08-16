import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import type { ResearchResult } from '../../intelligence/research-engine.js';

export interface StoredFinding {
  id: number;
  question_hash: string;
  question_text: string;
  answer_summary: string;
  confidence: number;
  findings_json: string | null;
  model_used: string | null;
  tokens_used: number;
  iterations_used: number;
  duration_ms: number;
  created_at: string;
  last_used_at: string;
  use_count: number;
  stale: number;
}

export function hashQuestion(question: string): string {
  return createHash('sha256').update(question.trim().toLowerCase()).digest('hex').slice(0, 32);
}

export function findCachedResearch(db: Database.Database, question: string): StoredFinding | null {
  const hash = hashQuestion(question);
  const row = db.prepare(
    `SELECT * FROM research_findings WHERE question_hash = ? AND stale = 0`
  ).get(hash) as StoredFinding | undefined;

  if (row) {
    db.prepare(
      `UPDATE research_findings SET last_used_at = datetime('now'), use_count = use_count + 1 WHERE id = ?`
    ).run(row.id);
  }

  return row ?? null;
}

export function saveResearchFinding(
  db: Database.Database,
  question: string,
  result: ResearchResult,
  model: string,
): number {
  const hash = hashQuestion(question);

  const info = db.prepare(`
    INSERT INTO research_findings (question_hash, question_text, answer_summary, confidence, findings_json, model_used, tokens_used, iterations_used, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(question_hash) DO UPDATE SET
      answer_summary = excluded.answer_summary,
      confidence = excluded.confidence,
      findings_json = excluded.findings_json,
      model_used = excluded.model_used,
      tokens_used = excluded.tokens_used,
      iterations_used = excluded.iterations_used,
      duration_ms = excluded.duration_ms,
      last_used_at = datetime('now'),
      use_count = use_count + 1,
      stale = 0
  `).run(
    hash,
    question.trim(),
    result.answer,
    result.confidence,
    JSON.stringify({
      filesExamined: result.filesExamined,
      searchesPerformed: result.searchesPerformed,
      blockerReport: result.blockerReport,
    }),
    model,
    result.tokensUsed.input + result.tokensUsed.output,
    result.iterations,
    result.durationMs,
  );

  const rowId = Number(info.lastInsertRowid);
  const findingId = rowId > 0 ? rowId : ((db.prepare(
    `SELECT id FROM research_findings WHERE question_hash = ?`
  ).get(hash) as { id: number } | undefined)?.id ?? 0);

  return findingId;
}

export function saveReferences(
  db: Database.Database,
  findingId: number,
  filesExamined: string[],
  searchesPerformed: string[],
): void {
  db.prepare(`DELETE FROM finding_references WHERE finding_id = ?`).run(findingId);

  const insert = db.prepare(
    `INSERT INTO finding_references (finding_id, ref_type, ref_value) VALUES (?, ?, ?)`
  );

  for (const file of filesExamined) {
    insert.run(findingId, 'file', file);
  }
  for (const search of searchesPerformed) {
    insert.run(findingId, 'search', search);
  }
}

export function markFindingsStale(db: Database.Database, filePath: string): number {
  const findings = db.prepare(`
    SELECT DISTINCT f.id FROM research_findings f
    JOIN finding_references r ON r.finding_id = f.id
    WHERE r.ref_type = 'file' AND r.ref_value = ? AND f.stale = 0
  `).all(filePath) as Array<{ id: number }>;

  if (findings.length === 0) return 0;

  const ids = findings.map(f => f.id);
  db.prepare(
    `UPDATE research_findings SET stale = 1 WHERE id IN (${ids.map(() => '?').join(',')})`
  ).run(...ids);

  return ids.length;
}

export function indexFindingAsMessage(
  db: Database.Database,
  question: string,
  answer: string,
): void {
  const sourceId = `research_${hashQuestion(question)}`;
  db.prepare(`
    INSERT OR REPLACE INTO messages (topic_id, source, source_id, content, author, timestamp)
    VALUES (0, 'research', ?, ?, 'research-engine', datetime('now'))
  `).run(sourceId, `Q: ${question}\n\nA: ${answer.slice(0, 2000)}`);
}
