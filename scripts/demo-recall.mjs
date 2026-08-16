#!/usr/bin/env node
/**
 * STEP 13 (OSS release) — make the 9-lane recall demonstrable on the demo DB
 * (seeded by STEP 12's `npm run demo`):
 *
 *   node scripts/demo-recall.mjs
 *
 * Runs ONE recall query (recallMemory — the RRF merge in rrf-merge.ts, imported
 * at recall.ts:37, fusing 9 lanes: palace / decision / cluster / verification /
 * observation / obsidian / message_cosine / prompt_memory_cosine / doc_cosine)
 * and prints one line per fused lane, each line containing the literal word
 * `lane`.
 *
 * MemPalace check: `palace` is hard-wired to null — recall never queries the
 * real MemPalace from fake demo data, so a palace lane can never leak in.
 * With the palace env unset the output must contain a sqlite lane and no
 * palace lane (asserted by the STEP 13 DoD).
 *
 * Embedding note: the seed (seed-demo.mjs) inserts messages only; the
 * message_cosine lane needs message_embeddings rows. EmbeddingService
 * .indexMessages() is Ollama-gated (checkEnabled → checkOllamaAvailable), so
 * in stub mode we embed directly via embed() (embedder.ts:58 — WI_EMBED_STUB=1
 * hash vectors, zero connectors) with the same upsert the service uses.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

process.env.WI_EMBED_STUB ??= '1';

// The DoD invokes this as plain `node scripts/demo-recall.mjs`, but the src
// tree is TypeScript — re-exec ourselves under the tsx loader when the caller
// didn't pass it (same loader as `npm run demo` / `npm run demo:trace`).
if (!process.execArgv.some((a) => a.includes('tsx'))) {
  const res = spawnSync(process.execPath, ['--import', 'tsx/esm', process.argv[1]], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(res.status ?? 1);
}

const { getDatabase } = await import('../src/db/connection.js');
const { registerCosineUDF, float32ArrayToBlob } = await import('../src/services/brain/cosine-udf.js');
const { recallMemory } = await import('../src/services/brain/recall.js');
const { embed } = await import('../src/services/embedder.js');

const DB_PATH = process.env.DATABASE_PATH || './data/demo.db';
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
    db.close();
    process.exit(1);
  }

  const results = await recallMemory({
    db,
    pattern: PATTERN,
    limit: 10,
    palace: null,
    queryBlob: float32ArrayToBlob(queryVec),
  });

  console.log(`[demo-recall] query="${PATTERN}" on ${DB_PATH} — ${results.length} fused lane result(s) (embedded ${indexed} demo message(s))`);
  for (const r of results) {
    console.log(`lane=${r.source} id=${r.id} score=${r.score.toFixed(4)} snippet=${r.snippet.slice(0, 140)}`);
  }
  db.close();
  return results;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runDemoRecall().catch((e) => {
    console.error(`[demo-recall] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}