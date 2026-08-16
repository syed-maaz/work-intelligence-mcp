---
title: "BUG-15: Duplicated FTS query code"
sidebar_label: "BUG-15: Duplicated FTS code"
---

# BUG-15: Duplicated FTS query code, no shared search module

| | |
|---|---|
| **Severity** | Accumulating Debt |
| **Status** | 📋 Tracked (EP-9) |
| **File** | `src/tools/teams-updates.ts`, `src/tools/search-all.ts` |
| **Discovered** | April 2026 technical audit |

## Description

`teams-updates.ts` and `search-all.ts` both implement an FTS5 + LIKE fallback search pattern. The code is copy-pasted verbatim with minor variations:

**`teams-updates.ts`** (excerpt):
```typescript
function searchFTS(db, query, since, limit) {
  const sanitized = query.replace(/["()*:]/g, ' ').trim();
  const ftsQuery = `
    SELECT m.id, m.source, m.source_id, m.subject, m.content,
           m.author, m.timestamp, m.metadata, bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m ON messages_fts.rowid = m.id
    WHERE messages_fts MATCH ? AND m.timestamp >= ?
    ORDER BY rank LIMIT ?
  `;
  // ... FTS, then LIKE fallback
}
```

**`search-all.ts`** (excerpt):
```typescript
function searchFTS(db, query, since, limit) {
  const sanitized = query.replace(/["()*:]/g, ' ').trim();
  const ftsQuery = `
    SELECT m.id, m.source, m.source_id, m.subject, m.content,
           m.author, m.timestamp, m.metadata, bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m ON messages_fts.rowid = m.id
    WHERE messages_fts MATCH ? AND m.timestamp >= ?
    ORDER BY rank LIMIT ?
  `;
  // ... same FTS, same LIKE fallback, same sanitization
}
```

Both also have identical `searchLike()` fallback functions.

## Why This Is a Problem

When a bug is found in the FTS path (e.g., the FTS5 metacharacter sanitization), it must be fixed in two files. When a new source column needs to be added to search results, both files must be updated. When the LIKE fallback logic changes, both must be updated. In practice, one file tends to get the fix and the other doesn't — divergence accumulates silently.

Additionally, `better-sqlite3` caches prepared statements internally, but preparing the same SQL on every call (rather than at module load time) is still wasteful and makes query auditing harder.

## Recommended Fix (EP-9)

Extract a `src/db/search.ts` module:

```typescript
// src/db/search.ts
export interface SearchOptions {
  query: string;
  since?: string;
  source?: string;
  limit?: number;
}

export interface SearchRow {
  id: number;
  source: string;
  source_id: string | null;
  subject: string | null;
  content: string;
  author: string;
  timestamp: string;
  rank?: number;
}

export function searchMessages(db: Database, opts: SearchOptions): SearchRow[];
export function searchMeetings(db: Database, opts: SearchOptions): MeetingRow[];
```

All tools (`teams-updates.ts`, `search-all.ts`, `topic-expert.ts`) call this module. The FTS + LIKE logic lives in exactly one place.

## Tracking

Refactor planned in [EP-9 (Dead Code Cleanup)](../epics/ep9-cleanup).
