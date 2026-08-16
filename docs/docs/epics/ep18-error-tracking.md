---
title: "EP-18: Error Tracking & Auto Bug Report"
sidebar_label: "EP-18: Error Tracking"
---

# EP-18: Error Tracking & Auto Bug Report

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Agent Role** | Backend / Full-Stack Engineer |
| **Depends On** | — |
| **Blocks** | — |
| **File Scope** | `src/db/schema.ts` (edit), `src/db/queries.ts` (edit), `src/tools/error-analyzer.ts` (new), `web-server.js` (edit), `web/src/lib/api.ts` (edit), `web/src/components/shared/ErrorLogSection.tsx` (new), `web/src/pages/DashboardPage.tsx` (edit) |

## Goal

Persist all API errors to SQLite instead of losing them to stderr. Surface recent errors on the Dashboard with severity badges. Allow on-demand AI analysis (Claude Haiku) of each error to suggest a fix. The user said: "if error happens during the fetch it should be able to log everything create a bug ticket automatically and report to me and best try to solve it."

## Decisions Made

- **Persist in SQLite, not a log file**: Consistent with the project's "everything in the DB" philosophy. Allows queries, filtering, and UI rendering without parsing log files.
  - **Rejected**: Writing to a `.log` file — harder to query, needs log rotation, not queryable from the frontend.
- **Synchronous `persistError()`**: Uses `better-sqlite3`'s synchronous `.run()`. Never async — we don't want error persistence to fail silently due to an unhandled promise rejection.
  - **Rejected**: Async DB write — could fail without the caller noticing, and adds complexity.
- **AI analysis on-demand, not automatic**: Claude Haiku is only called when the user clicks "Analyze" on an error — not on every error. Avoids API costs for noise (e.g., 404s).
  - **Rejected**: Auto-analyze every error — would burn API credits on repeated health-check failures.
- **30-day auto-cleanup on startup**: Delete `error_logs` older than 30 days on each `web-server.js` start. Keeps the table bounded without needing a separate cron job.
- **Auto Jira ticket**: Stretch goal, gated behind `JIRA_AUTO_TICKET_BOARD` env var. Only fires when `shouldCreateTicket: true` from the analyzer AND env var is set.

## What Will Be Built

### DB Migration — `src/db/schema.ts` (edit)

Bump `CURRENT_SCHEMA_VERSION`. Add migration:

```sql
CREATE TABLE IF NOT EXISTS error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL,          -- e.g. 'api:/api/jira-report', 'sync:jira'
  message TEXT NOT NULL,
  stack TEXT,
  request_path TEXT,             -- e.g. '/api/saturn/issues'
  severity TEXT NOT NULL DEFAULT 'error',  -- 'info' | 'warn' | 'error' | 'critical'
  category TEXT,                 -- NULL until AI-analyzed
  suggested_fix TEXT,            -- NULL until AI-analyzed
  resolved INTEGER NOT NULL DEFAULT 0,
  jira_ticket_key TEXT           -- set if auto-ticket created, e.g. 'PROJ-15099'
);
CREATE INDEX IF NOT EXISTS idx_error_logs_occurred_at ON error_logs(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_severity ON error_logs(severity, resolved);
```

### `src/db/queries.ts` (edit)

```ts
export function insertErrorLog(db: Database, data: {
  source: string; message: string; stack?: string;
  requestPath?: string; severity?: 'info' | 'warn' | 'error' | 'critical';
}): number  // returns new row id

export function listErrorLogs(db: Database, opts: {
  limit?: number; resolved?: boolean; severity?: string;
}): ErrorLog[]

export function markErrorResolved(db: Database, id: number): void

export function updateErrorAnalysis(db: Database, id: number, data: {
  category: string; suggestedFix: string; severity: string;
}): void

export interface ErrorLog {
  id: number; occurred_at: string; source: string; message: string;
  stack: string | null; request_path: string | null; severity: string;
  category: string | null; suggested_fix: string | null;
  resolved: number; jira_ticket_key: string | null;
}
```

### `src/tools/error-analyzer.ts` (new)

```ts
export interface ErrorAnalysis {
  severity: 'info' | 'warn' | 'error' | 'critical';
  category: string;       // e.g. "DB schema mismatch", "Auth expired", "Network timeout"
  suggestedFix: string;   // 1-2 sentence actionable suggestion
  shouldCreateTicket: boolean;
}

export async function analyzeError(
  errorMessage: string,
  stack: string | null,
  requestPath: string | null,
  anthropicApiKey: string
): Promise<ErrorAnalysis>
```

Uses `claude-haiku-4-5-20251001` with tool use (structured output). System prompt: "You are a debugging assistant. Categorize this error and suggest a fix in 1-2 sentences."

### `web-server.js` (edit)

