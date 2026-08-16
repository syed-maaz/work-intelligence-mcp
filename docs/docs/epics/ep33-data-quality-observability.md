---
sidebar_position: 33
title: EP-33 Data Quality & Pipeline Observability
---

# EP-33: Data Quality & Pipeline Observability

| Field | Value |
|-------|-------|
| **Status** | ✅ Done |
| **Priority** | High |
| **Complexity** | Medium (3–4 days) |
| **Blocked By** | None |
| **Schema version** | 19 (adds `ingestion_log` table; adds constraints) |

## Summary

Data flows in from Teams, Jira, Outlook and is stored silently — no record of what was ingested, what failed, or whether data is malformed. When sync fails halfway, there is no trace. This epic adds:

1. **Ingestion log** — per-run record of what each sync attempt saw, inserted, and errored on
2. **Data quality constraints** — DB-level CHECK constraints catching bad values at write time
3. **FTS coverage fix** — add `subject` field to `messages_fts` so email subjects are searchable
4. **Retention policy** — auto-purge messages from inactive chats beyond `lookback_days`

## Decisions Made

- **Ingestion log in SQLite** (not file-based) — queryable, correlatable with messages by `source_id`, same DB
- **Log at the `upsertMessage()` call site** — not in the scraper, not in the sync service; the DB layer is the right choke point
- **`data_quality` table separate from `ingestion_log`** — ingestion_log tracks run-level stats; data_quality tracks per-row anomalies (truncated content, null assignees, garbled transcripts). Different granularity, different consumers.
- **Soft retention** — set `archived_at` on old messages rather than DELETE; hard delete only after 90 days
- **FTS rebuild on column add** — adding `subject` to FTS requires drop + recreate of `messages_fts` virtual table in migration
- **CHECK constraints are additive** — added in migration, don't break existing data

## DB Schema (Migration 17 → 18)

### New table: `ingestion_log`

```sql
CREATE TABLE IF NOT EXISTS ingestion_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,              -- 'teams', 'jira', 'outlook', 'calendar'
  topic_name TEXT,
  run_started_at TEXT NOT NULL,
  run_completed_at TEXT,
  messages_seen INTEGER NOT NULL DEFAULT 0,
  messages_inserted INTEGER NOT NULL DEFAULT 0,
  messages_skipped INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  error_detail TEXT,                 -- JSON array of { source_id, error } for first N errors
  status TEXT NOT NULL DEFAULT 'running'  -- 'running' | 'completed' | 'failed'
);
CREATE INDEX IF NOT EXISTS idx_ingestion_log_source ON ingestion_log(source, run_started_at DESC);
```

### New table: `data_quality`

Logs per-row anomalies detected at ingest time — truncated messages, garbled transcripts, null required fields:

```sql
CREATE TABLE IF NOT EXISTS data_quality (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,          -- 'messages', 'meetings', 'action_items'
  row_id INTEGER NOT NULL,           -- FK to the offending row
  source TEXT NOT NULL,              -- 'teams', 'jira', 'outlook'
  rule TEXT NOT NULL,                -- 'content_truncated' | 'null_assignee' | 'short_transcript' | 'missing_source_id'
  severity TEXT NOT NULL DEFAULT 'warning',  -- 'warning' | 'error'
  detail TEXT,                       -- human-readable description
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_data_quality_table ON data_quality(table_name, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_quality_rule ON data_quality(rule);
```

### Data quality rules

| Rule | Trigger | Severity |
|------|---------|----------|
| `content_truncated` | `length(content) >= 1990` (near scraper limit) | warning |
| `null_assignee` | action_item inserted with `assignee IS NULL` | warning |
| `short_transcript` | meeting inserted with `length(transcript) < 50` | warning |
| `missing_source_id` | message inserted with `source_id IS NULL` | error |
| `garbled_content` | content contains >30% non-ASCII characters | warning |

### New column: `messages.archived_at`

```sql
ALTER TABLE messages ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_archived_at ON messages(archived_at) WHERE archived_at IS NOT NULL;
```

### FTS rebuild to include `subject`

```sql
-- Migration drops and recreates messages_fts to add subject field
DROP TABLE IF EXISTS messages_fts;
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  author,
  subject,         -- NEW
  content='messages',
  content_rowid='id',
  tokenize='porter unicode61'
);
-- Repopulate
INSERT INTO messages_fts(rowid, content, author, subject)
  SELECT id, content, author, COALESCE(subject, '') FROM messages;
```

Update AFTER INSERT / AFTER UPDATE / AFTER DELETE triggers on `messages` to include `subject`.

### CHECK constraints (safe to add to existing tables)

```sql
-- Prevent source_id from being NULL (was already UNIQUE but not NOT NULL)
-- Applied in migration via recreate or deferred enforcement
```

## New DB Queries — `src/db/queries.ts`

