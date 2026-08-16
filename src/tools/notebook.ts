/**
 * Topic Notebook — LLM Memory per Topic
 *
 * Each topic gets a persistent, structured notebook that Claude
 * maintains incrementally. On first access it builds from all
 * available messages/meetings. On subsequent accesses it only
 * processes new messages (id > last_message_id) and merges them
 * into the existing notebook — incremental LLM memory update.
 */

import type Database from 'better-sqlite3';
import type { AIAnalyzer, NotebookMessage, NotebookMeeting } from '../services/analyzer.js';
import { parseMarkdownToState, type NotebookState } from '../services/notebook-merge.js';
import {
  getNotebook,
  saveNotebook,
  listNotebooks,
  deleteNotebook,
  getCorrections,
  type TopicNotebook,
} from '../db/queries.js';

export { listNotebooks, deleteNotebook, type TopicNotebook };

interface MessageRow {
  id: number;
  source: string;
  subject: string | null;
  content: string;
  author: string;
  timestamp: string;
}

interface MeetingRow {
  id: number;
  title: string;
  date: string;
  summary: string | null;
  decisions: string | null;
  topics: string | null;
  chat_name: string | null;
}

function rowToMessage(r: MessageRow): NotebookMessage {
  return {
    source: r.source,
    content: r.content,
    author: r.author,
    timestamp: r.timestamp,
  };
}

function rowToMeeting(r: MeetingRow): NotebookMeeting {
  return {
    title: r.title,
    date: r.date,
    summary: r.summary,
    decisions: r.decisions,
    topics: r.topics,
  };
}

/**
 * Fetch all messages for a topic by name. Falls back to searching all
 * messages via FTS if the topic is not in the topics table.
 */
