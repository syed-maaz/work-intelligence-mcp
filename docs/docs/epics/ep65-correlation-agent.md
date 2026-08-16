---
id: ep65-correlation-agent
title: EP-65 — CorrelationAgent (Cross-Topic Signal Surfacing)
---

# EP-65 — CorrelationAgent (Cross-Topic Signal Surfacing)

| Field | Value |
|-------|-------|
| Sprint | Sprint 17 |
| Status | ✅ Done (2026-05-04) |
| ADR | [ADR-017](../adr/adr-017-always-on-agent-architecture) |
| Schema | None |
| Depends On | EP-64 ✅ |
| Effort | 1 wave |

## Problem

Related signals across different topics (Jira tickets, Teams discussions, code changes) were invisible to each other. A developer might not notice that a Teams conversation about "recommended links" is directly connected to PROJ-15257 and a feature flag change in operations repo — unless they manually searched each source.

## Solution

Build CorrelationAgent — a nightly analysis agent that traverses the knowledge graph to find entities appearing in multiple contexts within the last 7 days, generates a "here's what's converging" digest, and pushes it to `proactive_queue`.

## Success Criteria

- [x] CorrelationAgent runs on 24h nightly schedule
- [x] First run fires 5 minutes after startup (catch-up)
- [x] Queries MemPalace KG for multi-context entities (last 7 days)
- [x] Uses OrchestratorAgent as execution engine with correlation-specific tools
- [x] Generates convergence digest via Claude Haiku
- [x] Digest links related Jira tickets, Teams discussions, and code changes
- [x] Writes digest to `proactive_queue` for SSE delivery
- [x] Gracefully no-ops when MemPalace is not connected
- [x] Errors caught and logged, never crash the server

## Delivery Notes

**Completed**: Sprint 17 (2026-05-04)

### Key Implementations

| File | What was delivered |
|------|-------------------|
| `src/intelligence/correlation-agent.ts` | CorrelationAgent class — uses OrchestratorAgent with correlation-specific tools (KG query, topic fetch, cross-reference check). Queries palace for entities in 2+ contexts within 7 days. |
| `web-server.js` | Nightly schedule wiring — 24h `setTimeout` in boot block. First run at T+5min after startup. Graceful no-op when palace disconnected. |
| `proactive_queue` | Convergence digests written as JSON events with `agent: 'correlation'`, delivered via existing SSE endpoint. |

### Design Decisions

1. **Nightly cadence** — correlations are slow-forming; more frequent runs waste tokens
2. **T+5min first run** — catches up on missed nightly cycle without blocking startup
3. **OrchestratorAgent as engine** — reuses EP-64's tool_use loop, no duplication
4. **7-day window** — long enough to catch cross-sprint connections, short enough to stay relevant
5. **Graceful no-op** — zero regression when MemPalace is disabled
