import type Database from 'better-sqlite3';

export interface WebCacheRow {
  id: number;
  url: string;
  content: string;
  source_type: string;
  fetched_at: string;
  expires_at: string;
}

const TTL_BY_TYPE: Record<string, number> = {
  jira: 3600,
  github: 1800,
  confluence: 7200,
  docs: 86400,
  generic: 3600,
};

export function getTtlForUrl(type: string): number {
  return TTL_BY_TYPE[type] || 3600;
}

export function getCachedContent(db: Database.Database, url: string): WebCacheRow | null {
  return (db.prepare(
    `SELECT * FROM web_cache WHERE url = ? AND expires_at > datetime('now')`
  ).get(url) as WebCacheRow | undefined) ?? null;
}

export function upsertWebCache(db: Database.Database, url: string, content: string, sourceType: string): void {
  const ttl = getTtlForUrl(sourceType);
  db.prepare(`
    INSERT INTO web_cache (url, content, source_type, fetched_at, expires_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now', '+${ttl} seconds'))
    ON CONFLICT(url) DO UPDATE SET
      content = excluded.content,
      source_type = excluded.source_type,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at
  `).run(url, content, sourceType);
}

export function pruneExpiredCache(db: Database.Database): number {
  const result = db.prepare(`DELETE FROM web_cache WHERE expires_at < datetime('now')`).run();
  return result.changes;
}
