#!/usr/bin/env node
// wi-frontmatter: audit frontmatter across the WI auto-memory dir.
// Read-only. No --fix flag.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const DIR = path.join(
  HOME,
);

const REQUIRED_FIELDS = ['name', 'description'];
// metadata.type enum sanity — novel values WARN, missing field WARN.
const TYPE_ENUM = new Set([
  'user',
  'feedback',
  'project',
  'reference',
  'fact',
  'bug',
  'decision',
  'jira',
]);

const DAILY_NOTE_RE = /^\d{4}-\d{2}-\d{2}/;
const SLUG_VERSION_RE = /v(\d+)/i;
const BODY_VERSION_RE = /\bv(\d{1,3})\b/gi;

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { ok: false, reason: 'no frontmatter' };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { ok: false, reason: 'unterminated frontmatter' };
  const block = text.slice(3, end).replace(/^\n/, '');
  const body = text.slice(end + 4);
  const fm = {};
  let currentKey = null;
  let nested = null;
  for (const rawLine of block.split('\n')) {
    if (!rawLine.trim()) continue;
    if (/^[A-Za-z0-9_]+:/.test(rawLine)) {
      // top-level key
      const m = rawLine.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      currentKey = m[1];
      const v = m[2].trim();
      if (v === '') {
        fm[currentKey] = {};
        nested = currentKey;
      } else {
        fm[currentKey] = v.replace(/^["']|["']$/g, '');
        nested = null;
      }
    } else if (nested && /^\s+[A-Za-z0-9_]+:/.test(rawLine)) {
      const m = rawLine.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
      fm[nested][m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { ok: true, fm, body };
}

function checkVersionDrift(slug, body) {
  if (!slug) return null;
  const m = SLUG_VERSION_RE.exec(slug);
  if (!m) return null;
  const slugV = parseInt(m[1], 10);
  const seen = new Set();
  let bm;
  BODY_VERSION_RE.lastIndex = 0;
  while ((bm = BODY_VERSION_RE.exec(body))) {
    const n = parseInt(bm[1], 10);
    if (n >= 1 && n < 1000) seen.add(n);
  }
  if (seen.size === 0) return null;
  const max = Math.max(...seen);
  if (max > slugV) {
    return `name slug says v${slugV} but body references v${max}`;
  }
  return null;
}

function audit(file) {
  const stem = path.basename(file, '.md');
  if (stem === 'MEMORY') return { kind: 'OK', reason: 'index file (skipped)' };
  if (DAILY_NOTE_RE.test(stem)) return { kind: 'OK', reason: 'daily note (skipped)' };

  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) {
    return { kind: 'ERROR', reason: parsed.reason };
  }

  const issues = [];
  for (const f of REQUIRED_FIELDS) {
    if (!parsed.fm[f]) issues.push(`missing required field: ${f}`);
  }
  // metadata.type
  if (!parsed.fm.metadata || typeof parsed.fm.metadata !== 'object') {
    issues.push('missing metadata block');
  } else if (!parsed.fm.metadata.type) {
    issues.push('missing metadata.type');
  } else if (!TYPE_ENUM.has(parsed.fm.metadata.type)) {
    issues.push(
      `novel metadata.type "${parsed.fm.metadata.type}" (expected one of ${[...TYPE_ENUM].join(', ')})`,
    );
  }
  const drift = checkVersionDrift(parsed.fm.name, parsed.body);
  if (drift) issues.push(drift);

  if (issues.length === 0) return { kind: 'OK' };
  // missing-required is ERROR; novel type / drift / missing block is WARN
  const hasErr = issues.some((i) => i.startsWith('missing required field'));
  return { kind: hasErr ? 'ERROR' : 'WARN', reason: issues.join('; ') };
}

function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`wi-frontmatter: directory not found: ${DIR}`);
    process.exit(2);
  }
  const files = fs
    .readdirSync(DIR)
    .filter((n) => n.endsWith('.md'))
    .sort()
    .map((n) => path.join(DIR, n));

  let ok = 0,
    warn = 0,
    err = 0;

  console.log('# wi-frontmatter report');
  console.log('');
  console.log(`Scanned ${files.length} files in ${DIR.replace(HOME, '~')}`);
  console.log('');
  for (const f of files) {
    const r = audit(f);
    const stem = path.basename(f);
    if (r.kind === 'OK') {
      ok++;
      // skip OK lines in the report unless verbose; show short ✓
      console.log(`- OK    ${stem}${r.reason ? '  (' + r.reason + ')' : ''}`);
    } else if (r.kind === 'WARN') {
      warn++;
      console.log(`- WARN  ${stem}  ${r.reason}`);
    } else {
      err++;
      console.log(`- ERROR ${stem}  ${r.reason}`);
    }
  }
  console.log('');
  console.log(`Totals: ${ok} OK, ${warn} WARN, ${err} ERROR`);
  process.exit(warn + err > 0 ? 1 : 0);
}

try {
  main();
} catch (e) {
  console.error('wi-frontmatter: error:', e.message);
  process.exit(2);
}
