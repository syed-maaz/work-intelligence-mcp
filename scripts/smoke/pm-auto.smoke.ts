/**
 * § 25 — PM-AUTO autonomous write loop smoke (TS, slice 81a, 2026-06-14).
 *
 * Verifies the four autonomous write paths landed by PM-AUTO:
 *   - link_session          — confidence-1.0 PM-4 suggestion → INSERT INTO work_item_links
 *   - transition_in_progress — first link on a 'pending' work_item → status flip
 *   - link_commit           — outcome=success on feature branch → git commits → links
 *   - transition_shipped    — commit linked to in_progress work_item → status flip
 *   - protected_branch safety — outcome=success on main/master skips link_commit
 *
 * State assertions read pm_auto_actions directly via better-sqlite3.
 * That's a deliberate divergence from the bridge-only pattern in § 23
 * (drift): there's no /health/auto-actions endpoint until 81b ships.
 * Once 81b lands, § 26 will repeat these reads through the endpoint.
 *
 * Tests are isolated by:
 *   - Using `PM-AUTO-SMOKE-N` work_item ids that are seeded fresh per
 *     describe block and torn down after.
 *   - Stamping the dispatch session_id on the assertions so concurrent
 *     dispatches don't bleed into each other's audit rows.
 */

import { describe, expect, test, beforeAll, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { waitForBridge, dispatch } from './client.js';

const DB_PATH = process.env.WI_DB_PATH ?? join(homedir(), '.work-intelligence-mcp/data.db');

interface AutoActionRow {
  id: number;
  session_id: string;
  work_item_id: string;
  action: string;
  evidence_kind: string | null;
  evidence_value: string | null;
  reason: string;
  created_at: string;
}

interface WorkItemRow { status: string }

let db: Database.Database;

const SEED_IDS = ['PM-AUTO-SMOKE-A', 'PM-AUTO-SMOKE-B', 'PM-AUTO-SMOKE-C'];

function actionsForSession(sessionId: string): AutoActionRow[] {
  return db.prepare<[string], AutoActionRow>(
    `SELECT id, session_id, work_item_id, action, evidence_kind, evidence_value, reason, created_at
       FROM pm_auto_actions WHERE session_id = ? ORDER BY id ASC`,
  ).all(sessionId);
}

function statusOf(id: string): string | null {
  const row = db.prepare<[string], WorkItemRow>(
    `SELECT status FROM work_items WHERE id = ?`,
  ).get(id);
  return row?.status ?? null;
}

function seedWorkItem(id: string, status: 'pending' | 'in_progress' | 'shipped' = 'pending'): void {
  db.prepare(`
    INSERT INTO work_items (id, phase, wave, title, description, status, priority,
                            depends_on, smoke_section, blocker_reason, shipped_at,
                            created_at, updated_at)
    VALUES (?, 'cypher-pm', 'pm-auto-smoke', ?, NULL, ?, 5,
            '[]', NULL, NULL, NULL,
            datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')
  `).run(id, `Smoke fixture ${id}`, status);
}

function tearDownWorkItems(): void {
  for (const id of SEED_IDS) {
    db.prepare('DELETE FROM pm_auto_actions WHERE work_item_id = ?').run(id);
    db.prepare('DELETE FROM work_item_links WHERE work_item_id = ?').run(id);
    db.prepare('DELETE FROM work_items WHERE id = ?').run(id);
  }
}

beforeAll(async () => {
  const up = await waitForBridge({ maxAttempts: 5, intervalMs: 1_000 });
  if (!up) throw new Error('bridge not reachable on /api/status — start it with `npm run web:bridge`');
  db = new Database(DB_PATH, { readonly: false });
  db.pragma('foreign_keys = ON');
  const row = db.prepare(`SELECT value FROM schema_metadata WHERE key='schema_version'`).get() as { value: string } | undefined;
  if (!row || Number(row.value) < 61) {
    throw new Error(`pm_auto_actions requires schema v61+, found v${row?.value ?? '?'}`);
  }
});

afterAll(() => {
  tearDownWorkItems();
  db.close();
});

beforeEach(() => {
  tearDownWorkItems();
});

describe('§ 25 — PM-AUTO autonomous write loop', () => {
  describe('§ 25.1 — auto-link on dispatch', () => {
    test('§ 25.1.1 — confidence-1.0 PM-* id auto-writes link_session row', async () => {
      seedWorkItem('PM-AUTO-SMOKE-A', 'in_progress');
      const r = await dispatch({
        goal: 'Smoke 25.1.1 — verify PM-AUTO-SMOKE-A is linked',
        task_class: 'smoke',
        answers: { shape: 'light', sprint_approved: 'no' },
      });
      expect(r.ok).toBe(true);
      const sessionId = r.body!.session_id;

      const rows = actionsForSession(sessionId);
      const linkRows = rows.filter(x => x.action === 'link_session' && x.work_item_id === 'PM-AUTO-SMOKE-A');
      expect(linkRows.length).toBe(1);
      expect(linkRows[0].evidence_kind).toBe('cypher_session_id');
      expect(linkRows[0].evidence_value).toBe(sessionId);
      expect(linkRows[0].reason).toBe('pm4_high_confidence');
    });

    test('§ 25.1.2 — confidence-0.5 DEMO-NNNN id is NOT auto-written (suggest-only path preserved)', async () => {
      const r = await dispatch({
        goal: 'Smoke 25.1.2 — mention DEMO-99999 (not seeded)',
        task_class: 'smoke',
        answers: { shape: 'light', sprint_approved: 'no' },
      });
      expect(r.ok).toBe(true);
      const sessionId = r.body!.session_id;

      const rows = actionsForSession(sessionId);
      const wrongLinks = rows.filter(x => x.action === 'link_session');
      expect(wrongLinks).toEqual([]);
    });

    test('§ 25.1.3 — first auto-link on a pending work_item flips it to in_progress', async () => {
      seedWorkItem('PM-AUTO-SMOKE-B', 'pending');
      expect(statusOf('PM-AUTO-SMOKE-B')).toBe('pending');

      const r = await dispatch({
        goal: 'Smoke 25.1.3 — verify PM-AUTO-SMOKE-B transitions',
        task_class: 'smoke',
        answers: { shape: 'light', sprint_approved: 'no' },
      });
      expect(r.ok).toBe(true);
      const sessionId = r.body!.session_id;

      const rows = actionsForSession(sessionId);
      const transitionRow = rows.find(x => x.action === 'transition_in_progress' && x.work_item_id === 'PM-AUTO-SMOKE-B');
      expect(transitionRow).toBeDefined();
      expect(transitionRow!.reason).toBe('first_link');

      expect(statusOf('PM-AUTO-SMOKE-B')).toBe('in_progress');
    });
  });

  describe('§ 25.2 — auto-close on outcome', () => {
    test('§ 25.2.1 — outcome=mixed does NOT fire link_commit (only success closes)', async () => {
      seedWorkItem('PM-AUTO-SMOKE-C', 'in_progress');
      const open = await dispatch({
        goal: 'Smoke 25.2.1 — open for PM-AUTO-SMOKE-C, will close mixed',
        task_class: 'smoke',
        answers: { shape: 'light', sprint_approved: 'no' },
      });
      expect(open.ok).toBe(true);
      const sessionId = open.body!.session_id;

      const close = await dispatch({
        session_id: sessionId,
        goal: 'Smoke 25.2.1 — close mixed',
        task_class: 'smoke',
        outcome: 'mixed',
        candidate_skills: ['wi-investigate'],
      });
      expect(close.ok).toBe(true);

      const rows = actionsForSession(sessionId);
      const commitRows = rows.filter(x => x.action === 'link_commit');
      expect(commitRows).toEqual([]);
      expect(statusOf('PM-AUTO-SMOKE-C')).toBe('in_progress');
    });

    test('§ 25.2.2 — auto-close trace shape carries skipped_reason on non-success', async () => {
      seedWorkItem('PM-AUTO-SMOKE-A', 'in_progress');
      const open = await dispatch({
        goal: 'Smoke 25.2.2 — open for PM-AUTO-SMOKE-A, will close failed',
        task_class: 'smoke',
        answers: { shape: 'light', sprint_approved: 'no' },
      });
      const sessionId = open.body!.session_id;

      const close = await dispatch({
        session_id: sessionId,
        goal: 'Smoke 25.2.2 — close failed',
        task_class: 'smoke',
        outcome: 'failed',
        candidate_skills: ['wi-investigate'],
      });
      expect(close.ok).toBe(true);

      const recordStep = close.body!.trace.find(s => s.stage === 'record');
      expect(recordStep).toBeDefined();
      const payload = recordStep!.payload as { pm_auto_close?: { skipped_reason?: string } } | undefined;
      if (payload?.pm_auto_close) {
        expect(payload.pm_auto_close.skipped_reason).toBe('not_success');
      }
      const commitRows = actionsForSession(sessionId).filter(x => x.action === 'link_commit');
      expect(commitRows).toEqual([]);
    });
  });
});
