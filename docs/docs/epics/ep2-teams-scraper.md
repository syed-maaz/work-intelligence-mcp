---
title: "EP-2: Teams Browser Connector"
sidebar_label: "EP-2: Teams Scraper"
---

# EP-2: Teams Browser Connector

| | |
|---|---|
| **Status** | ✅ DONE |
| **Priority** | High |
| **Agent Role** | Teams Scraper Engineer |
| **Depends On** | [EP-1](./ep1-browser-session) |
| **Blocks** | [EP-5](./ep5-sync-pipeline) |
| **File Scope** | `src/connectors/teams-chats.ts`, `src/connectors/teams-meetings.ts`, `src/scripts/teams-sync.ts` |

## Goal

Scrape Microsoft Teams group chats and meeting recaps from `teams.microsoft.com/v2/` using the shared Playwright browser. Track active/inactive chats event-driven, scrape meeting transcripts from the Recap tab inline, and store everything in SQLite with FTS5 search. No auth needed — reuses existing SSO session.

## What Was Built

### `src/connectors/teams-chats.ts`
`TeamsChatScraper` class — discovers all group chats from the Teams sidebar and scrapes messages:
- `readSidebar()`: scrolls `app-layout-area--sub-nav` to load all virtualised items, filters by date/time pattern, deduplicates by name
- `scrapeOneChat()`: clicks sidebar item, collects messages via scroll-up loop, then checks for Recap tab (after message scraping, with 3s timeout to allow tab bar to settle)
- `scrapeMessages()`: scroll-up loop on `message-pane-list-viewport`, stable `sha256(chat|sender|timestamp|contentPrefix)` hash per message, stops at cutoff or 2 passes with no new content
- Auth redirect detection via URL pattern check

### `src/connectors/teams-meetings.ts`
`TeamsMeetingsScraper` — scrapes the Recap tab inline on the same open page:
- Clicks Recap tab, waits for `intelligent-recap-header` to confirm load
- Clicks Speakers / Transcript / Notes / AINotes pills in sequence
- Full text dump of `meeting-recap-main-panel` for transcript
- Claude Haiku analysis (tool use) extracts: summary, topics, decisions, action items
- Prompt caching via `beta.promptCaching`

### `src/scripts/teams-sync.ts`
`npm run teams-sync` CLI — orchestrates the full sync:
- `TEAMS_ALL=true` scrapes all chats; default scrapes unread only
- `TEAMS_SINCE_DAYS` (default 90)
- `upsertGroupChat()` / `upsertMessage()` / `upsertMeeting()` — all use `INSERT OR IGNORE INTO topics` pattern to avoid FK constraint errors
- `markInactiveChats()` — sets `is_active = 0` where `last_message_at` older than 7 days
- Prints summary to stdout on completion

### `src/tools/teams-updates.ts`
`get_teams_updates` MCP tool — keyword/sentence/topic search over stored Teams data:
- FTS5 BM25 search with LIKE fallback
- Groups message results by chat
- Missing transcript detection: chats with meeting-signal keywords but no stored transcript prompt the user to provide it
- Claude Sonnet 4.6 summarization with grouped results

### `src/server.ts` (wired)
`get_teams_updates` tool registered with `query`, `since`, `includeMeetings`, `maxResults` params.

## DOM Selectors (confirmed April 2026)

```
Sidebar rail:     div[data-tid="simple-collab-dnd-rail"]
Sub-nav scroller: [data-tid="app-layout-area--sub-nav"]
Chat title:       [data-tid="chat-title"]
Viewport:         div[data-tid="message-pane-list-viewport"]
Chat pane item:   div[data-tid="chat-pane-item"]
Message body:     div[data-tid="chat-pane-message"]
Author:           span[data-tid="message-author-name"]
Timestamp:        time[datetime]
Recap tab:        button[data-tid="tab-item-com.microsoft.chattabs.recap"]
Recap header:     [data-tid="intelligent-recap-header"]
Main panel:       [data-tid="meeting-recap-main-panel"]
Left panel:       [data-tid="Meeting-Recap-left-panel-container"]
Transcript pill:  button[data-tid="Transcript"]
Notes pill:       button[data-tid="Notes"]
AI Notes pill:    button[data-tid="AINotes"]
Speakers pill:    button[data-tid="Speakers"]
APC body:         [data-tid="apc-body"]
AI insights:      [data-tid="ai-insights-content-wrapper"]
```

## Active Chat Logic

- **Active**: chat had a new message in the last 7 days (`INACTIVE_THRESHOLD_DAYS`)
- **Inactive**: `last_message_at` older than threshold → `is_active = 0`, `inactive_since` set
- `markInactiveChats()` runs at end of every sync

## Acceptance Criteria

