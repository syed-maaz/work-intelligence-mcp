#!/usr/bin/env node
/**
 * scripts/paraphrase-baseline.mjs — measure recall of getCatalogHint
 * against .planning/paraphrase-corpus-v1.jsonl.
 *
 * For each corpus goal:
 *   - Call getCatalogHint(goal, db)
 *   - Parse the top-1 skill from the hint
 *   - Compare to expected_skill
 * Reports:
 *   - per-goal path (semantic|word-overlap) + top-1 skill + match/miss
 *   - aggregate recall (top-1 matches expected)
 *   - which goals used semantic vs word-overlap fallback
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.dirname(new URL(import.meta.url).pathname).replace(/\/scripts$/, '');
process.env.DATABASE_PATH = process.env.DATABASE_PATH || `${process.env.HOME}/.work-intelligence-mcp/data.db`;

const { getDatabase } = await import(`${REPO}/dist/db/connection.js`);
const { getCatalogHint } = await import(`${REPO}/dist/services/cypher/tool-catalog.js`);

const db = getDatabase();

const corpus = fs.readFileSync(`${REPO}/.planning/paraphrase-corpus-v1.jsonl`, 'utf8')
  .split('\n')
  .filter(l => l.trim())
  .map(l => JSON.parse(l))
  .filter(e => e.goal);

console.log('═══════════════════════════════════════════════════════════════════');
console.log(`Paraphrase baseline — ${corpus.length} goals against getCatalogHint`);
console.log('═══════════════════════════════════════════════════════════════════');

const results = [];
for (const e of corpus) {
  const hint = await getCatalogHint(e.goal, db);
  const firstLine = hint.split('\n')[0] || '';
  const path = firstLine.includes('learned from similar past prompts') ? 'semantic'
             : firstLine.includes('description-overlap') ? 'word-overlap'
             : 'empty';
  // Extract top-1 skill: line 2 starts with '  - <skill>'
  const top1Match = hint.split('\n')[1]?.match(/^\s*-\s*([\w-]+)/);
  const top1 = top1Match ? top1Match[1] : '(none)';
  const hit = top1 === e.expected_skill;
  results.push({ id: e.id, goal: e.goal, expected: e.expected_skill, top1, path, hit });
  console.log(`\n${e.id}  ${hit ? '✓' : '✗'}  ${path.padEnd(12)}  expected=${e.expected_skill}  got=${top1}`);
  console.log(`  goal: "${e.goal}"`);
}

const hits = results.filter(r => r.hit).length;
const semantic = results.filter(r => r.path === 'semantic').length;
const wordoverlap = results.filter(r => r.path === 'word-overlap').length;
const empty = results.filter(r => r.path === 'empty').length;

console.log('');
console.log('═══════════════════════════════════════════════════════════════════');
console.log(`Baseline recall (top-1 correct): ${hits}/${corpus.length} = ${(hits/corpus.length*100).toFixed(1)}%`);
console.log(`  Path split: semantic=${semantic}  word-overlap=${wordoverlap}  empty=${empty}`);
console.log('');
console.log('Semantic hits (recognised via prompt_memory):');
for (const r of results.filter(r => r.path === 'semantic')) {
  console.log(`  ${r.id}: ${r.hit ? '✓' : '✗'} ${r.expected} → ${r.top1}`);
}
console.log('');
console.log('Word-overlap fallbacks:');
for (const r of results.filter(r => r.path === 'word-overlap')) {
  console.log(`  ${r.id}: ${r.hit ? '✓' : '✗'} ${r.expected} → ${r.top1}`);
}
console.log('═══════════════════════════════════════════════════════════════════');

// Save for reproducibility
const out = { timestamp: new Date().toISOString(), corpus_version: 'v1',
              results, recall: hits/corpus.length,
              path_split: { semantic, word_overlap: wordoverlap, empty } };
const outPath = `${REPO}/.planning/paraphrase-baseline-v1.json`;
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Baseline snapshot saved: ${outPath}`);
process.exit(0);
