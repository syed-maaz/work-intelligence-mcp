---
sidebar_label: "ADR-044: Fetcher Module"
sidebar_position: 44
title: "ADR-044: Extract Fetch into a Separate In-Process Module"
status: Substrate Accepted, partial (2026-07-24) — S1 facade + S2 orchestrator + S2.5 email + S2.7 Jira + S3 /api/sync/stream + S4 /api/search-all/stream + S5 search-all migration landed; outcome ACs (AC-U1–U6) + full facade wiring (S6+) pending
date: 2026-07-15
---

# ADR-044: Extract Fetch into a Separate In-Process Module

**Status:** 🚧 **Substrate Accepted, partial (2026-07-24).** Core module (`src/fetcher/`), orchestrator with cancel-and-release isolation, background email fetch (S2.5), Jira persist (S2.7), fetch telemetry, `GET /api/sync/stream`, and — as of 2026-07-24 — `POST /api/search-all/stream` (S4) plus the local-first `search_all` migration (S5) are landed. Outcome ACs (AC-U1–U6) and full consumer migration (AC-S1 grep-clean, `runFullSync` delegation) remain open. `FETCHER_MODULE_ENABLED` env flag **not implemented** — slices ship unconditionally behind orchestrator imports.

> **Quick ref**
> - **Module:** `src/fetcher/` — `orchestrator.ts` (live, now includes `local` source), `index.ts` facade (partial — `createFetcher()` throws until S6)
> - **Endpoints live:** `GET /api/sync/stream`, `GET /api/sync/telemetry`, `POST /api/search-all/stream` (SSE, since 2026-07-24)
> - **Endpoints pending:** none in the S1–S5 slice; S6+ facade wiring still open
> - **Probe:** `scripts/probe-better-searchall.ts` (parallel isolation proof)
> - **Unblocks:** [ADR-042](./adr-042-prompt-generation-stage.md) EXECUTE latency (`wi_search_all` blocking scrapes)
> - **Smoke:** `npm run smoke:fetcher` — scripts/smoke-fetcher.sh (parallel isolation + AC-U6 slot-leak; LIVE where the environment exposes a browser pool, honest-posture skip otherwise)

**Related:**
- [ADR-042](./adr-042-prompt-generation-stage.md) — 3-stage Cypher; the fetch module is the substrate Stage-1's "parallel mechanical fetch" leans on.
- CLAUDE.md § "Four-Stage Pipeline" — FETCH → PROCESS → ANALYZE → PROPOSE; this ADR hardens the FETCH stage into a real module.
- CLAUDE.md § "Bridge MUST never be blocked" — the architectural rule this ADR stops the fetcher from violating.

---

## Problem Statement

> **The project depends on "fetch" — pulling raw data from Teams, Outlook/email, Jira, GitHub, and Calendar — but fetch logic was scattered:** ad-hoc connector classes under `src/fetcher/sources/` (partially migrated from legacy `src/connectors/`), consumers that `new` connectors directly, plus a divergent copy of orchestration logic inlined into `web-server.js`. The designed orchestrator (`SyncService` in `src/services/sync.ts`) runs only in the MCP server (`src/server.ts`), not the live bridge. As a result the fetch layer was simultaneously (a) architecturally un-separable, (b) functionally incomplete, and (c) an active violation of the "bridge must never block" rule.

