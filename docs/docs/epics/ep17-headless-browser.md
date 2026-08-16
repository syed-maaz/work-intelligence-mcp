---
title: "EP-17: Headless Browser (Invisible Jira/Outlook Fetch)"
sidebar_label: "EP-17: Headless Browser"
---

# EP-17: Headless Browser

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Agent Role** | Infrastructure / DevOps Engineer |
| **Depends On** | — |
| **Blocks** | [EP-20](./ep20-saturn-board), [EP-21](./ep21-my-jira-issues), [EP-25](./ep25-calendar-sync) |
| **File Scope** | `src/connectors/browser-session.ts` (edit), `.env.example` (edit), `CLAUDE.md` (edit) |

## Goal

Ensure all Playwright browser automation (Jira scraping, Outlook email, calendar) runs silently in the background — no visible Chrome window opens during normal operation. The existing code has the correct default (`headless: true`) but it has never been formally audited, logged, or documented. This epic locks it down so subsequent browser-heavy epics (EP-20, EP-21, EP-25) run invisibly.

## Decisions Made

- **Headless via env var, not hardcode**: `process.env.BROWSER_HEADLESS !== 'false'` is already the correct pattern. Headless is the default; set `BROWSER_HEADLESS=false` only for local debugging. This avoids accidental production window-opens from a committed `.env`.
  - **Rejected**: Always headless with no toggle — too hard to debug SSO issues without a visible window.
- **Startup log to stderr**: Log `[BrowserSession] headless: true/false` once at launch. Goes to stderr (not stdout) to avoid polluting MCP protocol messages.
- **No Jira PAT**: User explicitly chose to keep using SSO cookie reuse via Chrome profile rather than setting up a Personal Access Token. This matches the existing Outlook approach.

## What Will Be Built

### `src/connectors/browser-session.ts` (edit)

Current line 41:
```ts
headless: process.env.BROWSER_HEADLESS !== 'false'
```
This is already correct. **No functional change needed.**

Add startup log in `BrowserSessionManager.launch()`:
```ts
process.stderr.write(
  `[BrowserSession] Launching browser: headless=${this.config.headless}, profile=${this.config.profilePath}\n`
);
```

### `.env.example` (edit)

Add:
```bash
# Browser automation (required for Jira, Outlook, Teams scraping)
BROWSER_PROFILE_PATH=/path/to/chrome/profile   # chrome://version → "Profile Path"
BROWSER_HEADLESS=true                           # default; set to 'false' only for local debugging
BROWSER_EXECUTABLE=                             # optional: custom Chrome binary path
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-17-1 | Audit: `grep -r 'headless: false' src/` — fix any hardcoded values — **File:** `src/connectors/browser-session.ts` | 🔲 TODO |
| EP-17-2 | Add startup log in `BrowserSessionManager.launch()` — **File:** `src/connectors/browser-session.ts` | 🔲 TODO |
| EP-17-3 | Document `BROWSER_HEADLESS` in `.env.example` and `CLAUDE.md` | 🔲 TODO |

## Acceptance Criteria

- [ ] `grep -r 'headless: false' src/` returns zero results
- [ ] Starting `web-server.js` and triggering a browser request logs `[BrowserSession] headless: true`
- [ ] `.env.example` contains `BROWSER_HEADLESS=true` with explanation comment
- [ ] `npm run typecheck` passes with zero errors

## Sample Usage

```bash
# Verify headless mode in logs
node --env-file=.env web-server.js 2>&1 | grep BrowserSession
# Should print: [BrowserSession] Launching browser: headless=true, profile=/path/to/profile

# Override for debugging
BROWSER_HEADLESS=false node --env-file=.env web-server.js
# Chrome window will open visibly — useful for debugging SSO issues
```
