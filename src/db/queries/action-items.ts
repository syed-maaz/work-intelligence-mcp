import Database from 'better-sqlite3';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  ActionItem,
  ActionItemSchema,
} from '../schema.js';

export const InsertActionItemSchema = z.object({
  topic_id: z.number(),
  title: z.string(),
  description: z.string().nullable().optional(),
  assignee: z.string().nullable().optional(),
  status: z.string().default('pending'),
  due_date: z.string().nullable().optional(),
  source_message_id: z.number().nullable().optional(),
});

export type InsertActionItem = z.infer<typeof InsertActionItemSchema>;

export function insertActionItem(db: Database.Database, data: InsertActionItem): ActionItem {
  const validated = InsertActionItemSchema.parse(data);
  // content_hash deduplicates action items across sync cycles.
  // Two items with the same topic + title are considered the same task.
  const contentHash = createHash('sha256')
    .update(`${validated.topic_id}|${validated.title}`)
    .digest('hex');

  // INSERT OR IGNORE — silently skip if this (topic, title) already exists.
  db.prepare(`
    INSERT OR IGNORE INTO action_items
      (topic_id, title, description, assignee, status, due_date, source_message_id, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    validated.topic_id,
    validated.title,
    validated.description || null,
    validated.assignee || null,
    validated.status,
    validated.due_date || null,
    validated.source_message_id || null,
    contentHash,
  );

  const actionItem = db
    .prepare('SELECT * FROM action_items WHERE content_hash = ?')
    .get(contentHash) as unknown;
  return ActionItemSchema.parse(actionItem);
}

export interface ActionItemUpdate {
  title?: string;
  description?: string | null;
  assignee?: string | null;
  status?: string;
  due_date?: string | null;
}

export function updateActionItem(
  db: Database.Database,
  id: number,
  updates: ActionItemUpdate
): ActionItem | null {
  const fields: string[] = [];
  const parameters: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    parameters.push(updates.title);
  }

  if (updates.description !== undefined) {
    fields.push('description = ?');
    parameters.push(updates.description);
  }

  if (updates.assignee !== undefined) {
    fields.push('assignee = ?');
    parameters.push(updates.assignee);
  }

  if (updates.status !== undefined) {
    fields.push('status = ?');
    parameters.push(updates.status);
  }

  if (updates.due_date !== undefined) {
    fields.push('due_date = ?');
    parameters.push(updates.due_date);
  }

  if (fields.length === 0) {
    return getActionItem(db, id);
  }

  parameters.push(id);
  const query = `UPDATE action_items SET ${fields.join(', ')} WHERE id = ?`;
  const statement = db.prepare(query);
  statement.run(...parameters);

  return getActionItem(db, id);
}

export interface ActionItemFilters {
  topic_id?: number;
  status?: string;
  assignee?: string;
  due_date_before?: string;
  due_date_after?: string;
}

export function getActionItems(db: Database.Database, filters?: ActionItemFilters): ActionItem[] {
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

  if (filters?.assignee) {
    conditions.push('assignee = ?');
    parameters.push(filters.assignee);
  }

  if (filters?.due_date_before) {
    conditions.push('due_date <= ?');
    parameters.push(filters.due_date_before);
  }

  if (filters?.due_date_after) {
    conditions.push('due_date >= ?');
    parameters.push(filters.due_date_after);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `SELECT * FROM action_items ${whereClause} ORDER BY due_date ASC`;

  const statement = db.prepare(query);
  const actionItems = statement.all(...parameters) as unknown[];
  return z.array(ActionItemSchema).parse(actionItems);
}

export function getActionItem(db: Database.Database, id: number): ActionItem | null {
  const statement = db.prepare('SELECT * FROM action_items WHERE id = ?');
  const actionItem = statement.get(id) as unknown;
  return actionItem ? ActionItemSchema.parse(actionItem) : null;
}

export function deleteActionItem(db: Database.Database, id: number): boolean {
  const statement = db.prepare('DELETE FROM action_items WHERE id = ?');
  const result = statement.run(id);
  return result.changes > 0;
}

// ── EP-35: Action item confidence triage ─────────────────────────────────

export function getPendingReviewItems(db: Database.Database, topicId?: number): ActionItem[] {
  const rows = topicId
    ? db.prepare(`SELECT * FROM action_items WHERE status = 'pending_review' AND topic_id = ? ORDER BY id DESC LIMIT 50`).all(topicId)
    : db.prepare(`SELECT * FROM action_items WHERE status = 'pending_review' ORDER BY id DESC LIMIT 50`).all();
  return rows as ActionItem[];
}

export function confirmActionItem(db: Database.Database, id: number): void {
  db.prepare(`
    UPDATE action_items SET confirmed = 1, confirmed_at = datetime('now'), status = 'open' WHERE id = ?
  `).run(id);
}

export function dismissActionItem(db: Database.Database, id: number): void {
  db.prepare(`UPDATE action_items SET status = 'dismissed' WHERE id = ?`).run(id);
}

/** Promote pending_review items older than olderThanHours to 'open'. Returns count promoted. */
export function autoPromotePendingItems(db: Database.Database, olderThanHours: number): number {
  const result = db.prepare(`
    UPDATE action_items
    SET status = 'open'
    WHERE status = 'pending_review'
      AND confirmed_at < datetime('now', '-' || ? || ' hours')
  `).run(olderThanHours);
  return result.changes;
}
