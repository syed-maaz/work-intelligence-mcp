---
title: "EP-23: Daily Summary Dashboard Section"
sidebar_label: "EP-23: Daily Summary"
---

# EP-23: Daily Summary Dashboard Section

| | |
|---|---|
| **Status** | 🔲 TODO |
| **Priority** | High |
| **Agent Role** | AI / Full-Stack Engineer |
| **Depends On** | [EP-19](./ep19-persistent-digests), [EP-20](./ep20-saturn-board) |
| **Blocks** | — |
| **File Scope** | `src/tools/daily-summary.ts` (new), `web-server.js` (edit), `web/src/lib/api.ts` (edit), `web/src/components/shared/DailySummarySection.tsx` (new), `web/src/pages/DashboardPage.tsx` (edit) |

## Goal

The Dashboard front page opens with a hero "Daily Summary" section that answers: what happened yesterday, what to do today, which Saturn issues are ready to pick up, and which action items are due. Generated once per hour and cached. The user said: "on the front-page it should give me summary of the last day and what should be done and if Saturn has a ticket which I can pick or in waiting."

## Decisions Made

- **Reuse `digests` table from EP-19 with `topic_name = '__daily_summary__'`**: No new table. The `expires_at` column handles the 1-hour TTL.
  - **Rejected**: A separate `daily_summaries` table — redundant with `digests`.
- **Claude Sonnet for synthesis**: This is the highest-value AI call in the system — it synthesizes multiple data sources into actionable morning briefing. Sonnet quality over Haiku cost.
- **Don't trigger Saturn board fetch**: If `saturnCache.fetchedAt === 0` (cold), skip Saturn section rather than triggering a Playwright browser fetch from within the summary generator. Saturn section renders separately on the dashboard.
  - **Rejected**: Triggering Saturn fetch inside `generateDailySummary` — would make the first dashboard load unbearably slow.
- **`staleTime: 3_600_000` on frontend**: The 1-hour cache means navigating away and back returns the cached version instantly without re-fetching.
- **4 accordion sections**: Collapsible so the user can focus on what they care about. Default: all expanded.

## What Will Be Built

### `src/tools/daily-summary.ts` (new)

```ts
export interface DailySummaryData {
  yesterdaySummary: string;          // 2-3 sentence prose
  todayPriorities: string[];         // bullet list items
  saturnReadyIssues: SaturnIssue[];  // from saturnCache if warm; [] if cold
  actionItemsDueToday: Array<{
    title: string; assignee: string | null; due_date: string;
  }>;
}

export interface DailySummaryResult {
  markdown: string;
  sections: DailySummaryData;
}

export async function generateDailySummary(
  db: Database,
  date: string,            // ISO date string: '2026-04-17'
  saturnIssues: SaturnIssue[],  // pass from saturnCache — tool doesn't fetch
  anthropicApiKey: string
): Promise<DailySummaryResult>
```

**Context collection logic:**
```ts
// Yesterday's messages — all topics
const yesterday = format(subDays(parseISO(date), 1), 'yyyy-MM-dd');
const messages = db.prepare(`
  SELECT content, author, source, subject, timestamp
  FROM messages
  WHERE date(timestamp) = ?
  ORDER BY timestamp DESC LIMIT 100
`).all(yesterday);

// Action items due today or overdue
const dueItems = db.prepare(`
  SELECT title, assignee, due_date FROM action_items
  WHERE status != 'completed' AND due_date <= ?
  ORDER BY due_date ASC LIMIT 20
`).all(date);

// Recent meetings (last 7 days)
const meetings = db.prepare(`
  SELECT chat_name, summary, date FROM meetings
  WHERE date(date) >= date(?, '-7 days')
  ORDER BY date DESC LIMIT 5
`).all(date);
```

**Claude Sonnet call**: Uses `AIAnalyzer` with tool use. Tool schema:
```ts
{
  name: 'generate_daily_summary',
  input_schema: {
    type: 'object',
    properties: {
      yesterdaySummary: { type: 'string' },
      todayPriorities: { type: 'array', items: { type: 'string' } },
    },
    required: ['yesterdaySummary', 'todayPriorities']
  }
}
```

System prompt instructs: "If a section has no data, write 'Nothing to report' — never invent information."

### `web-server.js` (edit)

New endpoint: `GET /api/daily-summary?date=2026-04-17&refresh=false`

