---
sidebar_position: 10
title: ADR-010 Meeting Intelligence Architecture
---

# ADR-010: Meeting Intelligence — Calendar Bugs, Pre-Meeting Context, Auto-Transcript Pipeline

| Field | Value |
|-------|-------|
| **Date** | 2026-04-20 |
| **Status** | ✅ Accepted |
| **Deciders** | Project owner |
| **Epics** | [EP-51](../epics/ep51-pre-meeting-context), [EP-52](../epics/ep52-meeting-intelligence) |
| **Supersedes** | Pre-meeting brief pattern from EP-25 (keyword FTS only) |

---

## Context

A full audit of the calendar and meeting subsystem on 2026-04-20 revealed:

1. **Two silent bugs** preventing the calendar widget from showing any events
2. **A shallow pre-meeting brief** that uses title keywords rather than actual attendee data
3. **No post-meeting intelligence pipeline** — transcripts require manual sync, topics are never auto-linked, and action items extracted by AI are discarded
4. **Passive missing-info alerts** — Rule 5 warns but provides no actionable path to resolution

These were diagnosed through live endpoint testing and source code inspection:

```bash
# Bug confirmed: CALENDAR_TTL_MS undefined
curl "http://localhost:3132/api/calendar/upcoming?days=7"
# → {"error": "CALENDAR_TTL_MS is not defined"}

# Today filter works for days=1 but may miss events due to UTC drift
# getUpcomingEvents uses datetime('now') — UTC, not localtime
# Events stored in local ISO time (e.g., "2026-04-20T14:00:00") appear as
# tomorrow's events to the server if running after midnight UTC
```

The user confirmed the desired interaction model during the brainstorm session:
- Pre-meeting context should appear inline (expand-panel), not on a separate page
- Transcript capture should eventually be automatic, while also supporting manual paste
- All four areas (bugs, pre-meeting context, auto-transcript, missing-info alerts) should be addressed

---

## Decisions

### Decision 1: Fix `CALENDAR_TTL_MS` as part of EP-51

**Chosen**: Declare `const CALENDAR_TTL_MS = 30 * 60 * 1000;` near the other TTL constants (~line 276 of `web-server.js`).

**Why it was missed**: The constant was likely deleted during a refactor. The error is a `ReferenceError` at runtime, invisible during `npm run typecheck` (plain JS file) and only triggered on the `days=7` code path (the default `days=1` exits the condition before reaching `CALENDAR_TTL_MS`).

**Rationale for 30 min TTL**: Calendar events are deterministic — they don't change minute-to-minute. 30 min is short enough to catch same-day additions (if someone schedules a meeting), long enough to avoid hammering the AppleScript scraper.

---

### Decision 2: Fix today-filter timezone to use `'localtime'`

**Chosen**: Change `getUpcomingEvents` query in `src/db/queries/calendar.ts:55` to:
```sql
WHERE start_time >= datetime('now', 'localtime')
  AND start_time <= datetime('now', 'localtime', '+' || ? || ' days')
```

**Root cause**: SQLite's `datetime('now')` returns UTC. Calendar events scraped via macOS AppleScript arrive as local-time ISO strings (e.g., `2026-04-20T09:00:00` without `Z`). Comparing a UTC `now` to a local-time event string produces incorrect ordering when server timezone is behind UTC.

**Alternative rejected**: Store all events with UTC timestamps at scrape time. This would require changing the scraper, the schema, and all display formatters — too large a blast radius for a bug fix. Localtime correction at query time is the minimal correct fix.

---

### Decision 3: Inline expand panel (not a dedicated page) for pre-meeting context

**Chosen**: Extend `EventRow` in `TodaysCalendarSection.tsx` to show a two-section expanded panel: Pre-Meeting Brief (existing) + Context Panel (new).

**User confirmed**: Inline expand preferred. Avoids navigation break — user is scanning their day and wants context without leaving the dashboard.

**Design constraint**: Context sections must load lazily (on expand, not on page load) to avoid making 5 extra API calls per calendar event on every Dashboard load.

---

### Decision 4: New `/api/calendar/events/:id/context` endpoint — no AI, pure SQL

**Chosen**: Separate context endpoint that returns attendees, recent messages, past meetings, open action items, and Jira tickets — all from DB queries, no AI call.

**Why no AI**: The pre-brief already handles AI synthesis. The context sections are raw data the user can scan in 5–10 seconds. Adding an AI call would introduce 2–5s latency on expand, which breaks the inline UX.

**Why a new endpoint (not augmenting `/regenerate-brief`)**: The brief and context are orthogonal concerns. Brief = AI-written narrative. Context = raw structured data. Keeping them separate allows independent caching, refresh, and future reuse (EP-52 reuses the context endpoint for post-meeting comparison).

---

### Decision 5: Attendee resolution via `member_aliases` (EP-45 table)

**Chosen**: Resolve meeting attendees to `team_members` entries using the `member_aliases` table before querying messages and action items.

**Why**: Raw attendee names from calendar often differ from message authors (display name vs login vs email prefix). The `member_aliases` table (built by EP-45 `buildAliasesForMember`) already handles this — it's the right hook.

**Fallback**: If no alias match, fall back to substring match on `messages.author`. Better than nothing; avoids returning 0 results for attendees not yet in the alias table.

---

