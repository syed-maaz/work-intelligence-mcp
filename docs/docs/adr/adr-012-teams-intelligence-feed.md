---
sidebar_position: 12
title: ADR-012 Teams Intelligence Feed
---

# ADR-012: Teams Intelligence Feed — Activity-First Redesign

**Date:** 2026-04-21  
**Status:** Implemented (EP-53 ✅, Sprint 11)  
**Epic:** EP-53  

---

## Context

The Teams Updates page was a pure search tool: users typed a keyword, waited for an AI summary, and read the result. It delivered zero passive value — the data was there, but nothing was surfaced proactively.

The system already stores 200+ Teams messages across 6 active chats, 28 unique people, and 81 action items. The Four-Stage Pipeline (Fetch → Process → Analyze → Propose) was fully populating the DB but the Propose stage only exposed a search box.

**Problem:** Search requires intent. A developer who hasn't checked Teams in two days can't know what to search for. The tool was invisible until you needed it, and useless when you did.

---

## Decision

Redesign the Teams Updates page from **search-only** to **activity-first**, with search preserved as a secondary tab.

### New architecture

1. **`chat_activity` rollup table** (schema v33): daily aggregations per chat — message count, unique authors, Jira links mentioned, mentions-me flag. Computed by `recomputeChatActivity()` after every Teams sync. Zero AI cost, ~5ms.

2. **`group_chats` digest columns**: `digest TEXT`, `digest_generated_at TEXT`, `jira_links TEXT`. Per-chat AI digest generated on demand via `POST /api/teams/chats/:name/digest` (Claude Haiku, &lt;15s, 2h cache).

3. **Three new REST endpoints**:
   - `GET /api/teams/chats` — chat list sorted by recent activity (last 24h/7d counts, member count, last preview)
   - `GET /api/teams/chats/:name/feed` — messages + meetings + action items for one chat, with inline Jira key extraction
   - `POST /api/teams/chats/:name/digest` — fire-and-forget digest generation (202 pattern)

4. **Two-tab UI**:
   - **Activity tab** (default): `ChatList` (left panel, sorted by activity) + `ChatFeedPanel` (center: messages, meetings, action items, AI digest card)
   - **Search tab**: existing EP-30 search UX unchanged

---

## Alternatives Considered

| Option | Rejected because |
|--------|-----------------|
| Keep search-only, just improve UI | Doesn't solve the passive-value problem |
| Real-time polling for new messages | Requires websocket or long-poll; over-engineered for current scale |
| Per-message reaction tracking | Reactions are stored as text suffix in content; fragile to parse |
| Threading reconstruction | No `parent_id` in schema; requires scraper change (EP-54) |

---

## Consequences

**Positive:**
- Teams data now surfaces proactively — most active chat selected by default on page load
- Jira links in Teams messages are now visible and clickable
- On-demand AI digest per chat (Haiku, cheap) bridges Teams ↔ project context
- Zero regression on search functionality

**Negative / Deferred:**
- `recomputeChatActivity()` runs on sync (not startup) — first load after restart shows empty `jira_links` until next sync
- Action items linked via topic routing (keyword match) — not directly linked to specific chat messages
- Threading and reactions deferred to EP-54

---

## Files Changed

| File | Change |
|------|--------|
| `src/db/schema.ts` | v33 migration: `chat_activity` table + `group_chats` new columns |
| `src/services/analyzer.ts` | `generateChatDigest()` standalone export (Haiku) |
| `web-server.js` | `recomputeChatActivity()` + 3 endpoints + import |
| `web/src/lib/api.ts` | `ChatSummary`, `ChatFeed`, `ChatMessage` types + 3 API functions |
| `web/src/pages/TeamsUpdatesPage.tsx` | Full rewrite: 2-tab layout |
| `web/src/components/shared/ChatList.tsx` | New: left panel chat list |
| `web/src/components/shared/ChatFeedPanel.tsx` | New: center feed panel |
