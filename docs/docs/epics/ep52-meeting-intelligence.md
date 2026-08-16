---
sidebar_position: 52
title: EP-52 Meeting Intelligence (Auto Transcript + Topic Mapping)
---

# EP-52: Meeting Intelligence — Auto Transcript Capture, Topic Mapping & Missing-Info Alerts

| Field | Value |
|-------|-------|
| **Sprint** | 10 |
| **Status** | ✅ Done (2026-04-20) |
| **Priority** | High |
| **Schema** | v30 — `meeting_topic_links` join table + `meetings.auto_captured` flag |
| **Depends On** | EP-51 ✅ (context endpoint), EP-11 ✅ (teams scraper), EP-15 ✅ (alert engine), EP-45 ✅ (aliases) |
| **Blocks** | — |

---

## Problem

Meeting transcripts currently require manual intervention: a developer must run `npm run teams-sync`, which scrapes **all** unread Teams chats. This is too coarse and too slow for the post-meeting workflow:

1. **Capture latency**: transcript arrives hours or days after the meeting ends, if at all
2. **No automatic topic linkage**: transcripts land in `meetings` table with `topic_id = 0` (unassigned) — they are never connected to the relevant topic unless a human manually edits them
3. **No action item extraction**: the `AIAnalyzer.analyzeMeeting()` method produces `actionItems[]` but they are never upserted into `action_items` table after a scrape
4. **Missing-info alerts are passive**: Rule 5 in `generateAlerts()` detects missing transcripts but provides no path to resolution — just a warning badge with no "paste transcript" affordance in the UI
5. **No meeting-end trigger**: there is no mechanism to detect that a calendar event ended and initiate post-meeting intelligence

---

## Decisions Made

See [ADR-010](../adr/adr-010-meeting-intelligence) for full rationale. Key decisions:

| # | Decision | Why |
|---|----------|-----|
| D7 | Meeting-end detection via calendar polling, not system event | No OS hook available; calendar events have `end_time`; polling every 5 min is sufficient |
| D8 | Targeted Teams scrape by chat name match (not full sync) | Full sync is expensive (all unread chats); targeted scrape hits only the matching chat |
| D9 | Topic mapping via FTS keyword matching against `topics.name`, surfaced as suggestion (not auto-applied) | Auto-applying a wrong topic link is worse than showing a suggestion user must confirm |
| D10 | Action items extracted from transcript upserted with `source_message_id = meetings.id` | Reuses existing `action_items` schema; FK allows tracing item back to its meeting |
| D11 | "Paste transcript" CTA opens chat panel with pre-injected instruction | Consistent with EP-49-10 chat injection pattern; avoids a new modal |
| D12 | `meetings.auto_captured` flag tracks which meetings were captured automatically vs manually | Allows filtering, debugging, and future analytics without a separate table |

---

## Acceptance Criteria

### Schema Migration v30 (EP-52-0)

- [x] `meeting_topic_links` join table created:
  ```sql
  CREATE TABLE meeting_topic_links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    topic_id   INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    confidence REAL NOT NULL DEFAULT 0.0,  -- 0.0–1.0 from FTS score
    confirmed  INTEGER NOT NULL DEFAULT 0, -- 1 = user confirmed
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(meeting_id, topic_id)
  );
  CREATE INDEX IF NOT EXISTS idx_meeting_topic_links_meeting ON meeting_topic_links(meeting_id);
  CREATE INDEX IF NOT EXISTS idx_meeting_topic_links_topic ON meeting_topic_links(topic_id);
  ```
- [x] `meetings` table gains `auto_captured INTEGER NOT NULL DEFAULT 0` column (ALTER TABLE)
- [x] Schema version bumped to 30 in `src/db/schema.ts`

### Meeting-End Detection (EP-52-1)

- [x] On each background sync cycle (every 15 min), a new `checkEndedMeetings()` function runs
- [x] Logic: find calendar events where `end_time < datetime('now')` AND `end_time > datetime('now', '-3 hours')` (ended in last 3 hours)
- [x] For each ended event: check if a `meetings` row exists with matching title/date (within ±1 day)
- [x] If no matching meeting row: trigger `captureTranscriptForEvent(event)` (fire-and-forget)
- [x] Guard: `captureTranscriptForEvent` records a `data_quality` row on attempt start — prevents re-triggering if scrape already attempted

