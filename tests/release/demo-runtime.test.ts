import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../src/services/wi-config.js', () => ({
  getWiConfig: () => ({connectors:{slack:{enabled:true,mode:'api'}}}),
  getRepos: () => [], getGitHubApiBaseUrl: () => '', getGitHubApiToken: () => '',
}));
import { buildSourceSpecs } from '../../src/services/connector-registry.js';
import { searchAll } from '../../src/tools/search-all.js';
afterEach(() => vi.unstubAllEnvs());
it('demo mode blocks enabled token connectors before building a live source', () => {
  vi.stubEnv('WI_DEMO_MODE','1'); vi.stubEnv('SLACK_TOKEN','synthetic');
  expect(buildSourceSpecs(null as never)).toEqual([]);
});
it('demo mode forces stored evidence even when live search is requested', async () => {
  vi.stubEnv('WI_DEMO_MODE','1');
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE messages (id INTEGER,source TEXT,source_id TEXT,subject TEXT,content TEXT,author TEXT,timestamp TEXT); CREATE TABLE meetings(id INTEGER,title TEXT,date TEXT,chat_name TEXT,attendees TEXT,summary TEXT,topics TEXT,decisions TEXT,transcript TEXT); INSERT INTO messages VALUES(1,'teams','fictional-1','widget','fictional widget rollout','alex',datetime('now')); PRAGMA query_only=ON;");
    const result = await searchAll(db,{query:'widget',mode:'live-blocking',summarize:true},null,'synthetic-key');
    expect(result).toContain('fictional widget rollout');
    expect(result).not.toContain('## Summary');
  } finally { db.close(); }
});
