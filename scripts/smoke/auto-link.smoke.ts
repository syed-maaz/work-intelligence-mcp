/**
 * § 22 — Cypher PM-4 auto-link smoke (TS).
 *
 * Verifies the auto-link slice end-to-end:
 *   - Regex extractor pulls AC-shaped tokens from goal text
 *   - DB filter against work_items rejects unknown ids
 *   - /api/wi/dispatch surfaces auto_link_suggestions on every dispatch
 *   - /api/cypher/pm/link with kind='cypher_session_id' lands an evidence
 *     row that /api/cypher/pm/status reads back
 *
 * The dispatch hits we make here are recorded as Cypher sessions in the
 * live DB. That's intentional — the auto-link path is reachable only via
 * a real dispatch, and a session row per smoke run is acceptable noise
 * (the existing § 21 already creates them).
 */

import { describe, expect, test, beforeAll } from 'vitest';
import { waitForBridge, dispatch, pmLink, pmStatus } from './client.js';

beforeAll(async () => {
  const up = await waitForBridge({ maxAttempts: 5, intervalMs: 1_000 });
  if (!up) throw new Error('bridge not reachable on /api/status — start it with `npm run web:bridge`');
});

describe('§ 22 — Cypher PM-4 auto-link', () => {
  describe('§ 22.1 — dispatch surfaces auto_link_suggestions', () => {
    test('§ 22.1.1 — goal mentioning PM-4 yields PM-4 in existing_ids', async () => {
      // PM-4 is itself the slice we just shipped — but at smoke time it
      // exists as a work_item only if seeded. We pick PM-1 instead, which
      // is shipped and confirmed to exist in the rollup.
      const r = await dispatch({
        goal: 'Investigation: how does PM-1 work in the schema v60 lens?',
        task_class: 'understand',
      });
      expect(r.ok).toBe(true);
      const body = r.body!;
      expect(body.auto_link_suggestions).toBeDefined();
      expect(body.auto_link_suggestions!.existing_ids).toContain('PM-1');
    });

    test('§ 22.1.2 — goal with no AC tokens yields empty existing_ids', async () => {
      const r = await dispatch({
        goal: 'Refactor the unrelated helper file to drop dead code paths.',
        task_class: 'refactor',
      });
      expect(r.ok).toBe(true);
      expect(r.body!.auto_link_suggestions).toBeDefined();
      expect(r.body!.auto_link_suggestions!.existing_ids).toEqual([]);
    });

    test('§ 22.1.3 — goal with non-existent AC id surfaces in suggestions but not existing_ids', async () => {
      const r = await dispatch({
        goal: 'Working on PERSONA-AC-9999 which does not exist in the queue.',
        task_class: 'build-feature',
      });
      expect(r.ok).toBe(true);
      const bundle = r.body!.auto_link_suggestions!;
      // Suggestion list should contain the candidate (regex matched).
      const found = bundle.suggestions.find(s => s.id === 'PERSONA-AC-9999');
      expect(found).toBeDefined();
      expect(found!.exists).toBe(false);
      // But existing_ids must NOT contain it — DB filter caught it.
      expect(bundle.existing_ids).not.toContain('PERSONA-AC-9999');
    });

    test('§ 22.1.4 — multiple AC ids in goal land as multiple existing_ids', async () => {
      const r = await dispatch({
        goal: 'Cross-cutting work on PM-1 and PM-2 simultaneously.',
        task_class: 'build-feature',
      });
      expect(r.ok).toBe(true);
      const ids = r.body!.auto_link_suggestions!.existing_ids;
      expect(ids).toContain('PM-1');
      expect(ids).toContain('PM-2');
    });
  });

  describe('§ 22.2 — link round-trip via /api/cypher/pm/link', () => {
    test('§ 22.2.1 — link cypher_session_id → /status returns it as evidence', async () => {
      // Open a session so we have a stable session_id to link against.
      const open = await dispatch({
        goal: 'PM-4 smoke: link round-trip test for PM-1.',
        task_class: 'build-feature',
      });
      expect(open.ok).toBe(true);
      const sessionId = open.body!.session_id;
      expect(sessionId).toMatch(/^cyp_/);

      // Link it manually — mirrors what /wi-record-outcome --ac would do.
      const link = await pmLink({
        work_item_id: 'PM-1',
        evidence_kind: 'cypher_session_id',
        evidence_value: sessionId,
        note: '§ 22.2 smoke link',
      });
      expect(link.ok).toBe(true);

      // Read it back via /status.
      const status = await pmStatus('PM-1');
      expect(status.ok).toBe(true);
      const evidence = (status.body as { evidence: Array<{ evidence_kind: string; evidence_value: string }> }).evidence;
      const hit = evidence.find(
        e => e.evidence_kind === 'cypher_session_id' && e.evidence_value === sessionId,
      );
      expect(hit).toBeDefined();
    });

    test('§ 22.2.2 — link to unknown work_item returns 404 (best-effort fail)', async () => {
      const r = await pmLink({
        work_item_id: 'PM-DOES-NOT-EXIST',
        evidence_kind: 'cypher_session_id',
        evidence_value: 'cyp_smoke_22_2_2',
      });
      expect(r.status).toBe(404);
    });
  });

  describe('§ 22.3 — extractor edge cases', () => {
    test('§ 22.3.1 — JIRA-key superset of PERSONA-AC dedupes correctly', async () => {
      // PERSONA-AC-2 matches both the persona_ac pattern AND the
      // jira_key pattern. extractCandidates must surface it ONCE,
      // with persona_ac's higher confidence.
      const r = await dispatch({
        goal: 'Slice references PERSONA-AC-2 only.',
        task_class: 'understand',
      });
      expect(r.ok).toBe(true);
      const matches = r.body!.auto_link_suggestions!.suggestions.filter(
        s => s.id === 'PERSONA-AC-2',
      );
      expect(matches.length).toBe(1);
      expect(matches[0].confidence).toBe(1.0);
    });

    test('§ 22.3.2 — context text is scanned alongside goal', async () => {
      const r = await dispatch({
        goal: 'Routine refactor.',
        context: 'See PM-1 for the original spine slice.',
        task_class: 'refactor',
      });
      expect(r.ok).toBe(true);
      expect(r.body!.auto_link_suggestions!.existing_ids).toContain('PM-1');
    });
  });
});
