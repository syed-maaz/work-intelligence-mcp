/**
 * Proactive scan — Phase 71-03 (ADR-024 Pillar 4 / Brain Learning).
 *
 * Cron service that surfaces high-confidence pending brain decisions to the
 * user without an explicit ask. Runs every `intervalMs` (default 30 minutes)
 * via setInterval and pushes eligible rows into the existing
 * `proactive_queue` SSE channel — the same one ChatPanel already drains.
 *
 * Scan rules (locked by 71-03 PLAN must_haves):
 *   1. Window:    brain_decisions WHERE outcome='pending'
 *                 AND confidence >= CONFIDENCE_THRESHOLD (0.85)
 *                 AND created_at >  (now_ms - 7d)
 *   2. Cluster signature: derive per-row from
 *                  - explicit `signature` field on evidence_json[0], OR
 *                  - evidence_json[0].id, OR
 *                  - fall back to the decision row id (so unsignatured rows
 *                    still cool down per-row instead of pushing every cycle).
 *   3. Cooldown:  per-cluster `last_pushed_at` tracked in an in-memory Map.
 *                 Skip if delivered within COOLDOWN_MS (24h). T-71-02 mitigation.
 *   4. Push:      INSERT INTO proactive_queue (agent='brain', source_id=cluster_signature,
 *                 type='brain_decision', payload=JSON({decision_id, decision, rationale,
 *                 confidence, evidence, next_actions, created_at})). Reuses existing
 *                 SSE channel — no new transport.
 *   5. Update last_pushed_at after successful push.
 *
 * Boundary: pure SQL + JSON. No Anthropic calls, no network. Safe to run
 * unattended forever; bounded I/O per tick (single SELECT + N small INSERTs).
 *
 * Exported:
 *   - `startProactiveScan(db, opts?)` — registers the interval, returns the
 *     timer handle so the bridge can clearInterval on SIGTERM.
 *   - `runProactiveScanOnce(db, state)` — single-tick driver, exported for
 *     tests so cooldown/threshold can be asserted without waiting 30 minutes.
 *   - `CONFIDENCE_THRESHOLD`, `COOLDOWN_MS`, `DEFAULT_INTERVAL_MS` — locked
 *     constants surfaced for tests + observability.
 */

import type Database from 'better-sqlite3';

// ---------- Locked constants ------------------------------------------------

export const CONFIDENCE_THRESHOLD = 0.85;
export const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
export const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// ---------- Public types ----------------------------------------------------

export interface ProactiveScanState {
  /** cluster_signature → epoch-ms last push timestamp */
  lastPushedAt: Map<string, number>;
  /** Counters surfaced for observability + tests */
  ticks: number;
  pushed: number;
  skippedCooldown: number;
  scanned: number;
}

export interface StartOptions {
  /** Override the 30m default. Tests pass small numbers; production omits. */
  intervalMs?: number;
  /** Override `Date.now()` source for deterministic tests. */
  now?: () => number;
  /** Optional logger; defaults to process.stderr.write. */
  log?: (msg: string) => void;
}

export interface ProactiveScanHandle {
  /** Underlying setInterval timer. Bridge clears this on SIGTERM. */
  timer: ReturnType<typeof setInterval>;
  /** State Map — exposed so tests can inspect cooldown after a tick. */
  state: ProactiveScanState;
  /** Stop the cron + clear timer. Idempotent. */
  stop: () => void;
}

interface BrainDecisionRow {
  id: string;
  decision: string;
  rationale: string | null;
  confidence: number | null;
  evidence_json: string | null;
  next_actions_json: string | null;
  created_at: number;
}

// ---------- Cluster signature -----------------------------------------------

/**
 * Derive a cluster signature from a brain_decisions row. Cooldown is per
 * signature, so all rows that share a signature share the 24h gate.
 *
 * Resolution order (locked by PLAN line 50):
 *   1. evidence_json[0].signature — explicit cluster anchor.
 *   2. evidence_json[0].id        — fall back to first piece of evidence.
 *   3. row.id                     — fall back to the decision id itself, so
 *      decisions without evidence still respect a per-row cooldown rather
 *      than re-pushing every tick.
 */
