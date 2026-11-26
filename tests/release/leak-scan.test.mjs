import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixtures = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture({ patterns = 'SYNTHETIC_DENY\n', names = 'FictionalPerson\n', allow = '^safe-fixture\\.txt$\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wi-leak-test-'));
  fixtures.push(root);
  mkdirSync(join(root, 'scripts'));
  for (const name of ['leak-scan.sh', 'leak-scan.mjs']) {
    const source = new URL(`../../scripts/${name}`, import.meta.url);
    if (existsSync(source)) copyFileSync(source, join(root, 'scripts', name));
  }
  for (const [name, value] of [['patterns', patterns], ['names', names], ['allow', allow]]) {
    if (value !== null) writeFileSync(join(root, 'scripts', `leak-${name}.txt`), value);
  }
  return root;
}

function scan(root, args = []) {
  const result = spawnSync('bash', ['scripts/leak-scan.sh', ...args], { cwd: root, encoding: 'utf8' });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test('clean files pass and a real fixture hit fails without printing its content', () => {
  const root = fixture();
  writeFileSync(join(root, 'fixture.txt'), 'ordinary text');
  assert.equal(scan(root).status, 0);
  writeFileSync(join(root, 'fixture.txt'), 'SYNTHETIC_DENY confidential-fixture-payload');
  const result = scan(root);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.output, /confidential-fixture-payload/);
});
test('strict projection scanning checks private names inside nested ignored folders', () => {
  const root=fixture();mkdirSync(join(root,'docs/.planning'),{recursive:true});
  writeFileSync(join(root,'docs/.planning/note.txt'),'FictionalPerson');
  const result=scan(root,['--strict']);
  assert.equal(result.status,1);
  assert.doesNotMatch(result.output,/FictionalPerson/);
});

for (const field of ['patterns', 'names', 'allow']) {
  test(`missing ${field} rules fail closed`, () => {
    const result = scan(fixture({ [field]: null }));
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.output, /LEAK SCAN CLEAN/);
  });
  test(`malformed ${field} rules fail closed`, () => {
    const result = scan(fixture({ [field]: '[\n' }));
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.output, /LEAK SCAN CLEAN/);
  });
}

test('allow rules must match an anchored path rather than leak content', () => {
  const root = fixture({ allow: 'SYNTHETIC_DENY\n' });
  writeFileSync(join(root, 'fixture.txt'), 'SYNTHETIC_DENY');
  assert.equal(scan(root).status, 2);
});

test('an exact safe-file allowance does not exempt a neighbouring path', () => {
  const root = fixture();
  writeFileSync(join(root, 'safe-fixture.txt'), 'SYNTHETIC_DENY');
  assert.equal(scan(root).status, 0);
  writeFileSync(join(root, 'safe-fixture.txt.extra'), 'SYNTHETIC_DENY');
  assert.equal(scan(root).status, 1);
});

test('filename-only leaks are rejected', () => {
  const root = fixture();
  writeFileSync(join(root, 'SYNTHETIC_DENY.txt'), 'ordinary text');
  assert.equal(scan(root).status, 1);
});

test('deny patterns inside binary files are still detected', () => {
  const root = fixture();
  writeFileSync(join(root, 'fixture.bin'), Buffer.from('image\0SYNTHETIC_DENY'));
  assert.equal(scan(root).status, 1);
});

test('symlinks escaping the scanned root are rejected without following them', () => {
  const root = fixture();
  symlinkSync(join(tmpdir(), 'outside-fictional-file'), join(root, 'escape'));
  assert.equal(scan(root).status, 1);
});

test('private names can be supplied without publishing the deny-list', () => {
  const root = fixture({ names: '# public template\n' });
  const privateRules = join(root, '..', `${root.split('/').at(-1)}-names.txt`);
  writeFileSync(privateRules, 'FictionalPerson\n');
  try {
    writeFileSync(join(root, 'fixture.txt'), 'FictionalPerson');
    assert.equal(scan(root, ['--names', privateRules]).status, 1);
  } finally { rmSync(privateRules, { force: true }); }
});
