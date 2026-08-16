---
title: "EP-0: Foundation"
sidebar_label: "EP-0: Foundation ✅"
---

# EP-0: Foundation

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | — |
| **Agent Role** | N/A — locked, do not modify |

> This epic represents all work that is already complete and working. These files are the stable base all other epics build on. **Do not modify any EP-0 files unless a specific ticket in another epic explicitly says to.**

## What's Working

| Component | File | Notes |
|-----------|------|-------|
| MCP server | `src/server.ts` | Boots, connects, handles all 4 tools |
| configure_topic | `src/tools/configure-topic.ts` | Creates topic in DB |
| search_messages | `src/tools/search-messages.ts` | Full-text search on messages table |
| get_action_items | `src/tools/action-items.ts` | Queries action_items table |
| get_daily_digest | `src/tools/digest.ts` | Calls AIAnalyzer |
| AIAnalyzer | `src/services/analyzer.ts` | Calls Claude API (upgrade planned in EP-6) |
| SQLite schema v1 | `src/db/schema.ts` | All tables created |
| DB connection | `src/db/connection.ts` | Init + migration runner |
| SyncService skeleton | `src/services/sync.ts` | No connectors wired yet |
| JiraConnector | `src/connectors/jira.ts` | Built, not wired (EP-4) |
| TypeScript build | — | Zero errors |

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-0-1 | MCP server boots, all 4 tools respond | ✅ Done |
| EP-0-2 | SQLite schema v1 | ✅ Done |
| EP-0-3 | configure_topic tool | ✅ Done |
| EP-0-4 | search_messages tool | ✅ Done |
| EP-0-5 | get_action_items tool | ✅ Done |
| EP-0-6 | get_daily_digest tool | ✅ Done |
| EP-0-7 | AIAnalyzer (action items, digest, questions) | ✅ Done |
| EP-0-8 | JiraConnector (built, not wired) | ✅ Done |
| EP-0-9 | SyncService skeleton | ✅ Done |
| EP-0-10 | TypeScript builds clean | ✅ Done |
