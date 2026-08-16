---
title: "EP-19: Persistent Digests (Memory / History)"
sidebar_label: "EP-19: Persistent Digests"
---

# EP-19: Persistent Digests (Memory / History)

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Agent Role** | Backend / Full-Stack Engineer |
| **Depends On** | — |
| **Blocks** | [EP-23](./ep23-daily-summary) |
| **File Scope** | `src/db/schema.ts` (edit), `src/db/queries.ts` (edit), `web-server.js` (edit), `web/src/lib/api.ts` (edit), `web/src/pages/DigestPage.tsx` (edit) |

## Goal

Store generated digests in SQLite so they load instantly on repeat visits. Add date shortcuts (Yesterday, 2 days ago, Last Monday) to the Digest page so the user can browse history with one click. The user said: "it should have memory, if I want to see what happened yesterday I just clicked on it gives me details."

## Decisions Made

- **`UNIQUE(date, topic_name)` with `INSERT OR REPLACE`**: Simplest deduplication. Using `topic_name` (string) rather than `topic_id` (FK integer) avoids a JOIN on every cache read and survives topic renaming.
  - **Rejected**: Using `topic_id` as FK — would break if a topic is renamed; requires a JOIN to display topic name.
- **`expires_at` column as optional TTL**: Permanent digests (user-generated) have `expires_at = NULL` (keep forever). Auto-generated summaries (EP-23 daily summary) set `expires_at = datetime('now', '+1 hour')`. One table handles both.
  - **Rejected**: Separate table for auto-summaries — unnecessary duplication.
- **Cache check in `web-server.js`, not inside `getDailyDigest()`**: Tools stay pure functions. The bridge layer is the correct place for caching concerns. This matches existing pattern (tools never touch `sync_state` — the bridge does).
- **`date-fns` for shortcuts**: Already in `web/package.json`. No new dependency needed.

## What Will Be Built

### DB Migration — `src/db/schema.ts` (edit)

Bump `CURRENT_SCHEMA_VERSION`. Add migration:

```sql
CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,              -- ISO date string: '2026-04-15'
  topic_name TEXT,                 -- NULL means cross-topic (daily summary)
  markdown TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,                 -- NULL = permanent; ISO datetime = TTL
  UNIQUE(date, topic_name)
);
CREATE INDEX IF NOT EXISTS idx_digests_date ON digests(date DESC);
CREATE INDEX IF NOT EXISTS idx_digests_topic_date ON digests(topic_name, date DESC);
```

### `src/db/queries.ts` (edit)

```ts
export interface DigestRecord {
  id: number;
  date: string;
  topic_name: string | null;
  markdown: string;
  generated_at: string;
  expires_at: string | null;
}

export function saveDigest(
  db: Database,
  date: string,
  topicName: string | null,
  markdown: string,
  expiresAt?: string        // ISO datetime; omit for permanent
): void  // INSERT OR REPLACE

export function getCachedDigest(
  db: Database,
  date: string,
  topicName: string | null
): DigestRecord | null  // returns null if expired (expires_at < now) or missing

export function listDigests(
  db: Database,
  limit?: number            // default 20
): Pick<DigestRecord, 'id' | 'date' | 'topic_name' | 'generated_at'>[]

export function deleteDigest(db: Database, id: number): void
```

`getCachedDigest` must check expiry:
```sql
SELECT * FROM digests
WHERE date = ? AND (topic_name = ? OR (? IS NULL AND topic_name IS NULL))
  AND (expires_at IS NULL OR expires_at > datetime('now'))
```

### `web-server.js` (edit)

Modify `POST /api/digest`:
```js
// Before: just calls getDailyDigest every time
// After:
const cached = getCachedDigest(db, date, topicName);
if (cached) {
  json(res, 200, { markdown: cached.markdown, cached: true, generatedAt: cached.generated_at });
  return;
}
const result = await getDailyDigest(db, { topic, date }, anthropicApiKey);
saveDigest(db, date, topicName, result.markdown);
json(res, 200, { markdown: result.markdown, cached: false, generatedAt: new Date().toISOString() });
```

New endpoints:
```
GET    /api/digests?limit=20       → DigestListItem[]
DELETE /api/digests/:id            → { ok: true }
```

