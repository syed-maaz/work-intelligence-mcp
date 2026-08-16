---
title: "BUG-13: Concurrent browser navigation"
sidebar_label: "BUG-13: Concurrent navigation"
---

# BUG-13: `search_all` concurrent browser navigation corrupts page state

| | |
|---|---|
| **Severity** | 🔴 Breaking |
| **Status** | 📋 Tracked (EP-14-5) |
| **File** | `src/tools/search-all.ts:176, 191` |
| **Discovered** | April 2026 technical audit |

## Description

`search_all` instantiates a fresh connector on every call:

```typescript
// Before — new connectors on every call
const connector = new OutlookBrowserConnector(session);
// ...
const connector = new JiraBrowserConnector(session);
```

`BrowserSessionManager` (`session`) is a singleton — there is one shared browser context. However, `OutlookBrowserConnector` and `JiraBrowserConnector` each maintain their own rate-limit state (`requestTimestamps` array) and do not know about each other's in-flight navigations.

## Failure Scenario

Two near-simultaneous `search_all` calls:

1. **Call A** gets a connector, navigates the shared browser page to `outlook.office.com/inbox`
2. **Call B** gets a different connector instance (same underlying page), navigates to `jira.example.com`
3. **Call A** tries to read email list from the page that is now showing Jira
4. Playwright selectors fail — `$('#inbox-list')` not found on a Jira page
5. Both calls throw or return empty results

The two connector instances share one browser page but have completely independent navigation state. There is no lock or coordination.

## Impact

Any scenario where `search_all` is called concurrently (e.g., two Claude Desktop conversations, a tool called from two places) will corrupt the browser session. One call will fail silently with empty results; the other may get mixed content.

## Root Cause

The `BrowserSessionManager` returns pages but does not serialize access to them. Browser connectors are designed as stateless factories, but the underlying Playwright page is stateful.

## Fix Plan (EP-14-5)

A 2-slot browser pool in `BrowserSessionManager`:

```typescript
// EP-14-5 design
class BrowserSessionManager {
  private pool: Array<{ page: Page; inUse: boolean }> = [];
  private readonly maxSlots = Number(process.env.BROWSER_MAX_SLOTS) || 2;

  async acquirePage(url: string): Promise<Page> {
    // Wait for a free slot, navigate, return locked page
  }

  releasePage(page: Page): void {
    // Mark slot as available
  }
}
```

Until EP-14-5, `search_all` serializes Outlook and Jira fetches (already the case in the current implementation — they run `await fetchOutlook(...)` then `await fetchJira(...)` sequentially, not in parallel). The risk is only with concurrent `search_all` calls from different MCP client sessions.

## Tracking

Fix planned in [EP-14-5](../epics/ep14-smart-topic-expert#ep-14-5----browser-session-pool-2-slot).
