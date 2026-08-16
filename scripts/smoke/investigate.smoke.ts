/**
 * § 31 — investigate.ts probeRecentSessions + buildSavedContext
 * (ADR-036 PHASE-86-02-A, 2026-06-16; PHASE-86-02-B added 2026-06-19;
 * PHASE-86-02-C added 2026-06-20).
 *
 * Saved-context probes for the investigate stage. Verifies:
 *   - probeRecentSessions returns at most `limit` sessions, most-recent first
 *   - filter is per-user (alice vs bob isolated)
 *   - goal_token_match flips on Jira-key / ADR-NNN overlap with the new goal
 *   - SQLite error → empty findings + error string (best-effort, never throws)
 *   - probePalaceSearch maps MemPalace JSON shapes to PalaceFinding rows,
 *     handles timeouts silently, and short-circuits on null palace
 *   - probeBrainContext maps BrainContext aggregates to BrainFinding rows,
 *     short-circuits on null fetcher, handles timeouts silently, and
 *     surfaces fetcher exceptions in errors.brain
 *   - buildSavedContext stitches all three probes into a SavedContext
 *     shape; partial degradation (one probe fails, others succeed) works
 */

import { describe, expect, test, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  probeRecentSessions,
  probePalaceSearch,
  probeBrainContext,
  buildSavedContext,
  PALACE_SEARCH_TIMEOUT_MS,
  BRAIN_CONTEXT_TIMEOUT_MS,
} from '../../dist/services/cypher/investigate.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  // Mirror the v59 cypher_sessions shape — only the columns the probe reads.
  db.exec(`
    CREATE TABLE cypher_sessions (
      session_id   TEXT PRIMARY KEY,
      goal         TEXT NOT NULL,
      task_class   TEXT,
      outcome      TEXT,
      chosen_skill TEXT,
      user         TEXT NOT NULL DEFAULT 'maaz',
      started_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function seed(
  db: Database.Database,
  session_id: string,
  goal: string,
  user: string = 'maaz',
  startedOffsetMin: number = 0,
  outcome: string | null = null,
  chosen_skill: string | null = null,
  task_class: string | null = 'test',
): void {
  db.prepare(`
    INSERT INTO cypher_sessions (session_id, goal, task_class, outcome, chosen_skill, user, started_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))
  `).run(session_id, goal, task_class, outcome, chosen_skill, user, `${startedOffsetMin} minutes`);
}

describe('§ 31 — probeRecentSessions', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  test('§ 31.1 — returns most-recent first, capped at limit', () => {
    seed(db, 'cyp_a', 'goal a', 'maaz', -30);
    seed(db, 'cyp_b', 'goal b', 'maaz', -20);
    seed(db, 'cyp_c', 'goal c', 'maaz', -10);
    seed(db, 'cyp_d', 'goal d', 'maaz', 0);
    const r = probeRecentSessions(db, 'maaz', 'something', 2);
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0].session_id).toBe('cyp_d');
    expect(r.findings[1].session_id).toBe('cyp_c');
  });

  test('§ 31.2 — filters per-user (alice not seen by maaz)', () => {
    seed(db, 'cyp_a', 'alice goal', 'alice', 0);
    seed(db, 'cyp_m', 'maaz goal', 'maaz', 0);
    const r = probeRecentSessions(db, 'maaz', 'whatever');
    expect(r.findings.map(f => f.session_id)).toEqual(['cyp_m']);
  });

  test('§ 31.3 — goal_token_match true when goal shares a Jira key', () => {
    seed(db, 'cyp_a', 'investigate DEMO-15702 cookie', 'maaz', 0);
    seed(db, 'cyp_b', 'unrelated thing', 'maaz', -5);
    const r = probeRecentSessions(db, 'maaz', 'now look at DEMO-15702 again');
    const a = r.findings.find(f => f.session_id === 'cyp_a')!;
    const b = r.findings.find(f => f.session_id === 'cyp_b')!;
    expect(a.goal_token_match).toBe(true);
    expect(b.goal_token_match).toBe(false);
  });

  test('§ 31.4 — goal_token_match true on ADR-NNN overlap', () => {
    seed(db, 'cyp_a', 'mark ADR-032 superseded', 'maaz', 0);
    const r = probeRecentSessions(db, 'maaz', 'follow up on ADR-032');
    expect(r.findings[0].goal_token_match).toBe(true);
  });

  test('§ 31.5 — goal with no tokens → all goal_token_match=false', () => {
    seed(db, 'cyp_a', 'goal a', 'maaz', 0);
    seed(db, 'cyp_b', 'goal b mentions DEMO-1', 'maaz', -5);
    const r = probeRecentSessions(db, 'maaz', 'free-text question');
    expect(r.findings.every(f => f.goal_token_match === false)).toBe(true);
  });

  test('§ 31.6 — empty result when no sessions for user', () => {
    seed(db, 'cyp_x', 'goal', 'someone-else', 0);
    const r = probeRecentSessions(db, 'maaz', 'goal');
    expect(r.findings).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  test('§ 31.7 — broken DB → empty findings + error (never throws)', () => {
    const broken = new Database(':memory:');
    // No cypher_sessions table — query will throw inside the helper.
    const r = probeRecentSessions(broken, 'maaz', 'goal');
    expect(r.findings).toEqual([]);
    expect(r.error).toBeTruthy();
  });
});

describe('§ 31.8 — buildSavedContext', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  // Note: tests in this block pass `brainFetcher: null` to keep them
  // hermetic — the default fetcher imports buildBrainContext which
  // would query the production schema not present in this :memory: db.
  // § 31.8.5 / .6 exercise the brain wiring with a stub fetcher.

  test('§ 31.8.1 — stitches sessions into SavedContext; sources.sessions=true; palace not attempted', async () => {
    seed(db, 'cyp_a', 'goal a', 'maaz', 0, 'success', 'wi-investigate');
    const ctx = await buildSavedContext(db, 'maaz', 'continuation goal', undefined, null);
    expect(ctx.recent_sessions).toHaveLength(1);
    expect(ctx.recent_sessions[0]).toMatchObject({
      session_id: 'cyp_a',
      outcome: 'success',
      chosen_skill: 'wi-investigate',
    });
    // No palace passed → probe not attempted, palace_findings empty,
    // sources.palace = false (because attempted=false).
    expect(ctx.palace_findings).toEqual([]);
    expect(ctx.brain_findings).toEqual([]);
    expect(ctx.sources).toEqual({ sessions: true, palace: false, brain: false });
    expect(ctx.errors).toEqual({});
  });

  test('§ 31.8.2 — broken DB → empty context, sources.sessions=false, error logged', async () => {
    const broken = new Database(':memory:');
    const ctx = await buildSavedContext(broken, 'maaz', 'goal', undefined, null);
    expect(ctx.recent_sessions).toEqual([]);
    expect(ctx.sources.sessions).toBe(false);
    expect(ctx.errors.sessions).toBeTruthy();
    expect(ctx.sources.palace).toBe(false);
    expect(ctx.sources.brain).toBe(false);
  });

  test('§ 31.8.3 — palace probe wired: stub palace returning hits → palace_findings populated, sources.palace=true', async () => {
    seed(db, 'cyp_a', 'goal a', 'maaz', 0);
    const stubPalace = {
      async search(_query: string, _wing?: string, _limit = 5): Promise<string> {
        return JSON.stringify([
          { id: 'd-1', wing: 'investigations', room: 'PROJ-15702', text: 'cookie regression notes' },
        ]);
      },
    } as unknown as Parameters<typeof buildSavedContext>[3];
    const ctx = await buildSavedContext(db, 'maaz', 'continuation', stubPalace, null);
    expect(ctx.palace_findings).toHaveLength(1);
    expect(ctx.palace_findings[0]).toMatchObject({
      drawer_id: 'd-1',
      wing: 'investigations',
      room: 'PROJ-15702',
    });
    expect(ctx.sources.palace).toBe(true);
    expect(ctx.errors.palace).toBeUndefined();
  });

  test('§ 31.8.4 — palace throws → empty palace_findings + errors.palace recorded; dispatch survives', async () => {
    seed(db, 'cyp_a', 'goal a', 'maaz', 0);
    const stubPalace = {
      async search(): Promise<string> { throw new Error('mempalace stdio closed'); },
    } as unknown as Parameters<typeof buildSavedContext>[3];
    const ctx = await buildSavedContext(db, 'maaz', 'continuation', stubPalace, null);
    expect(ctx.palace_findings).toEqual([]);
    expect(ctx.sources.palace).toBe(false);
    expect(ctx.errors.palace).toContain('mempalace stdio closed');
    // Sessions still succeed independently — partial degradation is fine.
    expect(ctx.recent_sessions).toHaveLength(1);
    expect(ctx.sources.sessions).toBe(true);
  });

  test('§ 31.8.5 — brain probe wired: stub fetcher returning context → brain_findings populated, sources.brain=true', async () => {
    seed(db, 'cyp_a', 'goal a', 'maaz', 0);
    const stubBrain: Parameters<typeof buildSavedContext>[4] = async () => ({
      sprint: { name: 'Saturn-94', ends: '2026-06-30', fresh: true },
      stuck_jiras: [{ key: 'DEMO-15702', days_stuck: 7, cluster: null }],
      noise_clusters: [],
      calendar_today: [{ time: '14:00', title: 'Cypher review', with: 'Maaz' }],
      open_investigations: [],
      memory_relevant: [],
      stale_warnings: ['no recent dispatches'],
    });
    const ctx = await buildSavedContext(db, 'maaz', 'continuation', undefined, stubBrain);
    expect(ctx.sources.brain).toBe(true);
    expect(ctx.errors.brain).toBeUndefined();
    // Sprint + stuck Jira + calendar + stale warning = 4 findings.
    expect(ctx.brain_findings).toHaveLength(4);
    expect(ctx.brain_findings.map(f => f.kind).sort()).toEqual(
      ['calendar', 'sprint', 'stale_warning', 'stuck_jira'],
    );
  });

  test('§ 31.8.6 — brain throws → errors.brain captured, other probes survive', async () => {
    seed(db, 'cyp_a', 'goal a', 'maaz', 0);
    const stubBrain: Parameters<typeof buildSavedContext>[4] = async () => {
      throw new Error('brain context-builder failed');
    };
    const ctx = await buildSavedContext(db, 'maaz', 'continuation', undefined, stubBrain);
    expect(ctx.brain_findings).toEqual([]);
    expect(ctx.sources.brain).toBe(false);
    expect(ctx.errors.brain).toContain('brain context-builder failed');
    expect(ctx.sources.sessions).toBe(true);
  });
});

describe('§ 31.9 — probePalaceSearch (PHASE-86-02-B)', () => {
  test('§ 31.9.1 — null palace → empty findings, attempted=false, no error', async () => {
    const r = await probePalaceSearch(null, 'any goal');
    expect(r.findings).toEqual([]);
    expect(r.attempted).toBe(false);
    expect(r.error).toBeUndefined();
  });

  test('§ 31.9.2 — empty goal → short-circuit, empty findings, attempted=false', async () => {
    const stubPalace = {
      async search(): Promise<string> {
        throw new Error('should not be called for empty goal');
      },
    } as unknown as Parameters<typeof probePalaceSearch>[0];
    const r = await probePalaceSearch(stubPalace, '');
    expect(r.findings).toEqual([]);
    expect(r.attempted).toBe(false);
  });

  test('§ 31.9.3 — palace returns top-level array → maps each row to PalaceFinding', async () => {
    const stubPalace = {
      async search(): Promise<string> {
        return JSON.stringify([
          { drawer_id: 'd-1', wing: 'w1', room: 'r1', content: 'first body', distance: 0.12 },
          { id: 'd-2', wing: 'w2', room: 'r2', snippet: 'second body', score: 0.87 },
        ]);
      },
    } as unknown as Parameters<typeof probePalaceSearch>[0];
    const r = await probePalaceSearch(stubPalace, 'goal');
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]).toMatchObject({
      drawer_id: 'd-1', wing: 'w1', room: 'r1', content_preview: 'first body', distance: 0.12,
    });
    // Falls back from `id` when `drawer_id` missing; uses `score` when `distance` missing.
    expect(r.findings[1].drawer_id).toBe('d-2');
    expect(r.findings[1].distance).toBe(0.87);
    expect(r.attempted).toBe(true);
  });

  test('§ 31.9.4 — palace returns {results: [...]} envelope → still parsed', async () => {
    const stubPalace = {
      async search(): Promise<string> {
        return JSON.stringify({ results: [{ id: 'd-r', wing: 'w', room: 'r', text: 't' }] });
      },
    } as unknown as Parameters<typeof probePalaceSearch>[0];
    const r = await probePalaceSearch(stubPalace, 'goal');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].drawer_id).toBe('d-r');
  });

  test('§ 31.9.5 — palace returns {hits: [...]} envelope → still parsed', async () => {
    const stubPalace = {
      async search(): Promise<string> {
        return JSON.stringify({ hits: [{ id: 'd-h', wing: 'w', room: 'r' }] });
      },
    } as unknown as Parameters<typeof probePalaceSearch>[0];
    const r = await probePalaceSearch(stubPalace, 'goal');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].drawer_id).toBe('d-h');
  });

  test('§ 31.9.6 — palace returns empty string (unconfigured / unreachable) → empty findings, attempted=true, no error', async () => {
    const stubPalace = {
      async search(): Promise<string> { return ''; },
    } as unknown as Parameters<typeof probePalaceSearch>[0];
    const r = await probePalaceSearch(stubPalace, 'goal');
    expect(r.findings).toEqual([]);
    expect(r.attempted).toBe(true);
    expect(r.error).toBeUndefined();
  });

  test('§ 31.9.7 — palace returns malformed JSON → empty findings, no error (best-effort)', async () => {
    const stubPalace = {
      async search(): Promise<string> { return 'not-json {{{'; },
    } as unknown as Parameters<typeof probePalaceSearch>[0];
    const r = await probePalaceSearch(stubPalace, 'goal');
    expect(r.findings).toEqual([]);
    expect(r.attempted).toBe(true);
    expect(r.error).toBeUndefined();
  });

  test('§ 31.9.8 — palace timeout falls through silently (AC-86.2.2)', async () => {
    const stubPalace = {
      async search(): Promise<string> {
        // Resolves after the timeout — Promise.race should win the empty branch.
        return new Promise<string>((resolve) => setTimeout(() => resolve('[]'), 200));
      },
    } as unknown as Parameters<typeof probePalaceSearch>[0];
    const r = await probePalaceSearch(stubPalace, 'goal', 5, 50);
    expect(r.findings).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  test('§ 31.9.9 — palace.search throws → error captured, dispatch can continue', async () => {
    const stubPalace = {
      async search(): Promise<string> { throw new Error('palace process exited'); },
    } as unknown as Parameters<typeof probePalaceSearch>[0];
    const r = await probePalaceSearch(stubPalace, 'goal');
    expect(r.findings).toEqual([]);
    expect(r.error).toContain('palace process exited');
    expect(r.attempted).toBe(true);
  });

  test('§ 31.9.10 — content_preview truncates at 200 chars', async () => {
    const long = 'x'.repeat(500);
    const stubPalace = {
      async search(): Promise<string> {
        return JSON.stringify([{ id: 'd', wing: 'w', room: 'r', text: long }]);
      },
    } as unknown as Parameters<typeof probePalaceSearch>[0];
    const r = await probePalaceSearch(stubPalace, 'goal');
    expect(r.findings[0].content_preview).toHaveLength(200);
  });

  test('§ 31.9.11 — limit caps the number of findings', async () => {
    const stubPalace = {
      async search(_q: string, _w?: string, limit = 5): Promise<string> {
        // Honor limit at the source so the test exercises the cap end-to-end.
        return JSON.stringify(
          Array.from({ length: limit }, (_, i) => ({ id: `d-${i}`, wing: 'w', room: 'r' })),
        );
      },
    } as unknown as Parameters<typeof probePalaceSearch>[0];
    const r = await probePalaceSearch(stubPalace, 'goal', 3);
    expect(r.findings).toHaveLength(3);
  });

  test('§ 31.9.12 — PALACE_SEARCH_TIMEOUT_MS is exported for callers', () => {
    expect(typeof PALACE_SEARCH_TIMEOUT_MS).toBe('number');
    expect(PALACE_SEARCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PALACE_SEARCH_TIMEOUT_MS).toBeLessThanOrEqual(2000); // AC-86.2.4 budget
  });
});

describe('§ 31.10 — probeBrainContext (PHASE-86-02-C)', () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  // A minimally-shaped BrainContext covering the five surfaces the
  // probe maps. Tests pick what they need from this template via
  // shallow merge.
  type BrainCtx = Awaited<ReturnType<NonNullable<Parameters<typeof probeBrainContext>[2]>>>;
  const baseBrainCtx: BrainCtx = {
    sprint: null,
    stuck_jiras: [],
    noise_clusters: [],
    calendar_today: [],
    open_investigations: [],
    memory_relevant: [],
    stale_warnings: [],
  };

  test('§ 31.10.1 — null fetcher → empty findings, attempted=false, no error', async () => {
    const r = await probeBrainContext(db, 'maaz', null);
    expect(r.findings).toEqual([]);
    expect(r.attempted).toBe(false);
    expect(r.error).toBeUndefined();
  });

  test('§ 31.10.2 — fetcher resolves with sprint → maps to one BrainFinding kind=sprint', async () => {
    const fetcher: Parameters<typeof probeBrainContext>[2] = async () => ({
      ...baseBrainCtx,
      sprint: { name: 'Saturn-94', ends: '2026-06-30', fresh: true },
    });
    const r = await probeBrainContext(db, 'maaz', fetcher);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: 'sprint', label: 'Saturn-94' });
    expect(r.findings[0].detail).toContain('2026-06-30');
    expect(r.findings[0].detail).toContain('fresh');
    expect(r.attempted).toBe(true);
  });

  test('§ 31.10.3 — fetcher with stuck Jiras → maps each to kind=stuck_jira', async () => {
    const fetcher: Parameters<typeof probeBrainContext>[2] = async () => ({
      ...baseBrainCtx,
      stuck_jiras: [
        { key: 'DEMO-15702', days_stuck: 7, cluster: 'auth' },
        { key: 'DEMO-16141', days_stuck: 3, cluster: null },
      ],
    });
    const r = await probeBrainContext(db, 'maaz', fetcher);
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]).toMatchObject({ kind: 'stuck_jira', label: 'DEMO-15702' });
    expect(r.findings[0].detail).toContain('7d');
    expect(r.findings[0].detail).toContain('auth');
    expect(r.findings[1].detail).not.toContain('cluster='); // null cluster omitted
  });

  test('§ 31.10.4 — fetcher with calendar events → maps each to kind=calendar', async () => {
    const fetcher: Parameters<typeof probeBrainContext>[2] = async () => ({
      ...baseBrainCtx,
      calendar_today: [
        { time: '14:00', title: 'Cypher review', with: 'Maaz' },
        { time: '16:00', title: 'Solo focus block', with: null },
      ],
    });
    const r = await probeBrainContext(db, 'maaz', fetcher);
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]).toMatchObject({ kind: 'calendar', label: 'Cypher review' });
    expect(r.findings[0].detail).toContain('14:00');
    expect(r.findings[0].detail).toContain('Maaz');
    expect(r.findings[1].detail).not.toContain('with'); // null with omitted
  });

  test('§ 31.10.5 — fetcher with open investigations → maps to kind=open_investigation', async () => {
    const fetcher: Parameters<typeof probeBrainContext>[2] = async () => ({
      ...baseBrainCtx,
      open_investigations: [{ key: 'DEMO-15702', status: 'investigating' }],
    });
    const r = await probeBrainContext(db, 'maaz', fetcher);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      kind: 'open_investigation',
      label: 'DEMO-15702',
      detail: 'status=investigating',
    });
  });

  test('§ 31.10.6 — fetcher with stale warnings → maps each to kind=stale_warning', async () => {
    const fetcher: Parameters<typeof probeBrainContext>[2] = async () => ({
      ...baseBrainCtx,
      stale_warnings: ['no recent dispatches', 'sprint last updated 12d ago'],
    });
    const r = await probeBrainContext(db, 'maaz', fetcher);
    expect(r.findings).toHaveLength(2);
    expect(r.findings.every(f => f.kind === 'stale_warning')).toBe(true);
  });

  test('§ 31.10.7 — fetcher returning all five aspects → 1 sprint + 2 stuck + 2 cal + 1 inv + 1 warn = 7 findings', async () => {
    const fetcher: Parameters<typeof probeBrainContext>[2] = async () => ({
      sprint: { name: 'S-94', ends: null, fresh: false },
      stuck_jiras: [
        { key: 'A-1', days_stuck: 1, cluster: null },
        { key: 'A-2', days_stuck: 2, cluster: null },
      ],
      noise_clusters: [],
      calendar_today: [
        { time: '09:00', title: 'standup', with: null },
        { time: '15:00', title: 'review', with: null },
      ],
      open_investigations: [{ key: 'B-1', status: 'open' }],
      memory_relevant: [],
      stale_warnings: ['warn 1'],
    });
    const r = await probeBrainContext(db, 'maaz', fetcher);
    expect(r.findings).toHaveLength(7);
    const kinds = r.findings.map(f => f.kind);
    expect(kinds.filter(k => k === 'sprint')).toHaveLength(1);
    expect(kinds.filter(k => k === 'stuck_jira')).toHaveLength(2);
    expect(kinds.filter(k => k === 'calendar')).toHaveLength(2);
    expect(kinds.filter(k => k === 'open_investigation')).toHaveLength(1);
    expect(kinds.filter(k => k === 'stale_warning')).toHaveLength(1);
  });

  test('§ 31.10.8 — fetcher timeout → empty findings, attempted=true, no error (silent fall-through)', async () => {
    const fetcher: Parameters<typeof probeBrainContext>[2] = () =>
      new Promise<BrainCtx>((resolve) =>
        setTimeout(() => resolve({ ...baseBrainCtx, sprint: { name: 'late', ends: null, fresh: true } }), 200),
      );
    const r = await probeBrainContext(db, 'maaz', fetcher, undefined, 50);
    expect(r.findings).toEqual([]);
    expect(r.attempted).toBe(true);
    expect(r.error).toBeUndefined();
  });

  test('§ 31.10.9 — fetcher throws → error captured, attempted=true', async () => {
    const fetcher: Parameters<typeof probeBrainContext>[2] = async () => {
      throw new Error('brain context-builder failed');
    };
    const r = await probeBrainContext(db, 'maaz', fetcher);
    expect(r.findings).toEqual([]);
    expect(r.error).toContain('brain context-builder failed');
    expect(r.attempted).toBe(true);
  });

  test('§ 31.10.10 — empty BrainContext → empty findings, attempted=true, no error', async () => {
    const fetcher: Parameters<typeof probeBrainContext>[2] = async () => baseBrainCtx;
    const r = await probeBrainContext(db, 'maaz', fetcher);
    expect(r.findings).toEqual([]);
    expect(r.attempted).toBe(true);
    expect(r.error).toBeUndefined();
  });

  test('§ 31.10.11 — BRAIN_CONTEXT_TIMEOUT_MS is exported and within budget', () => {
    expect(typeof BRAIN_CONTEXT_TIMEOUT_MS).toBe('number');
    expect(BRAIN_CONTEXT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(BRAIN_CONTEXT_TIMEOUT_MS).toBeLessThanOrEqual(2000); // AC-86.2.4 budget
  });
});
