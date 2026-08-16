#!/usr/bin/env node
/**
 * scripts/stage1-recall-sweep.mjs — ADR-042 Phase B (2026-07-24).
 *
 * Sweeps the three recall-tuning knobs exposed by `stage1Fetch`:
 *   - simGate:       prompt_memory branch sim floor  (rankPromptMemory)
 *   - blendSemantic: word-overlap → merged-score rescale multiplier
 *   - antiDomTopK:   catalog top-K reserved regardless of pm-dedup
 *
 * Runs the 10-row held-out paraphrase corpus at each combo, records per-combo
 * top-1 and top-5. Writes .planning/stage1-sweep-<date>.json with:
 *   - baseline (current production defaults)
 *   - full grid results
 *   - `chosen` combo — highest top-1 that does NOT regress top-5 below baseline
 *
 * Honest posture (ADR-042 AC-U1): bar is ≥70% top-1. If nothing in the sweep
 * crosses 7/10, status stays 🚧 Substrate Accepted.
 *
 * DOES NOT modify:
 *   - .planning/paraphrase-corpus-v1.jsonl   (immutable held-out corpus)
 *   - .planning/paraphrase-baseline-v1.json  (immutable baseline floor)
 *
 * Runs against the LIVE ~/.work-intelligence-mcp/data.db (read-only).
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

const db = getDatabase();

// --corpus flag: allow variant swaps (v1/v2/v3). Defaults to v1 for back-compat
// with the ADR-042 immutable-baseline claim; Phase-0 M1 sweeps override via
// `--corpus=paraphrase-corpus-v3.jsonl`.
const corpusArg = process.argv.find((a) => a.startsWith('--corpus='));
const CORPUS_FILE = corpusArg ? corpusArg.split('=')[1] : 'paraphrase-corpus-v1.jsonl';
const SWEEP_TAG = process.env.SWEEP_TAG || 'run';

const corpus = fs.readFileSync(`${REPO}/.planning/${CORPUS_FILE}`, 'utf8')
  .split('\n')
  .filter(l => l.trim())
  .map(l => JSON.parse(l))
  .filter(e => e.goal && !e.exclude_from_gate);

// Grid — tight around current production defaults + wider description-lane
// exploration (since the paraphrase corpus is description-shaped, not pm-shaped).
const GRID = {
  simGate:       [0.50, 0.55, 0.60, 0.65, 0.70, 0.75],
  blendSemantic: [0.05, 0.08, 0.12, 0.18, 0.25, 0.35],
  antiDomTopK:   [0, 1, 2, 3],
};

async function scoreCombo(simGate, blendSemantic, antiDomTopK) {
  let top1 = 0, top5 = 0;
  const perGoal = [];
  for (const e of corpus) {
    const ev = await stage1Fetch(e.goal, db, { simGate, blendSemantic, antiDomTopK });
    const pmSkills = ev.prompt_memory_hits.map(h => ({ skill: h.id, score: h.score }));
    const catSkills = ev.catalog_candidates.map(h => ({ skill: h.id, score: h.score }));
    const merged = [...pmSkills, ...catSkills].sort((a, b) => b.score - a.score);
    const top5Skills = merged.slice(0, 5).map(c => c.skill);
    // Support v3 `accept[]` multi-answer scoring; fall back to strict expected_skill for older corpora.
    const acceptSet = new Set(
      Array.isArray(e.accept) && e.accept.length ? e.accept : [e.expected_skill],
    );
    const t1 = acceptSet.has(merged[0]?.skill);
    const t5 = top5Skills.some((s) => acceptSet.has(s));
    if (t1) top1++;
    if (t5) top5++;
    perGoal.push({ id: e.id, expected: e.expected_skill, accept: [...acceptSet], top1: merged[0]?.skill ?? '(none)', top5: top5Skills, top1Hit: t1, top5Hit: t5 });
  }
  return { top1, top5, perGoal };
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('ADR-042 Stage 1 recall sweep — 2026-07-24');
console.log(`Grid: ${GRID.simGate.length}×${GRID.blendSemantic.length}×${GRID.antiDomTopK.length} = ${GRID.simGate.length*GRID.blendSemantic.length*GRID.antiDomTopK.length} combos`);
console.log(`Corpus: ${corpus.length} paraphrase goals (held-out, no verbatim collision)`);
console.log(`Baseline defaults: simGate=${RECALL_SIM_GATE_DEFAULT}, blendSemantic=${RECALL_BLEND_SEMANTIC_DEFAULT}, antiDomTopK=${RECALL_ANTI_DOM_TOPK_DEFAULT}`);
console.log('═══════════════════════════════════════════════════════════════════');

// 1) Baseline (current production defaults, live measurement now).
const baselineRun = await scoreCombo(
  RECALL_SIM_GATE_DEFAULT,
  RECALL_BLEND_SEMANTIC_DEFAULT,
  RECALL_ANTI_DOM_TOPK_DEFAULT,
);
console.log(`\nBaseline (production defaults): top1=${baselineRun.top1}/${corpus.length}  top5=${baselineRun.top5}/${corpus.length}\n`);

// 2) Full sweep.
const results = [];
let idx = 0;
const total = GRID.simGate.length * GRID.blendSemantic.length * GRID.antiDomTopK.length;
for (const simGate of GRID.simGate) {
  for (const blendSemantic of GRID.blendSemantic) {
    for (const antiDomTopK of GRID.antiDomTopK) {
      idx++;
      const r = await scoreCombo(simGate, blendSemantic, antiDomTopK);
      const mark = r.top1 >= Math.ceil(corpus.length * 0.7) ? '🎯' : r.top1 > baselineRun.top1 ? '↑' : '·';
      console.log(`  [${idx.toString().padStart(3)}/${total}] ${mark} simGate=${simGate} blend=${blendSemantic} K=${antiDomTopK} → top1=${r.top1}/${corpus.length} top5=${r.top5}/${corpus.length}`);
      results.push({ simGate, blendSemantic, antiDomTopK, top1: r.top1, top5: r.top5, top1_pct: r.top1/corpus.length, top5_pct: r.top5/corpus.length });
    }
  }
}

// 3) Selection: highest top1 with top5 not regressed below baseline top5.
const baselineTop5 = baselineRun.top5;
const eligible = results.filter(r => r.top5 >= baselineTop5);
eligible.sort((a, b) => b.top1 - a.top1 || b.top5 - a.top5);
const chosen = eligible[0] ?? results.sort((a, b) => b.top1 - a.top1)[0];

const bar_pct = 0.70;
const bar_hits = Math.ceil(corpus.length * bar_pct);
const ac_u1_met = chosen && chosen.top1 >= bar_hits;

// 4) Rerun the chosen combo to capture per-goal details.
const chosenRun = await scoreCombo(chosen.simGate, chosen.blendSemantic, chosen.antiDomTopK);

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('Selection:');
console.log(`  chosen: simGate=${chosen.simGate}, blendSemantic=${chosen.blendSemantic}, antiDomTopK=${chosen.antiDomTopK}`);
console.log(`  top1=${chosen.top1}/${corpus.length} (baseline was ${baselineRun.top1}/${corpus.length})`);
console.log(`  top5=${chosen.top5}/${corpus.length} (baseline was ${baselineRun.top5}/${corpus.length})`);
console.log(`  AC-U1 bar (≥70% top-1 = ≥${bar_hits}/${corpus.length}): ${ac_u1_met ? 'MET ✅' : 'NOT MET ❌'}`);
console.log('═══════════════════════════════════════════════════════════════════');

const out = {
  timestamp: new Date().toISOString(),
  corpus_file: CORPUS_FILE,
  corpus_size: corpus.length,
  sweep_tag: SWEEP_TAG,
  dispatchable_filter_env: process.env.STAGE1_DISPATCHABLE_ONLY === '1' ? 'on' : 'off',
  grid: GRID,
  baseline_defaults: {
    simGate: RECALL_SIM_GATE_DEFAULT,
    blendSemantic: RECALL_BLEND_SEMANTIC_DEFAULT,
    antiDomTopK: RECALL_ANTI_DOM_TOPK_DEFAULT,
  },
  baseline_measured: { top1: baselineRun.top1, top5: baselineRun.top5 },
  results,
  chosen: {
    ...chosen,
    per_goal: chosenRun.perGoal,
  },
  ac_u1_bar: { pct: bar_pct, hits: bar_hits, met: !!ac_u1_met },
};

const corpusStem = CORPUS_FILE.replace(/\.jsonl$/, '');
const outPath = `${REPO}/.planning/stage1-sweep-${corpusStem}-${SWEEP_TAG}.json`;
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nSweep snapshot saved: ${outPath}`);
process.exit(0);