export function deriveClusterSignature(row: BrainDecisionRow): string {
  const raw = row.evidence_json;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0];
        if (first && typeof first === 'object') {
          const sig = (first as { signature?: unknown }).signature;
          if (typeof sig === 'string' && sig.length > 0) return sig;
          const id = (first as { id?: unknown }).id;
          if (typeof id === 'string' && id.length > 0) return id;
          if (typeof id === 'number') return String(id);
        }
        if (typeof first === 'string' && first.length > 0) return first;
      }
    } catch {
      // Malformed evidence_json → fall through to row id.
    }
  }
  return row.id;
}

// ---------- Single-tick driver ---------------------------------------------

/**
 * Run one scan pass synchronously. Exported for tests.
 *
 * Returns the count of rows pushed so callers can log or assert.
 */
export function runProactiveScanOnce(
  db: Database.Database,
  state: ProactiveScanState,
  opts: { now?: () => number } = {},
): number {
  const now = (opts.now ?? Date.now)();
  state.ticks += 1;

  const cutoff = now - LOOKBACK_MS;

  // Single-column SELECT; threshold + window enforced in SQL so the bridge
  // never holds large result sets in memory.
  const rows = db
    .prepare<[number, number], BrainDecisionRow>(
      `SELECT id, decision, rationale, confidence, evidence_json,
              next_actions_json, created_at
         FROM brain_decisions
        WHERE outcome = 'pending'
          AND confidence >= ?
          AND created_at > ?
        ORDER BY created_at DESC`,
    )
    .all(CONFIDENCE_THRESHOLD, cutoff);

  state.scanned += rows.length;

  const insert = db.prepare(
    `INSERT INTO proactive_queue (agent, source_id, type, payload)
     VALUES (?, ?, ?, ?)`,
  );

  let pushed = 0;
  for (const row of rows) {
    const signature = deriveClusterSignature(row);
    const last = state.lastPushedAt.get(signature);
    if (last !== undefined && now - last < COOLDOWN_MS) {
      state.skippedCooldown += 1;
      continue;
    }

    let evidence: unknown[] = [];
    try {
      evidence = row.evidence_json ? JSON.parse(row.evidence_json) : [];
      if (!Array.isArray(evidence)) evidence = [];
    } catch {
      evidence = [];
    }
    let nextActions: unknown[] = [];
    try {
      nextActions = row.next_actions_json ? JSON.parse(row.next_actions_json) : [];
      if (!Array.isArray(nextActions)) nextActions = [];
    } catch {
      nextActions = [];
    }

    const payload = JSON.stringify({
      decision_id: row.id,
      decision: row.decision,
      rationale: row.rationale,
      confidence: row.confidence,
      evidence,
      next_actions: nextActions,
      cluster_signature: signature,
      created_at: row.created_at,
    });

    insert.run('brain', signature, 'brain_decision', payload);
    state.lastPushedAt.set(signature, now);
    pushed += 1;
    state.pushed += 1;
  }

  return pushed;
}

// ---------- Public entry point ---------------------------------------------

/**
 * Register the proactive scan interval. Returns a handle whose `stop()`
 * method must be called on bridge shutdown so the timer does not keep the
 * Node event loop alive.
 *
 * The first scan runs `intervalMs` after registration, NOT immediately —
 * matches existing scheduleNextSync() semantics in web-server.js so the
 * bridge has time to finish startup before any external work fires.
 */
export function startProactiveScan(
  db: Database.Database,
  opts: StartOptions = {},
): ProactiveScanHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((msg: string) => process.stderr.write(msg));

  const state: ProactiveScanState = {
    lastPushedAt: new Map<string, number>(),
    ticks: 0,
    pushed: 0,
    skippedCooldown: 0,
    scanned: 0,
  };

  const timer = setInterval(() => {
    try {
      const pushed = runProactiveScanOnce(db, state, { now });
      if (pushed > 0) {
        log(`[brain] proactive scan pushed ${pushed} decision(s)\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[brain] proactive scan error: ${msg}\n`);
    }
  }, intervalMs);

  const stop = (): void => {
    clearInterval(timer);
  };

  return { timer, state, stop };
}
