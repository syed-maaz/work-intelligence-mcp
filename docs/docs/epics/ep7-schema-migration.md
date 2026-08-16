---
title: "EP-7: Schema Migration v2"
sidebar_label: "EP-7: Schema v2"
---

# EP-7: Schema Migration v2

| | |
|---|---|
| **Status** | ✅ DONE |
| **Priority** | High |
| **Agent Role** | Database Engineer |
| **Depends On** | [EP-0](./ep0-foundation) |
| **Blocks** | [EP-5](./ep5-sync-pipeline) |
| **File Scope** | `src/db/schema.ts` (modify), `src/db/queries.ts` (create new) |

## Goal

The current SQLite schema (v1) has no `source_id` column on `messages` and no `sync_state` table. The sync pipeline (EP-5) needs both to deduplicate messages across sync cycles and track when each source was last synced. This epic adds a backward-compatible migration and creates the query helpers that the sync pipeline will use.

This epic can run **in parallel** with EP-1 through EP-4.

## Acceptance Criteria

- [ ] Migration v1→v2 added to `applyMigrations()` in `src/db/schema.ts`
- [ ] `messages.source_id TEXT` column added (nullable for backward compatibility with v1 rows)
- [ ] `UNIQUE(source, source_id)` constraint on `messages` table (partial: only when `source_id IS NOT NULL`)
- [ ] New `sync_state` table created:
  ```sql
  CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id TEXT NOT NULL,
    source TEXT NOT NULL,
    last_synced_at TEXT,
    last_message_count INTEGER DEFAULT 0,
    UNIQUE(topic_id, source)
  )
  ```
- [ ] `CURRENT_SCHEMA_VERSION` constant bumped from `1` to `2`
- [ ] `src/db/queries.ts` created with:
  - `upsertMessage(db, msg: UnifiedMessage): void` — `INSERT OR IGNORE` using `(source, source_id)` as dedup key
  - `getSyncState(db, topicId: string, source: string): SyncState | null`
  - `updateSyncState(db, topicId: string, source: string, timestamp: Date): void`
- [ ] Existing v1 databases migrate without data loss (existing rows unaffected)
- [ ] `npm run typecheck` passes

## Schema Changes

```sql
-- Migration v2
ALTER TABLE messages ADD COLUMN source_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_dedup
  ON messages(source, source_id)
  WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL,
  source TEXT NOT NULL,
  last_synced_at TEXT,
  last_message_count INTEGER DEFAULT 0,
  UNIQUE(topic_id, source)
);
```

## Query Helper Signatures

```typescript
// src/db/queries.ts
export function upsertMessage(db: Database, msg: UnifiedMessage & { source_id: string }): void;
export function getSyncState(db: Database, topicId: string, source: string): SyncState | null;
export function updateSyncState(db: Database, topicId: string, source: string, timestamp: Date): void;

export interface SyncState {
  topicId: string;
  source: string;
  lastSyncedAt: Date | null;
  lastMessageCount: number;
}
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-7-1 | Add `source_id` column + partial unique index to `messages` | ✅ DONE |
| EP-7-2 | Create `sync_state` table | ✅ DONE |
| EP-7-3 | Implement `upsertMessage()` in `src/db/queries.ts` | ✅ DONE |
| EP-7-4 | Implement `getSyncState()` + `updateSyncState()` in `src/db/queries.ts` | ✅ DONE |
| EP-7-5 | Bump `CURRENT_SCHEMA_VERSION` to `2`, verify migration on v1 DB | ✅ DONE |

---

## Agent Prompt

:::tip Start This Epic
Only EP-0 (Foundation) is needed. This epic can run in parallel with EP-1/EP-2/EP-3/EP-4/EP-6.
:::

```
You are implementing EP-7: Schema Migration v2 for the Work Intelligence MCP project.


CONTEXT:
The SQLite schema is at v1 (in src/db/schema.ts). The sync pipeline (EP-5) needs:
1. A source_id column on messages for deduplication
2. A sync_state table to track last sync time per (topic, source) pair
3. Query helpers: upsertMessage(), getSyncState(), updateSyncState()

YOUR SCOPE:
- src/db/schema.ts — add v2 migration (additive only, do NOT change v1 migration)
- src/db/queries.ts — create this new file with query helpers
Do NOT modify any other files.

READ FIRST:
- src/db/schema.ts (understand existing migration runner and v1 schema)
- src/db/connection.ts (understand how db is initialized)
- src/connectors/types.ts (UnifiedMessage shape — needed for upsertMessage)

WHAT TO BUILD:

1. In src/db/schema.ts:
   - Add migration v2 that runs only when CURRENT_SCHEMA_VERSION < 2
   - ALTER TABLE messages ADD COLUMN source_id TEXT
   - CREATE UNIQUE INDEX idx_messages_source_dedup ON messages(source, source_id) WHERE source_id IS NOT NULL
   - CREATE TABLE sync_state (id, topic_id, source, last_synced_at, last_message_count, UNIQUE(topic_id, source))
   - Bump CURRENT_SCHEMA_VERSION to 2
   - Migration must be idempotent (safe to run twice)

2. Create src/db/queries.ts:
   - upsertMessage(db, msg): void — INSERT OR IGNORE, maps UnifiedMessage fields to columns
   - getSyncState(db, topicId, source): SyncState | null
   - updateSyncState(db, topicId, source, timestamp): void
   - Export SyncState interface

ACCEPTANCE CRITERIA:
- npm run typecheck passes
- A v1 database (no source_id, no sync_state) successfully migrates to v2 with no data loss
- upsertMessage with same (source, source_id) is idempotent (no duplicate rows)
- Migration is backward-compatible — nullable source_id for old rows
```
