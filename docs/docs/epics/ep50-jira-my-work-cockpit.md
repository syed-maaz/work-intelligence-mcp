---
sidebar_position: 50
title: EP-50 Jira My Work Cockpit (Sprint 9)
---

# EP-50: Jira My Work Cockpit — Redesign

| Field | Value |
|-------|-------|
| **Status** | ✅ Done |
| **Priority** | High |
| **Agent Role** | Senior Frontend + Senior Backend |
| **Sprint** | 9 |
| **Created** | 2026-04-20 |
| **Depends On** | EP-46 ✅ (Jira MCP adapter), EP-49 ✅ (data_source column, isRefreshing fix) |
| **Blocks** | — |
| **File Scope** | `web/src/pages/JiraReportPage.tsx` (full rewrite), `web-server.js` (new endpoint + JQL fetch), `src/connectors/jira-adapter.ts` (sprint classification), `web/src/lib/api.ts` (new types), `src/db/schema.ts` (sprint_name column) |

---

## Context & Problem

The current Jira page (`JiraReportPage.tsx`) has fundamental problems that make it useless as a daily work tool:

### Root cause audit (2026-04-20)

1. **Sprint detection is a heuristic lie.** `isInSprint()` guesses sprint membership by checking whether a status string is NOT in a blocklist of "done-ish" words (`done`, `closed`, `open`, `to do`, etc). This has no connection to Jira sprint data. It classifies "Open" (which is IN the current sprint) as backlog.

2. **No real sprint metadata.** The MCP `jira_search` fields list never included `customfield_10020` (the sprint field). Even if it had, the  Jira MCP strips that field from responses — it is not returned. Sprint membership must be determined by **JQL queries** (`sprint in openSprints()`), not field values.

3. **Wrong scope.** The page fetches all 141 BDS tickets, not your tickets. The default view should be **your assigned tickets** — that's what a developer actually wants to see day-to-day.


5. **No sprint label.** Even when sprint membership is correct, no sprint name/dates are shown anywhere. The user has no idea if they're looking at Saturn-93 or some cached stale board.

