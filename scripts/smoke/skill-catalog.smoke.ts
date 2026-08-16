/**
 * § 25 — SKILL_CATALOG buildRequest unit tests (CYPHER-NEXT-CATALOG).
 *
 * Verifies the pure regex-extraction logic of newly wired skills:
 *   - wi-pr-review extracts (repo, pr) from goal text in several shapes
 *   - wi-blast-radius extracts (repo, file) from path-shaped tokens
 *   - both return null when the goal has nothing to bind to
 *   - existing wi-search and wi-investigate still bind the way they did
 *
 * These are direct imports of the catalog — no bridge involved. The
 * bridge integration is already covered by § 22 (auto-link) which
 * exercises the dispatch path that consumes the catalog.
 */

import { describe, expect, test } from 'vitest';
import { SKILL_CATALOG, categoryOf } from '../../dist/services/cypher/skills.js';

describe('§ 25 — SKILL_CATALOG buildRequest', () => {
  describe('§ 25.1 — wi-pr-review', () => {
    const spec = SKILL_CATALOG['wi-pr-review'];

    test('§ 25.1.1 — registered as auto-class with GET /api/pr/review', () => {
      expect(spec).toBeDefined();
      expect(spec.category).toBe('auto');
      expect(spec.endpoint).toBe('/api/pr/review');
      expect(spec.method).toBe('GET');
      expect(categoryOf('wi-pr-review')).toBe('auto');
    });

    test('§ 25.1.2 — extracts PR number from "PR-4167" shape', () => {
      const r = spec.buildRequest!('Review PR-4167 for the bot findings.', undefined);
      expect(r).not.toBeNull();
      expect(r!.query).toEqual({ repo: 'example-service', pr: '4167' });
    });

    test('§ 25.1.3 — extracts PR number from "#4080" shape', () => {
      const r = spec.buildRequest!('Look at #4080 — it just merged.', undefined);
      expect(r).not.toBeNull();
      expect(r!.query!.pr).toBe('4080');
    });

    test('§ 25.1.4 — extracts PR number from "pull/3858" shape', () => {
      const r = spec.buildRequest!('See pull/3858 for the oRPC adapter fix.', undefined);
      expect(r).not.toBeNull();
      expect(r!.query!.pr).toBe('3858');
    });

    test('§ 25.1.5 — repo:operations override surfaces in query', () => {
      const r = spec.buildRequest!('Review PR-100 repo:operations for the deploy config.', undefined);
      expect(r).not.toBeNull();
      expect(r!.query!.repo).toBe('example-service');
      expect(r!.query!.pr).toBe('100');
    });

    test('§ 25.1.6 — returns null when no PR number present', () => {
      const r = spec.buildRequest!('Random goal with no PR reference.', undefined);
      expect(r).toBeNull();
    });
  });

  describe('§ 25.2 — wi-blast-radius', () => {
    const spec = SKILL_CATALOG['wi-blast-radius'];

    test('§ 25.2.1 — registered as auto-class with GET /api/code-graph/blast-radius', () => {
      expect(spec).toBeDefined();
      expect(spec.category).toBe('auto');
      expect(spec.endpoint).toBe('/api/code-graph/blast-radius');
      expect(spec.method).toBe('GET');
    });

    test('§ 25.2.2 — extracts a typical src/.../foo.ts path', () => {
      const r = spec.buildRequest!('Blast radius of changing src/auth/login.ts', undefined);
      expect(r).not.toBeNull();
      expect(r!.query).toEqual({ repo: 'example-service', file: 'src/auth/login.ts' });
    });

    test('§ 25.2.3 — extracts a tsx path under web/', () => {
      const r = spec.buildRequest!('What touches web/src/pages/CypherPage.tsx', undefined);
      expect(r).not.toBeNull();
      expect(r!.query!.file).toBe('web/src/pages/CypherPage.tsx');
    });

    test('§ 25.2.4 — repo:operations override surfaces in query', () => {
      const r = spec.buildRequest!('Check repo:operations infra/kustomize/dev.yaml dependencies… nope wait, scripts/install.sh', undefined);
      expect(r).not.toBeNull();
      expect(r!.query!.repo).toBe('example-service');
      // First match wins — scripts/install.sh has the right extension.
      // (infra/kustomize/dev.yaml lacks a recognized source extension.)
      expect(r!.query!.file).toBe('scripts/install.sh');
    });

    test('§ 25.2.5 — returns null when no path-shaped token present', () => {
      const r = spec.buildRequest!('Just a goal mentioning some files but not real paths.', undefined);
      expect(r).toBeNull();
    });

    test('§ 25.2.6 — returns null on bare README (no source extension)', () => {
      const r = spec.buildRequest!('Update docs/README.md', undefined);
      expect(r).toBeNull();
    });
  });

  describe('§ 25.3 — pre-existing skills still bind correctly', () => {
    test('§ 25.3.1 — wi-search returns body with full goal as query', () => {
      const r = SKILL_CATALOG['wi-search'].buildRequest!('Find anything about DEMO-15702.', undefined);
      expect(r).not.toBeNull();
      expect((r as { body: { query: string; limit: number } }).body.query).toBe('Find anything about DEMO-15702.');
    });

    test('§ 25.3.2 — wi-investigate still extracts Jira key', () => {
      const r = SKILL_CATALOG['wi-investigate'].buildRequest!('Investigate DEMO-16141 thoroughly.', undefined);
      expect(r).not.toBeNull();
      expect((r as { body: { key: string } }).body.key).toBe('DEMO-16141');
    });
  });

  describe('§ 25.4 — wi-jira-analyze is auto with no buildRequest (audited per ADR-036 PHASE-86-01)', () => {
    test('§ 25.4.1 — categoryOf returns "auto" (writes only to WI DB; audited as not posting to Jira)', () => {
      expect(categoryOf('wi-jira-analyze')).toBe('auto');
      // No buildRequest means the auto-class skill cataloged but unwirable
      // today; runtime falls through to the default-skip branch with a
      // /skill-name suggestion (see run.ts execute stage).
      expect(SKILL_CATALOG['wi-jira-analyze'].buildRequest).toBeUndefined();
    });
  });
});

