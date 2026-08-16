/**
 * Phase 78a-03 — /api/persona ?mode= parameter contract.
 *
 * Tests the per-mode synthesis path directly via the exported
 * `_testSynthesizePersona` helper (skips the HTTP layer to keep the suite
 * deterministic and < 5s). Invalid-mode + backward-compat are tested via the
 * HTTP route handler with mocked req/res so the parser branch is also covered.
 *
 * The token-counting path uses the char/4 fallback in persona.ts (no Anthropic
 * client in scope), so no SDK mocking is required.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';

import {
  TOKEN_BUDGETS,
  _testSynthesizePersona,
  personaRoutes,
  resetPersonaCache,
  type PersonaMode,
} from '../../src/routes/persona.js';

/** Minimal mock req/res matching the RouteHandler signature. */
function makeRes(): ServerResponse & { _status?: number; _body?: string } {
  const headers: Record<string, string | number | string[]> = {};
  let status = 0;
  let body = '';
  return {
    writeHead(code: number, h?: Record<string, string | number | string[]>) {
      status = code;
      if (h) Object.assign(headers, h);
      // chainable, mirrors node http
      return this as unknown as ServerResponse;
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
    },
    get _status() { return status; },
    get _body() { return body; },
  } as unknown as ServerResponse & { _status?: number; _body?: string };
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  // Minimal tables persona.ts touches (best-effort — getRollingProfile and
  // getRecurringJiraKeys both swallow errors if tables are missing, but we
  // create them so the rolling-profile path is exercised).
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      user TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      source TEXT NOT NULL,
      consumer TEXT NOT NULL DEFAULT 'unknown'
    );
    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      author TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
  `);
  // Seed a handful of observations + jira keys so the rendered body is non-trivial.
  const now = new Date();
  const insertObs = db.prepare(`
    INSERT INTO user_profile_observations (ts, user, kind, payload, source)
    VALUES (?, 'maaz', ?, ?, 'test')
  `);
  for (let i = 0; i < 4; i++) {
    const ts = new Date(now.getTime() - (4 - i) * 60 * 1000).toISOString();
    insertObs.run(ts, 'tool_call', JSON.stringify({ target: `tool-${i}` }));
  }
  db.prepare(`INSERT INTO topics (name) VALUES ('default')`).run();
  const insertMsg = db.prepare(`
    INSERT INTO messages (topic_id, source, content, author, timestamp) VALUES (1, 'teams', ?, 'maaz', ?)
  `);
  insertMsg.run('Looking at DEMO-15702 today', new Date(now.getTime() - 1000 * 60).toISOString());
  insertMsg.run('Also DEMO-16155 follow-up', new Date(now.getTime() - 2000 * 60).toISOString());
  return db;
}

/** Test ctx mirrors RouteContext minimally — only db is used. */
function makeCtx(db: Database.Database) {
  return { db };
}

const personaHandler = personaRoutes[0];

describe('/api/persona ?mode= contract', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetPersonaCache();
    db = freshDb();
  });

  it('WORK ≤ 1500 tokens', async () => {
    const r = await _testSynthesizePersona({ db, user: 'maaz', mode: 'work' });
    expect(r.mode).toBe('work');
    // char/4 heuristic mirrors what persona.ts uses internally.
    expect(Math.ceil(r.systemPrompt.length / 4)).toBeLessThanOrEqual(TOKEN_BUDGETS.work);
  });

  it('LIFE ≤ 1200 tokens', async () => {
    const r = await _testSynthesizePersona({ db, user: 'maaz', mode: 'life' });
    expect(r.mode).toBe('life');
    expect(Math.ceil(r.systemPrompt.length / 4)).toBeLessThanOrEqual(TOKEN_BUDGETS.life);
  });

  it('MIXED ≤ 1800 tokens', async () => {
    const r = await _testSynthesizePersona({ db, user: 'maaz', mode: 'mixed' });
    expect(r.mode).toBe('mixed');
    expect(Math.ceil(r.systemPrompt.length / 4)).toBeLessThanOrEqual(TOKEN_BUDGETS.mixed);
  });

  it('Backward compat — no mode param defaults to WORK', async () => {
    const ctx = makeCtx(db);
    const url = new URL('http://localhost:3132/api/persona');
    const res = makeRes();
    await personaHandler.handle({} as IncomingMessage, res, ctx as never, url);
    expect((res as { _status?: number })._status).toBe(200);
    const body = JSON.parse((res as { _body?: string })._body || '{}');
    expect(body.mode).toBe('work');

    // And the body matches an explicit mode='work' call.
    resetPersonaCache();
    const explicit = await _testSynthesizePersona({ db, user: 'maaz', mode: 'work' });
    // Don't compare freshSynthesisMs / generatedAt (timing-dependent), do
    // compare systemPrompt + version (content-derived, deterministic).
    expect(body.systemPrompt).toBe(explicit.systemPrompt);
    expect(body.version).toBe(explicit.version);
  });

  it('Version hash stable across two consecutive same-tuple calls', async () => {
    const a = await _testSynthesizePersona({ db, user: 'maaz', mode: 'work' });
    // Don't reset cache — second call hits cache and must echo the same version.
    const b = await _testSynthesizePersona({ db, user: 'maaz', mode: 'work' });
    expect(a.version).toBe(b.version);
  });

  it('Version hash differs across modes (WORK vs LIFE)', async () => {
    const work = await _testSynthesizePersona({ db, user: 'maaz', mode: 'work' });
    const life = await _testSynthesizePersona({ db, user: 'maaz', mode: 'life' });
    expect(work.version).not.toBe(life.version);
    // Sanity: LIFE body contains the stub marker, WORK does not.
    expect(life.systemPrompt).toContain('# Life mode (Phase 78c stub fall-through)');
    expect(work.systemPrompt).not.toContain('# Life mode (Phase 78c stub fall-through)');
  });

  it('Cache HIT path — second call is cached', async () => {
    const first = await _testSynthesizePersona({ db, user: 'maaz', mode: 'work' });
    const second = await _testSynthesizePersona({ db, user: 'maaz', mode: 'work' });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    // freshSynthesisMs is 0 on the cache-hit path.
    expect(second.freshSynthesisMs).toBe(0);
  });

  it('Invalid mode rejected with HTTP 400 and helpful error', async () => {
    const ctx = makeCtx(db);
    const url = new URL('http://localhost:3132/api/persona?mode=garbage');
    const res = makeRes();
    await personaHandler.handle({} as IncomingMessage, res, ctx as never, url);
    expect((res as { _status?: number })._status).toBe(400);
    const body = JSON.parse((res as { _body?: string })._body || '{}');
    expect(body.error).toContain("'work'");
    expect(body.error).toContain("'life'");
    expect(body.error).toContain("'mixed'");
  });

  it("Persona/tone-split sentence present in WORK", async () => {
    const r = await _testSynthesizePersona({ db, user: 'maaz', mode: 'work' });
    expect(r.systemPrompt).toContain('If the user expresses fatigue or frustration');
  });

  it('Truncation marker only when over budget — small input does NOT include it', async () => {
    // freshDb seeds a tiny corpus; the body is well under 1500 tokens, so the
    // marker must not appear.
    const r = await _testSynthesizePersona({ db, user: 'maaz', mode: 'work' });
    expect(r.systemPrompt).not.toContain('[persona truncated to fit budget]');
  });

  it('All four supported tuples (no-mode/work/life/mixed) mode echo + shape', async () => {
    // Cross-check the response shape includes the new top-level `mode` echo.
    const modes: Array<PersonaMode | undefined> = ['work', 'life', 'mixed', undefined];
    for (const m of modes) {
      resetPersonaCache();
      const ctx = makeCtx(db);
      const url = new URL('http://localhost:3132/api/persona' + (m ? `?mode=${m}` : ''));
      const res = makeRes();
      await personaHandler.handle({} as IncomingMessage, res, ctx as never, url);
      expect((res as { _status?: number })._status).toBe(200);
      const body = JSON.parse((res as { _body?: string })._body || '{}');
      expect(body.mode).toBe(m ?? 'work');
      expect(typeof body.systemPrompt).toBe('string');
      expect(typeof body.version).toBe('string');
      expect(body.version.length).toBeGreaterThan(0);
    }
  });
});
