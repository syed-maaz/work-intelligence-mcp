/**
 * Work-data retrieval for POST /api/chat — Teams/Jira/calendar queries must not
 * fall through to ResearchEngine (code-research persona).
 *
 * When required data is missing, returns structured gaps so the bridge can ask
 * the user to run sync instead of hallucinating or invoking the code agent.
 */

import type Database from 'better-sqlite3';
import type { ContextItem } from './analyzer.js';

export type WorkDataSource = 'teams' | 'jira' | 'meetings' | 'email';

export interface DataGap {
  source: WorkDataSource;
  label: string;
  reason: string;
  /** CLI hint for terminal users */
  cliHint: string;
}

export interface WorkContextFetchResult {
  items: ContextItem[];
  gaps: DataGap[];
  /** True when at least one non-placeholder context item exists for requested sources */
  hasData: boolean;
}

export interface DataGapReplyOptions {
  syncRunning: boolean;
  browserConfigured: boolean;
  lastSyncAt: string | null;
  teamsMessageCount: number;
}

/** True when the user is asking about work data, not the configured repos codebase. */
export function isWorkIntelligenceQuery(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    /\b(teams?|jira|email|outlook|meeting|calendar|action items?|digest|sprint|messages?|chats?|transcript|recap|activity)\b/i.test(
      message,
    ) ||
    /^summari[sz]e?\b/i.test(lower) ||
    /\b(yesterday|today|last week|overnight|this week)\b/i.test(lower)
  );
}

function resolveDateRange(message: string): { start: string; end: string; label: string } {
  const lower = message.toLowerCase();
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  if (/\byesterday\b/.test(lower)) {
    const y = new Date(today);
    y.setUTCDate(y.getUTCDate() - 1);
    const day = iso(y);
    return { start: day, end: day, label: 'yesterday' };
  }
  if (/\btoday\b/.test(lower)) {
    const day = iso(today);
    return { start: day, end: day, label: 'today' };
  }
  if (/\blast week\b/.test(lower)) {
    const end = iso(today);
    const startD = new Date(today);
    startD.setUTCDate(startD.getUTCDate() - 7);
    return { start: iso(startD), end, label: 'last 7 days' };
  }
  const end = iso(today);
  const startD = new Date(today);
  startD.setUTCDate(startD.getUTCDate() - 2);
  return { start: iso(startD), end, label: 'last 2 days' };
}

function inferRequiredSources(message: string): WorkDataSource[] {
  const lower = message.toLowerCase();
  const sources = new Set<WorkDataSource>();
  if (/\bteams?\b/i.test(message) || (/\b(activity|messages?|chats?)\b/i.test(lower) && /^summari/i.test(lower))) {
    sources.add('teams');
  }
  if (/\bjira\b/i.test(message) || /\b(ticket|issue|sprint|blocker)\b/i.test(lower)) {
    sources.add('jira');
  }
  if (/\b(meeting|transcript|recap)\b/i.test(lower)) {
    sources.add('meetings');
  }
  if (/\b(email|outlook|inbox)\b/i.test(lower)) {
    sources.add('email');
  }
  if (sources.size === 0 && isWorkIntelligenceQuery(message)) {
    sources.add('teams');
  }
  return [...sources];
}

function countTeamsInRange(
  db: Database.Database,
  start: string,
  end: string,
): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
         WHERE source = 'teams' AND date(timestamp) >= date(?) AND date(timestamp) <= date(?)`,
      )
      .get(start, end) as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function countSource(db: Database.Database, source: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE source = ?`).get(source) as {
      n: number;
    };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function countMeetings(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM meetings').get() as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export function detectDataGaps(
  db: Database.Database,
  message: string,
): { gaps: DataGap[]; range: ReturnType<typeof resolveDateRange> } {
  const range = resolveDateRange(message);
  const gaps: DataGap[] = [];

  for (const source of inferRequiredSources(message)) {
    if (source === 'teams') {
      const inRange = countTeamsInRange(db, range.start, range.end);
      const total = countSource(db, 'teams');
      if (inRange === 0) {
        gaps.push({
          source: 'teams',
          label: `Teams (${range.label})`,
          reason:
            total === 0
              ? 'No Teams messages are stored locally yet.'
              : `No Teams messages for ${range.label} (${range.start}${range.end !== range.start ? `–${range.end}` : ''}); ${total} message(s) exist for other dates.`,
          cliHint: 'npm run teams-sync',
        });
      }
    }
    if (source === 'jira' && countSource(db, 'jira') === 0) {
      gaps.push({
        source: 'jira',
        label: 'Jira',
        reason: 'No Jira issues are stored locally yet.',
        cliHint: 'npm run report or trigger sync from the dashboard',
      });
    }
    if (source === 'meetings' && countMeetings(db) === 0) {
      gaps.push({
        source: 'meetings',
        label: 'Meeting transcripts',
        reason: 'No meeting recaps or transcripts are stored yet (Teams meeting scrape).',
        cliHint: 'npm run teams-sync (opens chats with Recap tabs)',
      });
    }
    if (source === 'email' && countSource(db, 'email') === 0) {
      gaps.push({
        source: 'email',
        label: 'Email / Outlook',
        reason: 'No Outlook messages are stored locally yet.',
        cliHint: 'Run full sync with browser profile configured',
      });
    }
  }

  return { gaps, range };
}

