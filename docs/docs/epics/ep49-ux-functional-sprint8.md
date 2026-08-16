---
sidebar_position: 49
title: EP-49 UX & Functional Improvements (Sprint 8)
---

# EP-49: UX & Functional Improvements — Sprint 8

| Field | Value |
|-------|-------|
| **Status** | ✅ Done (2026-04-20) |
| **Priority** | High |
| **Agent Role** | Senior Frontend + Senior Backend |
| **Sprint** | 8 |
| **Reported** | 2026-04-20 |
| **Depends On** | EP-46 ✅ (Jira MCP adapter), EP-42 ✅ (schema v23), EP-48 🔲 (Jira Solution Engine — EP-49 independent; can run in parallel) |
| **Blocks** | — |
| **File Scope** | `web/src/pages/TopicExpertPage.tsx` (edit), `web/src/pages/JiraReportPage.tsx` (edit), `web-server.js` (edit), `src/db/schema.ts` (edit), `src/connectors/jira-adapter.ts` (edit), `web/src/components/shell/ChatPanel.tsx` (edit) |

---

## Goal

Ten UX pain points and functional bugs reported in a single session on 2026-04-20. They span:

1. **Topic Expert layout** — redundant 3-column structure, confusing notes behavior, missing source attribution, missing human-feedback loop for summaries
2. **Graph tab** — currently shows only a static circle of topic nodes with message counts; not actionable
3. **Jira page** — no data-source indicator (MCP vs scraper), mysterious "unknown" in analyzed-batch label, infinite loading loop when no data, sprint items not showing assigned-to-me issues, missing real-time Jira fetch on page load
4. **Global chat** — ticket mentions (`PROJ-1234`) in chat should trigger a live fetch and inline answer

---

## Decisions Made

### EP-49-1 (Related section as inline chips, not a column)
- **Decision**: Move the Related Topics strip from a vertical middle column into an inline chip row inside the Notebook tab header. Remove the `w-1/2` left / `shrink-0` Related / `w-1/2` right three-section layout.
- **Why**: Only ~5 chips wide; a full column wastes ~20% of viewport real-estate for decorative arrows. The Notebook + Chat 50/50 split gives both panels breathing room.
- **Rejected**: Accordion in left tab bar — would hide the most relevant cross-topic signal.

### EP-49-2 (Notes tab — show existing content on load, not blank)
- **Decision**: The bug is that `setAnnotation('')` runs before the `useQuery` resolves because `data` is initially `undefined`. Fix: guard the `useEffect` with `if (data !== undefined)` before setting annotation. Do not reset to empty on mount.
- **Why**: Trivial sync bug — one-line fix avoids losing the user's existing notes on every page load.

### EP-49-3 (Notebook — show source citations)
- **Decision**: Add a `sources` field to the notebook content API response (`GET /api/topics/:name/notebook`). The AI prompt should extract a short list of sources (message IDs / authors / channel names) it used. Surface as a collapsible "Sources (N)" footer below the notebook body in `MarkdownPanel`.
- **Why**: User needs to audit AI summaries and trust them; blind summaries are opaque.
- **Rejected**: Raw message IDs — use human-readable `"${author} in ${channel} (${date})"` strings.

### EP-49-4 (Human feedback loop for notebook summaries)
- **Decision**: Add a `POST /api/topics/:name/notebook/feedback` endpoint that appends a correction note to `topic_notebooks.user_corrections` (new JSON column). The `buildNotebook()` AI prompt already injects user annotations — extend it to also inject the corrections list as "Human Corrections — treat these as ground truth". The Notes tab is the general scratchpad; Feedback is explicit correction of AI-generated claims.
- **Why**: The user gave a concrete example: "Yasar is not part of KBA" — this is a factual correction, not a personal note. Separating the two surfaces make the intent clear.
- **Rejected**: Storing corrections in the same `annotation` field — mixing intent makes the prompt harder to control.

### EP-49-5 (Graph — make it actionable)
- **Decision**: Replace the current static node-on-circle layout with a **Smart Connections Graph** that shows:
  1. Nodes as topics (same as today)
  2. Edge labels showing **shared people** AND **shared Jira tickets** (new — cross-reference `jira_issues` with topic messages)
  3. A node click → switches to that topic in the left panel (already works)
  4. A "strongest connection" callout — a single highlighted most-connected pair with the list of shared items
  5. Add a mini-legend: what edge thickness means, what node size means (message count)
