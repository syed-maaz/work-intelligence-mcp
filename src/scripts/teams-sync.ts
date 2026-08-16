#!/usr/bin/env node
/**
 * Teams Sync Script
 *
 * Discovers all Teams group chats, scrapes active ones (those with new messages),
 * scrapes Recap tabs for meeting transcripts, stores everything in SQLite,
 * and marks inactive chats.
 *
 * Usage:
 *   npm run teams-sync                     # scrape unread chats only (fast)
 *   TEAMS_ALL=true npm run teams-sync      # scrape all chats
 *   TEAMS_SINCE_DAYS=30 npm run teams-sync # look back N days (default: 90)
 *
 * Environment variables:
 *   BROWSER_PROFILE_PATH   Chrome profile path (required)
 *   BROWSER_EXECUTABLE     Path to Chrome binary (required for SSO)
 *   BROWSER_HEADLESS       'true' | 'false' (default: true)
 *   TEAMS_ALL              'true' = scrape all chats, not just unread
 *   TEAMS_SINCE_DAYS       Days of history to load per chat (default: 90)
 *   ANTHROPIC_API_KEY      For meeting transcript analysis (optional)
 *   ANTHROPIC_BASE_URL     Proxy URL (optional)
 */

import { getDatabase, closeDatabase } from '../db/connection.js';
import { getBrowserSession } from '../fetcher/sources/browser-session.js';
import { TeamsChatScraper } from '../fetcher/sources/teams-chats.js';
import { TeamsMeetingsScraper } from '../fetcher/sources/teams-meetings.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const UNREAD_ONLY = process.env.TEAMS_ALL !== 'true';
const SINCE_DAYS = Number.parseInt(process.env.TEAMS_SINCE_DAYS ?? '90', 10);
const INACTIVE_THRESHOLD_DAYS = 7;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function upsertGroupChat(db: Database.Database, name: string, lastMessageAt: Date | null, isActive: boolean): number {
  // Guard against invalid dates
  const lastMessageAtISO = (lastMessageAt && !isNaN(lastMessageAt.getTime()))
    ? lastMessageAt.toISOString()
    : null;

  const existing = db.prepare('SELECT id FROM group_chats WHERE name = ?').get(name) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE group_chats SET
        last_message_at = COALESCE(?, last_message_at),
        is_active = ?,
        last_scraped_at = datetime('now'),
        inactive_since = CASE WHEN ? = 0 AND inactive_since IS NULL THEN datetime('now') WHEN ? = 1 THEN NULL ELSE inactive_since END
      WHERE id = ?
    `).run(
      lastMessageAtISO,
      isActive ? 1 : 0,
      isActive ? 1 : 0,
      isActive ? 1 : 0,
      existing.id
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO group_chats (name, last_message_at, is_active, last_scraped_at, message_count)
    VALUES (?, ?, ?, datetime('now'), 0)
  `).run(name, lastMessageAtISO, isActive ? 1 : 0);

  return result.lastInsertRowid as number;
}

function upsertMessage(db: Database.Database, msg: {
  sourceId: string;
  chatName: string;
  senderName: string;
  createdAt: Date;
  bodyHtml: string;
  bodyText: string;
}): void {
  // Ensure a default "teams" topic exists for unassigned messages
  db.prepare(`
    INSERT OR IGNORE INTO topics (name, created_at) VALUES ('teams', datetime('now'))
  `).run();

  const topicRow = db.prepare('SELECT id FROM topics WHERE name = ?').get('teams') as { id: number };

  db.prepare(`
    INSERT OR IGNORE INTO messages (topic_id, source, source_id, subject, content, author, timestamp, raw_data)
    VALUES (?, 'teams', ?, ?, ?, ?, ?, ?)
  `).run(
    topicRow.id,
    msg.sourceId,
    `[Teams] ${msg.chatName}`,
    msg.bodyText,
    msg.senderName,
    msg.createdAt.toISOString(),
    JSON.stringify({ chatName: msg.chatName, html: msg.bodyHtml }),
  );
}

