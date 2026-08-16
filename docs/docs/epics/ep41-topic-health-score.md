---
sidebar_position: 41
title: EP-41 Topic Health Score
---

# EP-41: Topic Health Score

| Field | Value |
|-------|-------|
| **Status** | ✅ Done |
| **Priority** | High |
| **Complexity** | Small (< 1 day) |
| **Blocked By** | None |
| **Schema version** | No change — pure SQL |

## Summary

Each topic gets a single health score (0–1) computed from existing data: message recency, activity ratio, action item completion rate, and meeting transcript coverage. Displayed as a colored badge on the Topics page and in the dashboard NeedsAttention widget. Zero new tables — pure SQL aggregation.

## Decisions Made

- **No new table** — computed on-the-fly via SQL VIEW, not stored. Fast enough at this scale.
- **Four components** (equal weight 0.25 each): recency, activity ratio, completion rate, transcript coverage.
- **Color thresholds**: green ≥ 0.7, yellow 0.4–0.69, red < 0.4.
- **Surface in NeedsAttentionSection** — red/yellow topics automatically appear as alerts.

---

## EP-41-1: Health Score SQL View

### Add to `src/db/queries.ts`

```typescript
export interface TopicHealth {
  topic_name: string;
  health_score: number;       // 0–1
  recency_score: number;      // days since last message (decay)
  activity_ratio: number;     // last 7d messages / last 30d messages
  completion_rate: number;    // done action items / total
  transcript_coverage: number; // meetings with transcript / total meetings
  color: 'green' | 'yellow' | 'red';
}

export function getTopicHealthScores(db: Database): TopicHealth[]
```

```sql
-- SQL backing the function
WITH topic_stats AS (
  SELECT
    t.name AS topic_name,
    -- Recency: 1.0 if active today, decays over 30 days
    MAX(0, 1.0 - (julianday('now') - julianday(MAX(m.timestamp))) / 30.0) AS recency_score,
    -- Activity: ratio of last-7d messages to last-30d messages
    CAST(COUNT(CASE WHEN m.timestamp >= date('now', '-7 days') THEN 1 END) AS REAL) /
      MAX(1, COUNT(CASE WHEN m.timestamp >= date('now', '-30 days') THEN 1 END)) AS activity_ratio,
    -- Completion: done / total action items
    CAST(COUNT(CASE WHEN ai.status = 'done' THEN 1 END) AS REAL) /
      MAX(1, COUNT(ai.id)) AS completion_rate,
    -- Transcript coverage: meetings with transcript / total meetings
    CAST(COUNT(CASE WHEN length(mt.transcript) > 100 THEN 1 END) AS REAL) /
      MAX(1, COUNT(mt.id)) AS transcript_coverage
  FROM topics t
  LEFT JOIN messages m ON m.topic_id = t.id
  LEFT JOIN action_items ai ON ai.topic_id = t.id
  LEFT JOIN meetings mt ON mt.topic_id = t.id
  GROUP BY t.id
)
SELECT
  topic_name,
  (recency_score + activity_ratio + completion_rate + transcript_coverage) / 4.0 AS health_score,
  recency_score, activity_ratio, completion_rate, transcript_coverage
FROM topic_stats
ORDER BY health_score ASC
```

---

## EP-41-2: API Endpoint

### Add to `web-server.js`

```javascript
// GET /api/topics/health
// Returns health scores for all topics
app.get('/api/topics/health', (req, res) => {
  const scores = getTopicHealthScores(db);
  res.json({ topics: scores });
});
```

---

## EP-41-3: UI Badge

### Update `web/src/pages/TopicsPage.tsx`

Add colored health badge next to each topic name:

```tsx
const colorMap = { green: 'var(--success)', yellow: 'var(--warning)', red: 'var(--error)' };

<span style={{
  display: 'inline-block',
  width: 8, height: 8, borderRadius: '50%',
  backgroundColor: colorMap[topic.color],
  marginRight: 6
}} title={`Health: ${(topic.health_score * 100).toFixed(0)}%`} />
```

Also wire into `NeedsAttentionSection` — red topics automatically surface as alerts.

---

## Key Code Locations

| File | Change |
|------|--------|
| `src/db/queries.ts` | Add `getTopicHealthScores()` + `TopicHealth` interface |
| `web-server.js` | Add `GET /api/topics/health` endpoint |
| `web/src/pages/TopicsPage.tsx` | Add colored health badge |
| `web/src/lib/api.ts` | Add `topicHealth: () => request('/topics/health')` |

## Acceptance Criteria

- [x] `getTopicHealthScores()` returns correct scores for all topics
- [x] Health score is 0–1, color threshold applied correctly
- [x] `GET /api/topics/health` returns JSON array
- [x] Colored dot badge visible on Topics page
- [x] Red/yellow topics appear in NeedsAttentionSection
- [x] TypeScript builds clean
