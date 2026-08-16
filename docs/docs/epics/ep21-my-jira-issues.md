---
title: "EP-21: My Jira Issues (Assigned to Me)"
sidebar_label: "EP-21: My Jira Issues"
---

# EP-21: My Jira Issues (Assigned to Me)

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Agent Role** | Web UI / Integration Engineer |
| **Depends On** | [EP-17](./ep17-headless-browser) |
| **Blocks** | — |
| **File Scope** | `web-server.js` (edit), `web/src/lib/api.ts` (edit), `web/src/components/shared/MyIssuesSection.tsx` (new), `web/src/pages/DashboardPage.tsx` (edit) |

## Goal

Show the user's personally assigned Jira issues on the Dashboard using the standard Jira "assigned to me" filter. The user said: "This is the link for the ticket or issues assigned to me: `https://jira.example.com/issues/?filter=-1`".

## Key URL

```
https://jira.example.com/issues/?filter=-1
```

`filter=-1` is Jira's built-in magic filter for "assigned to the current logged-in user". This is already a valid issue navigator URL — `convertRapidBoardToNavigatorUrl()` in `jira-browser.ts` passes non-RapidBoard URLs through unchanged (line 81: `return rawUrl`). No new URL conversion logic needed.

## Decisions Made

- **5-min TTL cache (vs 10-min for Saturn)**: Personal issue queue changes more frequently — assignee adds/removes, status updates from your own work. 5 minutes is a reasonable balance.
  - **Rejected**: Same 10-min TTL as Saturn — too stale for personal queue.
- **Limit 1 page (50 issues)**: The `filter=-1` list could have hundreds of issues across all projects. The dashboard card shows only the most recent 50 (1 pagination page). "View all in Jira" link handles the rest.
  - **Rejected**: Fetching all pages — too slow for a dashboard card, usually >100 issues.
- **Reuse `SaturnIssue` type**: My issues and Saturn issues have identical shape. No new type needed.
- **Auth expired handling**: If `ConnectorError(Authentication)` is thrown (SSO session expired), return `{ issues: [], error: 'auth_expired' }` — UI shows "Jira session expired — re-open Jira in browser".

## What Will Be Built

### `web-server.js` (edit)

Add near top:
```js
const myIssuesCache = { data: [], fetchedAt: 0 };
const MY_ISSUES_URL = 'https://jira.example.com/issues/?filter=-1';
const MY_ISSUES_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function refreshMyIssuesCache() {
  try {
    const session = getBrowserSession();
    const { JiraBrowserConnector } = await import('./dist/connectors/jira-browser.js');
    const connector = new JiraBrowserConnector();
    const messages = await connector.fetchMessages(
      { boardUrl: MY_ISSUES_URL },
      undefined,        // no 'since' filter
      { maxPages: 1 }   // limit to 50 issues
    );
    myIssuesCache.data = messages.map(m => ({
      key: m.metadata?.jira?.key ?? m.sourceId,
      title: m.subject ?? m.content.slice(0, 80),
      status: m.metadata?.jira?.status ?? 'Unknown',
      assignee: m.metadata?.jira?.assignee ?? null,
      priority: m.metadata?.jira?.priority ?? null,
      updatedAt: m.createdAt.toISOString(),
      url: `https://jira.example.com/browse/${m.metadata?.jira?.key}`,
    }));
    myIssuesCache.fetchedAt = Date.now();
  } catch (err) {
    if (err.message?.includes('Authentication')) {
      myIssuesCache.authExpired = true;
    }
    process.stderr.write('[MyIssues] Cache refresh failed: ' + err.message + '\n');
  }
}
```

New endpoint:
```
GET /api/jira/my-issues?refresh=true
```

Logic mirrors Saturn endpoint — cold start blocks, stale returns immediately + background refresh.
Returns `{ issues: SaturnIssue[], error?: 'browser_not_configured' | 'auth_expired', cachedAt?: string }`.

### `web/src/components/shared/MyIssuesSection.tsx` (new)

```tsx
// Priority color dot mapping
const priorityColor = (p: string | null) => {
  if (!p) return '#6b7280';
  const l = p.toLowerCase();
  if (l.includes('blocker') || l.includes('critical')) return '#ef4444';
  if (l.includes('major')) return '#f97316';
  if (l.includes('normal') || l.includes('medium')) return '#eab308';
  return '#6b7280';
};

// Renders:
// - Card header: "Assigned to Me" (User icon) + issue count Badge + Refresh button
// - Table rows: priority dot, key (Jira link), title (truncated 60), status Badge, formatRelative(updatedAt)
// - "View all in Jira →" link at bottom (opens https://jira.example.com/issues/?filter=-1)
// - Error 'auth_expired': amber warning "Jira session expired — re-open Jira in your browser"
// - Error 'browser_not_configured': amber warning
// useQuery key: ['my-issues']
// refetchInterval: 300_000 (5 min)
```

### `web/src/lib/api.ts` (edit)

```ts
// Reuses SaturnIssue type from EP-20

myIssues: (opts?: { refresh?: boolean }) =>
  request<{ issues: SaturnIssue[]; error?: string; cachedAt?: string }>(
    `/jira/my-issues${opts?.refresh ? '?refresh=true' : ''}`
  )
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-21-1 | Add `myIssuesCache` + `refreshMyIssuesCache()` + `GET /api/jira/my-issues` — **File:** `web-server.js` | 🔲 TODO |
| EP-21-2 | Add `api.myIssues()` — **File:** `web/src/lib/api.ts` | 🔲 TODO |
| EP-21-3 | Build `MyIssuesSection` component with priority dots — **File:** `web/src/components/shared/MyIssuesSection.tsx` | 🔲 TODO |
| EP-21-4 | Add `<MyIssuesSection />` alongside Saturn section — **File:** `web/src/pages/DashboardPage.tsx` | 🔲 TODO |

## Acceptance Criteria

- [ ] `GET /api/jira/my-issues` returns issues from `filter=-1` (the current user's assigned issues)
- [ ] Response cached for 5 minutes; stale-while-revalidate pattern works
- [ ] Auth expired error surfaces correctly in UI
- [ ] `MyIssuesSection` renders with priority color dots
- [ ] "View all in Jira" link opens the correct URL in a new tab
- [ ] Graceful empty state when no issues assigned
- [ ] `npm run typecheck` passes with zero errors

## Sample Usage

```bash
curl http://localhost:3132/api/jira/my-issues
# → { issues: [{ key: "PROJ-15042", title: "Fix token refresh", status: "In Progress", priority: "Major", ... }] }

# If browser not configured:
# → { issues: [], error: "browser_not_configured" }

# If SSO expired:
# → { issues: [], error: "auth_expired" }
```
