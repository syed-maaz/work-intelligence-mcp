---
title: "BUG-02: Signal handlers registered per call"
sidebar_label: "BUG-02: Signal handlers"
---

# BUG-02: Signal handlers registered on every `getDatabase()` call

| | |
|---|---|
| **Severity** | Accumulating Debt |
| **Status** | ✅ Fixed |
| **File** | `src/db/connection.ts:51–63` |
| **Discovered** | April 2026 technical audit |
| **Fixed in** | Direct code fix (April 2026) |

## Description

`process.on('exit')`, `process.on('SIGINT')`, and `process.on('SIGTERM')` were registered **inside** `getDatabase()`, not at module scope:

```typescript
// Before fix — inside the factory function
export function getDatabase(config?: DatabaseConfig): Database.Database {
  if (dbInstance) return dbInstance;  // singleton guard
  // ...open db...

  // These run on EVERY call that passes the singleton guard
  process.on('exit', () => { closeDatabase(); });
  process.on('SIGINT', () => { closeDatabase(); process.exit(0); });
  process.on('SIGTERM', () => { closeDatabase(); process.exit(0); });

  return dbInstance;
}
```

## Why the Singleton Guard Doesn't Save You

In production with a single process, `getDatabase()` only passes the guard once — so handlers are only registered once. This appears safe.

However, any test that resets the singleton (e.g., `dbInstance = null`) to get a fresh in-memory DB will call `getDatabase()` again, registering a second set of handlers. Node.js warns at 11+ listeners with `MaxListenersExceededWarning` and will emit the warning to stderr, polluting test output. With 10+ tests each doing setup/teardown, this becomes noise at best and a false signal at worst.

## Fix

Move signal handler registration to module scope — they run exactly once when the module is first imported:

```typescript
// After fix — at module scope, outside any function
let dbInstance: Database.Database | null = null;

process.on('exit', () => { closeDatabase(); });
process.on('SIGINT', () => { closeDatabase(); process.exit(0); });
process.on('SIGTERM', () => { closeDatabase(); process.exit(0); });
```

## Files Changed

- `src/db/connection.ts` — signal handler registration moved to module top-level
