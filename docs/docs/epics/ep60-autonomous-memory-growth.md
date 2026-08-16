---
id: ep60-autonomous-memory-growth
title: EP-60 — Autonomous Memory Growth
---

# EP-60 — Autonomous Memory Growth

| Field | Value |
|-------|-------|
| Sprint | Sprint 16 |
| Status | ✅ Done |
| ADR | [ADR-016](../adr/adr-016-second-brain-architecture) |
| Review | [EP-59/60 Multi-Expert Review](../adr/ep59-ep60-review) |
| Schema | None |
| Depends On | EP-59 ✅ (retrieval instrumentation for health dashboard metrics) |
| Effort | 2 waves (~1 week) — reduced from 4 per review |

## Problem

After EP-58 populates the palace and EP-59 makes it queryable, two gaps remain:

1. **No human feedback loop** — users annotate Obsidian notes (`<!-- USER ANNOTATIONS BELOW -->`), but this knowledge never flows back into the semantic layer. The palace misses the most valuable signal: human corrections and observations.
2. **No observability** — there's no way to know if the palace is healthy, if facts are stale, or if some topics have zero coverage.

## Scope Reduction (Multi-Expert Review Decision)

| Original Wave | Decision | Rationale |
|---------------|----------|-----------|
| 60-01 `kg_invalidate` | **Moved to EP-58** (wave 58-02) | All 4 reviewers agreed: prerequisite for EP-59 accuracy. Stale triples poison recall. |
| 60-02 Obsidian annotations → palace | **Keep** | Closes human-in-the-loop gap. |
| 60-03 Cross-wing tunnels | **CUT** | Premature at under 300 drawers. KG traversal in 59-03 provides implicit cross-wing discovery. Revisit at 300+ drawers. |
| 60-04 Health dashboard | **Deprioritized** | Execute if 60-02 completes ahead of schedule. Gated on EP-59 instrumentation. |

### Wave Plan

| Wave | Deliverable | Key Condition |
|------|-------------|---------------|
| 60-02 | Obsidian annotations → palace — on-sync extraction, optional `fs.watch`, content hash dedup, human-wins conflict resolution | 60-C3, 60-C4, 60-C6 |
| 60-04 | Memory health dashboard — 4 metrics (stale facts, orphan rate, topic coverage, retrieval hit rate), `MemoryHealthPanel` | 60-C5, 60-C8 |

### Key Design Decisions (from multi-expert review)

1. **On-sync primary** (not real-time) — scan vault during `runFullSync()` every 15 min. Optional `fs.watch` with 2s debounce for faster feedback.
2. **Human wins** — when annotations contradict KG triples, human override creates new triple. Audit trail via `palace.diaryWrite()`.
3. **Node.js native `fs.watch`** (not chokidar) — no extra dependency. Content SHA-256 hash prevents duplicate ingestion.
4. **Exactly 4 metrics** — stale facts, orphan entity rate, topic coverage, retrieval hit rate. No embedding quality proxies at this scale.
5. **Palace is now backup-critical** — human annotations not rebuildable from SQLite. Document in ops runbook.

### Touch Points

1. `src/tools/obsidian-export.ts` — **extend**: annotation extraction below `<!-- USER ANNOTATIONS BELOW -->` marker
2. `src/intelligence/memory-enricher.ts` — **extend**: annotation processing + conflict detection
3. `web-server.js` — **extend**: `fs.watch` setup, health detailed endpoint
4. `web/src/components/shared/MemoryHealthPanel.tsx` — **new**: 4-metric health cards
5. `web/src/pages/DashboardPage.tsx` — **extend**: render `MemoryHealthPanel`

### New Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/palace/health/detailed` | 4 health metrics with thresholds |
| POST | `/api/palace/health/refresh` | On-demand health recalculation |

## Success Criteria

- [x] Obsidian annotations flow into palace drawers on sync
- [x] Content hash prevents duplicate annotation ingestion
- [x] Human annotations override conflicting KG triples with audit trail
- [x] `fs.watch` triggers extraction within 5s of file save
- [x] Palace backup documentation updated
- [x] Health dashboard shows 4 metrics with color thresholds
- [x] Zero regression: sync loop timing unaffected

## Delivery Notes

**Completed**: Sprint 16 (April 2026)

### Key Implementations

| File | What was delivered |
|------|-------------------|
| `src/tools/obsidian-export.ts` | Annotation extraction below `<!-- USER ANNOTATIONS BELOW -->` marker. On-sync scanning during `runFullSync()` every 15 min. Content SHA-256 hash deduplication. |
| `src/intelligence/memory-enricher.ts` | Annotation processing + human-wins conflict resolution. When annotations contradict KG triples, human override creates new triple with audit trail via `palace.diaryWrite()`. |
| `web-server.js` | `fs.watch` setup with 2s debounce for near-realtime annotation pickup. `GET /api/palace/health/detailed` (4 metrics) and `POST /api/palace/health/refresh` endpoints. |
| `web/src/components/shared/MemoryHealthPanel.tsx` | 4-metric health cards: stale facts, orphan entity rate, topic coverage, retrieval hit rate. Color-coded thresholds. |
| `web/src/pages/DashboardPage.tsx` | `MemoryHealthPanel` rendered on main dashboard. |

### Design Decisions Implemented

1. **On-sync primary** — vault scanned during `runFullSync()` every 15 min; optional `fs.watch` with 2s debounce for faster feedback
2. **Human wins** — annotations override KG triples with audit trail via `palace.diaryWrite()`
3. **Node.js native `fs.watch`** — no chokidar dependency; content SHA-256 prevents duplicate ingestion
4. **Exactly 4 metrics** — stale facts, orphan rate, topic coverage, retrieval hit rate

### Deferred Work

| Item | Trigger |
|------|---------|
| 60-03 Cross-wing tunnel auto-discovery | Palace exceeds 300 drawers |
| LLM query-time NER | Palace exceeds 500 drawers |
| 3-hop KG traversal | Palace exceeds 500 triples |
| Embedding model swap | Retrieval hit rate drops below 50% |

## Sprint Plan

Full wave-by-wave plan: [60-SPRINT-PLAN.md](../../.planning/phases/60-autonomous-memory-growth/60-SPRINT-PLAN.md)
