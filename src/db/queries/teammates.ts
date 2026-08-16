import type Database from 'better-sqlite3';

export interface TeamMember {
  id: number;
  name: string;
  email: string | null;
  github_handle: string | null;
  jira_username: string | null;
  teams_display_name: string | null;
  marked: number;
  added_at: string;
  deleted_at: string | null;
  notes: string | null;
}

export interface MemberAlias {
  id: number;
  member_id: number;
  alias: string;
  source: string;
}

export interface MemberProfile {
  id: number;
  member_id: number;
  profile_content: string;
  summary: string | null;
  activity_level: 'high' | 'medium' | 'low' | 'new' | 'unknown' | null;
  activity_score: number | null;
  workload_signal: 'available' | 'busy' | 'overloaded' | 'unknown' | null;
  domains: string; // JSON string[]
  jira_open_count: number;
  jira_overdue_count: number;
  top_topics: string; // JSON [{name, count, relevanceWeight}]
  code_files_owned: string; // JSON string[]
  last_updated: string;
}

export interface MemberWithStats extends TeamMember {
  message_count: number;
  last_active: string | null;
}

export interface MemberActivity {
  messageCount: number;
  topTopics: Array<{ name: string; count: number; relevanceWeight: number }>;
  lastActiveDate: string | null;
  recentMessages: string[];
  effectiveDays: number;
}

export interface TeamAverages {
  avgMessages: number;
  avgCommits: number;
  avgJiraActivity: number;
}

export interface ExpertCandidate {
  member: TeamMember;
  commitCount: number;
  workloadSignal: string;
}

// ── Member management ─────────────────────────────────────────────────────────

