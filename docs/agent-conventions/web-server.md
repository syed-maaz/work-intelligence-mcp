---
paths:
  - "web-server.js"
---

## Jira concurrency — always use withJiraLock()
Both `/api/saturn/issues` and `/api/jira/my-issues` must serialize via `withJiraLock()`. Concurrent JiraBrowserConnector calls crash. Never call JiraBrowserConnector outside the lock.

## isRefreshing pattern for cold-start endpoints
Saturn and MyIssues caches use `isRefreshing: boolean`. Set true before `withJiraLock`, false after. Endpoints never block — always fire-and-forget on cold start, return `{ isRefreshing }` in response. Frontend polls every 3s while `isRefreshing === true`.

## Alert rules in generateAlerts()
5 rules in order: overdue action items → stale topics (3d) → high_activity (2x baseline) → meeting_soon (60min) → missing_transcript (7d calendar scan). Each rule is wrapped in try/catch. Add new rules after rule 4, before the sort.

## Missing transcript rule (Rule 5) matching logic
Takes first keyword (>3 chars) from `calendar_events.title`, does `LIKE %keyword%` against `meetings.chat_name` AND `meetings.title`. Transcript present = `length(transcript) > 100`. Scans events ended within last 7 days.

## Auth header pattern when ANTHROPIC_BASE_URL is set
Set `apiKey: 'x-proxy'` + `Authorization: Bearer` header only. Do NOT set `x-api-key` header — newer Anthropic SDK rejects empty `x-api-key` when proxy is active. Fix lives in `src/services/analyzer.ts`.

## SQLite string literals
Always use single quotes for string values in SQL. Double quotes are identifiers in SQLite — `"completed"` is a column reference, `'completed'` is a string.
