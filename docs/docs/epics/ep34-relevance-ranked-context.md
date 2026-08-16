---
sidebar_position: 34
title: EP-34 Relevance-Ranked Context Injection
---

# EP-34: Relevance-Ranked Context Injection

| Field | Value |
|-------|-------|
| **Status** | ✅ Done |
| **Priority** | High |
| **Complexity** | Small (1 day) |
| **Blocked By** | None |
| **Schema version** | No change |

## Summary

Every AI call in `AIAnalyzer` currently passes messages sorted by recency (most recent first) and truncates at a fixed character cap (400–500 chars/message, max 30–60 messages). This is naive — a message from 3 days ago that directly answers the query gets dropped while a tangentially-related message from today is included.

The fix: before truncating, **rank messages by relevance to the query** using the FTS5 BM25 scores already computed during retrieval. The top-N by combined score (relevance × recency decay) get included. No new infrastructure needed — the scores are already available.

## Decisions Made

- **Rank at the tool layer, not in AIAnalyzer** — `teams-updates.ts`, `digest.ts`, `topic-expert.ts` each retrieve messages differently; ranking logic lives in a shared utility
- **Combined score = BM25 × recency decay** — recency decay: `e^(-λ × days_old)` with λ=0.1 (messages lose ~10% weight per day, half-weight at ~7 days)
- **No embedding infrastructure** — pure BM25 + recency, zero added latency; EP-36 adds semantic ranking later
- **Preserve context window budget** — same total char cap as today, just smarter selection within it

## Architecture

### New utility — `src/tools/context-ranker.ts`

```typescript
export interface ScoredMessage {
  message: MessageRow;
  bm25Score: number;      // from FTS5 rank column (negative; lower = better)
  recencyScore: number;   // 0–1; 1.0 = today
  combinedScore: number;  // higher = more relevant
}

/**
 * Rank messages by relevance + recency, return top-N.
 *
 * @param messages  Raw message rows (must include fts_rank if available)
 * @param query     The search query (used to compute recency only if bm25 not available)
 * @param opts.maxMessages  Max messages to return (default: 50)
 * @param opts.maxCharsPerMessage  Char cap per message body (default: 400)
 * @param opts.lambda  Recency decay rate (default: 0.1 = half-weight at ~7d)
 */
export function rankAndTruncate(
  messages: (MessageRow & { fts_rank?: number })[],
  opts?: { maxMessages?: number; maxCharsPerMessage?: number; lambda?: number }
): ScoredMessage[]
```

Implementation:

```typescript
function recencyScore(timestamp: string, lambda = 0.1): number {
  const days = (Date.now() - new Date(timestamp).getTime()) / 86_400_000;
  return Math.exp(-lambda * days);
}

export function rankAndTruncate(messages, opts = {}) {
  const { maxMessages = 50, maxCharsPerMessage = 400, lambda = 0.1 } = opts;

  const scored = messages.map(msg => {
    // FTS5 rank is negative; negate so higher = more relevant
    const bm25 = msg.fts_rank != null ? -msg.fts_rank : 0.5;
    const recency = recencyScore(msg.timestamp, lambda);
    // Normalize BM25 to 0–1 range across the batch, then blend 70/30
    return { message: msg, bm25Score: bm25, recencyScore: recency, combinedScore: 0 };
  });

  // Normalize BM25 scores
  const maxBm25 = Math.max(...scored.map(s => s.bm25Score), 1);
  scored.forEach(s => {
    const normalizedBm25 = s.bm25Score / maxBm25;
    s.combinedScore = 0.7 * normalizedBm25 + 0.3 * s.recencyScore;
  });

  return scored
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, maxMessages)
    .map(s => ({
      ...s,
      message: {
        ...s.message,
        content: s.message.content.slice(0, maxCharsPerMessage),
      },
    }));
}
```

### FTS5 query change — include `rank` column

In `src/db/queries.ts`, the FTS search query must expose the rank:

```sql
-- Before
SELECT m.* FROM messages m
JOIN messages_fts fts ON fts.rowid = m.id
WHERE messages_fts MATCH ?
ORDER BY rank

-- After
SELECT m.*, fts.rank AS fts_rank FROM messages m
JOIN messages_fts fts ON fts.rowid = m.id
WHERE messages_fts MATCH ?
ORDER BY rank
```

Update `searchMessages()`, `getRecentMessages()`, and any FTS query that feeds into AI calls to include `fts_rank`.

### Integration points

Update these tool files to call `rankAndTruncate()` before passing messages to `AIAnalyzer`:

- `src/tools/teams-updates.ts` — `get_teams_updates`: rank before passing to `summarizeContent()`
- `src/tools/topic-expert.ts` — rank before passing to `answerQuestion()`
- `src/tools/digest.ts` — rank before passing to `generateDigest()`
- `web-server.js` — `/api/chat` FTS results; `/api/teams-updates`; `/api/topic-expert`

## Expected Impact

For a query like "what happened in the KBA meeting last week":
- **Before**: top 50 messages by recency — may include today's unrelated Teams chatter
- **After**: top 50 by BM25×recency — messages containing "KBA", "meeting", "recap" score highest regardless of when they were sent

Token cost unchanged (same volume passed to Claude). Answer quality improves because Claude sees the most relevant context, not just the most recent.

## Key Code Locations

| File | Change |
|------|--------|
| `src/tools/context-ranker.ts` | NEW — `rankAndTruncate()` utility |
| `src/db/queries.ts` | Add `fts_rank` to FTS SELECT; expose via `MessageRow` type |
| `src/tools/teams-updates.ts` | Use `rankAndTruncate()` before AI call |
| `src/tools/topic-expert.ts` | Use `rankAndTruncate()` before AI call |
| `src/tools/digest.ts` | Use `rankAndTruncate()` before AI call |
| `web-server.js` | Use `rankAndTruncate()` in chat + teams-updates + topic-expert endpoints |

## Acceptance Criteria

- [ ] `rankAndTruncate()` implemented and exported from `context-ranker.ts`
- [ ] FTS queries return `fts_rank` alongside message rows
- [ ] `teams-updates`, `topic-expert`, `digest` tools use ranked context
- [ ] For a query with known relevant old messages, those messages appear in AI context
- [ ] No regression in response quality on simple recent queries
- [ ] TypeScript builds clean
