/**
 * § 27 — Stale-pending sweep smoke (TS, slice 82a-1, 2026-06-14).
 *
 * Verifies the pre-existing-session-rot UX:
 *   - GET /api/cypher/health/sessions/stale flags pending-and-old
 *   - POST /api/cypher/health/sessions/sweep closes them in batch and
 *     moves the Beta priors for sessions with chosen_skill
 *   - sweep refuses outcome=success at the type boundary
 *   - sweep is idempotent on already-closed sessions
 *
 * Tests seed disposable session rows directly into the DB so we can
 * control timestamps. Real bridge dispatches won't backdate past the
 * stale window in <1s, so seeding is the only reliable path.
 *
 * Cleanup: tests delete only the seeded session_ids. Existing live
 * sessions are untouched (we don't sweep them in smoke).
 */

import { describe, expect, test, beforeAll, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { waitForBridge } from './client.js';

const DB_PATH = process.env.WI_DB_PATH ?? join(homedir(), '.work-intelligence-mcp/data.db');
const BASE = process.env.BRIDGE_URL ?? 'http://localhost:3132';

interface PriorRow { alpha: number; beta: number; total_runs: number }
interface SessionRow { status: string; outcome: string | null }

let db: Database.Database;

const SEED_PREFIX = 'cyp_smoke_27_';
const SEED_SKILL = 'wi-stale-smoke-fixture';
const SEED_TASK_CLASS = 'stale-smoke';

async function postJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  let parsed: any = null;
  try { parsed = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: parsed };
}

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(8_000) });
  let parsed: any = null;
  try { parsed = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: parsed };
}

function seedSession(id: string, ageHours: number, opts: { chosenSkill?: string | null; status?: string } = {}): void {
  const ageMs = ageHours * 3_600_000;
  const startedAt = new Date(Date.now() - ageMs).toISOString().replace('T', ' ').replace(/\..+$/, '');
  db.prepare(`
    INSERT OR REPLACE INTO cypher_sessions
      (session_id, goal, context, task_class, chosen_skill, user, status, outcome,
       outcome_note, total_tokens, duration_ms, allow_destructive, started_at, completed_at)
    VALUES (?, ?, NULL, ?, ?, 'smoke-27', ?, NULL, NULL, 0, NULL, 0, ?, NULL)
  `).run(
    id,
    `Smoke § 27 fixture ${id}`,
    SEED_TASK_CLASS,
    opts.chosenSkill === undefined ? SEED_SKILL : opts.chosenSkill,
    opts.status ?? 'pending',
    startedAt,
  );
}

function tearDown(): void {
  db.prepare(`DELETE FROM cypher_sessions WHERE session_id LIKE ?`).run(`${SEED_PREFIX}%`);
  db.prepare(`DELETE FROM skill_priors WHERE skill_name = ?`).run(SEED_SKILL);
}

function priorOf(skill: string, taskClass: string = SEED_TASK_CLASS): PriorRow | null {
  return db.prepare<[string, string], PriorRow>(
    `SELECT alpha, beta, total_runs FROM skill_priors WHERE skill_name = ? AND task_class = ?`,
  ).get(skill, taskClass) ?? null;
}

function sessionRow(id: string): SessionRow | null {
  return db.prepare<[string], SessionRow>(
    `SELECT status, outcome FROM cypher_sessions WHERE session_id = ?`,
  ).get(id) ?? null;
}

beforeAll(async () => {
  const up = await waitForBridge({ maxAttempts: 5, intervalMs: 1_000 });
  if (!up) throw new Error('bridge not reachable on /api/status — start it with `npm run web:bridge`');
  db = new Database(DB_PATH, { readonly: false });
  db.pragma('foreign_keys = ON');
});

afterAll(() => {
  tearDown();
  db.close();
});

beforeEach(() => {
  tearDown();
});

