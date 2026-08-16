---
title: "BUG-03: INSERT OR REPLACE orphans action items"
sidebar_label: "BUG-03: INSERT OR REPLACE"
---

# BUG-03: `INSERT OR REPLACE` orphans action items on every sync

| | |
|---|---|
| **Severity** | 🔴 Breaking |
| **Status** | ✅ Fixed |
| **File** | `src/db/queries.ts:146` |
| **Discovered** | April 2026 technical audit |
| **Fixed in** | Direct code fix (April 2026) |

## Description

`upsertMessage()` used `INSERT OR REPLACE`:

```sql
-- Before fix
INSERT OR REPLACE INTO messages
  (topic_id, source, content, author, timestamp, metadata, source_id, subject, raw_data)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
```

`INSERT OR REPLACE` in SQLite is **not** an upsert. It is a **DELETE followed by INSERT**. When the `UNIQUE(source, source_id)` constraint fires, SQLite:

1. Deletes the existing row — triggering `ON DELETE SET NULL` on `action_items.source_message_id`
2. Inserts a new row with a **new auto-increment `id`**

## Cascade Effect

The `action_items` table has:

```sql
FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL
```

Every sync cycle that re-encounters a known message would:
- Delete the old `messages` row (new `id` assigned to replacement)
- Null out `source_message_id` on every action item linked to that message
- Action items lose their source provenance permanently

After a few syncs, every action item in the DB had `source_message_id = NULL` regardless of what was originally extracted.

## FTS5 Trigger Compound Effect

The schema has three triggers: `messages_ai` (after insert), `messages_ad` (after delete), `messages_au` (after update). Because SQLite implements `REPLACE` as delete + insert, it fires `messages_ad` then `messages_ai` — **not** `messages_au`. The FTS index received a spurious delete+insert for every already-known message on every sync run, causing unnecessary FTS index churn.

## Fix

Changed to `INSERT OR IGNORE` (preserves existing `id`) followed by a separate `UPDATE` that refreshes mutable fields only when content actually changes:

```typescript
// After fix
db.prepare(`
  INSERT OR IGNORE INTO messages
    (topic_id, source, content, author, timestamp, metadata, source_id, subject, raw_data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(...);

// Separate UPDATE for mutable fields — id never changes, FK never breaks
db.prepare(`
  UPDATE messages
  SET content = ?, metadata = ?, raw_data = ?, subject = ?, timestamp = ?
  WHERE source = ? AND source_id = ?
`).run(...);
```

The `UPDATE` fires `messages_au`, which correctly does a delete+insert pair in the FTS index only when the row changes.

## Files Changed

- `src/db/queries.ts` — `upsertMessage()` function