- **Why**: Current graph has no actionable value — lines have no readable meaning without hover. The user explicitly asked to brainstorm; this design surfaces "who or what connects these topics" which is actionable for meeting prep.
- **Rejected**: D3.js — no dependency; we stay with pure SVG. Force-directed layout would be unreadable with 3-8 nodes.

### EP-49-6 (Jira — data source indicator)
- **Decision**: Add a `data_source` column to the `jira_issues` table (TEXT, default `'unknown'`). Populate it as `'mcp'` when fetched via McpClient and `'browser'` when fetched via JiraBrowserConnector. Surface as a tiny chip (`MCP` or `scraper`) next to the "Updated N ago" text in the Jira page header.
- **Why**: Debugging fetches is currently opaque. User needs to know which path was used to assess data freshness and reliability.
- **Schema**: Add migration in `schema.ts` at `CURRENT_SCHEMA_VERSION + 1`.

### EP-49-7 ("Unknown" in analyzed batch)
- **Decision**: The "analyzed batch" count label shows "Unknown" because `analyzed_at` from SQLite can come back as a raw ISO string that `timeAgo()` fails to parse when the string contains `'Unknown'` as the default value (schema default `'Unknown'` on status column bleeds into display). Fix: guard `timeAgo()` with a validity check — if the timestamp is not parseable, show "–" not "Unknown".
- **Why**: Simple defensive UI fix. The real data is correct; the display crashes on the schema default.

### EP-49-8 (Infinite loading / fetch loop)
- **Decision**: The page enters a loading loop because `saturnCache.isRefreshing = true` and then the browser Playwright session fails silently — leaving `isRefreshing` stuck as `true` forever. Fix: Ensure the `finally` block in `startSaturnRefresh()` always sets `saturnCache.isRefreshing = false`, add a `REFETCH_TIMEOUT_MS = 120_000` guard that resets the flag if still true after 2 minutes. Surface a "Last attempt failed" badge if `lastFailedAt` is within the last 5 minutes.
- **Why**: Silent failures leave the UI in a spinner forever. The user sees the page "keep on loading and fetching" — needs a visible error state.

### EP-49-9 (Sprint tab — show issues assigned to me)
- **Decision**: The `SPRINT_STATUSES` list used to filter sprint issues is too narrow. Current: `['in progress', 'in review', 'in testing', 'code review', 'active', 'dev in progress']`. Missing specific statuses like `'in development'`, `'in qa'`, `'selected for development'`. Additionally, the sprint fetch should **try MCP first** (via `createJiraDataSource` with `JIRA_SOURCE=auto`), then fall back to browser scraper. The "assigned to me" filter should use the authenticated user's account from the MCP token rather than hardcoding.
- **Why**: BDS Jira uses specific status strings not in the current list. The MCP-first approach aligns with EP-46's intent.
- **Rejected**: Adding ALL possible statuses — use a keyword-match approach (anything not `'done'`, `'closed'`, `'resolved'`, `'backlog'`, `'open'`) is "in sprint".

### EP-49-10 (Chat — fetch ticket details on mention)
- **Decision**: In `ChatPanel.tsx`, before sending the user message to the AI, run a regex `[A-Z]+-\d+` across the message. If matches found, call `GET /api/jira/ticket/:key` for each (max 3 tickets). Inject the results as system context into the chat API call: `"Context for ticket PROJ-1234: [title, status, assignee, description snippet]"`. The chat endpoint (`POST /api/chat`) receives an optional `injectedContext` field.
- **Why**: The user wants to ask "what's the status of PROJ-1234?" in chat and get a live answer. Without live fetch, the AI can only answer from its training data.
- **Rejected**: Full Jira re-scrape on every chat message — only fetch if ticket key is explicitly mentioned; max 3 per message to bound latency.

---

## What Will Be Built

### EP-49-1: TopicExpertPage — Remove middle column, inline Related chips

**Current layout** (3 columns):
```
[ Notebook/Graph/Notes (w-1/2) ] [ Related chips (shrink-0) ] [ Chat (w-1/2) ]
```