describe('§ 27 — stale-pending sweep', () => {
  describe('§ 27.1 — stale endpoint', () => {
    test('§ 27.1.1 — returns sessions older than ageHours, omits fresh ones', async () => {
      seedSession(`${SEED_PREFIX}old1`, 5);     // 5h old → stale at default 2h
      seedSession(`${SEED_PREFIX}old2`, 3);     // 3h old → stale
      seedSession(`${SEED_PREFIX}fresh`, 0.1);  // 6 min old → not stale

      // limit=500 because the live DB has many real stale sessions; seeded
      // fixtures need a wide enough window to land in the response.
      const r = await getJson('/api/cypher/health/sessions/stale?ageHours=2&limit=500');
      expect(r.status).toBe(200);
      const ids = (r.body.sessions as Array<{ session_id: string }>).map(s => s.session_id);
      expect(ids).toContain(`${SEED_PREFIX}old1`);
      expect(ids).toContain(`${SEED_PREFIX}old2`);
      expect(ids).not.toContain(`${SEED_PREFIX}fresh`);
    });

    test('§ 27.1.2 — returns newest first (most recently stuck at top)', async () => {
      seedSession(`${SEED_PREFIX}10h`, 10);
      seedSession(`${SEED_PREFIX}3h`, 3);
      seedSession(`${SEED_PREFIX}5h`, 5);

      const r = await getJson('/api/cypher/health/sessions/stale?ageHours=2&limit=500');
      const seeded = (r.body.sessions as Array<{ session_id: string }>)
        .map(s => s.session_id)
        .filter(id => id.startsWith(SEED_PREFIX));
      // Newest-first: 3h-old (most recently stuck) appears before 5h before 10h.
      expect(seeded.indexOf(`${SEED_PREFIX}3h`)).toBeLessThan(seeded.indexOf(`${SEED_PREFIX}5h`));
      expect(seeded.indexOf(`${SEED_PREFIX}5h`)).toBeLessThan(seeded.indexOf(`${SEED_PREFIX}10h`));
    });
  });

  describe('§ 27.2 — sweep endpoint', () => {
    test('§ 27.2.1 — sweeping mixed closes the session and moves the prior', async () => {
      seedSession(`${SEED_PREFIX}sweep1`, 5);
      // Confirm prior doesn't exist yet.
      expect(priorOf(SEED_SKILL)).toBeNull();

      const r = await postJson('/api/cypher/health/sessions/sweep', {
        session_ids: [`${SEED_PREFIX}sweep1`],
        outcome: 'mixed',
      });
      expect(r.status).toBe(200);
      expect(r.body.swept).toBe(1);
      expect(r.body.swept_ids).toEqual([`${SEED_PREFIX}sweep1`]);

      // Session row updated.
      const row = sessionRow(`${SEED_PREFIX}sweep1`);
      expect(row?.status).toBe('done');
      expect(row?.outcome).toBe('mixed');

      // Beta prior moved: mixed splits 0.5α + 0.5β. Seeded as Beta(1,1) →
      // becomes Beta(1.5, 1.5).
      const prior = priorOf(SEED_SKILL);
      expect(prior).not.toBeNull();
      expect(prior!.alpha).toBeCloseTo(1.5, 9);
      expect(prior!.beta).toBeCloseTo(1.5, 9);
      expect(prior!.total_runs).toBe(1);
    });

    test('§ 27.2.2 — outcome=success returns 400', async () => {
      const r = await postJson('/api/cypher/health/sessions/sweep', {
        session_ids: ['anything'],
        outcome: 'success',
      });
      expect(r.status).toBe(400);
    });

    test('§ 27.2.3 — non-existent and already-closed ids reported separately', async () => {
      seedSession(`${SEED_PREFIX}closed`, 5, { status: 'done' });
      seedSession(`${SEED_PREFIX}good`, 5);

      const r = await postJson('/api/cypher/health/sessions/sweep', {
        session_ids: [`${SEED_PREFIX}closed`, `${SEED_PREFIX}good`, `${SEED_PREFIX}nope`],
        outcome: 'failed',
      });
      expect(r.status).toBe(200);
      expect(r.body.swept).toBe(1);
      expect(r.body.swept_ids).toEqual([`${SEED_PREFIX}good`]);
      expect(r.body.already_closed).toEqual([`${SEED_PREFIX}closed`]);
      expect(r.body.not_found).toEqual([`${SEED_PREFIX}nope`]);
    });

    test('§ 27.2.4 — sweeping a session with chosen_skill=null skips the prior write', async () => {
      seedSession(`${SEED_PREFIX}noskill`, 5, { chosenSkill: null });

      const r = await postJson('/api/cypher/health/sessions/sweep', {
        session_ids: [`${SEED_PREFIX}noskill`],
        outcome: 'mixed',
      });
      expect(r.body.swept).toBe(1);
      // No prior should appear for SEED_SKILL because chosen_skill was null.
      expect(priorOf(SEED_SKILL)).toBeNull();
      // Session still got closed.
      expect(sessionRow(`${SEED_PREFIX}noskill`)?.status).toBe('done');
    });

    test('§ 27.2.5 — > 50 ids returns 400', async () => {
      const ids = Array.from({ length: 51 }, (_, i) => `${SEED_PREFIX}batch${i}`);
      const r = await postJson('/api/cypher/health/sessions/sweep', {
        session_ids: ids,
        outcome: 'mixed',
      });
      expect(r.status).toBe(400);
    });
  });
});
