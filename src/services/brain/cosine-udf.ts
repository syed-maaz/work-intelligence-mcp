/**
 * Phase 79-5b — SQLite UDF for cosine similarity over BLOB embeddings.
 *
 * All embeddings in WI are 768-dim float32 (nomic-embed-text v1), stored as
 * 3072-byte BLOBs. This UDF unpacks two BLOBs into Float32Arrays and returns
 * their cosine similarity. Deterministic, side-effect-free — safe to use in
 * WHERE / ORDER BY / SELECT.
 *
 * Register once at server boot via registerCosineUDF(db).
 */
import type Database from 'better-sqlite3';

export function registerCosineUDF(db: Database.Database): void {
  db.function(
    'cosine_similarity',
    { deterministic: true, safeIntegers: false },
    (blob1: Buffer, blob2: Buffer) => {
      if (!blob1 || !blob2) return null;
      const a = new Float32Array(blob1.buffer, blob1.byteOffset, blob1.byteLength / 4);
      const b = new Float32Array(blob2.buffer, blob2.byteOffset, blob2.byteLength / 4);
      if (a.length !== b.length) return null;
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      const denom = Math.sqrt(na) * Math.sqrt(nb);
      return denom === 0 ? 0 : dot / denom;
    },
  );
}

export function float32ArrayToBlob(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
