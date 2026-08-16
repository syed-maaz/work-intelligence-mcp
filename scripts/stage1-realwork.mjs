#!/usr/bin/env node
/**
 * scripts/stage1-realwork.mjs — ADR-042 Stage 1 real-work scenarios.
 *
 * Runs Stage 1 (parallel fetch + evidence bundle) against 10 real
 * paraphrase goals and measures whether the evidence bundle CONTAINS
 * the correct skill anywhere in its ranked candidates.
 *
 * This is not the same as end-to-end recall (which needs an LLM to make
 * the final pick from the evidence). This measures Stage 1's job:
 * "did we surface the right skill somewhere in the evidence?" — which
 * is what 1b will read.
 *
 * Reports:
 *   - per-goal: was expected_skill in prompt_memory_hits[] or catalog_candidates[]?
 *   - top-1 recall (like baseline)
 *   - top-5 recall (was correct skill in top 5 of ANY source?)
 *   - stage1 wall-clock distribution
 *
 * This is the honest "is Stage 1 doing its job?" measurement.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.dirname(new URL(import.meta.url).pathname).replace(/\/scripts$/, '');
process.env.DATABASE_PATH = process.env.DATABASE_PATH || `${process.env.HOME}/.work-intelligence-mcp/data.db`;

const { getDatabase } = await import(`${REPO}/dist/db/connection.js`);
const { stage1Fetch } = await import(`${REPO}/dist/services/cypher/stage1.js`);

const db = getDatabase();

const corpus = fs.readFileSync(`${REPO}/.planning/paraphrase-corpus-v1.jsonl`, 'utf8')
  .split('\n')
  .filter(l => l.trim())
  .map(l => JSON.parse(l))
  .filter(e => e.goal);

console.log('═══════════════════════════════════════════════════════════════════');
console.log(`ADR-042 Stage 1 REAL-WORK — ${corpus.length} paraphrase goals`);
console.log(`Question: does the Stage 1 evidence bundle SURFACE the correct skill?`);
console.log('═══════════════════════════════════════════════════════════════════');

const results = [];
for (const e of corpus) {
  const ev = await stage1Fetch(e.goal, db);

  // Aggregate all candidate skills from the evidence bundle
  const pmSkills = ev.prompt_memory_hits.map(h => ({ skill: h.id, score: h.score, src: 'pm' }));
  const catSkills = ev.catalog_candidates.map(h => ({ skill: h.id, score: h.score, src: 'cat' }));
  const allCandidates = [...pmSkills, ...catSkills]
    .sort((a, b) => b.score - a.score);

  const topSkill = allCandidates[0]?.skill ?? '(none)';
  const top1Hit = topSkill === e.expected_skill;
  const top5 = allCandidates.slice(0, 5).map(c => c.skill);
  const top5Hit = top5.includes(e.expected_skill);
  const anyHit = allCandidates.some(c => c.skill === e.expected_skill);

  results.push({
    id: e.id, goal: e.goal, expected: e.expected_skill,
    top1: topSkill, top5, top1Hit, top5Hit, anyHit,
    wallclock: ev.fetch_wallclock_ms,
    pm_count: ev.prompt_memory_hits.length,
    cat_count: ev.catalog_candidates.length,
    msg_count: ev.message_hits.length,
    catalog_source: ev.catalog_source,
    semantic_available: ev.semantic_available,
  });

  const mark1 = top1Hit ? '🥇' : top5Hit ? '📊' : anyHit ? '❓' : '❌';
  console.log(`\n${mark1} ${e.id}  expected=${e.expected_skill}  top1=${topSkill}`);
  console.log(`   top5: [${top5.join(', ')}]`);
  console.log(`   wall=${ev.wallclock ?? ev.fetch_wallclock_ms}ms  pm=${ev.prompt_memory_hits.length}  cat=${ev.catalog_candidates.length}  msg=${ev.message_hits.length}  source=${ev.catalog_source}`);
  console.log(`   goal: "${e.goal.slice(0, 80)}"`);
}

const top1 = results.filter(r => r.top1Hit).length;
const top5 = results.filter(r => r.top5Hit).length;
const anyRecall = results.filter(r => r.anyHit).length;
const wallclocks = results.map(r => r.wallclock).sort((a, b) => a - b);
const p50 = wallclocks[Math.floor(wallclocks.length / 2)];
const p95 = wallclocks[Math.floor(wallclocks.length * 0.95)];
const max = wallclocks[wallclocks.length - 1];

console.log('');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('Recall summary (Stage 1 evidence bundle):');
console.log(`  Top-1 exact:  ${top1}/${corpus.length} = ${(top1/corpus.length*100).toFixed(0)}%`);
console.log(`  Top-5 recall: ${top5}/${corpus.length} = ${(top5/corpus.length*100).toFixed(0)}%`);
console.log(`  Any-recall:   ${anyRecall}/${corpus.length} = ${(anyRecall/corpus.length*100).toFixed(0)}%`);
console.log('');
console.log('Wall-clock distribution:');
console.log(`  p50=${p50}ms   p95=${p95}ms   max=${max}ms`);
console.log('');
console.log('Comparison vs baseline (word-overlap + broken semantic path):');
let baseTop1 = 0;
try {
  const base = JSON.parse(fs.readFileSync(`${REPO}/.planning/paraphrase-baseline-v1.json`, 'utf8'));
  baseTop1 = base.results.filter(r => r.hit).length;
} catch {}
console.log(`  Baseline: ${baseTop1}/${corpus.length} top-1 correct`);
console.log(`  Stage 1:  ${top1}/${corpus.length} top-1 correct   (${top1 > baseTop1 ? '↑' : top1 === baseTop1 ? '=' : '↓'}${Math.abs(top1 - baseTop1)})`);
console.log(`  Stage 1 top-5: ${top5}/${corpus.length}   (this is what 1b sees — LLM picks from the 5)`);
console.log('═══════════════════════════════════════════════════════════════════');

// Save snapshot
const out = {
  timestamp: new Date().toISOString(),
  corpus_version: 'v1',
  results,
  metrics: {
    top1: top1 / corpus.length,
    top5: top5 / corpus.length,
    anyRecall: anyRecall / corpus.length,
    wallclock_p50_ms: p50,
    wallclock_p95_ms: p95,
    wallclock_max_ms: max,
  },
  baseline_top1: baseTop1 / corpus.length,
};
fs.writeFileSync(`${REPO}/.planning/stage1-realwork-v1.json`, JSON.stringify(out, null, 2));
console.log(`\nSnapshot saved: ${REPO}/.planning/stage1-realwork-v1.json`);
process.exit(0);
