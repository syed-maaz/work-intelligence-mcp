---
title: "EP-25: Outlook Calendar Sync"
sidebar_label: "EP-25: Calendar Sync"
---

# EP-25: Outlook Calendar Sync

| | |
|---|---|
| **Status** | 🔲 TODO |
| **Priority** | Medium |
| **Agent Role** | Integration / Web UI Engineer |
| **Depends On** | [EP-17](./ep17-headless-browser), [EP-22](./ep22-sync-all) |
| **Blocks** | — |
| **File Scope** | `src/db/schema.ts` (edit), `src/db/queries.ts` (edit), `src/connectors/outlook-calendar.ts` (new), `web-server.js` (edit), `web/src/lib/api.ts` (edit), `web/src/components/shared/TodaysCalendarSection.tsx` (new), `web/src/pages/DashboardPage.tsx` (edit) |

## Goal

Scrape the user's Outlook Calendar and show today's meetings + upcoming events on the Dashboard. The user said: "calendar is not synced and no updates of meetings are there." User explicitly chose **Outlook Calendar** (`outlook.office.com`) as the source.

## Why Playwright (Not Microsoft Graph API)

The company IT blocks Azure AD app registration and OAuth. Graph API is impossible. This is the same constraint that drove the Outlook email and Teams scraping approach. Browser automation with SSO cookie reuse is the only path.

## Scraping Strategy

Navigate to `https://outlook.office.com/calendar/view/week`.

**DOM approach — aria-label parsing (most stable):**

OWA calendar renders each event as a `button` element with a rich `aria-label`. Example labels:
```
"10:00 AM - 11:00 AM, Weekly Saturn Standup, accepted"
"2:30 PM - 3:00 PM, 1:1 with Manager, tentative"
"All day, OOO - Out of Office, accepted"
```

Regex: `/^(\d{1,2}:\d{2} [AP]M) - (\d{1,2}:\d{2} [AP]M), (.+), (accepted|tentative|declined|none)$/`

This is far more stable than CSS class selectors — OWA's CSS classes change with every release (confirmed by existing `outlook-browser.ts` comments).

## Decisions Made

- **aria-label parsing over CSS selectors**: OWA class names are obfuscated and change with releases. aria-labels follow WCAG and are more stable.
  - **Rejected**: Scraping by CSS class (`span.TtcXM` style) — breaks on every OWA update.
- **Store in separate `calendar_events` table, not `messages`**: Calendar events are structurally different from messages. Different fields (start_time, end_time, response_status), different query patterns ("what's on my calendar today" vs "search messages for keyword"). Keeping them separate avoids polluting FTS5 index.
  - **Rejected**: Storing as `source: 'calendar'` in `messages` — mismatches the schema (no subject/content fields fit calendar event structure).
- **`source_id = sha256(title + start_time day+hour)`**: Stable deduplication. Two events with the same title at the same time are the same event. Handles recurring events as separate rows (each occurrence has a unique start_time).
- **1-hour DB cache**: Calendar is scraped at most once per hour. The `scraped_at` column on the most recent event for the date range is the cache key.
- **No attendee detail scraping (MVP)**: Getting full attendee list requires clicking each event to open the detail pane — slow. MVP uses only aria-label data. Attendee detail is a V2 feature.

## What Will Be Built

### DB Migration — `src/db/schema.ts` (edit)

Bump `CURRENT_SCHEMA_VERSION`. Add migration:

```sql
CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL UNIQUE,    -- sha256(title + format(start_time,'yyyyMMddHHmm'))
  title TEXT NOT NULL,
  start_time TEXT NOT NULL,          -- ISO datetime: '2026-04-17T10:00:00+02:00'
  end_time TEXT,                     -- ISO datetime or NULL for all-day
  location TEXT,
  organizer TEXT,
  attendees TEXT,                    -- JSON: [{ name, email }] — empty array MVP
  body TEXT,                         -- event description, NULL if not scraped
  is_all_day INTEGER NOT NULL DEFAULT 0,
  response_status TEXT,              -- 'accepted' | 'tentative' | 'declined' | 'none'
  scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_calendar_start_time ON calendar_events(start_time);
CREATE INDEX IF NOT EXISTS idx_calendar_source_id ON calendar_events(source_id);
```

