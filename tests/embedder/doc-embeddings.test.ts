/**
 * doc_embeddings (ADR-042 Gap 2) — embedDocs + searchDocs unit tests.
 *
 * Runs against a real temp repo dir + an in-memory DB with the v101 table.
 * Live-embeds via Ollama when available; the Ollama-down path is exercised by
 * pointing OLLAMA_BASE_URL at a dead port (embed() → null → graceful no-op).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migrateV101 from '../../src/db/migrations/v101_doc_embeddings.js';
import { embedDocs, searchDocs, checkOllamaAvailable } from '../../src/services/embedder.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  migrateV101(db);
  return db;
}

/** Build a throwaway repo root with docs/docs/adr + a couple of markdown files. */
function fakeRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'wi-docembed-'));
  const adrDir = join(root, 'docs/docs/adr');
  mkdirSync(adrDir, { recursive: true });
  writeFileSync(
    join(adrDir, 'adr-999-search-provider-proxy.md'),
    `# ADR-999: search-provider proxy authentication\n\nThe search-provider proxy returns 401 when the token middleware is misconfigured. This ADR decides the session-format migration.`,
  );
  writeFileSync(
    join(adrDir, 'adr-998-kanban-board.md'),
    `# ADR-998: Outcome-honest kanban board\n\nA delivery board with workers picking ready cards. Nothing about search or authentication here.`,
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

let ollamaUp = false;
beforeAll(async () => {
  ollamaUp = await checkOllamaAvailable();
});

describe('embedDocs', () => {
  let db: Database.Database;
  let repo: { root: string; cleanup: () => void };
  beforeEach(() => { db = freshDb(); repo = fakeRepo(); });
  afterEach(() => { db.close(); repo.cleanup(); });

  it('Ollama-down → no-op (indexed 0), does not throw', async () => {
    const saved = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:59999'; // dead port
    try {
      const r = await embedDocs(db, repo.root);
      expect(r.indexed).toBe(0);
      const n = (db.prepare('SELECT COUNT(*) n FROM doc_embeddings').get() as { n: number }).n;
      expect(n).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = saved;
    }
  });

  it('indexes the corpus, then re-run skips unchanged (change-hash) — live Ollama', async () => {
    if (!ollamaUp) { expect(ollamaUp).toBe(false); return; } // skip cleanly when Ollama down
    const first = await embedDocs(db, repo.root);
    expect(first.indexed).toBe(2);
    expect(first.unchanged).toBe(0);
    const rows = db.prepare('SELECT path, title, doc_kind FROM doc_embeddings ORDER BY path').all() as Array<{ path: string; title: string; doc_kind: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0]!.doc_kind).toBe('adr');
    expect(rows.some((r) => r.title.includes('search-provider proxy'))).toBe(true);

    // Re-run: nothing changed → all unchanged, 0 indexed.
    const second = await embedDocs(db, repo.root);
    expect(second.indexed).toBe(0);
    expect(second.unchanged).toBe(2);

    // Change one file → only it re-embeds.
    writeFileSync(join(repo.root, 'docs/docs/adr/adr-999-search-provider-proxy.md'), `# ADR-999: search-provider proxy authentication (revised)\n\nNew body.`);
    const third = await embedDocs(db, repo.root);
    expect(third.indexed).toBe(1);
    expect(third.unchanged).toBe(1);
  });

  it('missing corpus dir is skipped gracefully (no throw)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'wi-empty-'));
    try {
      const r = await embedDocs(db, empty);
      expect(r.indexed).toBe(0);
      expect(r.skipped).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('searchDocs', () => {
  let db: Database.Database;
  let repo: { root: string; cleanup: () => void };
  beforeEach(() => { db = freshDb(); repo = fakeRepo(); });
  afterEach(() => { db.close(); repo.cleanup(); });

  it('ranks the semantically-relevant doc first — live Ollama', async () => {
    if (!ollamaUp) { expect(ollamaUp).toBe(false); return; }
    await embedDocs(db, repo.root);
    const hits = await searchDocs('why does the search-provider proxy return 401', db, 8);
    expect(hits.length).toBeGreaterThan(0);
    // The search-provider ADR should outrank the kanban ADR for this query.
    expect(hits[0]!.title).toMatch(/search-provider proxy/);
    expect(hits[0]!.path).toContain('adr-999');
  });

  it('empty table → [] (no throw)', async () => {
    const hits = await searchDocs('anything', db, 8);
    expect(hits).toEqual([]);
  });

  it('Ollama-down → [] (no throw)', async () => {
    const saved = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:59999';
    try {
      const hits = await searchDocs('anything', db, 8);
      expect(hits).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = saved;
    }
  });
});
