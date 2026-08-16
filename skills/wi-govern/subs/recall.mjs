#!/usr/bin/env node
/**
 * wi-recall-tune — sweep the recognition sim-gate and report top-1 / top-5
 * recall against the labeled paraphrase corpus.
 *
 * This is the SCORING axis of AC-U1 (recall ≥70%). It is DISTINCT from the
 * recognition-feedback loop (which tunes skill TRUST via Beta priors, not
 * recall). rankPromptMemory's `simGate` default (0.72) was inherited from a
 * spike and is empirically untuned for nomic-embed-text on this corpus; this
 * script finds the gate that maximizes recall so the number is chosen from
 * data, not folklore.
 *
 * For each candidate simGate it runs every corpus goal through
 * rankPromptMemory(goal, db, simGate) and scores:
 *   - top-1 hit: ranked[0].skill === expected_skill
 *   - top-5 hit: expected_skill appears in ranked[0..4]
 * then reports aggregate recall per gate + the best gate.
 *
 * READ-ONLY: it only reads prompt_memory + the corpus. It changes NO config —
 * it PRINTS the recommended gate. Applying it is a one-line edit to
 * embedder.ts:rankPromptMemory's `simGate` default (or the caller), which a
 * human makes after reviewing the sweep.
 *
 * Requires: dist/ built (uses compiled embedder.js), Ollama reachable
 * (nomic-embed-text — the embedding backend), and a populated prompt_memory.
 *
 * Usage:
 *   node sweep.mjs                          # default gate sweep 0.40..0.80 step 0.05
 *   node sweep.mjs --gates 0.5,0.6,0.7      # explicit gate list
 *   node sweep.mjs --corpus <path.jsonl>    # override corpus
 *
 * Exit: 0 on a completed sweep, 2 on setup error (no Ollama / empty corpus).
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
process.env.DATABASE_PATH = process.env.DATABASE_PATH || `${process.env.HOME}/.work-intelligence-mcp/data.db`;

const args = process.argv.slice(2);
const gatesArg = args.indexOf('--gates');
const corpusArg = args.indexOf('--corpus');
const GATES = gatesArg !== -1
  ? args[gatesArg + 1].split(',').map(Number)
  : [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.72, 0.75, 0.80];
const CORPUS = corpusArg !== -1
  ? args[corpusArg + 1]
  : `${REPO}/.planning/paraphrase-corpus-v1.jsonl`;

const { getDatabase } = await import(`${REPO}/dist/db/connection.js`);
const { rankPromptMemory, checkOllamaAvailable } = await import(`${REPO}/dist/services/embedder.js`);

const db = getDatabase();

// Guard: Ollama must be up or every rankPromptMemory returns null (embed fails).
const ollamaOk = await checkOllamaAvailable().catch(() => false);
if (!ollamaOk) {
  console.error('wi-recall-tune: Ollama not reachable — rankPromptMemory needs nomic-embed-text to embed goals. Start Ollama and retry.');
  process.exit(2);
}

const corpus = fs.readFileSync(CORPUS, 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  .filter((e) => e.goal && e.expected_skill);
if (corpus.length === 0) {
  console.error(`wi-recall-tune: corpus ${CORPUS} has no labeled goals (need goal + expected_skill).`);
  process.exit(2);
}

const pmCount = db.prepare('SELECT COUNT(*) c FROM prompt_memory').get().c;

console.log('═══════════════════════════════════════════════════════════════════');
console.log(`wi-recall-tune — sim-gate sweep`);
console.log(`  corpus: ${corpus.length} labeled goals (${path.basename(CORPUS)})`);
console.log(`  prompt_memory: ${pmCount} rows`);
console.log(`  gates: ${GATES.join(', ')}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

// Cache: rankPromptMemory embeds the goal each call — but the gate only filters
// AFTER embedding, so we can't cheaply cache across gates without refactoring
// the lib. We re-call per (gate, goal); the embed is the cost. Corpus is small.
const rows = []; // { gate, top1, top5 }
for (const gate of GATES) {
  let top1 = 0;
  let top5 = 0;
  const misses = [];
  for (const e of corpus) {
    const ranked = (await rankPromptMemory(e.goal, db, gate)) ?? [];
    const names = ranked.map((r) => r.skill);
    const isTop1 = names[0] === e.expected_skill;
    const isTop5 = names.slice(0, 5).includes(e.expected_skill);
    if (isTop1) top1++;
    if (isTop5) top5++;
    if (!isTop1) misses.push(`${e.id}: want ${e.expected_skill}, got ${names[0] ?? '(none)'}`);
  }
  const n = corpus.length;
  rows.push({ gate, top1, top5, top1Rate: top1 / n, top5Rate: top5 / n, misses });
  console.log(
    `gate ${gate.toFixed(2)}  →  top-1 ${top1}/${n} (${((top1 / n) * 100).toFixed(0)}%)   ` +
    `top-5 ${top5}/${n} (${((top5 / n) * 100).toFixed(0)}%)`,
  );
}

// Best gate = max top-1 recall; tiebreak on top-5, then LOWER gate (more
// paraphrases visible is generally healthier for the corpus-skew problem).
const best = [...rows].sort((a, b) =>
  b.top1Rate - a.top1Rate || b.top5Rate - a.top5Rate || a.gate - b.gate,
)[0];

console.log('\n───────────────────────────────────────────────────────────────────');
console.log(`Best gate: ${best.gate.toFixed(2)} — top-1 ${(best.top1Rate * 100).toFixed(0)}%, top-5 ${(best.top5Rate * 100).toFixed(0)}%`);
console.log(`Current default is 0.72 (embedder.ts:rankPromptMemory). AC-U1 target: top-1 ≥ 70%.`);
if (best.top1Rate < 0.7) {
  console.log(`⚠️  Even the best gate is below the 70% top-1 bar. The gate is not the only lever —`);
  console.log(`    corpus skew + the word-overlap blend + doc_embeddings recall also matter. This`);
  console.log(`    sweep isolates the sim-gate contribution; it does not by itself hit AC-U1.`);
}
if (best.misses.length) {
  console.log(`\nTop-1 misses at the best gate (${best.gate.toFixed(2)}):`);
  for (const m of best.misses) console.log(`  ✗ ${m}`);
}
console.log('\nThis script changes NO config. To apply: edit the simGate default in');
console.log('src/services/embedder.ts (rankPromptMemory) or the caller, then re-run to confirm.');

process.exit(0);