### `src/db/queries.ts` (edit)

```ts
export interface CalendarEvent {
  id: number;
  source_id: string;
  title: string;
  start_time: string;       // ISO datetime
  end_time: string | null;
  location: string | null;
  organizer: string | null;
  attendees: string;        // JSON string — parse with JSON.parse()
  body: string | null;
  is_all_day: number;       // 0 | 1
  response_status: string | null;
  scraped_at: string;
}

export function upsertCalendarEvent(db: Database, event: Omit<CalendarEvent, 'id'>): void
// INSERT OR REPLACE INTO calendar_events

export function getUpcomingEvents(db: Database, days: number): CalendarEvent[]
// WHERE start_time >= datetime('now') AND start_time <= datetime('now', '+N days')
// ORDER BY start_time ASC

export function getEventsForDate(db: Database, date: string): CalendarEvent[]
// WHERE date(start_time) = date(?)
// ORDER BY start_time ASC
```

### `src/connectors/outlook-calendar.ts` (new)

```ts
export interface ScrapedCalendarEvent {
  sourceId: string;
  title: string;
  startTime: Date;
  endTime: Date | null;
  isAllDay: boolean;
  responseStatus: 'accepted' | 'tentative' | 'declined' | 'none';
}

export class OutlookCalendarConnector {
  async scrapeWeek(page: Page, weekOffset = 0): Promise<ScrapedCalendarEvent[]>
  private parseAriaLabel(label: string, referenceDate: Date): ScrapedCalendarEvent | null
  private generateSourceId(title: string, startTime: Date): string
    // sha256(title + format(startTime, 'yyyyMMddHHmm'))
}
```

`scrapeWeek` logic:
```ts
// 1. Navigate to https://outlook.office.com/calendar/view/week
await page.goto('https://outlook.office.com/calendar/view/week');
await page.waitForSelector('div[role="main"]', { timeout: 10000 });

// 2. Check for auth redirect
if (page.url().includes('microsoftonline.com') || page.url().includes('/login')) {
  throw new ConnectorError('Authentication', 'OWA session expired');
}

// 3. Query all buttons with aria-labels containing time patterns
const buttons = await page.$$('button[aria-label*=":"]');
// Also query all-day row: div[aria-label*="All day"] or buttons in header row

// 4. Parse each aria-label
const events: ScrapedCalendarEvent[] = [];
for (const btn of buttons) {
  const label = await btn.getAttribute('aria-label');
  if (!label) continue;
  const parsed = this.parseAriaLabel(label, new Date());
  if (parsed) events.push(parsed);
}

return events;
```

`parseAriaLabel` regex:
```ts
// Standard event: "10:00 AM - 11:00 AM, Title, accepted"
const EVENT_RE = /^(\d{1,2}:\d{2} [AP]M) - (\d{1,2}:\d{2} [AP]M), (.+), (accepted|tentative|declined|none)$/i;
// All-day: "All day, Title, accepted"
const ALLDAY_RE = /^All day, (.+), (accepted|tentative|declined|none)$/i;
```

### `web-server.js` (edit)

New endpoint: `GET /api/calendar/upcoming?days=7`

```js
// Cache check: any event scraped < 1 hour ago for the requested range?
const recentScrape = db.prepare(`
  SELECT MAX(scraped_at) as latest FROM calendar_events
  WHERE start_time >= datetime('now') AND start_time <= datetime('now', '+' || ? || ' days')
`).get(days);

const isStale = !recentScrape?.latest ||
  new Date(recentScrape.latest) < new Date(Date.now() - 3600000);

if (isStale && process.env.BROWSER_PROFILE_PATH) {
  const page = await getBrowserSession().getPage();
  const connector = new OutlookCalendarConnector();
  const scraped = await connector.scrapeWeek(page);
  for (const event of scraped) upsertCalendarEvent(db, toDbEvent(event));
}

const events = getUpcomingEvents(db, days);
json(res, 200, { events, count: events.length });
```

Wire into `runFullSync()` from EP-22 as the final step after topic syncs.

### `web/src/components/shared/TodaysCalendarSection.tsx` (new)

