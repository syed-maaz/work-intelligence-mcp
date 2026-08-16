/**
 * ADR-044 — 10-scenario acceptance suite (AC-U1..U6).
 *
 * The outcome bar for the Fetcher module. Each scenario exercises the real
 * orchestrator (fetchStream / fetchOneSource / localFirst) against stub or
 * fake-slot sources — deterministic, no live browser — and asserts on PRODUCT
 * behavior, not plumbing. AC-U6 uses a real BrowserSessionManager (playwright
 * mocked) because a stub holds no pool slot.
 *
 * Mapping:
 *   1  email-only sync lands rows            → AC-U1 (persist path)
 *   2  jira sync persists to messages        → AC-U2
 *   3  all sources in parallel, all land     → AC-U3 (incremental, per-source)
 *   4  one source times out, others survive  → AC-U5
 *   5  timed-out source frees its slot        → AC-U6 (LIVE slot invariant)
 *   6  local-first returns before slow source→ local grounding
 *   7  dedup on re-sync (same source_id)      → dedup contract
 *   8  empty query → local returns 0          → localFirst guard
 *   9  all sources fail → graceful, no throw  → AC-U5 (aggregate never rejects)
 *   10 result envelopes emit in completion    → AC-U3/U4 shape (fast before slow)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Playwright mock for the AC-U6 live-slot scenario (#5) ──────────────────
const closedPages = new Set<object>();
function makeFakePage() {
  return {
    _closed: false,
    setDefaultNavigationTimeout() {}, setDefaultTimeout() {},
    goto: async () => ({ ok: () => true, status: () => 200 }),
    url: () => 'https://outlook.office.com/mail/inbox',
    isClosed() { return (this as { _closed: boolean })._closed; },
    async close() { (this as { _closed: boolean })._closed = true; closedPages.add(this as object); },
    $: async () => null,
  };
}
vi.mock('playwright', () => ({
  chromium: { launchPersistentContext: async () => ({
    newPage: async () => makeFakePage(),
    browser: () => ({ isConnected: () => true }),
    close: async () => {},
  }) },
  BrowserContext: class {}, Page: class {},
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, lstatSync: () => { throw new Error('ENOENT'); } };
});

import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/db/schema.js';
import { fetchStream, fetchOneSource, localFirst } from '../../src/fetcher/orchestrator.js';
import type { SourceSpec } from '../../src/fetcher/orchestrator.js';
import { MessageSource } from '../../src/fetcher/types.js';
import type { UnifiedMessage } from '../../src/fetcher/types.js';
import { BrowserSessionManager } from '../../src/fetcher/sources/browser-session.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); initializeDatabase(db); closedPages.clear(); });
afterEach(() => { db.close(); });

function msg(source: MessageSource, id: string): UnifiedMessage {
  return {
    id, source, subject: `s-${id}`, content: 'body',
    sender: { id: 'u', name: 'User', email: 'u@x.com' },
    createdAt: new Date('2026-07-17T00:00:00Z'), isReply: false, metadata: {},
  };
}
function okSpec(source: SourceSpec['source'], ms: MessageSource, ids: string[]): SourceSpec {
  return { source, timeoutMs: 1_000, fetch: async () => ids.map((i) => msg(ms, i)) };
}
function slowSpec(source: SourceSpec['source'], ms: MessageSource, id: string): SourceSpec {
  return {
    source, timeoutMs: 30,
    fetch: (signal) => new Promise((res, rej) => {
      const t = setTimeout(() => res([msg(ms, id)]), 5_000);
      signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
    }),
  };
}
async function drain(specs: SourceSpec[]): Promise<{ results: Record<string, string>; kinds: string[] }> {
  const results: Record<string, string> = {}; const kinds: string[] = [];
  for await (const ev of fetchStream(db, specs)) {
    kinds.push(ev.kind);
    if (ev.kind === 'result') results[ev.source] = ev.status;
  }
  return { results, kinds };
}
const countBySource = (): Record<string, number> =>
  Object.fromEntries((db.prepare(`SELECT source, COUNT(*) n FROM messages GROUP BY source`).all() as { source: string; n: number }[]).map((r) => [r.source, r.n]));

describe('ADR-044 acceptance — 10 scenarios (AC-U1..U6)', () => {
  it('S1 (AC-U1): email-only sync lands rows in messages', async () => {
    await drain([okSpec('email', MessageSource.Email, ['e1', 'e2', 'e3'])]);
    expect(countBySource().email).toBe(3);
  });

  it('S2 (AC-U2): jira sync persists to messages, not merely cache-invalidated', async () => {
    await drain([okSpec('jira', MessageSource.Jira, ['J-1', 'J-2'])]);
    expect(countBySource().jira).toBe(2);
  });

  it('S3 (AC-U3): all sources fetched in parallel, each persists', async () => {
    await drain([
      okSpec('email', MessageSource.Email, ['e1']),
      okSpec('jira', MessageSource.Jira, ['J-1']),
      okSpec('teams', MessageSource.Teams, ['T-1']),
    ]);
    const c = countBySource();
    expect(c.email).toBe(1); expect(c.jira).toBe(1); expect(c.teams).toBe(1);
  });

  it('S4 (AC-U5): one source times out, the others still return + persist', async () => {
    const { results } = await drain([
      slowSpec('email', MessageSource.Email, 'e1'),
      okSpec('jira', MessageSource.Jira, ['J-1']),
      okSpec('teams', MessageSource.Teams, ['T-1']),
    ]);
    expect(results.email).toBe('timed_out');
    expect(results.jira).toBe('ok');
    expect(results.teams).toBe('ok');
    const c = countBySource();
    expect(c.jira).toBe(1); expect(c.teams).toBe(1); expect(c.email ?? 0).toBe(0);
  });

  it('S5 (AC-U6 LIVE): a timed-out browser source frees its pool slot', async () => {
    const mgr = new BrowserSessionManager({ profilePath: '/tmp/fake', headless: true, maxSlots: 2 });
    const before = mgr.freeSlotCount();
    // A fetch that acquires+tags a real slot then hangs until aborted.
    const spec: SourceSpec = {
      source: 'email', timeoutMs: 40,
      fetch: async (signal) => {
        const page = await mgr.getPage('https://outlook.office.com/mail/inbox');
        mgr.tagPageSource(page, 'email');
        await new Promise<void>((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
        return [];
      },
      release: () => mgr.releaseBySource('email'),
    };
    const { envelope } = await fetchOneSource(spec);
    expect(envelope.status).toBe('timed_out');
    expect(mgr.freeSlotCount()).toBe(before); // INVARIANT: slot returned, not leaked
  });

  it('S6: local-first returns immediately (independent of any live fetch)', async () => {
    // Seed a local row, then assert localFirst finds it with zero fetch.
    db.prepare(`INSERT OR IGNORE INTO topics (name, created_at) VALUES ('email', datetime('now'))`).run();
    const tid = (db.prepare(`SELECT id FROM topics WHERE name='email'`).get() as { id: number }).id;
    db.prepare(`INSERT INTO messages (topic_id, source, source_id, subject, content, author, timestamp) VALUES (?,?,?,?,?,?,?)`)
      .run(tid, 'email', 'local-1', 'quarterly report', 'body about quarterly report', 'a', new Date().toISOString());
    expect(localFirst(db, 'quarterly')).toBeGreaterThan(0);
  });

  it('S7: dedup on re-sync — same source_id does not duplicate', async () => {
    await drain([okSpec('jira', MessageSource.Jira, ['J-1', 'J-1'])]); // dup in one batch
    await drain([okSpec('jira', MessageSource.Jira, ['J-1'])]);         // re-sync same id
    expect(countBySource().jira).toBe(1);
  });

  it('S8: empty query → localFirst returns 0 (no crash)', () => {
    expect(localFirst(db, undefined)).toBe(0);
    expect(localFirst(db, '')).toBe(0);
  });

  it('S9 (AC-U5): all sources fail → aggregate resolves gracefully, never throws', async () => {
    const boom = (source: SourceSpec['source']): SourceSpec =>
      ({ source, timeoutMs: 1_000, fetch: async () => { throw new Error('down'); } });
    const { results, kinds } = await drain([boom('email'), boom('jira'), boom('teams')]);
    expect(results.email).toBe('error');
    expect(results.jira).toBe('error');
    expect(results.teams).toBe('error');
    expect(kinds[kinds.length - 1]).toBe('done'); // stream completed cleanly
    expect(Object.keys(countBySource())).toHaveLength(0); // nothing persisted
  });

  it('S10 (AC-U3/U4): fast source emits its result before a slow source blocks the stream', async () => {
    const order: string[] = [];
    const specs: SourceSpec[] = [
      { source: 'jira', timeoutMs: 1_000, fetch: async () => [msg(MessageSource.Jira, 'J-1')] }, // fast
      { source: 'email', timeoutMs: 200, fetch: (s) => new Promise((res, rej) => {              // slow → times out
          const t = setTimeout(() => res([]), 5_000);
          s.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
        }) },
    ];
    for await (const ev of fetchStream(db, specs)) {
      if (ev.kind === 'result') order.push(ev.source);
    }
    // Fast jira result must arrive before the slow email result — incremental,
    // not one blocking response gated on the slowest source.
    expect(order.indexOf('jira')).toBeLessThan(order.indexOf('email'));
  });
});
