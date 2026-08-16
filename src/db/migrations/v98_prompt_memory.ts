import type Database from 'better-sqlite3';

/**
 * v97→v98: prompt_memory — learned prompt→skill recognition store.
 *
 * Backs the recognition-based skill routing in getCatalogHint (SCOPE refiner).
 * Each row is a past Cypher dispatch's goal, embedded (768-dim nomic-embed-text),
 * tagged with the skill that ran and its outcome. A new goal is matched by
 * cosine to the region of past goals; skills that SUCCEEDED there are surfaced,
 * outcome-weighted (success 1.0 / mixed 0.5 / failed 0.0). Backfilled from the
 * ~850 existing (goal, chosen_skill, outcome) triples in cypher_sessions.
 *
 * Mirrors the message_embeddings BLOB pattern (schema.ts): embedding stored as
 * a Float32 BLOB, model label for re-embed detection. session_id PK + FK CASCADE
 * so a purged session reaps its memory row. Population is best-effort and
 * Ollama-gated (embedPromptMemory in embedder.ts) — the table simply stays empty
 * when Ollama is down, and getCatalogHint falls back to description word-overlap.
 */
export default function migrateV98(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_memory (
      session_id   TEXT PRIMARY KEY REFERENCES cypher_sessions(session_id) ON DELETE CASCADE,
      goal         TEXT NOT NULL,
      chosen_skill TEXT NOT NULL,
      outcome      TEXT NOT NULL,
      embedding    BLOB NOT NULL,
      model        TEXT NOT NULL DEFAULT 'nomic-embed-text',
      embedded_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
