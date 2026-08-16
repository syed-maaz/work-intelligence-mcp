---
id: ep62-quick-wins-wave1b
title: EP-62 — Quick Wins Wave 1b (Sprint Config + Eviction)
---

# EP-62 — Quick Wins Wave 1b (Sprint Config + Eviction)

| Field | Value |
|-------|-------|
| Sprint | Sprint 17 |
| Status | ✅ Done (2026-05-03) |
| ADR | [ADR-017](../adr/adr-017-always-on-agent-architecture) |
| Schema | v39 (`sprint_config` table) |
| Depends On | EP-61 ✅ |
| Effort | 1 wave |

## Problem

1. The Saturn-93 sprint name and date range were hardcoded in `web-server.js` — switching sprints required a code deploy.
2. `proactive_queue` had no eviction — rows accumulated indefinitely when the bridge was stopped.
3. No way to detect embedding availability from the primary status endpoint.

## Solution

Move sprint config to a DB table with REST endpoints, add 24h max-age eviction to the queue, and surface `embeddingsAvailable` in `/api/status`.

## Success Criteria

- [x] `sprint_config` table created with seed row for Saturn-93
- [x] `GET /api/config/sprint` returns active sprint as JSON
- [x] `PUT /api/config/sprint` updates sprint atomically (deactivate all, insert new)
- [x] All hardcoded Saturn-93 literals removed from `web-server.js`
- [x] `proactive_queue` 24h eviction runs on every SSE drain cycle
- [x] `embeddingsAvailable` field in `/api/status` response
- [x] Migration is non-destructive (`INSERT OR IGNORE`)

## Delivery Notes

**Completed**: Sprint 17 (2026-05-03)

### Key Implementations

| File | What was delivered |
|------|-------------------|
| `src/db/schema.ts` | Schema v39 — `sprint_config` table (`id`, `sprint_name`, `project_key`, `start_date`, `end_date`, `active`, `created_at`) with partial index on `active`. Seeds Saturn-93 row via `INSERT OR IGNORE`. |
| `web-server.js` | `GET /api/config/sprint` returns active row (404 if none). `PUT /api/config/sprint` runs atomic transaction: deactivate all → insert new → invalidate `sprintMeta` cache. All five Saturn-93 literals replaced with `_activeSprint` DB reads. |
| `web-server.js` | SSE drain now runs `DELETE FROM proactive_queue WHERE created_at < datetime('now', '-24 hours')` before SELECT. Prevents unbounded growth. |
| `web-server.js` | `/api/status` converted to async IIFE calling `checkOllamaAvailable()`, surfacing `embeddingsAvailable` boolean. |

### Design Decisions

1. **`INSERT OR IGNORE` with explicit id=1** — prevents duplicate seed on re-run
2. **`readBody(req)` not `parseBody(req)`** — raw JSON parser (plan had a typo)
3. **`_activeSprint` fallback to `'Unknown'`** — avoids crash if all rows deleted
