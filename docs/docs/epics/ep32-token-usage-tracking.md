---
sidebar_position: 32
title: EP-32 Token Usage Tracking
---

# EP-32: Token Usage Tracking

| Field | Value |
|-------|-------|
| **Status** | ✅ Done |
| **Priority** | High — enables all cost optimization decisions |
| **Complexity** | Small (1–2 days) |
| **Blocked By** | None |
| **Schema version** | 18 (adds `token_usage` table) |
| **Completed** | 2026-04-18 |

## Summary

Every Claude API call in `AIAnalyzer` is currently a black box cost-wise. We have no visibility into which operations are expensive, which models are over-used, or how token cost grows over time. This epic adds structured token tracking at the call site, persists usage to SQLite, and exposes a stats endpoint + dashboard widget.

This is the foundation for all future cost optimization. You can't optimize what you can't measure.

## Decisions Made

- **Track at call site in `AIAnalyzer`** — wrap every `client.beta.promptCaching.messages.create()` call; never rely on external logging
- **Persist to SQLite, not logs** — queryable, survives restarts, same DB as everything else
- **Per-method granularity** — track by `method` name (detectActionItems, generateDigest, chatWithContext, etc.) so we know which operations are expensive
- **Cache hit tracking** — log `cache_read_input_tokens` separately; this is real money saved
- **No sampling** — track every call; this is a low-volume local tool, overhead is negligible
- **Rolling 30-day window** — purge entries older than 30 days automatically on insert

## DB Schema (Migration 17 → 18)

```sql
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_token_usage_method ON token_usage(method);
CREATE INDEX IF NOT EXISTS idx_token_usage_recorded_at ON token_usage(recorded_at);
```

Bump `CURRENT_SCHEMA_VERSION = 18`.

> **Note**: Column names differ slightly from the plan (`cost_usd` not `total_cost_usd`, `cache_creation_tokens` not `cache_write_tokens`, `recorded_at` not `called_at`). No `topic_name` column — omitted as the per-method granularity is sufficient. No `model` index added (low cardinality, not needed).

## Cost Rates — `computeCost()` in `src/services/analyzer.ts`

```typescript
// Prices per million tokens (2026 Q2)
const pricing: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  'claude-sonnet-latest':      { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  },
  'claude-haiku-latest':       { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  },
  'claude-opus-4-6':           { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  'claude-opus-latest':        { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
};

export function computeCost(model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens): number
```

Returns `0` for unknown models rather than throwing. Update this table when Anthropic reprices.

## DB Queries — `src/db/queries.ts`

```typescript
// Insert one usage row; purges rows >30 days old automatically
export function recordTokenUsage(
  db: Database,
  method: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  costUsd: number,
): void

// Returns totals + by_method array + by_day array
export function getTokenStats(db: Database, days?: number): TokenStatsSummary
```

## Changes to `src/services/analyzer.ts`

`AIAnalyzerConfig` gets an optional `db` field:
```typescript
export interface AIAnalyzerConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  db?: Database.Database;  // NEW — required for token tracking
}
```

Private `_track()` method (no-ops when `db` not provided):
```typescript
private _track(method: string, model: string, usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): void
```

Called after every `client.beta.promptCaching.messages.create()` — 9 sites total:
`detectActionItems`, `summarizeContent`, `extractQuestions`, `generateDigest`,
`chatWithContext`, `answerQuestion`, `extractCalendarFromMessages`,
`buildNotebook`, `updateNotebook`.

## New Endpoints — `web-server.js`

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/token-stats` | `{ stats: TokenStats[], totalCostUsd: number, period: '30d' }` |
| GET | `/api/token-stats?days=7` | Same, scoped to last 7 days |

## New Web UI — `web/src/components/shared/TokenStatsWidget.tsx`

Small widget for dashboard or Settings page:

```
┌─────────────────────────────────────────┐
│  Token Usage  (last 30d)         $0.84  │
├────────────────────┬────────┬───────────┤
│ generateDigest     │ Sonnet │ $0.41     │
│ chatWithContext    │ Sonnet │ $0.22     │
│ detectActionItems  │ Haiku  │ $0.12     │
│ buildNotebook      │ Sonnet │ $0.09     │
└────────────────────┴────────┴───────────┘
```

## Key Code Locations

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `token_usage` table, bump to v18 |
| `src/db/queries.ts` | Add `recordTokenUsage()` (with auto-purge), `getTokenStats()`, `TokenUsageRow`, `TokenStatsSummary` |
| `src/services/analyzer.ts` | Add `computeCost()` (exported), `_track()` private method, `db?` in `AIAnalyzerConfig`; 9 `_track()` call sites |
| `web-server.js` | Pass `db` to `AIAnalyzer` constructor; add `GET /api/token-stats` endpoint |
| `web/src/components/shared/TokenStatsWidget.tsx` | NEW — totals row + cache savings row + per-method table |
| `web/src/lib/api.ts` | Add `TokenStats` interface + `api.tokenStats(days)` |
| `web/src/pages/DigestPage.tsx` | Render `<TokenStatsWidget />` at bottom of page |

## Acceptance Criteria

- [x] Every `AIAnalyzer` method call writes a row to `token_usage` (9 call sites)
- [x] `cache_read_tokens` and `cache_creation_tokens` tracked separately
- [x] `cost_usd` computed at insert time using known rate table (`computeCost()`)
- [x] Rows older than 30 days auto-purged on insert (in `recordTokenUsage()`)
- [x] `GET /api/token-stats` returns per-method breakdown + by-day totals
- [x] DigestPage shows last-30d cost by method via `TokenStatsWidget`
- [x] TypeScript builds clean (`npm run typecheck`)
