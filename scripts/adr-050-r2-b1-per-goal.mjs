#!/usr/bin/env node
/**
 * ADR-050 R2-B.1 consumer-path diagnostic — per-goal failure breakdown.
 *
 * Runs stage1Fetch() over the v2 paraphrase corpus with CURRENT production
 * defaults (no knob sweep), then dumps every goal's expected vs top-1 vs
 * top-5 — so we can see WHICH goals fail and HOW (embedder returns
 * something plausible? unrelated? close-but-not-top-1?). This is the
 * evidence we need to pick between weighted-boost / first-pass-filter /
 * rerank.
 *
 * Reads live ~/.work-intelligence-mcp/data.db (read-only) via the same code
 * path stage1-recall-sweep.mjs uses, so the numbers are directly comparable.
 *
 * Output: pretty table on stdout + one-line TSV per goal on stderr for grep.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.dirname(new URL(import.meta.url).pathname).replace(/\/scripts$/, '');
process.env.DATABASE_PATH = process.env.DATABASE_PATH || `${process.env.HOME}/.work-intelligence-mcp/data.db`;

const { getDatabase } = await import(`${REPO}/dist/db/connection.js`);
const {
  stage1Fetch,
  RECALL_SIM_GATE_DEFAULT,
  RECALL_BLEND_SEMANTIC_DEFAULT,
  RECALL_ANTI_DOM_TOPK_DEFAULT,
} = await import(`${REPO}/dist/services/cypher/stage1.js`);

const CORPUS = process.argv.find((a) => a.startsWith('--corpus='))?.split('=')[1] ?? 'paraphrase-corpus-v2.jsonl';
const corpus = fs.readFileSync(`${REPO}/.planning/${CORPUS}`, 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  .filter((r) => r.expected_skill); // drop the metadata header row

const db = getDatabase();

console.log('═══════════════════════════════════════════════════════════════════');
console.log(`ADR-050 R2-B.1 per-goal diagnostic — corpus=${CORPUS} (${corpus.length} goals)`);
console.log(`Baseline defaults: simGate=${RECALL_SIM_GATE_DEFAULT}, blend=${RECALL_BLEND_SEMANTIC_DEFAULT}, K=${RECALL_ANTI_DOM_TOPK_DEFAULT}`);
console.log('═══════════════════════════════════════════════════════════════════\n');

let top1 = 0, top5 = 0;
for (const e of corpus) {
  const ev = await stage1Fetch(e.goal, db, {
    simGate: RECALL_SIM_GATE_DEFAULT,
    blendSemantic: RECALL_BLEND_SEMANTIC_DEFAULT,
    antiDomTopK: RECALL_ANTI_DOM_TOPK_DEFAULT,
  });
  const pmSkills  = ev.prompt_memory_hits.map((h) => ({ skill: h.id, score: h.score, src: 'pm' }));
  const catSkills = ev.catalog_candidates.map((h) => ({ skill: h.id, score: h.score, src: 'cat' }));
  const merged = [...pmSkills, ...catSkills].sort((a, b) => b.score - a.score);
  const top5arr = merged.slice(0, 5);
  const acceptSet = new Set(Array.isArray(e.accept) && e.accept.length ? e.accept : [e.expected_skill]);
  const t1Skill = merged[0]?.skill ?? '(none)';
  const t1Hit = acceptSet.has(t1Skill);
  const t5Hit = top5arr.some((s) => acceptSet.has(s.skill));
  if (t1Hit) top1++;
  if (t5Hit) top5++;

  // Where does the expected skill actually land?
  const expectedIdx = merged.findIndex((c) => acceptSet.has(c.skill));
  const rankStr = expectedIdx < 0 ? 'NOT-IN-LIST' : `rank ${expectedIdx + 1}`;
  const rankMark = t1Hit ? '✅' : t5Hit ? `↓${expectedIdx + 1}` : '❌';
  console.log(`${rankMark}  expected=${[...acceptSet].join('|').padEnd(24)}  top1=${t1Skill.padEnd(24)}  ${rankStr}`);
  console.log(`   goal: ${e.goal.slice(0, 90)}`);
  console.log(`   top5: ${top5arr.map((c) => `${c.skill}(${c.score.toFixed(2)},${c.src})`).join(' ')}`);
  console.log('');

  // stderr TSV for grep
  process.stderr.write(
    `${t1Hit ? 'T1' : t5Hit ? 'T5' : 'MISS'}\t${e.expected_skill}\t${t1Skill}\t${expectedIdx + 1}\t${e.goal.slice(0, 80).replace(/\t/g, ' ')}\n`,
  );
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log(`Baseline: top1=${top1}/${corpus.length} (${(top1 / corpus.length * 100).toFixed(0)}%)  top5=${top5}/${corpus.length} (${(top5 / corpus.length * 100).toFixed(0)}%)`);
console.log('═══════════════════════════════════════════════════════════════════');

db.close();
