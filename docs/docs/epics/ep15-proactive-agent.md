---
title: "EP-15: Proactive Intelligence Engine"
sidebar_label: "EP-15: Proactive Intelligence"
---

# EP-15: Proactive Intelligence Engine

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Agent Role** | Backend + Frontend Engineer |
| **Depends On** | [EP-14](./ep14-smart-topic-expert), [EP-26](./ep26-topic-notebooks) |
| **Blocks** | EP-16 |
| **File Scope** | `web-server.js` (edit), `web/src/pages/DashboardPage.tsx` (edit), `web/src/lib/api.ts` (edit), `web/src/components/shared/` (new files) |

## Goal

Transform the system from a **pull dashboard** (you open it, it shows data) into a **push intelligence layer** (it watches, decides what matters, tells you without being asked).

Five concrete capabilities:

1. **Auto-sync loop** — web-server.js continuously runs Teams+Calendar+Jira+Notebooks every 15 min. No manual Sync button needed.
2. **Alert feed** — a pinned list at the top of the dashboard showing what changed since you last looked: overdue items, high-activity topics, imminent meetings.
3. **Workload intensity** — per-topic signal showing message velocity and Jira churn this week vs last week. Answers "how busy is each project right now?"
4. **Pre-meeting briefs** — auto-generated before every calendar event. Available before you even open the app.
5. **Morning brief push** — daily summary delivered to a REST endpoint that EP-16 (n8n) can poll and push to Slack/email on a schedule.

---

## Architecture Decision: web-server.js, not src/server.ts

The original EP-15 spec placed the scheduler inside `src/server.ts` (MCP stdio server). **That was wrong for this use case.**

| | MCP stdio server (`src/server.ts`) | Web bridge (`web-server.js`) |
|---|---|---|
| When does it run? | Only when Claude Desktop is open | Always running (`npm run web:bridge`) |
| Who uses it? | Claude AI assistant | You, directly via the web UI |
| Can it push to UI? | No | Yes — it IS the UI backend |
| Can n8n call it? | No — stdio only | Yes — HTTP endpoints |

All proactive intelligence belongs in `web-server.js`. It is always running. It already has the DB connection, the analyzer, the sync functions. It just needs a timer and the logic to act on data changes.

---

## Tickets

### EP-15-1 — Auto-Sync Loop in web-server.js

**Goal**: web-server.js syncs continuously every 15 minutes without user interaction. Right now it only syncs when you press the button.

**What changes:**
Add to the bottom of `web-server.js`, after the server starts listening:

```javascript
// Auto-sync loop — runs every 15 minutes
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS) || 15 * 60 * 1000;
function scheduleNextSync() {
  setTimeout(async () => {
    if (!syncProgress.running) {
      process.stderr.write(`[AutoSync] Starting scheduled sync\n`);
      await runFullSync();
      generateAlerts(); // EP-15-2 — refresh alert feed after sync
    }
    scheduleNextSync(); // re-schedule after completion
  }, SYNC_INTERVAL_MS);
}
// Run one initial sync shortly after startup, then every interval
setTimeout(() => runFullSync().then(() => generateAlerts()), 60_000);
scheduleNextSync();
```

**Acceptance criteria:**
- [x] `web-server.js` auto-syncs every `SYNC_INTERVAL_MS` ms (default 15 min) without any user action
- [x] Sync skipped if one is already in progress (`syncProgress.running` check)
- [x] No startup sync — server boots fast, seeds alertCache + workloadCache from existing DB immediately; first real sync fires after SYNC_INTERVAL_MS or on manual trigger
- [x] `GET /api/sync/status` continues to reflect auto-sync progress
- [x] Sync loop uses `scheduleNextSync()` recursion (not `setInterval`) so it waits for the previous sync to finish before starting the timer again — no overlap
- [x] `SYNC_INTERVAL_MS` env var respected (enables faster intervals for testing)

**Files:** `web-server.js`

---

### EP-15-2 — Alert Feed

**Goal**: A live feed of what matters right now, generated after every sync. Not a page you visit — a pinned strip at the top of the dashboard.

