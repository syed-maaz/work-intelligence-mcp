#!/usr/bin/env node
/**
 * scripts/stage1-realwork-v2.mjs — ADR-042 Stage 1 recall vs corpus v2.
 *
 * Differs from stage1-realwork.mjs:
 *   - reads .planning/paraphrase-corpus-v2.jsonl (live consolidated taxonomy)
 *   - honours the accept[] array (a goal may map to >1 defensibly-correct skill)
 *   - refreshes skill_catalog from the WORKTREE skills/ dir before measuring
 *     (WI_SKILLS_ROOT), so description edits in this worktree are measured
 *     without touching the installed ~/.claude symlinks (which point at main).
 *
 * Usage:  node scripts/stage1-realwork-v2.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.dirname(new URL(import.meta.url).pathname).replace(/\/scripts$/, '');
process.env.DATABASE_PATH = process.env.DATABASE_PATH || `${process.env.HOME}/.work-intelligence-mcp/data.db`;
// Point the discovery scanner at THIS worktree's skills/ so description edits
// here are what we measure. Falls back to the default installed root if unset.
process.env.WI_SKILLS_ROOT = process.env.WI_SKILLS_ROOT || `${REPO}/skills`;

const { getDatabase } = await import(`${REPO}/dist/db/connection.js`);
const { stage1Fetch } = await import(`${REPO}/dist/services/cypher/stage1.js`);
const { discoverSkills } = await import(`${REPO}/dist/services/cypher/skill-discovery.js`);

const db = getDatabase();

// Refresh skill_catalog descriptions from the worktree skills/ dir.
const scan = discoverSkills(db, { roots: [process.env.WI_SKILLS_ROOT] });
console.log(`Catalog refreshed from ${process.env.WI_SKILLS_ROOT}: scanned=${scan.scanned} updated=${scan.updated} inserted=${scan.inserted} errors=${scan.errors.length}`);

const corpus = fs.readFileSync(`${REPO}/.planning/paraphrase-corpus-v2.jsonl`, 'utf8')
  .split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).filter(e => e.goal);

console.log('═══════════════════════════════════════════════════════════════════');
console.log(`ADR-042 Stage 1 REAL-WORK v2 — ${corpus.length} paraphrase goals (live taxonomy)`);
console.log('═══════════════════════════════════════════════════════════════════');

const results = [];
for (const e of corpus) {
  const accept = new Set(e.accept && e.accept.length ? e.accept : [e.expected_skill]);
  const ev = await stage1Fetch(e.goal, db);
  const cands = [
    ...ev.prompt_memory_hits.map(h => ({ skill: h.id, score: h.score })),
    ...ev.catalog_candidates.map(h => ({ skill: h.id, score: h.score })),
  ].sort((a, b) => b.score - a.score);
  // de-dup by skill keeping best score (mirrors computeRecognitionConfidence merge)
  const seen = new Set();
  const merged = [];
  for (const c of cands) { if (!seen.has(c.skill)) { seen.add(c.skill); merged.push(c); } }
  // ADR-050 R2.2-B (option c) — mirror production rerank so the metric measures
  // the same order the 1b LLM sees. Phrase-matched skills rise above non-matches,
  // relative order preserved; never adds/removes candidates.
  const { getTriggerPhraseHitSkills, rerankByPhraseHit } = await import(`${REPO}/dist/services/cypher/tool-catalog.js`);
  const phraseHits = getTriggerPhraseHitSkills(e.goal, db);
  const reranked = phraseHits.size > 0
    ? rerankByPhraseHit(merged.map(c => ({ id: c.skill, score: c.score })), phraseHits)
        .map(c => ({ skill: c.id, score: c.score }))
    : merged;
  const top5 = reranked.slice(0, 5).map(c => c.skill);
  const top1Hit = accept.has(top5[0]);
  const top5Hit = top5.some(s => accept.has(s));
  results.push({ id: e.id, expected: e.expected_skill, accept: [...accept], top5, top1Hit, top5Hit, wall: ev.fetch_wallclock_ms });
  const mark = top1Hit ? '🥇' : top5Hit ? '📊' : '❌';
  console.log(`${mark} ${e.id}  want=[${[...accept].join('|')}]  top5=[${top5.join(', ')}]`);
}

const t1 = results.filter(r => r.top1Hit).length;
const t5 = results.filter(r => r.top5Hit).length;
console.log('');
console.log('═══════════════════════════════════════════════════════════════════');
console.log(`  Top-1: ${t1}/${corpus.length} = ${(t1 / corpus.length * 100).toFixed(0)}%`);
console.log(`  Top-5: ${t5}/${corpus.length} = ${(t5 / corpus.length * 100).toFixed(0)}%   ← AC-U1 gate (target ≥70%)`);
console.log('═══════════════════════════════════════════════════════════════════');

fs.writeFileSync(`${REPO}/.planning/stage1-realwork-v2.json`, JSON.stringify({
  timestamp_note: 'stamp externally — Date.now unavailable in some contexts',
  corpus_version: 'v2', results, metrics: { top1: t1 / corpus.length, top5: t5 / corpus.length },
}, null, 2));
process.exit(t5 / corpus.length >= 0.7 ? 0 : 2);