```typescript
export interface IngestionRun {
  id: number;
  source: string;
  topic_name: string | null;
  run_started_at: string;
  run_completed_at: string | null;
  messages_seen: number;
  messages_inserted: number;
  messages_skipped: number;
  errors: number;
  error_detail: string | null;
  status: 'running' | 'completed' | 'failed';
}

export interface DataQualityRow {
  id: number;
  table_name: string;
  row_id: number;
  source: string;
  rule: string;
  severity: 'warning' | 'error';
  detail: string | null;
  detected_at: string;
  resolved: number;
}

// Start a run, returns run id
export function startIngestionRun(db: Database, source: string, topicName?: string): number

// Update counters as messages are processed (called in batches)
export function updateIngestionRun(db: Database, runId: number, delta: {
  messages_seen?: number;
  messages_inserted?: number;
  messages_skipped?: number;
  errors?: number;
  error_detail?: string;
}): void

// Mark run complete or failed
export function completeIngestionRun(db: Database, runId: number, status: 'completed' | 'failed'): void

// List recent runs (last N, default 20)
export function listIngestionRuns(db: Database, limit?: number): IngestionRun[]

// Archive messages older than lookback_days for inactive chats
export function archiveOldMessages(db: Database, lookbackDays: number): number  // returns count archived

// Hard-delete archived messages older than 90 days
export function purgeArchivedMessages(db: Database): number  // returns count deleted

// Log a data quality anomaly (called from upsertMessage / upsertMeeting / insertActionItem)
export function logDataQuality(db: Database, row: Omit<DataQualityRow, 'id' | 'detected_at' | 'resolved'>): void

// List unresolved anomalies, optionally filtered by rule or severity
export function listDataQualityIssues(db: Database, opts?: { rule?: string; severity?: string; limit?: number }): DataQualityRow[]

// Mark an anomaly resolved
export function resolveDataQualityIssue(db: Database, id: number): void
```

### Data quality check helper — `src/db/quality-checks.ts`

```typescript
export function checkMessage(msg: MessageRow): Array<{ rule: string; severity: 'warning' | 'error'; detail: string }> {
  const issues = [];
  if (!msg.source_id) issues.push({ rule: 'missing_source_id', severity: 'error', detail: 'source_id is null' });
  if (msg.content.length >= 1990) issues.push({ rule: 'content_truncated', severity: 'warning', detail: `content length ${msg.content.length} near scraper limit` });
  const nonAscii = (msg.content.match(/[^\x00-\x7F]/g) ?? []).length;
  if (nonAscii / msg.content.length > 0.3) issues.push({ rule: 'garbled_content', severity: 'warning', detail: `${Math.round(nonAscii/msg.content.length*100)}% non-ASCII` });
  return issues;
}

export function checkMeeting(m: MeetingRow): Array<{ rule: string; severity: 'warning' | 'error'; detail: string }> {
  const issues = [];
  if (m.transcript && m.transcript.length < 50) issues.push({ rule: 'short_transcript', severity: 'warning', detail: `transcript only ${m.transcript.length} chars` });
  return issues;
}

export function checkActionItem(a: ActionItemRow): Array<{ rule: string; severity: 'warning' | 'error'; detail: string }> {
  const issues = [];
  if (!a.assignee) issues.push({ rule: 'null_assignee', severity: 'warning', detail: 'no assignee extracted' });
  return issues;
}
```

Called from `upsertMessage()`, `upsertMeeting()`, `insertActionItem()` after insert — log any issues to `data_quality` table.

## Changes to Sync Flow

In `web-server.js` `runFullSync()`:

```javascript
// Wrap each source sync in ingestion log
const runId = startIngestionRun(db, 'teams', topicName);
try {
  for (const msg of messages) {
    const result = upsertMessage(db, msg);
    updateIngestionRun(db, runId, {
      messages_seen: 1,
      messages_inserted: result.inserted ? 1 : 0,
      messages_skipped: result.inserted ? 0 : 1,
    });
  }
  completeIngestionRun(db, runId, 'completed');
} catch (err) {
  updateIngestionRun(db, runId, { errors: 1, error_detail: err.message });
  completeIngestionRun(db, runId, 'failed');
}
```

Also call `archiveOldMessages(db, 30)` at end of each full sync. Call `purgeArchivedMessages(db)` weekly (check last purge timestamp in sync_state).

## New Endpoints — `web-server.js`

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/ingestion/runs` | `{ runs: IngestionRun[] }` — last 20 runs |
| GET | `/api/ingestion/runs?source=teams` | Filter by source |
| GET | `/api/data-quality` | `{ issues: DataQualityRow[], unresolvedCount: number }` |
| POST | `/api/data-quality/:id/resolve` | Mark anomaly resolved |

## Dashboard Integration

Add a "Last Sync Health" indicator to the existing Topbar sync status:
- Green dot: last run `completed` with 0 errors
- Yellow dot: last run `completed` with errors > 0
- Red dot: last run `failed`

Tooltip shows: `Teams: 47 inserted, 12 skipped — 2m ago`

## Key Code Locations

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `ingestion_log`, `data_quality`, `messages.archived_at`, FTS rebuild, bump to v18 |
| `src/db/queries.ts` | Add ingestion log functions + data quality functions + `archiveOldMessages` + `purgeArchivedMessages` |
| `src/db/quality-checks.ts` | NEW — `checkMessage`, `checkMeeting`, `checkActionItem` |
| `web-server.js` | Wrap sync calls with ingestion log; call quality checks at upsert; call archive/purge in `runFullSync()` |
| `web/src/components/shell/Topbar.tsx` | Update sync dot to use ingestion health |
| `web/src/lib/api.ts` | Add `listIngestionRuns()`, `listDataQualityIssues()`, `resolveDataQualityIssue()` |

## Acceptance Criteria

- [ ] Every sync run creates an `ingestion_log` row with `running` status at start
- [ ] Row updated with counts during sync; marked `completed` or `failed` at end
- [ ] `data_quality` table populated with anomalies on insert (`content_truncated`, `null_assignee`, `short_transcript`, `missing_source_id`, `garbled_content`)
- [ ] `GET /api/data-quality` returns unresolved anomalies
- [ ] `messages_fts` includes `subject` field; searching email subjects returns results
- [ ] `archiveOldMessages()` sets `archived_at` on messages beyond lookback window
- [ ] `purgeArchivedMessages()` hard-deletes archived rows older than 90 days
- [ ] `GET /api/ingestion/runs` returns last 20 runs
- [ ] Topbar sync dot reflects last run health
- [ ] TypeScript builds clean