function upsertMeeting(db: Database.Database, meeting: {
  sourceId: string;
  chatName: string;
  title: string;
  date: Date;
  attendees: string[];
  transcriptText: string;
  notes: string;
  topics: string[];
  summary: string;
  decisions: string[];
  actionItems: string[];
}): void {
  // Ensure a default "teams" topic exists
  db.prepare(`
    INSERT OR IGNORE INTO topics (name, created_at) VALUES ('teams', datetime('now'))
  `).run();

  const topicRow = db.prepare('SELECT id FROM topics WHERE name = ?').get('teams') as { id: number };

  db.prepare(`
    INSERT OR IGNORE INTO meetings
      (topic_id, title, date, attendees, notes, decisions, transcript, topics, summary, chat_name, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    topicRow.id,
    meeting.title,
    meeting.date.toISOString(),
    JSON.stringify(meeting.attendees),
    meeting.notes,
    JSON.stringify(meeting.decisions),
    meeting.transcriptText,
    JSON.stringify(meeting.topics),
    meeting.summary,
    meeting.chatName,
    meeting.sourceId,
  );
}

function markInactiveChats(db: Database.Database): void {
  const threshold = new Date(Date.now() - INACTIVE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    UPDATE group_chats SET is_active = 0, inactive_since = COALESCE(inactive_since, datetime('now'))
    WHERE is_active = 1
      AND (last_message_at IS NULL OR last_message_at < ?)
      AND last_scraped_at IS NOT NULL
  `).run(threshold);
}

function updateMessageCount(db: Database.Database, chatName: string): void {
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM messages WHERE source = 'teams' AND subject = ?"
  ).get(`[Teams] ${chatName}`) as { cnt: number };

  db.prepare('UPDATE group_chats SET message_count = ? WHERE name = ?').run(row.cnt, chatName);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const start = Date.now();
  process.stderr.write(`[TeamSync] Starting (unreadOnly=${UNREAD_ONLY}, sinceDays=${SINCE_DAYS})\n`);

  const db = getDatabase();
  const session = getBrowserSession();

  const chatScraper = new TeamsChatScraper(session);
  const meetingScraper = new TeamsMeetingsScraper(session, ANTHROPIC_API_KEY, db);

  try {
    // --- 1. Scrape chats + Recap tabs inline (same page, while chat is open) ---
    const chats = await chatScraper.scrapeChats({
      unreadOnly: UNREAD_ONLY,
      sinceDays: SINCE_DAYS,
      maxMessagesPerChat: 500,
      maxChats: 50,
      meetingScraper,
    });

    process.stderr.write(`[TeamsSync] Processing ${chats.length} chats into DB...\n`);

    let totalMessages = 0;
    let totalMeetings = 0;

    for (const chat of chats) {
      const isActive = chat.lastMessageAt !== null &&
        chat.lastMessageAt > new Date(Date.now() - INACTIVE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

      upsertGroupChat(db, chat.name, chat.lastMessageAt, isActive || chat.isUnread);

      const insertMessages = db.transaction(() => {
        for (const msg of chat.messages) {
          upsertMessage(db, msg);
        }
      });
      insertMessages();
      totalMessages += chat.messages.length;
      updateMessageCount(db, chat.name);

      // Store meeting if scraped from Recap tab
      if (chat.meeting) {
        upsertMeeting(db, chat.meeting);
        totalMeetings++;
      }
    }

    // --- 3. Mark inactive chats ---
    markInactiveChats(db);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stderr.write(
      `[TeamsSync] Done in ${elapsed}s | Chats: ${chats.length} | Messages: ${totalMessages} | Meetings: ${totalMeetings}\n`
    );

    // Print summary to stdout
    const activeChats = db.prepare('SELECT name, message_count, last_message_at FROM group_chats WHERE is_active = 1 ORDER BY last_message_at DESC').all() as Array<{ name: string; message_count: number; last_message_at: string }>;

    process.stdout.write('\n## Teams Sync Summary\n\n');
    process.stdout.write(`**Active chats:** ${activeChats.length}\n\n`);
    for (const c of activeChats) {
      process.stdout.write(`- **${c.name}** — ${c.message_count} messages, last: ${c.last_message_at ?? 'unknown'}\n`);
    }
    process.stdout.write(`\n**Total messages scraped:** ${totalMessages}\n`);

  } finally {
    await session.close().catch(() => undefined);
    closeDatabase();
  }
}

main().catch((err) => {
  process.stderr.write(`[TeamsSync] Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
