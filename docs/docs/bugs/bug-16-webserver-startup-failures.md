---
title: "BUG-16: web-server.js startup failures (DB, retry storm, qs)"
sidebar_label: "BUG-16: Startup failures"
---

# BUG-16: web-server.js startup failures — DB uninitialised, retry storm, undefined `qs`

| | |
|---|---|
| **Severity** | 🔴 Breaking |
| **Status** | ✅ Fixed |
| **File** | `web-server.js` |
| **Discovered** | April 2026 (EP-41 first-run) |

## Three compounding bugs

### Bug A — `db` never initialised

`getDatabase()` was imported but never called. Every DB operation threw `ReferenceError: db is not defined` on the first request.

**Root cause:** `const db = getDatabase()` was missing at the top-level of `web-server.js`.

**Fix:** Added `const db = getDatabase();` immediately after the constant declarations (line 31).

---

### Bug B — Wrong `DATABASE_PATH` — silent empty database

`.env` had `DATABASE_PATH` commented out. The code default resolves to `~/.work-intelligence-mcp/data.db`, but the server was pointed at `./data/work-intelligence.db` (an empty test file). All topics, messages, and Jira data appeared missing.

**Root cause:** Documentation and `.env` template referred to `./data/intelligence.db` / `./data/work-intelligence.db`. Real user data lives in `~/.work-intelligence-mcp/data.db` (the MCP server default).


**Prevention:** `getDatabase()` already logs the resolved path to stderr on startup — always check `[DB] Using database at: ...` in bridge logs on first run.

---

### Bug C — Retry storm starving the Node.js event loop

With `JIRA_SOURCE=mcp` and an expired MCP token, the Saturn and MyIssues cache refresh functions failed instantly (HTTP 401, ~0ms). The `isRefreshing` flag reset to `false` immediately, and the next frontend poll (every 3s) triggered another refresh — a tight synchronous retry loop that consumed all of Node's event loop, making every HTTP request time out with `ECONNREFUSED` or hang indefinitely.

**Root cause:** No cooldown after failed cache refreshes. Any error (including auth failures) caused `isRefreshing = false` instantly, allowing the next poll to fire another attempt.

**Fix:**
- Added `lastFailedAt: 0` to both `saturnCache` and `myIssuesCache`.
- Set `lastFailedAt = Date.now()` in the `catch` block of each refresh function.
- Added `coolingDown = (Date.now() - lastFailedAt) < 60_000` guard before triggering a new refresh.
- Changed `JIRA_SOURCE=auto` (falls back to browser scraper when MCP unavailable).

---

### Bug D — `qs` undefined on three endpoints

Three endpoints used `qs.status`, `qs.limit`, `qs.topic` — a variable that was never defined. The rest of the file uses `url.searchParams.get(...)` consistently.

**Affected endpoints:** `GET /api/data-quality`, `GET /api/action-items/pending-review`, `GET /api/ingestion-log`

**Fix:** Replaced all `qs.*` references with `url.searchParams.get('...')`.

---

### Bug E — `action_items.created_at` does not exist

`getPendingReviewItems()` and `autoPromotePendingItems()` in `src/db/queries/action-items.ts` referenced `created_at` in SQL. The `action_items` table has no such column (confirmed via `PRAGMA table_info`).

**Fix:**
- `ORDER BY created_at DESC` → `ORDER BY id DESC`
- `AND created_at < datetime(...)` → `AND confirmed_at < datetime(...)`

---

## How to prevent

1. **Always start and curl-test the server after any `web-server.js` change** — `curl http://localhost:3132/api/status` must respond before calling a task done.
2. **Check bridge logs for `[DB] Using database at:`** on every startup to confirm the right DB is open.
3. **Never introduce new query-string variable names** — use `url.searchParams.get('key')` exclusively.
4. **Before adding SQL column references**, verify with `PRAGMA table_info(table_name)`.
5. **Add 60s cooldown to any fire-and-forget background refresh** that can fail fast (auth errors, network errors).
