---
title: "BUG-07: Ghost topics unbounded growth"
sidebar_label: "BUG-07: Ghost topics"
---

# BUG-07: `search_all` creates unbounded ghost topics

| | |
|---|---|
| **Severity** | Silently Wrong |
| **Status** | ✅ Fixed |
| **File** | `src/tools/search-all.ts:394` |
| **Discovered** | April 2026 technical audit |
| **Fixed in** | Direct code fix (April 2026) |

## Description

Every call to `search_all` created a new row in the `topics` table named after the query string:

```typescript
// Before fix
const topicName = `search:${query.slice(0, 60).trim()}`;
const topicId = ensureTopic(db, topicName);
```

This means:
- `search_all({ query: "KBA access" })` → creates topic `search:KBA access`
- `search_all({ query: "kba access" })` → creates topic `search:kba access` (different row)
- `search_all({ query: "KBA access issues" })` → creates topic `search:KBA access issues` (different row)

Each topic row also accumulates its own copy of the fetched messages under that `topic_id`. There is no cleanup, no TTL, and no deduplication.

## Impact

Over weeks of normal use:
- The `topics` table fills with hundreds of one-off `search:...` rows that no tool ever queries back against
- The `messages` table accumulates duplicate copies of the same Jira issues and emails under different `topic_id` values
- `configure_topic` listings become polluted with ghost topics visible to tools that list all topics
- DB size grows unboundedly from search-fetched content that is never reused

## Fix

All live-fetched content from `search_all` is now stored under a single shared `_search_cache` topic:

```typescript
// After fix
function ensureSearchCacheTopic(db: Database.Database): number {
  const SEARCH_CACHE_TOPIC = '_search_cache';
  const existing = getTopicByName(db, SEARCH_CACHE_TOPIC);
  if (existing) return existing.id;
  const created = createTopic(db, { name: SEARCH_CACHE_TOPIC });
  return created.id;
}

// One topic, regardless of query text
const topicId = ensureSearchCacheTopic(db);
```

Messages are still deduplicated by `UNIQUE(source, source_id)` — storing the same Jira issue twice (once from `search_all`, once from `get_jira_report`) results in one row, not two.

## Files Changed

- `src/tools/search-all.ts` — `ensureTopic()` replaced with `ensureSearchCacheTopic()`