/** User-facing reply when we should not call Claude on empty work data. */
export function buildDataGapReply(gaps: DataGap[], opts: DataGapReplyOptions): string {
  const lines: string[] = [
    "I don't have the data needed to answer that yet — nothing useful is in your local Work Intelligence database for this question.",
    '',
  ];

  for (const g of gaps) {
    lines.push(`**${g.label}:** ${g.reason}`);
  }

  lines.push('');
  if (!opts.browserConfigured) {
    lines.push(
      '**Browser not configured** — Teams and Outlook sync need `BROWSER_PROFILE_PATH` in `.env` (Chrome profile with an active Teams/Outlook session). See **Setup** in the sidebar.',
    );
    lines.push('');
  }

  if (opts.lastSyncAt) {
    lines.push(`Last successful sync: ${opts.lastSyncAt.slice(0, 19).replace('T', ' ')} UTC.`);
  } else if (opts.teamsMessageCount === 0) {
    lines.push('This install has never synced Teams messages.');
  }

  lines.push('');
  if (opts.syncRunning) {
    lines.push(
      'A **sync is already running** in the background (Teams, calendar, …). Wait a minute, then ask again — or tap **Check sync status** below.',
    );
  } else {
    lines.push(
      '**Run sync** to pull Teams chats, calendar, and related sources into SQLite (~2–5 min with browser).',
    );
    lines.push(
      'In chat: tap **Run sync now** (uses the **`wi_sync`** tool — same as the Work Intelligence plugin). In Atlas/Cursor: `wi_sync` with `{ "kind": "all" }` or the `/wi-sync` skill.',
    );
  }

  return lines.join('\n');
}

interface TeamsMsgRow {
  subject: string | null;
  content: string;
  author: string | null;
  timestamp: string;
}

function fetchTeamsItems(
  db: Database.Database,
  message: string,
  range: ReturnType<typeof resolveDateRange>,
): ContextItem[] {
  const lower = message.toLowerCase();
  const wantsTeams =
    /\bteams?\b/i.test(message) ||
    (/^summari[sz]e?\b/i.test(lower) && /\b(activity|messages?|chats?)\b/i.test(lower));

  if (!wantsTeams) return [];

  let rows: TeamsMsgRow[];
  try {
    rows = db
      .prepare(
        `SELECT subject, content, author, timestamp
         FROM messages
         WHERE source = 'teams'
           AND date(timestamp) >= date(?)
           AND date(timestamp) <= date(?)
         ORDER BY timestamp DESC
         LIMIT 100`,
      )
      .all(range.start, range.end) as TeamsMsgRow[];
  } catch {
    return [];
  }

  if (rows.length === 0) return [];

  const byChat = new Map<string, TeamsMsgRow[]>();
  for (const row of rows) {
    const chat =
      row.subject?.replace(/^\[Teams\]\s*/i, '').trim() ||
      row.subject ||
      'Unknown chat';
    const list = byChat.get(chat) ?? [];
    list.push(row);
    byChat.set(chat, list);
  }

  const items: ContextItem[] = [];
  for (const [chat, msgs] of byChat) {
    const lines = msgs.slice(0, 15).map((m) => {
      const ts = m.timestamp?.slice(0, 16) ?? '';
      const who = m.author?.trim() || 'unknown';
      const body = (m.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
      return `[${ts}] ${who}: ${body}`;
    });
    items.push({
      source: 'teams',
      title: `${chat} (${msgs.length} messages, ${range.label})`,
      content: lines.join('\n'),
      author: '',
      timestamp: msgs[0]?.timestamp ?? new Date().toISOString(),
    });
  }

  return items.slice(0, 12);
}

/**
 * Fetch work-data context items and detect gaps for chat.
 */
export function fetchWorkContextForChat(
  db: Database.Database,
  message: string,
): WorkContextFetchResult {
  const { gaps, range } = detectDataGaps(db, message);
  const items = fetchTeamsItems(db, message, range);
  return { items, gaps, hasData: items.length > 0 };
}

/** Skip Claude when work data was requested but SQLite has nothing for that window. */
export function shouldOfferSync(result: WorkContextFetchResult, message: string): boolean {
  if (!isWorkIntelligenceQuery(message)) return false;
  if (result.items.length > 0) return false;
  return result.gaps.length > 0;
}

/** @deprecated Use fetchWorkContextForChat */
export function fetchTeamsActivityContextItems(
  db: Database.Database,
  message: string,
): ContextItem[] {
  return fetchWorkContextForChat(db, message).items;
}