6. **Two-column layout is wrong.** The current `Current Sprint | Backlog` split is derived from the broken heuristic. Even if the heuristic worked, it's not useful — the developer's real mental model is **My tickets** (where am I?), **Sprint** (what's the team working on?), **All** (full board).

7. **Detail is inaccessible.** Clicking a ticket only expands an analysis card inline. The full description, comments, and linked issues require a separate Jira browser tab. A master-detail layout keeps the developer in the tool.

### Confirmed data model from live MCP testing

```
Sprint membership determined by JQL only:
  sprint in openSprints()                     → Saturn-93 (141 tickets)

customfield_10020 (sprint field) → NOT returned by jira_search ( MCP strips it)
currentUser() JQL → returns 0 results (OAuth context not resolved by  MCP)
```

---

## Goal

Redesign the Jira page into a **My Work Cockpit**: a focused, accurate, developer-centric view that answers "what am I working on and where does it stand?" in real time using proper JQL queries against the MCP.

---

## Design Decision

### Layout: Master-Detail (List + Detail Panel)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Jira  ·  Saturn-93  ·  Apr 20 – May 2  ·  141 tickets total        │
│  [Mine 13]  [Sprint 141]  [All]        [● MCP]  [Refresh]           │
├──────────────────────────┬──────────────────────────────────────────┤
│  ● PROJ-15257  HIGH       │  PROJ-15257                                │
│  BIS recommended links…  │  [Customer Incident] BIS doesn't show... │
│  Open  ·  ★ Sprint       │                                           │
│  ─────────────────────── │  Bug · High · Open                        │
│  ● PROJ-15222  MEDIUM     │  Sprint: Saturn-93  ·  Assignee: You      │
│  Pre-login KBA Viewer    │  Updated: 2h ago · via MCP                │
│  Open  ·  ★ Sprint       │  ─────────────────────────────────────── │
│  ─────────────────────── │  Description                              │
│  ● PROJ-14920  MEDIUM     │  Customer states that their automated...  │
│  Implement E2E KBA       │                                           │
│  Open  ·  ★ Sprint       │  Comments (2)                             │
│  ─────────────────────── │  ↳ Pai, Venkatesh · 1h ago                │
│  ○ PROJ-14654  MEDIUM     │    Could someone from Saturn look at this │
│  Research: KBA Media     │  ↳ Mourabiti, Ziyad · 2h ago              │
│  ─────────────────────── │  ─────────────────────────────────────── │
│  ○ PROJ-12345  LOW        │  [⚡ Analyze]  [📖 Mark Learned]           │
│  Tooltip layout fix      │  ─────────────────────────────────────── │
│  To Do  ·  ─ No Sprint   │  Analysis | Effort | Explanation |        │
│                          │  Solution | Code Impact                   │
│                          │  ─────────────────────────────────────── │
│                          │  [AI content rendered here]               │
└──────────────────────────┴──────────────────────────────────────────┘
```

**Left panel** (fixed ~340px, scrollable):
- Compact ticket rows: priority color bar + key + title + status badge + sprint tag
- Sprint tags: `★ Sprint` (current), `◇ Backlog`, `↩ Sprint-92` (closed sprint), `─ No Sprint`
- Assignee shown for Sprint/All tabs (hidden for Mine since it's always you)
- Selected ticket highlighted with accent left border

**Right panel** (flex-1, scrollable):
- Full ticket detail: title, metadata row, description, comments
- Action buttons: Analyze, Mark as Learned, Draft PR
- Inline analysis tabs below (existing AnalysisCard component reused)

### Three Tabs

| Tab | JQL | When to use |
|-----|-----|-------------|
| **Sprint** | `project = BDS AND sprint in openSprints() ORDER BY assignee ASC, priority ASC` | Full team sprint board — 141 tickets |
| **All** | `project = BDS AND updated >= -30d ORDER BY updated DESC` | Recent BDS activity |

### Sprint Classification per Ticket

Since `customfield_10020` is not returned, sprint context is determined at **fetch time** by which JQL query returned the ticket:

```
Fetched via `sprint in openSprints()`       → sprintContext = 'current_sprint', sprintName = 'Saturn-93'
Fetched via `sprint in closedSprints()`     → sprintContext = 'closed_sprint',  sprintName = (sprint N)
Not in any sprint JQL                       → sprintContext = 'backlog'
statusCategory = Done and in closed sprint  → sprintContext = 'closed_sprint' (done)
```

For the Mine tab: run two parallel queries — one with `AND sprint in openSprints()`, one for the rest. Tag each accordingly.

### Sprint Header Banner

```
Saturn-93  ·  Apr 20 – May 2  ·  141 tickets  ·  13 unassigned
```

- Sprint name stored in memory after first successful fetch (`saturnSprintName` in-memory cache)
- Sprint dates: stored from first `jira_search` response (use `updated` range as proxy, or store manually after first observation)
- Hardcode `Saturn-93` detection from ticket's sprint context on first successful open-sprint fetch

---

## Decisions Made

### D1: JQL-only sprint detection — no field parsing

**Decision**: Sprint membership is determined exclusively by which JQL query a ticket was returned in (`sprint in openSprints()`), not by parsing any field on the ticket object.

**Why**: `customfield_10020` is not returned by the  Jira MCP. Status-based heuristics (current approach) are wrong — "Open" in Jira means a ticket is in the sprint backlog, not that it's uninitiated. JQL is the authoritative source.

**Impact**: Every fetch that needs sprint classification runs 2 parallel `jira_search` calls (sprint + non-sprint). This is acceptable at ~50ms each via the MCP.

### D2: JIRA_MY_USERNAME stored in .env


**Why**: The MCP OAuth token authenticates the app, not the user. `currentUser()` is a Jira server-side resolution that requires a user session cookie, not a bearer token. Storing the username in env is explicit, transparent, and doesn't require a DB migration.

**Rejected**: Extracting username from the MCP token claims — the token is opaque and we don't control its JWT structure. Storing in DB — adds a settings UI + migration for what is effectively a one-line env var.

**New env var**: `JIRA_MY_USERNAME` (required for Mine tab). Falls back to `''` which disables the Mine tab with an error message.

### D3: Master-detail layout (list + side panel, not inline expand)

**Decision**: Clicking a ticket opens a right-side detail panel. The left list stays visible. The current "expand inline below the row" pattern is replaced.

**Why**: The inline expand pushes all other tickets out of view. With 13+ tickets in Mine view, the developer needs to scan the list while reading a ticket detail. The master-detail pattern (like VS Code's file explorer + editor) is the standard for this use case.

**Rejected**: Full-screen modal per ticket — loses list context entirely.
**Rejected**: Keep inline expand — bad for scan + compare workflow.

### D4: New dedicated endpoint `GET /api/jira/board`

**Decision**: Replace `/api/saturn/issues` with a new `/api/jira/board` endpoint that:
1. Accepts `?tab=mine|sprint|all` and `?refresh=true`
2. Returns `{ sprint: { name, start, end, total }, issues: EnhancedIssue[], cachedAt, isRefreshing, dataSource }`
3. Stores `JIRA_MY_USERNAME` from env; returns `{ missingConfig: true }` when absent
4. Each issue has `sprintContext: 'current_sprint' | 'closed_sprint' | 'backlog' | 'no_sprint'` and `sprintName: string | null`

**Why**: The existing `/api/saturn/issues` is tightly coupled to the old heuristic model. A clean new endpoint avoids entangling new JQL logic with the existing cache + browser mutex code. The old endpoint stays in place for the dashboard's `SaturnBoardSection` widget.

### D5: Detail panel fetches full ticket on demand via `jira_get_issue`

**Decision**: The list fetch (`jira_search`) returns summary data. When the user selects a ticket, the right panel fires `GET /api/jira/ticket/:key` (already implemented in EP-49-10) which calls `jira_get_issue` for the full description and comments.

**Why**: `jira_search` doesn't return description or comments. Fetching full details for 141 tickets upfront is wasteful. On-demand fetch per click is fast (\<200ms MCP call) and keeps the list fetch lightweight.

### D6: Sprint name stored in in-memory cache after first fetch

**Decision**: After the first successful `sprint in openSprints()` query, store the sprint name in a module-level `sprintMeta` variable `{ name: 'Saturn-93', start: '2026-04-20', end: '2026-05-02', total: 141 }`. Derive name from the first returned issue's sprint context (use a hardcoded pattern `project = BDS AND sprint in openSprints()` count from `total` field).

**Why**: The MCP doesn't return `customfield_10020`. Sprint name is not in the response. However, we know from `claude -p` query that the sprint is `Saturn-93`. After observing this, store it. In production, use the `total` count from the open sprint query — if we ever see this differ significantly, it signals a sprint boundary.

**Future**: When/if the  Jira MCP adds `customfield_10020` to returned fields, switch to reading it directly.

---

## What Will Be Built

### EP-50-1: New `GET /api/jira/board` endpoint

**File**: `web-server.js`

```js
GET /api/jira/board?tab=mine|sprint|all&refresh=true|false

Response:
{
  sprint: { name: 'Saturn-93', start: '2026-04-20', end: '2026-05-02', total: 141 } | null,
  issues: EnhancedIssue[],
  cachedAt: string | null,
  isRefreshing: boolean,
  dataSource: 'mcp' | 'browser' | 'unknown',
  missingConfig?: true  // when JIRA_MY_USERNAME not set and tab=mine
}
```

**JQL per tab**:
- `mine`: Two parallel calls: `(1) project = BDS AND assignee = ${username} AND sprint in openSprints()` + `(2) project = BDS AND assignee = ${username} AND statusCategory != Done AND sprint not in openSprints()`. Merge, tag sprintContext.
- `sprint`: `project = BDS AND sprint in openSprints() ORDER BY assignee ASC, priority ASC` (paginated, up to 200)
- `all`: `project = BDS AND updated >= -30d ORDER BY updated DESC` (up to 100)

**EnhancedIssue** (extends existing `SaturnIssue`):
```ts
interface EnhancedIssue extends SaturnIssue {
  sprintContext: 'current_sprint' | 'closed_sprint' | 'backlog' | 'no_sprint';
  sprintName: string | null;
  issueType: string | null;  // Bug, Story, Task, Backlog Item...
  labels: string[];
}
```

**Caching**: Separate cache per tab (`boardCache.mine`, `boardCache.sprint`, `boardCache.all`), each with `isRefreshing` + `lastFailedAt` + `refreshStartedAt`. TTL: 5 min (mine), 10 min (sprint), 30 min (all).

### EP-50-2: Rebuild `JiraReportPage.tsx` — master-detail layout

**File**: `web/src/pages/JiraReportPage.tsx`

Remove:
- `IssueColumn` component (two-column layout)
- `EpicGroup` / `EpicGroupedList` components (epic grouping — Sprint tab will sort by assignee instead)
- `isInSprint()` heuristic function
- `DONE_STATUSES` array
- `sprintFiltered` / `backlogFiltered` derived arrays

Add:
- `TicketList` component — left panel, compact rows with sprint tag badges
- `TicketDetail` component — right panel, full metadata + description + comments + analysis
- `SprintBanner` component — header strip showing sprint name/dates/total
- `MissingConfigBanner` component — shown when `JIRA_MY_USERNAME` not set
- Three-tab switcher: Mine / Sprint / All
- `selectedKey` state — which ticket is selected (click → load detail)

**Sprint tag variants:**
```tsx
const sprintTag = {
  current_sprint: { icon: '★', label: 'Sprint', color: 'var(--accent)', bg: 'rgba(99,102,241,0.1)' },
  closed_sprint:  { icon: '↩', label: sprintName ?? 'Past Sprint', color: '#6b7280', bg: 'var(--bg-3)' },
  backlog:        { icon: '◇', label: 'Backlog', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)' },
  no_sprint:      { icon: '─', label: 'No Sprint', color: 'var(--muted)', bg: 'var(--bg-3)' },
};
```

### EP-50-3: Update `src/connectors/jira-adapter.ts` — return `issueType` + `labels`

The `JiraMcpAdapter.issueToMessage()` already has `f.issuetype` and `f.labels` but they're not exposed in the metadata. Add them:
```ts
metadata.jira.issueType = f.issuetype?.name ?? undefined;
metadata.jira.labels = f.labels ?? [];
```

Update `SaturnIssue` interface in `src/tools/saturn-board.ts` and `EnhancedIssue` in `web/src/lib/api.ts`.

### EP-50-4: `GET /api/jira/ticket/:key` — return description + comments

Already implemented in EP-49-10 but only returns `{ key, title, status, assignee, description, url }`. Extend to include:
```ts
{
  key, title, status, assignee, description, url,
  comments: Array<{ author: string; body: string; created: string }>,
  issueType: string | null,
  priority: string | null,
  labels: string[],
  reporter: string | null,
}
```

The `jira_get_issue` tool already returns all of this (confirmed from live test).

### EP-50-5: Update `web/src/lib/api.ts` — new types + board endpoint

```ts
interface EnhancedIssue {
  key: string; title: string; status: string;
  assignee: string | null; priority: string | null;
  epicKey: string | null; epicName: string | null;
  issueType: string | null; labels: string[];
  updatedAt: string; url: string;
  sprintContext: 'current_sprint' | 'closed_sprint' | 'backlog' | 'no_sprint';
  sprintName: string | null;
  similarLearning?: { summary: string; solution: string } | null;
}

interface SprintMeta {
  name: string;
  start: string | null;
  end: string | null;
  total: number;
}

interface JiraBoardResponse {
  sprint: SprintMeta | null;
  issues: EnhancedIssue[];
  cachedAt: string | null;
  isRefreshing: boolean;
  dataSource: string;
  missingConfig?: boolean;
}

interface TicketDetail {
  key: string; title: string; status: string;
  assignee: string | null; reporter: string | null;
  priority: string | null; issueType: string | null;
  labels: string[]; description: string | null; url: string;
  comments: Array<{ author: string; body: string; created: string }>;
}

// api.ts additions
jiraBoard(tab: 'mine' | 'sprint' | 'all', refresh?: boolean): Promise<JiraBoardResponse>
getTicketDetail(key: string): Promise<TicketDetail>
```

### EP-50-6: MCP reconnect guidance

When `GET /api/jira/mcp-status` returns `connected: false` **and** the board is empty, show an actionable reconnect panel (not just a warning banner):

```
┌─────────────────────────────────────────────────────────┐
│  ⚠️ Jira MCP is not connected                           │
│                                                         │
│  Your Jira data cannot be fetched. To reconnect:        │
│  1. Open a terminal                                     │
│  2. Run:                                                │
│     npm run mcp-setup -- --name jira \              │
│       --url https://mcp.jira.example.com/mcp             │
│  3. Complete the browser authentication                 │
│  4. Click Retry below                                   │
│                                     [Retry connection]  │
└─────────────────────────────────────────────────────────┘
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JIRA_SOURCE` | No | `auto` | `mcp \| browser \| auto`. Mine tab always uses MCP when available. |
| `SATURN_BOARD_URL` | No | `https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=BDS` | Existing — unchanged. |

---

## Schema Changes

**Migration 29** (`src/db/schema.ts`): Add `sprint_name TEXT` column to `jira_issues` table.

```sql
ALTER TABLE jira_issues ADD COLUMN sprint_name TEXT DEFAULT NULL;
ALTER TABLE jira_issues ADD COLUMN sprint_context TEXT DEFAULT 'no_sprint';
-- values: 'current_sprint' | 'closed_sprint' | 'backlog' | 'no_sprint'
```

This lets the dashboard `SaturnBoardSection` widget also show sprint context without re-fetching.

---

## Tickets

| ID | Title | Status | Files |
|----|-------|--------|-------|
| EP-50-1 | New `GET /api/jira/board` endpoint — JQL-based, 3 tabs, sprint classification | ✅ Done | `web-server.js` |
| EP-50-2 | Rebuild `JiraReportPage.tsx` — master-detail, 3 tabs, sprint tags | ✅ Done | `web/src/pages/JiraReportPage.tsx` |
| EP-50-3 | Expose `issueType` + `labels` from jira-adapter | ✅ Done | `src/connectors/jira-adapter.ts`, `src/tools/saturn-board.ts` |
| EP-50-4 | Extend `GET /api/jira/ticket/:key` — add comments, issueType, priority, labels, reporter | ✅ Done | `web-server.js` |
| EP-50-5 | Update `api.ts` — new types, `jiraBoard()`, `getTicketDetail()` | ✅ Done | `web/src/lib/api.ts` |
| EP-50-6 | MCP reconnect guidance panel — actionable instructions + retry | ✅ Done | `web/src/pages/JiraReportPage.tsx` |
| EP-50-7 | Auto-import Sprint teammates — add all assignees in current sprint as team members | ✅ Done | `web-server.js`, `src/db/queries/teammates.ts` |

---

## EP-50-7: Auto-import Sprint Teammates

When the Sprint tab loads (or on Refresh), parse the `assignee` field from all `sprint in openSprints()` results. For each unique assignee:
- If not already in `team_members` table → `INSERT OR IGNORE` with `name = display_name`, `jira_username = name (I-number)`
- Mark `marked = 0` by default (visible in Teammates page but profile not yet built)
- Log to `ingestion_log`: `source='jira_sprint_sync', records_fetched=N, records_inserted=M`

**Trigger**: Runs automatically after every successful Sprint tab fetch (background, non-blocking).

**UI**: After sprint load, if new teammates were discovered, show a dismissible toast:
```
✓ 3 new teammates discovered from Saturn-93. View in Teammates →
```

**Why**: The developer's team is whoever is in the current sprint. Manual discovery in the Teammates page (EP-45) requires the user to know names in advance. Sprint sync makes team membership automatic and accurate.

**Decision**: `marked = 0` not `marked = 1` — auto-import means "known person", not "build full profile". Profile building (Sonnet analysis) is triggered separately via the Teammates page → "Mark" toggle. This avoids expensive AI calls on every sprint sync.

**Deduplication**: `INSERT OR IGNORE INTO team_members (name, jira_username) VALUES (?, ?)` — UNIQUE constraint on `name` prevents duplicates.

---

## Acceptance Criteria

- [x] Mine tab shows only tickets assigned to `JIRA_MY_USERNAME`, classified by sprint context (current sprint / closed sprint / backlog / no sprint)
- [x] Sprint tab shows all 141 Saturn-93 tickets, sorted by assignee then priority — sprint membership determined by JQL, not status heuristic
- [x] All tab shows recent BDS activity (30d), with sprint tags on each row
- [x] Sprint banner correctly shows "Saturn-93 · Apr 20 – May 2 · 141 tickets"
- [x] Each ticket in the list shows a sprint tag: `★ Sprint`, `◇ Backlog`, `↩ Sprint-N`, or `─ No Sprint`
- [x] Clicking a ticket opens the right detail panel with: full title, metadata, description, comments
- [x] Detail panel shows AI analysis tabs when available (re-uses existing `AnalysisCard`)
- [x] Analyze / Mark as Learned / Draft PR buttons work from the detail panel
- [x] When `JIRA_MY_USERNAME` is not set, Mine tab shows a configuration banner explaining the env var
- [x] When MCP is disconnected, page shows actionable reconnect instructions with `npm run mcp-setup` command
- [x] `isRefreshing` never gets stuck — `finally` always resets, 2-min timeout guard active
- [x] `npm run typecheck` passes with zero errors
- [x] `npm run build` compiles cleanly
- [x] Smoke test: `curl http://localhost:3132/api/jira/board?tab=mine` returns issues array (not empty when MCP connected)
- [x] After Sprint tab loads, all unique assignees from Saturn-93 are inserted into `team_members` (deduped)
- [x] Dismissible toast appears if new teammates were discovered: "N new teammates from Saturn-93. View in Teammates →"

---

## Non-Goals (Explicitly Out of Scope)

- Editing tickets from the UI (create/update/transition — Jira write operations)
- Showing tickets from other projects (BDS only)
- Sprint planning view (drag-and-drop)
- Real-time push updates (polling every 5 min is sufficient)
