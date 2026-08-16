import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/db/schema.js';
import { getOwnership } from '../../src/intelligence/ownership-map.js';
import { KnowledgeIndexer } from '../../src/intelligence/knowledge-indexer.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function openTestDatabase(): Database.Database {
  const db = new Database(':memory:');
  initializeDatabase(db);
  return db;
}

let MOCK_REPO_PATH: string;

function createMockRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wi-test-repo-'));
  // Create ADR directory with a sample file
  const adrDir = join(dir, 'docs', 'docs', 'adr');
  mkdirSync(adrDir, { recursive: true });
  writeFileSync(join(adrDir, 'adr-001-test.md'), '# ADR-001: Test Decision\n\nWe decided to use SQLite for local storage.');
  writeFileSync(join(adrDir, 'adr-002-api.md'), '# ADR-002: REST API\n\nWe use a REST API for the web bridge.');
  // CLAUDE.md
  writeFileSync(join(dir, 'CLAUDE.md'), '# Claude Instructions\n\nThis is the CLAUDE.md file.');
  // README
  writeFileSync(join(dir, 'README.md'), '# example-service\n\nMain application README.');
  return dir;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Layer 1: Knowledge Base', () => {
  beforeEach(() => {
    MOCK_REPO_PATH = createMockRepo();
  });

  afterEach(() => {
    rmSync(MOCK_REPO_PATH, { recursive: true, force: true });
  });

  // ── getOwnership() ──────────────────────────────────────────────────────────

  describe('getOwnership()', () => {
    it('identifies external team as owner of thirdparty-ui-plugins/**', () => {
      const result = getOwnership('webapps/plugins/Component.js', 'thirdparty-ui-plugins');
      expect(result?.team).toBe('external');
    });

    it('identifies core as owner of app/**', () => {
      const result = getOwnership('apps/recommended-links/useRecommendedLinks.ts', 'app', [
        { repo: 'app', glob: 'apps/**', team: 'core' },
        { repo: 'app', glob: '**', team: 'core' },
      ]);
      expect(result?.team).toBe('core');
    });

    it('returns null for unknown repo', () => {
      expect(getOwnership('some/file.ts', 'unknown-repo')).toBeNull();
    });

    it('most-specific glob wins when multiple match', () => {
      // apps/** is more specific than **
      const result = getOwnership('apps/auth/middleware.ts', 'app', [
        { repo: 'app', glob: 'apps/**', team: 'core' },
        { repo: 'app', glob: '**', team: 'core' },
      ]);
      expect(result?.glob).toBe('apps/**');
    });
  });

  // ── KnowledgeIndexer ────────────────────────────────────────────────────────

  describe('KnowledgeIndexer', () => {
    it('indexes ADR files into codebase_knowledge', async () => {
      const db = openTestDatabase();
      const indexer = new KnowledgeIndexer(db, MOCK_REPO_PATH);
      const { indexed } = await indexer.indexAll();
      expect(indexed).toBeGreaterThan(0);
      const rows = db.prepare('SELECT * FROM codebase_knowledge WHERE type=?').all('architecture');
      expect(rows.length).toBeGreaterThan(0);
      db.close();
    });

    it('skips unchanged files on second run', async () => {
      const db = openTestDatabase();
      const indexer = new KnowledgeIndexer(db, MOCK_REPO_PATH);
      await indexer.indexAll();
      const second = await indexer.indexAll();
      expect(second.indexed).toBe(0);
      expect(second.skipped).toBeGreaterThan(0);
      db.close();
    });
  });
});
