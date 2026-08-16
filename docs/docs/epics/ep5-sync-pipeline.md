---
title: "EP-5: Sync Pipeline Wiring"
sidebar_label: "EP-5: Sync Pipeline"
---

# EP-5: Sync Pipeline Wiring

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Agent Role** | Integration / Wiring Engineer |
| **Depends On** | [EP-1](./ep1-browser-session), [EP-2](./ep2-teams-scraper), [EP-3](./ep3-outlook-scraper), [EP-4](./ep4-jira-wiring), [EP-7](./ep7-schema-migration) |
| **Blocks** | — |
| **File Scope** | `src/services/sync.ts`, `src/server.ts` |

## Goal

All connectors are built (EP-1 through EP-4) and the DB schema is upgraded (EP-7). This epic wires everything together: start `SyncService` on server boot, register all three connectors, load topics from DB, run sync cycles, write results to DB via `upsertMessage()`, and extract action items after each batch.

This is a **pure wiring epic** — do not modify connector files. Do not modify the tools layer.

## Acceptance Criteria

- [x] `SyncService` started in `server.ts` on boot, before the MCP server begins accepting connections
- [x] All three connectors registered: `TeamsBrowserConnector`, `OutlookBrowserConnector`, `JiraBrowserConnector`
- [x] On startup: all topics loaded from DB → sync triggered for each
- [x] Each sync cycle calls `upsertMessage()` (from EP-7's `queries.ts`) per message — dedup by `(source, source_id)`
- [x] After each batch: `AIAnalyzer.detectActionItems()` called → results inserted into `action_items`
- [x] `updateSyncState()` called after each successful sync cycle
- [x] All sync errors caught and logged to `stderr` — MCP server **never** crashes due to sync errors
- [x] Sync interval configurable via `SYNC_INTERVAL_MS` env var (default: `900000` = 15 min)
- [x] `configure_topic` tool triggers immediate sync for the new topic after creation
- [x] `npm run typecheck` passes

## Dependencies

This epic cannot start until:
- EP-1: `BrowserSessionManager` exists at `src/connectors/browser-session.ts`
- EP-2: `TeamsBrowserConnector` exists at `src/connectors/teams-browser.ts`
- EP-3: `OutlookBrowserConnector` exists at `src/connectors/outlook-browser.ts`
- EP-4: `JiraBrowserConnector.fetchMessages()` exists in `src/connectors/jira-browser.ts`
- EP-7: `upsertMessage()`, `getSyncState()`, `updateSyncState()` exist in `src/db/queries.ts`

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-5-1 | Instantiate + start `SyncService` in `server.ts` on boot | ✅ Done |
| EP-5-2 | Register `TeamsBrowserConnector`, `OutlookBrowserConnector`, `JiraBrowserConnector` | ✅ Done |
| EP-5-3 | Load all topics from DB on startup, trigger sync for each | ✅ Done |
| EP-5-4 | Call `upsertMessage()` for each message in sync batch | ✅ Done |
| EP-5-5 | Post-sync: call `AIAnalyzer.detectActionItems()`, insert results | ✅ Done |
| EP-5-6 | Call `updateSyncState()` after each successful sync | ✅ Done |
| EP-5-7 | Global try/catch around all sync — MCP server never crashes | ✅ Done |
| EP-5-8 | `configure_topic` triggers immediate sync for new topic | ✅ Done |

---

## Agent Prompt

:::tip Start This Epic
EP-1, EP-2, EP-3, EP-4, and EP-7 must ALL be complete before starting this epic.
:::

```
You are implementing EP-5: Sync Pipeline Wiring for the Work Intelligence MCP project.


CONTEXT:
All connectors are ready. The DB schema has been upgraded. Your job is to wire everything
together so the sync pipeline actually runs. This is a pure integration task — do NOT
modify connector files or tool files.

YOUR SCOPE:
- src/services/sync.ts — complete the SyncService implementation
- src/server.ts — start SyncService on boot, trigger sync from configure_topic

FILES TO READ FIRST (in this order):
1. src/services/sync.ts — existing skeleton (understand what's there)
2. src/server.ts — understand server boot sequence and configure_topic handler
3. src/db/queries.ts — upsertMessage(), getSyncState(), updateSyncState()
4. src/connectors/browser-session.ts — BrowserSessionManager
5. src/connectors/teams-browser.ts — TeamsBrowserConnector
6. src/connectors/outlook-browser.ts — OutlookBrowserConnector
7. src/connectors/jira-browser.ts — JiraBrowserConnector.fetchMessages()
8. src/services/analyzer.ts — AIAnalyzer.detectActionItems()

WHAT TO BUILD:

In src/services/sync.ts:
- Complete SyncService.start(): load topics from DB, register connectors, begin sync cycles
- Sync loop: for each topic × connector, call fetchMessages(config, since), upsertMessage() each result
- After batch: call AIAnalyzer.detectActionItems(), insert results
- Call updateSyncState() after success
- Catch ALL errors — log to stderr, never throw to caller
- Interval from SYNC_INTERVAL_MS env var (default 900000)

In src/server.ts:
- After DB init, instantiate and start SyncService
- In configure_topic handler: after topic saved to DB, trigger immediate sync

ACCEPTANCE CRITERIA:
- npm run typecheck passes with zero errors
- Server boots without sync errors crashing it
- configure_topic triggers immediate sync
- Sync errors are logged to stderr, not thrown
- SYNC_INTERVAL_MS env var controls interval
```
