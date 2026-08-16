#!/usr/bin/env node
// wi-check-links: validate [[wikilinks]] across the WI auto-memory dir.
// Read-only.
//
// Usage:
//   node check-links.mjs              # report-only; exit 1 if any unresolved
//   node check-links.mjs --fix-suggest  # also print closest-match suggestions

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const DIRS = [
  {
    label: 'auto-memory',
    path: path.join(
      HOME,
    ),
    // resolve via frontmatter name: slug primarily, filename stem as fallback
    resolveBy: 'frontmatter',
  },
];

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const DAILY_NOTE_RE = /^\d{4}-\d{2}-\d{2}/;
const FRONTMATTER_NAME_RE = /^name:\s*(.+)$/m;

const args = process.argv.slice(2);
const FIX_SUGGEST = args.includes('--fix-suggest');

function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.join(dir, e.name));
}

function readSlug(file) {
  const head = fs.readFileSync(file, 'utf8').slice(0, 1024);
  if (!head.startsWith('---')) return null;
  const end = head.indexOf('\n---', 3);
  if (end === -1) return null;
  const m = FRONTMATTER_NAME_RE.exec(head.slice(0, end));
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function buildIndex() {
  const slugs = new Map(); // slug -> {file, kind}
  const filenames = new Map(); // stem -> {file, kind}
  for (const d of DIRS) {
    for (const file of listMarkdown(d.path)) {
      const stem = path.basename(file, '.md');
      filenames.set(stem, { file, kind: d.label });
      const slug = readSlug(file);
      if (slug) slugs.set(slug, { file, kind: d.label });
    }
  }
  return { slugs, filenames };
}

function parseRef(raw) {
  // strip alias
  const aliasIdx = raw.indexOf('|');
  let target = aliasIdx === -1 ? raw : raw.slice(0, aliasIdx);
  // strip header anchor
  const hashIdx = target.indexOf('#');
  if (hashIdx === 0) return { target: '', anchorOnly: true };
  if (hashIdx > 0) target = target.slice(0, hashIdx);
  return { target: target.trim(), anchorOnly: false };
}

function resolveRef(ref, sourceFile, index) {
  if (ref.anchorOnly || !ref.target) return { kind: 'skip' };
  const t = ref.target;
  // relative path
  if (t.startsWith('./') || t.startsWith('../') || t.includes('/')) {
    const candidate = path.resolve(path.dirname(sourceFile), t);
    const withMd = candidate.endsWith('.md') ? candidate : candidate + '.md';
    if (fs.existsSync(withMd)) return { kind: 'ok', via: 'path' };
    return { kind: 'unresolved', via: 'path' };
  }
  if (index.slugs.has(t)) return { kind: 'ok', via: 'slug' };
  if (index.filenames.has(t)) return { kind: 'ok', via: 'filename' };
  if (DAILY_NOTE_RE.test(t)) return { kind: 'info', why: 'daily-note' };
  return { kind: 'unresolved', via: 'none' };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function suggest(target, index, n = 3) {
  const candidates = [...index.slugs.keys(), ...index.filenames.keys()];
  return candidates
    .map((c) => ({ c, d: levenshtein(target, c) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .filter((x) => x.d <= Math.max(3, Math.ceil(target.length * 0.4)));
}

function main() {
  const index = buildIndex();
  const findings = []; // {file, line, target, kind, suggestions?}

  for (const d of DIRS) {
    for (const file of listMarkdown(d.path)) {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        let m;
        WIKILINK_RE.lastIndex = 0;
        while ((m = WIKILINK_RE.exec(line))) {
          const ref = parseRef(m[1]);
          const res = resolveRef(ref, file, index);
          if (res.kind === 'unresolved' || res.kind === 'info') {
            const item = {
              file,
              dir: d.label,
              line: idx + 1,
              target: ref.target,
              kind: res.kind,
              via: res.via,
            };
            if (FIX_SUGGEST && res.kind === 'unresolved') {
              item.suggestions = suggest(ref.target, index);
            }
            findings.push(item);
          }
        }
      });
    }
  }

  const unresolved = findings.filter((f) => f.kind === 'unresolved');
  const info = findings.filter((f) => f.kind === 'info');

  // group by file
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  console.log('# wi-check-links report');
  console.log('');
  console.log(
    `Scanned ${DIRS.length} directories. ${unresolved.length} unresolved, ${info.length} info-only (daily notes).`,
  );
  console.log('');
  if (byFile.size === 0) {
    console.log('All wikilinks resolve. Nothing to report.');
    process.exit(0);
  }
  for (const [file, items] of byFile) {
    const rel = file.replace(HOME, '~');
    console.log(`## ${rel}`);
    for (const it of items) {
      const tag = it.kind === 'unresolved' ? 'WARN' : 'INFO';
      console.log(`- ${tag} L${it.line}: \`[[${it.target}]]\``);
      if (it.suggestions && it.suggestions.length > 0) {
        const s = it.suggestions.map((x) => `\`${x.c}\` (d=${x.d})`).join(', ');
        console.log(`  - did you mean: ${s}`);
      } else if (FIX_SUGGEST && it.kind === 'unresolved') {
        console.log(`  - did you mean: (no close matches)`);
      }
    }
    console.log('');
  }
  process.exit(unresolved.length > 0 ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error('wi-check-links: error:', err.message);
  process.exit(2);
}
