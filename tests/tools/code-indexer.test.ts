/**
 * Tests for src/tools/code-indexer.ts — specifically that the extractor
 * actually emits ref_type='call', 'type', and 'api_call' rows.
 *
 * Background: graphify decline review (2026-05-30) found code_graph held
 * 5,740 rows with ZERO entries for those three ref_types — the extractors
 * were silently under-emitting. These tests pin the fix so a future regression
 * fails CI loudly instead of silently shipping a half-empty graph.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractEdgesFromSource,
  __test_only_nonTs__,
} from '../../src/tools/code-indexer.js';
import type { RepoConfig } from '../../src/services/config.js';

const opts = { repoName: 'example-service', repoLocalPath: '/repos/example-service', relPath: 'src/example.ts' };

describe('code-indexer: ref_type emission', () => {
  it('emits at least one call edge for a normal function-calling file', () => {
    const src = `
      import { helper } from './helper.js';
      export function doWork() {
        const result = helper(42);
        return computeStuff(result);
      }
      function computeStuff(n: number) { return n * 2; }
    `;
    const edges = extractEdgesFromSource(src, opts);
    const callEdges = edges.filter((e) => e.ref_type === 'call');
    // helper() and computeStuff() are both non-noisy named callees → 2+ rows
    expect(callEdges.length).toBeGreaterThanOrEqual(2);
    expect(callEdges.some((e) => e.ref_symbol === 'helper')).toBe(true);
    expect(callEdges.some((e) => e.ref_symbol === 'computeStuff')).toBe(true);
  });

  it('does NOT emit call edges for noisy callees (console.log, expect, push)', () => {
    const src = `
      const xs: number[] = [];
      console.log('hi');
      console.warn('bye');
      xs.push(1);
      xs.map((n) => n + 1);
    `;
    const edges = extractEdgesFromSource(src, opts);
    const calls = edges.filter((e) => e.ref_type === 'call').map((e) => e.ref_symbol);
    expect(calls).not.toContain('log');
    expect(calls).not.toContain('warn');
    expect(calls).not.toContain('push');
    expect(calls).not.toContain('map');
  });

  it('emits ref_type=type for `import type { ... }` declarations', () => {
    const src = `
      import type { RepoConfig } from './config.js';
      import { Project } from './proj.js';
      export const x: RepoConfig | null = null;
      export const p = new Project();
    `;
    const edges = extractEdgesFromSource(src, opts);
    const typeEdges = edges.filter((e) => e.ref_type === 'type');
    // Expect at least: (a) import-type decl edge, (b) TypeReference RepoConfig
    expect(typeEdges.length).toBeGreaterThanOrEqual(1);
    // The import declaration itself should be classified as 'type'
    expect(typeEdges.some((e) => e.ref_file.includes('config'))).toBe(true);
    // Plain `import { Project }` should still be 'import', not 'type'
    const importEdges = edges.filter((e) => e.ref_type === 'import');
    expect(importEdges.some((e) => e.ref_file.includes('proj'))).toBe(true);
  });

  it('emits api_call edges for axios.get, axios.post, and template-literal fetch', () => {
    const src = `
      import axios from 'axios';
      const baseUrl = '/api';
      async function load() {
        await axios.get('/api/users');
        await axios.post('/api/users', { name: 'a' });
        await fetch(\`\${baseUrl}/api/items/42\`);
        await client.get('/api/sessions');
        await axios({ url: '/api/widgets', method: 'GET' });
      }
    `;
    const edges = extractEdgesFromSource(src, opts);
    const apiEdges = edges.filter((e) => e.ref_type === 'api_call');
    // Each of the 5 calls above should produce an api_call row.
    expect(apiEdges.length).toBeGreaterThanOrEqual(4);
    const refFiles = apiEdges.map((e) => e.ref_file);
    expect(refFiles).toContain('/api/users');
    expect(refFiles.some((f) => f.startsWith('/api/items'))).toBe(true);
    expect(refFiles).toContain('/api/sessions');
    expect(refFiles).toContain('/api/widgets');
  });

  it('still emits literal fetch("/api/...") api_call edges (regression check)', () => {
    const src = `
      async function go() {
        await fetch('/api/legacy');
      }
    `;
    const edges = extractEdgesFromSource(src, opts);
    const apiEdges = edges.filter((e) => e.ref_type === 'api_call');
    expect(apiEdges.length).toBe(1);
    expect(apiEdges[0].ref_file).toBe('/api/legacy');
  });

  it('does NOT emit call edges for vitest matchers or zod schema constructors (ADR-028 F3 ignore-list)', () => {
    // Phase 73 F3 verdict (2026-05-31, sample-100): vitest matchers and zod
    // schema constructors dominated the call-edge population in the live DB.
    // The ignore-list in NOISY_CALLEES filters them at extraction time.
    const src = `
      import { z } from 'zod';
      const schema = z.object({ name: z.string(), n: z.int() });
      const arr = z.array(z.union([z.string(), z.optional(z.string())]));
      const enumLike = z.enum(['a', 'b']);
      const parsed = schema.safeParse({});
      expect(parsed).toBe(true);
      expect(parsed).toEqual({});
      expect(el).toContain('x');
      expect(el).toBeVisible();
      expect(el).toBeInTheDocument();
      expect(fn).toHaveBeenCalled();
      expect(fn).toHaveBeenCalledWith('a');
      expect(el).toHaveAttribute('aria-label');
      expect(n).toBeLessThanOrEqual(10);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(() => fn()).toThrow();
      expect(x).toBeUndefined();
      expect(x).toBeNull();
    `;
    const edges = extractEdgesFromSource(src, opts);
    const calls = edges.filter((e) => e.ref_type === 'call').map((e) => e.ref_symbol);
    // Vitest matchers MUST NOT appear as call edges.
    for (const matcher of [
      'toBe', 'toBeUndefined', 'toBeNull', 'toBeVisible', 'toBeInTheDocument',
      'toContain', 'toEqual', 'toHaveBeenCalled', 'toHaveBeenCalledWith',
      'toHaveAttribute', 'toBeLessThanOrEqual', 'toBeGreaterThanOrEqual', 'toThrow',
    ]) {
      expect(calls, `vitest matcher "${matcher}" leaked through NOISY_CALLEES`).not.toContain(matcher);
    }
    // Zod schema constructors MUST NOT appear as call edges.
    for (const zodMethod of ['object', 'array', 'string', 'enum', 'optional', 'union', 'int', 'safeParse']) {
      expect(calls, `zod method "${zodMethod}" leaked through NOISY_CALLEES`).not.toContain(zodMethod);
    }
  });

  it('does NOT emit call edges for Math.* stdlib methods (ADR-028 F-028-1 ignore-list)', () => {
    // F-028-1 (2026-05-31): Math namespace stdlib methods are call-edge noise
    // — they appear in any numeric code but carry near-zero blast-radius signal.
    const src = `
      function compute(x: number, a: number, b: number, n: number) {
        const a1 = Math.floor(x);
        const a2 = Math.ceil(x);
        const a3 = Math.round(x);
        const a4 = Math.abs(x);
        const a5 = Math.max(a, b);
        const a6 = Math.min(a, b);
        const a7 = Math.sqrt(n);
        const a8 = Math.pow(a, b);
        const a9 = Math.random();
        const a10 = Math.log2(n);
        const a11 = Math.log10(n);
        const a12 = Math.trunc(x);
        const a13 = Math.sign(x);
        return a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8 + a9 + a10 + a11 + a12 + a13;
      }
    `;
    const edges = extractEdgesFromSource(src, opts);
    const calls = edges.filter((e) => e.ref_type === 'call').map((e) => e.ref_symbol);
    for (const m of [
      'floor', 'ceil', 'round', 'abs', 'max', 'min', 'sqrt', 'pow',
      'random', 'log2', 'log10', 'trunc', 'sign',
    ]) {
      expect(calls, `Math.${m} leaked through NOISY_CALLEES`).not.toContain(m);
    }
  });

  it('does NOT emit api_call for non-HTTP method calls with non-URL args', () => {
    // ".post" on a non-axios/non-client object with a non-URL first arg should
    // not be classified as an api_call. This guards against false-positives.
    const src = `
      const board = { post: (msg: string) => console.log(msg) };
      board.post('hello world');
    `;
    const edges = extractEdgesFromSource(src, opts);
    const apiEdges = edges.filter((e) => e.ref_type === 'api_call');
    expect(apiEdges.length).toBe(0);
  });
});

/**
 * Drift-prevention test for the two non-TS extractor surfaces.
 *
 * Phase 73 / ADR-028 F2: extractNonTsEdges (full-sweep dispatcher) and
 * extractNonTsEdgesForFile (incremental per-file dispatcher) must recognize
 * the same set of file shapes. Adding a new shape to one without the other
 * silently drops edges on every incremental tick. Both methods now carry
 * SYNC INVARIANT JSDocs naming each other; this test pins the invariant.
 *
 * Each fixture is exercised against both extractNonTsEdges and
 * extractNonTsEdgesForFile. The test fails if their ref_type sets differ.
 */
