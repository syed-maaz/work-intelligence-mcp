import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  Question,
  QuestionSchema,
} from '../schema.js';

export const InsertQuestionSchema = z.object({
  topic_id: z.number(),
  question: z.string(),
  status: z.string().default('open'),
  answer: z.string().nullable().optional(),
  asked_date: z.string().optional(),
  answered_date: z.string().nullable().optional(),
});

export type InsertQuestion = z.infer<typeof InsertQuestionSchema>;

export function insertQuestion(db: Database.Database, data: InsertQuestion): Question {
  const validated = InsertQuestionSchema.parse(data);
  const statement = db.prepare(`
    INSERT INTO questions (topic_id, question, status, answer, asked_date, answered_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const result = statement.run(
    validated.topic_id,
    validated.question,
    validated.status,
    validated.answer || null,
    validated.asked_date || new Date().toISOString(),
    validated.answered_date || null
  );

  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(result.lastInsertRowid) as unknown;
  return QuestionSchema.parse(question);
}

export interface QuestionUpdate {
  status?: string;
  answer?: string | null;
  answered_date?: string | null;
}

export function updateQuestion(
  db: Database.Database,
  id: number,
  updates: QuestionUpdate
): Question | null {
  const fields: string[] = [];
  const parameters: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    parameters.push(updates.status);
  }

  if (updates.answer !== undefined) {
    fields.push('answer = ?');
    parameters.push(updates.answer);
  }

  if (updates.answered_date !== undefined) {
    fields.push('answered_date = ?');
    parameters.push(updates.answered_date);
  }

  if (fields.length === 0) {
    return getQuestion(db, id);
  }

  parameters.push(id);
  const query = `UPDATE questions SET ${fields.join(', ')} WHERE id = ?`;
  const statement = db.prepare(query);
  statement.run(...parameters);

  return getQuestion(db, id);
}

export function getQuestion(db: Database.Database, id: number): Question | null {
  const statement = db.prepare('SELECT * FROM questions WHERE id = ?');
  const question = statement.get(id) as unknown;
  return question ? QuestionSchema.parse(question) : null;
}

export interface QuestionFilters {
  topic_id?: number;
  status?: string;
}

export function getQuestions(db: Database.Database, filters?: QuestionFilters): Question[] {
  const conditions: string[] = [];
  const parameters: unknown[] = [];

  if (filters?.topic_id) {
    conditions.push('topic_id = ?');
    parameters.push(filters.topic_id);
  }

  if (filters?.status) {
    conditions.push('status = ?');
    parameters.push(filters.status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `SELECT * FROM questions ${whereClause} ORDER BY asked_date DESC`;

  const statement = db.prepare(query);
  const questions = statement.all(...parameters) as unknown[];
  return z.array(QuestionSchema).parse(questions);
}

export function deleteQuestion(db: Database.Database, id: number): boolean {
  const statement = db.prepare('DELETE FROM questions WHERE id = ?');
  const result = statement.run(id);
  return result.changes > 0;
}
