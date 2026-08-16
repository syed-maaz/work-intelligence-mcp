---
id: ep59-recall-augmented-chat
title: EP-59 — Recall-Augmented Chat + Semantic Search
---

# EP-59 — Recall-Augmented Chat + Semantic Search

| Field | Value |
|-------|-------|
| Sprint | Sprint 15 |
| Status | ✅ Done |
| ADR | [ADR-016](../adr/adr-016-second-brain-architecture) |
| Review | [EP-59/60 Multi-Expert Review](../adr/ep59-ep60-review) |
| Schema | None |
| Depends On | EP-58 ✅ (PalaceClient v2, MemoryEnricher, palace populated with >50 drawers) |
| Effort | 5 waves (~2 weeks) |

## Problem

`chatWithContext()` relies on FTS5 BM25 keyword search + notebook content. It cannot surface semantic connections ("what happened with recommended links?" won't match "BIS blank page" without exact keyword overlap), causal chains (FF_RM_11372 → PROJ-15257), or cross-domain relationships (a person mentioned in both a meeting and a Jira ticket).

After EP-58, the palace will contain rich semantic content — but the chat pipeline doesn't use it.

## Solution

Add palace recall to every chat interaction: extract entities from the question, search palace for semantic matches + KG relationships, fuse results with existing FTS5 via Reciprocal Rank Fusion, and show provenance links so users can verify answers.

### Wave Plan

| Wave | Deliverable | Key Condition |
|------|-------------|---------------|
| 59-01 | Entity extraction — regex NER (query-time) + Haiku NER (sync-time) + 5 unit tests | 59-C1, 59-C2, 59-C10 |
| 59-02a | Palace search integration — results as `ContextItem[]`, 500ms timeout, graceful fallback | 59-C4, 59-C6, 59-C8 |
| 59-02b | RRF fusion (extend `hybridSearch`) + retrieval recall instrumentation | 59-C3, 59-C9 |
| 59-03 | KG traversal — 2-hop max, 15-node cap, cached graph (5-min TTL), natural language format | 59-C5 |
| 59-04 | Provenance UI — inline citations, existing `sources` flow, `GET /api/palace/drawer/:id` | 59-C7 |

### Key Design Decisions (from multi-expert review)

1. **Regex NER at query time** (not LLM) — Jira keys, `team_members` names, feature flags, file paths. Zero latency. LLM NER deferred until >500 drawers.
2. **Palace context as `ContextItem[]`** — assembled in `web-server.js`, no `chatWithContext()` signature change. Pipeline: Fetch (palace) → Process (rank) → Analyze (Claude).
3. **RRF fusion** — extend existing `hybridSearch()` pattern with `k=60`. Four rank lists: FTS5, embeddings, palace search, KG results.
4. **2-hop traversal** (not 3) — at ~100 triples, 3 hops returns 60%+ of graph. `maxNodes=15` safety cap.
5. **Inline citations** — reuse `addAssistantMessage` sources flow. No new component architecture.

### Touch Points

1. `src/intelligence/entity-extractor.ts` — **new**: regex/dictionary NER
2. `src/services/embedder.ts` — **extend**: RRF with palace rank lists
3. `src/intelligence/palace-client.ts` — **extend**: `traverse()` method
4. `src/intelligence/traversal-formatter.ts` — **new**: graph → natural language paths
5. `web-server.js` — **extend**: palace context in chat handlers, retrieval instrumentation, drawer endpoint
6. `web/src/components/shell/ChatPanel.tsx` — **extend**: inline citation rendering

### New Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/palace/drawer/:id` | Drawer content for provenance deep-linking |

## Success Criteria

- [x] Chat responses include palace-sourced context when relevant
- [x] Retrieval hit rate >60% for topics with >5 drawers
- [x] RRF produces better ranking than FTS5-alone (manual audit)
- [x] KG traversal returns connected paths for known entities
- [x] Provenance links clickable and resolve to source content
- [x] Chat works normally when MEMPALACE_PATH is unset
- [x] Total chat response time under 4s including palace context

## Delivery Notes

**Completed**: Sprint 15 (April 2026)

### Key Implementations

| File | What was delivered |
|------|-------------------|
| `src/intelligence/entity-extractor.ts` | Regex/dictionary NER — extracts Jira keys, team member names, feature flags, file paths at query time with zero latency. |
| `src/services/embedder.ts` | Extended `hybridSearch()` with RRF fusion (k=60). Four rank lists: FTS5, embeddings, palace search, KG results. |
| `src/intelligence/palace-client.ts` | `traverse()` method — 2-hop KG traversal, maxNodes=15 safety cap, cached graph with 5-min TTL. |
| `src/intelligence/traversal-formatter.ts` | Graph-to-natural-language formatter — converts KG paths into readable context for Claude. |
| `web-server.js` | Palace context injected in chat handlers, retrieval instrumentation, `GET /api/palace/drawer/:id` endpoint for provenance deep-linking. |
| `web/src/components/shell/ChatPanel.tsx` | Inline citation rendering — provenance links resolve to palace drawer content. |

### Design Decisions Implemented

1. **Regex NER at query time** — zero-latency entity extraction without LLM calls
2. **Palace context as `ContextItem[]`** — no `chatWithContext()` signature change needed
3. **RRF fusion with k=60** — four rank lists merged via Reciprocal Rank Fusion
4. **2-hop traversal with 15-node cap** — prevents graph explosion at current scale
5. **Inline citations** — reuses existing `addAssistantMessage` sources flow

## Sprint Plan

Full wave-by-wave plan: [59-SPRINT-PLAN.md](../../.planning/phases/59-recall-augmented-chat/59-SPRINT-PLAN.md)