// ── § 30 — ADR-036 PHASE-86-01: 3-way taxonomy verifier ────────────────────
// Per AC L1.1-A-05 / AC-86.1.5: SKILL_CATALOG declares one of
// auto|confirm|cli for every entry; zero 'unknown' or 'read' or 'write'
// values remain. Per AC-86.1.2: categoryOf defaults non-wi-* to 'cli'
// and unknown wi-* to 'confirm'.
describe('§ 30 — ADR-036 3-way skill taxonomy', () => {
  test('§ 30.1 — every SKILL_CATALOG entry declares auto | confirm | cli (no legacy values)', () => {
    const allowed = new Set(['auto', 'confirm', 'cli']);
    const violations: Array<{ skill: string; category: string }> = [];
    for (const [name, spec] of Object.entries(SKILL_CATALOG)) {
      if (!allowed.has(spec.category)) {
        violations.push({ skill: name, category: spec.category });
      }
    }
    expect(violations).toEqual([]);
  });

  test('§ 30.2 — categoryOf default for non-wi-* is "cli" (Claude Code skills)', () => {
    expect(categoryOf('deep-research')).toBe('cli');
    expect(categoryOf('frontend-design')).toBe('cli');
    expect(categoryOf('mem-search')).toBe('cli');
    expect(categoryOf('engineering-skills')).toBe('cli');
  });

  test('§ 30.3 — categoryOf default for un-cataloged wi-* is "confirm" (conservative)', () => {
    // A wi-* skill we haven't cataloged yet should default to confirm
    // (surface + wait for user) rather than auto (silently invoke).
    expect(categoryOf('wi-not-yet-cataloged-thing')).toBe('confirm');
  });

  test('§ 30.4 — every previously-"unknown" wi-* skill is now "auto"', () => {
    // The 10 skills the v1 catalog left as 'unknown' all moved to 'auto'
    // per AC L1.1-A-03. Re-asserting the move here so a future regression
    // (someone adding 'unknown' back) fails fast.
    const promoted = [
      'wi-jira-analyze', 'wi-pre-meeting', 'wi-morning-brief', 'wi-action-items',
      'wi-bug-report', 'wi-search-all', 'wi-teams-search', 'wi-daily-digest',
      'wi-check-links', 'wi-skill-install',
    ];
    for (const skill of promoted) {
      expect(categoryOf(skill)).toBe('auto');
    }
  });

  test('§ 30.5 — wi-save-to-ticket is the only confirm-class entry (leaks to Jira)', () => {
    const confirmEntries = Object.entries(SKILL_CATALOG)
      .filter(([_, spec]) => spec.category === 'confirm')
      .map(([name]) => name);
    expect(confirmEntries).toEqual(['wi-save-to-ticket']);
  });

  test('§ 30.6 — WI-internal writes (sync, update-context, bug-resolve*) are auto', () => {
    expect(categoryOf('wi-update-context')).toBe('auto');
    expect(categoryOf('wi-bug-resolve')).toBe('auto');
    expect(categoryOf('wi-bug-resolve-all')).toBe('auto');
    expect(categoryOf('wi-sync')).toBe('auto');
  });
});
