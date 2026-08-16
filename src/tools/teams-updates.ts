/**
 * get_teams_updates MCP Tool
 *
 * Searches stored Teams messages and meeting transcripts for a keyword,
 * sentence, or topic. Returns a Claude-summarized report with:
 *   - Matching messages grouped by chat
 *   - Related meetings with their topics and decisions
 *   - Action items extracted from the matches
 *   - A natural-language summary
 */

import Anthropic from '@anthropic-ai/sdk';
import type { PromptCachingBetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/prompt-caching/messages.js';
import type Database from 'better-sqlite3';
import { withRetry } from '../lib/retry.js';
import { bucketCallParams } from '../services/model-config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GetTeamsUpdatesArgs {
  /** Free-text query: keyword, topic, sentence, or question */
  query: string;
  /** Optional date filter — only return results from this date onwards (ISO format) */
  since?: string;
  /** Include meeting transcripts in search (default: true) */
  includeMeetings?: boolean;
  /** Max results to return before summarizing (default: 50) */
  maxResults?: number;
}

interface MessageRow {
  id: number;
  source_id: string | null;
  subject: string | null;
  content: string;
  author: string;
  timestamp: string;
  raw_data: string | null;
  rank: number;
}

interface MeetingRow {
  id: number;
  title: string;
  date: string;
  chat_name: string | null;
  attendees: string | null;
  summary: string | null;
  topics: string | null;
  decisions: string | null;
  transcript: string | null;
  rank: number;
}

interface SearchResults {
  messages: MessageRow[];
  meetings: MeetingRow[];
}

// ---------------------------------------------------------------------------
// Search via FTS5
// ---------------------------------------------------------------------------

