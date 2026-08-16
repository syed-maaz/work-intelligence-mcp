---
title: "EP-12: Universal Search (search_all)"
sidebar_label: "EP-12: Universal Search"
---

# EP-12: Universal Search

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Depends On** | [EP-3](./ep3-outlook-scraper), [EP-4](./ep4-jira-wiring), [EP-11](./ep11-teams-sync) |
| **File Scope** | `src/tools/search-all.ts` (created), `src/server.ts` (modified), `src/tools/index.ts` (modified) |

## Goal

Type any keyword, sentence, or topic and get back all relevant information from Outlook email, Jira issues, and Teams messages — fetched live from Outlook and Jira, combined with stored Teams data, then AI-summarized in a single response.

## What Was Built

**New MCP tool: `search_all`**

- Live-fetches from Outlook (subject-filtered) and Jira (board URL) using the shared browser session
- Stores all fetched messages to the `messages` table (deduped by `source_id`)
- Searches everything via FTS5 (falling back to LIKE) across all three sources in one query
- Also searches `meetings` table for relevant Teams meeting transcripts
- Returns a Claude-summarized report grouped by source: Email / Jira / Teams / Meetings

## Acceptance Criteria

- [x] `search_all` MCP tool registered in `src/server.ts`
- [x] Live Outlook fetch with `subjectFilter` = query
- [x] Live Jira fetch using `JIRA_BOARD_URL` env var or `jiraBoardUrl` arg
- [x] Sequential fetches (email then Jira) — shared browser session cannot run in parallel
- [x] Timeout guards: 90s for Outlook, 300s for Jira — partial results returned on timeout
- [x] FTS5 search across all sources with LIKE fallback
- [x] AI summary via `claude-sonnet-4-6` with prompt caching
- [x] Fetch errors noted in response (not thrown) — first line only, no Playwright stacktraces
- [x] `npm run typecheck` passes

## Parameters

```typescript
{
  query: string;                              // Required — keyword, sentence, topic, or question
  sources?: Array<'email' | 'jira' | 'teams'>; // Default: all three
  since?: string;                             // ISO date, default: 7 days ago
  jiraBoardUrl?: string;                      // Falls back to JIRA_BOARD_URL env var
  outlookFolder?: string;                     // Default: 'inbox'
  maxResults?: number;                        // Default: 50
}
```

## Response Structure

```
## Summary
<AI-generated answer to the query across all sources>

---
*Searched across Outlook, Jira, and Teams for "query" — N result(s) found.*

## Email Results (N)
**Author** — YYYY-MM-DDTHH:MM
*Subject*
Body preview...

## Jira Results (N)
...

## Teams Results (N)
...

## Meetings (N)
### Meeting Title
**Date:** YYYY-MM-DD  |  **Chat:** chat name
**Summary:** ...
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-12-1 | `searchAll()` function with FTS + LIKE fallback | ✅ Done |
| EP-12-2 | Live Outlook fetch + store integration | ✅ Done |
| EP-12-3 | Live Jira fetch + store integration | ✅ Done |
| EP-12-4 | Sequential fetch with per-source timeout guards | ✅ Done |
| EP-12-5 | AI summarization (multi-source prompt) | ✅ Done |
| EP-12-6 | Register `search_all` tool in `src/server.ts` | ✅ Done |
| EP-12-7 | End-to-end test: fetched Outlook email + Teams message + meeting summarized | ✅ Done |

## Implementation Notes

- **Topic naming**: results stored under `search:<query>` topic prefix — separate from user-configured topics
- **Jira timeout**: 300s (5 min) — scraping 50 detail pages takes ~2–3 min on the corporate VPN
- **Error truncation**: `err.message.split('\n')[0]` prevents verbose Playwright stacktraces appearing in MCP output
- **Sequential vs parallel**: Outlook and Jira share one `BrowserSessionManager`; running them in parallel causes `SingletonLock` errors. They run sequentially: Outlook first, then Jira.
