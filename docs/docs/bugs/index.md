---
sidebar_position: 1
title: Bug Tracker
---

# Bug Tracker

All known bugs, their severity, root cause, and fix status. Bugs discovered in the April 2026 technical audit.

## Status Summary

| Bug | Title | Severity | Status |
|-----|-------|----------|--------|
| [BUG-01](./bug-01-transaction-dead-abstraction) | `transaction()` dead abstraction | Silently Wrong | ✅ Fixed |
| [BUG-02](./bug-02-signal-handler-registration) | Signal handlers registered per factory call | Accumulating Debt | ✅ Fixed |
| [BUG-03](./bug-03-insert-or-replace-orphans) | `INSERT OR REPLACE` orphans action items | 🔴 Breaking | ✅ Fixed |
| [BUG-04](./bug-04-migrations-not-transactional) | Migrations not wrapped in transactions | 🔴 Breaking | ✅ Fixed |
| [BUG-05](./bug-05-wal-mode-not-active) | WAL mode not active on any database | Silently Wrong | ✅ Fixed |
| [BUG-06](./bug-06-search-uses-like-not-fts5) | `searchMessages()` uses LIKE, bypasses FTS5 | Accumulating Debt | ✅ Fixed |
| [BUG-07](./bug-07-ghost-topics-unbounded) | `search_all` creates unbounded ghost topics | Silently Wrong | ✅ Fixed |
| [BUG-08](./bug-08-action-items-duplicated) | Action items duplicated on every sync | 🔴 Breaking | ✅ Fixed |
| [BUG-09](./bug-09-two-sync-loops) | Two conflicting sync loops running simultaneously | 🔴 Breaking | ✅ Fixed |
| [BUG-10](./bug-10-meeting-schema-drift) | `InsertMeetingSchema` missing all v3 columns | Silently Wrong | ✅ Fixed |
| [BUG-11](./bug-11-topic-id-zero-lie) | `topic_id = 0` comment contradicts NOT NULL constraint | Accumulating Debt | 📋 Documented |
| [BUG-12](./bug-12-temperature-extraction) | Temperature 0.7 on deterministic extraction tasks | Accumulating Debt | ✅ Fixed |
| [BUG-13](./bug-13-connector-concurrent-navigation) | `search_all` concurrent browser navigation corrupts page | 🔴 Breaking | 📋 Tracked (EP-14-5) |
| [BUG-14](./bug-14-database-path-mismatch) | Default `DATABASE_PATH` differs between code and docs | Silently Wrong | 📋 Documented |
| [BUG-15](./bug-15-no-prepared-statement-cache) | Duplicated FTS query code, no shared query module | Accumulating Debt | 📋 Tracked (EP-9) |
| [BUG-16](./bug-16-webserver-startup-failures) | web-server.js: `db` uninitialised + retry storm + `qs` undefined + missing columns | 🔴 Breaking | ✅ Fixed |

## Severity Definitions

| Level | Meaning |
|-------|---------|
| 🔴 **Breaking** | Causes data loss, corruption, or incorrect behavior in production |
| ⚠️ **Silently Wrong** | Works on the surface but produces wrong results or violates invariants |
| 🔵 **Accumulating Debt** | Not urgent today but will cause real problems as the system grows |

## Fix Status

| Status | Meaning |
|--------|---------|
| ✅ Fixed | Code change applied and typechecks pass |
| 📋 Documented | Root cause analysed; fix tracked in an epic ticket |
| 🔲 Open | Not yet addressed |

## Architectural Recommendations (from same audit)

The following were raised as architectural improvements — not bugs, but design-level issues with clear upgrade paths. Each is tracked under an existing or future epic.

| Rec | Summary | Tracked In |
|-----|---------|-----------|
| A | Replace raw SQL with type-safe query builder (Kysely/Drizzle) | EP-9 |
| B | Consolidate FTS search into `src/db/search.ts` | EP-9 |
| C | Event/outbox pattern for sync pipeline | EP-15 |
| D | Vector search via `sqlite-vec` for semantic queries | EP-17 |
| E | Structured logging with pino | EP-15 |
| F | Replace `setInterval` with `node-cron` / Croner | EP-15 |
| G | Playwright connector pool (reuse sessions across calls) | EP-14-5 |
| H | Content-addressed message storage (hash-gated UPDATE) | Partial — BUG-03 fix is the foundation |
| I | In-memory SQLite test fixtures (vitest) | EP-8 |
| J | Split `analyzer.ts` into `extractor.ts` + `summarizer.ts` | EP-8 |
| K | Hard fail at startup on missing `BROWSER_PROFILE_PATH` | EP-14 |