**What an alert looks like:**
```typescript
interface Alert {
  id: string;          // deterministic hash (prevents duplicates on re-render)
  type: 'overdue' | 'high_activity' | 'meeting_soon' | 'stale_item' | 'new_blocker';
  severity: 'critical' | 'warning' | 'info';
  title: string;       // short, e.g. "3 overdue items in BDS"
  body: string;        // 1 sentence detail
  topic?: string;      // which topic this relates to
  link?: string;       // optional — which page to navigate to
  generatedAt: string; // ISO timestamp
}
```

**Alert rules (pure SQL — no AI needed):**

| Rule | Trigger | Severity |
|------|---------|----------|
| `overdue` | `action_items` WHERE `status != 'completed' AND due_date < today` | critical |
| `stale_item` | `action_items` WHERE `status = 'open' AND source_message created > 3 days ago AND due_date IS NULL` | warning |
| `high_activity` | topic has > 2× average messages/day in last 24h vs 7-day average | warning |
| `meeting_soon` | `calendar_events` starting within 60 min | info |
| `new_blocker` | notebook content contains "blocked" or "blocker" section changed since last check | warning |

**Implementation:**

```javascript
// web-server.js
let alertCache = { alerts: [], generatedAt: null };

function generateAlerts() {
  const alerts = [];
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();

  // Rule 1: overdue action items
  const overdue = db.prepare(
    `SELECT title, assignee, topic_id FROM action_items
     WHERE status != 'completed' AND due_date < ? LIMIT 20`
  ).all(today);
  if (overdue.length > 0) {
    alerts.push({
      id: `overdue-${today}`,
      type: 'overdue', severity: 'critical',
      title: `${overdue.length} overdue action item${overdue.length > 1 ? 's' : ''}`,
      body: overdue.slice(0,3).map(a => a.title).join(', ') + (overdue.length > 3 ? '…' : ''),
      link: '/action-items',
      generatedAt: now.toISOString(),
    });
  }

  // Rule 2: stale open items (open > 3 days, no due date)
  const stale = db.prepare(
    `SELECT ai.title FROM action_items ai
     LEFT JOIN messages m ON ai.source_message_id = m.id
     WHERE ai.status = 'open' AND ai.due_date IS NULL
       AND (m.timestamp < datetime('now', '-3 days') OR m.timestamp IS NULL)
     LIMIT 10`
  ).all();
  if (stale.length > 0) {
    alerts.push({
      id: `stale-${today}`,
      type: 'stale_item', severity: 'warning',
      title: `${stale.length} action item${stale.length > 1 ? 's' : ''} stale for 3+ days`,
      body: stale.slice(0,2).map(a => a.title).join(', ') + (stale.length > 2 ? '…' : ''),
      link: '/action-items',
      generatedAt: now.toISOString(),
    });
  }

  // Rule 3: high-activity topics
  const topics = db.prepare(`SELECT id, name FROM topics`).all();
  for (const topic of topics) {
    const last24h = db.prepare(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE topic_id = ? AND timestamp >= datetime('now', '-1 day')`
    ).get(topic.id).cnt;
    const avg7d = db.prepare(
      `SELECT COUNT(*) / 7.0 as avg FROM messages
       WHERE topic_id = ? AND timestamp >= datetime('now', '-7 days')`
    ).get(topic.id).avg;
    if (avg7d > 2 && last24h > avg7d * 2) {
      alerts.push({
        id: `activity-${topic.name}-${today}`,
        type: 'high_activity', severity: 'warning',
        title: `High activity in ${topic.name}`,
        body: `${last24h} messages today vs ${Math.round(avg7d)} daily average`,
        topic: topic.name,
        link: '/teams-updates',
        generatedAt: now.toISOString(),
      });
    }
  }

  // Rule 4: meetings in next 60 min
  const soon = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const upcoming = db.prepare(
    `SELECT title, start_time FROM calendar_events
     WHERE start_time > ? AND start_time <= ?
     ORDER BY start_time ASC LIMIT 3`
  ).all(now.toISOString(), soon);
  for (const ev of upcoming) {
    const minsAway = Math.round((new Date(ev.start_time) - now) / 60000);
    alerts.push({
      id: `meeting-${ev.start_time}`,
      type: 'meeting_soon', severity: 'info',
      title: `Meeting in ${minsAway} min: ${ev.title}`,
      body: 'Pre-brief available in Topic Expert',
      link: '/topic-expert',
      generatedAt: now.toISOString(),
    });
  }

  // Sort: critical first, then warning, then info
  const order = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity]);
  alertCache = { alerts, generatedAt: now.toISOString() };
}

