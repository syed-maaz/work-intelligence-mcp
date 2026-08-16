/**
 * Phase 70-05 — Cross-consumer parity suite (T-70-01 mitigation).
 *
 * Threat T-70-01: UI / Atlas / MCP drift if any consumer bypasses /api/brain/*.
 * This suite locks down that threat by asserting that the same (question, user,
 * day) triplet yields an identical decision_id, decision text, rationale, and
 * evidence shape regardless of which X-WI-Consumer header is sent.
 *
 * Why this works:
 *   cache_key = sha256(normalize(question) \x1F user \x1F day_iso_utc)
 *   consumer does NOT enter the cache_key formula (ADR-024 lines 244-272).
 *   Therefore all three consumers collapse onto the same brain_decisions row.
 *
 * Test cases:
 *   P1  Same question + user + day via ui/atlas/mcp → identical decision_id,
 *       decision text, rationale, and evidence shape. Calls 2+3 are cache hits.
 *   P2  brain_decisions has exactly 1 row for the parity question; consumer='ui'
 *       (the first call's consumer value is preserved — later cache hits don't
 *       overwrite the consumer column).
 *   P3  Different question (same user + day) → different decision_id.
 *
 * Transport: node:http against the running bridge at WI_BRIDGE_URL
 * (default http://localhost:3132). Suite skips gracefully when bridge is
 * unreachable — no in-process app boot required.
 */

import http from 'node:http';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupFixtures, dbExists, openBrainTestDb } from './fixtures.js';

// ── Config ─────────────────────────────────────────────────────────────────

const BASE_URL = process.env.WI_BRIDGE_URL ?? 'http://localhost:3132';
const STATUS_PROBE_TIMEOUT_MS = 1500;
const CONTEXT_TIMEOUT_MS = 5000;
// Allow generous timeout for live LLM round-trips (10-18s observed in 69-06).
const DECIDE_TIMEOUT_MS = 35000;

// ── HTTP helper ─────────────────────────────────────────────────────────────

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

function request(
  method: 'GET' | 'POST',
  pathname: string,
  opts: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE_URL);
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(opts.headers ?? {}),
    };
    if (bodyStr !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const start = Date.now();
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const durationMs = Date.now() - start;
          const flatHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') flatHeaders[k.toLowerCase()] = v;
            else if (Array.isArray(v)) flatHeaders[k.toLowerCase()] = v.join(',');
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: flatHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
            durationMs,
          });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs ?? 5000, () => {
      req.destroy(new Error(`request timeout after ${opts.timeoutMs ?? 5000}ms`));
    });
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

function parseJson<T = unknown>(body: string): T {
  return JSON.parse(body) as T;
}

// ── Bridge reachability probe ───────────────────────────────────────────────

interface BridgeProbe {
  reachable: boolean;
  brainDecideHealthy: boolean;
  reason?: string;
}

async function probeBridge(): Promise<BridgeProbe> {
  try {
    const res = await request('GET', '/api/status', { timeoutMs: STATUS_PROBE_TIMEOUT_MS });
    if (res.status !== 200) {
      return {
        reachable: false,
        brainDecideHealthy: false,
        reason: `bridge /api/status returned ${res.status}`,
      };
    }
  } catch (err) {
    return {
      reachable: false,
      brainDecideHealthy: false,
      reason: `bridge ${BASE_URL}/api/status unreachable: ${(err as Error).message}`,
    };
  }

  // Verify brain context endpoint responds (proxy for brain routes being alive).
  try {
    const res = await request('GET', `/api/brain/context?user=${encodeURIComponent('probe')}`, {
      timeoutMs: CONTEXT_TIMEOUT_MS,
    });
    if (res.status !== 200) {
      return {
        reachable: true,
        brainDecideHealthy: false,
        reason: `GET /api/brain/context returned ${res.status}: ${res.body.slice(0, 200)}`,
      };
    }
    return { reachable: true, brainDecideHealthy: true };
  } catch (err) {
    return {
      reachable: true,
      brainDecideHealthy: false,
      reason: `GET /api/brain/context errored: ${(err as Error).message}`,
    };
  }
}

