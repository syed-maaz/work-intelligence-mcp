---
id: ep53-teams-intelligence
title: EP-53 — Teams Intelligence Feed
---

# EP-53 — Teams Intelligence Feed

| Field | Value |
|-------|-------|
| Sprint | Sprint 11 |
| Status | ✅ Done (2026-04-21) |
| ADR | ADR-012 |
| Schema | v33 |
| Effort | ~1 session |

## Problem

Teams Updates was search-only. Zero passive value — data in DB, nothing surfaced proactively. Users had to remember to check, and remember what to search for.

## Decisions Made

1. **Activity-first layout** — chat list sorted by recency/volume replaces the search box as the default view. Search preserved as secondary tab (no regression).
2. **`chat_activity` rollup** — pure SQL aggregation per (chat, date), no AI. Runs after every Teams sync via `recomputeChatActivity(db)`.
3. **On-demand chat digest** — Claude Haiku, 2h cache, fire-and-forget 202 pattern. Cheap enough to run per chat.
4. **Jira key extraction in JS layer** — regex `[A-Z][A-Z0-9_]+-\d+` applied at query time (not stored per-message) to avoid schema churn.
5. **`maxWidth: 1100px`** for the page — wider than other pages to accommodate the split-panel layout.

## Schema v33

```sql
CREATE TABLE chat_activity (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_name       TEXT NOT NULL,
  date            TEXT NOT NULL,          -- YYYY-MM-DD
  message_count   INTEGER NOT NULL DEFAULT 0,
  unique_authors  INTEGER NOT NULL DEFAULT 0,
  has_decisions   INTEGER NOT NULL DEFAULT 0,
  has_action_items INTEGER NOT NULL DEFAULT 0,
  jira_links      TEXT NOT NULL DEFAULT '[]',
  mentions_me     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(chat_name, date)
);
CREATE INDEX idx_chat_activity_date ON chat_activity(date, message_count DESC);
-- Also adds to group_chats:
ALTER TABLE group_chats ADD COLUMN digest TEXT;
ALTER TABLE group_chats ADD COLUMN digest_generated_at TEXT;
ALTER TABLE group_chats ADD COLUMN jira_links TEXT NOT NULL DEFAULT '[]';
```

## New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/teams/chats` | Chat list with activity metrics |
| GET | `/api/teams/chats/:name/feed` | Messages + meetings + action items |
| POST | `/api/teams/chats/:name/digest` | Generate/refresh AI chat digest |

## New Components

- `web/src/components/shared/ChatList.tsx` — left panel, sorted by activity dot (green/amber/gray)
- `web/src/components/shared/ChatFeedPanel.tsx` — center panel with digest card, meetings, action items, messages

## Acceptance Criteria

- [x] `GET /api/teams/chats` returns chats sorted by `last24hCount` desc
- [x] `GET /api/teams/chats/:name/feed` returns messages + action items + meetings
- [x] Jira keys extracted from message content (`SP-32516`, `PROJ-14832`, etc.)
- [x] `POST /api/teams/chats/:name/digest` fires async Haiku digest, returns 202
- [x] Activity tab loads with most-active chat selected by default
- [x] Search tab fully preserved (no regression)
- [x] `recomputeChatActivity()` wired into `runFullSync()` after Teams sync
- [x] TypeScript typecheck clean, build clean

## What Was Skipped (Deferred to EP-54)

- Reaction parsing (text suffix in content — fragile)
- Message threading (no `parent_id` in schema)
- Mention-count per person
- Unread count (would need persistent read-position tracking)