export function addTeamMember(
  db: Database.Database,
  member: Omit<TeamMember, 'id' | 'added_at' | 'deleted_at'>,
): number {
  const result = db
    .prepare<
      [string, string | null, string | null, string | null, string | null, number, string | null]
    >(
      `INSERT INTO team_members (name, email, github_handle, jira_username, teams_display_name, marked, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      member.name,
      member.email,
      member.github_handle,
      member.jira_username,
      member.teams_display_name,
      member.marked,
      member.notes,
    );
  return result.lastInsertRowid as number;
}

export function markMember(db: Database.Database, id: number, marked: boolean): void {
  db.prepare('UPDATE team_members SET marked = ? WHERE id = ? AND deleted_at IS NULL').run(
    marked ? 1 : 0,
    id,
  );
}

export function softDeleteMember(db: Database.Database, id: number): void {
  db.prepare("UPDATE team_members SET deleted_at = datetime('now') WHERE id = ?").run(id);
}

export function getTeamMember(db: Database.Database, id: number): TeamMember | null {
  return (
    (db
      .prepare<[number], TeamMember>(
        'SELECT * FROM team_members WHERE id = ? AND deleted_at IS NULL',
      )
      .get(id) as TeamMember | undefined) ?? null
  );
}

export function getMarkedMembers(db: Database.Database): TeamMember[] {
  return db
    .prepare<[], TeamMember>(
      'SELECT * FROM team_members WHERE marked = 1 AND deleted_at IS NULL ORDER BY name',
    )
    .all() as TeamMember[];
}

export function getAllMembers(db: Database.Database): MemberWithStats[] {
  return db
    .prepare<[], MemberWithStats>(
      `SELECT tm.*,
              COUNT(DISTINCT m.id)     AS message_count,
              MAX(m.timestamp)         AS last_active
       FROM team_members tm
       LEFT JOIN messages m ON (
         m.author = tm.teams_display_name
         OR m.author IN (SELECT alias FROM member_aliases WHERE member_id = tm.id)
       )
       WHERE tm.deleted_at IS NULL
       GROUP BY tm.id
       ORDER BY tm.marked DESC, tm.name`,
    )
    .all() as MemberWithStats[];
}

// ── Alias management ──────────────────────────────────────────────────────────

export function addMemberAlias(
  db: Database.Database,
  memberId: number,
  alias: string,
  source: string,
): void {
  db.prepare('INSERT OR IGNORE INTO member_aliases (member_id, alias, source) VALUES (?, ?, ?)').run(
    memberId,
    alias,
    source,
  );
}

export function resolveMemberByAlias(
  db: Database.Database,
  rawName: string,
): TeamMember | null {
  const byAlias = db
    .prepare<[string], TeamMember>(
      `SELECT tm.* FROM team_members tm
       JOIN member_aliases ma ON ma.member_id = tm.id
       WHERE ma.alias = ? AND tm.deleted_at IS NULL`,
    )
    .get(rawName) as TeamMember | undefined;
  if (byAlias) return byAlias;
  return (
    (db
      .prepare<[string], TeamMember>(
        'SELECT * FROM team_members WHERE teams_display_name = ? AND deleted_at IS NULL',
      )
      .get(rawName) as TeamMember | undefined) ?? null
  );
}

export function getMemberAliases(db: Database.Database, memberId: number): MemberAlias[] {
  return db
    .prepare<[number], MemberAlias>('SELECT * FROM member_aliases WHERE member_id = ?')
    .all(memberId) as MemberAlias[];
}

// ── Profile queries ───────────────────────────────────────────────────────────

export function getMemberProfile(
  db: Database.Database,
  memberId: number,
): MemberProfile | null {
  return (
    (db
      .prepare<[number], MemberProfile>('SELECT * FROM member_profiles WHERE member_id = ?')
      .get(memberId) as MemberProfile | undefined) ?? null
  );
}

export function saveMemberProfile(
  db: Database.Database,
  memberId: number,
  profile: Omit<MemberProfile, 'id' | 'member_id'>,
): void {
  db.prepare(
    `INSERT INTO member_profiles
       (member_id, profile_content, summary, activity_level, activity_score,
        workload_signal, domains, jira_open_count, jira_overdue_count,
        top_topics, code_files_owned, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(member_id) DO UPDATE SET
       profile_content   = excluded.profile_content,
       summary           = excluded.summary,
       activity_level    = excluded.activity_level,
       activity_score    = excluded.activity_score,
       workload_signal   = excluded.workload_signal,
       domains           = excluded.domains,
       jira_open_count   = excluded.jira_open_count,
       jira_overdue_count= excluded.jira_overdue_count,
       top_topics        = excluded.top_topics,
       code_files_owned  = excluded.code_files_owned,
       last_updated      = datetime('now')`,
  ).run(
    memberId,
    profile.profile_content,
    profile.summary,
    profile.activity_level,
    profile.activity_score,
    profile.workload_signal,
    profile.domains,
    profile.jira_open_count,
    profile.jira_overdue_count,
    profile.top_topics,
    profile.code_files_owned,
  );
}

export function countNewMessages(
  db: Database.Database,
  memberId: number,
  since: string,
): number {
  const row = db
    .prepare<[number, number, string], { cnt: number }>(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE author IN (
         SELECT alias FROM member_aliases WHERE member_id = ?
         UNION
         SELECT teams_display_name FROM team_members WHERE id = ?
       )
       AND timestamp > ?`,
    )
    .get(memberId, memberId, since) as { cnt: number };
  return row?.cnt ?? 0;
}

export function countNewCommits(
  db: Database.Database,
  memberId: number,
  since: string,
): number {
  // Uses code_graph if EP-43 data exists; otherwise 0
  const member = getTeamMember(db, memberId);
  if (!member?.github_handle) return 0;
  try {
    const row = db
      .prepare<[string, string], { cnt: number }>(
        `SELECT COUNT(*) as cnt FROM code_graph
         WHERE symbol = ? AND ref_type = 'commit' AND indexed_at > ?`,
      )
      .get(member.github_handle, since) as { cnt: number };
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

// ── Activity aggregation ──────────────────────────────────────────────────────

export function getMemberActivity(
  db: Database.Database,
  memberId: number,
  days = 30,
): MemberActivity {
  // Effective window respects member tenure
  const firstRow = db
    .prepare<[number, number], { first_msg: string | null }>(
      `SELECT MIN(timestamp) as first_msg FROM messages
       WHERE author IN (
         SELECT alias FROM member_aliases WHERE member_id = ?
         UNION
         SELECT teams_display_name FROM team_members WHERE id = ?
       )`,
    )
    .get(memberId, memberId) as { first_msg: string | null };

  let effectiveDays = days;
  if (firstRow?.first_msg) {
    const msPerDay = 1000 * 60 * 60 * 24;
    const daysSinceFirst = Math.floor(
      (Date.now() - new Date(firstRow.first_msg).getTime()) / msPerDay,
    );
    effectiveDays = Math.min(days, daysSinceFirst);
  }

  const since = new Date(Date.now() - effectiveDays * 24 * 60 * 60 * 1000).toISOString();

  const countRow = db
    .prepare<[number, number, string], { cnt: number; last_active: string | null }>(
      `SELECT COUNT(*) as cnt, MAX(timestamp) as last_active FROM messages
       WHERE author IN (
         SELECT alias FROM member_aliases WHERE member_id = ?
         UNION
         SELECT teams_display_name FROM team_members WHERE id = ?
       )
       AND timestamp > ?`,
    )
    .get(memberId, memberId, since) as { cnt: number; last_active: string | null };

  // top_topics weighted by BM25 relevance density
  let topTopics: Array<{ name: string; count: number; relevanceWeight: number }> = [];
  try {
    const topicRows = db
      .prepare<[number, number, string], { name: string; count: number; avg_relevance: number }>(
        `SELECT t.name,
                COUNT(*) as count,
                AVG(ABS(bm25(messages_fts))) as avg_relevance
         FROM messages m
         JOIN topics t ON m.topic_id = t.id
         JOIN messages_fts mf ON mf.rowid = m.id
         WHERE m.author IN (
           SELECT alias FROM member_aliases WHERE member_id = ?
           UNION
           SELECT teams_display_name FROM team_members WHERE id = ?
         )
         AND m.timestamp > ?
         GROUP BY t.name
         ORDER BY count * avg_relevance DESC
         LIMIT 5`,
      )
      .all(memberId, memberId, since) as Array<{
      name: string;
      count: number;
      avg_relevance: number;
    }>;
    topTopics = topicRows.map((r) => ({
      name: r.name,
      count: r.count,
      relevanceWeight: r.avg_relevance ?? 1,
    }));
  } catch {
    // FTS not available — fall back to raw count
    const fallbackRows = db
      .prepare<[number, number, string], { name: string; count: number }>(
        `SELECT t.name, COUNT(*) as count
         FROM messages m
         JOIN topics t ON m.topic_id = t.id
         WHERE m.author IN (
           SELECT alias FROM member_aliases WHERE member_id = ?
           UNION
           SELECT teams_display_name FROM team_members WHERE id = ?
         )
         AND m.timestamp > ?
         GROUP BY t.name ORDER BY count DESC LIMIT 5`,
      )
      .all(memberId, memberId, since) as Array<{ name: string; count: number }>;
    topTopics = fallbackRows.map((r) => ({ ...r, relevanceWeight: 1 }));
  }

  const recentRows = db
    .prepare<[number, number, string], { content: string }>(
      `SELECT content FROM messages
       WHERE author IN (
         SELECT alias FROM member_aliases WHERE member_id = ?
         UNION
         SELECT teams_display_name FROM team_members WHERE id = ?
       )
       AND timestamp > ?
       ORDER BY timestamp DESC LIMIT 10`,
    )
    .all(memberId, memberId, since) as Array<{ content: string }>;

  return {
    messageCount: countRow?.cnt ?? 0,
    topTopics,
    lastActiveDate: countRow?.last_active ?? null,
    recentMessages: recentRows.map((r) => r.content),
    effectiveDays,
  };
}

export function getTeamAverages(db: Database.Database): TeamAverages {
  const days = 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const msgRow = db
    .prepare<[string], { avg: number }>(
      `SELECT AVG(cnt) as avg FROM (
         SELECT tm.id, COUNT(m.id) as cnt
         FROM team_members tm
         LEFT JOIN messages m ON (
           m.author = tm.teams_display_name
           OR m.author IN (SELECT alias FROM member_aliases WHERE member_id = tm.id)
         ) AND m.timestamp > ?
         WHERE tm.marked = 1 AND tm.deleted_at IS NULL
         GROUP BY tm.id
       )`,
    )
    .get(since) as { avg: number };

  const jiraRow = db
    .prepare<[string], { avg: number }>(
      `SELECT AVG(cnt) as avg FROM (
         SELECT COUNT(*) as cnt FROM jira_issues ji
         JOIN team_members tm ON ji.assignee = tm.jira_username
         WHERE tm.marked = 1 AND tm.deleted_at IS NULL
         AND ji.updated_at > ?
         GROUP BY tm.id
       )`,
    )
    .get(since) as { avg: number };

  return {
    avgMessages: Math.max(1, msgRow?.avg ?? 1),
    avgCommits: 1, // placeholder — populated by EP-43 code_graph when available
    avgJiraActivity: Math.max(1, jiraRow?.avg ?? 1),
  };
}

// ── Expert finder ─────────────────────────────────────────────────────────────

export function getExpertCandidates(
  db: Database.Database,
  _repo: string,
  filePath: string,
): ExpertCandidate[] {
  // Join code_graph commit owners with team_members + workload from member_profiles
  try {
    const rows = db
      .prepare<[string], { github_handle: string; commit_count: number; workload_signal: string | null }>(
        `SELECT tm.github_handle,
                COUNT(*) as commit_count,
                mp.workload_signal
         FROM code_graph cg
         JOIN team_members tm ON cg.symbol = tm.github_handle
         LEFT JOIN member_profiles mp ON mp.member_id = tm.id
         WHERE cg.ref_file = ? AND cg.ref_type = 'commit'
           AND tm.deleted_at IS NULL
         GROUP BY tm.github_handle
         ORDER BY commit_count DESC
         LIMIT 3`,
      )
      .all(filePath) as Array<{
      github_handle: string;
      commit_count: number;
      workload_signal: string | null;
    }>;

    return rows.map((r) => {
      const member = db
        .prepare<[string], TeamMember>(
          'SELECT * FROM team_members WHERE github_handle = ? AND deleted_at IS NULL',
        )
        .get(r.github_handle) as TeamMember | undefined;
      return {
        member: member!,
        commitCount: r.commit_count,
        workloadSignal: r.workload_signal ?? 'unknown',
      };
    }).filter((c) => c.member != null);
  } catch {
    return [];
  }
}
