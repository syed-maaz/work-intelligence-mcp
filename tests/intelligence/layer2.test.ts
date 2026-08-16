/**
 * Layer 2: Temporal Investigation — Unit Tests
 * Phase 55 Wave 2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  extractRegressionDate,
  addDays,
  window as regressionWindow,
} from '../../src/intelligence/regression-date-extractor.js';

import {
  gitLogWindow,
  parseGitLog,
  formatGitSummary,
} from '../../src/intelligence/tools/git-log-window.js';

import { extractDepChanges } from '../../src/intelligence/tools/dep-diff.js';
import type { GitCommitEntry } from '../../src/intelligence/tools/git-log-window.js';

// ---------------------------------------------------------------------------
// Mock child_process
// ---------------------------------------------------------------------------

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
const mockExec = vi.mocked(execFileSync);

/**
 * Sets up execFileSync to return different values based on the joined args string.
 * Pass `new Error(...)` as a value to make that call throw.
 */
function mockExecFileSync(responses: Record<string, string | Error>): void {
  mockExec.mockReset();
  mockExec.mockImplementation((_cmd: unknown, args: unknown) => {
    const key = (args as string[]).join(' ');
    // Find the first matching pattern
    for (const [pattern, value] of Object.entries(responses)) {
      if (pattern === '*' || key.includes(pattern)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    // Default: return empty string
    return '';
  });
}

// ---------------------------------------------------------------------------
// extractRegressionDate()
// ---------------------------------------------------------------------------

describe('Layer 2: Temporal Investigation', () => {

  describe('extractRegressionDate()', () => {

    it('extracts "since April 17" as explicit date', () => {
      const r = extractRegressionDate(
        'BIS links broken since April 17',
        '',
        '2026-04-20',
        '2026-04-20',
      );
      expect(r.date).toBe('2026-04-17');
      expect(r.source).toBe('explicit');
      expect(r.confidence).toBe('high');
      expect(r.windowStart).toBe('2026-04-14');
      expect(r.windowEnd).toBe('2026-04-19');
    });

    it('extracts "after yesterday" as relative date', () => {
      const r = extractRegressionDate('Button broken since yesterday', '', '2026-04-21', '2026-04-21');
      expect(r.date).toBe('2026-04-20');
      expect(r.source).toBe('relative');
      expect(r.confidence).toBe('medium');
    });

    it('falls back to createdAt - 3 days when no date signal', () => {
      const r = extractRegressionDate('Button sometimes not clickable', '', '2026-04-21', '2026-04-21');
      expect(r.date).toBe('2026-04-18');
      expect(r.source).toBe('created_at');
      expect(r.confidence).toBe('low');
    });

    it('handles "broken since 2026-04-15" ISO date in description', () => {
      const r = extractRegressionDate('Bug', 'broken since 2026-04-15', '2026-04-21', '2026-04-21');
      expect(r.date).toBe('2026-04-15');
      expect(r.confidence).toBe('high');
    });

    it('handles "today" as relative date with offset 0', () => {
      const r = extractRegressionDate('Bug happens today', '', '2026-04-21', '2026-04-21');
      expect(r.date).toBe('2026-04-21');
      expect(r.source).toBe('relative');
      expect(r.confidence).toBe('medium');
    });

    it('handles "after last week" with offset -7', () => {
      const r = extractRegressionDate('Error started after last week', '', '2026-04-21', '2026-04-21');
      expect(r.date).toBe('2026-04-14');
      expect(r.source).toBe('relative');
    });

    it('computes windowStart and windowEnd correctly', () => {
      const r = extractRegressionDate('broken since 2026-04-10', '', '2026-04-21', '2026-04-21');
      expect(r.windowStart).toBe('2026-04-07');
      expect(r.windowEnd).toBe('2026-04-12');
    });

    it('rawMatch is null for created_at fallback', () => {
      const r = extractRegressionDate('No date info here', '', '2026-04-21', '2026-04-21');
      expect(r.rawMatch).toBeNull();
    });

    it('rawMatch is non-null for explicit date', () => {
      const r = extractRegressionDate('broken since 2026-04-15', '', '2026-04-21', '2026-04-21');
      expect(r.rawMatch).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // addDays() and window()
  // -------------------------------------------------------------------------

  describe('addDays()', () => {
    it('adds positive days', () => {
      expect(addDays('2026-04-17', 2)).toBe('2026-04-19');
    });

    it('subtracts days with negative offset', () => {
      expect(addDays('2026-04-17', -3)).toBe('2026-04-14');
    });

    it('handles month boundary', () => {
      expect(addDays('2026-03-31', 1)).toBe('2026-04-01');
    });
  });

  describe('window()', () => {
    it('returns date-3 and date+2', () => {
      const w = regressionWindow('2026-04-17');
      expect(w.windowStart).toBe('2026-04-14');
      expect(w.windowEnd).toBe('2026-04-19');
    });
  });

  // -------------------------------------------------------------------------
  // gitLogWindow()
  // -------------------------------------------------------------------------

  describe('gitLogWindow()', () => {

    beforeEach(() => {
      mockExec.mockReset();
    });

    it('detects @types/openui5 as dependency bump', async () => {
      const rawLog = [
        '44a5ed8912aabbccddee44a5ed8912aabbccddee|2026-04-16T10:00:00+00:00|dependabot|chore(deps): bump @types/openui5 from 1.145.0 to 1.146.0',
        'M\tpackage.json',
        'M\tpackage-lock.json',
      ].join('\n');

      const pkgCurrent = JSON.stringify({ devDependencies: { '@types/openui5': '1.146.0' } });
      const pkgParent  = JSON.stringify({ devDependencies: { '@types/openui5': '1.145.0' } });

      mockExec.mockReset();
      mockExec.mockImplementation((_cmd: unknown, args: unknown) => {
        const joined = (args as string[]).join(' ');
        if (joined.includes('log')) return rawLog;
        if (joined.includes('~1:package.json')) return pkgParent;
        if (joined.includes(':package.json')) return pkgCurrent;
        return '';
      });

      const result = await gitLogWindow(
        { repo: 'example-service', since: '2026-04-14', until: '2026-04-18' },
        { 'example-service': './repos/example-service' },
      );

      expect(result.commits).toHaveLength(1);
      expect(result.commits[0].isDependencyBump).toBe(true);
      expect(result.dependencyChanges).toContainEqual({
        packageName: '@types/openui5',
        from: '1.145.0',
        to: '1.146.0',
        type: 'changed',
      });
      expect(result.summary).toContain('1 commit');
      expect(result.summary).toContain('@types/openui5');
    });

    it('returns empty gracefully when git repo not accessible', async () => {
      mockExecFileSync({ '*': new Error('not a git repository') });
      const result = await gitLogWindow(
        { repo: 'example-service', since: '2026-04-14', until: '2026-04-18' },
        { 'example-service': './repos/example-service' },
      );
      expect(result.commits).toHaveLength(0);
      expect(result.summary).toContain('No git history');
    });

    it('returns empty when no commits in window', async () => {
      mockExecFileSync({ '*': '' });
      const result = await gitLogWindow(
        { repo: 'example-service', since: '2026-01-01', until: '2026-01-02' },
        { 'example-service': './repos/example-service' },
      );
      expect(result.commits).toHaveLength(0);
      expect(result.summary).toBe('No commits found in this date range.');
    });

    it('throws for unknown repo', async () => {
      await expect(
        // @ts-expect-error — intentionally passing unknown repo
        gitLogWindow({ repo: 'unknown', since: '2026-01-01', until: '2026-01-02' }, {}),
      ).rejects.toThrow('Unknown repo');
    });
  });

  // -------------------------------------------------------------------------
  // parseGitLog()
  // -------------------------------------------------------------------------

  describe('parseGitLog()', () => {

    it('returns empty array for empty string', () => {
      expect(parseGitLog('')).toHaveLength(0);
    });

    it('marks package.json commit as dependency bump', () => {
      const raw = [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|2026-04-16T10:00:00+00:00|dev|chore: update deps',
        'M\tpackage.json',
      ].join('\n');
      const commits = parseGitLog(raw);
      expect(commits).toHaveLength(1);
      expect(commits[0].isDependencyBump).toBe(true);
    });

    it('marks non-dep commit as isDependencyBump false', () => {
      const raw = [
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|2026-04-16T11:00:00+00:00|dev|fix: bug fix',
        'M\tsrc/app.ts',
      ].join('\n');
      const commits = parseGitLog(raw);
      expect(commits[0].isDependencyBump).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // formatGitSummary()
  // -------------------------------------------------------------------------

  describe('formatGitSummary()', () => {

    it('returns no-commits message for empty input', () => {
      expect(formatGitSummary([], [])).toBe('No commits found in this date range.');
    });

    it('includes commit count', () => {
      const commit: GitCommitEntry = {
        sha: 'abc1234500000000000000000000000000000000',
        date: '2026-04-16T10:00:00+00:00',
        author: 'dev',
        message: 'fix something',
        filesChanged: ['src/app.ts'],
        isDependencyBump: false,
      };
      const summary = formatGitSummary([commit], []);
      expect(summary).toContain('1 commit');
    });

    it('includes dependency changes section when present', () => {
      const commit: GitCommitEntry = {
        sha: 'def1234500000000000000000000000000000000',
        date: '2026-04-16T10:00:00+00:00',
        author: 'bot',
        message: 'bump lodash',
        filesChanged: ['package.json'],
        isDependencyBump: true,
      };
      const summary = formatGitSummary([commit], [
        { packageName: 'lodash', from: '4.17.20', to: '4.17.21', type: 'changed' },
      ]);
      expect(summary).toContain('Dependency changes');
      expect(summary).toContain('lodash');
    });
  });

  // -------------------------------------------------------------------------
  // extractDepChanges()
  // -------------------------------------------------------------------------

  describe('extractDepChanges()', () => {

    beforeEach(() => {
      mockExec.mockReset();
    });

    it('returns empty when no dep-bump commits', async () => {
      const commits: GitCommitEntry[] = [
        {
          sha: 'abc', date: '2026-04-16', author: 'dev', message: 'fix: bug',
          filesChanged: ['src/app.ts'], isDependencyBump: false,
        },
      ];
      const result = await extractDepChanges(commits, './repos/example-service');
      expect(result).toHaveLength(0);
    });

    it('identifies version bump as "changed"', async () => {
      const commits: GitCommitEntry[] = [
        {
          sha: 'abc123', date: '2026-04-16', author: 'bot', message: 'bump dep',
          filesChanged: ['package.json'], isDependencyBump: true,
        },
      ];

      mockExec.mockImplementation((_cmd: unknown, args: unknown) => {
        const joined = (args as string[]).join(' ');
        if (joined.includes('~1:package.json')) {
          return JSON.stringify({ dependencies: { lodash: '4.17.20' } });
        }
        return JSON.stringify({ dependencies: { lodash: '4.17.21' } });
      });

      const changes = await extractDepChanges(commits, './repos/example-service');
      expect(changes).toContainEqual({
        packageName: 'lodash',
        from: '4.17.20',
        to: '4.17.21',
        type: 'changed',
      });
    });

    it('identifies new package as "added"', async () => {
      const commits: GitCommitEntry[] = [
        {
          sha: 'def456', date: '2026-04-16', author: 'dev', message: 'add new-pkg',
          filesChanged: ['package.json'], isDependencyBump: true,
        },
      ];

      mockExec.mockImplementation((_cmd: unknown, args: unknown) => {
        const joined = (args as string[]).join(' ');
        if (joined.includes('~1:package.json')) {
          return JSON.stringify({ dependencies: {} });
        }
        return JSON.stringify({ dependencies: { 'new-pkg': '1.0.0' } });
      });

      const changes = await extractDepChanges(commits, './repos/example-service');
      expect(changes).toContainEqual({
        packageName: 'new-pkg',
        from: null,
        to: '1.0.0',
        type: 'added',
      });
    });

    it('identifies removed package as "removed"', async () => {
      const commits: GitCommitEntry[] = [
        {
          sha: 'ghi789', date: '2026-04-16', author: 'dev', message: 'remove old-pkg',
          filesChanged: ['package.json'], isDependencyBump: true,
        },
      ];

      mockExec.mockImplementation((_cmd: unknown, args: unknown) => {
        const joined = (args as string[]).join(' ');
        if (joined.includes('~1:package.json')) {
          return JSON.stringify({ dependencies: { 'old-pkg': '2.0.0' } });
        }
        return JSON.stringify({ dependencies: {} });
      });

      const changes = await extractDepChanges(commits, './repos/example-service');
      expect(changes).toContainEqual({
        packageName: 'old-pkg',
        from: '2.0.0',
        to: null,
        type: 'removed',
      });
    });

    it('returns empty when git show fails gracefully', async () => {
      const commits: GitCommitEntry[] = [
        {
          sha: 'badfail', date: '2026-04-16', author: 'bot', message: 'bump',
          filesChanged: ['package.json'], isDependencyBump: true,
        },
      ];

      mockExec.mockImplementation(() => { throw new Error('git error'); });

      const changes = await extractDepChanges(commits, './repos/example-service');
      expect(changes).toHaveLength(0);
    });

    it('processes at most 3 dep-bump commits', async () => {
      const commits: GitCommitEntry[] = Array.from({ length: 5 }, (_, i) => ({
        sha: `sha${i}`, date: '2026-04-16', author: 'bot', message: `bump ${i}`,
        filesChanged: ['package.json'], isDependencyBump: true,
      }));

      let callCount = 0;
      mockExec.mockImplementation((_cmd: unknown, args: unknown) => {
        const joined = (args as string[]).join(' ');
        if (joined.includes(':package.json')) callCount++;
        return JSON.stringify({ dependencies: {} });
      });

      await extractDepChanges(commits, './repos/example-service');
      // Each commit calls show twice (sha:pkg and sha~1:pkg), max 3 commits = 6 calls
      expect(callCount).toBeLessThanOrEqual(6);
    });
  });
});