function fetchMessagesForTopic(db: Database.Database, topicName: string): MessageRow[] {
  // Try exact topic match first
  const topic = db.prepare(`SELECT id FROM topics WHERE name = ?`).get(topicName) as { id: number } | undefined;
  if (topic) {
    return db.prepare(`
      SELECT id, source, subject, content, author, timestamp
      FROM messages
      WHERE topic_id = ?
      ORDER BY id ASC
    `).all(topic.id) as MessageRow[];
  }

  // Fallback: FTS search across all sources using topic name as query
  const ftsQuery = topicName.replace(/"/g, '""');
  try {
    return db.prepare(`
      SELECT m.id, m.source, m.subject, m.content, m.author, m.timestamp
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.id
      WHERE messages_fts MATCH ?
      ORDER BY m.id ASC
      LIMIT 200
    `).all(ftsQuery) as MessageRow[];
  } catch {
    return [];
  }
}

function fetchMeetingsForTopic(db: Database.Database, topicName: string): MeetingRow[] {
  const topic = db.prepare(`SELECT id FROM topics WHERE name = ?`).get(topicName) as { id: number } | undefined;
  if (topic) {
    return db.prepare(`
      SELECT id, title, date, summary, decisions, topics, chat_name
      FROM meetings
      WHERE topic_id = ?
      ORDER BY date ASC
    `).all(topic.id) as MeetingRow[];
  }
  // Fallback: all meetings
  return db.prepare(`
    SELECT id, title, date, summary, decisions, topics, chat_name
    FROM meetings
    ORDER BY date ASC
    LIMIT 50
  `).all() as MeetingRow[];
}

function fetchNewMessages(db: Database.Database, topicName: string, afterId: number): MessageRow[] {
  const topic = db.prepare(`SELECT id FROM topics WHERE name = ?`).get(topicName) as { id: number } | undefined;
  if (topic) {
    return db.prepare(`
      SELECT id, source, subject, content, author, timestamp
      FROM messages
      WHERE topic_id = ? AND id > ?
      ORDER BY id ASC
    `).all(topic.id, afterId) as MessageRow[];
  }
  return [];
}

function fetchNewMeetings(db: Database.Database, topicName: string, afterId: number): MeetingRow[] {
  const topic = db.prepare(`SELECT id FROM topics WHERE name = ?`).get(topicName) as { id: number } | undefined;
  if (topic) {
    return db.prepare(`
      SELECT id, title, date, summary, decisions, topics, chat_name
      FROM meetings
      WHERE topic_id = ? AND id > ?
      ORDER BY date ASC
    `).all(topic.id, afterId) as MeetingRow[];
  }
  return [];
}

function getMaxMessageId(db: Database.Database, topicName: string): number {
  const topic = db.prepare(`SELECT id FROM topics WHERE name = ?`).get(topicName) as { id: number } | undefined;
  if (!topic) return 0;
  const row = db.prepare(`SELECT MAX(id) as maxId FROM messages WHERE topic_id = ?`).get(topic.id) as { maxId: number | null };
  return row?.maxId ?? 0;
}

function countMessages(db: Database.Database, topicName: string): number {
  const topic = db.prepare(`SELECT id FROM topics WHERE name = ?`).get(topicName) as { id: number } | undefined;
  if (!topic) return 0;
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM messages WHERE topic_id = ?`).get(topic.id) as { cnt: number };
  return row?.cnt ?? 0;
}

/**
 * Get the notebook for a topic, building or updating it as needed.
 *
 * - No notebook: build from all messages → save
 * - Notebook exists + new messages: merge new data into existing memory → save
 * - Notebook exists + no new messages: return cached as-is
 */
export async function getOrBuildNotebook(
  db: Database.Database,
  topicName: string,
  analyzer: AIAnalyzer,
  opts: { forceRebuild?: boolean } = {}
): Promise<{ content: string; sources: string[]; fresh: boolean; last_updated: string; message_count: number }> {
  const existing = getNotebook(db, topicName);
  const corrections = getCorrections(db, topicName);

  if (opts.forceRebuild || !existing) {
    // Full build from all data
    const msgRows = fetchMessagesForTopic(db, topicName);
    const meetRows = fetchMeetingsForTopic(db, topicName);
    const messages = msgRows.map(rowToMessage);
    const meetings = meetRows.map(rowToMeeting);

    const { content, sources } = await analyzer.buildNotebook(topicName, messages, meetings, corrections);
    const maxId = getMaxMessageId(db, topicName);
    const count = countMessages(db, topicName);
    // Option 3 (schema v68): parse the freshly-built markdown into state and
    // persist it alongside the markdown so the next call can patch instead
    // of rebuild. parseMarkdownToState returns null on parse failure — we
    // pass that through (column stays NULL) so the next read tries again.
    const builtState = parseMarkdownToState(content);
    const stateJson = builtState ? JSON.stringify(builtState) : null;
    saveNotebook(db, topicName, content, maxId, count, stateJson);

    const updated = getNotebook(db, topicName);
    return { content, sources, fresh: true, last_updated: updated?.last_updated ?? new Date().toISOString(), message_count: count };
  }

  // Check for new messages since last update
  const lastId = existing.last_message_id ?? 0;
  const newMsgRows = fetchNewMessages(db, topicName, lastId);
  const newMeetRows = fetchNewMeetings(db, topicName, lastId);

  if (newMsgRows.length === 0 && newMeetRows.length === 0) {
    // Nothing new — return cached
    return {
      content: existing.content,
      sources: [],
      fresh: false,
      last_updated: existing.last_updated,
      message_count: existing.message_count,
    };
  }

  // Incremental update — Claude returns a PATCH, we apply it server-side.
  // Recover state from state_json if available, else parse markdown (backfill
  // for rows written before schema v68). If parsing fails, updateNotebook
  // itself falls back to emptyState() and lets the model fill it in.
  let existingState: NotebookState | null = null;
  if (existing.state_json) {
    try {
      existingState = JSON.parse(existing.state_json) as NotebookState;
    } catch {
      existingState = null;  // fall through to markdown parse
    }
  }
  if (!existingState) {
    existingState = parseMarkdownToState(existing.content);
  }

  const newMessages = newMsgRows.map(rowToMessage);
  const newMeetings = newMeetRows.map(rowToMeeting);
  const { content, sources, state: nextState } =
    await analyzer.updateNotebook(topicName, existing.content, newMessages, newMeetings, corrections, existingState);

  const maxId = getMaxMessageId(db, topicName);
  const count = countMessages(db, topicName);
  saveNotebook(db, topicName, content, maxId, count, JSON.stringify(nextState));

  const updated = getNotebook(db, topicName);
  return { content, sources, fresh: true, last_updated: updated?.last_updated ?? new Date().toISOString(), message_count: count };
}
