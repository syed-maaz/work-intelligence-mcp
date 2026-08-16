---
title: "EP-20: Saturn Board Dashboard Section"
sidebar_label: "EP-20: Saturn Board"
---

# EP-20: Saturn Board Dashboard Section

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Agent Role** | Web UI / Integration Engineer |
| **Depends On** | [EP-17](./ep17-headless-browser) |
| **Blocks** | [EP-23](./ep23-daily-summary) |
| **File Scope** | `src/tools/saturn-board.ts` (new), `web-server.js` (edit), `web/src/lib/api.ts` (edit), `web/src/components/shared/SaturnBoardSection.tsx` (new), `web/src/pages/DashboardPage.tsx` (edit), `web/src/pages/JiraReportPage.tsx` (consumes same cache) |

## Goal

Show the Saturn Jira board issues directly on the Dashboard front page so the user sees team status at a glance without opening Jira. The user said: "It should show me what is happening in my team so there should be section called Saturn Update which shows me only Saturn issues and update."

## Key URL

```
https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=BDS
```

`convertRapidBoardToNavigatorUrl()` in `jira-browser.ts` already handles converting this RapidBoard URL to issue navigator format — no new URL logic needed.

## Decisions Made

- **In-memory cache (10-min TTL), not DB**: Saturn issues are ephemeral board state, not messages to analyze. Storing in a separate table adds migration complexity for no benefit. The cache survives for the life of the `web-server.js` process.
  - **Rejected**: Storing in `messages` table — issues are already there from `jira-report.ts` syncs; duplicate storage without a clear read path.
- **Background refresh on cache miss**: On first call (cold cache), `await` the fetch synchronously. On subsequent calls with stale cache, return stale data immediately AND kick off a background refresh — so the user never waits.
  - **Rejected**: Always blocking — would make the Dashboard load slow on every page refresh.
- **Map `UnifiedMessage` metadata → `SaturnIssue`**: `JiraBrowserConnector.fetchMessages()` returns `UnifiedMessage[]`. The Jira metadata block already contains `key`, `status`, `assignee`, `priority`, `updatedAt`. No new scraping logic needed.
- **`BROWSER_PROFILE_PATH` guard**: If browser not configured, return `{ issues: [], error: 'browser_not_configured' }` — never crash. UI shows an amber warning.

## What Will Be Built

### `src/tools/saturn-board.ts` (new)

```ts
export interface SaturnIssue {
  key: string;           // 'PROJ-15057'
  title: string;
  status: string;        // 'In Progress' | 'Blocked' | 'Todo' | 'Done' | raw string
  assignee: string | null;
  priority: string | null;
  updatedAt: string;     // ISO datetime
  url: string;           // 'https://jira.example.com/browse/PROJ-15057'
}

const SATURN_BOARD_URL = process.env.SATURN_BOARD_URL
  ?? 'https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=BDS';

export async function getSaturnIssues(
  session: BrowserSessionManager
): Promise<SaturnIssue[]>
// Calls JiraBrowserConnector.fetchMessages({ boardUrl: SATURN_BOARD_URL })
// Maps each UnifiedMessage to SaturnIssue using message.metadata.jira
// Reuses normalizeStatus() — extract to src/tools/jira-utils.ts if not already shared
```

### `web-server.js` (edit)

Add near top (after `const db = getDatabase()`):
```js
const saturnCache = { data: [], fetchedAt: 0 };

async function refreshSaturnCache() {
  try {
    const session = getBrowserSession();
    const { getSaturnIssues } = await import('./dist/tools/saturn-board.js');
    saturnCache.data = await getSaturnIssues(session);
    saturnCache.fetchedAt = Date.now();
  } catch (err) {
    process.stderr.write('[Saturn] Cache refresh failed: ' + err.message + '\n');
  }
}
```

New endpoint:
```
GET /api/saturn/issues?refresh=true
```

