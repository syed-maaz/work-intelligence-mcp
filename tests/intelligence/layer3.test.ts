import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { traceCallGraph, type TraceOutput } from '../../src/intelligence/tools/call-graph-tracer.js';
import { readFile, readChangedFiles, type GitCommitEntry } from '../../src/intelligence/tools/file-reader.js';
import { evaluateExternalDepSignal, type DepChange } from '../../src/intelligence/tools/external-dep-signal.js';
import type { OwnershipEntry } from '../../src/intelligence/ownership-map.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function openTestDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_graph (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      file_path TEXT NOT NULL,
      symbol TEXT,
      ref_repo TEXT NOT NULL,
      ref_file TEXT NOT NULL,
      ref_symbol TEXT,
      ref_type TEXT NOT NULL,
      line_number INTEGER,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type)
    )
  `);
  return db;
}

interface CodeGraphRow {
  repo: string;
  file_path: string;
  ref_file: string;
  ref_type: string;
  ref_repo: string;
  symbol?: string;
  ref_symbol?: string;
}

function seedCodeGraph(db: Database.Database, rows: CodeGraphRow[]): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO code_graph (repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    stmt.run(row.repo, row.file_path, row.symbol ?? null, row.ref_repo, row.ref_file, row.ref_symbol ?? null, row.ref_type);
  }
}

// Seed a deep call chain: start.ts → level1.ts → level2.ts → ... → levelN.ts
function seedDeepCallGraph(db: Database.Database, depth: number): void {
  const rows: CodeGraphRow[] = [];
  for (let i = 0; i < depth; i++) {
    rows.push({
      repo: 'example-service',
      file_path: i === 0 ? 'start.ts' : `level${i}.ts`,
      ref_file: `level${i + 1}.ts`,
      ref_type: 'call',
      ref_repo: 'example-service',
    });
  }
  seedCodeGraph(db, rows);
}

// Minimal ownership map for tests
const DEFAULT_OWNERSHIP_MAP: OwnershipEntry[] = [
  { repo: 'example-service', glob: 'apps/**',   team: 'Saturn' },
  { repo: 'example-service', glob: 'packages/**', team: 'Saturn' },
  { repo: 'example-service', glob: '**',         team: 'Saturn' },
  { repo: 'example-service',       glob: '**', team: 'Platform' },
];

// Create a temp directory that acts as a mock repo with a file
function createMockRepo(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'test-repo-'));
  for (const f of files) {
    const fullPath = join(dir, f);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, `// mock file: ${f}\nexport const x = 1;\n`);
  }
  return dir;
}

// Create a mock repo with specific content for a file
function createMockRepoWithContent(file: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'test-repo-'));
  const fullPath = join(dir, file);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
  return dir;
}

