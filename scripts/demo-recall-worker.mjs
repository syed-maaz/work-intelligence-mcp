
const { getDatabase } = await import('../src/db/connection.js');
const { registerCosineUDF, float32ArrayToBlob } = await import('../src/services/brain/cosine-udf.js');
const { recallMemory } = await import('../src/services/brain/recall.js');
const { embed } = await import('../src/services/embedder.js');

const DB_PATH = process.env.DATABASE_PATH;
const PATTERN = process.env.DEMO_RECALL_QUERY ?? 'acme/widgets rollout';

export async function runDemoRecall() {
  const db = getDatabase({ path: DB_PATH });
  registerCosineUDF(db);

  const unembedded = db
    .prepare(
      `SELECT m.id, m.content, m.subject FROM messages m
       LEFT JOIN message_embeddings me ON me.message_id = m.id
       WHERE me.message_id IS NULL`,
    )
    .all();

  const upsert = db.prepare(
    `INSERT INTO message_embeddings (message_id, embedding, embedded_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(message_id) DO UPDATE SET embedding = excluded.embedding, embedded_at = excluded.embedded_at`,
  );

  let indexed = 0;
  for (const m of unembedded) {
    const vec = await embed([m.subject, m.content].filter(Boolean).join(' '));
    if (vec) {
      upsert.run(m.id, float32ArrayToBlob(vec));
      indexed++;
    }
  }

  const queryVec = await embed(PATTERN);
  if (!queryVec) {
    console.error('[demo-recall] embed() returned null — set WI_EMBED_STUB=1 for the zero-connector demo.');

    process.exit(1);
  }

  const results = await recallMemory({
    db,
    pattern: PATTERN,
    limit: 10,
    palace: null,
    queryBlob: float32ArrayToBlob(queryVec),
  });

  console.log(`[demo-recall] query="${PATTERN}" on isolated fictional demo database — ${results.length} fused lane result(s) (embedded ${indexed} demo message(s))`);
  for (const r of results) {
    console.log(`lane=${r.source} id=${r.id} score=${r.score.toFixed(4)} snippet=${r.snippet.slice(0, 140)}`);
  }

  return results;
}
