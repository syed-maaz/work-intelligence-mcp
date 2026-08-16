# EP-31: Architecture Hardening

| Field | Value |
|-------|-------|
| **Epic** | EP-31 |
| **Status** | ✅ Done (Sprint 6 scope: EP-31-2/3/8 ✅; EP-31-1/4/5/6/7 deferred → Sprint 7) |
| **Sprint** | Sprint 6 |
| **Goal** | Improve codebase maintainability, observability, and resilience |

## Overview

EP-31 addresses architectural issues identified in the 2026-04-18 architecture review. It is broken into 8 sub-tickets covering structured logging, resource caching, query modularisation, input validation, service abstraction, route splitting, and retry logic.

## Sub-tickets

| ID | Title | Status |
|----|-------|--------|
| EP-31-1 | Zod validation on all POST/PUT endpoints | 🔲 Planned |
| EP-31-2 | `ResourceCache` generic TTL cache class | ✅ Done |
| EP-31-3 | Structured JSON logger (`src/lib/logger.ts`) | ✅ Done |
| EP-31-4 | Split `src/db/queries.ts` into domain files | 🔲 Planned |
| EP-31-5 | AnalysisService wrapper | 🔲 Planned |
| EP-31-6 | Split `web-server.js` into route modules | 🔲 Planned |
| EP-31-7 | `withRetry` + backoff utility | 🔲 Planned |
| EP-31-8 | Ingestion log + data quality checks (EP-33 overlap) | ✅ Done |

## Completed in this sprint

- `src/lib/logger.ts` — structured JSON logger writing to stderr  
- `src/lib/resource-cache.ts` — generic TTL cache replacing hand-rolled caches  
- `src/lib/quality-checks.ts` — pure functions for flagging data anomalies (EP-33)  
- `src/lib/index.ts` — re-exports for all lib modules  

## Deferred

EP-31-1 (Zod validation), EP-31-4 (queries split), EP-31-5 (AnalysisService), EP-31-6 (route modules), EP-31-7 (withRetry) deferred to EP-40 or Sprint 7 due to scope.