### `web/src/pages/DigestPage.tsx` (edit)

Add date shortcut bar above the date field:
```tsx
import { subDays, previousMonday, format } from 'date-fns';

const shortcuts = [
  { label: 'Today',       date: format(new Date(), 'yyyy-MM-dd') },
  { label: 'Yesterday',   date: format(subDays(new Date(), 1), 'yyyy-MM-dd') },
  { label: '2 days ago',  date: format(subDays(new Date(), 2), 'yyyy-MM-dd') },
  { label: 'Last Monday', date: format(previousMonday(new Date()), 'yyyy-MM-dd') },
];
// Each shortcut: <Button variant="ghost" size="sm" onClick={() => { setValue('date', s.date); handleSubmit(onSubmit)(); }}>
```

Show "Cached" Badge in MarkdownPanel when `cached: true`:
```tsx
<MarkdownPanel
  title={result.cached ? 'Daily Digest (cached)' : 'Daily Digest'}
  content={result.markdown}
/>
// + <Badge variant="info">Cached {formatRelative(result.generatedAt)}</Badge>
```

Add collapsible "Recent Digests" list below the form (using `useQuery(['digests'], api.listDigests)`).
Clicking a row sets the date + topic fields and auto-submits.

### `web/src/lib/api.ts` (edit)

```ts
// Update digest() return type:
export interface DigestResult {
  markdown: string;
  cached?: boolean;
  generatedAt?: string;
}

// New:
export interface DigestListItem {
  id: number; date: string; topic_name: string | null; generated_at: string;
}

listDigests: () => request<DigestListItem[]>('/digests')
deleteDigest: (id: number) => request<{ ok: boolean }>(`/digests/${id}`, null)  // DELETE via method override
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-19-1 | DB migration: `digests` table — **File:** `src/db/schema.ts` | ✅ Done |
| EP-19-2 | Add `saveDigest`, `getCachedDigest`, `listDigests`, `deleteDigest` — **File:** `src/db/queries.ts` | ✅ Done |
| EP-19-3 | Modify `POST /api/digest` to check + populate cache — **File:** `web-server.js` | ✅ Done |
| EP-19-4 | Add `GET /api/digests` and `DELETE /api/digests/:id` — **File:** `web-server.js` | ✅ Done |
| EP-19-5 | Add date shortcuts (Today/Yesterday/2 days ago/Last Monday) — **File:** `web/src/pages/DigestPage.tsx` | ✅ Done |
| EP-19-6 | Add "Cached" badge in MarkdownPanel — **File:** `web/src/pages/DigestPage.tsx` | ✅ Done |
| EP-19-7 | Add "Recent Digests" collapsible list — **File:** `web/src/pages/DigestPage.tsx` | ✅ Done |
| EP-19-8 | Update `DigestResult` type + add `listDigests`, `deleteDigest` — **File:** `web/src/lib/api.ts` | ✅ Done |

## Acceptance Criteria

- [x] `digests` table exists with correct schema after migration
- [x] Second `POST /api/digest` for same date+topic returns `cached: true` within milliseconds
- [x] `GET /api/digests` returns list sorted by `date DESC`
- [x] `DELETE /api/digests/:id` removes the row (forces regeneration on next request)
- [x] Date shortcuts render and auto-submit the form
- [x] "Cached" badge appears when serving cached result
- [x] Recent Digests list shows previous entries and click-to-load works
- [x] `npm run typecheck` passes with zero errors

## Sample Usage

```bash
# Generate digest for yesterday (slow — calls Claude)
curl -X POST http://localhost:3132/api/digest -d '{"topic":"BDS","date":"2026-04-15"}'
# → { markdown: "...", cached: false, generatedAt: "2026-04-15T..." }

# Request same digest again (instant — from cache)
curl -X POST http://localhost:3132/api/digest -d '{"topic":"BDS","date":"2026-04-15"}'
# → { markdown: "...", cached: true, generatedAt: "2026-04-15T..." }

# List all stored digests
curl http://localhost:3132/api/digests
# → [{ id: 1, date: "2026-04-15", topic_name: "BDS", generated_at: "..." }]

# Delete to force regeneration
curl -X DELETE http://localhost:3132/api/digests/1
# → { ok: true }
```
