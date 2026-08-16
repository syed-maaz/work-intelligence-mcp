import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Investigation queries — Phase 55 foundation + Phase 56 self-learning brain
// ---------------------------------------------------------------------------

// ─── Phase 55 stubs — to be implemented in Phase 55 waves ───────────────────
// These placeholder exports reserve the namespace. Phase 55 execution will
// fill in the actual implementations for session CRUD, knowledge indexing,
// and ReAct orchestrator helpers.

export interface InvestigationSession {
  id: number;
  issue_key: string;
  status: 'running' | 'done' | 'failed';
  regression_date: string | null;
  regression_date_confidence: string | null;
  hypothesis: string | null;
  conclusion: string | null;
  confidence: number | null;
  owner_team: string | null;
  react_trace: string;
  report_json: string | null;
  started_at: string;
  completed_at: string | null;
}

export function getSession(
  db: Database.Database,
  issueKey: string
): InvestigationSession | undefined {
  return db.prepare(`
    SELECT * FROM investigation_sessions WHERE issue_key = ?
  `).get(issueKey) as InvestigationSession | undefined;
}

export function createSession(
  db: Database.Database,
  issueKey: string
): number {
  const info = db.prepare(`
    INSERT INTO investigation_sessions (issue_key) VALUES (?)
  `).run(issueKey);
  return Number(info.lastInsertRowid);
}

const ALLOWED_SESSION_COLS = new Set([
  'status', 'hypothesis', 'conclusion', 'confidence', 'owner_team',
  'react_trace', 'report_json', 'regression_date', 'regression_date_confidence', 'completed_at',
]);

export function updateSession(
  db: Database.Database,
  sessionId: number,
  updates: Partial<Pick<InvestigationSession, 'status' | 'hypothesis' | 'conclusion' | 'confidence' | 'owner_team' | 'react_trace' | 'report_json' | 'regression_date' | 'regression_date_confidence' | 'completed_at'>>
): void {
  const cols = Object.keys(updates).filter(k =>
    ALLOWED_SESSION_COLS.has(k) && updates[k as keyof typeof updates] !== undefined
  );
  if (cols.length === 0) return;
  const setClause = cols.map(c => `${c} = ?`).join(', ');
  const values = cols.map(c => updates[c as keyof typeof updates] ?? null);
  db.prepare(`UPDATE investigation_sessions SET ${setClause} WHERE id = ?`).run(...values, sessionId);
}

// ─── Phase 55 full implementations ──────────────────────────────────────────

export interface ReActEntry {
  iteration: number;
  thought: string;
  tool: string;
  toolInput: unknown;
  observation: string;
}

export interface InvestigationReport {
  hypothesis: string;
  conclusion: string;
  confidence: number;
  ownerTeam: string;
  regressionDate?: string | null;
  regressionDateConfidence?: string;
  reportJson?: unknown;
}

export interface PastInvestigation {
  id: number;
  issue_key: string;
  conclusion: string;
  confidence: number;
  owner_team: string | null;
  completed_at: string | null;
}

/**
 * Create a new investigation session for the given issue key.
 * Idempotent: does nothing if a session already exists (IGNORE on conflict).
 */
export function createInvestigationSession(
  db: Database.Database,
  issueKey: string,
  regressionDate: string | null,
  confidence: string
): void {
  db.prepare(`
    INSERT OR IGNORE INTO investigation_sessions
      (issue_key, regression_date, regression_date_confidence, status)
    VALUES (?, ?, ?, 'running')
  `).run(issueKey, regressionDate, confidence);
}

/**
 * Append a ReAct trace entry to the session's react_trace JSON array.
 */
export function appendReActTrace(
  db: Database.Database,
  issueKey: string,
  entry: ReActEntry
): void {
  const row = db.prepare(
    `SELECT react_trace FROM investigation_sessions WHERE issue_key = ?`
  ).get(issueKey) as { react_trace: string } | undefined;

  if (!row) return;

  const trace: ReActEntry[] = JSON.parse(row.react_trace || '[]');
  trace.push(entry);

  db.prepare(
    `UPDATE investigation_sessions SET react_trace = ? WHERE issue_key = ?`
  ).run(JSON.stringify(trace), issueKey);
}

/**
 * Mark a session as done and write the final report fields.
 */
export function completeInvestigation(
  db: Database.Database,
  issueKey: string,
  report: InvestigationReport
): void {
  db.prepare(`
    UPDATE investigation_sessions SET
      status                     = 'done',
      hypothesis                 = ?,
      conclusion                 = ?,
      confidence                 = ?,
      owner_team                 = ?,
      regression_date            = COALESCE(?, regression_date),
      regression_date_confidence = COALESCE(?, regression_date_confidence),
      report_json                = ?,
      completed_at               = datetime('now')
    WHERE issue_key = ?
  `).run(
    report.hypothesis,
    report.conclusion,
    report.confidence,
    report.ownerTeam,
    report.regressionDate ?? null,
    report.regressionDateConfidence ?? null,
    report.reportJson != null ? JSON.stringify(report.reportJson) : null,
    issueKey,
  );
}