Logic:
```js
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const age = Date.now() - saturnCache.fetchedAt;
const forceRefresh = url.searchParams.get('refresh') === 'true';

if (!process.env.BROWSER_PROFILE_PATH) {
  json(res, 200, { issues: [], error: 'browser_not_configured' });
  return;
}

if (saturnCache.fetchedAt === 0) {
  // Cold start — block until we have data
  await refreshSaturnCache();
} else if (age > CACHE_TTL_MS || forceRefresh) {
  // Stale — return current data, refresh in background
  refreshSaturnCache(); // fire-and-forget
}

json(res, 200, { issues: saturnCache.data, cachedAt: new Date(saturnCache.fetchedAt).toISOString() });
```

### `web/src/components/shared/SaturnBoardSection.tsx` (new)

```tsx
// Status → Badge variant mapping
const statusVariant = (s: string) => {
  const n = s.toLowerCase();
  if (n.includes('block')) return 'danger';
  if (n.includes('progress')) return 'info';
  if (n.includes('done') || n.includes('complete')) return 'success';
  return 'default';
};

// Renders:
// - Card header: "Saturn Board" + issue count Badge + Refresh button (RefreshCw icon)
// - Table: key (linked to Jira), title (truncate 60), status Badge, assignee, formatRelative(updatedAt)
// - Loading: 4 × SkeletonRow
// - Error 'browser_not_configured': amber warning card
// useQuery key: ['saturn-issues']
// refetchInterval: 600_000 (10 min)
// Refresh button: invalidateQueries + adds ?refresh=true to URL
```

### `web/src/lib/api.ts` (edit)

```ts
export interface SaturnIssue {
  key: string; title: string; status: string;
  assignee: string | null; priority: string | null;
  updatedAt: string; url: string;
}

saturnIssues: (opts?: { refresh?: boolean }) =>
  request<{ issues: SaturnIssue[]; cachedAt?: string; error?: string }>(
    `/saturn/issues${opts?.refresh ? '?refresh=true' : ''}`
  )
```

## Environment Variables

```bash
SATURN_BOARD_URL=https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=BDS
# optional override; hardcoded default used if unset
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-20-1 | Extract `normalizeStatus()` to `src/tools/jira-utils.ts` if not already shared — **File:** `src/tools/jira-report.ts` | 🔲 TODO |
| EP-20-2 | Create `getSaturnIssues()` tool — **File:** `src/tools/saturn-board.ts` | 🔲 TODO |
| EP-20-3 | Add `saturnCache` + `refreshSaturnCache()` + `GET /api/saturn/issues` — **File:** `web-server.js` | 🔲 TODO |
| EP-20-4 | Add `SaturnIssue` type + `api.saturnIssues()` — **File:** `web/src/lib/api.ts` | 🔲 TODO |
| EP-20-5 | Build `SaturnBoardSection` component — **File:** `web/src/components/shared/SaturnBoardSection.tsx` | 🔲 TODO |
| EP-20-6 | Add `<SaturnBoardSection />` below stats row — **File:** `web/src/pages/DashboardPage.tsx` | 🔲 TODO |

## Acceptance Criteria

- [ ] `GET /api/saturn/issues` returns `SaturnIssue[]` from the Saturn RapidBoard
- [ ] Response is cached; second call within 10 min returns `cachedAt` and does not open a new browser
- [ ] Background refresh fires when cache is stale (no blocking)
- [ ] `SaturnBoardSection` renders with correct status Badge colors on Dashboard
- [ ] Graceful `browser_not_configured` warning shown if `BROWSER_PROFILE_PATH` not set
- [ ] Refresh button triggers background re-fetch and invalidates query
- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` compiles cleanly

## Sample Usage

```bash
# First call — fetches from Jira (may take 30-60s on cold start)
curl http://localhost:3132/api/saturn/issues
# → { issues: [{ key: "PROJ-15057", title: "...", status: "In Progress", ... }], cachedAt: "..." }

# Subsequent calls — instant from cache
curl http://localhost:3132/api/saturn/issues
# → same data, same cachedAt

# Force refresh
curl "http://localhost:3132/api/saturn/issues?refresh=true"
# → returns current cache immediately, triggers background refresh
```
