import { describe, it, expect } from 'vitest';
import {
  classifyResolveTarget,
  classifyAllTargets,
  getRepoRoot,
} from '../../../src/services/bugs/path-classifier.js';

// REPO_ROOT is detected from this file's location (tests/services/bugs/ → ../../..),
// which lands on the same WI repo root the classifier would compute. We can
// therefore test ALLOWED + BLOCKED against real on-disk paths.

describe('classifyResolveTarget — ALLOWED bucket', () => {
  it('allows a relative path inside src/', () => {
    expect(classifyResolveTarget('src/routes/bugs.ts')).toBe('ALLOWED');
  });

  it('allows a relative path inside web/src/', () => {
    expect(classifyResolveTarget('web/src/pages/BugsPage.tsx')).toBe('ALLOWED');
  });

  it('allows a path that does not yet exist (new file in patch)', () => {
    expect(classifyResolveTarget('src/services/bugs/brand-new-file.ts')).toBe('ALLOWED');
  });

  it('allows the repo root itself', () => {
    // The classifier accepts REPO_ROOT exactly (commit on repo root, e.g. CLAUDE.md edit).
    expect(classifyResolveTarget('CLAUDE.md')).toBe('ALLOWED');
  });

  it('allows an absolute path inside the repo', () => {
    expect(classifyResolveTarget(`${getRepoRoot()}/src/db/schema.ts`)).toBe('ALLOWED');
  });
});

describe('classifyResolveTarget — sibling-repo BLOCKED', () => {
  it('blocks a relative path under repos/app', () => {
    expect(classifyResolveTarget('repos/app/foo.ts')).toBe('BLOCKED');
  });

  it('blocks a relative path under repos/operations', () => {
    expect(classifyResolveTarget('repos/app/deploy.yaml')).toBe('BLOCKED');
  });

  it('blocks the repos/app directory itself', () => {
    expect(classifyResolveTarget('repos/app')).toBe('BLOCKED');
  });

  it('blocks a deep nested path under repos/app/lib-x/y/z.ts', () => {
    expect(classifyResolveTarget('repos/app/libs/search-provider-proxy/src/index.ts')).toBe('BLOCKED');
  });

  it('blocks an absolute path under repos/app', () => {
    expect(classifyResolveTarget(`${getRepoRoot()}/repos/app/foo.ts`)).toBe('BLOCKED');
  });

  it('blocks even when the file does not exist (lexical fence still applies)', () => {
    expect(classifyResolveTarget('repos/app/does-not-exist-yet.ts')).toBe('BLOCKED');
  });
});

describe('classifyResolveTarget — outside-repo BLOCKED', () => {
  it('blocks an absolute path under ~/.claude (Claude Code territory)', () => {
    expect(classifyResolveTarget('/home/testuser/.claude/skills/foo/SKILL.md')).toBe('BLOCKED');
  });

  it('blocks /tmp', () => {
    expect(classifyResolveTarget('/tmp/anywhere.ts')).toBe('BLOCKED');
  });

  it('blocks a relative path that escapes the repo via ..', () => {
    expect(classifyResolveTarget('../some-other-project/foo.ts')).toBe('BLOCKED');
  });

  it('blocks an absolute /etc path', () => {
    expect(classifyResolveTarget('/etc/passwd')).toBe('BLOCKED');
  });

  it('blocks an empty string defensively', () => {
    expect(classifyResolveTarget('')).toBe('BLOCKED');
  });
});

describe('classifyAllTargets — aggregate', () => {
  it('returns ALLOWED with empty blocked list when every path is allowed', () => {
    const result = classifyAllTargets([
      'src/routes/bugs.ts',
      'web/src/pages/BugsPage.tsx',
      'CLAUDE.md',
    ]);
    expect(result.decision).toBe('ALLOWED');
    expect(result.blocked).toEqual([]);
  });

  it('returns BLOCKED with the offending paths when ANY path is blocked', () => {
    const result = classifyAllTargets([
      'src/routes/bugs.ts',
      'repos/app/foo.ts',
      'web/src/lib/api.ts',
    ]);
    expect(result.decision).toBe('BLOCKED');
    expect(result.blocked).toEqual(['repos/app/foo.ts']);
  });

  it('lists every blocked path, not just the first', () => {
    const result = classifyAllTargets([
      'repos/app/foo.ts',
      'src/routes/bugs.ts',
      '/home/testuser/.claude/skills/foo/SKILL.md',
      'repos/app/deploy.yaml',
    ]);
    expect(result.decision).toBe('BLOCKED');
    expect(result.blocked).toEqual([
      'repos/app/foo.ts',
      '/home/testuser/.claude/skills/foo/SKILL.md',
      'repos/app/deploy.yaml',
    ]);
  });

  it('empty input returns ALLOWED (no patch, no problem at this gate)', () => {
    // The agent's pre-flight guards against empty patches separately;
    // the classifier's job is only the path scope.
    const result = classifyAllTargets([]);
    expect(result.decision).toBe('ALLOWED');
    expect(result.blocked).toEqual([]);
  });
});

describe('getRepoRoot()', () => {
  it('returns an absolute path ending in the working repo dir name', () => {
    const root = getRepoRoot();
    expect(root.startsWith('/')).toBe(true);
    expect(root.endsWith(process.cwd().split('/').pop() ?? '')).toBe(true);
  });
});