// Empty trace for signal tests
const emptyTrace: TraceOutput = {
  nodes: [],
  edges: [],
  externalDeps: [],
  crossRepoBoundaries: [],
  maxDepthReached: false,
  summary: '',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Layer 3: Symptom-Driven Code Layer', () => {

  describe('traceCallGraph()', () => {
    it('traces recommended links to smrdp-ui-plugins boundary', () => {
      const db = openTestDatabase();
      seedCodeGraph(db, [
        {
          repo: 'example-service',
          file_path: 'apps/recommended-links/useRecommendedLinks.ts',
          ref_file: 'apps/recommended-links/getRecommendedLinks.ts',
          ref_type: 'call', ref_repo: 'example-service',
        },
        {
          repo: 'example-service',
          file_path: 'apps/recommended-links/getRecommendedLinks.ts',
          ref_file: 'webapps/plugins/Component.js',
          ref_type: 'api_call', ref_repo: 'smrdp-ui-plugins',
        },
      ]);

      const result = traceCallGraph(
        { repo: 'example-service', startFile: 'apps/recommended-links/useRecommendedLinks.ts', direction: 'callees', maxDepth: 3 },
        db, DEFAULT_OWNERSHIP_MAP
      );

      expect(result.crossRepoBoundaries).toHaveLength(1);
      expect(result.crossRepoBoundaries[0].toRepo).toBe('smrdp-ui-plugins');
      expect(result.externalDeps).toContain('smrdp-ui-plugins');
    });

    it('returns start node with informative summary when code_graph is not indexed', () => {
      const db = openTestDatabase(); // empty code_graph
      const result = traceCallGraph(
        { repo: 'example-service', startFile: 'apps/auth/middleware.ts', direction: 'callees', maxDepth: 3 },
        db, DEFAULT_OWNERSHIP_MAP
      );
      expect(result.nodes).toHaveLength(1); // the start node itself
      expect(result.summary).toContain('code_graph may not be indexed');
    });

    it('respects maxDepth limit', () => {
      const db = openTestDatabase();
      seedDeepCallGraph(db, 10); // 10-level deep chain
      const result = traceCallGraph(
        { repo: 'example-service', startFile: 'start.ts', direction: 'callees', maxDepth: 3 },
        db, DEFAULT_OWNERSHIP_MAP
      );
      // Should stop at depth 3, not traverse all 10
      expect(result.nodes.length).toBeLessThanOrEqual(4); // start + 3 levels
    });

    it('detects visited nodes and avoids infinite cycles', () => {
      const db = openTestDatabase();
      // Create a cycle: a.ts → b.ts → a.ts
      seedCodeGraph(db, [
        { repo: 'example-service', file_path: 'a.ts', ref_file: 'b.ts', ref_type: 'call', ref_repo: 'example-service' },
        { repo: 'example-service', file_path: 'b.ts', ref_file: 'a.ts', ref_type: 'call', ref_repo: 'example-service' },
      ]);
      const result = traceCallGraph(
        { repo: 'example-service', startFile: 'a.ts', direction: 'callees', maxDepth: 5 },
        db, DEFAULT_OWNERSHIP_MAP
      );
      // Should not hang or stack overflow
      expect(result.nodes.length).toBeLessThanOrEqual(3);
    });
  });

  describe('readChangedFiles()', () => {
    it('skips test files and lockfiles', () => {
      const commits: GitCommitEntry[] = [{
        sha: 'abc', date: '2026-04-16', author: 'bot', message: 'bump',
        isDependencyBump: true,
        filesChanged: [
          'package.json',
          'package-lock.json',              // should skip
          'apps/auth/middleware.ts',         // should include
          'apps/auth/middleware.test.ts',    // should skip
        ],
      }];

      const mockRepoPaths = { workspace: createMockRepo(['apps/auth/middleware.ts', 'package.json']) };
      const results = readChangedFiles(commits, mockRepoPaths, 5);

      expect(results.map(r => r.filePath)).toContain('apps/auth/middleware.ts');
      expect(results.map(r => r.filePath)).not.toContain('package-lock.json');
      expect(results.map(r => r.filePath)).not.toContain('apps/auth/middleware.test.ts');
    });

    it('caps at maxFiles', () => {
      const dir = mkdtempSync(join(tmpdir(), 'test-repo-'));
      const files = Array.from({ length: 20 }, (_, i) => `apps/file${i}.ts`);
      for (const f of files) {
        const fullPath = join(dir, f);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, `export const x${f} = 1;\n`);
      }
      const commits: GitCommitEntry[] = [{
        sha: 'abc123', date: '2026-04-16', author: 'dev', message: 'add files',
        isDependencyBump: false,
        filesChanged: files,
      }];
      const mockRepoPaths = { 'example-service': dir };
      const results = readChangedFiles(commits, mockRepoPaths, 5);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('truncates large files at maxLines', () => {
      const largeFile = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
      const mockRepoPaths = { 'example-service': createMockRepoWithContent('apps/big.ts', largeFile) };
      const result = readFile({ file: 'apps/big.ts', repo: 'example-service', maxLines: 400 }, mockRepoPaths);
      expect(result.truncated).toBe(true);
      expect(result.content.split('\n').length).toBe(400);
    });

    it('returns full content when file is within the line cap', () => {
      const smallFile = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
      const mockRepoPaths = { 'example-service': createMockRepoWithContent('apps/small.ts', smallFile) };
      const result = readFile({ file: 'apps/small.ts', repo: 'example-service', maxLines: 400 }, mockRepoPaths);
      expect(result.truncated).toBe(false);
      expect(result.lineCount).toBe(10);
    });

    it('throws when repo is not in repoPaths', () => {
      expect(() => readFile({ file: 'some/file.ts', repo: 'unknown-repo', maxLines: 400 }, {}))
        .toThrow('Unknown repo: unknown-repo');
    });
  });

  describe('signalExternalDep()', () => {
    it('triggers HIGH confidence when dep bump + external boundary both present', () => {
      const signal = evaluateExternalDepSignal(
        [{ packageName: '@types/openui5', from: '1.145.0', to: '1.146.0', type: 'changed' }],
        { crossRepoBoundaries: [{ fromRepo: 'example-service', toRepo: 'smrdp-ui-plugins', via: 'Component.js' }], nodes: [], edges: [], externalDeps: ['smrdp-ui-plugins'], maxDepthReached: false, summary: '' },
        'BIS Recommended Links Not Showing'
      );
      expect(signal.triggered).toBe(true);
      expect(signal.confidence).toBe('high');
      expect(signal.depName).toBe('@types/openui5');
    });

    it('does not trigger when neither dep bump nor external boundary', () => {
      const signal = evaluateExternalDepSignal([], emptyTrace, 'Some bug');
      expect(signal.triggered).toBe(false);
    });

    it('triggers MEDIUM confidence with only dep bump (no trace boundary)', () => {
      const signal = evaluateExternalDepSignal(
        [{ packageName: 'lodash', from: '4.17.20', to: '4.17.21', type: 'changed' }],
        emptyTrace,
        'Some bug'
      );
      expect(signal.triggered).toBe(true);
      expect(signal.confidence).toBe('medium');
    });

    it('triggers LOW confidence with only external boundary (no dep bump)', () => {
      const signal = evaluateExternalDepSignal(
        [],
        { ...emptyTrace, crossRepoBoundaries: [{ fromRepo: 'example-service', toRepo: 'smrdp-ui-plugins', via: 'webapps/Component.js' }] },
        'Behavior changed after deploy'
      );
      expect(signal.triggered).toBe(true);
      expect(signal.confidence).toBe('low');
      expect(signal.affectedPath).toBe('webapps/Component.js');
    });

    it('includes dep version info in reason for medium confidence', () => {
      const changes: DepChange[] = [{ packageName: 'react', from: '18.0.0', to: '18.1.0', type: 'changed' }];
      const signal = evaluateExternalDepSignal(changes, emptyTrace, 'React rendering bug');
      expect(signal.reason).toContain('react');
      expect(signal.fromVersion).toBe('18.0.0');
      expect(signal.toVersion).toBe('18.1.0');
    });
  });
});
