/**
 * ADR-044 Fetcher module — public types.
 *
 * The FETCH stage's contract, in one place. Re-exports the existing
 * `UnifiedMessage` / `MessageSource` (from the connectors layer, which S3 will
 * move under `src/fetcher/sources/`) and adds the module's own facade types:
 * `FetchSource` and the `FetchProgress` streaming envelope.
 *
 * Design note (ADR-044 § Fetch semantics): every live source produces an
 * INDEPENDENT `FetchProgress` envelope. A source that times out or errors
 * resolves its own `timed_out` / `error` envelope — it NEVER rejects out of the
 * aggregate. This is the "one slow source must not sink the call" contract,
 * proven by scripts/probe-better-searchall.ts.
 */

// Re-export the normalized message contract. S3 moved connectors/types.ts to
// src/fetcher/sources/types.js — this points at the real location, not the shim.
export { MessageSource } from './sources/types.js';
export type { UnifiedMessage } from './sources/types.js';
// Local binding for use in the DataSource interface below (a re-export alone
// does not create a name usable inside this module).
import type { UnifiedMessage as UnifiedMessageT } from './sources/types.js';

/**
 * The sources the fetcher can pull from. `calendar` is included for facade
 * completeness but persists to `calendar_events` (its own path), not the
 * `messages`/UnifiedMessage dedup path — see ADR-044 Open Q on the contract.
 */
/**
 * `local` (ADR-044 S4): the FTS/DB read over already-synced data. Not a live
 * scrape — resolves in ~10ms with no network, no browser slot. `fetchStream`
 * emits its `result` envelope FIRST so the caller always has an immediate
 * grounding answer even when every live source stalls (the AC-U5 lesson from
 * search_all: one slow source must not sink the call — and local is the
 * source that never even risks stalling).
 */
export type FetchSource = 'teams' | 'email' | 'jira' | 'github' | 'slack' | 'linear' | 'calendar' | 'local';

/** Per-source outcome status. */
export type FetchStatus = 'ok' | 'timed_out' | 'error';

/**
 * Streaming progress envelope — one emitted per lifecycle event of a source.
 * Mirrors the code-graph SSE schema (started/progress/result/error/done) so the
 * bridge's SSE surface (a later slice) can forward these verbatim.
 */
export type FetchProgress =
  | { kind: 'started'; source: FetchSource }
  | { kind: 'progress'; source: FetchSource; done: number; total: number }
  | { kind: 'result'; source: FetchSource; status: FetchStatus; count: number; durationMs: number; note?: string }
  | { kind: 'error'; source: FetchSource; message: string }
  | { kind: 'done'; sources: FetchSource[] };

/** Options common to a fetch call. */
export interface FetchOpts {
  /** Only fetch items newer than this. Defaults per-source. */
  since?: Date;
  /** Per-source wall-clock timeout (ms). The isolation guard. */
  timeoutMs?: number;
  /** Free-text query for search-shaped fetches (e.g. email subject filter). */
  query?: string;
}

/** Options for a multi-source sync. */
export interface SyncOpts extends FetchOpts {
  /** Which sources to sync. Defaults to all message sources (not calendar). */
  sources?: FetchSource[];
}

/**
 * The minimal contract a fetch source implements: pull normalized messages
 * since a cutoff. ADR-044 S5 relocated this here from services/sync.ts so the
 * moved connectors (src/fetcher/sources/*) no longer import UP into the
 * services layer — the fetcher module owns its own source contract. The live
 * SyncService (src/services/sync.ts, used by the MCP stdio server) re-exports
 * this type for backward compatibility.
 */
export interface DataSource {
  fetchMessages(config: Record<string, unknown>, since?: Date): Promise<UnifiedMessageT[]>;
}
