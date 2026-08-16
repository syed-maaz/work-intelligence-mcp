/**
 * v48 — Relabel embeddings to the actual model that produced them.
 *
 * Background: v22 created `message_embeddings` with `DEFAULT 'text-embedding-3-small'`,
 * but the bridge has been calling Ollama's `nomic-embed-text` (768-dim float32) since
 * EP-37. The bytes on disk are nomic; the label was just wrong. This migration fixes
 * the metadata so future audits aren't misled, and flips the column DEFAULT for new
 * inserts. The BLOB payload is untouched.
 *
 * Idempotent: running twice is a no-op (the second UPDATE matches zero rows).
 */
import type Database from 'better-sqlite3';

export default function migrateV48(db: Database.Database): void {
  db.transaction(() => {
    // Step 1: relabel existing rows. Bytes are 768-dim nomic-embed-text vectors.
    db.exec(`UPDATE message_embeddings SET model = 'nomic-embed-text' WHERE model = 'text-embedding-3-small'`);

    // Step 2: flip the column DEFAULT so new rows inserted without an explicit
    // model value will be labelled correctly. SQLite cannot ALTER a column's
    // default in place, so we rebuild the table. This preserves all data.
    //
    // NOTE: only changes new INSERTs that omit `model`; existing rows are
    // already corrected by Step 1.
    db.exec(`
      CREATE TABLE message_embeddings_new (
        message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL DEFAULT 'nomic-embed-text',
        embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO message_embeddings_new (message_id, embedding, model, embedded_at)
        SELECT message_id, embedding, model, embedded_at FROM message_embeddings;
      DROP TABLE message_embeddings;
      ALTER TABLE message_embeddings_new RENAME TO message_embeddings;
    `);
  })();
}