// ── Suite-wide setup ───────────────────────────────────────────────────────

let probe: BridgeProbe = { reachable: false, brainDecideHealthy: false };
// Unique tag embedded in the parity question to prevent collision with other
// test runs on the same (user, day) — the question is part of cache_key.
let suiteRunId: string;
// decision_ids inserted during this suite that must be cleaned up.
const insertedDecisionIds: string[] = [];

const PARITY_USER = 'USR12345-test-70-05';

beforeAll(async () => {
  probe = await probeBridge();
  if (!dbExists()) {
    probe = {
      reachable: false,
      brainDecideHealthy: false,
      reason: `live DB not found; ${probe.reason ?? ''}`.trim(),
    };
  }
  if (probe.reachable && probe.brainDecideHealthy) {
    suiteRunId = `70-05-${Date.now().toString(36)}`;
  }
}, 15_000);

afterAll(() => {
  if (insertedDecisionIds.length > 0) {
    const db = openBrainTestDb();
    try {
      cleanupFixtures(db, insertedDecisionIds);
      console.log(`[70-05 afterAll] cleaned up ${insertedDecisionIds.length} parity decision row(s)`);
    } finally {
      db.close();
    }
  }
});

// ── Test cases ─────────────────────────────────────────────────────────────

describe('cross-consumer parity', () => {

  // P1 — core parity assertion: same question + user + day via all 3 consumers
  it('P1 same question via ui / atlas / mcp consumers → identical decision_id + decision + rationale + evidence', { timeout: 120_000 }, async () => {
    if (!probe.brainDecideHealthy) {
      console.warn(`[skip P1] ${probe.reason ?? 'bridge brain endpoints unreachable'}`);
      return;
    }

    const question = `[parity ${suiteRunId}] which task should I focus on to unblock the team?`;
    const payload = { question, user: PARITY_USER };
    const consumers: Array<'ui' | 'atlas' | 'mcp'> = ['ui', 'atlas', 'mcp'];

    type DecisionBody = {
      decision_id: string;
      decision: string;
      rationale: string;
      evidence: unknown[];
      cache_hit: boolean;
      confidence: number;
      next_actions: unknown[];
      alternatives: unknown[];
      outcome: string;
      created_at: string | number;
    };

    const results: DecisionBody[] = [];

    for (const consumer of consumers) {
      const res = await request('POST', '/api/brain/decide', {
        body: payload,
        headers: { 'X-WI-Consumer': consumer },
        timeoutMs: DECIDE_TIMEOUT_MS,
      });
      console.log(`[P1] consumer=${consumer} status=${res.status} dur=${res.durationMs}ms`);
      expect(res.status, `consumer=${consumer} expect 200`).toBe(200);
      const body = parseJson<DecisionBody>(res.body);
      expect(typeof body.decision_id, `consumer=${consumer} decision_id type`).toBe('string');
      expect(String(body.decision_id).startsWith('dec_'), `consumer=${consumer} decision_id prefix`).toBe(true);
      results.push(body);
    }

    const [uiBody, atlasBody, mcpBody] = results;

    // Core parity assertion: all three share the same decision_id.
    expect(atlasBody.decision_id, 'atlas decision_id === ui decision_id').toBe(uiBody.decision_id);
    expect(mcpBody.decision_id, 'mcp decision_id === ui decision_id').toBe(uiBody.decision_id);

    // decision text and rationale must be identical (same DB row).
    expect(atlasBody.decision, 'atlas decision text === ui').toBe(uiBody.decision);
    expect(mcpBody.decision, 'mcp decision text === ui').toBe(uiBody.decision);
    expect(atlasBody.rationale, 'atlas rationale === ui').toBe(uiBody.rationale);
    expect(mcpBody.rationale, 'mcp rationale === ui').toBe(uiBody.rationale);

    // Evidence shape: all arrays with the same length.
    expect(Array.isArray(uiBody.evidence), 'ui evidence is array').toBe(true);
    expect(atlasBody.evidence.length, 'atlas evidence.length === ui').toBe(uiBody.evidence.length);
    expect(mcpBody.evidence.length, 'mcp evidence.length === ui').toBe(uiBody.evidence.length);

    // Calls 2 + 3 must be cache hits.
    expect(atlasBody.cache_hit, 'atlas call (2nd) is cache_hit').toBe(true);
    expect(mcpBody.cache_hit, 'mcp call (3rd) is cache_hit').toBe(true);

    // Track for cleanup.
    insertedDecisionIds.push(uiBody.decision_id);
  });

  // P2 — consumer field integrity: only 1 DB row for the parity question,
  // consumer='ui' (the first caller's value is preserved; cache hits don't
  // overwrite it).
  it('P2 brain_decisions has 1 row for the parity question; consumer=ui', { timeout: 10_000 }, () => {
    if (!probe.brainDecideHealthy) {
      console.warn(`[skip P2] ${probe.reason ?? 'bridge brain endpoints unreachable'}`);
      return;
    }
    if (!suiteRunId) {
      console.warn('[skip P2] suiteRunId not set — P1 likely skipped');
      return;
    }

    const db = openBrainTestDb();
    try {
      const rows = db
        .prepare(
          `SELECT id, consumer FROM brain_decisions
           WHERE question LIKE ? AND user = ?
           LIMIT 10`,
        )
        .all(`[parity ${suiteRunId}]%`, PARITY_USER) as Array<{ id: string; consumer: string | null }>;

      console.log(`[P2] rows found for parity question: ${rows.length}`);

      // Exactly 1 row — cache deduplicated the 3 calls onto a single DB row.
      expect(rows.length, 'exactly 1 row for parity question').toBe(1);
      // The row must carry consumer='ui' (first caller).
      expect(rows[0].consumer, 'row consumer = ui').toBe('ui');
    } finally {
      db.close();
    }
  });

  // P3 — different question → different decision_id (no cross-question collision).
  it('P3 different question same user+day → different decision_id', { timeout: 120_000 }, async () => {
    if (!probe.brainDecideHealthy) {
      console.warn(`[skip P3] ${probe.reason ?? 'bridge brain endpoints unreachable'}`);
      return;
    }

    const questionA = `[parity-diff-A ${suiteRunId}] is it safe to deploy right now?`;
    const questionB = `[parity-diff-B ${suiteRunId}] should I start the refactor or wait for the PR?`;

    type DecisionBody = { decision_id: string; cache_hit: boolean };

    const resA = await request('POST', '/api/brain/decide', {
      body: { question: questionA, user: PARITY_USER },
      headers: { 'X-WI-Consumer': 'ui' },
      timeoutMs: DECIDE_TIMEOUT_MS,
    });
    console.log(`[P3] questionA status=${resA.status} dur=${resA.durationMs}ms`);
    expect(resA.status, 'questionA expect 200').toBe(200);
    const bodyA = parseJson<DecisionBody>(resA.body);

    const resB = await request('POST', '/api/brain/decide', {
      body: { question: questionB, user: PARITY_USER },
      headers: { 'X-WI-Consumer': 'ui' },
      timeoutMs: DECIDE_TIMEOUT_MS,
    });
    console.log(`[P3] questionB status=${resB.status} dur=${resB.durationMs}ms`);
    expect(resB.status, 'questionB expect 200').toBe(200);
    const bodyB = parseJson<DecisionBody>(resB.body);

    expect(bodyA.decision_id, 'different questions → different decision_ids').not.toBe(bodyB.decision_id);

    // Track for cleanup.
    insertedDecisionIds.push(bodyA.decision_id, bodyB.decision_id);
  });
});
