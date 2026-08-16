import Database from 'better-sqlite3';

// ── Topic notebooks (LLM memory per topic) — schema v9 ───────────────────────

export interface TopicNotebook {
  id: number;
  topic_name: string;
  content: string;
  user_annotation: string | null;
  user_corrections: string | null;
  last_message_id: number | null;
  last_updated: string;
  message_count: number;
  created_at: string;
  // Option 3 (schema v68): structured form of `content`. Holds NotebookState
  // serialized as JSON. Returned along with `content` so callers can apply
  // a patch_notebook delta without re-parsing the markdown. Nullable for
  // backfill — rows created before v68 have NULL until first read parses
  // the markdown into state (see getOrBuildNotebook in src/tools/notebook.ts).
  state_json: string | null;
}

export function getNotebook(db: Database.Database, topicName: string): TopicNotebook | null {
  return db.prepare(
    `SELECT * FROM topic_notebooks WHERE topic_name = ?`
  ).get(topicName) as TopicNotebook | null;
}

export function saveNotebook(
  db: Database.Database,
  topicName: string,
  content: string,
  lastMessageId: number,
  messageCount: number,
  stateJson: string | null = null
): void {
  // Option 3 (schema v68): when stateJson is supplied, persist it alongside
  // the rendered markdown so the next call can patch instead of rebuild.
  // When stateJson is null (legacy callers or cold-rebuild paths) we leave
  // the column at NULL — the next read will backfill via parseMarkdownToState.
  db.prepare(`
    INSERT INTO topic_notebooks (topic_name, content, last_message_id, message_count, last_updated, state_json)
    VALUES (?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(topic_name) DO UPDATE SET
      content = excluded.content,
      last_message_id = excluded.last_message_id,
      message_count = excluded.message_count,
      last_updated = datetime('now'),
      state_json = COALESCE(excluded.state_json, topic_notebooks.state_json)
  `).run(topicName, content, lastMessageId, messageCount, stateJson);
}

export function listNotebooks(db: Database.Database): TopicNotebook[] {
  return db.prepare(
    `SELECT * FROM topic_notebooks ORDER BY last_updated DESC`
  ).all() as TopicNotebook[];
}

export function deleteNotebook(db: Database.Database, topicName: string): void {
  db.prepare(`DELETE FROM topic_notebooks WHERE topic_name = ?`).run(topicName);
}

export function saveAnnotation(db: Database.Database, topicName: string, annotation: string): void {
  db.prepare(`
    UPDATE topic_notebooks SET user_annotation = ? WHERE topic_name = ?
  `).run(annotation, topicName);
}

export function getAnnotation(db: Database.Database, topicName: string): string | null {
  const row = db.prepare(`SELECT user_annotation FROM topic_notebooks WHERE topic_name = ?`).get(topicName) as { user_annotation: string | null } | undefined;
  return row?.user_annotation ?? null;
}

export function getCorrections(db: Database.Database, topicName: string): string[] {
  const row = db.prepare(`SELECT user_corrections FROM topic_notebooks WHERE topic_name = ?`).get(topicName) as { user_corrections: string | null } | undefined;
  try {
    return JSON.parse(row?.user_corrections ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function appendCorrection(db: Database.Database, topicName: string, correction: string): void {
  const current = getCorrections(db, topicName);
  current.push(correction);
  db.prepare(`UPDATE topic_notebooks SET user_corrections = ? WHERE topic_name = ?`).run(JSON.stringify(current), topicName);
}

// ── Notebook Chat History ─────────────────────────────────────────────────────

export interface NotebookChatEntry {
  id: number;
  topic_name: string;
  question: string;
  answer: string;
  asked_at: string;
}

export function saveNotebookChatEntry(
  db: Database.Database,
  topicName: string,
  question: string,
  answer: string
): void {
  db.prepare(
    `INSERT INTO notebook_chat_history (topic_name, question, answer) VALUES (?, ?, ?)`
  ).run(topicName, question, answer);
}

export function getNotebookChatHistory(
  db: Database.Database,
  topicName: string,
  limit = 10
): NotebookChatEntry[] {
  return db.prepare(
    `SELECT * FROM notebook_chat_history WHERE topic_name = ? ORDER BY asked_at DESC LIMIT ?`
  ).all(topicName, limit) as NotebookChatEntry[];
}