Timeline layout:
```
10:00 ● Weekly Saturn Standup   (1h)  [accepted]
11:30 ● 1:1 with Manager        (30m) [tentative]
14:00 ──────────── All day: OOO ───────────────────
```

```tsx
// Response status → color
const statusColor = {
  accepted:  '#10b981',   // green
  tentative: '#f59e0b',   // yellow
  declined:  '#6b7280',   // gray (+ strikethrough on title)
  none:      '#6b7280',
};

// Duration formatting: 30m, 1h, 1h 30m
// Toggle: "Today" (days=1) | "This Week" (days=7) — tab buttons

// useQuery config:
useQuery({
  queryKey: ['calendar-upcoming', days],
  queryFn: () => api.upcomingCalendar({ days }),
  refetchInterval: 300_000,  // 5 min
})
```

### `web/src/lib/api.ts` (edit)

```ts
export interface CalendarEvent {
  id: number;
  source_id: string;
  title: string;
  start_time: string;    // ISO datetime
  end_time: string | null;
  location: string | null;
  is_all_day: number;
  response_status: string | null;
  scraped_at: string;
}

upcomingCalendar: (opts?: { days?: number }) =>
  request<{ events: CalendarEvent[]; count: number }>(
    `/calendar/upcoming?days=${opts?.days ?? 1}`
  )
```

## Environment Variables

No new env vars. Reuses `BROWSER_PROFILE_PATH` from existing browser config.

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-25-1 | DB migration: `calendar_events` table — **File:** `src/db/schema.ts` | 🔲 TODO |
| EP-25-2 | Add `upsertCalendarEvent`, `getUpcomingEvents`, `getEventsForDate` — **File:** `src/db/queries.ts` | 🔲 TODO |
| EP-25-3 | Build `OutlookCalendarConnector` with aria-label parsing — **File:** `src/connectors/outlook-calendar.ts` | 🔲 TODO |
| EP-25-4 | Add `GET /api/calendar/upcoming` with 1-hour DB cache — **File:** `web-server.js` | 🔲 TODO |
| EP-25-5 | Wire calendar scrape into `runFullSync()` — **File:** `web-server.js` | 🔲 TODO |
| EP-25-6 | Add `CalendarEvent` type + `api.upcomingCalendar()` — **File:** `web/src/lib/api.ts` | 🔲 TODO |
| EP-25-7 | Build `TodaysCalendarSection` with timeline layout — **File:** `web/src/components/shared/TodaysCalendarSection.tsx` | 🔲 TODO |
| EP-25-8 | Add `<TodaysCalendarSection />` between stats row and Recent Messages — **File:** `web/src/pages/DashboardPage.tsx` | 🔲 TODO |

## Acceptance Criteria

- [ ] `calendar_events` table exists with correct schema
- [ ] `OutlookCalendarConnector.scrapeWeek()` parses aria-labels correctly (test with sample labels)
- [ ] `GET /api/calendar/upcoming` returns events from DB (scrapes on first call)
- [ ] Events deduplicated via `source_id UNIQUE` — re-scraping doesn't duplicate events
- [ ] Auth expired throws `ConnectorError(Authentication)` — graceful UI warning
- [ ] `TodaysCalendarSection` renders timeline with response status colors
- [ ] "Today" / "This Week" toggle works
- [ ] Calendar scrape wired into Sync All (EP-22) — fires after topic syncs
- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` compiles cleanly

## Sample Usage

```bash
# Fetch today's calendar (scrapes if cache > 1 hour old)
curl "http://localhost:3132/api/calendar/upcoming?days=1"
# → {
#     events: [
#       { title: "Weekly Saturn Standup", start_time: "2026-04-17T10:00:00+02:00",
#         end_time: "2026-04-17T11:00:00+02:00", response_status: "accepted", ... },
#       { title: "1:1 with Manager", start_time: "2026-04-17T11:30:00+02:00",
#         end_time: "2026-04-17T12:00:00+02:00", response_status: "tentative", ... }
#     ],
#     count: 2
#   }

# This week
curl "http://localhost:3132/api/calendar/upcoming?days=7"
# → { events: [...], count: 12 }
```