```js
// Cache key: digests table, topic_name = '__daily_summary__', date = today
const cached = getCachedDigest(db, date, '__daily_summary__');
if (cached && !forceRefresh) {
  json(res, 200, { markdown: cached.markdown, cached: true, generatedAt: cached.generated_at });
  return;
}

const { generateDailySummary } = await import('./dist/tools/daily-summary.js');
const result = await generateDailySummary(db, date, saturnCache.data, anthropicApiKey);

// Save with 1-hour TTL
saveDigest(db, date, '__daily_summary__', result.markdown,
  new Date(Date.now() + 3600000).toISOString());

json(res, 200, { markdown: result.markdown, sections: result.sections, cached: false,
  generatedAt: new Date().toISOString() });
```

### `web/src/components/shared/DailySummarySection.tsx` (new)

Four accordion panels rendered with `useState` for open/closed:

| Panel | Data source | Default |
|-------|------------|---------|
| Yesterday's Summary | `sections.yesterdaySummary` | Open |
| Today's Priorities | `sections.todayPriorities` (bullet list) | Open |
| Saturn Issues Ready | `sections.saturnReadyIssues` (reuses SaturnIssue row format) | Open |
| Action Items Due Today | `sections.actionItemsDueToday` (checklist style) | Open |

```tsx
// useQuery config:
useQuery({
  queryKey: ['daily-summary'],
  queryFn: () => api.dailySummary(),
  staleTime: 3_600_000,    // 1 hour — never re-fetch within the hour
  refetchOnWindowFocus: false,
})

// Header: "Daily Briefing" with CalendarDays icon
// "Updated X min ago" chip + Refresh button (calls with refresh=true, invalidates query)
// Skeleton: 3 lines × 4 panels while loading
// Loading text: "Generating your daily briefing..." if > 3s elapsed
```

### `web/src/lib/api.ts` (edit)

```ts
export interface DailySummary {
  markdown: string;
  sections: {
    yesterdaySummary: string;
    todayPriorities: string[];
    saturnReadyIssues: SaturnIssue[];
    actionItemsDueToday: Array<{ title: string; assignee: string | null; due_date: string }>;
  };
  cached: boolean;
  generatedAt: string;
}

dailySummary: (opts?: { date?: string; refresh?: boolean }) =>
  request<DailySummary>('/daily-summary' + buildQs(opts))
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-23-1 | Create `generateDailySummary()` with data collection + Claude Sonnet — **File:** `src/tools/daily-summary.ts` | 🔲 TODO |
| EP-23-2 | Add `GET /api/daily-summary` with 1-hour cache via `digests` table — **File:** `web-server.js` | 🔲 TODO |
| EP-23-3 | Add `DailySummary` type + `api.dailySummary()` — **File:** `web/src/lib/api.ts` | 🔲 TODO |
| EP-23-4 | Build `DailySummarySection` with 4 accordion panels — **File:** `web/src/components/shared/DailySummarySection.tsx` | 🔲 TODO |
| EP-23-5 | Add `<DailySummarySection />` as topmost content on Dashboard — **File:** `web/src/pages/DashboardPage.tsx` | 🔲 TODO |

## Acceptance Criteria

- [ ] `GET /api/daily-summary` returns markdown + structured sections
- [ ] Result is cached for 1 hour in `digests` table with `topic_name = '__daily_summary__'`
- [ ] Second call within 1 hour returns `cached: true` instantly
- [ ] "Nothing to report" shown for empty sections — no hallucination
- [ ] `DailySummarySection` renders 4 accordion panels as topmost content on Dashboard
- [ ] Refresh button force-regenerates
- [ ] `staleTime: 3_600_000` prevents redundant API calls on navigation
- [ ] `npm run typecheck` passes with zero errors

## Sample Usage

```bash
curl http://localhost:3132/api/daily-summary
# → {
#     markdown: "## Daily Briefing...",
#     sections: {
#       yesterdaySummary: "Yesterday the team focused on...",
#       todayPriorities: ["Review PROJ-15042 PR", "Follow up on deployment"],
#       saturnReadyIssues: [{ key: "PROJ-15057", status: "Todo", ... }],
#       actionItemsDueToday: []
#     },
#     cached: false,
#     generatedAt: "2026-04-17T08:02:11Z"
#   }

# Second call (within 1 hour) — instant
curl http://localhost:3132/api/daily-summary
# → { ..., cached: true }
```
