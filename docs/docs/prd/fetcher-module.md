---
sidebar_label: "Fetcher Module PRD"
title: "PRD: Fetcher — the WI Fetch Module"
status: Draft (2026-07-15)
date: 2026-07-15
---

# PRD: Fetcher — the WI Fetch Module

## Problem Statement

> **WI's entire value depends on having *current* data from Teams, Outlook/email, Jira, GitHub, and Calendar. Today it does not. There is no fetcher module — fetch logic is a scatter of ad-hoc connector classes plus a divergent copy inlined into a 9,900-line server file, while the one clean orchestrator that was built for the job (`SyncService`) is dead code that never runs. The consequences are user-visible: email is never fetched in the background, Jira only refreshes when someone pokes the UI, and any live search can freeze the whole bridge for up to 6.5 minutes. The system presents stale or missing data as if it were current.**

This PRD defines the product outcome: **a single Fetcher module that reliably keeps WI's data current, streams progress instead of blocking, and can be reasoned about (and later relocated) as one unit.** The architectural decision behind it is [ADR-044](../adr/adr-044-fetcher-module.md).

---

## Who it's for

- **Maaz (primary user)** — opens the dashboard / runs `/wi` and `wi-sync` and needs the answer grounded in *today's* Teams/email/Jira, not last-time-the-UI-was-open.
- **Cypher (internal consumer)** — ADR-042 Stage-1 needs a fast "fetch context in parallel" primitive; it currently reaches the browser scraper and hangs.
- **The bridge itself** — must stay responsive; a fetch must never block the event loop.

## Goals

1. **Current data, automatically.** Background sync fetches *all* sources — including email and Jira — into the local DB on the normal cadence, with no manual trigger.
2. **Never block the bridge.** No fetch, however slow, makes `/api/status` or any other route hang.
3. **Streaming progress.** Callers see per-source results as they land (email at ~5 s) instead of one blocking response after the slowest source (~90 s+).
4. **One module.** All fetch behind a single `Fetcher` facade; no consumer reaches around it into a connector class or a route-handler `import()`.
5. **Reversible & relocatable.** The module is the seam; promoting it to an out-of-process service later is a lift-behind-the-facade, not a rewrite.

## Non-goals

- Not an out-of-process microservice in this milestone (in-process module; see ADR-044 Open Q 2).
- Not changing the storage schema (`messages` + `UNIQUE(source, source_id)` stays).
- Not adding new data sources — same five (Teams, email, Jira, GitHub, Calendar).
- Not fixing the ADR-042 SCOPE loop itself — this unblocks it by giving it a non-blocking fetch, but the loop restructure is ADR-042's scope.

## User outcomes & acceptance criteria

These are the bar. Each is observable, not a feeling.

| # | Outcome | Acceptance |
|---|---|---|
| O1 | Email shows up without me searching for it | After a background sync, `messages` contains Outlook email fetched in that cycle — no `/api/search-all` needed |
| O2 | Jira is current in the background | After a background sync, Jira issues are persisted to `messages`, not just cache-invalidated |
| O3 | Search returns partial results fast | `GET /api/sync/stream` (SSE) emits email's `result` event before Jira's `done` — I see something at ~5 s, not nothing for 90 s |
| O4 | The app never freezes during a fetch | `/api/status` responds < 500 ms while a live multi-source fetch is running |
| O5 | `/wi` can ground on live context without hanging | Cypher Stage-1's parallel fetch completes or streams; it never pegs the bridge (removes the SCOPE-hang root) |

## Milestones

### M1 — Extract & prune (module boundary)
- Create `src/fetcher/` with the `Fetcher` facade + moved connectors + moved browser-session pool and Jira locks.
- Delete the 4 dead connectors (`jira.ts` REST, `teams-browser.ts`, `outlook-calendar.ts`, REST `github.ts`) and the dead `SyncService`.
- All consumers (`web-server.js` routes, `search-all`, CLIs, Cypher tools) import only `src/fetcher`.
- **Exit:** AC-S1..S4 pass; typecheck + `smoke:bridge` green; behavior unchanged vs today (still Teams+Calendar in background — the gaps are M2).

### M2 — Close the functional gaps (email + Jira background)
- `orchestrator.syncAll` registers and fetches **email** (Outlook) and persists **Jira** to `messages`.
- `OutlookWatcher` unread-delta becomes a trigger into `syncAll('email')`.
- Browser scrapes run under worker-thread / bounded-async isolation (ADR-027 pattern) — non-blocking.
- **Exit:** O1, O2, O4 pass in `smoke:outcome`.

### M3 — Streaming progress surface (SSE)
- `GET /api/sync/stream` + `POST /api/search-all/stream` (SSE), mirroring the code-graph SSE schema.
- Legacy blocking `POST /api/search-all` kept as a deprecated shim, removed one release later.
- **Exit:** O3, O5 pass; the deprecated endpoint still returns correct aggregate during the window.

## Success metrics (post-M3 soak)

- **Data freshness:** email + Jira rows in `messages` have a max age ≤ `SYNC_INTERVAL_MS` (currently 15 min) without any manual sync. Today: email age = ∞ (never), Jira = only-on-UI-hit.
- **Bridge responsiveness:** p99 `/api/status` latency < 500 ms while syncs run. Today: up to 6.5 min stalls on `search-all`.
- **Time-to-first-result:** first SSE `result` event ≤ 10 s on a cold multi-source fetch. Today: 0 (blocking).
- **SCOPE-hang rate:** `/wi` dispatches that halt in SCOPE due to a fetch tool → 0 (root removed). Today: dominant hang cause.

## Rollout & risk

- `FETCHER_MODULE_ENABLED` (default on) gates M1's orchestrator; `=0` reverts to legacy inline sync for one release. Full rollback = revert the extraction commit.
- **Biggest risk:** the M1 refactor is high-touch across `web-server.js`; the smoke suite is the guardrail — no milestone ships without it green. Moving the browser-session singleton + Jira locks is the concurrency-sensitive part; land it behind the flag and soak before removing the legacy path.
- **Expected transient:** during M1 the board/loop may surface fewer results until M2 wires email/Jira — call this out; it is the gap being fixed becoming visible, not a regression.

## Open questions

Tracked in [ADR-044 § Open questions](../adr/adr-044-fetcher-module.md): (1) Calendar in the `UnifiedMessage` contract; (2) when/whether to promote to an out-of-process service; (3) concurrent-SSE-stream cap.

## References

- [ADR-044: Extract Fetch into a Separate In-Process Module](../adr/adr-044-fetcher-module.md) — the architecture decision.
- CLAUDE.md § "Four-Stage Pipeline" (FETCH stage) and § "Bridge MUST never be blocked."
- Fetcher subsystem audit (2026-07-15): the 7-problem catalogue this PRD is built on.