### Targeted Teams Scrape (EP-52-2)

- [x] New function `TeamsChatScraper.scrapeSpecificChat(chatName: string)` in `src/connectors/teams-chats.ts`
- [x] Logic: open Teams, scroll sidebar, find chat whose name fuzzy-matches `chatName` (Jaro–Winkler ≥ 0.85 or `includes` for short names), click it, scrape Recap tab only
- [x] Returns `{ transcript: string | null; summary: string | null; decisions: string[]; actionItems: string[] }` or null if chat not found
- [x] If no matching chat found: logs a `data_quality` warning (not an error — meeting may not have been on Teams)
- [x] `scrapeSpecificChat` is wrapped in `withJiraLock()` to prevent concurrent browser sessions

### Transcript → Meetings DB (EP-52-3)

- [x] After successful scrape, upsert into `meetings` table with `auto_captured = 1`
- [x] `source_id` = `sha256(eventId + ':' + startTime).slice(0, 16)` for deduplication
- [x] Trigger `AIAnalyzer.analyzeMeeting()` on the transcript text
- [x] Meeting summary, topics, decisions, actionItems all persisted

### Auto Action Item Extraction (EP-52-4)

- [x] After meeting analysis, for each `actionItem` string from `analyzeMeeting()` result:
  - Check `action_items` table for content_hash collision (dedup guard)
  - If new: INSERT with `source_message_id = meetings.id`, `status = 'pending'`
  - Attempt assignee resolution: if action item text contains a known alias (`member_aliases`), set `assignee`
- [x] Action items from auto-captured meetings are tagged in `action_items.description` with `[auto from meeting: {title}]`
- [x] New items are surfaced in the next `generateAlerts()` run as priority items if `due_date` is within 48h

### Smart Topic Mapping (EP-52-5)

- [x] After analysis, run `suggestTopicLinks(meetingId)` which:
  1. Extracts top-10 keywords from `transcript + summary` via TF-IDF (simple word frequency, stop-word filtered)
  2. For each keyword, FTS-searches `topics.name` and `topic_notebooks.content`
  3. Scores each topic by sum of BM25 hits
  4. Inserts into `meeting_topic_links` with `confirmed = 0` for any topic scoring above threshold (0.3)
- [x] `GET /api/meetings/:id/topic-suggestions` returns unconfirmed links for UI display
- [x] `POST /api/meetings/:id/topic-links` body `{ topicId, confirmed: true }` confirms or creates a link
- [x] `DELETE /api/meetings/:id/topic-links/:topicId` removes a link

### Missing-Info Alert Enhancement (EP-52-6)

- [x] Alert Rule 5 (missing transcript) upgraded:
  - Current: generic alert "meeting has no transcript"
  - New: alert includes attendee names, meeting title, formatted time, and a `cta` field
  - `cta = { label: "Paste transcript", action: "chat", prompt: "I want to add a transcript for the meeting '{title}' on {date}. The attendees were: {attendees}. Please help me extract key points, decisions, and action items from the transcript I'm about to paste." }`
- [x] Alert `cta` field rendered in `AlertFeed` as a clickable button that calls `sendToChat(cta.prompt)`
- [x] If `auto_captured` scrape was attempted but transcript is empty, alert shows "Auto-capture failed — paste manually" instead of generic message

### UI: Meeting Context + Topic Links (EP-52-7)

- [x] `RecentMeetingsWidget` shows topic chips on each meeting row (from `meeting_topic_links WHERE confirmed = 1`)
- [x] Unconfirmed suggestions shown with dashed border chip: `+ Link to: {topic}?` — clicking confirms the link
- [x] Meeting row click expands to show: summary | decisions | action items extracted | topic links
- [x] "View in Teams" link icon if `meetings.chat_name` is present (opens `https://teams.microsoft.com/` search)

---

## Code Shapes

### Schema DDL (src/db/schema.ts — migration 29→30)

