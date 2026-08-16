/**
 * ADR-044 S2 — orchestrator isolation tests.
 *
 * Proves the core contract (AC-U5): one slow/failing source does NOT sink the
 * others, local-first grounding works, and persisted messages dedup. Uses stub
 * SourceFetchers (no browser) — the LIVE pool-slot-leak test (AC-U6) is a
 * separate integration test that holds a real getPage slot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/db/schema.js';
import { fetchStream, fetchOneSource, localFirst, localSpec } from '../../src/fetcher/orchestrator.js';
import type { SourceSpec } from '../../src/fetcher/orchestrator.js';
import { MessageSource } from '../../src/fetcher/types.js';
import type { UnifiedMessage } from '../../src/fetcher/types.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); initializeDatabase(db); });
afterEach(() => { db.close(); });

function msg(source: MessageSource, id: string, subject = 'x'): UnifiedMessage {
  return {
    id, source, subject, content: 'body',
    sender: { id: 'u', name: 'User', email: 'u@x.com' },
    createdAt: new Date('2026-07-16T00:00:00Z'), isReply: false,
    metadata: {},
  };
}

describe('fetchOneSource — cancel-and-release timeout', () => {
  it('resolves timed_out (never rejects) when fetch exceeds timeout, and runs release', async () => {
    let released = false;
    const spec: SourceSpec = {
      source: 'email',
      timeoutMs: 30,
      fetch: (signal) => new Promise((resolve, reject) => {
        // A slow fetch that honors abort by REJECTING (realistic connector
        // behavior — an aborted Playwright await throws AbortError).
        const t = setTimeout(() => resolve([msg(MessageSource.Email, 'e1')]), 5_000);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
      }),
      release: () => { released = true; },
    };
    const { envelope } = await fetchOneSource(spec);
    expect(envelope.status).toBe('timed_out');
    expect(envelope.count).toBe(0);
    expect(released).toBe(true); // cleanup ran — slot would be freed
  });

  it('resolves error (never rejects) when fetch throws', async () => {
    const spec: SourceSpec = {
      source: 'jira', timeoutMs: 1_000,
      fetch: async () => { throw new Error('boom'); },
    };
    const { envelope } = await fetchOneSource(spec);
    expect(envelope.status).toBe('error');
    expect(envelope.note).toContain('boom');
  });

  it('resolves ok with messages on success', async () => {
    const spec: SourceSpec = {
      source: 'jira', timeoutMs: 1_000,
      fetch: async () => [msg(MessageSource.Jira, 'J-1'), msg(MessageSource.Jira, 'J-2')],
    };
    const { envelope, messages } = await fetchOneSource(spec);
    expect(envelope.status).toBe('ok');
    expect(envelope.count).toBe(2);
    expect(messages).toHaveLength(2);
  });
});

describe('fetchStream — one slow source does not sink the others (AC-U5)', () => {
  it('a timed-out email source does not block jira/teams; all envelopes emit; ok rows persist + dedup', async () => {
    const specs: SourceSpec[] = [
      { source: 'email', timeoutMs: 30, fetch: (s) => new Promise((res, rej) => {
          const t = setTimeout(() => res([msg(MessageSource.Email, 'e1')]), 5_000);
          s.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
        }) },
      { source: 'jira', timeoutMs: 1_000, fetch: async () => [msg(MessageSource.Jira, 'J-1')] },
      { source: 'teams', timeoutMs: 1_000, fetch: async () => [msg(MessageSource.Teams, 'T-1'), msg(MessageSource.Teams, 'T-1')] },
    ];
    const events: string[] = [];
    const results: Record<string, string> = {};
    for await (const ev of fetchStream(db, specs)) {
      events.push(ev.kind);
      if (ev.kind === 'result') results[ev.source] = ev.status;
    }
    // Every source reported; email isolated as timed_out, others ok.
    expect(results.email).toBe('timed_out');
    expect(results.jira).toBe('ok');
    expect(results.teams).toBe('ok');
    expect(events.filter((e) => e === 'result')).toHaveLength(3);
    expect(events[events.length - 1]).toBe('done');
    // Persistence + dedup: jira 1 row, teams 1 row (duplicate T-1 deduped), email 0.
    const rows = db.prepare(`SELECT source, COUNT(*) n FROM messages GROUP BY source`).all() as { source: string; n: number }[];
    const bySource = Object.fromEntries(rows.map((r) => [r.source, r.n]));
    expect(bySource.jira).toBe(1);
    expect(bySource.teams).toBe(1); // dedup on (source, source_id)
    expect(bySource.email ?? 0).toBe(0);
  });
});

describe('localFirst — instant grounding', () => {
  it('returns count of local FTS matches, 0 for empty query', () => {
    expect(localFirst(db, undefined)).toBe(0);
    expect(localFirst(db, 'nothing-here')).toBe(0);
  });
});

describe('fetchStream — local-first (ADR-044 S4)', () => {
  it('emits the local result envelope BEFORE any live source starts, with the FTS hit count', async () => {
    // Seed one row so FTS has something to match. The test proves 'local' is
    // emitted first regardless of whether the query matches; the count follows.
    const topicId = db.prepare(`INSERT INTO topics (name, created_at) VALUES ('t', datetime('now'))`).run().lastInsertRowid as number;
    db.prepare(`INSERT INTO messages (topic_id, source, source_id, subject, content, author, timestamp) VALUES (?, 'teams', 'seed-1', 'x', 'localunique needle', 'u', datetime('now'))`).run(topicId);

    const order: string[] = [];
    const jiraStart = { t: 0 };
    const specs: SourceSpec[] = [
      // Jira takes 200ms so we can be certain 'local' arrives first.
      { source: 'jira', timeoutMs: 5_000, fetch: async () => { jiraStart.t = Date.now(); await new Promise((r) => setTimeout(r, 200)); return [msg(MessageSource.Jira, 'J-1')]; } },
      localSpec(db, 'localunique needle', 10),
    ];
    let firstResultAt = 0;
    for await (const ev of fetchStream(db, specs)) {
      if (ev.kind === 'result') {
        if (!firstResultAt) firstResultAt = Date.now();
        order.push(ev.source);
        if (ev.source === 'local') {
          expect(ev.status).toBe('ok');
          expect(ev.count).toBe(1);
        }
      }
    }
    // Local came first, before any live source started producing.
    expect(order[0]).toBe('local');
    expect(order).toEqual(['local', 'jira']);
  });

  it('with only local + a timing-out live source, local still resolves immediately and the timed_out envelope follows', async () => {
    const specs: SourceSpec[] = [
      localSpec(db, 'nothing', 10),
      { source: 'email', timeoutMs: 30, fetch: (s) => new Promise((res, rej) => {
          const t = setTimeout(() => res([msg(MessageSource.Email, 'e1')]), 5_000);
          s.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
        }) },
    ];
    const results: Record<string, string> = {};
    for await (const ev of fetchStream(db, specs)) {
      if (ev.kind === 'result') results[ev.source] = ev.status;
    }
    expect(results.local).toBe('ok');
    expect(results.email).toBe('timed_out');
  });
});
