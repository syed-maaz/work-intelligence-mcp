#!/usr/bin/env node
/**
 * scripts/adr-053-classifier-corpus.mjs — AC-S5 run harness.
 *
 * Reads .planning/adr-053-multi-stage-orchestration/template-classifier-corpus.jsonl
 * and, for each goal, calls feature.cross-repo `applies()` on a HydratedBrief built
 * from the row, then reports predicted-vs-expected per goal plus aggregate accuracy.
 *
 * Satisfies ADR-053 AC-S5: "New test corpus at ...jsonl; run harness reports
 * per-goal predicted-vs-expected." Bar is >=80% accuracy.
 *
 * Run: npm run build && node scripts/adr-053-classifier-corpus.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.dirname(new URL(import.meta.url).pathname).replace(/\/scripts$/, '');
const CORPUS = `${REPO}/.planning/adr-053-multi-stage-orchestration/template-classifier-corpus.jsonl`;

const { default: featureCrossRepo } = await import(
  `${REPO}/dist/services/cypher/pm-templates/feature-cross-repo.js`
);

const rows = fs.readFileSync(CORPUS, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

console.log('═══════════════════════════════════════════════════════════════════');
console.log(`ADR-053 AC-S5 classifier corpus — ${rows.length} goals against applies()`);
console.log('═══════════════════════════════════════════════════════════════════');

let correct = 0;
for (const r of rows) {
  // Build the minimal HydratedBrief shape applies() reads: intent + affected_repos.
  const brief = { goal: r.goal, intent: r.intent, affected_repos: r.affected_repos ?? [] };
  const predicted = featureCrossRepo.applies(brief);
  const ok = predicted === r.expected;
  if (ok) correct++;
  const mark = ok ? 'OK  ' : 'MISS';
  console.log(`${mark}  pred=${String(predicted).padEnd(5)} exp=${String(r.expected).padEnd(5)}  ${r.goal}`);
}

const acc = correct / rows.length;
console.log('───────────────────────────────────────────────────────────────────');
console.log(`accuracy: ${correct}/${rows.length} = ${(acc * 100).toFixed(1)}%  (AC-S5 bar: >=80%)`);
process.exit(acc >= 0.8 ? 0 : 1);
