#!/usr/bin/env node
/**
 * wi-memory-compact — audit (and optionally propose a compaction of) the WI
 * auto-memory index MEMORY.md.
 *
 * MEMORY.md is loaded into context every session. It has a hard read limit
 * (~24.4 KB); past ~21 KB the harness warns. It rots the same way every time:
 * index lines grow from one-liner hooks into full multi-sentence summaries that
 * duplicate the topic file they point at. This script measures the bloat and
 * flags the specific lines to trim — the fix is always "shorten the hook, the
 * detail already lives in the linked file".
 *
 * READ-ONLY by default. `--apply` is NOT implemented as an auto-rewrite (that
 * would risk dropping load-bearing context another terminal relies on — see the
 * SKILL.md rationale). Instead the script emits a ready-to-paste compacted line
 * for each offender under `--suggest`, which the human reviews and applies.
 *
 * Usage:
 *   node audit.mjs                 # report: size, line count, offenders
 *   node audit.mjs --suggest       # + a proposed ≤LINE_TARGET-char rewrite per offender
 *   node audit.mjs --budget 17000  # override the target byte budget
 *
 * Exit: 0 when under budget, 1 when over budget or offenders found, 2 on error.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MEM_DIR = join(
  homedir(),
);
const MEM = join(MEM_DIR, 'MEMORY.md');

// A healthy index line is a one-liner hook. These thresholds flag the ones that
// have grown into summaries. Tuned to the observed corpus (median line ~150ch;
// offenders 400–680ch).
const LINE_SOFT_MAX = 240; // above this a line is a compaction candidate
const READ_LIMIT = 24_400; // harness hard read limit (bytes)
const WARN_AT = 21_000; // harness warns here

const args = process.argv.slice(2);
const suggest = args.includes('--suggest');
const budgetArg = args.indexOf('--budget');
const BUDGET = budgetArg !== -1 ? Number(args[budgetArg + 1]) : 17_100;

function main() {
  let raw;
  try {
    raw = readFileSync(MEM, 'utf8');
  } catch (e) {
    console.error(`wi-memory-compact: cannot read ${MEM}: ${e.message}`);
    process.exit(2);
  }

  const bytes = Buffer.byteLength(raw, 'utf8');
  const lines = raw.split('\n');
  const indexLines = lines
    .map((text, i) => ({ text, lineNo: i + 1 }))
    .filter((l) => /^-\s+\[/.test(l.text));

  // Header/status readout.
  const pct = ((bytes / READ_LIMIT) * 100).toFixed(0);
  console.log(`MEMORY.md: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB) — ${pct}% of the ${READ_LIMIT}-byte read limit`);
  console.log(`  index entries: ${indexLines.length}`);
  console.log(`  budget target: ${BUDGET} bytes` + (bytes > BUDGET ? `  ⚠️  OVER by ${bytes - BUDGET}` : '  ✓ under'));
  if (bytes >= WARN_AT) console.log(`  ⚠️  past the ${WARN_AT}-byte harness warn threshold`);
  console.log('');

  // Offenders: index lines longer than the soft max, longest first.
  const offenders = indexLines
    .map((l) => ({ ...l, len: l.text.length }))
    .filter((l) => l.len > LINE_SOFT_MAX)
    .sort((a, b) => b.len - a.len);

  if (offenders.length === 0) {
    console.log('No over-long index lines — every entry is a tight hook. Nothing to compact.');
    process.exit(bytes > BUDGET ? 1 : 0);
  }

  const overBudgetBy = Math.max(0, bytes - BUDGET);
  console.log(`${offenders.length} over-long index line(s) (> ${LINE_SOFT_MAX} chars). ` +
    `Trimming these to ~${LINE_SOFT_MAX} would reclaim ~${offenders.reduce((s, o) => s + Math.max(0, o.len - LINE_SOFT_MAX), 0)} bytes ` +
    `(need ${overBudgetBy} to hit budget).`);
  console.log('The detail already lives in the linked topic file — the index only needs the hook.\n');

  for (const o of offenders) {
    const linkMatch = o.text.match(/^(-\s+\[[^\]]+\]\([^)]+\))\s*—?\s*(.*)$/);
    const head = linkMatch ? linkMatch[1] : o.text.slice(0, 80);
    console.log(`  L${o.lineNo} (${o.len} chars): ${head}`);
    if (suggest && linkMatch) {
      // Propose a trimmed hook: keep the link + the first clause of the body.
      const body = linkMatch[2];
      const firstClause = body.split(/(?<=[.;])\s/)[0] ?? body;
      const room = LINE_SOFT_MAX - head.length - 3;
      const trimmed = firstClause.length > room ? firstClause.slice(0, room - 1) + '…' : firstClause;
      console.log(`     ↳ suggest: ${head} — ${trimmed}`);
    }
  }

  if (!suggest) {
    console.log('\nRun with --suggest to see a proposed one-liner rewrite per offender.');
  }
  console.log('\nThis script never edits MEMORY.md. Review each suggestion, move any dropped');
  console.log('detail into the linked topic file if it is not already there, then edit by hand.');

  process.exit(1);
}

main();