/**
 * Retrieve a session by issue key. Returns null if not found.
 */
export function getInvestigationSession(
  db: Database.Database,
  issueKey: string
): InvestigationSession | null {
  const row = db.prepare(
    `SELECT * FROM investigation_sessions WHERE issue_key = ?`
  ).get(issueKey) as InvestigationSession | undefined;
  return row ?? null;
}

/**
 * Find the most recent completed investigation that mentions any of the
 * provided keywords in its conclusion, optionally filtered by minimum confidence.
 */
export function findSimilarInvestigation(
  db: Database.Database,
  keywords: string[],
  minConfidence = 0.5
): PastInvestigation | null {
  if (keywords.length === 0) return null;

  // Build a LIKE clause for each keyword (case-insensitive via LOWER)
  const conditions = keywords
    .map(() => `LOWER(conclusion) LIKE ?`)
    .join(' OR ');
  const params = keywords.map(k => `%${k.toLowerCase()}%`);

  const row = db.prepare(`
    SELECT id, issue_key, conclusion, confidence, owner_team, completed_at
    FROM investigation_sessions
    WHERE status = 'done'
      AND confidence >= ?
      AND (${conditions})
    ORDER BY confidence DESC, completed_at DESC
    LIMIT 1
  `).get(minConfidence, ...params) as PastInvestigation | undefined;

  return row ?? null;
}

/**
 * Return formatted markdown of architecture knowledge for a repo,
 * truncated to approximately maxTokens worth of characters (4 chars ≈ 1 token).
 */
export function getArchitectureKnowledge(
  db: Database.Database,
  repo: string,
  maxTokens = 2000
): string {
  const maxChars = maxTokens * 4;
  const rows = db.prepare(`
    SELECT title, content, area FROM codebase_knowledge
    WHERE repo = ? AND type = 'architecture'
    ORDER BY area, title
  `).all(repo) as Array<{ title: string; content: string; area: string }>;

  if (rows.length === 0) return '';

  const sections: string[] = [];
  let totalChars = 0;

  for (const row of rows) {
    const section = `## ${row.area}/${row.title}\n${row.content}`;
    if (totalChars + section.length > maxChars) {
      // Include a truncated version up to the limit
      const remaining = maxChars - totalChars;
      if (remaining > 100) {
        sections.push(section.slice(0, remaining) + '\n...(truncated)');
      }
      break;
    }
    sections.push(section);
    totalChars += section.length;
  }

  return sections.join('\n\n');
}

// ─── Pattern Feedback (Phase 56) ───────────────────────────────────────────

export function recordPatternFeedback(
  db: Database.Database,
  patternId: number,
  sessionId: number,
  opts: { confirmed: boolean; contradicted: boolean }
): void {
  const delta = opts.confirmed ? 0.1 : opts.contradicted ? -0.15 : 0;
  db.prepare(`
    INSERT INTO pattern_feedback (pattern_id, session_id, confirmed, contradicted, confidence_delta)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(pattern_id, session_id) DO UPDATE SET
      confirmed        = excluded.confirmed,
      contradicted     = excluded.contradicted,
      confidence_delta = excluded.confidence_delta
  `).run(patternId, sessionId, opts.confirmed ? 1 : 0, opts.contradicted ? 1 : 0, delta);
}

export function getPatternWithFeedback(
  db: Database.Database,
  patternId: number
): { confirmCount: number; contradictCount: number; netConfidence: number } {
  const row = db.prepare(`
    SELECT
      SUM(confirmed)   AS confirmCount,
      SUM(contradicted) AS contradictCount,
      SUM(confidence_delta) AS netConfidence
    FROM pattern_feedback
    WHERE pattern_id = ?
  `).get(patternId) as { confirmCount: number; contradictCount: number; netConfidence: number } | undefined;
  return row ?? { confirmCount: 0, contradictCount: 0, netConfidence: 0 };
}

// ─── Tool Effectiveness (Phase 56) ─────────────────────────────────────────

export function upsertToolEffectiveness(
  db: Database.Database,
  toolName: string,
  rootCauseType: string,
  ledToConclusion: boolean
): void {
  db.prepare(`
    INSERT INTO tool_effectiveness (tool_name, root_cause_type, invocations, led_to_conclusion, effectiveness_score, last_updated)
    VALUES (?, ?, 1, ?, 0.0, datetime('now'))
    ON CONFLICT(tool_name, root_cause_type) DO UPDATE SET
      invocations       = invocations + 1,
      led_to_conclusion = led_to_conclusion + ?,
      effectiveness_score = CAST(led_to_conclusion + ? AS REAL) / (invocations + 1), -- WR-001: numerator reads post-increment value
      last_updated      = datetime('now')
  `).run(toolName, rootCauseType, ledToConclusion ? 1 : 0, ledToConclusion ? 1 : 0, ledToConclusion ? 1 : 0);
}

