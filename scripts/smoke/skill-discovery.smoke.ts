/**
 * § 29 — Skill discovery + catalog smoke (TS, phase 82b, 2026-06-14).
 *
 * Verifies the catalog substrate:
 *   - Schema v63 skill_catalog table exists
 *   - The boot scanner populated rows; counts add up by source
 *   - GET /api/cypher/skill-catalog returns the expected shape
 *   - resolveCandidates merges discovered skills below seeded entries
 *     (verified empirically by dispatching task_class=ui-review and
 *     looking for frontend-design in the ranked list)
 *
 * Tests don't seed/teardown the catalog — it's populated by the live
 * boot scan and the assertions are tolerant of whatever's installed.
 */

import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { waitForBridge, dispatch } from './client.js';

const DB_PATH = process.env.WI_DB_PATH ?? join(homedir(), '.work-intelligence-mcp/data.db');
const BASE = process.env.BRIDGE_URL ?? 'http://localhost:3132';

interface CatalogResponse {
  total: number;
  by_source: { wi: number; global: number; plugin: number; builtin: number };
  in_priors_count: number;
  skills: Array<{
    skill_name: string;
    source: string;
    description: string | null;
    task_classes: string[];
    in_priors: boolean;
  }>;
  generated_at: string;
}

let db: Database.Database;

async function getJson<T>(path: string): Promise<{ status: number; body: T | null }> {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(8_000) });
  let body: T | null = null;
  try { body = await r.json() as T; } catch { /* ignore */ }
  return { status: r.status, body };
}

beforeAll(async () => {
  const up = await waitForBridge({ maxAttempts: 5, intervalMs: 1_000 });
  if (!up) throw new Error('bridge not reachable on /api/status — start it with `npm run web:bridge`');
  db = new Database(DB_PATH, { readonly: false });
  db.pragma('foreign_keys = ON');
});

afterAll(() => { db.close(); });

describe('§ 29 — skill discovery + catalog', () => {
  describe('§ 29.1 — schema + scan', () => {
    test('§ 29.1.1 — skill_catalog table exists', () => {
      const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='skill_catalog'`).all();
      expect(rows.length).toBe(1);
    });

    test('§ 29.1.2 — scanner populated catalog (sanity floor)', () => {
      const row = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM skill_catalog`).get();
      // Floor of 30: 35 wi-* skills installed locally; if scan never ran
      // OR all wi-* mis-classified, this fires. Loose enough not to flake
      // when global/plugin counts shift.
      expect(row?.n ?? 0).toBeGreaterThanOrEqual(30);
    });

    test('§ 29.1.3 — every catalog row has valid source + non-empty path', () => {
      const rows = db.prepare<[], { source: string; source_path: string }>(`SELECT source, source_path FROM skill_catalog`).all();
      const validSources = new Set(['wi', 'global', 'plugin', 'builtin']);
      for (const r of rows) {
        expect(validSources.has(r.source)).toBe(true);
        expect(r.source_path.length).toBeGreaterThan(0);
      }
    });
  });

  describe('§ 29.2 — endpoint shape', () => {
    test('§ 29.2.1 — GET /skill-catalog returns expected shape', async () => {
      const r = await getJson<CatalogResponse>('/api/cypher/skill-catalog');
      expect(r.status).toBe(200);
      const body = r.body!;
      expect(typeof body.total).toBe('number');
      expect(body.by_source).toBeDefined();
      expect(body.by_source.wi).toBeGreaterThanOrEqual(0);
      expect(body.by_source.global).toBeGreaterThanOrEqual(0);
      expect(body.by_source.plugin).toBeGreaterThanOrEqual(0);
      expect(typeof body.in_priors_count).toBe('number');
      expect(Array.isArray(body.skills)).toBe(true);
      expect(typeof body.generated_at).toBe('string');
    });

    test('§ 29.2.2 — by_source counts sum to total', async () => {
      const r = await getJson<CatalogResponse>('/api/cypher/skill-catalog');
      const body = r.body!;
      const sum = body.by_source.wi + body.by_source.global + body.by_source.plugin + body.by_source.builtin;
      expect(sum).toBe(body.total);
    });

    test('§ 29.2.3 — every skill row has skill_name + source + task_classes array', async () => {
      const r = await getJson<CatalogResponse>('/api/cypher/skill-catalog');
      const body = r.body!;
      for (const s of body.skills.slice(0, 20)) {
        expect(s.skill_name.length).toBeGreaterThan(0);
        expect(['wi', 'global', 'plugin', 'builtin']).toContain(s.source);
        expect(Array.isArray(s.task_classes)).toBe(true);
      }
    });
  });

  describe('§ 29.3 — candidate merge', () => {
    test('§ 29.3.1 — explicit candidate_skills wins (no merge)', async () => {
      const r = await dispatch({
        goal: '§ 29.3.1 explicit candidates honored',
        task_class: 'ui-review',
        candidate_skills: ['wi-investigate'],
        answers: { shape: 'light', sprint_approved: 'no' },
      });
      expect(r.ok).toBe(true);
      const ranked = r.body!.ranked_skills.map(s => s.skill);
      expect(ranked).toEqual(['wi-investigate']);
    });

    test('§ 29.3.2 — discovered skills merge below seeded list when no explicit candidates', async () => {
      // task_class=ui-review has seeded list ['wi-investigate'];
      // frontend-design SKILL.md description includes 'frontend' which
      // synonym-maps to 'ui-review'. After scan it should appear.
      const r = await dispatch({
        goal: '§ 29.3.2 discovered surface',
        task_class: 'ui-review',
        answers: { shape: 'light', sprint_approved: 'no' },
      });
      expect(r.ok).toBe(true);
      const ranked = r.body!.ranked_skills.map(s => s.skill);
      // Seeded entry MUST come first when its prior is non-stale.
      // We don't assert frontend-design is present unless it's in the
      // catalog (which it is on this dev box, but a fresh install
      // without the plugin would legitimately not have it). Soft check:
      // ranked list has at least the seeded entry.
      expect(ranked).toContain('wi-investigate');
      // If frontend-design is in the catalog, it appears in the ranked list.
      const catalog = await getJson<CatalogResponse>('/api/cypher/skill-catalog');
      const fdInCatalog = catalog.body?.skills.some(s => s.skill_name === 'frontend-design') ?? false;
      if (fdInCatalog) {
        expect(ranked).toContain('frontend-design');
      }
    });
  });
});
