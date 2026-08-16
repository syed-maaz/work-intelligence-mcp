import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Jira issue cache (EP-20/21) — schema v8
// ---------------------------------------------------------------------------

export interface JiraIssueRow {
  list_name: string;
  key: string;
  title: string;
  status: string;
  assignee: string | null;
  priority: string | null;
  epic_key: string | null;
  epic_name: string | null;
  updated_at: string;
  url: string;
  scraped_at: string;
}

export function saveJiraIssues(
  db: Database.Database,
  listName: string,
  issues: Omit<JiraIssueRow, 'list_name' | 'scraped_at'>[]
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO jira_issues
      (list_name, key, title, status, assignee, priority, epic_key, epic_name, updated_at, url, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertAll = db.transaction((rows: typeof issues) => {
    for (const r of rows) {
      stmt.run(listName, r.key, r.title, r.status, r.assignee ?? null, r.priority ?? null, r.epic_key ?? null, r.epic_name ?? null, r.updated_at, r.url);
    }
  });
  insertAll(issues);
}

export interface BoardIssueRow {
  key: string;
  title: string;
  status: string;
  assignee: string | null;
  priority: string | null;
  epic_key: string | null;
  epic_name: string | null;
  updated_at: string;
  url: string;
  sprint_context: string;
  sprint_name: string | null;
  issue_type: string | null;
  labels: string; // JSON array string
  data_source: string;
}

export function saveBoardIssues(
  db: Database.Database,
  listName: string,
  issues: BoardIssueRow[]
): void {
  const stmt = db.prepare(`
    INSERT INTO jira_issues
      (list_name, key, title, status, assignee, priority, epic_key, epic_name,
       updated_at, url, sprint_context, sprint_name, issue_type, labels, data_source, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(list_name, key) DO UPDATE SET
      title        = excluded.title,
      status       = excluded.status,
      assignee     = excluded.assignee,
      priority     = excluded.priority,
      epic_key     = excluded.epic_key,
      epic_name    = excluded.epic_name,
      updated_at   = excluded.updated_at,
      sprint_context = excluded.sprint_context,
      sprint_name  = excluded.sprint_name,
      issue_type   = excluded.issue_type,
      labels       = excluded.labels,
      data_source  = excluded.data_source,
      scraped_at   = datetime('now')
  `);
  const upsertAll = db.transaction((rows: BoardIssueRow[]) => {
    for (const r of rows) {
      stmt.run(
        listName, r.key, r.title, r.status,
        r.assignee ?? null, r.priority ?? null, r.epic_key ?? null, r.epic_name ?? null,
        r.updated_at, r.url, r.sprint_context, r.sprint_name ?? null,
        r.issue_type ?? null, r.labels, r.data_source
      );
    }
  });
  upsertAll(issues);
}

export function loadBoardIssues(db: Database.Database, listName: string): BoardIssueRow[] {
  return db.prepare(
    `SELECT key, title, status, assignee, priority, epic_key, epic_name,
            updated_at, url, sprint_context, sprint_name, issue_type, labels, data_source
     FROM jira_issues WHERE list_name = ? ORDER BY scraped_at DESC, key ASC`
  ).all(listName) as BoardIssueRow[];
}

export function loadJiraIssues(db: Database.Database, listName: string): JiraIssueRow[] {
  return db.prepare(
    `SELECT * FROM jira_issues WHERE list_name = ? ORDER BY scraped_at DESC, key ASC`
  ).all(listName) as JiraIssueRow[];
}

export function getJiraIssuesCachedAt(db: Database.Database, listName: string): string | null {
  const row = db.prepare(
    `SELECT MAX(scraped_at) as latest FROM jira_issues WHERE list_name = ?`
  ).get(listName) as { latest: string | null };
  return row?.latest ?? null;
}

// ── Jira Analysis Cache ───────────────────────────────────────────────────────

export interface JiraAnalysisRow {
  id: number;
  issue_key: string;
  analysis: string | null;
  effort: string | null;
  explanation: string | null;
  solution: string | null;
  code_impact: string | null;
  linked_content: string | null;
  notes: string | null;
  status: 'pending' | 'done';
  analyzed_at: string;
}

export function saveJiraAnalysis(
  db: Database.Database,
  issueKey: string,
  fields: { analysis?: string | null; effort?: string | null; explanation?: string | null; solution?: string | null; code_impact?: string | null; linked_content?: string | null; status?: string }
): void {
  const existing = db.prepare('SELECT id FROM jira_analysis WHERE issue_key = ?').get(issueKey);
  if (existing) {
    const setClauses: string[] = ['analyzed_at = datetime(\'now\')'];
    const values: unknown[] = [];
    if (fields.analysis !== undefined) { setClauses.push('analysis = ?'); values.push(fields.analysis); }
    if (fields.effort !== undefined) { setClauses.push('effort = ?'); values.push(fields.effort); }
    if (fields.explanation !== undefined) { setClauses.push('explanation = ?'); values.push(fields.explanation); }
    if (fields.solution !== undefined) { setClauses.push('solution = ?'); values.push(fields.solution); }
    if (fields.code_impact !== undefined) { setClauses.push('code_impact = ?'); values.push(fields.code_impact); }
    if (fields.linked_content !== undefined) { setClauses.push('linked_content = ?'); values.push(fields.linked_content); }
    if (fields.status !== undefined) { setClauses.push('status = ?'); values.push(fields.status); }
    values.push(issueKey);
    db.prepare(`UPDATE jira_analysis SET ${setClauses.join(', ')} WHERE issue_key = ?`).run(...values);
  } else {
    db.prepare(
      `INSERT INTO jira_analysis (issue_key, analysis, effort, explanation, solution, code_impact, linked_content, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(issueKey, fields.analysis ?? null, fields.effort ?? null, fields.explanation ?? null, fields.solution ?? null, fields.code_impact ?? null, fields.linked_content ?? null, fields.status ?? 'pending');
  }
}

export function loadJiraAnalysis(db: Database.Database, issueKey: string): JiraAnalysisRow | null {
  return (db.prepare('SELECT * FROM jira_analysis WHERE issue_key = ?').get(issueKey) as JiraAnalysisRow | undefined) ?? null;
}

export function listJiraAnalyses(db: Database.Database): JiraAnalysisRow[] {
  return db.prepare('SELECT * FROM jira_analysis ORDER BY analyzed_at DESC').all() as JiraAnalysisRow[];
}

export function saveJiraNotes(db: Database.Database, issueKey: string, notes: string): void {
  const existing = db.prepare('SELECT id FROM jira_analysis WHERE issue_key = ?').get(issueKey);
  if (existing) {
    db.prepare('UPDATE jira_analysis SET notes = ? WHERE issue_key = ?').run(notes, issueKey);
  } else {
    db.prepare('INSERT INTO jira_analysis (issue_key, notes, status) VALUES (?, ?, ?)').run(issueKey, notes, 'pending');
  }
}

// ── Teams favourite keywords ──────────────────────────────────────────────────

export interface TeamsFavKeyword {
  id: number;
  keyword: string;
  added_at: string;
}

export function listFavKeywords(db: Database.Database): TeamsFavKeyword[] {
  return db.prepare('SELECT * FROM teams_fav_keywords ORDER BY added_at DESC').all() as TeamsFavKeyword[];
}

export function saveFavKeyword(db: Database.Database, keyword: string): TeamsFavKeyword {
  db.prepare('INSERT OR IGNORE INTO teams_fav_keywords (keyword) VALUES (?)').run(keyword.trim());
  return db.prepare('SELECT * FROM teams_fav_keywords WHERE keyword = ?').get(keyword.trim()) as TeamsFavKeyword;
}

export function deleteFavKeyword(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM teams_fav_keywords WHERE id = ?').run(id);
}
