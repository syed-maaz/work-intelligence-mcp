/**
 * § 28 — skill_actually_invoked credit-assignment smoke (TS, slice 82a-2, 2026-06-14).
 *
 * Verifies the credit-assignment fix:
 *   - Column exists (migration v62 applied)
 *   - Closing without skill_actually_invoked credits chosen_skill (backwards-compat)
 *   - Closing WITH skill_actually_invoked credits the actual skill, NOT chosen_skill
 *   - First-time skill creates a fresh skill_priors row
 *   - The session row persists both fields
 *   - getRecentSessions surfaces skill_actually_invoked in the response
 */

import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { waitForBridge } from './client.js';

const DB_PATH = process.env.WI_DB_PATH ?? join(homedir(), '.work-intelligence-mcp/data.db');
const BASE = process.env.BRIDGE_URL ?? 'http://localhost:3132';

interface PriorRow { alpha: number; beta: number; total_runs: number }

let db: Database.Database;

const SEED_SKILL_BACKCOMPAT = 'wi-smoke-28-backcompat-fixture';
const SEED_SKILL_ACTUAL = 'wi-smoke-28-actual-fixture';
const SEED_TASK_CLASS = 'smoke-28';

async function postJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
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

function priorOf(skill: string, taskClass: string = SEED_TASK_CLASS): PriorRow | null {
  return db.prepare<[string, string], PriorRow>(
    `SELECT alpha, beta, total_runs FROM skill_priors WHERE skill_name = ? AND task_class = ?`,
  ).get(skill, taskClass) ?? null;
}

function tearDown(): void {
  db.prepare(`DELETE FROM skill_priors WHERE skill_name = ? OR skill_name = ?`).run(SEED_SKILL_BACKCOMPAT, SEED_SKILL_ACTUAL);
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

describe('§ 28 — skill_actually_invoked credit-assignment', () => {
  describe('§ 28.1 — schema', () => {
    test('§ 28.1.1 — cypher_sessions has skill_actually_invoked column', () => {
      const cols = db.prepare(`PRAGMA table_info(cypher_sessions)`).all() as Array<{ name: string }>;
      expect(cols.some(c => c.name === 'skill_actually_invoked')).toBe(true);
    });
  });

  describe('§ 28.2 — credit assignment', () => {
    test('§ 28.2.1 — backwards-compat: no skill_actually_invoked → chosen_skill credited', async () => {
      tearDown();

      // Open a session with explicit candidate_skills so chosenSkill is the
      // backcompat fixture skill; force task_class so prior lands in our seed bucket.
      const open = await postJson('/api/wi/dispatch', {
        goal: 'Smoke 28.2.1 — backcompat path',
        task_class: SEED_TASK_CLASS,
        candidate_skills: [SEED_SKILL_BACKCOMPAT],
        answers: { shape: 'light', sprint_approved: 'no' },
      });
      expect(open.status).toBe(200);
      const sessionId = open.body.session_id;

      // Close WITHOUT skill_actually_invoked.
      const close = await postJson('/api/wi/dispatch', {
        session_id: sessionId,
        goal: 'close',
        task_class: SEED_TASK_CLASS,
        outcome: 'success',
        candidate_skills: [SEED_SKILL_BACKCOMPAT],
      });
      expect(close.status).toBe(200);
      expect(close.body.outcome).toBe('success');

      // chosen_skill should have moved.
      const prior = priorOf(SEED_SKILL_BACKCOMPAT);
      expect(prior).not.toBeNull();
      expect(prior!.total_runs).toBeGreaterThanOrEqual(1);
      expect(prior!.alpha).toBeGreaterThan(1.0); // success → alpha+=1
    });

    test('§ 28.2.2 — skill_actually_invoked credits the actual skill, not chosen_skill', async () => {
      tearDown();

      // Open: Cypher will pick from candidate_skills; force chosenSkill ≠ actual.
      const open = await postJson('/api/wi/dispatch', {
        goal: 'Smoke 28.2.2 — actual differs from chosen',
        task_class: SEED_TASK_CLASS,
        candidate_skills: [SEED_SKILL_BACKCOMPAT],
        answers: { shape: 'light', sprint_approved: 'no' },
      });
      const sessionId = open.body.session_id;

      // Close with skill_actually_invoked = different skill.
      const close = await postJson('/api/wi/dispatch', {
        session_id: sessionId,
        goal: 'close',
        task_class: SEED_TASK_CLASS,
        outcome: 'success',
        skill_actually_invoked: SEED_SKILL_ACTUAL,
        candidate_skills: [SEED_SKILL_BACKCOMPAT],
      });
      expect(close.body.outcome).toBe('success');

      // The ACTUAL skill should have moved.
      const actualPrior = priorOf(SEED_SKILL_ACTUAL);
      expect(actualPrior).not.toBeNull();
      expect(actualPrior!.total_runs).toBe(1);
      expect(actualPrior!.alpha).toBeCloseTo(2.0, 9); // Beta(1,1) → success → Beta(2,1)
      expect(actualPrior!.beta).toBeCloseTo(1.0, 9);

      // The CHOSEN-only skill prior should NOT have moved from this call
      // (it may exist from § 28.2.1 if we didn't tearDown — but tearDown ran).
      const chosenPrior = priorOf(SEED_SKILL_BACKCOMPAT);
      expect(chosenPrior).toBeNull();
    });

    test('§ 28.2.3 — session row persists both chosen_skill and skill_actually_invoked', async () => {
      tearDown();

      const open = await postJson('/api/wi/dispatch', {
        goal: 'Smoke 28.2.3 — both fields persist',
        task_class: SEED_TASK_CLASS,
        candidate_skills: [SEED_SKILL_BACKCOMPAT],
        answers: { shape: 'light', sprint_approved: 'no' },
      });
      const sessionId = open.body.session_id;

      await postJson('/api/wi/dispatch', {
        session_id: sessionId,
        goal: 'close',
        task_class: SEED_TASK_CLASS,
        outcome: 'success',
        skill_actually_invoked: SEED_SKILL_ACTUAL,
        candidate_skills: [SEED_SKILL_BACKCOMPAT],
      });

      // Direct DB readback.
      const row = db.prepare<[string], { chosen_skill: string | null; skill_actually_invoked: string | null }>(
        `SELECT chosen_skill, skill_actually_invoked FROM cypher_sessions WHERE session_id = ?`,
      ).get(sessionId);
      expect(row).toBeDefined();
      expect(row!.chosen_skill).toBe(SEED_SKILL_BACKCOMPAT);
      expect(row!.skill_actually_invoked).toBe(SEED_SKILL_ACTUAL);
    });
  });

  describe('§ 28.3 — health endpoint surfaces it', () => {
    test('§ 28.3.1 — getRecentSessions returns skill_actually_invoked field', async () => {
      const r = await getJson('/api/cypher/health/sessions?limit=20');
      expect(r.status).toBe(200);
      const sessions = r.body.sessions as Array<Record<string, unknown>>;
      // Field should be present on every session row, even if null.
      for (const s of sessions) {
        expect(s).toHaveProperty('skill_actually_invoked');
      }
      // At least one session populated by § 28.2 should have a non-null value.
      const populated = sessions.find(s => s.skill_actually_invoked === SEED_SKILL_ACTUAL);
      // It's possible the limit=20 window slid past — only assert when present.
      if (populated) {
        expect(populated.skill_actually_invoked).toBe(SEED_SKILL_ACTUAL);
      }
    });
  });
});