// Endpoint
// GET /api/alerts → returns { alerts, generatedAt }
```

**Frontend — `AlertFeed` component on DashboardPage:**

```
┌──────────────────────────────────────────────────────────────────┐
│ 🔴 3 overdue action items          → Action Items               │
│ 🟡 High activity in BDS (12 msgs today vs 4 avg)  → Teams       │
│ 🔵 Meeting in 23 min: Sprint Planning             → Topic Expert │
└──────────────────────────────────────────────────────────────────┘
```

- Appears at the very top of the dashboard, above DailySummarySection
- Hidden when empty (no alerts)
- Each alert is a clickable row that navigates to `link`
- Color-coded dot by severity: red=critical, amber=warning, blue=info
- Auto-refreshes every 5 minutes via `refetchInterval`
- `GET /api/alerts` — no AI, fast, generated after every sync

**Acceptance criteria:**
- [x] `generateAlerts()` runs at end of every `runFullSync()` call
- [x] `GET /api/alerts` returns `{ alerts: Alert[], generatedAt: string }`
- [x] All 4 rules implemented (overdue, stale, high_activity, meeting_soon)
- [x] `AlertFeed` component renders above `DailySummarySection` on Dashboard
- [x] Hides itself when alerts array is empty
- [x] Severity dot colors: red / amber / blue
- [x] Each row navigates to `link` on click
- [x] Query: `refetchInterval: 5 * 60 * 1000`

**Files:** `web-server.js`, `web/src/lib/api.ts`, `web/src/components/shared/AlertFeed.tsx`, `web/src/pages/DashboardPage.tsx`

---

### EP-15-3 — Workload Intensity Dashboard Section

**Goal**: Per-topic widget showing whether work is ramping up, steady, or slowing down. Pure SQL — no AI.

**Metrics computed per topic:**

| Metric | SQL | What it tells you |
|---|---|---|
| Messages this week | COUNT WHERE timestamp >= 7 days ago | Volume of communication |
| Messages last week | COUNT WHERE timestamp between 7-14 days ago | Trend comparison |
| Jira opened this sprint | COUNT issues WHERE created >= sprint start | New work arriving |
| Jira closed this sprint | COUNT issues WHERE status changed to Done | Work leaving |
| Open action items | COUNT WHERE status != completed | Backlog pressure |
| Overdue items | COUNT WHERE due_date < today AND status != completed | Risk signal |

**Intensity score** (simple formula, no AI):
```
score = (messages_this_week / max(messages_last_week, 1)) 
      + (jira_opened / max(jira_closed, 1))
      + (overdue_count * 2)
