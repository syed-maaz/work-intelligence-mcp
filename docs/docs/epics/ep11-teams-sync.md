---
title: "EP-11: Teams Chat Sync & Search"
sidebar_label: "EP-11: Teams Sync"
---

# EP-11: Teams Chat Sync & Search

| | |
|---|---|
| **Status** | ✅ DONE |
| **Priority** | High |
| **Agent Role** | Teams Integration Engineer |
| **Depends On** | [EP-2](./ep2-teams-scraper), [EP-7](./ep7-schema-migration) |
| **Blocks** | — |
| **File Scope** | `src/db/schema.ts`, `src/scripts/teams-sync.ts`, `src/tools/teams-updates.ts`, `src/server.ts` |

## Goal

Wire the Teams scraper into a usable end-to-end system: schema v3 with `group_chats` table + FTS5 indexes, a `teams-sync` CLI for scheduled/manual syncs, and a `get_teams_updates` MCP tool for natural-language search with AI summarization.

## What Was Built

### Schema v3 (`src/db/schema.ts`)

Added on top of schema v2:
- **WAL mode** — `PRAGMA journal_mode=WAL` for concurrent reads during sync
- **`group_chats` table** — tracks active/inactive state per chat:
  ```sql
  CREATE TABLE group_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    last_message_at TEXT,
    is_active INTEGER DEFAULT 1,
    last_scraped_at TEXT,
    inactive_since TEXT,
    message_count INTEGER DEFAULT 0
  )
  ```
- **Extended `meetings` columns** — `transcript TEXT`, `topics TEXT` (JSON), `summary TEXT`, `chat_name TEXT`, `source_id TEXT`
- **`messages_fts`** — FTS5 virtual table on `content + subject` with content sync triggers
- **`meetings_fts`** — FTS5 virtual table on `title + transcript + topics + summary + decisions`

### `npm run teams-sync`

Standalone sync script:
- `TEAMS_ALL=true` — scrape all chats (default: unread only)
- `TEAMS_SINCE_DAYS` — days of history to load (default: 90)
- Upserts `group_chats`, `messages`, `meetings` in a single browser session
- Runs `markInactiveChats()` at end of each sync
- Prints markdown summary to stdout

### `get_teams_updates` MCP Tool

Natural-language search across stored Teams data:
- **FTS5 BM25 ranking** — fast full-text search across messages and meetings
- **LIKE fallback** — for short or common queries where FTS returns nothing
- **Groups messages by chat** — up to 5 messages shown per chat
- **Meeting results** — shows summary, topics, decisions
- **Missing transcript detection** — scans matched chats for meeting signals; if no transcript stored, prompts the user to paste it
- **Claude Sonnet 4.6 summarization** — direct answer + key updates + decisions/action items

## Usage

```bash
# Sync all chats
TEAMS_ALL=true npm run teams-sync

# Sync unread only (fast)
npm run teams-sync

# Sync last 30 days
TEAMS_SINCE_DAYS=30 TEAMS_ALL=true npm run teams-sync
```

MCP tool (Claude Desktop / Cursor):
```
get_teams_updates { "query": "KBA access issues this week" }
get_teams_updates { "query": "persona discussion decisions", "includeMeetings": true }
get_teams_updates { "query": "action items from Saturn retro", "since": "2026-04-01" }
```

## Acceptance Criteria

- [x] Schema v3 migration runs cleanly on v2 databases
- [x] `group_chats` table tracks `is_active`, `last_message_at`, `inactive_since`
- [x] FTS5 tables `messages_fts` and `meetings_fts` with AFTER INSERT/UPDATE/DELETE triggers
- [x] `upsertGroupChat()`, `upsertMessage()`, `upsertMeeting()` all use correct FK (no `topic_id = 0`)
- [x] `markInactiveChats()` sets `is_active = 0` after 7 days of no activity
- [x] `get_teams_updates` FTS5 search with LIKE fallback
- [x] Missing transcript detection surfaces chats needing user-provided transcripts
- [x] AI summary via Claude Sonnet 4.6 with prompt caching
- [x] Registered in `server.ts`
- [x] `npm run typecheck` passes
- [x] Integration test: 6 chats, 143 messages, 2 meetings synced successfully

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-11-1 | Schema v3 — WAL, `group_chats`, extended `meetings`, FTS5 tables + triggers | ✅ DONE |
| EP-11-2 | `upsertGroupChat()` with invalid-date guard | ✅ DONE |
| EP-11-3 | `upsertMessage()` with auto-topic FK | ✅ DONE |
| EP-11-4 | `upsertMeeting()` with auto-topic FK (fix `topic_id = 0` bug) | ✅ DONE |
| EP-11-5 | `markInactiveChats()` — 7-day inactivity threshold | ✅ DONE |
| EP-11-6 | `teams-sync` CLI + `npm run teams-sync` | ✅ DONE |
| EP-11-7 | `get_teams_updates` — FTS5 + LIKE fallback + missing transcript detection | ✅ DONE |
| EP-11-8 | Claude Sonnet 4.6 summarization with prompt caching | ✅ DONE |
| EP-11-9 | Wire `get_teams_updates` into `server.ts` | ✅ DONE |
| EP-11-10 | Integration test against real Teams data | ✅ DONE |