### Decision 6: Meeting-end detection via polling (not OS-level event)

**Chosen**: Add `checkEndedMeetings()` to the existing background sync loop (runs every 15 min). Scans `calendar_events` for rows where `end_time` is in the last 3 hours and no corresponding `meetings` row exists.

**Alternatives rejected**:
- *macOS Calendar alert/script*: requires user to configure a Calendar alert, fragile, out of scope
- *Cron job at fixed time*: too rigid — meetings can end at any time
- *WebSocket/push notification*: no infrastructure for this; overkill for a personal productivity tool

**Guard against re-triggering**: A `data_quality` row is inserted with `detail LIKE 'auto-capture-attempted:{eventId}'` before each scrape attempt. The `checkEndedMeetings` query explicitly excludes events with such a row.

---

### Decision 7: Targeted Teams scrape (not full sync) for post-meeting capture

**Chosen**: New `scrapeSpecificChat(chatName)` method in `TeamsChatScraper` that navigates directly to the matching Teams chat and scrapes only the Recap tab, then returns.

**Why not full sync**: `npm run teams-sync` scrapes all unread chats. A post-meeting scrape is time-sensitive (user wants the transcript within minutes, not the next time all chats are synced). A targeted scrape takes ~15s vs ~3 min for a full sync.

**Chat name matching strategy**: Normalized substring match (`includes()`) for short names; string distance for longer names. Jaro–Winkler avoided to prevent adding a dependency.

**Serialization**: `scrapeSpecificChat` wrapped in `withTeamsLock()` — a new dedicated mutex alongside the existing `withSaturnLock`/`withMyIssuesLock` per-resource locks. `withJiraLock()` does not exist; this amendment corrects the original ADR text.

---

### Decision 8: Topic mapping as suggestions, not auto-applied

**Chosen**: `suggestTopicLinks()` inserts rows into `meeting_topic_links` with `confirmed = 0`. The UI surfaces them as dashed-border chips: `+ Link to: {topic}?`. User click sets `confirmed = 1`.

**Why not auto-apply**: A wrong topic link is worse than a suggestion the user ignores. False positives (e.g., "Daily Standup" meeting linked to topic "Standup testing framework" because "standup" appears in both) would pollute topic notebooks with irrelevant meeting history.

**Confidence threshold**: 0.5 with a minimum of 2 keyword hits required (amended from original 0.3 — analysis showed 0.3 produced too many false positives with common words). Stop-word filtering with minimum word length ≥4 chars reduces noise further.

---

### Decision 9: Action items extracted from transcripts upserted immediately

**Chosen**: After `analyzeMeeting()` returns `actionItems[]`, each item is upserted into `action_items` with `source_message_id = meetingId` (meeting FK) and content hash dedup.

**Why immediately (not on user request)**: Action items from meetings are high-signal. Delaying extraction to a manual step means they sit untracked. The `content_hash` dedup ensures re-running the extraction is idempotent.

**Assignee resolution**: Best-effort. If the action item text contains a name matching a `member_alias`, that alias's `member_id` is used to look up the canonical name. Otherwise, `assignee` is null.

---

### Decision 10: "Paste transcript" CTA uses `sendToChat()` — no new modal

**Chosen**: Alert Rule 5 CTA calls `sendToChat(preparedPrompt)` which opens the chat panel with a pre-written prompt asking the user to paste the transcript.

**Why no dedicated modal**: `sendToChat()` is already wired up (EP-49-10). A custom paste-transcript modal would add ~200 lines for a one-time interaction. The chat panel approach is consistent, requires zero new UI primitives, and naturally leads to the AI extracting decisions and action items from the pasted text.

---

## Consequences

**Positive**:
- Calendar widget reliably shows today's events (bugs fixed)
- Pre-meeting preparation context (attendees, history, open items) available in 2 clicks
- Post-meeting transcripts captured automatically for most Teams meetings
- Action items extracted from meetings without manual effort
- Topics enriched with meeting context without manual linking
- Missing-info alerts are now actionable (paste CTA)

**Negative / Tradeoffs**:
- `scrapeSpecificChat` adds a new browser automation path — needs careful error handling (chat not found, Recap tab absent, Teams offline)
- Topic suggestion accuracy depends on keyword overlap quality — may require tuning threshold in practice
- `checkEndedMeetings` runs on every sync cycle (every 15 min) — adds a small query overhead; acceptable given it's a lightweight SELECT

**Dependencies added**:
- EP-52 scraper logic depends on Teams being open and accessible (same constraint as EP-11)
- `member_aliases` must be populated for best attendee resolution (requires EP-45 to have been run at least once)

---

## Implementation Notes

- `CALENDAR_TTL_MS` fix: `web-server.js` line ~276, next to `SATURN_CACHE_TTL_MS` and `MY_ISSUES_TTL_MS`
- Timezone fix: `src/db/queries/calendar.ts` line 55–57
- `buildMeetingContext()`: new helper function in `web-server.js`, not a service method (pure SQL, no async)
- `suggestTopicLinks()`: add to `src/db/queries/` as `meeting-topics.ts`
- `scrapeSpecificChat()`: new method on `TeamsChatScraper` class in `src/connectors/teams-chats.ts`
- Schema v30: `src/db/schema.ts` migration array, index 29 (0-based) or migration `29 -> 30`
