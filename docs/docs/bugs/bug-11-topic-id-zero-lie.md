---
title: "BUG-11: topic_id=0 sentinel lie"
sidebar_label: "BUG-11: topic_id=0 sentinel"
---

# BUG-11: `topic_id = 0` comment contradicts `NOT NULL` FK constraint

| | |
|---|---|
| **Severity** | Accumulating Debt |
| **Status** | 📋 Documented |
| **File** | `src/db/schema.ts:252–253` |
| **Discovered** | April 2026 technical audit |

## Description

Migration 2→3 contains a comment explaining why `topic_id` in the `meetings` table is nullable:

```sql
-- Make topic_id nullable (meetings may not belong to a topic)
-- SQLite can't ALTER COLUMN, so we leave it as-is; topic_id = 0 means unassigned
```

This comment is incorrect in two ways.

### 1 — The column is still NOT NULL

The original `meetings` DDL (migration 0→1) declares:

```sql
CREATE TABLE meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL,   -- ← hard NOT NULL
  ...
  FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
);
```

SQLite does not support `ALTER COLUMN` to drop a `NOT NULL` constraint. The column is still `NOT NULL` on every database. The comment says "we leave it as-is" but describes the intent as nullable — these contradict each other.

### 2 — `topic_id = 0` violates the FK when foreign keys are ON

`connection.ts` sets `PRAGMA foreign_keys = ON`. Topic id `0` does not exist in the `topics` table (auto-increment starts at 1). Inserting a meeting with `topic_id = 0` will fail with:

```
SqliteError: FOREIGN KEY constraint failed
```

This is exactly why `upsertMeeting()` in `teams-sync.ts` inserts a default `"teams"` topic first and uses its real `id`:

```typescript
// teams-sync.ts workaround
db.prepare(`INSERT OR IGNORE INTO topics (name) VALUES ('teams')`).run();
const defaultTopic = db.prepare(`SELECT id FROM topics WHERE name = 'teams'`).get();
```

The underlying schema comment still describes a broken invariant, and any future developer who reads it and writes `INSERT INTO meetings (...) VALUES (0, ...)` will hit a FK violation.

## Recommended Fix

**Option A (clean):** In the next schema migration, recreate the `meetings` table with `topic_id INTEGER` (nullable) using the SQLite workaround (CREATE new table, INSERT SELECT, DROP old, RENAME). This is EP-18 scope.

**Option B (comment fix only):** Update the comment to accurately describe reality — topic_id is `NOT NULL` with FK enforcement; to insert a meeting without a user-configured topic, use the `_search_cache` default topic or a system topic.

## Tracking

This is a known documented issue. No immediate data loss risk as long as the `teams-sync.ts` workaround remains. Fix tracked for the next schema migration epic.
