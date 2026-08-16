---
sidebar_position: 37
title: EP-37 Semantic Search (Embeddings)
---

# EP-37: Semantic Search via Embeddings

| Field | Value |
|-------|-------|
| **Status** | ✅ Done |
| **Priority** | Medium |
| **Completed** | 2026-04-19 |
| **Schema version** | v22 (adds `message_embeddings` table) |

## Summary

FTS5 keyword search fails for:
- **Synonyms**: "auth" ≠ "authentication"
- **Paraphrasing**: "Alice needs to fix the login bug" doesn't match "authentication issue assigned to Alice"
- **Concept queries**: "what slowed down the sprint?" returns nothing unless someone literally said those words

This epic adds a semantic search layer using **Ollama** (`nomic-embed-text`) — free, runs locally, no API key required. Messages are embedded at ingest time and stored as float32 BLOBs in SQLite. Hybrid search merges FTS5 and semantic results via RRF (Reciprocal Rank Fusion).

## Why Ollama Instead of OpenAI

| | Ollama (chosen) | OpenAI |
|---|---|---|
| Cost | Free | $0.02/1M tokens |
| API key | None needed | Requires account + billing |
| Privacy | Fully local | Data sent to OpenAI |
| Quality | Comparable (`nomic-embed-text` 768-dim) | Good (`text-embedding-3-small` 1536-dim) |
| Setup | `brew install ollama && ollama pull nomic-embed-text` | Sign up, add card, get key |

## Setup

```bash
brew install ollama
ollama pull nomic-embed-text
ollama serve   # runs on http://localhost:11434 by default
```

Override the base URL if needed:
```
OLLAMA_BASE_URL=http://localhost:11434   # default, can be omitted
```

No restart of the web bridge required — the system auto-detects Ollama on each `/api/system-health` check and at the start of every sync.

## How It Works

### 1. Embedding model

`nomic-embed-text` produces 768-dimensional float32 vectors from text. Each message's `subject + content` (capped at 8,000 chars) is embedded and stored in `message_embeddings`.

### 2. Indexing

`EmbeddingService.indexMessages(ids[])` is called during `runFullSync()` for all newly synced messages. Already-embedded messages are skipped (idempotent). No blocking — runs after the sync write loop.

### 3. Hybrid search (RRF)

When a search query arrives, two ranked lists are produced and merged:

```
FTS5 results (BM25 ranked)  +  Semantic results (cosine similarity)
          ↓                              ↓
          └──────── RRF merge ───────────┘
                        ↓
              Final ranked results
```

**RRF formula**: `score(d) = 1/(60 + rank_fts) + 1/(60 + semRank × 100)`

If Ollama is unavailable, the system falls back to FTS5-only silently.

### 4. Availability check

On each `/api/system-health` request, `checkOllamaAvailable()` hits `GET /api/tags` on the Ollama server (3s timeout) and confirms `nomic-embed-text` is in the model list. This is what drives the Enabled/Disabled badge in the UI.

## DB Schema

**Migration v22** (in `src/db/schema.ts`):

```sql
CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  embedding  BLOB NOT NULL,    -- 768 × float32 = 3072 bytes per row
  embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

No sqlite-vec extension needed — cosine similarity is computed in-process via JavaScript after loading candidate embeddings from the DB (candidates are pre-filtered by FTS5, so the in-memory set stays small).

## Key Files

| File | Role |
|------|------|
| `src/services/embedder.ts` | `EmbeddingService`, `checkOllamaAvailable()`, `createEmbeddingService()` |
| `src/db/schema.ts` | Migration v22 — `message_embeddings` table |
| `web-server.js` | `runFullSync()` step calls `embedder.indexMessages()`; `/api/system-health` calls `checkOllamaAvailable()` |
| `web/src/pages/SystemHealthPage.tsx` | Shows Enabled/Disabled badge + setup instructions |

## `EmbeddingService` API

```typescript
class EmbeddingService {
  // True if Ollama responded and nomic-embed-text is available
  get isEnabled(): boolean

  // Async check — result cached for the session
  async checkEnabled(): Promise<boolean>

  // Embed new messages (skips already-indexed). No-ops when Ollama unavailable.
  async indexMessages(ids: number[]): Promise<{ indexed: number; skipped: number }>

  // Hybrid FTS + semantic search with RRF merge. Falls back to FTS when not enabled.
  async hybridSearch(query: string, limit?: number, topicId?: number):
    Promise<Array<{ message_id: number; score: number; source: string }>>
}

// Factory — no config needed
export function createEmbeddingService(db: Database): EmbeddingService
```

## What Gets Better With Semantic Search

| Search query | FTS5 only | + Semantic |
|---|---|---|
| "deployment issue" | Finds messages with those words | Also finds: "release broken", "prod down", "rollback needed" |
| "budget approval" | Finds exact phrase | Also finds: "cost sign-off", "finance review", "spend limit" |
| "who owns authentication" | Rarely useful | Finds SSO, login service, auth ownership discussions |
| "sprint blocked" | Needs exact words | Finds: "waiting on", "dependency not resolved", "can't proceed" |

**Affected features:**
- **Topic Expert** — context retrieval finds semantically related messages even when phrasing differs
- **Notebook chat** — better source grounding for answers
- **Cross-topic relationships** — future: embed-based similarity can supplement Jira/people overlap

## Acceptance Criteria

- [x] Ollama auto-detected on startup — no config required when running
- [x] New messages embedded during `runFullSync()` 
- [x] Already-embedded messages skipped (idempotent)
- [x] FTS5 fallback when Ollama unavailable — zero degradation
- [x] System Health page shows Enabled/Disabled with setup instructions
- [x] TypeScript builds clean, zero errors
