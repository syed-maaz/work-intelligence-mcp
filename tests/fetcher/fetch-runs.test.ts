/**
 * ADR-044 S2.6 — fetch telemetry query tests.
 *
 * Proves recordFetchRun persists the envelope and readFetchTelemetry returns
 * the recent ledger + a correct per-source rollup (newest row per source,
 * total count). This is the substrate behind /api/sync/telemetry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/db/schema.js';
import { recordFetchRun, readFetchTelemetry } from '../../src/db/queries/fetch-runs.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); initializeDatabase(db); });
afterEach(() => { db.close(); });

describe('recordFetchRun + readFetchTelemetry', () => {
  it('persists an ok run and reads it back in recent + rollup', () => {
    const id = recordFetchRun(db, { source: 'email', status: 'ok', count: 6, durationMs: 7902 });
    expect(id).toBeGreaterThan(0);

    const { recent, rollup } = readFetchTelemetry(db);
    expect(recent).toHaveLength(1);
    expect(recent[0].source).toBe('email');
    expect(recent[0].status).toBe('ok');
    expect(recent[0].count).toBe(6);
    expect(recent[0].duration_ms).toBe(7902);
    expect(recent[0].trigger).toBe('sync'); // default

    expect(rollup).toHaveLength(1);
    expect(rollup[0]).toMatchObject({ source: 'email', last_status: 'ok', total_runs: 1 });
  });

  it('rollup shows the NEWEST run per source and counts all attempts', () => {
    recordFetchRun(db, { source: 'email', status: 'error', count: 0, durationMs: 10, note: 'boom' });
    recordFetchRun(db, { source: 'email', status: 'ok', count: 3, durationMs: 500 });
    recordFetchRun(db, { source: 'jira', status: 'timed_out', count: 0, durationMs: 90000, note: '>90000ms' });

    const { rollup } = readFetchTelemetry(db);
    const bySource = Object.fromEntries(rollup.map((r) => [r.source, r]));

    // email: newest is the ok run; total counts both attempts.
    expect(bySource.email.last_status).toBe('ok');
    expect(bySource.email.last_count).toBe(3);
    expect(bySource.email.total_runs).toBe(2);

    // jira: single timed_out run, note preserved.
    expect(bySource.jira.last_status).toBe('timed_out');
    expect(bySource.jira.last_note).toBe('>90000ms');
    expect(bySource.jira.total_runs).toBe(1);
  });

  it('respects the limit on recent rows', () => {
    for (let i = 0; i < 5; i++) recordFetchRun(db, { source: 'email', status: 'ok', count: i, durationMs: 1 });
    const { recent } = readFetchTelemetry(db, 3);
    expect(recent).toHaveLength(3);
    // newest first — the last inserted (count=4) leads.
    expect(recent[0].count).toBe(4);
  });

  it('CHECK constraint rejects an invalid status', () => {
    expect(() => recordFetchRun(db, { source: 'x', status: 'bogus' as 'ok', count: 0, durationMs: 0 }))
      .toThrow();
  });
});
