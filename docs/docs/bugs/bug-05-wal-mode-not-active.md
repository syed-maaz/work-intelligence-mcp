---
title: "BUG-05: WAL mode not active"
sidebar_label: "BUG-05: WAL mode"
---

# BUG-05: WAL mode not active on any database

| | |
|---|---|
| **Severity** | Silently Wrong |
| **Status** | ✅ Fixed |
| **File** | `src/db/schema.ts:229`, `src/db/connection.ts:42–45` |
| **Discovered** | April 2026 technical audit |
| **Fixed in** | Direct code fix (April 2026) |

## Description

WAL mode (`PRAGMA journal_mode = WAL`) was set in **migration 2→3** and conditional on an `enableWAL` flag in `connection.ts`:

```typescript
// Before fix — connection.ts
if (config?.enableWAL) {          // ← flag never passed
  dbInstance.pragma('journal_mode = WAL');
}
```

```sql
-- Before fix — inside migration 2→3
PRAGMA journal_mode = WAL;        -- ← only runs once, during migration
```

Two separate problems:

### Problem 1 — `enableWAL` flag never passed

`getDatabase()` is called from `server.ts` and `teams-sync.ts` with no `config` argument. `config` is `undefined`, so `config?.enableWAL` is `undefined` (falsy). WAL was never enabled via the flag path.

### Problem 2 — PRAGMA inside a migration runs only once

The `PRAGMA journal_mode = WAL` inside migration `2→3` runs exactly once: the first time a database is migrated from schema v2 to v3. For any database that was **already at v3** when the code was deployed (or newly created after v3 was the baseline), this PRAGMA never ran. New databases skip migrations entirely and get the default journal mode (`DELETE`).

You can verify with:
```bash
sqlite3 ~/.work-intelligence-mcp/data.db "PRAGMA journal_mode;"
# Returns "delete" instead of "wal" on affected databases
```

## Impact

Without WAL mode:

- Reads block on writes and vice versa (exclusive lock for writes)
- Background sync and tool query calls cannot run concurrently without one waiting
- No concurrent read access from multiple connections (e.g., a shell query while the server is running)

## Fix

WAL mode is now set **unconditionally** in `getDatabase()`, before `initializeDatabase()` runs, so it applies to every database on every startup:

```typescript
// After fix — connection.ts
// WAL mode unconditionally — better concurrent read/write performance.
// Must run before initializeDatabase() so migrations see WAL mode.
dbInstance.pragma('journal_mode = WAL');
```

The `PRAGMA journal_mode = WAL` was also removed from migration `2→3` because:
1. It is now redundant (already set at connection time)
2. `PRAGMA journal_mode` cannot run inside a transaction in some SQLite builds, and migrations are now wrapped in transactions ([BUG-04](./bug-04-migrations-not-transactional))

## Files Changed

- `src/db/connection.ts` — WAL set unconditionally, `enableWAL` flag kept for compatibility but WAL is always on
- `src/db/schema.ts` — removed `PRAGMA journal_mode = WAL` from migration `2→3`
