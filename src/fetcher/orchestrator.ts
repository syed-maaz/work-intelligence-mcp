/**
 * ADR-044 Fetcher orchestrator (slice S2).
 *
 * The actual fix for "one slow source sinks the call": local-first grounding,
 * then live sources fetched in PARALLEL, each with its own timeout that yields
 * an isolated FetchProgress envelope (ok|timed_out|error) — never rejects out
 * of the aggregate.
 *
 * CRITICAL (ADR-044 § Cancellation & cleanup, re-audit #8): a timeout MUST
 * cancel the in-flight work and release its resource (browser pool slot / Jira
 * lock), not merely abandon it. A Promise.race that only resolves the outer
 * promise leaks the slot and, over repeated 15-min sync cycles, kills the pool
 * while the bridge stays responsive. So every source fetch is driven through an
 * AbortController: on timeout we abort() AND await a bounded cleanup before
 * emitting the envelope.
 *
 * S2 keeps the orchestrator connector-agnostic: source fetchers are INJECTED as
 * `SourceFetcher` functions `(signal) => Promise<UnifiedMessage[]>`. The real
 * connector wiring (OutlookBrowserConnector etc. with AbortSignal threaded in)
 * lands in S2.5/S3 — this file is unit-testable today with stub fetchers, and
 * the live slot-leak test (AC-U6) exercises a real getPage-holding fetcher.
 */

import type Database from 'better-sqlite3';
import { searchMessages } from '../db/queries/messages.js';
import { upsertMessage } from '../db/queries/messages.js';
import { createTopic, getTopicByName } from '../db/queries/topics.js';
import type { UnifiedMessage, FetchSource, FetchProgress, FetchStatus } from './types.js';

/** A source fetch, abortable. Receives an AbortSignal it MUST honor for cancel. */
export type SourceFetcher = (signal: AbortSignal) => Promise<UnifiedMessage[]>;

/** Optional cleanup run after abort() to release the source's resource. */
export type SourceReleaser = () => Promise<void> | void;

export interface SourceSpec {
  source: FetchSource;
  fetch: SourceFetcher;
  /** Bounded cleanup after abort — release pool slot / lock. Best-effort. */
  release?: SourceReleaser;
  /** Per-source timeout (ms). */
  timeoutMs: number;
}

const DEFAULT_TOPIC = '_fetcher_sync';

/** Resolve (create-if-missing) the fetcher's persistence topic. Never hardcode 0. */
function resolveTopicId(db: Database.Database): number {
  const existing = getTopicByName(db, DEFAULT_TOPIC);
  if (existing) return existing.id;
  return createTopic(db, { name: DEFAULT_TOPIC }).id;
}

/** Map a UnifiedMessage to the messages-table row (mirrors search-all storeMessage). */
function persist(db: Database.Database, topicId: number, msg: UnifiedMessage): void {
  upsertMessage(db, {
    topic_id: topicId,
    source: msg.source,
    source_id: msg.id,
    subject: msg.subject || null,
    content: msg.content ?? '',
    author: msg.sender?.name || msg.sender?.email || msg.sender?.id || 'unknown',
    timestamp: (msg.createdAt instanceof Date ? msg.createdAt : new Date(msg.createdAt)).toISOString(),
    metadata: msg.metadata ? JSON.stringify(msg.metadata) : null,
    raw_data: msg.raw ? JSON.stringify(msg.raw) : null,
  });
}

/**
 * Fetch one source with cancel-and-release timeout isolation.
 * Resolves a `result` FetchProgress envelope — NEVER rejects. On timeout it
 * calls abort() then awaits `release()` (bounded) before resolving `timed_out`,
 * so the pool slot / lock is freed rather than leaked.
 * @returns the source's result envelope + the fetched messages (empty on fail)
 */
export async function fetchOneSource(
  spec: SourceSpec,
): Promise<{ envelope: Extract<FetchProgress, { kind: 'result' }>; messages: UnifiedMessage[] }> {
  const start = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupDone: Promise<void> | undefined;

  const runCleanup = async (): Promise<void> => {
    try {
      controller.abort();
    } catch { /* abort never throws, defensive */ }
    if (spec.release) {
      try {
        // Bounded cleanup: don't let a wedged release hang the orchestrator.
        await Promise.race([
          Promise.resolve(spec.release()),
          new Promise<void>((r) => setTimeout(r, 5_000)),
        ]);
      } catch { /* release is best-effort */ }
    }
  };

  const timeout = new Promise<{ status: FetchStatus; messages: UnifiedMessage[]; note?: string }>(
    (resolve) => {
      timer = setTimeout(() => {
        // Resolve timed_out FIRST so this branch deterministically wins the
        // race — THEN abort + release. If we awaited cleanup before resolving,
        // the abort-induced rejection of `real` could win with status='error'.
        resolve({ status: 'timed_out', messages: [], note: `>${spec.timeoutMs}ms` });
        cleanupDone = runCleanup();
      }, spec.timeoutMs);
    },
  );

  const real = spec
    .fetch(controller.signal)
    .then((messages) => ({ status: 'ok' as FetchStatus, messages, note: undefined as string | undefined }))
    .catch((e: unknown) => ({
      status: 'error' as FetchStatus,
      messages: [] as UnifiedMessage[],
      note: (e instanceof Error ? e.message : String(e)).split('\n')[0] as string | undefined,
    }));

  const outcome = await Promise.race([real, timeout]);
  if (timer) clearTimeout(timer);
  // On the timeout path, ensure the abort+release cleanup has settled before
  // returning so callers/tests can rely on the slot being freed.
  if (cleanupDone) await cleanupDone;

  return {
    envelope: {
      kind: 'result',
      source: spec.source,
      status: outcome.status,
      count: outcome.messages.length,
      durationMs: Date.now() - start,
      ...(outcome.note ? { note: outcome.note } : {}),
    },
    messages: outcome.messages,
  };
}