```typescript
// Migration 29 -> 30: Meeting topic links + auto-capture flag
() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meeting_topic_links (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      topic_id   INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      confidence REAL NOT NULL DEFAULT 0.0,
      confirmed  INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(meeting_id, topic_id)
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_topic_links_meeting ON meeting_topic_links(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_meeting_topic_links_topic ON meeting_topic_links(topic_id);
    ALTER TABLE meetings ADD COLUMN auto_captured INTEGER NOT NULL DEFAULT 0;
  `);
  db.prepare('INSERT OR REPLACE INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '30');
},
```

### Meeting-end detection in sync loop (web-server.js)

```javascript
async function checkEndedMeetings() {
  const ended = db.prepare(`
    SELECT ce.* FROM calendar_events ce
    WHERE ce.end_time < datetime('now', 'localtime')
      AND ce.end_time > datetime('now', 'localtime', '-3 hours')
      AND ce.is_all_day = 0
      AND NOT EXISTS (
        SELECT 1 FROM meetings m
        WHERE m.source_id = 'auto:' || ce.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM data_quality dq
        WHERE dq.detail LIKE '%auto-capture-attempted:' || ce.id || '%'
      )
  `).all();

  for (const event of ended) {
    // Mark attempt to prevent re-triggering
    db.prepare(`INSERT INTO data_quality (rule, severity, detail) VALUES (?, ?, ?)`)
      .run('auto-transcript', 'warning', `auto-capture-attempted:${event.id} title:${event.title}`);
    // Fire and forget
    captureTranscriptForEvent(event).catch(err =>
      process.stderr.write(`[AutoCapture] Failed for event ${event.id}: ${err.message}\n`)
    );
  }
}
```

### Topic suggestion query

```typescript
export function suggestTopicLinks(db: Database.Database, meetingId: number): void {
  const meeting = db.prepare('SELECT transcript, summary, title FROM meetings WHERE id = ?').get(meetingId);
  if (!meeting) return;

  const text = [meeting.title, meeting.summary ?? '', meeting.transcript ?? ''].join(' ');
  const keywords = extractKeywords(text).slice(0, 10); // top 10 by frequency

  const topics = db.prepare('SELECT id, name FROM topics').all() as Array<{ id: number; name: string }>;
  for (const topic of topics) {
    const nameWords = topic.name.toLowerCase().split(/\s+/);
    const score = keywords.filter(k => nameWords.some(w => w.includes(k) || k.includes(w))).length / keywords.length;
    if (score > 0.3) {
      db.prepare(`
        INSERT OR IGNORE INTO meeting_topic_links (meeting_id, topic_id, confidence)
        VALUES (?, ?, ?)
      `).run(meetingId, topic.id, score);
    }
  }
}
```

---

## Ticket Breakdown

| ID | Title | Complexity | Notes |
|----|-------|-----------|-------|
| EP-52-0 | Schema v30 migration | XS | `schema.ts` — 2 DDL statements |
| EP-52-1 | `checkEndedMeetings()` + sync loop integration | S | Guard via `data_quality` table |
| EP-52-2 | `scrapeSpecificChat()` in teams-chats.ts | M | Fuzzy chat name match, Recap tab only |
| EP-52-3 | Transcript upsert + `AIAnalyzer.analyzeMeeting()` trigger | S | Reuses existing analyzer method |
| EP-52-4 | Auto action item extraction from transcript | S | Dedup via `content_hash` guard |
| EP-52-5 | `suggestTopicLinks()` + 3 topic-link endpoints | M | FTS keyword scoring, confirm/delete API |
| EP-52-6 | Alert Rule 5 upgrade + `cta` field + AlertFeed CTA button | S | `sendToChat()` pattern |
| EP-52-7 | RecentMeetingsWidget topic chips + meeting detail expand | M | Read from `meeting_topic_links` |

**Execution order** (waves):
- **Wave 1** (parallel): EP-52-0 + EP-52-1
- **Wave 2** (after Wave 1): EP-52-2, EP-52-3, EP-52-4
- **Wave 3** (after Wave 2): EP-52-5, EP-52-6, EP-52-7

---

## Open Questions

- Q1: Should `scrapeSpecificChat` reuse the existing `TeamsChatScraper` instance or create a new one? The existing scraper scrapes all chats on init — we need a targeted single-chat variant.
- Q2: What if the Teams meeting is an internal call without a Recap tab? Should we fall back to scraping the last N messages from the chat as the "transcript"?
- Q3: For topic mapping confidence threshold: 0.3 may be too aggressive (many false positives). Consider raising to 0.5 and requiring at least 2 keyword hits.
