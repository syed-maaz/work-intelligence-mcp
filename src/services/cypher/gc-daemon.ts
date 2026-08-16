/**
 * Cypher v2.5 D6 daemon — periodic GC ticker (2026-06-27).
 *
 * Closes the operational follow-up to D6 substrate (commit 39dbcc4).
 * runGc(db) ships as on-demand-only in slice 1; this daemon makes
 * it self-running so retention is enforced without manual triggers.
 *
 * **Cadence:** default once per 24h, configurable via
 * CYPHER_GC_INTERVAL_MS. First tick after 60s so the bridge boots
 * cleanly. Subsequent ticks every CYPHER_GC_INTERVAL_MS.
 *
 * **Kill switch:** CYPHER_GC_DISABLED=1 skips registration entirely.
 * Useful when investigating a wedged GC run.
 *
 * **Safety:** every tick is wrapped in try/catch — a broken GC run
 * never crashes the bridge. Errors surface in the gc_log row that
 * runGc writes regardless.
 *
 * **Why not the agent runtime (CodeGraphIndexer pattern):** the
 * heavier indexer uses sync_state + due_at rows for persistence
 * across restarts because its work is expensive. GC is cheap
 * (~tens of ms on typical loads). A plain setInterval is fine —
 * if the bridge restarts mid-tick, the next tick runs cleanly and
 * gc_log shows the gap.
 *
 * See:
 *   - docs/docs/adr/adr-038-cypher-v2.5-production-grade.md § D6
 *   - src/services/cypher/gc.ts (the actual sweep logic)
 */

import type Database from 'better-sqlite3';
import { runGc } from './gc.js';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const FIRST_TICK_DELAY_MS = 60 * 1000;            // 60s after boot

export interface GcDaemonHandle {
  stop(): void;
  intervalMs: number;
}

/**
 * Start the GC daemon. Returns a handle so tests / shutdown handlers
 * can stop it cleanly.
 *
 * Caller is expected to check CYPHER_GC_DISABLED upstream and skip
 * the call entirely if the daemon should be off — this function
 * always starts when called. (Keeps the boot decision visible in
 * the bridge log line.)
 */
export function startGcDaemon(
  db: Database.Database,
  opts: { intervalMs?: number; firstTickDelayMs?: number } = {}
): GcDaemonHandle {
  const intervalMs = opts.intervalMs ?? (Number(process.env.CYPHER_GC_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
  const firstDelay = opts.firstTickDelayMs ?? FIRST_TICK_DELAY_MS;

  function safeTick(): void {
    try {
      const result = runGc(db);
      if (result.errors.length > 0) {
        process.stderr.write(
          `[gc-daemon] tick ${result.run_id} completed with ${result.errors.length} error(s): ${result.errors.join('; ')}\n`
        );
      }
      // Success path stays quiet — the gc_log row is the durable
      // audit trail. A daemon that logs every successful tick clutters
      // stderr without adding signal.
    } catch (err) {
      process.stderr.write(
        `[gc-daemon] tick crashed (non-fatal): ${(err as Error).message}\n`
      );
    }
  }

  const firstTimer = setTimeout(safeTick, firstDelay);
  const interval = setInterval(safeTick, intervalMs);

  return {
    intervalMs,
    stop(): void {
      clearTimeout(firstTimer);
      clearInterval(interval);
    },
  };
}
