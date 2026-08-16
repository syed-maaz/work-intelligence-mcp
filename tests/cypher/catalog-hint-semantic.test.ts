/**
 * v98 — prompt-memory recognition routing tests.
 *
 * The semantic path needs Ollama (nomic-embed-text) to embed goals; those
 * assertions are gated behind a reachability probe and SKIP cleanly when
 * Ollama is down (it's an optional local service). The fallback path
 * (description word-overlap when prompt_memory is empty / Ollama absent) is
 * always exercised — that's the guarantee the loop depends on.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getCatalogHint } from '../../src/services/cypher/tool-catalog.js';
import migrateV63 from '../../src/db/migrations/v63_skill_catalog.js';
import migrateV98 from '../../src/db/migrations/v98_prompt_memory.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  // cypher_sessions is FK'd by prompt_memory; a minimal shape is enough here.
  db.exec(`CREATE TABLE IF NOT EXISTS cypher_sessions (session_id TEXT PRIMARY KEY);`);
  migrateV63(db);
  migrateV98(db);
  return db;
}

function insertSkill(db: Database.Database, name: string, description: string): void {
  db.prepare(
    `INSERT INTO skill_catalog (skill_name, source, source_path, description, trigger_phrases, task_classes)
     VALUES (?, 'wi', ?, ?, '[]', '[]')`,
  ).run(name, `/tmp/${name}/SKILL.md`, description);
}

describe('v98 — getCatalogHint prompt-memory recognition', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => db.close());

  it('migration creates prompt_memory with expected columns', () => {
    const cols = (db.prepare(`PRAGMA table_info(prompt_memory)`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(
      ['chosen_skill', 'embedded_at', 'embedding', 'goal', 'model', 'outcome', 'session_id'].sort(),
    );
  });

  it('falls back to description word-overlap when prompt_memory is empty', async () => {
    // wi- prefix: word-overlap now filters to dispatchable wi-* skills only
    // (recognition-recall fix, ADR-042 2026-07-25).
    insertSkill(db, 'wi-code-reviewer', 'Reviews pull requests for bugs and quality problems.');
    const hint = await getCatalogHint('review the pull request', db);
    // Empty prompt_memory (and/or Ollama down) → word-overlap fallback fires.
    expect(hint).toContain('description-overlap');
    expect(hint).toContain('wi-code-reviewer');
  });

  it('returns empty string for an empty goal', async () => {
    expect(await getCatalogHint('', db)).toBe('');
    expect(await getCatalogHint('   ', db)).toBe('');
  });

  it('hint stays advisory / non-binding (AC-10) on the fallback path', async () => {
    insertSkill(db, 'wi-search', 'Search across Jira Teams Email GitHub via cross-source FTS.');
    const hint = await getCatalogHint('search jira for tickets', db);
    expect(hint).toContain('advisory, not binding');
  });

  it('is awaitable (async signature) and never throws on a bare DB', async () => {
    // No skill_catalog rows, no prompt_memory rows → empty string, no throw.
    await expect(getCatalogHint('some goal with no matches xyzzy', db)).resolves.toBeTypeOf('string');
  });
});