function searchFTS(
  db: Database.Database,
  query: string,
  since: string | undefined,
  includeMeetings: boolean,
  maxResults: number
): SearchResults {
  // Sanitize query for FTS5 — escape double quotes
  const ftsQuery = query.replace(/"/g, '""');

  // Messages FTS search
  const msgSql = since
    ? `
      SELECT m.id, m.source_id, m.subject, m.content, m.author, m.timestamp, m.raw_data,
             bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.id
      WHERE messages_fts MATCH ? AND m.source = 'teams' AND m.timestamp >= ?
      ORDER BY rank
      LIMIT ?
    `
    : `
      SELECT m.id, m.source_id, m.subject, m.content, m.author, m.timestamp, m.raw_data,
             bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.id
      WHERE messages_fts MATCH ? AND m.source = 'teams'
      ORDER BY rank
      LIMIT ?
    `;

  const messages = since
    ? (db.prepare(msgSql).all(ftsQuery, since, maxResults) as MessageRow[])
    : (db.prepare(msgSql).all(ftsQuery, maxResults) as MessageRow[]);

  if (!includeMeetings) return { messages, meetings: [] };

  // Meetings FTS search
  const meetSql = since
    ? `
      SELECT mt.id, mt.title, mt.date, mt.chat_name, mt.attendees, mt.summary,
             mt.topics, mt.decisions, mt.transcript,
             bm25(meetings_fts) AS rank
      FROM meetings_fts
      JOIN meetings mt ON meetings_fts.rowid = mt.id
      WHERE meetings_fts MATCH ? AND mt.date >= ?
      ORDER BY rank
      LIMIT ?
    `
    : `
      SELECT mt.id, mt.title, mt.date, mt.chat_name, mt.attendees, mt.summary,
             mt.topics, mt.decisions, mt.transcript,
             bm25(meetings_fts) AS rank
      FROM meetings_fts
      JOIN meetings mt ON meetings_fts.rowid = mt.id
      WHERE meetings_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `;

  const meetings = since
    ? (db.prepare(meetSql).all(ftsQuery, since, maxResults) as MeetingRow[])
    : (db.prepare(meetSql).all(ftsQuery, maxResults) as MeetingRow[]);

  return { messages, meetings };
}

// ---------------------------------------------------------------------------
// Fallback: plain LIKE search when FTS returns nothing
// ---------------------------------------------------------------------------

function searchLike(
  db: Database.Database,
  query: string,
  since: string | undefined,
  includeMeetings: boolean,
  maxResults: number
): SearchResults {
  const pattern = `%${query}%`;

  const msgSql = since
    ? `SELECT id, source_id, subject, content, author, timestamp, raw_data, 0 as rank
       FROM messages WHERE source = 'teams' AND (content LIKE ? OR subject LIKE ?) AND timestamp >= ?
       ORDER BY timestamp DESC LIMIT ?`
    : `SELECT id, source_id, subject, content, author, timestamp, raw_data, 0 as rank
       FROM messages WHERE source = 'teams' AND (content LIKE ? OR subject LIKE ?)
       ORDER BY timestamp DESC LIMIT ?`;

  const messages = since
    ? (db.prepare(msgSql).all(pattern, pattern, since, maxResults) as MessageRow[])
    : (db.prepare(msgSql).all(pattern, pattern, maxResults) as MessageRow[]);

  if (!includeMeetings) return { messages, meetings: [] };

  const meetSql = since
    ? `SELECT id, title, date, chat_name, attendees, summary, topics, decisions, transcript, 0 as rank
       FROM meetings WHERE (title LIKE ? OR transcript LIKE ? OR topics LIKE ? OR summary LIKE ?) AND date >= ?
       ORDER BY date DESC LIMIT ?`
    : `SELECT id, title, date, chat_name, attendees, summary, topics, decisions, transcript, 0 as rank
       FROM meetings WHERE title LIKE ? OR transcript LIKE ? OR topics LIKE ? OR summary LIKE ?
       ORDER BY date DESC LIMIT ?`;

  const meetings = since
    ? (db.prepare(meetSql).all(pattern, pattern, pattern, pattern, since, maxResults) as MeetingRow[])
    : (db.prepare(meetSql).all(pattern, pattern, pattern, pattern, maxResults) as MeetingRow[]);

  return { messages, meetings };
}

// ---------------------------------------------------------------------------
// Format results for Claude + for the response
// ---------------------------------------------------------------------------

function formatForClaude(query: string, results: SearchResults): string {
  const lines: string[] = [`Search query: "${query}"`, ''];

  if (results.messages.length > 0) {
    lines.push(`## Messages (${results.messages.length})`, '');
    for (const msg of results.messages) {
      const chat = msg.subject?.replace('[Teams] ', '') ?? 'Unknown chat';
      lines.push(`[${msg.timestamp}] ${msg.author} in "${chat}":`);
      lines.push(msg.content.slice(0, 300));
      lines.push('');
    }
  }

  if (results.meetings.length > 0) {
    lines.push(`## Meetings (${results.meetings.length})`, '');
    for (const m of results.meetings) {
      lines.push(`### ${m.title} (${m.date}) — ${m.chat_name ?? ''}`);
      if (m.summary) lines.push(`Summary: ${m.summary}`);
      if (m.topics) {
        const topics = safeJsonParse<string[]>(m.topics, []);
        if (topics.length) lines.push(`Topics: ${topics.join(', ')}`);
      }
      if (m.decisions) {
        const decisions = safeJsonParse<string[]>(m.decisions, []);
        if (decisions.length) lines.push(`Decisions: ${decisions.join('; ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function safeJsonParse<T>(str: string | null, fallback: T): T {
  if (!str) return fallback;
  try { return JSON.parse(str) as T; } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Claude summarization
// ---------------------------------------------------------------------------

async function summarizeResults(
  query: string,
  content: string,
  anthropicApiKey?: string,
  db?: Database.Database,
): Promise<string> {
  if (!anthropicApiKey || !content.trim()) return '';

  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const client = new Anthropic({
    apiKey: baseURL ? 'x-proxy' : anthropicApiKey,
    ...(baseURL ? {
      baseURL,
      defaultHeaders: { 'Authorization': `Bearer ${anthropicApiKey}` },
    } : {}),
  });

  const systemPrompt = 'You are a work intelligence assistant. Summarize search results from Teams messages and meetings concisely and helpfully.';
  const cachedSystem: PromptCachingBetaTextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  const bucketParams = db ? bucketCallParams(db, 'digest', 1024) : {
    model: 'claude-sonnet-4-6' as const,
    max_tokens: 1024,
  };

  const truncated = content.length > 8000 ? content.slice(0, 8000) + '\n...[truncated]' : content;

  try {
    // Retry once on transient Anthropic errors — same rationale as
    // daily-summary.ts. See `src/lib/retry.ts` defaultShouldRetry list.
    const response = await withRetry(
      () => client.beta.promptCaching.messages.create({
        ...bucketParams,
        system: cachedSystem,
        messages: [{
          role: 'user',
          content: `Based on the following Teams messages and meeting data, answer this query: "${query}"\n\nProvide:\n1. A direct answer / summary\n2. Key updates grouped by topic\n3. Any decisions or action items found\n4. Which chats/meetings are most relevant\n\n---\n${truncated}`,
        }],
      }),
      { maxAttempts: 2, baseDelayMs: 1_000 },
    );

    const block = response.content.find((b) => b.type === 'text');
    return block?.type === 'text' ? block.text : '';
  } catch (err) {
    return `(AI summary unavailable: ${err instanceof Error ? err.message : String(err)})`;
  }
}

// ---------------------------------------------------------------------------
// Detect chats that appear to have had meetings but have no transcript stored
// ---------------------------------------------------------------------------

function findChatsWithMissingTranscripts(
  db: Database.Database,
  messages: MessageRow[]
): string[] {
  // Collect unique chat names from the matched messages
  const chatNames = new Set<string>();
  for (const msg of messages) {
    const chat = msg.subject?.replace('[Teams] ', '') ?? '';
    if (chat) chatNames.add(chat);
  }

  if (chatNames.size === 0) return [];

  // Keywords that strongly suggest a meeting took place
  const meetingKeywords = /\b(transcript|recording|recap|meeting notes|action item|follow.?up|attendees?|agenda|minutes|presentation|shared screen)\b/i;

  const missing: string[] = [];

  for (const chatName of chatNames) {
    // Already have a transcript for this chat?
    const existing = db.prepare(
      "SELECT id FROM meetings WHERE chat_name = ? AND transcript IS NOT NULL AND length(transcript) > 100"
    ).get(chatName);

    if (existing) continue;

    // Check if any messages in this chat hint at a meeting
    const chatMessages = db.prepare(
      "SELECT content FROM messages WHERE source = 'teams' AND subject = ? ORDER BY timestamp DESC LIMIT 50"
    ).all(`[Teams] ${chatName}`) as Array<{ content: string }>;

    const hasMeetingSignal = chatMessages.some((m) => meetingKeywords.test(m.content));
    if (hasMeetingSignal) {
      missing.push(chatName);
    }
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export async function getTeamsUpdates(
  db: Database.Database,
  args: GetTeamsUpdatesArgs,
  anthropicApiKey?: string
): Promise<string> {
  const {
    query,
    since,
    includeMeetings = true,
    maxResults = 50,
  } = args;

  if (!query?.trim()) {
    return 'Error: query is required.';
  }

  // Try FTS first, fall back to LIKE
  let results: SearchResults;
  try {
    results = searchFTS(db, query, since, includeMeetings, maxResults);
    // FTS may return 0 results for short/common queries — fall back to LIKE
    if (results.messages.length === 0 && results.meetings.length === 0) {
      results = searchLike(db, query, since, includeMeetings, maxResults);
    }
  } catch {
    // FTS table may not exist yet (migration hasn't run) — fall back to LIKE
    results = searchLike(db, query, since, includeMeetings, maxResults);
  }

  const totalHits = results.messages.length + results.meetings.length;

  if (totalHits === 0) {
    return `No results found for "${query}" in Teams messages or meetings.${since ? ` (searching from ${since})` : ''}`;
  }

  // Detect chats that look like they had a meeting but have no transcript stored
  const missingTranscripts = findChatsWithMissingTranscripts(db, results.messages);

  // Build response
  const contentForClaude = formatForClaude(query, results);
  const aiSummary = await summarizeResults(query, contentForClaude, anthropicApiKey, db);

  // Format the final response
  const lines: string[] = [];

  if (aiSummary) {
    lines.push('## Summary', '', aiSummary, '');
  }

  lines.push(`---`, `*Found ${results.messages.length} messages and ${results.meetings.length} meetings matching "${query}".*`);

  // Prompt user to provide transcripts for chats that appear to have had meetings
  if (missingTranscripts.length > 0) {
    lines.push('', '## Missing Transcripts', '');
    lines.push('The following chats appear to have had meetings, but no transcript is stored. To get better answers about these meetings, please provide the transcript text:');
    for (const chat of missingTranscripts) {
      lines.push(`- **${chat}**: Open the chat in Teams → click the Recap tab → copy the transcript text and share it here.`);
    }
    lines.push('');
  }

  if (results.messages.length > 0) {
    lines.push('', '## Matching Messages', '');
    // Group by chat
    const byChat = new Map<string, typeof results.messages>();
    for (const msg of results.messages) {
      const chat = msg.subject?.replace('[Teams] ', '') ?? 'Unknown';
      const existing = byChat.get(chat) ?? [];
      existing.push(msg);
      byChat.set(chat, existing);
    }
    for (const [chat, msgs] of byChat.entries()) {
      lines.push(`### ${chat} (${msgs.length} messages)`);
      for (const msg of msgs.slice(0, 5)) {
        lines.push(`- **${msg.author}** (${msg.timestamp.slice(0, 10)}): ${msg.content.slice(0, 150)}${msg.content.length > 150 ? '...' : ''}`);
      }
      if (msgs.length > 5) lines.push(`  *(${msgs.length - 5} more)*`);
      lines.push('');
    }
  }

  if (results.meetings.length > 0) {
    lines.push('## Matching Meetings', '');
    for (const m of results.meetings) {
      const topics = safeJsonParse<string[]>(m.topics, []);
      const decisions = safeJsonParse<string[]>(m.decisions, []);
      lines.push(`### ${m.title}`);
      lines.push(`**Date:** ${m.date.slice(0, 10)} | **Chat:** ${m.chat_name ?? 'unknown'}`);
      if (m.summary) lines.push(`**Summary:** ${m.summary}`);
      if (topics.length) lines.push(`**Topics:** ${topics.join(', ')}`);
      if (decisions.length) {
        lines.push('**Decisions:**');
        for (const d of decisions) lines.push(`  - ${d}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
