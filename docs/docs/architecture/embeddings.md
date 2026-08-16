---
sidebar_position: 6
title: Semantic Search & Embeddings
---

# Semantic Search & Embeddings

## Overview

Work Intelligence uses a **hybrid search** approach that combines two complementary ranking signals:

1. **FTS5 (BM25)** — SQLite full-text search. Fast, exact/stemmed keyword matching. Always available.
2. **Semantic (cosine similarity)** — vector embeddings via Ollama. Understands meaning, not just words. Active when Ollama is running locally.

Results from both signals are merged using **RRF (Reciprocal Rank Fusion)** to produce a single ranked list.

---

## Why Hybrid?

| Signal | Strengths | Weaknesses |
|--------|-----------|------------|
| FTS5 | Exact matches, Jira keys, names, fast | Misses synonyms, paraphrasing, concept queries |
| Semantic | Synonyms, paraphrasing, intent | Can surface irrelevant results when context is thin |
| **Hybrid** | Both | Slightly more latency on query |

---

## Embedding Model: `nomic-embed-text` via Ollama

**Why Ollama instead of OpenAI:**
- Free — no API key, no billing
- Fully local — data never leaves your machine
- `nomic-embed-text` quality is comparable to `text-embedding-3-small`
- Single command to set up

**Setup:**
```bash
brew install ollama
ollama pull nomic-embed-text
ollama serve        # starts on http://localhost:11434
```

Override the default URL if needed:
```
OLLAMA_BASE_URL=http://localhost:11434
```

---

## Data Flow

```
runFullSync()
    │
    ├─ upsertMessage(id) → writes to messages table
    │
    └─ embedder.indexMessages([id, ...])
           │
           ├─ Skip already-embedded (idempotent)
           ├─ POST /api/embeddings  →  Ollama nomic-embed-text
           └─ Store float32[768] BLOB → message_embeddings table


Query time (e.g. notebook chat, topic expert):
    │
    ├─ FTS5 search → top 30 BM25-ranked message IDs
    │
    ├─ Semantic: embed(query) → cosine_similarity(query_vec, stored_vecs)
    │
    └─ RRF merge: score = 1/(60+fts_rank) + 1/(60+sem_rank×100)
                  → top 15 results returned
```

---

## Storage

**Table:** `message_embeddings` (schema v22)

```sql
CREATE TABLE message_embeddings (
  message_id  INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  embedding   BLOB NOT NULL,    -- 768 × float32 = 3072 bytes per row
  embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Size estimate:** 3 KB per message. 10,000 messages ≈ 30 MB.

No sqlite-vec extension required — cosine similarity runs in-process in JavaScript. FTS5 pre-filters candidates to a small set (~30), so loading those vectors and computing similarity in memory is fast.

---

## Availability & Graceful Degradation

The system checks Ollama availability:
- On every `/api/system-health` request (shown in System Health page)
- Via `EmbeddingService.checkEnabled()` at the start of any indexing run

**When Ollama is not running:** all search automatically falls back to FTS5-only. No errors, no config changes needed. The System Health page shows "Disabled" with setup instructions.

---

## RRF Merge Formula

```
score(doc) = 1 / (60 + fts_rank)        ← FTS5 BM25 rank (0 = best)
           + 1 / (60 + semRank × 100)   ← semRank = 1 - cosine_sim (0 = best)
```

The constant `60` is the standard RRF smoothing factor. Higher cosine similarity → lower `semRank` → higher contribution to the final score.

---

## Key Files

| File | Role |
|------|------|
| `src/services/embedder.ts` | `EmbeddingService`, `checkOllamaAvailable()`, `hybridSearch()` |
| `src/db/schema.ts` | Migration v22 — `message_embeddings` table |
| `web-server.js` | Calls `indexMessages()` in `runFullSync()`; calls `checkOllamaAvailable()` in `/api/system-health` |
| `web/src/pages/SystemHealthPage.tsx` | Enabled/Disabled status card with setup instructions |

---

## Enabling Step by Step

1. Install Ollama: `brew install ollama`
2. Pull the model: `ollama pull nomic-embed-text`
3. Start Ollama: `ollama serve` (or it auto-starts on macOS after install)
4. Trigger a sync: click **Run Checks** on System Health page or **Sync All** on the dashboard
5. The next sync will embed all new messages. Existing messages are embedded incrementally.
6. System Health page will show **Enabled** with the indexed message count.