**New layout** (2 columns):
```
[ Notebook/Graph/Notes (w-1/2) ] [ Chat (w-1/2) ]
                ↑
    Related chips move here — inside Notebook tab, below tab switcher row
```

In `TopicExpertPage.tsx`:
- Remove the standalone Related Topics `<div>` column (lines ~663–687)
- Move `relData` chip row into Notebook tab content area, just below the tab switcher bar and Rebuild button row
- Layout becomes `flex flex-1 gap-4 pt-4 min-h-0` with two `w-1/2` children only

### EP-49-2: NotesTab — fix blank-on-load bug

**File**: `TopicExpertPage.tsx`, `NotesTab` component (~line 278)

```ts
// Before (buggy — runs on first render when data is undefined)
useEffect(() => {
  setAnnotation(data?.annotation ?? '');
  setSaved(true);
}, [data]);

// After
useEffect(() => {
  if (data !== undefined) {
    setAnnotation(data.annotation ?? '');
    setSaved(true);
  }
}, [data]);
```

### EP-49-3: Notebook — source citations

**Backend** (`web-server.js`, `GET /api/topics/:name/notebook`):
```ts
// Add to notebook response
interface NotebookResponse {
  content: string;
  message_count: number;
  last_updated: string;
  stale: boolean;
  fresh: boolean;
  sources: Array<{ label: string; count: number }>; // NEW
}
```

**AI prompt update** (`src/services/analyzer.ts`, `buildNotebook()`):
- Add instruction: "At the end of your response, add a `---SOURCES---` block listing the top 5 sources you used, format: `author | channel | date`. Do not fabricate sources."
- Parse `---SOURCES---` block server-side, strip from `content`, populate `sources` array.

**UI** (`TopicExpertPage.tsx`, Notebook tab):
- Below `<MarkdownPanel content={notebook.content} />`, add collapsible "Sources (N)" footer
- Each source as a small chip: `author in channel · date`

### EP-49-4: Human feedback correction loop

**Schema** (`src/db/schema.ts`):
```sql
ALTER TABLE topic_notebooks ADD COLUMN user_corrections TEXT DEFAULT '[]';
```
(add in next migration)

**Endpoint** (`web-server.js`):
```ts
POST /api/topics/:name/notebook/feedback
Body: { correction: string }  // e.g. "Yasar is not part of KBA"
Response: { ok: true }
// Appends to JSON array in user_corrections column
```

**AI prompt** (`src/services/analyzer.ts`, `buildNotebook()`):
```ts
// Inject before summary generation:
if (corrections.length > 0) {
  systemPrompt += `\n\nHuman Corrections (treat as ground truth, higher priority than message data):\n${corrections.map(c => `- ${c}`).join('\n')}`;
}
```

**UI** (`TopicExpertPage.tsx`, Notebook tab):
- Small "Correct this summary" button below notebook body
- Opens a simple `<textarea>` modal: "What is wrong? e.g. 'Yasar is not part of KBA'"
- On submit: `POST /api/topics/:name/notebook/feedback`
- Shows existing corrections count as "N corrections active" badge near Rebuild button

### EP-49-5: Smart Connections Graph

**New graph behavior** (`TopicExpertPage.tsx`, `KnowledgeGraph` component):
- Node size proportional to `messageCount` (min r=14, max r=28)
- Edge thickness based on `sharedPeople.length + sharedTickets.length` (combined weight)
- Edge label (shown on hover): list of shared people AND shared ticket keys
- Add `sharedTickets: string[]` to `GraphEdge` type in `web/src/lib/api.ts`
- Backend: `GET /api/topics/graph` should include `sharedTickets` — cross-join `messages` with `jira_issues` on author/assignee match
- Add mini-legend bottom-left: 3 lines — "● node size = message count", "— line weight = shared people + tickets", "click node = switch topic"
- Add "Strongest connection" callout card above graph when `safeEdges.length > 0`: `"${top.from} ↔ ${top.to} — ${top.sharedPeople.length + (top.sharedTickets?.length ?? 0)} shared connections"`

### EP-49-6: Jira data source indicator

