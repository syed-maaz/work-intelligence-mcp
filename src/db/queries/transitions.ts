import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Jira transition history (EP-42-2) — schema v23
// ---------------------------------------------------------------------------

export interface JiraTransition {
  id: number;
  issue_key: string;
  project_key: string;
  from_status: string | null;
  to_status: string;
  transitioned_at: string;
  detected_at: string;
}

/** Return the most recent transition for an issue, or null if none recorded yet. */
export function getLastTransition(db: Database.Database, issueKey: string): JiraTransition | null {
  return db.prepare(`
    SELECT * FROM jira_transitions
    WHERE issue_key = ?
    ORDER BY transitioned_at DESC
    LIMIT 1
  `).get(issueKey) as JiraTransition | null;
}

/**
 * Record a status transition. No-ops silently if the UNIQUE constraint fires
 * (i.e. exact duplicate detected within the same second).
 */
export function recordTransition(
  db: Database.Database,
  issueKey: string,
  projectKey: string,
  fromStatus: string | null,
  toStatus: string
): void {
  db.prepare(`
    INSERT OR IGNORE INTO jira_transitions (issue_key, project_key, from_status, to_status)
    VALUES (?, ?, ?, ?)
  `).run(issueKey, projectKey, fromStatus, toStatus);
}

/**
 * Cycle time in hours: first time issue entered 'In Progress' → first time it entered 'Done'.
 * Returns null if the issue hasn't reached Done yet.
 */
export function getCycleTime(db: Database.Database, issueKey: string): number | null {
  const startRow = db.prepare(`
    SELECT transitioned_at FROM jira_transitions
    WHERE issue_key = ? AND to_status = 'In Progress'
    ORDER BY transitioned_at ASC LIMIT 1
  `).get(issueKey) as { transitioned_at: string } | undefined;

  const doneRow = db.prepare(`
    SELECT transitioned_at FROM jira_transitions
    WHERE issue_key = ? AND to_status = 'Done'
    ORDER BY transitioned_at ASC LIMIT 1
  `).get(issueKey) as { transitioned_at: string } | undefined;

  if (!startRow || !doneRow) return null;

  const startMs = new Date(startRow.transitioned_at).getTime();
  const doneMs = new Date(doneRow.transitioned_at).getTime();
  return (doneMs - startMs) / 3_600_000;
}

export interface VelocityStats {
  project_key: string;
  week_of: string;
  completed_count: number;
  avg_cycle_time_hours: number;
  stuck_count: number;
  completed_delta: number | null;
  cycle_time_delta: number | null;
}

/**
 * Weekly velocity: completed tickets + avg cycle time per week, last N weeks.
 * Includes week-over-week deltas for trend arrows in VelocityStrip.
 */
export function getWeeklyVelocity(
  db: Database.Database,
  projectKey: string,
  weeks = 8
): VelocityStats[] {
  const rows = db.prepare(`
    WITH done_transitions AS (
      SELECT
        issue_key,
        transitioned_at,
        strftime('%Y-W%W', transitioned_at) AS week_of
      FROM jira_transitions
      WHERE project_key = ?
        AND to_status = 'Done'
        AND transitioned_at >= datetime('now', ? || ' weeks')
    ),
    weekly_counts AS (
      SELECT
        week_of,
        COUNT(*) AS completed_count
      FROM done_transitions
      GROUP BY week_of
    ),
    cycle_times AS (
      SELECT
        dt.week_of,
        AVG(
          (julianday(dt.transitioned_at) - julianday(ip.transitioned_at)) * 24
        ) AS avg_cycle_time_hours
      FROM done_transitions dt
      LEFT JOIN jira_transitions ip
        ON ip.issue_key = dt.issue_key AND ip.to_status = 'In Progress'
      GROUP BY dt.week_of
    )
    SELECT
      wc.week_of,
      wc.completed_count,
      COALESCE(ct.avg_cycle_time_hours, 0) AS avg_cycle_time_hours
    FROM weekly_counts wc
    LEFT JOIN cycle_times ct USING (week_of)
    ORDER BY wc.week_of ASC
  `).all(projectKey, `-${weeks}`) as Array<{
    week_of: string;
    completed_count: number;
    avg_cycle_time_hours: number;
  }>;

  // Count stuck issues (same status for > 3 days) for the current week
  const stuckRows = db.prepare(`
    SELECT COUNT(DISTINCT issue_key) AS stuck_count
    FROM jira_transitions jt1
    WHERE project_key = ?
      AND NOT EXISTS (
        SELECT 1 FROM jira_transitions jt2
        WHERE jt2.issue_key = jt1.issue_key
          AND jt2.transitioned_at > jt1.transitioned_at
      )
      AND jt1.transitioned_at < datetime('now', '-3 days')
  `).get(projectKey) as { stuck_count: number };

  const stuckCount = stuckRows.stuck_count;

  // Attach deltas (week-over-week)
  return rows.map((row, i): VelocityStats => {
    const prev = rows[i - 1];
    return {
      project_key: projectKey,
      week_of: row.week_of,
      completed_count: row.completed_count,
      avg_cycle_time_hours: row.avg_cycle_time_hours,
      stuck_count: i === rows.length - 1 ? stuckCount : 0,
      completed_delta: prev != null ? row.completed_count - prev.completed_count : null,
      cycle_time_delta: prev != null ? row.avg_cycle_time_hours - prev.avg_cycle_time_hours : null,
    };
  });
}

