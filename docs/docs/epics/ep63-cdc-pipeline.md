---
id: ep63-cdc-pipeline
title: EP-63 — CDC Pipeline (Change Data Capture)
---

# EP-63 — CDC Pipeline (Change Data Capture)

| Field | Value |
|-------|-------|
| Sprint | Sprint 17 |
| Status | ✅ Done (2026-05-03) |
| ADR | [ADR-017](../adr/adr-017-always-on-agent-architecture) |
| Schema | v40 (`changes_log` table + CDC triggers) |
| Depends On | EP-62 ✅ |
| Effort | 1 wave |

## Problem

Agents needed to react to data changes (new messages, Jira updates, calendar events) without polling external sources. No internal event backbone existed — each feature polled its own data source independently.

## Solution

SQLite triggers write change events to a `changes_log` table. A `ChangeWatcher` service polls at 100ms and dispatches to registered handlers. An `AlertScorerAgent` uses Haiku to score severity and push high-priority changes to `proactive_queue`.

## Success Criteria

- [x] `changes_log` table with indexes on `created_at` and `id`
- [x] AFTER INSERT triggers on `messages`, `jira_issues`, `calendar_events`
- [x] AFTER UPDATE trigger on `jira_issues`
- [x] Trigger names use `_cdc_` infix (no collision with FTS5 triggers)
- [x] ChangeWatcher polls at 100ms, groups by table, dispatches to handlers
- [x] AlertScorerAgent scores changes via Haiku (threshold 0.7)
- [x] High-severity events written to `proactive_queue` for SSE delivery
- [x] WAL mode ensures poll never blocks writes
- [x] Errors never propagate from agents to server

## Delivery Notes

**Completed**: Sprint 17 (2026-05-03)

### Key Implementations

| File | What was delivered |
|------|-------------------|
| `src/db/schema.ts` | Schema v40 — `changes_log` table (`id`, `table_name`, `row_id`, `operation`, `created_at`). Indexes on `created_at` and `id`. Four `_cdc_` triggers on messages (INSERT), jira_issues (INSERT + UPDATE), calendar_events (INSERT). |
| `web-server.js` | ChangeWatcher service — 100ms `setInterval` polling `changes_log` for `id > lastSeenId`. Groups changes by `table_name`, dispatches batches to registered handler callbacks. Runs in boot block. |
| `web-server.js` | AlertScorerAgent — subscribes to ChangeWatcher for `messages` and `jira_issues`. Calls Claude Haiku to score severity (0-1). Events above 0.7 threshold written to `proactive_queue`. Fire-and-forget. |

### Design Decisions

1. **100ms SQLite poll (not native CDC)** — no native module dependency, WAL handles concurrent reads
2. **`_cdc_` trigger infix** — avoids collision with existing FTS5 `_ai_` and `_au_` triggers
3. **Batch dispatch by table** — handlers receive grouped changes, reducing per-row overhead
4. **Haiku for scoring** — fast and cheap enough for 100ms cadence bursts
