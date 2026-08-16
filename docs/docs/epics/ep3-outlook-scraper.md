---
title: "EP-3: Outlook Browser Connector"
sidebar_label: "EP-3: Outlook Scraper"
---

# EP-3: Outlook Browser Connector

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Agent Role** | Outlook Scraper Engineer |
| **Depends On** | [EP-1](./ep1-browser-session) |
| **Blocks** | [EP-5](./ep5-sync-pipeline) |
| **File Scope** | `src/connectors/outlook-browser.ts` |

## Goal

Scrape Outlook emails from `outlook.office.com` using the shared Playwright browser. Convert emails to `UnifiedMessage[]` for the sync pipeline. No auth needed — reuses existing SSO session.

:::warning Start with EP-3-1 (DOM Spike)
Before writing any code, do the DOM inspection spike. Open `outlook.office.com` in your browser, open DevTools, and find stable selectors. Document them in a comment block at the top of the file. This is non-negotiable — skipping it leads to selectors that break in weeks.
:::

## Acceptance Criteria

- [x] `OutlookBrowserConnector` class in `src/connectors/outlook-browser.ts`
- [x] Implements `DataSource` interface from `src/services/sync.ts`
- [x] Constructor accepts `BrowserSessionManager` (from EP-1) and optional `RateLimitConfig`
- [x] `fetchMessages(config, since?): Promise<UnifiedMessage[]>`:
  - `config` shape: `{ folder?: string, subjectFilter?: string }`
  - Navigates to inbox or specified folder
  - Iterates emails received >= `since` (default: last 24h)
  - Opens each email to extract full body if needed
  - Extracts per email: from, to/cc, subject, body (HTML stripped), timestamp
  - Returns `UnifiedMessage[]` with `source: MessageSource.Email`
- [x] Deduplication: conversation ID from `data-convid` DOM attribute (`outlook-conv-${convId.slice(-16)}`)
- [x] Error handling:
  - Login redirect detected → `ConnectorError(ConnectorErrorType.Authentication)`
  - Page load timeout → `ConnectorError(ConnectorErrorType.Network)`
  - Empty inbox / no messages in range → returns `[]`
- [x] Does **not** import from `src/db/**` — connectors never touch the DB directly
- [x] `npm run typecheck` passes

## Verified OWA DOM Selectors

Documented in `src/connectors/outlook-browser.ts` (DOM spike comment block):

| Element | Selector |
|---------|---------|
| Email list rows | `div[aria-label="Message list"] div[role="option"]` |
| Sender name | `div.S2NDX span[title]` |
| Subject | `span.TtcXM` |
| Date (ISO in `title` attr) | `span._rWRU` |
| Conversation ID | `data-convid` attribute on row |
| Reading pane body | `div[role="document"]` |

These selectors use structural/ARIA attributes and are stable across OWA updates.

## Key Types to Reuse

```typescript
import { UnifiedMessage, MessageSource, DataSource, ConnectorError, ConnectorErrorType, RateLimitConfig } from './types.js';
import type { BrowserSessionManager } from './browser-session.js';
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-3-1 | **SPIKE**: Inspect Outlook DOM, document stable selectors + message ID availability | ✅ Done |
| EP-3-2 | `OutlookBrowserConnector` skeleton + `fetchMessages` signature | ✅ Done |
| EP-3-3 | Email list iteration with date filtering | ✅ Done |
| EP-3-4 | Email detail extraction (open each email, strip HTML) | ✅ Done |
| EP-3-5 | Deduplication logic (`source_id` computation) | ✅ Done |
| EP-3-6 | Auth redirect and error handling | ✅ Done |
| EP-3-7 | Manual integration test against real Outlook instance | ✅ Done |

---

## Agent Prompt

:::tip Start This Epic
EP-1 (BrowserSessionManager) must be complete before starting this epic.
:::

```
You are implementing EP-3: Outlook Browser Connector for the Work Intelligence MCP project.


CONTEXT:
Corporate IT blocks Microsoft Graph API. We scrape outlook.office.com using Playwright,
reusing the user's existing SSO session. Your job is ONLY the Outlook scraper.

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

YOUR SCOPE: One file — src/connectors/outlook-browser.ts (create it).
Do NOT modify any other files.

TYPES TO READ FIRST:
- src/connectors/types.ts — UnifiedMessage, MessageSource, DataSource, ConnectorError, RateLimitConfig
- src/connectors/browser-session.ts — BrowserSessionManager (your dependency)
- src/services/sync.ts — DataSource interface (you must implement this)
- src/connectors/jira-browser.ts — reference implementation (DOM spike pattern, error handling)

STEP 1 — DOM SPIKE (do this before writing code):
Open outlook.office.com in your browser, navigate to inbox.
Open DevTools → Inspector. Find and document:
- The email list container element and per-row selectors
- Sender, subject, received date per row
- Whether internet message ID is available in DOM (check data-* attrs, aria attrs)
- The email body container when an email is opened
- How to detect a login redirect (URL pattern or element)
- Pagination / "load more" mechanism
Document these as a comment block at the top of your file before any code.

STEP 2 — Implementation:
Class: OutlookBrowserConnector
- constructor(session: BrowserSessionManager, rateLimitConfig?: RateLimitConfig)
- fetchMessages(config, since?): Promise<UnifiedMessage[]>
  - config: { folder?: string, subjectFilter?: string }
  - Navigate to inbox/folder, filter by date >= since (default 24h)
  - For each email: extract from, to, subject, body (HTML stripped), timestamp
  - Map to UnifiedMessage with source: MessageSource.Email
  - source_id: internet message ID from DOM if available, else hash(sender+subject+date)
  - Login redirect → ConnectorError(ConnectorErrorType.Authentication)
  - Timeout → ConnectorError(ConnectorErrorType.Network)
  - Empty inbox → return []
  - Write progress to process.stderr.write (not console.log) — e.g. "[Outlook] Email N/total"

ACCEPTANCE CRITERIA:
- Implements DataSource interface
- npm run typecheck passes
- Empty inbox returns []
- Login redirect throws ConnectorError(Authentication)
- source_id is stable across multiple calls for the same message
```
