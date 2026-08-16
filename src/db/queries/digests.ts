import Database from 'better-sqlite3';

export interface DigestRecord {
  id: number;
  topic_name: string;
  date: string;
  markdown: string;
  generated_at: string;
  expires_at: string;
}

export function saveDigest(
  db: Database.Database,
  topicName: string,
  date: string,
  markdown: string,
  expiresAt: string
): void {
  db.prepare(`
    INSERT INTO digests (topic_name, date, markdown, generated_at, expires_at)
    VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(topic_name, date) DO UPDATE SET
      markdown = excluded.markdown,
      generated_at = excluded.generated_at,
      expires_at = excluded.expires_at
  `).run(topicName, date, markdown, expiresAt);
}

export function getCachedDigest(
  db: Database.Database,
  topicName: string,
  date: string
): DigestRecord | null {
  const row = db.prepare(
    `SELECT * FROM digests WHERE topic_name = ? AND date = ? AND expires_at > datetime('now')`
  ).get(topicName, date) as DigestRecord | undefined;
  return row ?? null;
}

export function listDigests(db: Database.Database, limit = 20): DigestRecord[] {
  return db.prepare(
    'SELECT * FROM digests ORDER BY generated_at DESC LIMIT ?'
  ).all(limit) as DigestRecord[];
}

export function deleteDigest(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM digests WHERE id = ?').run(id);
}
