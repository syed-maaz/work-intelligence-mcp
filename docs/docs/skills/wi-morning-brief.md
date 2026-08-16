---
sidebar_label: "wi-morning-brief"
---

# /wi-morning-brief

Generate your morning briefing: today's calendar with context, your open Jira issues, overnight Teams activity, and open action items — all in one command.

## Usage

```
/wi-morning-brief
```

No arguments needed.

## What It Does

Fetches four data sources in parallel and composes a briefing:

| Source | Endpoint | What You See |
|--------|----------|-------------|
| Calendar | `/api/calendar/upcoming` | Today's meetings with attendee context |
| My Jira Issues | `/api/jira/my-issues` | Assigned tickets with status and days stuck |
| Action Items | `/api/action-items?assignee=me` | Open items with due dates |
| Morning Brief | `/api/morning-brief` | Pre-computed overnight activity summary |

## Output

```
## Morning Brief — Saturday, May 17

### Today's Calendar
09:00  BDS Sprint Standup (30 min)
       Attendees: Alice, Bob, Charlie
       Context: PROJ-15257 was active in Teams yesterday — likely agenda item

11:00  Architecture Review (60 min)
       Attendees: Alice, Dave
       ⚠️ Starting in 58 minutes — run: /wi-pre-meeting architecture review

### My Open Issues (4)
PROJ-15257  Recommended Links not showing   In Progress  (3 days)  ⚠️ stuck
PROJ-15301  Auth timeout on slow networks   In Progress  (1 day)
PROJ-15189  Upgrade React to 18.3           To Do        (5 days)
PROJ-15240  PR: fix calendar timezone bug   In Review    (2 days)

### Open Action Items (3)
• Review Alex's PR for PROJ-15240 (overdue by 1 day) — from Teams: #bds-dev
• Add missing test for auth timeout path — from Jira: PROJ-15301
• Confirm feature freeze date with PM — from meeting: Sprint Planning May 12

### Overnight Activity
No high-priority alerts. 14 new Teams messages across 3 chats.
```

## Pre-Meeting Hints

For any meeting starting within 2 hours, the brief offers a one-click follow-up:
```
/wi-pre-meeting <meeting-name>
```

## Prerequisites

- Bridge running: `npm run web:bridge`
- Calendar synced (Outlook + macOS Calendar)
- Jira my-issues cache populated (auto-refreshes every hour)

## Related

- [`/wi-pre-meeting`](./wi-pre-meeting) — Full context card for a specific meeting
- [`/wi-action-items`](./wi-action-items) — Filtered action items view
- [`/wi-daily-digest`](./wi-daily-digest) — Deeper digest per topic
