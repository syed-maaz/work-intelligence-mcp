---
title: "EP-4: Jira Browser Connector"
sidebar_label: "EP-4: Jira Scraper"
---

# EP-4: Jira Browser Connector

| | |
|---|---|
| **Status** | ✅ DONE |
| **Priority** | Medium |
| **Agent Role** | Jira Scraper Engineer |
| **Depends On** | [EP-1](./ep1-browser-session) |
| **Blocks** | [EP-5](./ep5-sync-pipeline) |
| **File Scope** | `src/connectors/jira-browser.ts` (create new) |

## Goal

Scrape Jira issues and comments from `jira.example.com` using the shared Playwright browser, reusing the existing SSO session. The existing `JiraConnector` (REST API) is **not usable** — the corporate Jira Data Center instance rate-limits API requests at the IP level regardless of token validity.

:::warning Start with EP-4-1 (DOM Spike)
Before writing any code, do the DOM inspection spike. Open `jira.example.com` in your browser, open DevTools, and find stable selectors. Document them in a comment block at the top of the file.
:::

## Why Browser Scraping

The Jira REST API (`/rest/api/2/`) is blocked by an IP-level rate limiter on the corporate Jira Data Center instance (`jira.example.com`). Every request — including the very first auth check — returns `429 Too Many Requests` even after 24+ hours. Browser scraping reuses the existing SSO session and bypasses this entirely, consistent with the Teams and Outlook approach.

## Acceptance Criteria

- [ ] `JiraBrowserConnector` class in `src/connectors/jira-browser.ts`
- [ ] Implements `DataSource` interface from `src/services/sync.ts`
- [ ] Constructor accepts `BrowserSessionManager` (from EP-1) and optional `RateLimitConfig`
- [ ] `fetchMessages(config, since?): Promise<UnifiedMessage[]>`:
  - `config` shape: `{ boardUrl: string, projectKey?: string }`
  - Navigates to the Jira board/backlog URL
  - Collects issues updated since `since` (default: last 24h)
  - For each issue: opens it, extracts title, description, status, assignee, reporter, comments
  - Returns `UnifiedMessage[]` with `source: MessageSource.Jira`
- [ ] `source_id` = Jira issue key (e.g. `PROJ-123`) for issues, `PROJ-123-comment-{id}` for comments
- [ ] Error handling:
  - Login redirect → `ConnectorError(ConnectorErrorType.Authentication)`
  - Page load timeout → `ConnectorError(ConnectorErrorType.Network)`
  - No issues in range → returns `[]`
- [ ] Does **not** import from `src/db/**`
- [ ] `npm run typecheck` passes

## Key Types to Reuse

```typescript
import { UnifiedMessage, MessageSource, DataSource, ConnectorError, ConnectorErrorType, RateLimitConfig } from './types.js';
import type { BrowserSessionManager } from './browser-session.js';
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-4-1 | **SPIKE**: Inspect Jira DOM, document issue list + detail selectors | ✅ DONE |
| EP-4-2 | `JiraBrowserConnector` skeleton + `fetchMessages` signature | ✅ DONE |
| EP-4-3 | Issue list scraping with date filter | ✅ DONE |
| EP-4-4 | Issue detail extraction (title, description, status, assignee, comments) | ✅ DONE |
| EP-4-5 | Map to `UnifiedMessage[]` with stable `source_id` | ✅ DONE |
| EP-4-6 | Auth redirect and error handling | ✅ DONE |
| EP-4-7 | Manual integration test against real Jira instance | ✅ DONE |

---

## Agent Prompt

:::tip Start This Epic
EP-1 (BrowserSessionManager) must be complete before starting this epic.
:::

```
You are implementing EP-4: Jira Browser Connector for the Work Intelligence MCP project.


CONTEXT:
The Jira REST API is blocked by an IP-level rate limiter on the corporate Jira Data Center
instance (jira.example.com) — every API request returns 429 regardless of token. We scrape
jira.example.com using Playwright, reusing the user's existing SSO browser session.

Note: src/connectors/jira.ts exists (REST API implementation) but is NOT used. Do not modify it.

PREREQUISITE: EP-1 (BrowserSessionManager) is complete at src/connectors/browser-session.ts

YOUR SCOPE: One file — src/connectors/jira-browser.ts (create it).
Do NOT modify any other files.

TYPES TO READ FIRST:
- src/connectors/types.ts — UnifiedMessage, MessageSource, DataSource, ConnectorError, RateLimitConfig
- src/connectors/browser-session.ts — BrowserSessionManager (your dependency)
- src/services/sync.ts — DataSource interface (you must implement this)

STEP 1 — DOM SPIKE (do this before writing code):
Open jira.example.com in your browser, navigate to a project board or issue list.
Open DevTools → Inspector. Find and document:
- The issue list/board container and per-issue row selector
- Issue key, summary, updated date per row
- The issue detail page: title, description, status, assignee, reporter, created date
- Comment list container and per-comment selector (author, body, date)
- How to detect a login redirect
Document these as a comment block at the top of your file before any code.

STEP 2 — Implementation:
Class: JiraBrowserConnector
- constructor(session: BrowserSessionManager, rateLimitConfig?: RateLimitConfig)
- fetchMessages(config, since?): Promise<UnifiedMessage[]>
  - config: { boardUrl: string, projectKey?: string }
  - Navigate to boardUrl, collect issues updated >= since (default 24h)
  - For each issue: open detail page, extract title, description, status, assignee, comments
  - Map issues to UnifiedMessage with source: MessageSource.Jira
  - Map comments as separate UnifiedMessage entries with isReply: true
  - source_id: issue key (e.g. "PROJ-123") for issues, "PROJ-123-comment-{id}" for comments
  - Login redirect → ConnectorError(ConnectorErrorType.Authentication)
  - Timeout → ConnectorError(ConnectorErrorType.Network)

ACCEPTANCE CRITERIA:
- Implements DataSource interface
- npm run typecheck passes
- Empty board returns []
- Login redirect throws ConnectorError(Authentication)
- source_id is stable across multiple calls for the same issue
```
