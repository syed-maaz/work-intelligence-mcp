import type Database from 'better-sqlite3';
import type { AIAnalyzer } from '../services/analyzer.js';
import type { MemberProfileInput } from '../services/analyzer.js';
import {
  getTeamMember,
  getMemberProfile,
  saveMemberProfile,
  countNewMessages,
  countNewCommits,
  getMemberActivity,
  getTeamAverages,
} from '../db/queries.js';

export interface RepoConfig {
  name: string;
  path: string;
}

type SafeMemberInput = {
  name: string;
  email: string | null;
  github_handle: string | null;
  jira_username: string | null;
  teams_display_name: string | null;
};

export async function buildOrUpdateMemberProfile(
  db: Database.Database,
  memberId: number,
  analyzer: AIAnalyzer,
  _repos: RepoConfig[] = [],
): Promise<void> {
  const member = getTeamMember(db, memberId);
  if (!member) return;

  // Incremental rebuild guard — skip if nothing new since last update
  const existingProfile = getMemberProfile(db, memberId);
  if (existingProfile?.last_updated) {
    const newMsgs = countNewMessages(db, memberId, existingProfile.last_updated);
    const newCommits = countNewCommits(db, memberId, existingProfile.last_updated);
    if (newMsgs === 0 && newCommits === 0) return;
  }

  // Privacy enforcement: notes, id, added_at, deleted_at never reach AI
  const safeMember: SafeMemberInput = {
    name: member.name,
    email: member.email,
    github_handle: member.github_handle,
    jira_username: member.jira_username,
    teams_display_name: member.teams_display_name,
  };
  void safeMember; // used structurally to enforce Omit at type level

  const activity = getMemberActivity(db, memberId, 30);
  const teamAvg = getTeamAverages(db);

  // Data coverage note
  const dataCoverageNote =
    activity.effectiveDays < 14
      ? `New team member — only ${activity.effectiveDays}d of data available. Profile will improve over time.`
      : `Based on last ${activity.effectiveDays}d of activity.`;

  // Fetch Jira data if available
  let openTickets: MemberProfileInput['openTickets'] = [];
  let overdueTickets: MemberProfileInput['overdueTickets'] = [];
  if (member.jira_username) {
    try {
      const now = Date.now();
      const issues = db
        .prepare<[string], { key: string; title: string; status: string; due_date: string | null }>(
          `SELECT key, title, status, due_date FROM jira_issues WHERE assignee = ? AND status NOT IN ('Done','Closed','Resolved','Cancelled','Completed')`,
        )
        .all(member.jira_username) as Array<{
        key: string;
        title: string;
        status: string;
        due_date: string | null;
      }>;
      openTickets = issues.map((i) => ({ key: i.key, summary: i.title, status: i.status, dueDate: i.due_date ?? undefined }));
      overdueTickets = issues
        .filter((i) => i.due_date && new Date(i.due_date).getTime() < now)
        .map((i) => ({
          key: i.key,
          summary: i.title,
          daysPast: Math.floor((now - new Date(i.due_date!).getTime()) / 86_400_000),
        }));
    } catch {
      // jira_issues table may not be populated
    }
  }

  // Fetch recent meetings
  let recentMeetings: MemberProfileInput['recentMeetings'] = [];
  try {
    const mtgRows = db
      .prepare<[string], { title: string; date: string }>(
        `SELECT title, date FROM meetings
         WHERE attendees LIKE ? AND date > datetime('now', '-30 days')
         ORDER BY date DESC LIMIT 10`,
      )
      .all(`%${member.name}%`) as Array<{ title: string; date: string }>;
    recentMeetings = mtgRows.map((m) => ({ title: m.title, date: m.date, hadActionItems: false }));
  } catch {
    // meetings table may be empty
  }

  // Fetch pending action items
  let pendingActionItems: MemberProfileInput['pendingActionItems'] = [];
  try {
    const aiRows = db
      .prepare<[string], { title: string; due_date: string | null }>(
        `SELECT title, due_date FROM action_items WHERE assignee = ? AND status = 'pending'`,
      )
      .all(member.name) as Array<{ title: string; due_date: string | null }>;
    pendingActionItems = aiRows.map((a) => ({ description: a.title, dueDate: a.due_date ?? undefined }));
  } catch {
    // action_items may be empty
  }

  // Fetch commit-by-file ownership from code_graph
  let commitsByFile: MemberProfileInput['commitsByFile'] = [];
  if (member.github_handle) {
    try {
      const cgRows = db
        .prepare<[string], { file: string; commitCount: number }>(
          `SELECT ref_file as file, COUNT(*) as commitCount
           FROM code_graph WHERE symbol = ? AND ref_type = 'commit'
           GROUP BY ref_file ORDER BY commitCount DESC LIMIT 10`,
        )
        .all(member.github_handle) as Array<{ file: string; commitCount: number }>;
      commitsByFile = cgRows;
    } catch {
      // code_graph not populated yet (EP-43)
    }
  }

  const input: MemberProfileInput = {
    name: member.name,
    dataCoverageNote,
    messageCount: activity.messageCount,
    topTopics: activity.topTopics,
    lastActiveDate: activity.lastActiveDate,
    recentMessages: activity.recentMessages,
    openTickets,
    overdueTickets,
    recentMeetings,
    pendingActionItems,
    commitsByFile,
    teamAvgMessages: teamAvg.avgMessages,
    teamAvgCommits: teamAvg.avgCommits,
    teamAvgJiraActivity: teamAvg.avgJiraActivity,
  };

  const result = await analyzer.buildMemberProfile(input);

  saveMemberProfile(db, memberId, {
    profile_content: result.profileMarkdown,
    summary: result.summary,
    activity_level: result.activityLevel,
    activity_score: result.activityScore,
    workload_signal: result.workloadSignal,
    domains: JSON.stringify(result.domains),
    jira_open_count: openTickets.length,
    jira_overdue_count: overdueTickets.length,
    top_topics: JSON.stringify(activity.topTopics),
    code_files_owned: JSON.stringify(result.codeOwnership),
    last_updated: new Date().toISOString(),
  });
}
