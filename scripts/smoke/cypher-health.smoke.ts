/**
 * § 26 — Cypher visibility panel endpoints smoke (TS, slice 81b, 2026-06-14).
 *
 * Verifies the three read-only health endpoints behave as the panel
 * needs them to:
 *   - GET /api/cypher/health/priors           — Beta priors + per-skill rate
 *   - GET /api/cypher/health/sessions?limit=N — recent sessions, validated input
 *   - GET /api/cypher/health/sessions/:id     — drill-down (steps + links + auto_actions)
 *
 * No DB writes. Tests are tolerant of the live DB state (zero-row buckets
 * pass shape checks; presence checks scope themselves to seeded fixtures).
 */

import { describe, expect, test, beforeAll } from 'vitest';
import { waitForBridge } from './client.js';

interface PriorsResponse {
  current: Array<{ skill_name: string; task_class: string; alpha: number; beta: number; mean: number; total_runs: number; updated_at: string }>;
  success_rate: Array<{ chosen_skill: string; successes: number; attempts: number; rate: number | null }>;
  generated_at: string;
}

interface SessionsResponse {
  sessions: Array<{
    session_id: string;
    goal: string;
    task_class: string | null;
    user: string;
    status: string;
    outcome: string | null;
    chosen_skill: string | null;
    complexity_verdict: string | null;
    started_at: string;
    completed_at: string | null;
    step_count: number;
    in_flight: boolean;
  }>;
  total: number;
}

interface SessionDetailResponse {
  session: SessionsResponse['sessions'][number];
  steps: Array<{ stage: string; stage_index: number; status: string; payload: unknown }>;
  links: Array<{ work_item_id: string; evidence_kind: string; evidence_value: string }>;
  auto_actions: Array<{ action: string; work_item_id: string; reason: string }>;
}

const BASE = process.env.BRIDGE_URL ?? 'http://localhost:3132';

async function get<T>(path: string): Promise<{ ok: boolean; status: number; body: T | { error?: string } | null }> {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(8_000) });
  let body: T | { error?: string } | null = null;
  try { body = await r.json() as T; } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, body };
}

beforeAll(async () => {
  const up = await waitForBridge({ maxAttempts: 5, intervalMs: 1_000 });
  if (!up) throw new Error('bridge not reachable on /api/status — start it with `npm run web:bridge`');
});

describe('§ 26 — Cypher visibility panel endpoints', () => {
  describe('§ 26.1 — /priors', () => {
    test('§ 26.1.1 — returns { current, success_rate, generated_at }', async () => {
      const r = await get<PriorsResponse>('/api/cypher/health/priors');
      expect(r.ok).toBe(true);
      const body = r.body as PriorsResponse;
      expect(Array.isArray(body.current)).toBe(true);
      expect(Array.isArray(body.success_rate)).toBe(true);
      expect(typeof body.generated_at).toBe('string');
      expect(() => new Date(body.generated_at).toISOString()).not.toThrow();
    });

    test('§ 26.1.2 — every prior has α≥1, β≥1, mean = α/(α+β) within float tolerance', async () => {
      const r = await get<PriorsResponse>('/api/cypher/health/priors');
      const body = r.body as PriorsResponse;
      for (const p of body.current) {
        expect(p.alpha).toBeGreaterThanOrEqual(1);
        expect(p.beta).toBeGreaterThanOrEqual(1);
        const expectedMean = p.alpha / (p.alpha + p.beta);
        expect(Math.abs(p.mean - expectedMean)).toBeLessThan(1e-9);
        expect(p.total_runs).toBeGreaterThanOrEqual(0);
      }
    });

    test('§ 26.1.3 — every success_rate row has successes ≤ attempts, both integers', async () => {
      const r = await get<PriorsResponse>('/api/cypher/health/priors');
      const body = r.body as PriorsResponse;
      for (const row of body.success_rate) {
        expect(Number.isInteger(row.successes)).toBe(true);
        expect(Number.isInteger(row.attempts)).toBe(true);
        expect(row.successes).toBeLessThanOrEqual(row.attempts);
        if (row.attempts > 0 && row.rate !== null) {
          expect(row.rate).toBeCloseTo(row.successes / row.attempts, 9);
        }
      }
    });
  });

  describe('§ 26.2 — /sessions', () => {
    test('§ 26.2.1 — limit=5 returns ≤5 sessions sorted by started_at desc', async () => {
      const r = await get<SessionsResponse>('/api/cypher/health/sessions?limit=5');
      expect(r.ok).toBe(true);
      const body = r.body as SessionsResponse;
      expect(body.sessions.length).toBeLessThanOrEqual(5);
      for (let i = 1; i < body.sessions.length; i++) {
        const prev = body.sessions[i - 1].started_at;
        const curr = body.sessions[i].started_at;
        // ISO/SQLite-ish strings sort lexicographically the same as chronologically.
        expect(prev >= curr).toBe(true);
      }
    });

    test('§ 26.2.2 — limit=0 and limit=999 both return 400', async () => {
      const tooLow = await get<{ error: string }>('/api/cypher/health/sessions?limit=0');
      expect(tooLow.status).toBe(400);
      const tooHigh = await get<{ error: string }>('/api/cypher/health/sessions?limit=999');
      expect(tooHigh.status).toBe(400);
    });

    test('§ 26.2.3 — every returned session has goal length ≤ 200 chars (truncation honored)', async () => {
      const r = await get<SessionsResponse>('/api/cypher/health/sessions?limit=20');
      const body = r.body as SessionsResponse;
      for (const s of body.sessions) {
        expect(s.goal.length).toBeLessThanOrEqual(200);
      }
    });
  });

  describe('§ 26.3 — /sessions/:id', () => {
    test('§ 26.3.1 — unknown id returns 404', async () => {
      const r = await get<{ error: string }>('/api/cypher/health/sessions/cyp_does_not_exist_xyz');
      expect(r.status).toBe(404);
    });

    test('§ 26.3.2 — known id returns full shape (session + steps + links + auto_actions)', async () => {
      // Use the most recent real session id from /sessions to avoid
      // brittleness on a specific seeded id.
      const list = await get<SessionsResponse>('/api/cypher/health/sessions?limit=1');
      const body = list.body as SessionsResponse;
      if (body.sessions.length === 0) return; // empty DB — nothing to drill into

      const id = body.sessions[0].session_id;
      const r = await get<SessionDetailResponse>(`/api/cypher/health/sessions/${id}`);
      expect(r.ok).toBe(true);
      const detail = r.body as SessionDetailResponse;
      expect(detail.session).toBeDefined();
      expect(detail.session.session_id).toBe(id);
      expect(Array.isArray(detail.steps)).toBe(true);
      expect(Array.isArray(detail.links)).toBe(true);
      expect(Array.isArray(detail.auto_actions)).toBe(true);
      // Steps when present must be in stage_index order.
      for (let i = 1; i < detail.steps.length; i++) {
        expect(detail.steps[i].stage_index).toBeGreaterThanOrEqual(detail.steps[i - 1].stage_index);
      }
    });
  });
});
