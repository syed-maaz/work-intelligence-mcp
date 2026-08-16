#!/usr/bin/env node
/**
 * dream-apply.mjs — the human-gated APPLY half of the /dream feature.
 *
 * Shared by BOTH:
 *   - the wi-dream-apply skill (CLI):   node scripts/dream-apply.mjs --approve 1,3
 *   - the bridge route POST /api/dream/apply (imports applyDream())
 *
 * For each APPROVED item in the dream report it:
 *   1. writes/patches memory/<target>.md   (add/update)  OR deletes it (prune)
 *   2. upserts the MEMORY.md index line
 *   3. mirrors the memory into the palace via POST /api/palace/drawer (best-effort)
 *   4. commits that single change in the memory git repo (own commit per item)
 *   5. flips the item's status in dream-report.json to applied|rejected
 *
 * SAFETY:
 *   - Only items whose id is in --approve (or --all) are written. --reject marks
 *     status:rejected so the generator never re-proposes them; no file change.
 *   - Every write is a discrete git commit → `git revert <sha>` undoes one item.
 *   - Refuses to run when DREAM_UNATTENDED=1 (apply is never automatic).
 */

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const HOME = process.env.HOME;
const MEM_DIR =
  process.env.WI_DREAM_MEM_DIR ||
const REPORT_JSON = join(MEM_DIR, '.dream', 'dream-report.json');
const INDEX = join(MEM_DIR, 'MEMORY.md');
const BRIDGE = process.env.WI_BRIDGE_URL || 'http://localhost:3132';

function git(args) {
  return execFileSync('git', ['-C', MEM_DIR, ...args], { encoding: 'utf8' }).trim();
}

function renderMemoryFile(item) {
  const fm = item.frontmatter;
  const meta = fm.metadata || {};
  const lines = [
    '---',
    `name: ${fm.name}`,
    `description: ${fm.description}`,
    'metadata:',
    `  node_type: ${meta.node_type || 'memory'}`,
    `  type: ${meta.type}`,
  ];
  if (meta.originSessionId) lines.push(`  originSessionId: ${meta.originSessionId}`);
  lines.push('---', '', item.body, '');
  return lines.join('\n');
}

/** Upsert (or remove) the MEMORY.md index line for a target file. */
function upsertIndexLine(target, indexLine /* null = remove */) {
  const text = existsSync(INDEX) ? readFileSync(INDEX, 'utf8') : '# Memory Index\n';
  const lines = text.split('\n');
  // A line points at this target if it contains "](<target>)".
  const marker = `](${target})`;
  const kept = lines.filter((l) => !l.includes(marker));
  if (indexLine) {
    // prepend after the "# Memory Index" header (line 0) + its blank line
    const head = kept[0]?.startsWith('#') ? 1 : 0;
    kept.splice(head + 1, 0, indexLine);
  }
  writeFileSync(INDEX, kept.join('\n'));
}

async function mirrorToPalace(item) {
  // Best-effort: palace mirror must never block the memory write.
  try {
    const content =
      item.type === 'prune'
        ? `[pruned ${item.target}] ${item.rationale || ''}`
        : `${item.frontmatter?.description || item.target}\n\n${item.body || ''}`;
    const res = await fetch(`${BRIDGE}/api/palace/drawer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wing: item.room && ['topics', 'decisions', 'annotations'].includes(item.room) ? item.room : 'topics',
        room: `dream.${item.target.replace(/\.md$/, '')}`,
        content: content.slice(0, 64 * 1024),
        label: `dream:${item.type}`,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// NOTE: there is intentionally no /api/brain/learn call here. That endpoint is
// record-outcome for an EXISTING decision_id (closes a decision's feedback loop),
// not a free-text fact ingester — a dream memory is a new fact, not a decision
// outcome. The bridge-brain RECALL surface is fed by the palace mirror above
// (brain/recall reads palace), so palace + auto-memory + claude-mem give full
// 4-brain parity with wi-update-context for what a new memory actually needs.

// claude-mem marker file — the claude-mem observer ingests on next sweep.
// Same mechanism wi-update-context uses. Writes to the project's observations dir.
function writeClaudeMemMarker(item) {
  if (item.type === 'prune') return false;
  try {
    const obsDir = join(MEM_DIR, '..', 'observations');
    mkdirSync(obsDir, { recursive: true });
    const stamp = String(item.id).padStart(4, '0');
    const marker = join(obsDir, `dream-${item.target.replace(/\.md$/, '')}-${stamp}.md`);
    writeFileSync(
      marker,
      `# Dream-consolidated memory: ${item.target}\n\n` +
        `${item.frontmatter?.description || ''}\n\n${item.body || ''}\n\n` +
        `> Evidence (user-typed): "${item.evidence}"\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply a dream report.
 * @param {{approve?: number[], reject?: number[], all?: boolean}} opts
 * @returns {Promise<{results: Array, error?: string}>}
 */
export async function applyDream(opts = {}) {
  if (process.env.DREAM_UNATTENDED === '1') {
    return { results: [], error: 'apply refused: DREAM_UNATTENDED=1 (apply is never automatic)' };
  }
  if (!existsSync(REPORT_JSON)) return { results: [], error: 'no dream-report.json' };

  const report = JSON.parse(readFileSync(REPORT_JSON, 'utf8'));
  const approve = new Set(opts.all ? report.items.map((i) => i.id) : opts.approve || []);
  const reject = new Set(opts.reject || []);
  const results = [];

  for (const item of report.items) {
    if (reject.has(item.id)) {
      item.status = 'rejected';
      results.push({ id: item.id, action: 'rejected' });
      continue;
    }
    if (!approve.has(item.id) || item.status === 'applied') continue;

    const file = join(MEM_DIR, item.target);
    try {
      if (item.type === 'prune') {
        if (existsSync(file)) rmSync(file);
        upsertIndexLine(item.target, null);
      } else {
        writeFileSync(file, renderMemoryFile(item));
        upsertIndexLine(item.target, item.index_line || null);
      }
      const palaceOk = await mirrorToPalace(item);
      const claudeMemOk = writeClaudeMemMarker(item);

      git(['add', item.target, 'MEMORY.md']);
      git(['commit', '-m', `dream: ${item.type} ${item.target} (item ${item.id})`]);
      const sha = git(['rev-parse', '--short', 'HEAD']);

      item.status = 'applied';
      results.push({
        id: item.id, action: item.type, target: item.target, commit: sha,
        surfaces: { auto_memory: true, palace: palaceOk, claude_mem: claudeMemOk },
      });
    } catch (err) {
      results.push({ id: item.id, action: 'error', error: err.message });
    }
  }

  writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  // Commit the status changes to the report as a final bookkeeping commit.
  try {
    git(['add', '.dream/dream-report.json']);
    git(['commit', '-m', 'dream: record apply/reject status']);
  } catch { /* nothing staged / .dream ignored — fine */ }

  return { results };
}

// ── CLI entry ────────────────────────────────────────────────────────────────
function parseIds(s) {
  return (s || '').split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isInteger(n));
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opts = { approve: [], reject: [], all: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--approve') opts.approve = parseIds(args[++i]);
    else if (args[i] === '--reject') opts.reject = parseIds(args[++i]);
    else if (args[i] === '--all') opts.all = true;
    else if (/^[\d,]+$/.test(args[i])) opts.approve = parseIds(args[i]); // bare "1,3"
  }
  applyDream(opts).then((out) => {
    if (out.error) { console.error(out.error); process.exit(1); }
    for (const r of out.results) console.log(JSON.stringify(r));
    console.log(`applied ${out.results.filter((r) => r.commit).length} item(s)`);
  });
}
