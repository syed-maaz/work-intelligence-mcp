---
sidebar_position: 38
title: EP-38 Weekly Pattern Analysis
---

# EP-38: Weekly Pattern Analysis

| Field | Value |
|-------|-------|
| **Status** | ✅ Done |
| **Priority** | Medium |
| **Complexity** | Medium (2–3 days) |
| **Blocked By** | EP-32 ✅ (Token Tracking — embed cost tracking in weekly report); EP-33 helpful but not required |
| **Schema version** | No change (uses existing tables) |

## Summary

Once 4+ weeks of data exist, a simple weekly AI analysis over aggregated DB stats produces genuine team health insights that no single query surfaces. This is a high-signal, low-token operation: Claude analyzes pre-aggregated stats (not raw messages), so it's cheap and fast.

Weekly report covers:
- Topics with the most unresolved questions (stagnation signal)
- Action items chronically overdue (accountability signal)
- Meetings with no action items generated (wasted meeting signal)
- Topics with abnormally high or low message volume vs. 4-week average (surge/silence signal)
- Sprint-over-sprint change in open vs. closed Jira issues

The report is stored in `digests` (same pattern as daily digest) and cached for 7 days.

## Decisions Made

- **Aggregate in SQL first, then send stats to Claude** — never send raw messages; Claude receives a structured JSON summary of the week's stats. Keeps token cost under 2k input tokens.
- **Store in `digests` table** under `topic_name = '__weekly_report__'` — reuses existing cache + expiry infrastructure
- **Trigger manually OR via `/api/weekly-report`** — no automatic cron initially; user generates on demand
- **Separate from daily summary** — daily = yesterday's actions; weekly = 4-week trend analysis
- **4-week rolling window** — always compares current week to prior 3 weeks for trend lines

## SQL Aggregation Queries (pre-computed before AI call)

```sql
-- Unresolved questions per topic, last 4 weeks
SELECT topic_id, t.name, COUNT(*) as open_questions
FROM questions q JOIN topics t ON q.topic_id = t.id
WHERE q.status = 'open' AND q.asked_date >= date('now', '-28 days')
GROUP BY topic_id ORDER BY open_questions DESC;

-- Overdue action items (due_date passed, still open)
SELECT t.name, COUNT(*) as overdue_count,
       MIN(due_date) as oldest_overdue
FROM action_items a JOIN topics t ON a.topic_id = t.id
WHERE a.status = 'open' AND a.due_date < date('now') AND a.due_date IS NOT NULL
GROUP BY a.topic_id ORDER BY overdue_count DESC;

-- Meetings with no action items (last 28 days)
SELECT m.title, m.date, t.name as topic_name
FROM meetings m JOIN topics t ON m.topic_id = t.id
LEFT JOIN action_items a ON a.source_message_id IN (
  SELECT id FROM messages WHERE topic_id = m.topic_id
  AND timestamp BETWEEN m.date AND datetime(m.date, '+2 hours')
)
WHERE m.date >= date('now', '-28 days') AND a.id IS NULL
ORDER BY m.date DESC;

-- Per-topic message volume: this week vs 4-week average
SELECT t.name,
  COUNT(CASE WHEN m.timestamp >= date('now', '-7 days') THEN 1 END) as this_week,
  COUNT(*) / 4.0 as four_week_avg
FROM messages m JOIN topics t ON m.topic_id = t.id
WHERE m.timestamp >= date('now', '-28 days')
GROUP BY m.topic_id;
```

## AI Call — `src/services/analyzer.ts`

New method `generateWeeklyReport()`:

```typescript
async generateWeeklyReport(stats: WeeklyStats): Promise<string>

interface WeeklyStats {
  weekEnding: string;
  topicsWithOpenQuestions: Array<{ topicName: string; count: number }>;
  overdueActionItems: Array<{ topicName: string; count: number; oldestDue: string }>;
  meetingsWithNoActions: Array<{ title: string; date: string; topicName: string }>;
  messageVolumeByTopic: Array<{ topicName: string; thisWeek: number; fourWeekAvg: number }>;
  jiraSnapshot?: { openIssues: number; closedThisWeek: number; newThisWeek: number };
}
```

Prompt style: structured JSON stats → Claude writes a concise Markdown report with a "Health Summary" header, per-section bullet points, and a "Top 3 Actions" recommendation list at the bottom.

Model: `DIGEST_MODEL` (Sonnet). Estimated input: ~1,500 tokens. Output: ~800 tokens. Cost: ~$0.02/report.

## New Endpoint — `web-server.js`

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/weekly-report` | `{ markdown: string; generated_at: string; cached: boolean }` |
| GET | `/api/weekly-report?force=true` | Force regenerate even if cached |

Implementation pattern identical to `/api/morning-brief`: check `digests` table for `__weekly_report__` with `expires_at > now`; if cached, return; otherwise run SQL aggregations → AI call → save to `digests` with 7-day expiry.

## New Page — `web/src/pages/WeeklyReportPage.tsx`

Route: `/weekly-report` (add to Sidebar nav).

Layout:
```
┌─────────────────────────────────────────────────┐
│  Weekly Report   week of Apr 14                 │
│                            [↻ Regenerate]        │
├─────────────────────────────────────────────────┤
│  [MarkdownPanel rendering the report]           │
│                                                 │
│  Health Summary                                 │
│  • BDS: 4 overdue items, surge in messages +40% │
│  • Auth: 3 open questions stagnant >14 days     │
│                                                 │
│  Top 3 Actions                                  │
│  1. Review BDS overdue items...                 │
└─────────────────────────────────────────────────┘
```

## Key Code Locations

| File | Change |
|------|--------|
| `src/services/analyzer.ts` | Add `generateWeeklyReport(stats)` method |
| `src/db/queries.ts` | Add `getWeeklyStats()` — runs the 4 aggregation queries, returns `WeeklyStats` |
| `web-server.js` | Add `/api/weekly-report` endpoint (digest cache pattern) |
| `web/src/pages/WeeklyReportPage.tsx` | NEW |
| `web/src/lib/api.ts` | Add `getWeeklyReport()` |
| `web/src/components/shell/Sidebar.tsx` | Add Weekly Report nav item |

## Acceptance Criteria

- [ ] `getWeeklyStats()` runs 4 SQL aggregation queries and returns structured stats
- [ ] `generateWeeklyReport()` produces Markdown report from stats JSON
- [ ] Report covers: open questions, overdue items, empty meetings, volume anomalies
- [ ] Report cached in `digests` for 7 days; served from cache on repeat requests
- [ ] `/api/weekly-report?force=true` bypasses cache
- [ ] WeeklyReportPage renders at `/weekly-report`
- [ ] TypeScript builds clean