export interface CycleTimeBaseline {
  p25: number;
  p50: number;
  p75: number;
  n: number;
  sampleKeys: string[];
  warning?: string;
}

/**
 * Find completed tickets similar to the given keywords (FTS5 on jira_issues.title),
 * return their cycle times as a P25/P50/P75 distribution for effort baseline.
 */
export function getCycleTimesForSimilarTickets(
  db: Database.Database,
  keywords: string[],
  limit = 20
): CycleTimeBaseline | null {
  let issueKeys: string[] = [];

  if (keywords.length > 0) {
    try {
      const conditions = keywords.map(() => 'ji.title LIKE ?').join(' OR ');
      const patterns = keywords.map(k => `%${k}%`);
      const ftsRows = db.prepare(`
        SELECT ji.key
        FROM jira_issues ji
        WHERE ${conditions}
        LIMIT ?
      `).all(...patterns, limit) as Array<{ key: string }>;
      issueKeys = ftsRows.map(r => r.key);
    } catch {
      // FTS unavailable — proceed with empty list
    }
  }

  // Get cycle times for matched keys (or all Done tickets if no keywords matched)
  const cycleRows = (issueKeys.length > 0
    ? db.prepare(`
        SELECT jt.issue_key,
          (julianday(done.transitioned_at) - julianday(ip.transitioned_at)) * 24 AS hours
        FROM jira_transitions done
        JOIN jira_transitions ip ON ip.issue_key = done.issue_key AND ip.to_status = 'In Progress'
        WHERE done.to_status = 'Done'
          AND done.issue_key IN (${issueKeys.map(() => '?').join(',')})
        ORDER BY done.transitioned_at DESC
        LIMIT ?
      `).all(...issueKeys, limit)
    : db.prepare(`
        SELECT jt.issue_key,
          (julianday(done.transitioned_at) - julianday(ip.transitioned_at)) * 24 AS hours
        FROM jira_transitions done
        JOIN jira_transitions ip ON ip.issue_key = done.issue_key AND ip.to_status = 'In Progress'
        WHERE done.to_status = 'Done'
        ORDER BY done.transitioned_at DESC
        LIMIT ?
      `).all(limit)
  ) as Array<{ issue_key: string; hours: number }>;

  const validRows = cycleRows.filter(r => r.hours > 0);
  if (validRows.length === 0) return null;

  const sorted = validRows.map(r => r.hours).sort((a, b) => a - b);
  const p = (pct: number) => sorted[Math.floor(sorted.length * pct)] ?? sorted[sorted.length - 1];

  return {
    p25: p(0.25),
    p50: p(0.5),
    p75: p(0.75),
    n: sorted.length,
    sampleKeys: validRows.map(r => r.issue_key),
    warning: sorted.length < 5 ? `Low confidence: n=${sorted.length}` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Ticket learnings / implementation memory (EP-42-7) — schema v23
// ---------------------------------------------------------------------------

export interface TicketLearning {
  id: number;
  issue_key: string;
  project_key: string;
  summary: string;
  solution: string;
  files_changed: string | null;
  traps: string | null;
  cycle_time_hours: number | null;
  auto_captured: number;
  learned_at: string;
  embedding: Buffer | null;
}

export function saveLearning(
  db: Database.Database,
  learning: Omit<TicketLearning, 'id' | 'learned_at'>
): void {
  db.prepare(`
    INSERT INTO ticket_learnings
      (issue_key, project_key, summary, solution, files_changed, traps, cycle_time_hours, auto_captured, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(issue_key) DO UPDATE SET
      solution = excluded.solution,
      files_changed = COALESCE(excluded.files_changed, files_changed),
      traps = COALESCE(excluded.traps, traps),
      cycle_time_hours = COALESCE(excluded.cycle_time_hours, cycle_time_hours),
      auto_captured = excluded.auto_captured,
      embedding = COALESCE(excluded.embedding, embedding),
      learned_at = datetime('now')
  `).run(
    learning.issue_key, learning.project_key, learning.summary, learning.solution,
    learning.files_changed, learning.traps, learning.cycle_time_hours,
    learning.auto_captured ? 1 : 0, learning.embedding ?? null
  );
}

export function getLearning(db: Database.Database, issueKey: string): TicketLearning | null {
  return db.prepare(
    `SELECT * FROM ticket_learnings WHERE issue_key = ?`
  ).get(issueKey) as TicketLearning | null;
}

export function findSimilarLearnings(
  db: Database.Database,
  keywords: string[],
  limit = 3
): TicketLearning[] {
  if (keywords.length === 0) return [];
  const conditions = keywords.map(() => 'summary LIKE ?').join(' OR ');
  const patterns = keywords.map(k => `%${k}%`);
  return db.prepare(`
    SELECT * FROM ticket_learnings
    WHERE ${conditions}
    ORDER BY learned_at DESC
    LIMIT ?
  `).all(...patterns, limit) as TicketLearning[];
}