Add near top (after `const db = getDatabase()`):
```js
function persistError(db, { source, message, stack, requestPath, severity = 'error' }) {
  try {
    db.prepare(`
      INSERT INTO error_logs (source, message, stack, request_path, severity)
      VALUES (?, ?, ?, ?, ?)
    `).run(source, message, stack ?? null, requestPath ?? null, severity);
  } catch (e) {
    process.stderr.write('[persistError] Failed to log error: ' + e.message + '\n');
  }
}
```

Modify existing `catch (err)` block:
```js
} catch (err) {
  console.error('[API Error]', err);
  persistError(db, { source: 'api', message: err.message, stack: err.stack, requestPath: path });
  json(res, 500, { error: err instanceof Error ? err.message : String(err) });
}
```

On startup (after `const db = getDatabase()`):
```js
db.prepare("DELETE FROM error_logs WHERE occurred_at < datetime('now', '-30 days')").run();
```

New endpoints:
```
GET  /api/errors?limit=20&resolved=0        → ErrorLog[]
POST /api/errors/:id/analyze                → { updated: ErrorLog }
POST /api/errors/:id/resolve                → { ok: true }
```

### `web/src/components/shared/ErrorLogSection.tsx` (new)

Renders a dashboard card:
- Last 5 unresolved errors
- Each row: `severity` Badge, message (80-char truncated), `request_path`, `formatRelative(occurred_at)`
- Expand row: shows full message + stack in a `<pre>` block
- "Analyze" button → `POST /api/errors/:id/analyze` → shows `category` + `suggested_fix` inline
- "Resolve" button → `POST /api/errors/:id/resolve` → removes from list
- Empty state: green checkmark + "No errors in the last 24 hours"

### `web/src/lib/api.ts` (edit)

```ts
export interface ErrorLog {
  id: number; occurred_at: string; source: string; message: string;
  stack: string | null; request_path: string | null; severity: string;
  category: string | null; suggested_fix: string | null; resolved: number;
}

listErrors: (p?: { limit?: number; resolved?: number }) => request<ErrorLog[]>(...)
analyzeError: (id: number) => request<{ updated: ErrorLog }>('/api/errors/' + id + '/analyze', {})
resolveError: (id: number) => request<{ ok: boolean }>('/api/errors/' + id + '/resolve', {})
```

## Environment Variables

```bash
JIRA_AUTO_TICKET_BOARD=BDS   # optional: auto-create Jira bug tickets for critical errors
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-18-1 | DB migration: `error_logs` table — **File:** `src/db/schema.ts` | ✅ Done |
| EP-18-2 | Add `insertErrorLog`, `listErrorLogs`, `markErrorResolved`, `updateErrorAnalysis` — **File:** `src/db/queries.ts` | ✅ Done |
| EP-18-3 | Add `persistError()` helper + wrap `catch(err)` — **File:** `web-server.js` | ✅ Done |
| EP-18-4 | Add startup 30-day cleanup — **File:** `web-server.js` | ✅ Done |
| EP-18-5 | Add `GET /api/errors`, `POST /api/errors/:id/analyze`, `POST /api/errors/:id/resolve` — **File:** `web-server.js` | ✅ Done |
| EP-18-6 | Create `analyzeError()` using Claude Haiku — **File:** `src/tools/error-analyzer.ts` | ✅ Done |
| EP-18-7 | Add `ErrorLog` type + `listErrors`, `analyzeError`, `resolveError` — **File:** `web/src/lib/api.ts` | ✅ Done |
| EP-18-8 | Build `ErrorLogSection` component — **File:** `web/src/components/shared/ErrorLogSection.tsx` | ✅ Done |
| EP-18-9 | Add `<ErrorLogSection />` to dashboard bottom — **File:** `web/src/pages/DashboardPage.tsx` | ✅ Done |
| EP-18-10 | (Stretch) Auto Jira ticket on `shouldCreateTicket: true` gated by `JIRA_AUTO_TICKET_BOARD` — **File:** `web-server.js` | 🔲 TODO |

## Acceptance Criteria

- [x] `error_logs` table exists with correct schema after migration
- [x] All `catch (err)` blocks in `web-server.js` persist to `error_logs`
- [x] `GET /api/errors` returns correct filtered list
- [x] `POST /api/errors/:id/analyze` calls Claude Haiku and stores result
- [x] Errors older than 30 days are deleted on server startup
- [x] `ErrorLogSection` renders on Dashboard with correct severity badges
- [x] "Resolve" removes error from visible list
- [x] Empty state shown when no errors exist
- [x] `npm run typecheck` passes with zero errors
- [x] `npm run build` compiles cleanly

## Sample Usage

```bash
# Trigger a deliberate error and check it was logged
curl -X POST http://localhost:3132/api/digest -d '{"topic":"nonexistent"}'
# → 500 error

curl http://localhost:3132/api/errors?limit=5
# → [{ id: 1, message: "Topic nonexistent not found", severity: "error", ... }]

curl -X POST http://localhost:3132/api/errors/1/analyze
# → { updated: { category: "Missing data", suggested_fix: "Create the topic first via /api/configure-topic" } }

curl -X POST http://localhost:3132/api/errors/1/resolve
# → { ok: true }
```
