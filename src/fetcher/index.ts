/**
 * ADR-044 Fetcher module — public facade.
 *
 * THE single entry point for the FETCH stage. Consumers import `createFetcher`
 * and call `fetch` / `fetchStream` / `syncAll` — they never `new` a connector
 * directly (that scatter is what ADR-044 exists to end). The facade delegates
 * to the orchestrator (`orchestrator.ts`, slice S2), which runs sources in
 * parallel with per-source isolation + local-first grounding.
 *
 * Slice status: S1 defines the interface + factory; the orchestrator lands in
 * S2; the connector registry (src/services/connector-registry.ts, S2.5/S3)
 * wires wi.config.json connectors into SourceSpecs and backs the facade
 * end-to-end. `createFetcher` now returns a fully wired Fetcher.
 */

import type Database from 'better-sqlite3';
import { wireFetcher } from '../services/connector-registry.js';
import type {
  UnifiedMessage,
  FetchSource,
  FetchProgress,
  FetchOpts,
  SyncOpts,
} from './types.js';

export type {
  UnifiedMessage,
  FetchSource,
  FetchStatus,
  FetchProgress,
  FetchOpts,
  SyncOpts,
} from './types.js';
export { MessageSource } from './types.js';

/**
 * The Fetcher facade. One import surface for all fetch.
 */
export interface Fetcher {
  /**
   * One-shot: fetch a single source, return its normalized messages.
   * Used by search-shaped callers and CLIs. Bounded by opts.timeoutMs.
   */
  fetch(source: FetchSource, opts?: FetchOpts): Promise<UnifiedMessage[]>;

  /**
   * Streaming: fetch across sources, yielding a FetchProgress envelope as each
   * source lands. Local grounding returns first; a slow/failing source yields
   * its own timed_out/error envelope without blocking the rest. THE fix for
   * "one slow source sinks the call".
   */
  fetchStream(sources: FetchSource[], opts?: FetchOpts): AsyncIterable<FetchProgress>;

  /**
   * Background sync across sources: fetch + persist (dedup on source_id).
   * Replaces the inline runFullSync + the dead SyncService. Yields progress.
   */
  syncAll(opts?: SyncOpts): AsyncIterable<FetchProgress>;
}

/**
 * Build a Fetcher bound to a DB handle. The db is needed for persistence
 * (upsertMessage), topic resolution, and the Jira/GitHub MCP clients.
 *
 * Fully wired (S2.5/S3): creation delegates to the connector registry
 * (`wireFetcher`), which reads enabled connectors from wi.config.json and
 * builds their SourceSpecs from the existing source adapters. `fetch`,
 * `fetchStream` and `syncAll` all run through the orchestrator (parallel +
 * per-source cancel-and-release isolation).
 * @returns a Fetcher facade
 */
export function createFetcher(db: Database.Database): Fetcher {
  return wireFetcher(db);
}

// S2 orchestrator primitives — exported for S2.5 wire-up + unit/live tests.
export { fetchStream, fetchOneSource, localFirst } from './orchestrator.js';
export type { SourceSpec, SourceFetcher, SourceReleaser } from './orchestrator.js';

// S2.5/S3 connector registry — enabled-connector discovery + capabilities.
export {
  wireFetcher,
  getEnabledConnectors,
  getConnectorCapabilities,
  getConnectorStatuses,
  getCapabilitiesManifest,
  buildSourceSpecs,
} from '../services/connector-registry.js';
