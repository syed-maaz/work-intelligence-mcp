// Staleness detectors for the Unified Brain context endpoint (ADR-024, Phase 69-04).
//
// Two pure functions over the existing SQLite handle the rest of the codebase
// passes around. Each returns human-readable warning strings consumed by the
// 69-02 context-builder, which merges them into the `stale_warnings` field of
// the GET /api/brain/context response.
//
// Reuses existing canonical sources — does NOT introduce new schema or call
// external APIs:
//   - Sprint: `sprint_config` table (active row), as queried in
//     web-server.js:1803 and web-server.js:5436.
//   - Stuck Jiras: the `jira_transitions` + `jira_issues` join used by
//     GET /api/jira/stuck (web-server.js:1989-2008). We reuse the same SQL
//     pattern with a 14-day threshold and surface days_stuck per row.

import type Database from 'better-sqlite3';

const SPRINT_STALE_DAYS = 14;
const STUCK_JIRA_DAYS = 14;
const MS_PER_DAY = 86_400_000;

interface SprintConfigRow {
  sprint_name: string | null;
  project_key: string | null;
  start_date: string | null;
  end_date: string | null;
  active: number;
}

interface StuckJiraRow {
  issue_key: string;
  current_status: string;
  transitioned_at: string;
}

/**
 * Returns warnings when the active sprint started more than 14 days ago.
 * Reads `sprint_config` (active row) — same source used by /api/config/sprint
 * and the My Work Cockpit board endpoint. No Jira API call.
 */
export function detectSprintStaleness(db: Database.Database): string[] {
  const warnings: string[] = [];

  const row = db
    .prepare('SELECT * FROM sprint_config WHERE active = 1 LIMIT 1')
    .get() as SprintConfigRow | undefined;

  if (!row || !row.start_date || !row.sprint_name) return warnings;

  const startMs = Date.parse(row.start_date);
  if (Number.isNaN(startMs)) return warnings;

  const ageMs = Date.now() - startMs;
  if (ageMs <= SPRINT_STALE_DAYS * MS_PER_DAY) return warnings;

  const days = Math.floor(ageMs / MS_PER_DAY);
  warnings.push(`Sprint ${row.sprint_name} started ${days} days ago`);
  return warnings;
}

/**
 * Returns warnings for Jira issues that have been in the same non-terminal
 * status for more than 14 days. Reuses the canonical stuck-jira SQL from
 * GET /api/jira/stuck (web-server.js:1993-2006) with the threshold raised
 * to STUCK_JIRA_DAYS.
 */
export function detectStuckJiraStaleness(
  db: Database.Database,
  projectKey: string = (process.env.JIRA_PROJECT_KEY ?? 'PROJ')
): string[] {
  const warnings: string[] = [];

  const rows = db
    .prepare(
      `SELECT jt.issue_key, jt.to_status AS current_status, jt.transitioned_at
       FROM jira_transitions jt
       WHERE jt.project_key = ?
         AND jt.to_status NOT IN ('Done', 'Closed', 'Resolved', 'Cancelled')
         AND NOT EXISTS (
           SELECT 1 FROM jira_transitions jt2
           WHERE jt2.issue_key = jt.issue_key AND jt2.transitioned_at > jt.transitioned_at
         )
         AND jt.transitioned_at < datetime('now', '-' || ? || ' days')
       ORDER BY jt.transitioned_at ASC`
    )
    .all(projectKey, STUCK_JIRA_DAYS) as StuckJiraRow[];

  const now = Date.now();
  for (const row of rows) {
    const transitionedMs = Date.parse(row.transitioned_at.replace(' ', 'T') + 'Z');
    if (Number.isNaN(transitionedMs)) continue;

    const days = Math.floor((now - transitionedMs) / MS_PER_DAY);
    if (days <= STUCK_JIRA_DAYS) continue;

    warnings.push(`${row.issue_key} stuck for ${days} days`);
  }

  return warnings;
}