**Schema** (`src/db/schema.ts`):
```sql
ALTER TABLE jira_issues ADD COLUMN data_source TEXT DEFAULT 'unknown';
-- Populate on write in jira-adapter.ts
```

**Backend** (`src/connectors/jira-adapter.ts`):
```ts
// Add to JiraIssue type and all insert calls
data_source: 'mcp' | 'browser' | 'unknown'
```

**UI** (`JiraReportPage.tsx`, header area):
```tsx
{cachedAt && (
  <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full"
    style={{ background: dataSource === 'mcp' ? 'rgba(99,102,241,0.12)' : 'rgba(234,179,8,0.12)',
             color: dataSource === 'mcp' ? '#6366f1' : '#d97706',
             border: `1px solid ${dataSource === 'mcp' ? 'rgba(99,102,241,0.25)' : 'rgba(234,179,8,0.25)'}` }}>
    {dataSource === 'mcp' ? 'via MCP' : dataSource === 'browser' ? 'via scraper' : 'unknown source'}
  </span>
)}
```

### EP-49-7: Fix "Unknown" in analyzed batch label

**File**: `JiraReportPage.tsx`

```ts
// Current timeAgo() — no guard against invalid timestamps
function timeAgo(ts: string): string {
  const d = parseLocalTs(ts);
  // ...
}

// Fix: add guard
function timeAgo(ts: string): string {
  if (!ts || ts === 'Unknown' || ts === 'unknown') return '–';
  const d = parseLocalTs(ts);
  if (isNaN(d.getTime())) return '–';
  // ...rest unchanged
}
```

### EP-49-8: Fix infinite loading / isRefreshing stuck flag

**File**: `web-server.js`, `startSaturnRefresh()` and `startMyIssuesRefresh()`

```js
const REFETCH_TIMEOUT_MS = 120_000; // 2 minutes

async function startSaturnRefresh() {
  if (saturnCache.isRefreshing) {
    // Guard: if stuck for >2 min, force-reset
    if (Date.now() - (saturnCache.refreshStartedAt ?? 0) > REFETCH_TIMEOUT_MS) {
      saturnCache.isRefreshing = false;
      saturnCache.lastFailedAt = Date.now();
    } else {
      return;
    }
  }
  saturnCache.isRefreshing = true;
  saturnCache.refreshStartedAt = Date.now();
  try {
    // ...existing fetch logic
  } catch (err) {
    saturnCache.lastFailedAt = Date.now();
    // ensure error is logged
  } finally {
    saturnCache.isRefreshing = false; // ALWAYS reset
  }
}
```

**UI** (`JiraReportPage.tsx`): Show "Last attempt failed N ago" warning badge when `lastFailedAt` is within 5 minutes and `isRefreshing` is false.

### EP-49-9: Sprint — correct statuses + MCP-first + assigned-to-me

**File**: `JiraReportPage.tsx`

```ts
// Expanded status list
const SPRINT_STATUSES = [
  'in progress', 'in review', 'in testing', 'code review',
  'active', 'dev in progress', 'in development', 'in qa',
  'selected for development', 'in progress (dev)', 'in progress (review)',
];

// Alternative: invert — "not done" heuristic
function isInSprint(status: string): boolean {
  const done = ['done', 'closed', 'resolved', 'won\'t fix', 'duplicate', 'backlog', 'open', 'to do'];
  const n = status.toLowerCase();
  return !done.some(k => n.includes(k));
}
```

**File**: `web-server.js`, `startMyIssuesRefresh()`:
```js
// Try MCP first (JIRA_SOURCE=auto already does this via createJiraDataSource)
// Ensure JIRA_SOURCE env fallback logic reaches MCP before browser
// Add log: `[MyIssues] Fetching via ${source}` — 'mcp' | 'browser'
```

**File**: `web-server.js`, my-issues endpoint:
```js
// Return data_source in response so UI can surface it
res.json({ issues: myIssuesCache.data, data_source: myIssuesCache.dataSource ?? 'unknown' });
```

### EP-49-10: Chat — auto-fetch Jira ticket on mention

**File**: `web/src/components/shell/ChatPanel.tsx`

