---
title: "BUG-08: Action items duplicated every sync"
sidebar_label: "BUG-08: Duplicate action items"
---

# BUG-08: Action items duplicated on every sync cycle

| | |
|---|---|
| **Severity** | 🔴 Breaking |
| **Status** | ✅ Fixed |
| **File** | `src/services/analyzer.ts:172`, `src/db/queries.ts:247`, `src/db/schema.ts` |
| **Discovered** | April 2026 technical audit |
| **Fixed in** | Direct code fix (April 2026) |

## Description

Two independent bugs combined to insert duplicate action items on every sync cycle.

### Bug A — Parallel chunk ID collision

`detectActionItems()` splits messages into chunks of 50 and runs them in parallel:

```typescript
const results = await Promise.all(
  chunks.map((chunk) => this.detectActionItemsChunk(chunk))
);
return results.flat();
```

Inside `detectActionItemsChunk`, action item IDs were generated as:

```typescript
// Before fix
id: `action-${Date.now()}-${index}`,
```

Two chunks running in parallel (`Promise.all`) both execute at the same millisecond. Both produce `action-1713182400000-0` for their first item. After `.flat()`, the results contain duplicate IDs for items from different chunks.

### Bug B — Plain INSERT on every sync

`insertActionItem()` in `queries.ts` used a plain `INSERT`:

```sql
-- Before fix
INSERT INTO action_items
  (topic_id, title, description, assignee, status, due_date, source_message_id)
VALUES (?, ?, ?, ?, ?, ?, ?)
```

No `OR IGNORE`, no uniqueness constraint. The sync pipeline calls this for every detected action item in every sync run. The same task ("Send deployment checklist to Alice") would be inserted as a new row on every 15-minute sync cycle for as long as the source message remained in the sync window.

## Impact

After one week of syncing a topic with 10 action items in its messages, the `action_items` table would contain ~1,000 rows for those same 10 tasks. Queries like `get_action_items` would return the same task dozens of times with different IDs.

## Fix

Two changes:

**1 — Schema migration (v3→v4):** Added `content_hash TEXT` column with `UNIQUE` index:

```sql
ALTER TABLE action_items ADD COLUMN content_hash TEXT;
CREATE UNIQUE INDEX idx_action_items_content_hash
  ON action_items(content_hash)
  WHERE content_hash IS NOT NULL;
```

**2 — `insertActionItem()` computes content hash and uses `INSERT OR IGNORE`:**

```typescript
// After fix
const contentHash = createHash('sha256')
  .update(`${validated.topic_id}|${validated.title}`)
  .digest('hex');

db.prepare(`
  INSERT OR IGNORE INTO action_items
    (..., content_hash)
  VALUES (?, ..., ?)
`).run(..., contentHash);
```

Two action items with the same topic + title hash are considered the same task. Re-syncing the same messages inserts nothing.

**3 — `randomUUID()` for IDs:** Parallel chunks no longer produce colliding IDs:

```typescript
// After fix
id: randomUUID(),
```

## Files Changed

- `src/services/analyzer.ts` — `detectActionItemsChunk()`: `randomUUID()` for IDs
- `src/db/queries.ts` — `insertActionItem()`: content hash + `INSERT OR IGNORE`
- `src/db/schema.ts` — migration v3→v4: `content_hash` column + unique index, `CURRENT_SCHEMA_VERSION = 4`
