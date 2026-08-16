---
title: "EP-1: Browser Session Manager"
sidebar_label: "EP-1: Browser Session"
---

# EP-1: Browser Session Manager

| | |
|---|---|
| **Status** | ✅ DONE |
| **Priority** | High |
| **Agent Role** | Browser Infrastructure Engineer |
| **Depends On** | [EP-0](./ep0-foundation) |
| **Blocks** | [EP-2](./ep2-teams-scraper), [EP-3](./ep3-outlook-scraper) |
| **File Scope** | `src/connectors/browser-session.ts` (create new) |

## Goal

Provide a stable, **reusable Playwright browser instance** shared by all browser-based connectors. Handles launch, Chrome profile loading (for SSO cookie reuse), session persistence, and graceful shutdown.

This is pure infrastructure — no page scraping logic lives here.

## Acceptance Criteria

- [ ] `BrowserSessionManager` class in `src/connectors/browser-session.ts`
- [ ] Constructor accepts config: `{ profilePath: string, headless: boolean, executablePath?: string }`
- [ ] `getPage(url: string): Promise<Page>` — returns a Playwright `Page` navigated to the given URL, reusing the existing browser instance across calls
- [ ] If browser not yet launched, launches it; if already running, reuses it
- [ ] `close(): Promise<void>` — gracefully closes the browser
- [ ] Singleton factory exported: `getBrowserSession(config)` — returns the same instance across calls within a process
- [ ] Navigation errors mapped to `ConnectorError` with appropriate `ConnectorErrorType`:
  - `net::ERR_*`, timeout → `ConnectorErrorType.Network`
  - Redirect to login page → `ConnectorErrorType.Authentication`
- [ ] Config loadable from env vars: `BROWSER_PROFILE_PATH`, `BROWSER_HEADLESS`, `BROWSER_EXECUTABLE`
- [ ] `playwright` added to `package.json` dependencies
- [ ] `npm run typecheck` passes after this change

## Key Types to Reuse

Import these from `src/connectors/types.ts` — do not redefine:

```typescript
import { ConnectorError, ConnectorErrorType } from './types.js';
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-1-1 | Add `playwright` to `package.json` dependencies | ✅ DONE |
| EP-1-2 | Implement `BrowserSessionManager` class | ✅ DONE |
| EP-1-3 | Implement singleton `getBrowserSession()` factory | ✅ DONE |
| EP-1-4 | Load config from env vars | ✅ DONE |
| EP-1-5 | Map navigation errors to `ConnectorError` types | ✅ DONE |
| EP-1-6 | Verify Chrome profile SSO cookie preservation in headless mode | ✅ DONE |

---

## Agent Prompt

:::tip Start This Epic
Copy the prompt below and paste it to a new Claude Code session to start this epic immediately.
:::

```
You are implementing EP-1: Browser Session Manager for the Work Intelligence MCP project.


CONTEXT:
This is a Node.js 20 / TypeScript 5.7 MCP server. We are replacing Microsoft Graph API connectors
(blocked by corporate IT) with Playwright browser scraping that reuses the user's existing SSO session.
Your job is ONLY the shared browser infrastructure. Do not write any scraping logic.

YOUR SCOPE: One file — src/connectors/browser-session.ts (create it).
Do NOT modify any other files except package.json (to add playwright).

TYPES TO REUSE (read src/connectors/types.ts first):
- ConnectorError, ConnectorErrorType — import and reuse, do not redefine

WHAT TO BUILD:
1. Add "playwright" to package.json dependencies
2. BrowserSessionManager class:
   - Config: { profilePath: string, headless: boolean, executablePath?: string }
   - getPage(url: string): Promise<Page> — navigate to URL, reuse browser instance
   - close(): Promise<void> — graceful shutdown
3. Singleton factory: getBrowserSession(config) — same instance across calls
4. Load config from env: BROWSER_PROFILE_PATH, BROWSER_HEADLESS, BROWSER_EXECUTABLE
5. Map navigation errors to ConnectorError with ConnectorErrorType (Network / Authentication)

ACCEPTANCE CRITERIA (all must pass):
- npm run typecheck passes with zero errors
- getBrowserSession() called twice with same config returns the same instance
- getPage() navigates to the given URL
- Timeout throws ConnectorError(ConnectorErrorType.Network)
- Config reads from env vars as fallback

Read these files before starting:
- src/connectors/types.ts (ConnectorError, ConnectorErrorType, RateLimitConfig)
- package.json (existing dependencies)
```
