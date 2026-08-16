import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  Meeting,
  MeetingSchema,
} from '../schema.js';

export const InsertMeetingSchema = z.object({
  topic_id: z.number(),
  title: z.string(),
  date: z.string(),
  attendees: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  decisions: z.string().nullable().optional(),
  // v3 columns — required to store Teams Recap data
  transcript: z.string().nullable().optional(),
  topics: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  chat_name: z.string().nullable().optional(),
  source_id: z.string().nullable().optional(),
});

export type InsertMeeting = z.infer<typeof InsertMeetingSchema>;

export function insertMeeting(db: Database.Database, data: InsertMeeting): Meeting {
  const validated = InsertMeetingSchema.parse(data);
  const statement = db.prepare(`
    INSERT INTO meetings
      (topic_id, title, date, attendees, notes, decisions,
       transcript, topics, summary, chat_name, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = statement.run(
    validated.topic_id,
    validated.title,
    validated.date,
    validated.attendees || null,
    validated.notes || null,
    validated.decisions || null,
    validated.transcript || null,
    validated.topics || null,
    validated.summary || null,
    validated.chat_name || null,
    validated.source_id || null,
  );

  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(result.lastInsertRowid) as unknown;
  return MeetingSchema.parse(meeting);
}

export function getMeeting(db: Database.Database, id: number): Meeting | null {
  const statement = db.prepare('SELECT * FROM meetings WHERE id = ?');
  const meeting = statement.get(id) as unknown;
  return meeting ? MeetingSchema.parse(meeting) : null;
}

export function getMeetingsByTopic(db: Database.Database, topicId: number): Meeting[] {
  const statement = db.prepare('SELECT * FROM meetings WHERE topic_id = ? ORDER BY date DESC');
  const meetings = statement.all(topicId) as unknown[];
  return z.array(MeetingSchema).parse(meetings);
}

export function deleteMeeting(db: Database.Database, id: number): boolean {
  const statement = db.prepare('DELETE FROM meetings WHERE id = ?');
  const result = statement.run(id);
  return result.changes > 0;
}
