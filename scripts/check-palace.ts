#!/usr/bin/env tsx
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { join } from 'path';

interface CheckResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  detail: string;
}

const results: CheckResult[] = [];

function check(name: string, fn: () => { status: 'PASS' | 'FAIL' | 'WARN'; detail: string }) {
  try {
    results.push({ name, ...fn() });
  } catch (err) {
    results.push({ name, status: 'FAIL', detail: (err as Error).message });
  }
}

function resolvePalacePython(): string {
  if (process.env.MEMPALACE_PYTHON) return process.env.MEMPALACE_PYTHON;
  try {
    const bin = execFileSync('which', ['mempalace'], { encoding: 'utf8', timeout: 5000 }).trim();
    const shebang = readFileSync(bin, 'utf-8').split('\n')[0];
    const m = shebang.match(/^#!(.+)/);
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  return 'python3';
}

const palacePython = resolvePalacePython();

check('Python 3', () => {
  const version = execFileSync(palacePython, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  return { status: 'PASS', detail: `${version} (${palacePython})` };
});

check('MEMPALACE_PYTHON env', () => {
  const val = process.env.MEMPALACE_PYTHON;
  if (val) {
    const exists = existsSync(val);
    return { status: exists ? 'PASS' : 'FAIL', detail: exists ? `Set: ${val}` : `Set but not found: ${val}` };
  }
  return { status: 'PASS', detail: 'Not set (auto-detect will be used)' };
});

check('mempalace package', () => {
  const output = execFileSync(palacePython, ['-c', 'import mempalace; print(mempalace.__version__)'], { encoding: 'utf8', timeout: 5000 }).trim();
  return { status: 'PASS', detail: `v${output}` };
});

check('mempalace MCP server', () => {
  execFileSync(palacePython, ['-m', 'mempalace.mcp_server', '--help'], { encoding: 'utf8', timeout: 5000 });
  return { status: 'PASS', detail: 'mempalace.mcp_server module accessible' };
});

check('MEMPALACE_PATH', () => {
  const palacePath = process.env.MEMPALACE_PATH;
  if (!palacePath) return { status: 'FAIL', detail: 'MEMPALACE_PATH not set' };
  if (!existsSync(palacePath)) return { status: 'WARN', detail: `${palacePath} does not exist (will be created on first use)` };
  const stat = statSync(palacePath);
  if (!stat.isDirectory()) return { status: 'FAIL', detail: `${palacePath} is not a directory` };
  try {
    const files = readdirSync(palacePath, { recursive: true }) as string[];
    const sizeMB = files.reduce((sum, f) => {
      try { return sum + statSync(join(palacePath, f)).size; } catch { return sum; }
    }, 0) / 1024 / 1024;
    return { status: 'PASS', detail: `${palacePath} (${files.length} files, ${sizeMB.toFixed(1)} MB)` };
  } catch {
    return { status: 'PASS', detail: palacePath };
  }
});

check('ChromaDB', () => {
  const output = execFileSync(palacePython, ['-c', 'import chromadb; print(chromadb.__version__)'], { encoding: 'utf8', timeout: 5000 }).trim();
  return { status: 'PASS', detail: `v${output}` };
});

console.log('\n  Palace Environment Diagnostic\n');
console.log('  ' + '-'.repeat(60));
for (const r of results) {
  const icon = r.status === 'PASS' ? '[OK]' : r.status === 'WARN' ? '[!!]' : '[XX]';
  console.log(`  ${icon} ${r.name.padEnd(25)} ${r.detail}`);
}
console.log('  ' + '-'.repeat(60));

const fails = results.filter(r => r.status === 'FAIL');
if (fails.length > 0) {
  console.log(`\n  ${fails.length} check(s) failed. Palace may not function correctly.\n`);
  process.exit(1);
} else {
  console.log('\n  All checks passed.\n');
  process.exit(0);
}
