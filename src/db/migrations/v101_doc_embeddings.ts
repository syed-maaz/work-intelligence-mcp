/**
 * v101 — doc_embeddings (ADR-042 "Gap 2" / recognition-corpus keystone, 2026-07-16).
 *
 * # Why
 *
 * Cypher Stage-1 recognition (src/services/cypher/stage1.ts) fans out cosine
 * lookups over `prompt_memory` (past goals) and `message_embeddings`
 * (Jira/Teams/Email/GitHub). ADRs, architecture docs, and epics are NOT
 * embedded anywhere — so a goal like "/wi audit ADR-044" cannot be recognized
 * or enriched against the ADR that describes it. ADR-042 names this gap
 * ("doc_embeddings ... NOT BUILT yet") and defers it. This migration builds
 * the store; embedDocs() (embedder.ts) fills it at boot; a Stage-1 Branch-D
 * reads it.
 *
 * # Shape — keyed by path, not a source-table FK
 *
 * Unlike message_embeddings (REFERENCES messages(id)) and prompt_memory
 * (REFERENCES cypher_sessions(session_id)), docs are FILES on disk with no
 * source row to reference. The natural key is the repo-relative `path`.
 * `content_hash` (sha256 of the file text) lets the boot backfill re-embed
 * ONLY changed files — an unchanged file whose hash matches is skipped, so
 * repeated boots cost ~0 Ollama calls.
 *
 * # Storage — same BLOB pattern as message_embeddings / prompt_memory
 *
 * `embedding` is the raw bytes of a 768-dim Float32Array (768 × 4 = 3072
 * bytes), written via float32ToBuffer() and read via bufferToFloat32() in
 * embedder.ts. `model` labels the embedder for future re-embed detection.
 *
 * # Idempotency
 *
 * `CREATE TABLE IF NOT EXISTS` — re-running is a no-op. No embedding work
 * happens here (that's Ollama-gated boot work in embedDocs); this migration
 * is pure synchronous DDL, matching v98_prompt_memory.ts.
 *
 * See:
 *   - src/services/embedder.ts (embedDocs + searchDocs)
 *   - src/services/cypher/stage1.ts (Branch-D consumer)
 *   - src/db/migrations/v98_prompt_memory.ts (the pattern this copies)
 *   - docs/docs/adr/adr-042-prompt-generation-stage.md (Gap 2)
 */

import type Database from 'better-sqlite3';

export default function migrateV101(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_embeddings (
      path         TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      doc_kind     TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding    BLOB NOT NULL,
      model        TEXT NOT NULL DEFAULT 'nomic-embed-text',
      embedded_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
