import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  Topic,
  TopicSchema,
} from '../schema.js';

// Input schemas
export const InsertTopicSchema = z.object({
  name: z.string(),
  config: z.string().nullable().optional(),
});

export type InsertTopic = z.infer<typeof InsertTopicSchema>;

export function createTopic(db: Database.Database, data: InsertTopic): Topic {
  const validated = InsertTopicSchema.parse(data);
  const statement = db.prepare(`
    INSERT INTO topics (name, config)
    VALUES (?, ?)
  `);

  const result = statement.run(validated.name, validated.config || null);
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(result.lastInsertRowid) as unknown;
  return TopicSchema.parse(topic);
}

export function getTopic(db: Database.Database, id: number): Topic | null {
  const statement = db.prepare('SELECT * FROM topics WHERE id = ?');
  const topic = statement.get(id) as unknown;
  return topic ? TopicSchema.parse(topic) : null;
}

export function getTopicByName(db: Database.Database, name: string): Topic | null {
  const statement = db.prepare('SELECT * FROM topics WHERE name = ?');
  const topic = statement.get(name) as unknown;
  return topic ? TopicSchema.parse(topic) : null;
}

export function listTopics(db: Database.Database): Topic[] {
  const statement = db.prepare('SELECT * FROM topics ORDER BY created_at DESC');
  const topics = statement.all() as unknown[];
  return z.array(TopicSchema).parse(topics);
}

export function deleteTopic(db: Database.Database, id: number): boolean {
  const statement = db.prepare('DELETE FROM topics WHERE id = ?');
  const result = statement.run(id);
  return result.changes > 0;
}

// ── EP-41: Topic Health Score ─────────────────────────────────

export interface TopicHealth {
  topic_name: string;
  health_score: number;
  recency_score: number;
  activity_ratio: number;
  completion_rate: number;
  transcript_coverage: number;
  color: 'green' | 'yellow' | 'red';
}

export function getTopicHealthScores(db: Database.Database): TopicHealth[] {
  const rows = db.prepare(`
    WITH topic_stats AS (
      SELECT
        t.name AS topic_name,
        COALESCE(MAX(0.0, 1.0 - (julianday('now') - julianday(MAX(m.timestamp))) / 30.0), 0.0) AS recency_score,
        CAST(COUNT(CASE WHEN m.timestamp >= date('now', '-7 days') THEN 1 END) AS REAL) /
          MAX(1, COUNT(CASE WHEN m.timestamp >= date('now', '-30 days') THEN 1 END)) AS activity_ratio,
        CAST(COUNT(CASE WHEN ai.status = 'done' THEN 1 END) AS REAL) /
          MAX(1, COUNT(ai.id)) AS completion_rate,
        CAST(COUNT(CASE WHEN length(COALESCE(mt.transcript, '')) > 100 THEN 1 END) AS REAL) /
          MAX(1, COUNT(mt.id)) AS transcript_coverage
      FROM topics t
      LEFT JOIN messages m ON m.topic_id = t.id
      LEFT JOIN action_items ai ON ai.topic_id = t.id
      LEFT JOIN meetings mt ON mt.topic_id = t.id
      GROUP BY t.id, t.name
    )
    SELECT
      topic_name,
      (recency_score + activity_ratio + completion_rate + transcript_coverage) / 4.0 AS health_score,
      recency_score,
      activity_ratio,
      completion_rate,
      transcript_coverage
    FROM topic_stats
    ORDER BY health_score ASC
  `).all() as Array<Omit<TopicHealth, 'color'>>;

  return rows.map(row => ({
    ...row,
    color: row.health_score >= 0.7 ? 'green' : row.health_score >= 0.4 ? 'yellow' : 'red',
  }));
}