```ts
const TICKET_REGEX = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

async function enrichWithTicketContext(message: string): Promise<string> {
  const matches = [...new Set(message.match(TICKET_REGEX) ?? [])].slice(0, 3);
  if (matches.length === 0) return '';
  const contexts = await Promise.allSettled(
    matches.map(key => api.getJiraTicket(key))
  );
  return contexts
    .filter(r => r.status === 'fulfilled')
    .map(r => {
      const t = (r as PromiseFulfilledResult<JiraTicketSummary>).value;
      return `Ticket ${t.key}: "${t.title}" — Status: ${t.status}, Assignee: ${t.assignee ?? 'unassigned'}\n${t.description ?? ''}`;
    })
    .join('\n\n');
}
```

**Backend** (`web-server.js`):
```js
GET /api/jira/ticket/:key
// Tries MCP first (search_jira_issues with key filter), falls back to DB cache
// Returns: { key, title, status, assignee, description, url }
```

**Chat API** (`POST /api/chat`):
```js
// Accept optional injectedContext in request body
// Prepend as system context to the AI call
```

**`web/src/lib/api.ts`**:
```ts
getJiraTicket(key: string): Promise<JiraTicketSummary>

interface JiraTicketSummary {
  key: string;
  title: string;
  status: string;
  assignee: string | null;
  description: string | null;
  url: string;
}
```

---

## Environment Variables

No new env vars. Uses existing `JIRA_SOURCE=auto` for MCP-first fetch in EP-49-9.

---

## Tickets

| ID | Title | Status | File |
|----|-------|--------|------|
| EP-49-1 | Remove Related middle column; make 2-col layout | ✅ Done | `web/src/pages/TopicExpertPage.tsx` |
| EP-49-2 | Fix Notes tab blank-on-load (guard `useEffect` with `data !== undefined`) | ✅ Done | `web/src/pages/TopicExpertPage.tsx` |
| EP-49-3 | Notebook source citations — AI extracts, UI shows collapsible footer | ✅ Done | `web-server.js`, `src/services/analyzer.ts`, `web/src/pages/TopicExpertPage.tsx` |
| EP-49-4 | Human feedback corrections — new endpoint + `user_corrections` column + UI button | ✅ Done | `web-server.js`, `src/db/schema.ts`, `web/src/pages/TopicExpertPage.tsx` |
| EP-49-5 | Smart Connections Graph — shared tickets, node size, legend, strongest-pair callout | ✅ Done | `web/src/pages/TopicExpertPage.tsx`, `web-server.js`, `web/src/lib/api.ts` |
| EP-49-6 | Jira data source indicator — `data_source` column + chip in header | ✅ Done | `src/db/schema.ts`, `src/connectors/jira-adapter.ts`, `web/src/pages/JiraReportPage.tsx` |
| EP-49-7 | Fix "Unknown" in analyzed batch — guard `timeAgo()` for invalid timestamps | ✅ Done | `web/src/pages/JiraReportPage.tsx` |
| EP-49-8 | Fix infinite loading — stuck `isRefreshing` timeout + error badge | ✅ Done | `web-server.js`, `web/src/pages/JiraReportPage.tsx` |
| EP-49-9 | Sprint issues — expand status list, MCP-first fetch, assigned-to-me | ✅ Done | `web-server.js`, `web/src/pages/JiraReportPage.tsx` |
| EP-49-10 | Chat ticket mention → live fetch + inject context | ✅ Done | `web/src/components/shell/ChatPanel.tsx`, `web-server.js`, `web/src/lib/api.ts` |

---

## Acceptance Criteria

- [x] Topic Expert has exactly 2 panels (no middle column); Related chips appear inside the Notebook tab
- [x] Notes tab shows existing notes on load — not blank
- [x] Notebook has a "Sources" footer that lists where the summary came from
- [x] User can click "Correct this" on a notebook summary, enter text, and it is used in the next rebuild
- [x] Graph shows shared Jira tickets on edges, node sizes vary by message count, mini-legend is visible
- [x] Jira page header shows a "via MCP" or "via scraper" chip
- [x] The "analyzed batch" count never shows "Unknown" — shows "–" for invalid timestamps
- [x] If `isRefreshing` gets stuck for >2 min, it auto-resets and shows a "Last attempt failed" badge
- [x] Sprint view shows specific statuses correctly; "My Issues" tab fetches via MCP first
- [x] Typing `PROJ-1234` in global chat triggers a live fetch and injects ticket context into the AI answer
- [x] `npm run typecheck` passes with zero errors
- [x] `npm run build` compiles cleanly