/**
 * Local-first read: the FTS query over already-synced data. Returns instantly,
 * never blocked by any live fetch. This is the grounding answer.
 * @returns the count of local matches (rows are already in the DB)
 */
export function localFirst(db: Database.Database, query: string | undefined, limit = 10): number {
  if (!query) return 0;
  return searchMessages(db, { search_text: query, limit }).length;
}

/**
 * ADR-044 S4 — build a synthetic `local` SourceSpec that runs the FTS query
 * synchronously (no network, no browser slot). The caller passes this into
 * `fetchStream` alongside the live specs; the orchestrator recognises the
 * 'local' source and emits its `result` envelope FIRST — before any live
 * source is even spawned — so a stalled scrape can never delay grounding.
 *
 * The `fetch` closure is invoked at emit time (~microtask cost against an
 * in-memory prepared statement); it does NOT hit a network and does NOT
 * take a browser pool slot, so it needs no `release()` and its `timeoutMs`
 * is only a defensive backstop (default 5s).
 *
 * The returned spec carries `__localQuery` metadata so fetchStream can read
 * the hit count via `localFirst(db, query, limit)` and skip persistence —
 * local rows are ALREADY in `messages` (that's the whole point).
 */
export interface LocalSourceSpec extends SourceSpec {
  __localQuery: string | undefined;
  __localLimit: number;
}
export function localSpec(
  _db: Database.Database,
  query: string | undefined,
  limit = 50,
  timeoutMs = 5_000,
): LocalSourceSpec {
  return {
    source: 'local',
    timeoutMs,
    // fetch is a placeholder — fetchStream special-cases 'local' and never
    // invokes this closure. Present only so LocalSourceSpec satisfies
    // SourceSpec structurally.
    fetch: async () => [],
    __localQuery: query,
    __localLimit: limit,
  };
}

/**
 * Stream a multi-source fetch. Yields `started` per source, `result` as each
 * lands (in completion order), then `done`. Persists ok messages (dedup). One
 * slow/failing source yields its own envelope; it never blocks or fails the
 * others — Promise.allSettled + per-source cancel-and-release.
 *
 * ADR-044 S4 — 'local' source is emitted FIRST, synchronously, before any live
 * source starts. It runs the FTS query against `messages` (already-synced data)
 * and reports its hit count on the emitted envelope. No persistence (rows are
 * already in the DB); no browser slot; no network.
 */
export async function* fetchStream(
  db: Database.Database,
  specs: SourceSpec[],
): AsyncGenerator<FetchProgress> {
  const topicId = resolveTopicId(db);
  for (const s of specs) yield { kind: 'started', source: s.source };

  // Local-first grounding — emit synchronously ahead of any live scrape.
  const localIdx = specs.findIndex((s) => s.source === 'local');
  const liveSpecs: SourceSpec[] = [];
  for (let i = 0; i < specs.length; i++) {
    if (i === localIdx) continue;
    liveSpecs.push(specs[i]);
  }
  if (localIdx >= 0) {
    const ls = specs[localIdx] as Partial<LocalSourceSpec> & SourceSpec;
    const start = Date.now();
    let count = 0;
    let status: FetchStatus = 'ok';
    let note: string | undefined;
    try {
      // If it's a real LocalSourceSpec, use its embedded query + limit.
      // If someone shoved a plain SourceSpec with source:'local' in, degrade
      // gracefully — 0 hits rather than throwing.
      if ('__localQuery' in ls && ls.__localQuery !== undefined) {
        count = localFirst(db, ls.__localQuery, ls.__localLimit ?? 50);
      }
    } catch (e) {
      status = 'error';
      note = (e instanceof Error ? e.message : String(e)).split('\n')[0];
    }
    yield {
      kind: 'result',
      source: 'local',
      status,
      count,
      durationMs: Date.now() - start,
      ...(note ? { note } : {}),
    };
  }

  // Kick live sources in parallel; yield each envelope as it settles, in
  // completion order (fast sources first) with no barrier. Each promise
  // resolves to its envelope after persisting ok rows.
  const inflight = new Map<number, Promise<{ i: number; env: Extract<FetchProgress, { kind: 'result' }> }>>();
  liveSpecs.forEach((s, i) => {
    inflight.set(
      i,
      fetchOneSource(s).then((r) => {
        if (r.envelope.status === 'ok') {
          for (const m of r.messages) {
            try { persist(db, topicId, m); } catch { /* per-row best-effort */ }
          }
        }
        return { i, env: r.envelope };
      }),
    );
  });

  while (inflight.size > 0) {
    const { i, env } = await Promise.race(inflight.values());
    inflight.delete(i);
    yield env;
  }
  yield { kind: 'done', sources: specs.map((s) => s.source) };
}