```

Score bucketed: `< 1.5` = calm, `1.5–3` = active, `> 3` = intense

**API:**
```javascript
// GET /api/workload
// Returns:
{
  topics: [{
    name: string,
    messagesThisWeek: number,
    messagesLastWeek: number,
    messageTrend: 'up' | 'down' | 'steady',  // >20% change = up/down
    openActionItems: number,
    overdueItems: number,
    intensity: 'calm' | 'active' | 'intense',
    intensityScore: number,
  }],
  generatedAt: string,
}
```

**Frontend — `WorkloadSection` component:**

```
┌─────────────────────────────────────────────────────────────────┐
│  Workload Intensity                                             │
├──────────────┬──────────────┬──────────────┬────────────────────┤
│  BDS         │  KBA         │  INFRA       │                    │
│  🔴 INTENSE  │  🟡 ACTIVE   │  🟢 CALM     │                    │
│  47 msgs ↑   │  23 msgs →   │  8 msgs ↓    │                    │
│  3 overdue   │  1 overdue   │  0 overdue   │                    │
│  12 open     │  5 open      │  2 open      │                    │
└──────────────┴──────────────┴──────────────┴────────────────────┘
```

- One card per topic, side by side
- Color-coded intensity badge: red=intense, amber=active, green=calm
- Trend arrow on message count: ↑ ↓ →
- Placed between AlertFeed and DailySummarySection on Dashboard
- `staleTime: 10 * 60 * 1000` (recomputed after each sync, not on every render)

**Acceptance criteria:**
- [x] `GET /api/workload` returns per-topic metrics as above
- [x] `messageTrend` computed: >20% increase = 'up', >20% decrease = 'down', else 'steady'
- [x] `intensity` bucketed from score formula
- [x] `WorkloadSection` renders on Dashboard with one card per topic
- [x] Cards show intensity badge, message count with trend arrow, open/overdue counts
- [x] No AI calls — pure SQL + arithmetic

**Files:** `web-server.js`, `web/src/lib/api.ts`, `web/src/components/shared/WorkloadSection.tsx`, `web/src/pages/DashboardPage.tsx`

---

### EP-15-4 — Pre-Meeting Briefs (Auto-generated)

**Goal**: For every meeting in `calendar_events` in the next 24 hours, automatically generate a brief from the topic notebooks. When you open the dashboard before a meeting, it's already there.

**How it works:**

During `runFullSync()`, after notebooks are updated:

```javascript
// Step 5: generate pre-meeting briefs for events in next 24h
syncProgress.currentTopic = 'Pre-meeting briefs';
const upcomingMeetings = db.prepare(
  `SELECT id, title, attendees, start_time FROM calendar_events
   WHERE start_time > datetime('now')
     AND start_time <= datetime('now', '+24 hours')
     AND pre_brief IS NULL`  // don't regenerate if already done
).all();