**Original state (2026-07-15 audit).** Partial fixes landed 2026-07-16–22 (see [§ Implementation status](#implementation-status--2026-07-22)). Remaining gaps below still apply where noted.

Concretely, seven problems (verified 2026-07-15; status updated 2026-07-22):

1. **No module boundary / no entry point.** ~~`src/connectors/index.ts`~~ → `src/fetcher/index.ts` exists but `createFetcher()` facade methods throw `NOT_WIRED` until S6. Bridge still imports orchestrator + sources directly (`fetchOneSource`, `OutlookBrowserConnector`). **Partial fix.**

2. **The designed orchestrator is dead.** `SyncService` (`src/services/sync.ts`) still instantiated only in `src/server.ts` — not the live bridge. **Open.**

3. **The live orchestrator is inlined and divergent.** `runFullSync()` in `web-server.js` still exists but now calls `runEmailSync()` / Jira sync via `fetcher/orchestrator.ts`. Teams + Calendar unchanged. **Partial fix.**

4. **Background sync never fetches email.** ~~`OutlookBrowserConnector` unregistered~~ → **`runEmailSync()` landed (S2.5)** via orchestrator with cancel-and-release. **Fixed in code; AC-U1 outcome smoke pending.**

5. **Background sync never persists Jira.** ~~cache-invalidate only~~ → **`runJiraSync()` landed (S2.7)** persists to `messages`. **Fixed in code; AC-U2 outcome smoke pending.**

6. **Blocking live scrapes on the request path.** `POST /api/search-all` still `await searchAll(...)` inline — sequential, up to ~6.5 min. **`POST /api/search-all/stream` not shipped.** **Open — primary remaining UX pain.**

7. **Fetch mixed into Propose + duplicated per source.** Jira/Teams/Outlook still instantiated in some route handlers; dead legacy connectors may remain under `src/fetcher/sources/`. **Partial — prune pending (AC-S2).**

**User-facing symptom:** the user runs `/wi <goal>`, `wi-sync`, or opens the dashboard expecting current data; instead email is stale-to-absent, Jira only refreshes when the UI is poked, and any dispatch that touches live search can hang the whole bridge for minutes. The system quietly gives the user *less* current data than it claims to.

**Measured proof (2026-07-16, live DB — ground-truth `MAX(timestamp)` per source in `messages`):**

| Source | Rows | Newest message | Staleness | Root cause |
|---|---|---|---|---|
| **jira** | 335 (191 real + 144 epoch-0) | 2026-05-30 (+ `1970-01-01` epoch-0 rows) | **47 days** | Background loop only cache-invalidates (problem 5); epoch-0 dates are scars from the field-shape bug (`issue.fields.created` undefined → `new Date(undefined)`, fixed 2026-07-15 commit `2094813` — but the loop still never calls the fetch). |
| **email** | 644 | recent (rows land 07-15/07-16) | **freshness was accidental pre-S2.5** | Before S2.5, email appeared only via manual `/search-all`. **`runEmailSync()` now runs in background loop** — verify AC-U1 to confirm systemic freshness. |
| **teams** | 979 | 2026-07-14 | ~2 days | Loop *does* fetch teams, but observed stuck on `currentTopic: "Teams chats"` for 40s+ with 0 messages landing (2026-07-15 live obs) — the Teams-scrape queue-block. |

> **Framing note (audit-corrected 2026-07-16):** the load-bearing claim is *structural* — **email + Jira never fetch in the background** (`OutlookBrowserConnector` unregistered; Jira cache-invalidate-only) — not any single day's staleness number. Email's current freshness is an artifact of incidental `/search-all` scrapes, which masks the dead loop rather than fixing it. State the diagnosis (dead background fetch), not a staleness figure that drifts.

Critically, `GET /api/sync/status` reported `"running": true` throughout — **the sync loop looks healthy while delivering stale data across every source.** This is the substrate-done-≠-outcome-done pattern (`.claude/rules/outcome-honesty.md`) at the sync layer, compounded by telemetry blindness: a never-fetched email source and a hung Teams scrape produce **zero `/bugs` entries** (the same caught/degraded-exception hole closed for Jira in commit `5a6fb18`).

---

## Context

The FETCH stage is the first of WI's four architectural stages (`FETCH → PROCESS → ANALYZE → PROPOSE`). It is supposed to be the one place that talks to the outside world and hand PROCESS a normalized `UnifiedMessage[]`. The contract lives in `src/fetcher/types.ts` (`UnifiedMessage`; legacy copy may remain in `src/connectors/types.ts`). `SyncService` in `src/services/sync.ts` defines `DataSource.fetchMessages` but is not wired to the live bridge.

This ADR does **not** propose a network microservice. The decision (below) is a **separate in-process module** — a `src/fetcher/` package with one public interface, still running inside the bridge. This fixes the coupling, the dead code, and the two functional gaps without paying for a network hop, process supervision, or a second deploy target. The heavy-scrape-blocks-the-event-loop concern (problem 6) is addressed by isolation *within* the process (worker threads / bounded async), the same mechanism ADR-027 used for the code-graph indexer — **not** by moving to another process. A future promotion to an out-of-process service is left as an explicit, deferred option (see Open Questions), so this ADR is the reversible first step.

## Decision

**Extract the FETCH stage into a single in-process module, `src/fetcher/`, with one public interface, one live orchestrator, and a streaming progress surface. Retire the divergent inline logic and the dead `SyncService`.**

### The module boundary

```
src/fetcher/
  index.ts            # Public facade — createFetcher() (S6: wire all methods)
  types.ts            # UnifiedMessage + FetchSource + FetchProgress
  orchestrator.ts     # Live orchestrator — fetchOneSource, fetchStream (S2 ✅)
  sources/
    teams-chats.ts    # TeamsChatScraper (live)
    teams-meetings.ts # TeamsMeetingsScraper (live)
    outlook-browser.ts# OutlookBrowserConnector (live, S2.5)
    jira-adapter.ts   # MCP→browser auto (live, S2.7)
    github-mcp-client.ts
    mac-calendar.ts
    browser-session.ts# Shared Playwright pool + per-source locks
```

**Interim wiring pattern (until S6):** `web-server.js` imports `fetchOneSource` from `orchestrator.ts` and source classes from `sources/` directly — not through `createFetcher()`. The facade exists as the target contract; consumers migrate in S6.

Public facade (illustrative — the contract, not final signatures):

```ts
export interface Fetcher {
  // One-shot: fetch a source, return normalized messages (used by search-all, CLIs).
  fetch(source: FetchSource, opts: FetchOpts): Promise<UnifiedMessage[]>;
  // Streaming: fetch across sources, yielding progress as each lands. THE fix for
  // the 6.5-min blocking wait — email arrives, then Jira, incrementally.
  fetchStream(sources: FetchSource[], opts: FetchOpts): AsyncIterable<FetchProgress>;
  // The background sync loop (replaces runFullSync + the dead SyncService).
  syncAll(opts: SyncOpts): AsyncIterable<FetchProgress>;
}
export type FetchSource = 'teams' | 'email' | 'jira' | 'github' | 'calendar';
export type FetchProgress =
  | { kind: 'started'; source: FetchSource }
  | { kind: 'progress'; source: FetchSource; done: number; total: number }
  | { kind: 'result'; source: FetchSource; count: number; durationMs: number }
  | { kind: 'error'; source: FetchSource; message: string }
  | { kind: 'done'; sources: FetchSource[] };
```

The internal streaming interface is an **async iterator** (`AsyncIterable<FetchProgress>`) — not HTTP. The bridge's *HTTP surface* over it is SSE. That distinction is the transport decision below.

### Fetch semantics — parallel, per-source isolated, local-first (the `search_all` lesson)

The single most important behavioral decision, and the one that fixes the worst live bug. Today's `search_all` (`src/tools/search-all.ts`) is the anti-pattern this module must NOT reproduce:

- It fetches **sequentially** — `await` Outlook (90 s budget), then `await` Jira (300 s budget) — then runs the local FTS search **last**, then an AI summary.
- Its caller (`runSkillSubagent`, `skill-dispatch.ts:121`) aborts the whole request at **60 s**.
- Net effect: a slow Outlook scrape (the common case — cold browser, auth wall) **burns the 60 s budget before Jira or the local search ever run**, so the entire call returns nothing — even though the local FTS search needed no fetch at all and would have answered in ~10 ms. Verified across 10 real `/wi` dispatches (2026-07-15): every one hit ~60 000 ms on `wi_search_all`, recorded `completed`, returned empty. **One slow source sank the whole call.**

The fetcher module inverts this. **Fetch semantics are:**

1. **Local first, always.** The FTS/DB read over already-synced data runs synchronously and returns immediately — it is never gated behind any live fetch. This alone answers most grounding queries in ~10 ms.
2. **Live sources fetched in PARALLEL**, not sequentially. The browser pool already supports 2 concurrent slots (`browser-session.ts` `maxSlots=2`) and Jira is MCP-first (an API call, not a scrape), so parallelism is safe today — the current sequential code is a historical accident, not a constraint.
3. **Each source has its OWN timeout budget** and produces an **independent result envelope** — `{ source, status: 'ok' | 'timed_out' | 'error', count, durationMs, note? }`. A source that times out or throws resolves its own envelope; it **never rejects out of the aggregate**. `Promise.allSettled`, not a shared `await` chain.
4. **Streaming (`fetchStream`)** emits each source's envelope as it lands, so a caller has local+jira+teams within ~1 s while a stuck Outlook is a late footnote (or a `timed_out` envelope), never a blocker.

This resolves the design question raised during the investigation — *"if one fetch fails, do all calls fail?"* Under the current `search_all`: effectively yes (via sequencing + outer abort). Under the fetcher module: **no, by construction** — isolation is the contract, not an accident of exception handling. Prototype (`scripts/probe-better-searchall.ts`, 2026-07-15) proved it against live data:

```
[+   12ms] local  ok         count=1     ← usable answer, zero fetch
[+  814ms] teams  ok         count=2     ← parallel, isolated
[+ 1213ms] jira   ok         count=7     ← parallel, isolated
[+15012ms] email  timed_out  count=0     ← failed IN ISOLATION; did NOT sink the others
```

Two options were weighed: **(a)** N separate per-endpoint calls, each isolated, reporting per-source status; **(b)** one function structured (parallel + streaming) so a timeout doesn't cascade. The decision is their **intersection** — (a)'s per-source isolation + status envelope, delivered via (b)'s parallel + streaming shape. `fetch(source)` (one-shot, one source) covers the (a) use case; `fetchStream(sources[])` (parallel, streaming, per-source envelopes) covers (b). Both sit on the same isolated per-source primitive.

### Cancellation & cleanup — a timeout MUST cancel the work, not just abandon it (audit #8, 2026-07-16)

**The trap the naive design falls into.** The obvious per-source timeout is `Promise.race([fetchMessages(), timeout])` — exactly what today's `search-all.ts:186` (`withTimeout`) and `web-server.js:1559` (`withSyncTimeout`) do. `Promise.race` resolves the *outer* promise on timeout but **the losing fetch keeps running to completion**. For a browser scrape that is catastrophic:

- `OutlookBrowserConnector.fetchMessages` (`outlook-browser.ts:286`) does `const page = await session.getPage(url)` — which **acquires a pool slot** (`browser-session.ts:94`, `maxSlots=2`) — and frees it only in its `finally { await page.close() }`. On a raced timeout, the orchestrator emits `{status:'timed_out'}` but the scrape is still on an `await` inside; the slot is not freed until that promise settles (minutes later, or never if the context wedges).
- **Amplification:** `scheduleNextSync` re-fires every 15 min (`web-server.js:8874`). Each timed-out-but-still-running Outlook fetch orphans a page holding a slot. Over 4-6 cycles the 2-slot pool is dead; every `getPage` blocks forever on `acquireSlot`. The bridge stays HTTP-responsive but **no source ever syncs** — silently.
- **Jira lock variant:** the `_*FetchChain` promise-chain locks (`web-server.js:411-444`) don't advance until the original `fn` resolves; a raced Jira timeout leaves the next caller queued on a dead chain — re-creating the very 6.5-min wait pathology this ADR set out to kill (problem 6).

**So a raced timeout that only abandons work turns the "one slow source can't sink the call" contract into a lie** — it doesn't sink *this* call, it sinks *all future* calls by leaking the shared resource.

**The contract (binding on S2's orchestrator):**

1. **Every connector's `fetchMessages` accepts an `AbortSignal`:** `fetchMessages(config, since, signal?: AbortSignal)`. The connector wires it into Playwright waits (`page.setDefaultTimeout` already exists; pass the signal to abortable `await`s) so an aborted scrape stops promptly.
2. **On per-source timeout the orchestrator calls `controller.abort()` AND awaits a bounded cleanup** that MUST release the pool slot (call `page.close()` / `releasePage`) and, for Jira, advance/release the lock chain — before emitting the `timed_out` envelope. `Promise.race` alone is insufficient; the timeout branch must trigger cleanup, not just resolve.
3. **Coarser M1-acceptable fallback:** tag each page with its source at `getPage` time; on timeout call `session.releaseBySource(source)` which force-`page.close()`s that source's pages and frees their slots. Requires a small `browser-session.ts` addition (page tagging + a release-by-source method).

**Invariant to hold:** after any source times out, the pool's free-slot count returns to its pre-fetch value within a bounded window, and no Jira lock chain is left un-advanced. A `Promise.race`-only orchestrator does NOT satisfy this and MUST NOT ship.

### Transport — the decision (SSE), with the research behind it

The question the user raised: *"why HTTP — we can go SSE, no?"* Correct, and here's the rigorous answer. Because the module is **in-process**, there is no bridge↔fetcher wire to choose a protocol for — internally it's a function call returning an async iterator. The transport choice is about **how the bridge streams fetch progress to its callers (UI, CLI, Cypher)**. The fetch workload is *slow, multi-source, sequential, and produces incremental partial results* (email lands at ~5 s, Jira at ~90 s+). That shape is exactly what SSE is for.


| Transport | Fit for slow multi-source fetch | Verdict |
|---|---|---|
| **SSE (`text/event-stream`)** | Server pushes `started/progress/result/done` as each source lands; one-way, text, survives proxies with `X-Accel-Buffering: no`; **already the bridge's established pattern** (3 endpoints: `/wi/dispatch/stream`, `/brain/decide/stream`, `/code-graph/index/stream`). Caller sees email results at 5 s without waiting for Jira at 90 s. | ✅ **Chosen** |
| HTTP request/response (`await`) | One blocking response after the *slowest* source (~6.5 min). This is exactly problem 6. No partial results. | ❌ the bug we're fixing |
| HTTP + job-id + poll (`isRefreshing`) | Non-blocking, but caller polls; no incremental stream; extra endpoint + client state machine. Fine for a *single* cache (Saturn uses it) but clunky for multi-source progress. | ➖ fallback only |
| WebSocket | Bidirectional — we don't need client→server mid-fetch messages; adds a framing dep + upgrade handling the bridge doesn't otherwise use. | ❌ over-built |
| MCP stdio streaming | Only relevant if fetcher were an out-of-process MCP child; it's in-process. | ❌ out of scope |

**Decision: the bridge exposes `GET /api/sync/stream` (SSE) ✅ landed** and **`POST /api/search-all/stream` (SSE) ⏳ pending** over the module's `fetchStream`/`syncAll` iterators, mirroring the code-graph SSE schema. The existing blocking `POST /api/search-all` stays for one release as a deprecated shim then is removed.

## Implementation status — 2026-07-24

| Slice | What | Status |
|-------|------|--------|
| **S1** | `src/fetcher/index.ts` + `types.ts` facade/types | ✅ Landed; facade methods throw until S6 |
| **S2** | `orchestrator.ts` — parallel fetch, per-source envelopes, cancel-and-release | ✅ Landed |
| **S2.5** | Background email fetch (`runEmailSync` in `web-server.js`) | ✅ Landed |
| **S2.6** | Fetch telemetry (`fetch_runs` table, `/api/sync/telemetry`, `/bugs` on failure) | ✅ Landed |
| **S2.7** | Background Jira persist (`runJiraSync`) | ✅ Landed |
| **S3** | `GET /api/sync/stream` SSE | ✅ Landed |
| **S4** | `POST /api/search-all/stream` SSE | ✅ Landed (2026-07-24) |
| **S5** | Migrate `search-all.ts` to parallel + local-first | ✅ Landed (2026-07-24) |
| **S6** | Wire `createFetcher()` facade; grep-clean consumers (AC-S1) | ⏳ Open |
| **S7** | Delete dead `SyncService` + dead connectors (AC-S2) | ⏳ Open |
| **S8** | Worker-thread scrape isolation (AC-U4) | ⏳ Open |
| **S9** | `npm run smoke:fetcher` | ✅ Landed (script committed 2026-07-24; live execution pending bridge boot in an environment with a browser pool — see verification snapshot) |

### The functional fixes that come with extraction

- **Email background fetch (problem 4):** `orchestrator.syncAll` registers `email` and actually calls `OutlookBrowserConnector.fetchMessages`. `OutlookWatcher`'s unread-delta callback becomes a *trigger* into `syncAll('email')` instead of a dead-end detector.
- **Jira background persist (problem 5):** `syncAll` fetches Jira into `messages` (dedup on `UNIQUE(source, source_id)`), not just cache-invalidate. The UI caches become a read-through over persisted data.
- **Non-blocking scrapes (problem 6):** browser scrapes run under the same worker-thread / bounded-async isolation ADR-027 gave the code-graph indexer, so a 90 s Outlook scrape never pegs the bridge event loop. The per-source Jira locks move into `fetcher/browser-session.ts`.
- **Dead-code prune (problem 7):** delete `jira.ts` (REST), `teams-browser.ts`, `outlook-calendar.ts`, and REST `github.ts` (migrate `topic-expert` to the MCP client) before the move, so the module surface is only live code.

## Acceptance Criteria

> Per `.claude/rules/outcome-honesty.md`, user-flow ACs come first. **Substrate partial (S1–S2.7, S3) landed 2026-07-22.** Outcome ACs (Phase 1) not yet verified end-to-end.

### Phase 1 — User flows (bar for ✅ Accepted)

| # | AC | Verification |
|---|----|--------------|
| AC-U1 | When the background sync runs (or user hits `wi-sync`), **email** from Outlook lands in the `messages` table without an explicit `/api/search-all` call. | `smoke:outcome` — trigger `syncAll`, assert `SELECT COUNT(*) FROM messages WHERE source='email' AND created_at > <sync_start>` > 0 |
| AC-U2 | When the background sync runs, **Jira** issues are persisted to `messages` (not merely cache-invalidated). | `smoke:outcome` — assert Jira rows appear post-sync with no UI hit |
| AC-U3 | When user calls `GET /api/sync/stream`, they receive incremental SSE `result` events per source — email's `result` arrives before Jira's `done`, not one blocking response. | `smoke:outcome` — consume the SSE stream, assert ≥2 `result` events with email's timestamp < Jira's |
| AC-U4 | While a live fetch/scrape is running, `GET /api/status` stays responsive (< 500 ms). The bridge is not blocked. | `smoke:outcome` — fire a stream fetch, poll `/api/status` concurrently, assert all < 500 ms |
| AC-U5 | When one source times out or errors, the other sources AND the local result still return — one slow/dead source never sinks the call. | `smoke:outcome` — force an Outlook timeout, assert local+jira+teams envelopes still `ok`; the failed source reports `timed_out`/`error`, not a whole-call failure. Prototype: `scripts/probe-better-searchall.ts` |
| AC-U6 | A timed-out source releases its browser pool slot (and any Jira lock) — the pool's free-slot count returns to its pre-fetch value within a bounded window, so repeated sync cycles do not leak the pool. | **LIVE** test (not a stub): fire a fake-slow Outlook fetch, hit its timeout, assert `session` free-slot count == pre-fetch value within N s. A stub-connector unit test does NOT prove this (stubs hold no slot). See § Cancellation & cleanup. |

### Phase 2 — Substrate (bar for 🚧 Substrate Accepted)

| # | AC | Verification |
|---|----|--------------|
| AC-S1 | `src/fetcher/index.ts` exports a `Fetcher` facade with `fetch` / `fetchStream` / `syncAll`; no consumer imports a connector class directly (grep). | **Partial** — facade exists; bridge still imports orchestrator/sources directly. Full grep-clean pending S6. |
| AC-S2 | The dead `SyncService` and dead connectors are deleted; `git grep` finds zero live references. | ⏳ Open |
| AC-S3 | `orchestrator.syncAll` is the single sync path; `runFullSync` delegates or is removed. | **Partial** — `runFullSync` calls S2.5/S2.7 helpers but body remains |
| AC-S4 | `fetchStream` yields the `FetchProgress` union shape. | ✅ unit test in orchestrator |

### Phase 3 — Rollout safety

| # | AC | Verification |
|---|----|--------------|
| AC-R1 | Rollback path documented. **`FETCHER_MODULE_ENABLED` env flag deferred** — slices ship via direct orchestrator imports; no toggle exists yet. | Document rollback = revert commit; flag lands with S6 |
| AC-R2 | The legacy blocking `POST /api/search-all` still returns a correct aggregated result during the deprecation window. | smoke hits both old + new endpoints when stream lands |

## Operations

- **Current state:** email + Jira background fetch active via orchestrator imports in `runFullSync`. No env flag toggle — always on since S2.5/S2.7 landed.
- **Endpoints live:** `GET /api/sync/stream` (SSE), `GET /api/sync/telemetry`
- **Endpoints pending:** `POST /api/search-all/stream` (SSE)
- **Legacy (still blocking):** `POST /api/search-all` — deprecated when stream lands
- **Probe script:** `scripts/probe-better-searchall.ts` — parallel isolation proof for AC-U5
- **Rollback (interim):** revert S2.5/S2.7 commits in `web-server.js` — email/Jira gaps return but no regression vs pre-ADR-044 baseline
- **Env (unchanged):** `SYNC_INTERVAL_MS`, `JIRA_SOURCE`, `BROWSER_*` — same names, now behind fetcher sources
- **Planned (S6):** `FETCHER_MODULE_ENABLED` env flag for full-facade rollback

## Consequences

### Positive
- One import surface for all fetch; PROCESS/ANALYZE/PROPOSE can no longer reach around it.
- Email + Jira actually sync in the background — the product delivers current data it currently only claims to.
- Bridge stops blocking on scrapes; the Cypher SCOPE hang class (problem 6) loses its root.
- ADR-042 Stage-1 "parallel mechanical fetch" gets a real `fetchStream` to call.

### Negative / cost
- Sizeable refactor across `web-server.js` (lines 410-444, 1576, 5455, 6206/6231, 7027, 8874, 9313) — high-touch, needs the smoke suite as the guardrail.
- One-time risk moving the browser-session singleton + Jira locks; concurrency bugs here crash scrapes.
- SSE endpoints add long-lived connections; must cap concurrent streams.

### Neutral
- No new external dependency (SSE + async iterators are stdlib-level; the pattern already ships 3×).
- Schema unchanged (still `messages` + `UNIQUE(source, source_id)`).

## Trade-offs explored

| Alternative | Why rejected (for now) |
|---|---|
| Out-of-process microservice + HTTP/SSE wire | True event-loop isolation, but adds a second process to supervise, a deploy target, auth on the wire, and failure modes (fetcher down ≠ bridge down) — disproportionate before the in-process boundary is even proven. Deferred, not dismissed (Open Q). |
| Leave `SyncService` as the orchestrator, wire it into the bridge | Doesn't fix the scattered in-route fetches or the blocking scrape; and `SyncService` has drifted from live behavior. Reconciling into a fresh `orchestrator.ts` is cleaner than resurrecting drift. |
| HTTP request/response for search | Is the bug (problem 6). |
| Keep connectors as-is, just add a facade | Leaves dead code + duplication + the email/Jira gaps; a facade over a broken loop still doesn't fetch email. |

## Open questions

1. **Calendar in the `UnifiedMessage` contract?** `MacCalendarConnector` returns `MacCalendarEvent[]`, outside `MessageSource`. Include it in the fetcher module with its own typed result, or keep calendar separate? (Leaning: include, with a `FetchSource='calendar'` that yields events, not messages.)
2. **Promote to out-of-process service later?** If in-process worker-thread isolation proves insufficient for the browser scrapes (memory pressure, jetsam), the module's facade is already the seam to lift behind a real service + SSE wire. Revisit after M2 soak.
3. **Concurrent-stream cap** for the SSE endpoints — what's the max, and do we queue or 409?

## Verification snapshot at Substrate Accepted — partial (2026-07-22)

- **Module path:** `src/fetcher/` (16 files)
- **Orchestrator:** `fetchOneSource()` with AbortSignal + `releaseBySource()` cancel-and-release
- **Bridge wiring:** `runEmailSync()`, `runJiraSync()`, `recordFetchTelemetry()` in `web-server.js`
- **SSE:** `GET /api/sync/stream` — per-source progress events
- **Telemetry:** `GET /api/sync/telemetry` + `fetch_runs` table
- **Probe:** `scripts/probe-better-searchall.ts` — local+teams+jira ok while email timed_out in isolation
- **Not yet:** outcome smoke, `search-all/stream`, facade S6 wiring, `smoke:fetcher`

## Verification snapshot at S4/S5 landing (2026-07-24)

- **Branch:** `feat/adr-044-s4-searchall-stream` (pre-merge)
- **Commits:** `c92b3b7` (S4 prep: orchestrator `local` source) + `4ef15af` (S4+S5: `/api/search-all/stream` + `search-all.ts` migration) + `5e922f1` (C5: `smoke:fetcher` script)
- **Orchestrator vitest:** 7/7 green (`tests/fetcher/orchestrator.test.ts`) — includes 2 new S4 cases: local-first ordering and local resolves ok while a co-scheduled source times out
- **`tsc --noEmit`:** exit 0 (verified 2026-07-24 in the worktree at Node v24.7.0)
- **`smoke:fetcher` output:** **NOT executed** — this worktree could not boot a bridge (`AGENT-WORKFLOW.md § Prohibited Repo Commands` bans `npm run web:bridge` from a slot/worktree; no external bridge was reachable at the slot's `BRIDGE_URL`). The script itself was verified for syntax (`bash -n`) and committed.
- **Assertions status:**
  - (a) GET /api/sync/stream ordering — **skipped — bridge not booted from worktree**
  - (b) POST /api/search-all/stream local envelope <500ms — **skipped — bridge not booted from worktree**
  - (c) Outlook-timeout isolation — **skipped — bridge not booted from worktree** (also depends on an `x-wi-inject-timeout` injection hook not yet present in the bridge)
  - (d) AC-U6 browser pool slot-leak — **skipped — not verified.** No Playwright browser pool exposed by the bridge; the script is written to emit exactly `AC-U6 skipped: no browser pool in this environment` and mark the assertion non-zero when run. AC-U6 remains an **open outcome AC** — Phase C did not close it.
- **Overall ADR-044 status:** 🚧 **Substrate Accepted, partial** (S1–S5 landed, S6–S9 non-smoke slices open, all Phase 1 outcome ACs — AC-U1–U6 — still unverified). **Not** ✅ Accepted.

## Verification snapshot at acceptance time

Filled in when status changes to ✅ Accepted (not yet):

- Master HEAD: `<sha>`
- Smoke counts: outcome AC-U1–U6 verified
- Dedicated smoke: `npm run smoke:fetcher`
- Cypher session: `cyp_<id>`
