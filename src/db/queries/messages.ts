import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  Message,
  MessageSchema,
} from '../schema.js';

export const InsertMessageSchema = z.object({
  topic_id: z.number(),
  source: z.string(),
  content: z.string(),
  author: z.string(),
  timestamp: z.string().optional(),
  metadata: z.string().nullable().optional(),
  source_id: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  raw_data: z.string().nullable().optional(),
});

export type InsertMessage = z.infer<typeof InsertMessageSchema>;

export function insertMessage(db: Database.Database, data: InsertMessage): Message {
  const validated = InsertMessageSchema.parse(data);
  const statement = db.prepare(`
    INSERT INTO messages (topic_id, source, content, author, timestamp, metadata, source_id, subject, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = statement.run(
    validated.topic_id,
    validated.source,
    validated.content,
    validated.author,
    validated.timestamp || new Date().toISOString(),
    validated.metadata || null,
    validated.source_id || null,
    validated.subject || null,
    validated.raw_data || null,
  );

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid) as unknown;
  return MessageSchema.parse(message);
}

export function upsertMessage(
  db: Database.Database,
  data: InsertMessage & { source_id: string }
): Message {
  const validated = InsertMessageSchema.parse(data);
  // INSERT OR IGNORE preserves the existing row id so foreign keys in
  // action_items.source_message_id are never orphaned.  A separate UPDATE
  // refreshes mutable fields (content, metadata, raw_data) in case the
  // source record changed since last sync.
  db.prepare(`
    INSERT OR IGNORE INTO messages
      (topic_id, source, content, author, timestamp, metadata, source_id, subject, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    validated.topic_id,
    validated.source,
    validated.content,
    validated.author,
    validated.timestamp || new Date().toISOString(),
    validated.metadata || null,
    validated.source_id,
    validated.subject || null,
    validated.raw_data || null,
  );

  db.prepare(`
    UPDATE messages
    SET content   = ?,
        metadata  = ?,
        raw_data  = ?,
        subject   = ?,
        timestamp = ?
    WHERE source = ? AND source_id = ?
  `).run(
    validated.content,
    validated.metadata || null,
    validated.raw_data || null,
    validated.subject || null,
    validated.timestamp || new Date().toISOString(),
    validated.source,
    validated.source_id,
  );

  const message = db
    .prepare('SELECT * FROM messages WHERE source = ? AND source_id = ?')
    .get(validated.source, validated.source_id) as unknown;
  return MessageSchema.parse(message);
}

export interface MessageFilters {
  topic_id?: number;
  source?: string;
  author?: string;
  start_date?: string;
  end_date?: string;
  search_text?: string;
  limit?: number;
  offset?: number;
}

export function searchMessages(db: Database.Database, filters: MessageFilters): Message[] {
  const conditions: string[] = [];
  const parameters: unknown[] = [];

  if (filters.topic_id) {
    conditions.push('topic_id = ?');
    parameters.push(filters.topic_id);
  }

  if (filters.source) {
    conditions.push('source = ?');
    parameters.push(filters.source);
  }

  if (filters.author) {
    conditions.push('author = ?');
    parameters.push(filters.author);
  }

  if (filters.start_date) {
    conditions.push('timestamp >= ?');
    parameters.push(filters.start_date);
  }

  if (filters.end_date) {
    conditions.push('timestamp <= ?');
    parameters.push(filters.end_date);
  }

  const limitClause = filters.limit ? `LIMIT ${filters.limit}` : 'LIMIT 100';
  const offsetClause = filters.offset ? `OFFSET ${filters.offset}` : '';

  if (filters.search_text) {
    // FTS5 path — BM25-ranked, uses Porter stemmer index.
    // Sanitize FTS5 metacharacters to prevent parse errors on raw user input.
    const sanitized = filters.search_text.replace(/["()*:]/g, ' ').trim();

    if (sanitized.length > 0) {
      const ftsWhere = conditions.length > 0
        ? `AND ${conditions.join(' AND ')}`
        : '';

      const ftsQuery = `
        SELECT m.*
        FROM messages_fts
        JOIN messages m ON messages_fts.rowid = m.id
        WHERE messages_fts MATCH ?
        ${ftsWhere}
        ORDER BY bm25(messages_fts)
        ${limitClause} ${offsetClause}
      `;

      try {
        const rows = db.prepare(ftsQuery).all(sanitized, ...parameters) as unknown[];
        const results = z.array(MessageSchema).parse(rows);
        if (results.length > 0) return results;
      } catch {
        // FTS parse error (e.g. very short token) — fall through to LIKE
      }
    }

    // LIKE fallback — only reached if FTS returns nothing or sanitized to empty
    conditions.push('(content LIKE ? OR subject LIKE ?)');
    const likeParam = `%${filters.search_text}%`;
    parameters.push(likeParam, likeParam);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `
    SELECT * FROM messages
    ${whereClause}
    ORDER BY timestamp DESC
    ${limitClause} ${offsetClause}
  `;

  const statement = db.prepare(query);
  const messages = statement.all(...parameters) as unknown[];
  return z.array(MessageSchema).parse(messages);
}

export function getMessagesByTopic(
  db: Database.Database,
  topicId: number,
  dateRange?: { start: string; end: string }
): Message[] {
  const filters: MessageFilters = { topic_id: topicId };
  if (dateRange) {
    filters.start_date = dateRange.start;
    filters.end_date = dateRange.end;
  }
  return searchMessages(db, filters);
}

export function getMessage(db: Database.Database, id: number): Message | null {
  const statement = db.prepare('SELECT * FROM messages WHERE id = ?');
  const message = statement.get(id) as unknown;
  return message ? MessageSchema.parse(message) : null;
}
