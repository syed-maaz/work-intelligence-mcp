---
title: "BUG-06: searchMessages() uses LIKE"
sidebar_label: "BUG-06: LIKE not FTS5"
---

# BUG-06: `searchMessages()` uses LIKE, bypassing FTS5

| | |
|---|---|
| **Severity** | Accumulating Debt |
| **Status** | ✅ Fixed |
| **File** | `src/db/queries.ts:207–208` |
| **Discovered** | April 2026 technical audit |
| **Fixed in** | Direct code fix (April 2026) |

## Description

The primary `searchMessages()` query helper in `queries.ts` — called by the `search_messages` MCP tool — used a leading-wildcard `LIKE` scan for full-text search:

```typescript
// Before fix
if (filters.search_text) {
  conditions.push('content LIKE ?');
  parameters.push(`%${filters.search_text}%`);
}
```

This generates:

```sql
SELECT * FROM messages WHERE content LIKE '%authentication%'
ORDER BY timestamp DESC LIMIT 100
```

A leading wildcard (`%auth...`) forces SQLite to scan every row — no index can be used. Performance is O(n) in the number of stored messages.

## The FTS5 Table Was Right There

Migration 2→3 created `messages_fts` — a FTS5 virtual table with BM25 ranking and a Porter stemmer:

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, content, author, source,
  content='messages', content_rowid='id',
  tokenize='porter unicode61'
);
```

The triggers (`messages_ai`, `messages_ad`, `messages_au`) keep it in sync with every insert/update/delete. FTS5 queries complete in milliseconds on 500K rows. `searchMessages()` never used it.

## Fix

FTS5 is now the primary path. LIKE is kept as a fallback for cases where FTS5 returns zero results (e.g., very short tokens, special character queries):

```typescript
// After fix
if (filters.search_text) {
  const sanitized = filters.search_text.replace(/["()*:]/g, ' ').trim();

  if (sanitized.length > 0) {
    const ftsQuery = `
      SELECT m.*
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.id
      WHERE messages_fts MATCH ?
      ${ftsWhere}
      ORDER BY bm25(messages_fts)
      ${limitClause}
    `;

    try {
      const results = db.prepare(ftsQuery).all(sanitized, ...parameters);
      if (results.length > 0) return parse(results);
    } catch {
      // FTS parse error — fall through to LIKE
    }
  }

  // LIKE fallback
  conditions.push('(content LIKE ? OR subject LIKE ?)');
}
```

Benefits of the FTS5 path:
- BM25 ranking — most relevant results appear first
- Porter stemming — "running" matches "run", "authentication" matches "authenticate"  
- Sub-millisecond on large corpora
- Searches both `content` and `subject` columns

## Files Changed

- `src/db/queries.ts` — `searchMessages()` function
