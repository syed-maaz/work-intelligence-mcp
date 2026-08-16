#!/usr/bin/env node
/**
 * scripts/stage1-livework.mjs — Stage 1 against REAL recent goals from
 * cypher_sessions, not a synthetic paraphrase corpus.
 *
 * The paraphrase corpus at .planning/paraphrase-corpus-v1.jsonl tests the
 * hard adversarial case (goals engineered NOT to word-overlap match).
 * This tests the ORDINARY case — the goals you actually type. Sampled
 * from cypher_sessions.goal where outcome='success' and chosen_skill is
 * set, meaning: "these ARE the goals, and the historical answer is what
 * the user (or Cypher) actually ran and confirmed worked."
 *
 * Fair-play rule: since these goals ARE in prompt_memory (that's the point
 * of prompt_memory), we can't measure recall vs "was the exact-phrase
 * skill matched?" (trivial) — instead we measure something more useful:
 *
 *   1. Wall-clock: does Stage 1 stay fast on real goal shapes?
 *   2. Evidence completeness: does 1a produce actionable evidence
 *      (non-empty candidate list) on 100% of real goals?
 *   3. Historical concordance: is the historically-chosen skill anywhere
 *      in the Stage 1 evidence bundle (top-5)?
 *   4. Anti-domination live check: what fraction of goals have
 *      wi-investigate as the ONLY candidate?
 *
 * Reports per-goal + rollups + saves snapshot to
 *   .planning/stage1-livework-v1.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const REPO = path.dirname(new URL(import.meta.url).pathname).replace(/\/scripts$/, '');
process.env.DATABASE_PATH = process.env.DATABASE_PATH || `${process.env.HOME}/.work-intelligence-mcp/data.db`;

const { getDatabase } = await import(`${REPO}/dist/db/connection.js`);
const { stage1Fetch, renderStage1EvidenceBlock } = await import(`${REPO}/dist/services/cypher/stage1.js`);

const db = getDatabase();

// Sample real goals — success=1, valid chosen_skill, length 25..120 chars,
// distinct goal texts, from last 30 days. 15 samples.
const rows = db
  .prepare(`
    SELECT goal, chosen_skill, task_class, started_at
    FROM (
      SELECT goal, chosen_skill, task_class, started_at
      FROM cypher_sessions
      WHERE goal IS NOT NULL AND chosen_skill IS NOT NULL
        AND outcome='success'
        AND started_at > datetime('now', '-30 days')
        AND LENGTH(goal) BETWEEN 25 AND 120
      GROUP BY goal
    )
    ORDER BY RANDOM() LIMIT 15
  `)
  .all();

if (rows.length === 0) {
  console.error('No live-work corpus available — cypher_sessions has no matching rows.');
  process.exit(2);
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log(`ADR-042 Stage 1 LIVE-WORK — ${rows.length} real goals from cypher_sessions`);
console.log('Test: on ordinary goal shapes, does Stage 1 stay fast and produce actionable evidence?');
console.log('═══════════════════════════════════════════════════════════════════');

const results = [];
for (const row of rows) {
  const ev = await stage1Fetch(row.goal, db);

  // Collect all candidate skills across pm + catalog
  const allSkills = [
    ...ev.prompt_memory_hits.map(h => ({ skill: h.id, score: h.score, src: 'pm' })),
    ...ev.catalog_candidates.map(h => ({ skill: h.id, score: h.score, src: 'cat' })),
  ].sort((a, b) => b.score - a.score);

  const uniqueSkills = new Set(allSkills.map(s => s.skill));
  const top5 = allSkills.slice(0, 5).map(s => s.skill);
  const historicalInTop5 = top5.includes(row.chosen_skill);
  const historicalInAny = uniqueSkills.has(row.chosen_skill);
  const totalCandidates = ev.prompt_memory_hits.length + ev.catalog_candidates.length;
  const wiInvestigateOnly = uniqueSkills.size === 1 && uniqueSkills.has('wi-investigate');

  results.push({
    goal: row.goal,
    chosen_skill: row.chosen_skill,
    started_at: row.started_at,
    stage1_top1: top5[0] ?? null,
    stage1_top5: top5,
    stage1_unique_count: uniqueSkills.size,
    stage1_pm_count: ev.prompt_memory_hits.length,
    stage1_cat_count: ev.catalog_candidates.length,
    stage1_msg_count: ev.message_hits.length,
    wallclock_ms: ev.fetch_wallclock_ms,
    catalog_source: ev.catalog_source,
    historicalInTop5,
    historicalInAny,
    wiInvestigateOnly,
    errors: ev.errors,
  });

  const mark = historicalInTop5 ? '✅' : historicalInAny ? '⚠️' : '❌';
  console.log(`\n${mark} historical=${row.chosen_skill}  top1=${top5[0]}`);
  console.log(`   top5:      [${top5.join(', ')}]`);
  console.log(`   wall=${ev.fetch_wallclock_ms}ms  unique=${uniqueSkills.size}  pm=${ev.prompt_memory_hits.length}  cat=${ev.catalog_candidates.length}  source=${ev.catalog_source}`);
  console.log(`   goal:      "${row.goal.slice(0, 90)}"`);
}

// ── Rollups ──────────────────────────────────────────────────────────────
const n = results.length;
const concordanceTop5 = results.filter(r => r.historicalInTop5).length;
const concordanceAny = results.filter(r => r.historicalInAny).length;
const nonEmpty = results.filter(r => (r.stage1_pm_count + r.stage1_cat_count) > 0).length;
const wiInvOnly = results.filter(r => r.wiInvestigateOnly).length;
const uniqueAvg = results.reduce((s, r) => s + r.stage1_unique_count, 0) / n;

const wallclocks = results.map(r => r.wallclock_ms).sort((a, b) => a - b);
const p50 = wallclocks[Math.floor(n / 2)];
const p95 = wallclocks[Math.floor(n * 0.95)];
const max = wallclocks[n - 1];

console.log('');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('Live-work rollups:');
console.log(`  Sample size:            ${n} real goals from cypher_sessions`);
console.log(`  Evidence completeness:  ${nonEmpty}/${n} (${(nonEmpty/n*100).toFixed(0)}%) goals produce non-empty evidence`);
console.log(`  Historical in top-5:    ${concordanceTop5}/${n} (${(concordanceTop5/n*100).toFixed(0)}%)`);
console.log(`  Historical in any:      ${concordanceAny}/${n} (${(concordanceAny/n*100).toFixed(0)}%)`);
console.log(`  Avg unique skills/goal: ${uniqueAvg.toFixed(1)}  (higher = better diversity)`);
console.log(`  wi-investigate-only:    ${wiInvOnly}/${n} (${(wiInvOnly/n*100).toFixed(0)}%)  (want LOW — audit HIGH-2)`);
console.log('');
console.log('Wall-clock distribution:');
console.log(`  p50=${p50}ms   p95=${p95}ms   max=${max}ms   (budget 2000ms)`);
console.log('');

// Save the snapshot
const out = {
  timestamp: new Date().toISOString(),
  sample_size: n,
  metrics: {
    evidence_completeness: nonEmpty / n,
    historical_in_top5: concordanceTop5 / n,
    historical_in_any: concordanceAny / n,
    avg_unique_skills: uniqueAvg,
    wi_investigate_only: wiInvOnly / n,
    wallclock_p50_ms: p50,
    wallclock_p95_ms: p95,
    wallclock_max_ms: max,
  },
  goals: results,
};
fs.writeFileSync(`${REPO}/.planning/stage1-livework-v1.json`, JSON.stringify(out, null, 2));
console.log(`Snapshot saved: ${REPO}/.planning/stage1-livework-v1.json`);

// ── Show one full rendered evidence block so the user can eyeball what 1b sees ─
console.log('');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('Sample rendered 1b evidence block (first goal):');
console.log('═══════════════════════════════════════════════════════════════════');
const firstEv = await stage1Fetch(rows[0].goal, db);
console.log(renderStage1EvidenceBlock(firstEv));

process.exit(0);