---

## Sample Prompts / Usage

**Ticket context in chat:**
```
User: What's the current status of PROJ-4231?
→ ChatPanel detects "PROJ-4231", calls GET /api/jira/ticket/PROJ-4231
→ Injects: "Ticket PROJ-4231: 'Fix login timeout' — Status: In Progress, Assignee: John Doe"
→ AI answers with live data, not from training
```

**Human feedback correction:**
```
User clicks "Correct this" on KBA notebook
Types: "Yasar is not part of KBA"
→ POST /api/topics/KBA/notebook/feedback { correction: "Yasar is not part of KBA" }
→ Next notebook rebuild injects this as ground truth
→ AI no longer mentions Yasar in KBA context
```

**Data source indicator:**
```
Jira header: "Updated 3m ago · via MCP"
or: "Updated 3m ago · via scraper"
```

---

## Delivered (2026-04-20)

All 10 tickets completed in Sprint 8.

| Ticket | Delivered | Key Files |
|--------|-----------|-----------|
| EP-49-1 | 2-col layout in TopicExpertPage; Related chips inline in Notebook tab | `web/src/pages/TopicExpertPage.tsx` |
| EP-49-2 | Notes tab blank-on-load guard confirmed present (`if (data !== undefined)`) | `web/src/pages/TopicExpertPage.tsx` |
| EP-49-3 | `sources` field in `build_notebook` tool; `---SOURCES---` block parsed server-side; collapsible `<details>` footer in TopicExpertPage | `web-server.js`, `src/services/analyzer.ts`, `web/src/pages/TopicExpertPage.tsx` |
| EP-49-4 | `user_corrections TEXT DEFAULT '[]'` column in `topic_notebooks` (schema v27); `POST /api/notebooks/:topicName/feedback`; CorrectThisButton modal in TopicExpertPage | `web-server.js`, `src/db/schema.ts`, `web/src/pages/TopicExpertPage.tsx` |
| EP-49-5 | Node size 14–28px by messageCount; edge weight = sharedPeople + sharedTickets; tooltip; mini-legend; strongest-pair callout | `web/src/pages/TopicExpertPage.tsx`, `web-server.js`, `web/src/lib/api.ts` |
| EP-49-6 | `data_source TEXT DEFAULT 'unknown'` column in `jira_issues` (schema v28); `dataSource` in saturnCache; "via MCP"/"via scraper" chip in JiraReportPage header | `src/db/schema.ts`, `src/connectors/jira-adapter.ts`, `web/src/pages/JiraReportPage.tsx` |
| EP-49-7 | `timeAgo()` returns `'–'` for `null`/`'Unknown'`/`'unknown'`/`isNaN` | `web/src/pages/JiraReportPage.tsx` |
| EP-49-8 | `refreshStartedAt` + `REFETCH_TIMEOUT_MS = 120_000`; `finally` always resets `isRefreshing`; red "Last sync attempt failed" badge | `web-server.js`, `web/src/pages/JiraReportPage.tsx` |
| EP-49-9 | Inverted `DONE_STATUSES` heuristic — anything not done/closed/backlog/open is "in sprint"; catches specific statuses | `web-server.js`, `web/src/pages/JiraReportPage.tsx` |
| EP-49-10 | `GET /api/jira/ticket/:key` (MCP→DB fallback); `GET /api/jira/mcp-status`; `injectedContext` in `POST /api/chat`; ticket detection regex in `ChatPanel.tsx` submit(); MCP disconnection warning banner in JiraReportPage | `web/src/components/shell/ChatPanel.tsx`, `web-server.js`, `web/src/lib/api.ts` |

**Schema changes**: v27 adds `topic_notebooks.user_corrections TEXT DEFAULT '[]'`; v28 adds `jira_issues.data_source TEXT DEFAULT 'unknown'`

**New endpoints**: `POST /api/notebooks/:topicName/feedback`, `GET /api/jira/ticket/:key`, `GET /api/jira/mcp-status`
