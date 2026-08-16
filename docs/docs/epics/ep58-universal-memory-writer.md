---
id: ep58-universal-memory-writer
title: EP-58 — Universal Memory Writer + Persistent Palace Process
---

# EP-58 — Universal Memory Writer + Persistent Palace Process

| Field | Value |
|-------|-------|
| Sprint | Sprint 14 |
| Status | ✅ Done |
| ADR | [ADR-016](../adr/adr-016-second-brain-architecture) |
| Review | [ADR-016 Multi-Expert Review](../adr/adr-016-review) |
| Schema | v37 (`investigation_sessions.palace_payload TEXT`) |
| Depends On | EP-57 ✅ (PalaceClient v1, palace-seeder, investigation wiring) |
| Effort | 6 waves (~2 weeks) |

## Problem

EP-57 delivered MemPalace as an additive sidecar, but exposed six critical deficiencies (D1–D6 in ADR-016):

1. **`execFileSync` blocks the event loop** — 594ms warm, 5s cold per call. Seeder startup = 89s of total blocking.
2. **Palace starving** — only written on investigation conclude (0 times in production). All other data sources excluded.
3. **Obsidian disconnected** — one-directional export, no palace awareness.
4. **KG only knows feature flags** — people, tickets, meetings, conversations invisible.
5. **Hardcoded Python path** — only works on one machine.
6. **No deduplication or staleness** — seeder writes triples on every startup without existence check.

## Solution

Replace subprocess-per-call with a **persistent MCP child process** and wire palace into the sync loop as a **universal memory writer**.

### Wave Plan

| Wave | Deliverable | Key Condition |
|------|-------------|---------------|
| 58-01 | PalaceClient v2: persistent MCP stdio, portable path, auto-restart, integration test | B1, B2, R1, R3 |
| 58-02 | `MemoryEnricher` service + `kgInvalidate()` + Haiku NER entity extraction | R2, R7, 60-C1 |
| 58-03 | Wire into `runFullSync()` step 4c + fix seeder idempotency + `palace:rebuild` | R4, R5 |
| 58-04 | Obsidian export `## Deep Memory` section with palace search + KG query | — |
| 58-05 | Persist investigation outputs to SQLite (schema v37) + health endpoint | B3, R6 |
| 58-06 | Benchmark + exit strategy docs + `check:palace` diagnostic | B4, B5 |

### Touch Points

1. `src/intelligence/palace-client.ts` — **rewrite**: `@modelcontextprotocol/sdk` `StdioClientTransport`, child process lifecycle, portable Python path
2. `src/intelligence/memory-enricher.ts` — **new**: standalone service (notebooks → drawers, Jira → KG, messages → conversations, meetings → drawers)
3. `src/intelligence/palace-seeder.ts` — **fix**: deterministic `valid_from`, startup idempotency guard
4. `src/tools/obsidian-export.ts` — **extend**: optional `PalaceClient` param, `## Deep Memory` injection
5. `src/intelligence/investigation-orchestrator.ts` — **extend**: `writeToPalace()` also persists to `investigation_sessions.palace_payload`
6. `web-server.js` — **extend**: step 4c wiring, `GET /api/palace/status` endpoint
7. `src/db/schema.ts` — **v37**: `investigation_sessions.palace_payload TEXT`
8. `scripts/palace-rebuild.ts` — **new**: replay SQLite → palace
9. `scripts/check-palace.ts` — **new**: Python env diagnostic

### New Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/palace/status` | Palace process health + drawer/triple counts |

### New Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `MEMPALACE_PYTHON` | Override Python path for MemPalace | Auto-detect |

## Success Criteria

- [x] `tool_status` returns within 50ms after init
- [x] Palace process auto-restarts after SIGKILL within 5s
- [x] Seeder completes in under 5s (was 89s)
- [x] Sync step 4c writes drawers + KG triples without blocking
- [x] `kgInvalidate()` end-dates stale Jira triples
- [x] Investigation outputs persisted to `palace_payload` column
- [x] `GET /api/palace/status` returns `connected: true`
- [x] `MEMPALACE_PATH` unset → all palace behavior is no-op
- [x] No hardcoded paths
- [x] After 1 week: >50 drawers, >50 KG triples, >80% topics non-empty recall

## Delivery Notes

**Completed**: Sprint 14 (April 2026)

### Key Implementations

| File | What was delivered |
|------|-------------------|
| `src/intelligence/palace-client.ts` | PalaceClient v2 — persistent MCP child process via `StdioClientTransport`. Replaced `execFileSync` (594ms/call → under 5ms/call). Auto-restart on crash, portable Python path via `MEMPALACE_PYTHON` env var. |
| `src/intelligence/memory-enricher.ts` | `MemoryEnricher` service — universal sync→palace writer covering 5 wings: topics, conversations, meetings, investigations, jira tickets. Haiku NER for entity extraction. |
| `src/intelligence/palace-seeder.ts` | Fixed startup idempotency — deterministic `valid_from`, existence-check before write, seeder completes in under 3s (was 89s). |
| `src/tools/obsidian-export.ts` | `## Deep Memory` section injected into topic notes — palace drawers + KG entity relationships. |
| `src/intelligence/investigation-orchestrator.ts` | `writeToPalace()` persists to both palace AND `investigation_sessions.palace_payload` column for rebuild support. |
| `web-server.js` | Step 4c wiring in sync loop + `GET /api/palace/status` health endpoint. |
| `src/db/schema.ts` | Schema v37: `investigation_sessions.palace_payload TEXT` column. |
| `scripts/palace-rebuild.ts` | `npm run palace:rebuild` — replays all SQLite data into MemPalace from scratch. |
| `scripts/check-palace.ts` | `npm run check:palace` — diagnostic for Python env, mempalace version, ChromaDB status. |

### Performance Results

| Metric | Before (EP-57) | After (EP-58) |
|--------|----------------|---------------|
| Palace call latency | 594ms (execFileSync) | Under 5ms (persistent stdio) |
| Seeder startup | 89s blocking | Under 3s non-blocking |
| Palace population | Investigation-only (0 in prod) | All 5 data wings auto-populated |
| Graceful degradation | Crash on missing Python | No-op when `MEMPALACE_PATH` unset |

### Commands

```bash
npm run check:palace    # Diagnostic: Python env, mempalace version, ChromaDB status
npm run palace:rebuild  # Replay all SQLite data into MemPalace
```

## Sprint Plan

Full wave-by-wave plan: [58-SPRINT-PLAN.md](../../.planning/phases/58-universal-memory-writer/58-SPRINT-PLAN.md)
