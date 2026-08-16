---
title: "BUG-10: InsertMeetingSchema missing v3 columns"
sidebar_label: "BUG-10: Meeting schema drift"
---

# BUG-10: `InsertMeetingSchema` missing all v3 columns

| | |
|---|---|
| **Severity** | Silently Wrong |
| **Status** | ✅ Fixed |
| **File** | `src/db/queries.ts:46–53` |
| **Discovered** | April 2026 technical audit |
| **Fixed in** | Direct code fix (April 2026) |

## Description

Migration 2→3 added five columns to the `meetings` table:

```sql
ALTER TABLE meetings ADD COLUMN transcript TEXT;
ALTER TABLE meetings ADD COLUMN topics TEXT;
ALTER TABLE meetings ADD COLUMN summary TEXT;
ALTER TABLE meetings ADD COLUMN chat_name TEXT;
ALTER TABLE meetings ADD COLUMN source_id TEXT;
```

The `InsertMeetingSchema` Zod schema in `queries.ts` was never updated:

```typescript
// Before fix — only v1 columns
export const InsertMeetingSchema = z.object({
  topic_id: z.number(),
  title: z.string(),
  date: z.string(),
  attendees: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  decisions: z.string().nullable().optional(),
  // transcript, topics, summary, chat_name, source_id: missing
});
```

This meant:
- `insertMeeting()` could not store transcript data despite the schema supporting it
- Any call that passed `transcript` to the validated schema would have it silently stripped
- If a caller tried to pass v3 fields explicitly, Zod would reject them with a validation error (strict mode)
- `teams-sync.ts` worked around this by writing its own raw `upsertMeeting()` SQL instead of using the canonical `insertMeeting()` function

The drift created two separate meeting insert paths with no shared validation.

## Fix

All v3 columns added to both the schema and the insert function:

```typescript
// After fix
export const InsertMeetingSchema = z.object({
  topic_id: z.number(),
  title: z.string(),
  date: z.string(),
  attendees: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  decisions: z.string().nullable().optional(),
  transcript: z.string().nullable().optional(),
  topics: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  chat_name: z.string().nullable().optional(),
  source_id: z.string().nullable().optional(),
});
```

`insertMeeting()` now inserts all 11 columns, matching the v3 table definition.

## Files Changed

- `src/db/queries.ts` — `InsertMeetingSchema`, `InsertMeeting` type, `insertMeeting()` function