for (const meeting of upcomingMeetings) {
  const brief = await generatePreBrief(meeting, db, analyzer);
  db.prepare(
    `UPDATE calendar_events SET pre_brief = ? WHERE id = ?`
  ).run(brief, meeting.id);
}
```

**`generatePreBrief(meeting, db, analyzer)`:**
1. Extract keywords from meeting title
2. FTS search across messages for those keywords (last 30 days)
3. Find matching notebook (if any topic name appears in title)
4. Call `analyzer.chatWithContext()` with prompt:
   > "I have a meeting called '\{title\}' in \{X\} hours with \{attendees\}. Based on the context below, give me: (1) what was previously discussed on this topic, (2) any open items or blockers I should know about, (3) 3 suggested questions to raise."
5. Store result in `calendar_events.pre_brief` column

**Schema change** — add column to `calendar_events`:
```sql
ALTER TABLE calendar_events ADD COLUMN pre_brief TEXT;
-- Migration 12 → 13
```

**API:**
```javascript
// GET /api/calendar/upcoming already exists — extend response
// Add pre_brief field to each event if available
{ 
  events: [{
    id, title, start_time, end_time, attendees,
    pre_brief: string | null,   // NEW
  }]
}
```

**Frontend — `TodaysCalendarSection` update:**
- Each event row gets an expand arrow
- Expanding shows the pre-brief as a collapsible `MarkdownPanel`
- Badge "Brief ready" shown when `pre_brief !== null`
- If no brief yet: shows "Generating..." if meeting is within 6h, else nothing

**Acceptance criteria:**
- [x] `calendar_events` table has `pre_brief TEXT` column (migration 13→14)
- [x] `runFullSync()` step 5 generates briefs for events in next 24h
- [x] Brief only generated once per event (skipped if `pre_brief IS NOT NULL`)
- [x] Force regeneration: `POST /api/calendar/events/:id/regenerate-brief`
- [x] `GET /api/calendar/upcoming` includes `pre_brief` field
- [x] `TodaysCalendarSection` shows expand row with `MarkdownPanel` for brief
- [x] "Brief ready" badge on events that have a brief
- [x] Generation runs in background during sync — doesn't block sync completion

**Files:** `web-server.js`, `web/src/lib/api.ts`, `web/src/components/shared/TodaysCalendarSection.tsx`, `src/db/schema.ts`

---

### EP-15-5 — Morning Brief Push Endpoint

**Goal**: A stable REST endpoint that EP-16 (n8n) can call on a schedule to get today's brief and push it to Slack/email. The endpoint itself doesn't deliver — delivery is EP-16's job. EP-15 owns generation and caching.

**What this ticket adds** beyond the existing `GET /api/daily-summary`:

1. The daily summary currently only includes yesterday's messages and open action items. Extend it to include:
   - Workload intensity snapshot (which topics are hot today)
   - Alerts snapshot (what's overdue, what's changed)
   - Today's calendar events with pre-briefs if available
   - Jira sprint delta (tickets opened vs closed since last brief)

2. A dedicated endpoint with consistent format for machine consumption:

```javascript
// GET /api/morning-brief
// Response:
{
  date: string,                    // YYYY-MM-DD
  cached: boolean,
  generatedAt: string,
  sections: {
    summary: string,               // AI narrative (from daily-summary)
    alerts: Alert[],               // from alertCache
    workload: WorkloadTopic[],     // from /api/workload
    calendar: CalendarEvent[],     // today's events with pre_brief
    priorities: ActionItem[],      // top 5 open/overdue items
    sprintDelta: {                 // Jira changes since yesterday
      opened: number,
      closed: number,
      net: number,                 // opened - closed (positive = backlog growing)
    }
  },
  // Slack-ready: pre-formatted markdown for direct posting
  slackMarkdown: string,
}
```

3. `slackMarkdown` field — pre-formatted for Slack's mrkdwn syntax so n8n can post it directly without transformation:
```
*🌅 Morning Brief — Thursday 17 April*
━━━━━━━━━━━━━━━━━━━━━
*Yesterday:* BDS had 12 messages. Sprint planning completed...
*🔴 Overdue:* 3 action items past due → <http://localhost:5175/action-items|View>
*📊 Workload:* BDS 🔴 intense • KBA 🟡 active • INFRA 🟢 calm
*📅 Today:* Sprint Review at 14:00 • 1:1 with Alex at 15:30
*⚠️ Sprint:* +3 tickets opened, +1 closed (backlog growing)
━━━━━━━━━━━━━━━━━━━━━
```

**Acceptance criteria:**
- [x] `GET /api/morning-brief` returns full structured response as above
- [x] Cached for 1 hour (same as daily-summary) under `__morning_brief__` in digests
- [x] `?refresh=true` query param forces regeneration
- [x] `slackMarkdown` field populated with Slack-formatted string
- [x] `sprintDelta` computed from jira message counts (opened in last 24h)
- [x] All sections populated even if some data is missing (graceful nulls)
- [x] Existing `GET /api/daily-summary` unchanged (backward compatible)

**Files:** `web-server.js`, `web/src/lib/api.ts`

---

## Definition of Done

- [x] `npm run typecheck` (web) passes
- [x] web-server.js auto-syncs every 15 min with no user action
- [x] Dashboard shows AlertFeed at top with at least overdue + meeting-soon alerts
- [x] Dashboard shows WorkloadSection with per-topic intensity
- [x] Pre-meeting briefs generated for today's events after Sync All
- [x] `GET /api/morning-brief` returns all 6 sections + slackMarkdown
- [x] All new endpoints return data within 200ms (no AI on hot path except brief generation which is cached)
- [x] Auto-sync loop runs correctly after server restart

---

## Dashboard layout after EP-15

```
┌──────────────────────────────────────────────────┐
│  🔴 3 overdue items   🟡 High activity in BDS    │  ← AlertFeed (EP-15-2)
├──────────────────────────────────────────────────┤
│  BDS 🔴 INTENSE  │  KBA 🟡 ACTIVE  │  INFRA 🟢  │  ← WorkloadSection (EP-15-3)
├──────────────────────────────────────────────────┤
│  Daily Summary (accordion)                       │  ← DailySummarySection (existing)
├──────────────────────────────────────────────────┤
│  Action Items  │  Calendar (with pre-briefs ✨)  │  ← existing + EP-15-4
├──────────────────────────────────────────────────┤
│  Saturn Board  │  My Jira Issues                 │  ← existing
└──────────────────────────────────────────────────┘
```