describe('code-indexer: non-TS extractor sync invariant (ADR-028 F2)', () => {
  let scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; tmpdir is already isolated
      }
    }
    scratchDirs = [];
  });

  function makeScratch(repoName: string): { repo: RepoConfig; root: string } {
    const root = mkdtempSync(join(tmpdir(), 'adr028-f2-'));
    scratchDirs.push(root);
    return {
      repo: {
        name: repoName,
        localPath: root,
        // RepoConfig may carry other fields; cast through unknown so the test
        // does not couple to fields irrelevant to the extractor surface.
      } as unknown as RepoConfig,
      root,
    };
  }

  // Each fixture writes ONE file matching the named shape into a fresh scratch
  // dir, then runs both extractor surfaces against it (full-sweep walks the
  // dir, per-file is given the absolute path). Both MUST produce at least one
  // edge whose ref_type matches expected_ref_type.
  const FIXTURES = [
    {
      shape: 'Dockerfile',
      basename: 'Dockerfile',
      content: 'FROM node:20-alpine\n',
      expected_ref_type: 'docker_base_image' as const,
    },
    {
      shape: 'Helm Chart.yaml',
      basename: 'Chart.yaml',
      content:
        'apiVersion: v2\nname: parent-chart\nversion: 0.1.0\ndependencies:\n  - name: redis\n    version: 1.0.0\n    repository: https://example.com\n',
      expected_ref_type: 'helm_chart_dep' as const,
    },
    {
      shape: 'Shell .sh',
      basename: 'deploy.sh',
      content: '#!/bin/bash\necho "$DEPLOY_TOKEN $REGION"\n',
      expected_ref_type: 'shell_env_ref' as const,
    },
  ];

  for (const fx of FIXTURES) {
    it(`${fx.shape} — both extractNonTsEdges and extractNonTsEdgesForFile produce ${fx.expected_ref_type}`, () => {
      const { repo, root } = makeScratch('test-repo');
      const absPath = join(root, fx.basename);
      writeFileSync(absPath, fx.content, 'utf8');

      // Full-sweep dispatcher walks the scratch root.
      const fullSweepEdges = __test_only_nonTs__.extractNonTsEdges(repo);
      // Per-file dispatcher takes the absolute path directly.
      const perFileEdges = __test_only_nonTs__.extractNonTsEdgesForFile(repo, absPath, fx.basename);

      // Both must produce at least one edge.
      expect(fullSweepEdges.length, `extractNonTsEdges produced 0 edges for ${fx.shape}`).toBeGreaterThan(0);
      expect(perFileEdges.length, `extractNonTsEdgesForFile produced 0 edges for ${fx.shape}`).toBeGreaterThan(0);

      // Both must include the expected ref_type.
      expect(
        fullSweepEdges.some((e) => e.ref_type === fx.expected_ref_type),
        `extractNonTsEdges did not produce ${fx.expected_ref_type} for ${fx.shape}`,
      ).toBe(true);
      expect(
        perFileEdges.some((e) => e.ref_type === fx.expected_ref_type),
        `extractNonTsEdgesForFile did not produce ${fx.expected_ref_type} for ${fx.shape}`,
      ).toBe(true);

      // The set of ref_types produced should be identical between the two
      // surfaces. (config_ref is full-sweep-only by design and is excluded
      // from this comparison — the SYNC INVARIANT on the JSDoc allows it.)
      const fullSet = new Set(fullSweepEdges.map((e) => e.ref_type).filter((t) => t !== 'config_ref'));
      const perFileSet = new Set(perFileEdges.map((e) => e.ref_type));
      expect([...fullSet].sort()).toEqual([...perFileSet].sort());
    });
  }

  it('synthetic drift probe — Procfile must produce zero edges from BOTH extractNonTsEdges and extractNonTsEdgesForFile', () => {
    // If a future commit teaches one dispatcher about Procfiles but not the
    // other, this test fails — exactly the drift mode F2 is meant to catch.
    const { repo, root } = makeScratch('test-repo-procfile');
    const absPath = join(root, 'Procfile');
    writeFileSync(absPath, 'web: node server.js\n', 'utf8');

    const fullSweepEdges = __test_only_nonTs__.extractNonTsEdges(repo);
    const perFileEdges = __test_only_nonTs__.extractNonTsEdgesForFile(repo, absPath, 'Procfile');

    expect(fullSweepEdges, 'extractNonTsEdges grew Procfile coverage that extractNonTsEdgesForFile lacks').toEqual([]);
    expect(perFileEdges, 'extractNonTsEdgesForFile grew Procfile coverage that extractNonTsEdges lacks').toEqual([]);
  });

  it('config_ref is intentionally absent from extractNonTsEdgesForFile (documented exception)', () => {
    // Operations YAML/JSON env-var scan only fires from the full-sweep path.
    // Verifying the absence is part of pinning the SYNC INVARIANT exception
    // so a future commit cannot quietly mirror it onto the per-file dispatcher
    // without updating the JSDoc and this test.
    const { repo, root } = makeScratch('example-service');
    mkdirSync(join(root, 'manifests'), { recursive: true });
    const yamlPath = join(root, 'manifests', 'sample.yaml');
    writeFileSync(yamlPath, 'env:\n  - name: SOME_VAR\n    value: ${HOST_NAME}\n', 'utf8');

    const perFileEdges = __test_only_nonTs__.extractNonTsEdgesForFile(repo, yamlPath, 'manifests/sample.yaml');
    expect(perFileEdges.filter((e) => e.ref_type === 'config_ref')).toEqual([]);
  });
});