- [x] `TeamsChatScraper` in `src/connectors/teams-chats.ts`
- [x] `TeamsMeetingsScraper` in `src/connectors/teams-meetings.ts`
- [x] Sidebar discovery with virtual list scroll-loading
- [x] Message scroll-up loop with `since` cutoff and deduplication
- [x] Recap tab scraped inline (same page, while chat is open)
- [x] Claude Haiku extracts topics / decisions / action items from transcripts
- [x] `upsertMeeting()` with correct FK (no hardcoded `topic_id = 0`)
- [x] `markInactiveChats()` sets inactive after 7 days
- [x] `get_teams_updates` tool with FTS5 + LIKE fallback + AI summary
- [x] Missing transcript detection — prompts user to provide transcript when meeting signals found
- [x] `npm run typecheck` passes
- [x] Manual integration test: 6 chats, 143 messages, 2 meetings scraped

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-2-1 | DOM spike — Teams sidebar + chat + Recap tab selectors | ✅ DONE |
| EP-2-2 | `TeamsChatScraper` — sidebar discovery + `scrapeChats()` | ✅ DONE |
| EP-2-3 | Message scroll-up loop with `since` cutoff | ✅ DONE |
| EP-2-4 | Deduplication — `sha256(chat\|sender\|timestamp\|contentPrefix)` | ✅ DONE |
| EP-2-5 | Auth redirect detection | ✅ DONE |
| EP-2-6 | `TeamsMeetingsScraper` — Recap tab inline scraping | ✅ DONE |
| EP-2-7 | Claude Haiku meeting analysis (tool use + prompt caching) | ✅ DONE |
| EP-2-8 | `teams-sync.ts` CLI with `upsertGroupChat` / `upsertMessage` / `upsertMeeting` | ✅ DONE |
| EP-2-9 | Schema v3 — `group_chats`, extended `meetings`, FTS5 tables + WAL mode | ✅ DONE |
| EP-2-10 | `get_teams_updates` MCP tool — FTS5 search + AI summary + missing transcript detection | ✅ DONE |
| EP-2-11 | Wire `get_teams_updates` into `server.ts` | ✅ DONE |

---

## Agent Prompt

:::tip Start This Epic
EP-1 (BrowserSessionManager) must be complete before starting this epic.
:::

```
You are implementing EP-2: Teams Browser Connector for the Work Intelligence MCP project.


CONTEXT:
Corporate IT blocks Microsoft Graph API. We scrape teams.microsoft.com using Playwright,
reusing the user's existing SSO session. Your job is ONLY the Teams scraper.

PREREQUISITE: EP-1 (BrowserSessionManager) is complete at src/connectors/browser-session.ts

CRITICAL BROWSER SETUP (learned from EP-4/EP-10 implementation):
BrowserSessionManager uses launchPersistentContext(), which returns a BrowserContext — NOT a
Browser. All pages must be opened via context.newPage(), NOT browser.newContext().newPage().
The user's Chrome profile is at ~/Library/Application Support/Google/Chrome/Profile 3
(the profile with  SSO). BROWSER_EXECUTABLE must point to the real Chrome binary:
  BROWSER_EXECUTABLE=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
Playwright's bundled Chromium cannot decrypt macOS Keychain cookies and will get garbage values.
When Chrome is running, BrowserSessionManager copies the profile to a temp dir to avoid
SingletonLock. This is all already handled — just use BrowserSessionManager as-is.

YOUR SCOPE: One file — src/connectors/teams-browser.ts (create it).
Do NOT modify any other files.

TYPES TO READ FIRST:
- src/connectors/types.ts — UnifiedMessage, MessageSource, DataSource, ConnectorError, RateLimitConfig
- src/connectors/browser-session.ts — BrowserSessionManager (your dependency)
- src/services/sync.ts — DataSource interface (you must implement this)
- src/connectors/jira-browser.ts — reference implementation (DOM spike pattern, error handling)

STEP 1 — DOM SPIKE (do this before writing code):
Open teams.microsoft.com in your browser, navigate to any channel.
Open DevTools → Inspector. Find and document:
- The container element for the message list
- Per-message element: selector, data-* attributes for message ID, sender name, timestamp
- Message body content selector
- How to detect a login redirect (URL pattern or element)
Document these as a comment block at the top of your file before any code.

STEP 2 — Implementation:
Class: TeamsBrowserConnector
- constructor(session: BrowserSessionManager, rateLimitConfig?: RateLimitConfig)
- fetchMessages(config, since?): Promise<UnifiedMessage[]>
  - config: { channelUrl: string, teamName?: string, channelName?: string }
  - Navigate to channelUrl, wait for messages, scroll to collect back to `since` (default 24h)
  - Map each message to UnifiedMessage with source: MessageSource.Teams
  - source_id: DOM data-* message ID attr, or hash(sender+timestamp+content.slice(0,50))
  - Login redirect → ConnectorError(ConnectorErrorType.Authentication)
  - Timeout → ConnectorError(ConnectorErrorType.Network)
  - Write progress to process.stderr.write (not console.log) — e.g. "[Teams] Page N: X messages"

ACCEPTANCE CRITERIA:
- Implements DataSource interface
- npm run typecheck passes
- Empty channel returns []
- Login redirect throws ConnectorError(Authentication)
- source_id is stable across multiple calls for the same message
```
