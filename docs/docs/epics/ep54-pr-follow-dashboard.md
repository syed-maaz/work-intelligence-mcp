---
id: ep54-pr-follow-dashboard
title: EP-54 — PR Follow Dashboard
---

# EP-54 — PR Follow Dashboard

| Field | Value |
|-------|-------|
| Sprint | Sprint 11 |
| Status | ✅ Done (2026-04-21) |
| ADR | ADR-011 (PR Intelligence Overhaul) |
| Schema | v34 (watched_prs table — pre-existing) |
| Depends On | EP-44 ✅ (watched_prs table, PRReviewPage) |
| Effort | ~1 session (2 plans) |

## Problem

The `watched_prs` table was added in schema v34 but never wired to REST endpoints — PR follow state lived in localStorage only. No way to see all followed PRs at a glance without navigating to each repo's PR Review page.

## Decisions Made

1. **DB-backed follow state** — Wire `watched_prs` (schema v34) to REST endpoints; eliminate localStorage dependency. One-time migration copies existing localStorage follow entries to DB on first page load.
2. **Three watch endpoints** — `GET /api/pr/watch?repo=`, `POST /api/pr/watch`, `DELETE /api/pr/watch` — idempotent insert, correct HTTP status codes (200/201/204).
3. **Dashboard widget** — `MyPRsWidget` as a full-width row below the 2-col Jira boards grid; polls every 2 minutes.
4. **gh CLI per-PR** — `GET /api/pr/watched-summary` fetches live PR state via `gh pr view --json`; stub fallback when PR is deleted/merged/inaccessible.
5. **Stale badge** — OPEN PR with no update in 3+ days → amber `Stale` badge. Closed/merged PRs remain visible without stale marker.

## New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/pr/watch?repo=` | Returns `{ prs: number[] }` — watched PR numbers for a repo |
| POST | `/api/pr/watch` | Body `{ repo, pr }` — follow a PR (201, idempotent via INSERT OR IGNORE) |
| DELETE | `/api/pr/watch?repo=&pr=` | Unfollow a PR (204) |
| GET | `/api/pr/watched-summary` | Returns `{ items: WatchedPRSummary[] }` — all followed PRs with live state |

## New Components

- `web/src/components/shared/MyPRsWidget.tsx` — dashboard widget; shows all followed PRs grouped by repo with state badges, stale highlighting, empty state, and 2-min polling

## Schema

No new schema. Uses existing `watched_prs` table from schema v34:

```sql
CREATE TABLE watched_prs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  repo    TEXT NOT NULL,   -- "org/repo"
  pr      INTEGER NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo, pr)
);
```

## Acceptance Criteria

- [x] `GET /api/pr/watch?repo=` returns `{ prs: number[] }` for watched PRs
- [x] `POST /api/pr/watch` body `{ repo, pr }` returns 201 (idempotent)
- [x] `DELETE /api/pr/watch?repo=&pr=` returns 204
- [x] `GET /api/pr/watched-summary` returns live PR state from gh CLI
- [x] PRReviewPage migrated from localStorage → DB; legacy localStorage entries migrated on first load
- [x] `MyPRsWidget` rendered on DashboardPage below Jira boards
- [x] Stale badge shown for OPEN PRs with no update in 3+ days
- [x] Empty state: "No followed PRs — follow PRs from the PR Review page"
- [x] TypeScript typecheck and build clean
- [x] Smoke test: all endpoints return correct status codes

## Plans

| Plan | File | What it built |
|------|------|---------------|
| 54-01 | `54-01-PLAN.md` | GET/POST/DELETE /api/pr/watch endpoints + api.ts methods + PRReviewPage DB migration |
| 54-02 | `54-02-PLAN.md` | GET /api/pr/watched-summary + MyPRsWidget + DashboardPage integration |

## Key Patterns Established

- **DB-backed watch pattern**: GET to load on mount, POST/DELETE on toggle, localStorage migration as one-time side effect
- **Stale detection**: `staleDays(updatedAt, state)` — returns null when not stale, number of days when stale (≥3)
- **gh CLI with stub fallback**: per-PR state fetch via `execFileSync`; on error, push stub item with `state: 'UNKNOWN'`
