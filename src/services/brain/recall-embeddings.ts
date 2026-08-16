/**
 * Phase 79-5b — cosine-based recall helpers over the three embedding tables.
 *
 * Each helper fetches top-N rows ordered by cosine_similarity() (the SQLite
 * UDF registered at boot via registerCosineUDF). All return CosineHit[] and
 * are non-throwing — any error (table missing, UDF not registered, zero rows)
 * returns [].
 *
 * Called from recallMemory() when a pre-computed queryBlob is available.
 * The UDF must be registered on the same db connection before calling these.
 */
import type Database from 'better-sqlite3';

export interface CosineHit {
  id: string;
  snippet: string;
  score: number;
  source: string;
  created_at: string | number;
}

export function queryMessageCosine(
  db: Database.Database,
  queryBlob: Buffer,
  limit: number,
): CosineHit[] {
  try {
    return (
      db
        .prepare(
          `SELECT
            me.message_id AS id,
            m.content AS snippet,
            m.timestamp AS created_at,
            cosine_similarity(me.embedding, ?) AS score
          FROM message_embeddings me
          JOIN messages m ON me.message_id = m.id
          ORDER BY score DESC
          LIMIT ?`,
        )
        .all(queryBlob, limit) as Array<{
        id: number;
        snippet: string;
        created_at: number | string;
        score: number;
      }>
    ).map((r) => ({
      id: String(r.id),
      snippet: (r.snippet ?? '').slice(0, 240),
      score: r.score ?? 0,
      source: 'message_cosine',
      created_at: r.created_at,
    }));
  } catch {
    return [];
  }
}

export function queryPromptMemoryCosine(
  db: Database.Database,
  queryBlob: Buffer,
  limit: number,
): CosineHit[] {
  try {
    return (
      db
        .prepare(
          `SELECT
            session_id AS id,
            goal || ' → ' || chosen_skill || ' (' || outcome || ')' AS snippet,
            cosine_similarity(embedding, ?) AS score,
            embedded_at AS created_at
          FROM prompt_memory
          WHERE outcome IN ('success','completed')
          ORDER BY score DESC
          LIMIT ?`,
        )
        .all(queryBlob, limit) as Array<{
        id: string;
        snippet: string;
        score: number;
        created_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      snippet: (r.snippet ?? '').slice(0, 240),
      score: r.score ?? 0,
      source: 'prompt_memory_cosine',
      created_at: r.created_at,
    }));
  } catch {
    return [];
  }
}

export function queryDocCosine(
  db: Database.Database,
  queryBlob: Buffer,
  limit: number,
): CosineHit[] {
  try {
    return (
      db
        .prepare(
          `SELECT
            path AS id,
            title AS snippet,
            cosine_similarity(embedding, ?) AS score,
            embedded_at AS created_at
          FROM doc_embeddings
          ORDER BY score DESC
          LIMIT ?`,
        )
        .all(queryBlob, limit) as Array<{
        id: string;
        snippet: string;
        score: number;
        created_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      snippet: (r.snippet ?? '').slice(0, 240),
      score: r.score ?? 0,
      source: 'doc_cosine',
      created_at: r.created_at,
    }));
  } catch {
    return [];
  }
}