export function getTopToolsForRootCauseType(
  db: Database.Database,
  rootCauseType: string,
  limit = 5
): Array<{ toolName: string; effectivenessScore: number; invocations: number }> {
  return db.prepare(`
    SELECT tool_name AS toolName, effectiveness_score AS effectivenessScore, invocations
    FROM tool_effectiveness
    WHERE root_cause_type = ?
    ORDER BY effectiveness_score DESC, invocations DESC
    LIMIT ?
  `).all(rootCauseType, limit) as Array<{ toolName: string; effectivenessScore: number; invocations: number }>;
}

// ─── Hypothesis Accuracy (Phase 56) ────────────────────────────────────────

export function createHypothesisAccuracy(
  db: Database.Database,
  sessionId: number,
  issueKey: string,
  predicted: { rootCause: string; fixOwner?: string }
): void {
  db.prepare(`
    INSERT OR IGNORE INTO hypothesis_accuracy
      (session_id, issue_key, predicted_root_cause, predicted_fix_owner)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, issueKey, predicted.rootCause, predicted.fixOwner ?? null);
}

export function resolveHypothesisAccuracy(
  db: Database.Database,
  issueKey: string,
  actual: { rootCause: string; fixOwner?: string }
): void {
  const row = db.prepare(`
    SELECT ha.id, ha.predicted_root_cause, ha.predicted_fix_owner
    FROM hypothesis_accuracy ha
    JOIN investigation_sessions s ON s.id = ha.session_id
    WHERE ha.issue_key = ?
    ORDER BY ha.id DESC LIMIT 1
  `).get(issueKey) as { id: number; predicted_root_cause: string; predicted_fix_owner?: string } | undefined;

  if (!row) return;

  const wasCorrect =
    row.predicted_root_cause === actual.rootCause &&
    (!actual.fixOwner || row.predicted_fix_owner === actual.fixOwner);

  db.prepare(`
    UPDATE hypothesis_accuracy
    SET actual_root_cause = ?, actual_fix_owner = ?, was_correct = ?, fix_applied_at = datetime('now')
    WHERE id = ?
  `).run(actual.rootCause, actual.fixOwner ?? null, wasCorrect ? 1 : 0, row.id);
}

// ─── Knowledge Decay (Phase 56) ────────────────────────────────────────────

export const KNOWLEDGE_TTL_DAYS = 30;

export function getStaleKnowledgeIds(db: Database.Database, ttlDays = KNOWLEDGE_TTL_DAYS): number[] {
  const rows = db.prepare(`
    SELECT id FROM codebase_knowledge
    WHERE indexed_at < datetime('now', '-' || ? || ' days')
    ORDER BY indexed_at ASC
  `).all(ttlDays) as Array<{ id: number }>;
  return rows.map(r => r.id);
}

export function getBrainStats(db: Database.Database): {
  toolEffectiveness: Array<{ toolName: string; rootCauseType: string; effectivenessScore: number; invocations: number }>;
  accuracyByRootCause: Array<{ rootCauseType: string; total: number; correct: number; accuracy: number }>;
  patternCount: number;
  staleKnowledgeCount: number;
} {
  const toolEffectiveness = db.prepare(`
    SELECT tool_name AS toolName, root_cause_type AS rootCauseType,
           effectiveness_score AS effectivenessScore, invocations
    FROM tool_effectiveness
    ORDER BY effectiveness_score DESC
  `).all() as Array<{ toolName: string; rootCauseType: string; effectivenessScore: number; invocations: number }>;

  const accuracyByRootCause = db.prepare(`
    SELECT predicted_root_cause AS rootCauseType,
           COUNT(*) AS total,
           SUM(CASE WHEN was_correct = 1 THEN 1 ELSE 0 END) AS correct,
           CAST(SUM(CASE WHEN was_correct = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS accuracy
    FROM hypothesis_accuracy
    WHERE was_correct IS NOT NULL
    GROUP BY predicted_root_cause
  `).all() as Array<{ rootCauseType: string; total: number; correct: number; accuracy: number }>;

  const patternCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM codebase_knowledge WHERE type = 'pattern'
  `).get() as { n: number }).n;

  const staleKnowledgeCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM codebase_knowledge
    WHERE indexed_at < datetime('now', '-' || ${KNOWLEDGE_TTL_DAYS} || ' days')
  `).get() as { n: number }).n;

  return { toolEffectiveness, accuracyByRootCause, patternCount, staleKnowledgeCount };
}
