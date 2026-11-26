#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULE_FILES = new Set(['scripts/leak-patterns.txt', 'scripts/leak-names.txt', 'scripts/leak-allow.txt']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.wi-release', '.planning', '.codex', '.hermes']);

function rg(args, options = {}) {
  const result = spawnSync('rg', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  // rg uses 1 for a completed scan with no matches; every other failure is fatal.
  if (result.error || ![0, 1].includes(result.status)) throw new Error('ripgrep failed; scan did not complete');
  return result;
}

function readRules(file) {
  try {
    if (!lstatSync(file).isFile()) throw new Error();
    const rules = readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    rg(['--quiet', '-f', file, '--', '/dev/null']);
    return rules;
  } catch { throw new Error('missing, unreadable, or invalid rule file'); }
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function scanTree(root, options = {}) {
  root = realpathSync(root);
  const patterns = resolve(options.patterns ?? resolve(root, 'scripts/leak-patterns.txt'));
  const names = resolve(options.names ?? resolve(root, 'scripts/leak-names.txt'));
  const allow = resolve(options.allow ?? resolve(root, 'scripts/leak-allow.txt'));
  readRules(patterns);
  readRules(names);
  const allowances = readRules(allow).map(rule => {
    if (!rule.startsWith('^') || !rule.endsWith('$')) throw new Error('allow rules must be anchored to a complete relative path');
    try { return new RegExp(rule); } catch { throw new Error('invalid path allowance'); }
  });
  const files = [];
  const pathInputs = [];
  const unsafe = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(dir, entry.name);
      const rel = relative(root, absolute).split(sep).join('/');
      if (/[\r\n\0]/.test(rel)) { unsafe.push('invalid filename'); continue; }
      if (entry.isDirectory()) {
        const ignored = options.strict ? rel === '.git' : SKIP_DIRS.has(entry.name) || rel === '.claude/worktrees';
        if (!ignored) walk(absolute);
        continue;
      }
      // Never read the owner's real environment file. The exporter rejects
      // credential files; a tracked .env is rejected here using metadata only.
      if (rel === '.env') {
        const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', '.env'], { cwd: root, stdio: 'ignore' });
        if (tracked.status === 0) unsafe.push('tracked environment file');
        continue;
      }
      if (RULE_FILES.has(rel)) continue;
      if (allowances.some(rule => rule.test(rel))) continue;
      pathInputs.push(rel);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        pathInputs.push(target);
        const lexical = resolve(dirname(absolute), target);
        if (!inside(root, lexical)) { unsafe.push('symlink escapes scan root'); continue; }
        try { if (!inside(root, realpathSync(absolute))) unsafe.push('symlink escapes scan root'); }
        catch { unsafe.push('dangling or cyclic symlink'); }
        continue;
      }
      if (!entry.isFile()) { unsafe.push('unsupported filesystem entry'); continue; }
      files.push(rel);
    }
  }
  walk(root);
  const ruleArgs = ['-i', '-f', patterns, '-f', names];
  if (pathInputs.length && rg(['--quiet', ...ruleArgs], { input: pathInputs.join('\n') + '\n' }).status === 0) {
    unsafe.push('denied filename or symlink target');
  }
  const hits = [];
  for (let offset = 0; offset < files.length; offset += 128) {
    const result = rg(['--files-with-matches', '--null', '--text', '--no-ignore', '--hidden', ...ruleArgs, '--', ...files.slice(offset, offset + 128)], { cwd: root });
    if (result.status === 0) hits.push(...result.stdout.split('\0').filter(Boolean));
  }
  return { clean: unsafe.length === 0 && hits.length === 0, files: files.length, violations: unsafe.length + hits.length };
}

export function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length;) {
    if (argv[index] === '--strict') { options.strict=true; index++; continue; }
    const key = argv[index]?.replace(/^--/, '');
    if (!['root', 'patterns', 'names', 'allow'].includes(key) || !argv[index + 1]) throw new Error('invalid scanner arguments');
    options[key] = argv[index + 1];
    index += 2;
  }
  const result = scanTree(options.root ?? process.cwd(), options);
  console.log(result.clean ? `LEAK SCAN CLEAN (${result.files} files checked)` : `LEAK SCAN FAILED: ${result.violations} violation(s); matching data redacted`);
  return result.clean ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`SCANNER ERROR: ${error.message}`); process.exitCode = 2; }
}
