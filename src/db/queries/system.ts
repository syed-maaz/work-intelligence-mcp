import Database from 'better-sqlite3';

// ── Sync state ────────────────────────────────────────────────────────────────

export interface SyncState {
  id: number;
  topic_id: string;
  source: string;
  last_synced_at: string | null;
  last_message_count: number;
}

export function getSyncState(
  db: Database.Database,
  topicId: string,
  source: string
): SyncState | null {
  const row = db
    .prepare('SELECT * FROM sync_state WHERE topic_id = ? AND source = ?')
    .get(topicId, source) as unknown;
  return row ? (row as SyncState) : null;
}

export function updateSyncState(
  db: Database.Database,
  topicId: string,
  source: string,
  lastSyncedAt: string,
  messageCount = 0
): void {
  db.prepare(`
    INSERT INTO sync_state (topic_id, source, last_synced_at, last_message_count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(topic_id, source) DO UPDATE SET
      last_synced_at = excluded.last_synced_at,
      last_message_count = excluded.last_message_count
  `).run(topicId, source, lastSyncedAt, messageCount);
}

// ── Error log queries (EP-18) ─────────────────────────────────────────────────

export interface ErrorLog {
  id: number;
  occurred_at: string;
  source: string;
  message: string;
  stack: string | null;
  request_path: string | null;
  severity: string;
  category: string | null;
  suggested_fix: string | null;
  resolved: number; // 0 | 1
  jira_ticket_key: string | null;
}

export type InsertErrorLog = Omit<ErrorLog, 'id' | 'occurred_at' | 'resolved' | 'jira_ticket_key'>;

export function insertErrorLog(db: Database.Database, data: InsertErrorLog): number {
  const result = db.prepare(`
    INSERT INTO error_logs (source, message, stack, request_path, severity, category, suggested_fix)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.source,
    data.message,
    data.stack ?? null,
    data.request_path ?? null,
    data.severity,
    data.category ?? null,
    data.suggested_fix ?? null,
  );
  return result.lastInsertRowid as number;
}

export function listErrorLogs(
  db: Database.Database,
  opts: { limit?: number; resolved?: boolean } = {}
): ErrorLog[] {
  const where = opts.resolved !== undefined ? `WHERE resolved = ${opts.resolved ? 1 : 0}` : '';
  const limit = opts.limit ?? 50;
  return db.prepare(
    `SELECT * FROM error_logs ${where} ORDER BY occurred_at DESC LIMIT ?`
  ).all(limit) as ErrorLog[];
}

export function markErrorResolved(db: Database.Database, id: number): void {
  db.prepare('UPDATE error_logs SET resolved = 1 WHERE id = ?').run(id);
}

export function updateErrorAnalysis(
  db: Database.Database,
  id: number,
  analysis: { category: string; severity: string; suggested_fix: string }
): void {
  db.prepare(
    'UPDATE error_logs SET category = ?, severity = ?, suggested_fix = ? WHERE id = ?'
  ).run(analysis.category, analysis.severity, analysis.suggested_fix, id);
}

// ── Token Usage (EP-32) ───────────────────────────────────────────────────────

export interface TokenUsageRow {
  id: number;
  method: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  recorded_at: string;
}

export interface TokenStatsSummary {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
  by_method: Array<{
    method: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }>;
  by_day: Array<{
    day: string;
    calls: number;
    cost_usd: number;
  }>;
}

export function recordTokenUsage(
  db: Database.Database,
  method: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  costUsd: number,
): void {
  db.prepare(`
    INSERT INTO token_usage (method, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(method, model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd);
  // Auto-purge rows older than 30 days to keep the table lean
  db.prepare(`DELETE FROM token_usage WHERE recorded_at < datetime('now', '-30 days')`).run();
}

export function getTokenStats(db: Database.Database, days = 30): TokenStatsSummary {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_calls,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation_tokens,
      COALESCE(SUM(cost_usd), 0) as total_cost_usd
    FROM token_usage WHERE recorded_at >= ?
  `).get(since) as {
    total_calls: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_read_tokens: number;
    total_cache_creation_tokens: number;
    total_cost_usd: number;
  };

  const by_method = db.prepare(`
    SELECT
      method,
      COUNT(*) as calls,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM token_usage WHERE recorded_at >= ?
    GROUP BY method ORDER BY cost_usd DESC
  `).all(since) as Array<{ method: string; calls: number; input_tokens: number; output_tokens: number; cost_usd: number }>;

  const by_day = db.prepare(`
    SELECT
      date(recorded_at) as day,
      COUNT(*) as calls,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM token_usage WHERE recorded_at >= ?
    GROUP BY day ORDER BY day DESC
    LIMIT 30
  `).all(since) as Array<{ day: string; calls: number; cost_usd: number }>;

  return { ...totals, by_method, by_day };
}

// ── EP-33: Data quality & ingestion log ──────────────────────────────────────

export interface DataQualityIssue {
  id: number;
  message_id: number | null;
  meeting_id: number | null;
  rule: string;
  severity: 'warning' | 'error';
  detail: string | null;
  resolved_at: string | null;
  detected_at: string;
}

export function insertDataQualityIssue(
  db: Database.Database,
  issue: { message_id?: number; meeting_id?: number; rule: string; severity: string; detail: string }
): void {
  db.prepare(`
    INSERT OR IGNORE INTO data_quality (message_id, meeting_id, rule, severity, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(issue.message_id ?? null, issue.meeting_id ?? null, issue.rule, issue.severity, issue.detail);
}

export function listDataQualityIssues(
  db: Database.Database,
  opts: { status?: 'open' | 'resolved'; limit?: number } = {}
): DataQualityIssue[] {
  const { status = 'open', limit = 50 } = opts;
  const whereClause = status === 'open' ? 'WHERE resolved_at IS NULL' : 'WHERE resolved_at IS NOT NULL';
  return db.prepare(`
    SELECT * FROM data_quality ${whereClause} ORDER BY detected_at DESC LIMIT ?
  `).all(limit) as DataQualityIssue[];
}

export function resolveDataQualityIssue(db: Database.Database, id: number): void {
  db.prepare(`UPDATE data_quality SET resolved_at = datetime('now') WHERE id = ?`).run(id);
}

export function startIngestionLog(
  db: Database.Database,
  entry: { source: string; topic_name?: string }
): number {
  const result = db.prepare(`
    INSERT INTO ingestion_log (source, topic_name) VALUES (?, ?)
  `).run(entry.source, entry.topic_name ?? null);
  return result.lastInsertRowid as number;
}

export function finishIngestionLog(
  db: Database.Database,
  id: number,
  result: { records_fetched: number; records_inserted: number; error_message?: string }
): void {
  db.prepare(`
    UPDATE ingestion_log
    SET finished_at = datetime('now'),
        records_fetched = ?,
        records_inserted = ?,
        error_message = ?
    WHERE id = ?
  `).run(result.records_fetched, result.records_inserted, result.error_message ?? null, id);
}
