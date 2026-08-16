import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  Decision,
  DecisionSchema,
} from '../schema.js';

export const InsertDecisionSchema = z.object({
  topic_id: z.number(),
  meeting_id: z.number().nullable().optional(),
  decision: z.string(),
  context: z.string().nullable().optional(),
  date: z.string().optional(),
});

export type InsertDecision = z.infer<typeof InsertDecisionSchema>;

export function insertDecision(db: Database.Database, data: InsertDecision): Decision {
  const validated = InsertDecisionSchema.parse(data);
  const statement = db.prepare(`
    INSERT INTO decisions (topic_id, meeting_id, decision, context, date)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = statement.run(
    validated.topic_id,
    validated.meeting_id || null,
    validated.decision,
    validated.context || null,
    validated.date || new Date().toISOString()
  );

  const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(result.lastInsertRowid) as unknown;
  return DecisionSchema.parse(decision);
}

export function getDecision(db: Database.Database, id: number): Decision | null {
  const statement = db.prepare('SELECT * FROM decisions WHERE id = ?');
  const decision = statement.get(id) as unknown;
  return decision ? DecisionSchema.parse(decision) : null;
}

export function getDecisionsByTopic(db: Database.Database, topicId: number): Decision[] {
  const statement = db.prepare('SELECT * FROM decisions WHERE topic_id = ? ORDER BY date DESC');
  const decisions = statement.all(topicId) as unknown[];
  return z.array(DecisionSchema).parse(decisions);
}

export function getDecisionsByMeeting(db: Database.Database, meetingId: number): Decision[] {
  const statement = db.prepare('SELECT * FROM decisions WHERE meeting_id = ? ORDER BY date DESC');
  const decisions = statement.all(meetingId) as unknown[];
  return z.array(DecisionSchema).parse(decisions);
}

export function deleteDecision(db: Database.Database, id: number): boolean {
  const statement = db.prepare('DELETE FROM decisions WHERE id = ?');
  const result = statement.run(id);
  return result.changes > 0;
}
