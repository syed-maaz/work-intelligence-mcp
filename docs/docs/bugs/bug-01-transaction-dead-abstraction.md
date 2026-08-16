---
title: "BUG-01: transaction() dead abstraction"
sidebar_label: "BUG-01: transaction()"
---

# BUG-01: `transaction()` dead abstraction

| | |
|---|---|
| **Severity** | Silently Wrong |
| **Status** | ✅ Fixed |
| **File** | `src/db/connection.ts:87–97` |
| **Discovered** | April 2026 technical audit |
| **Fixed in** | Direct code fix (April 2026) |

## Description

The `transaction()` helper exported from `connection.ts` accepts an `options` parameter with an `immediate` flag. Callers that pass `{ immediate: true }` believe they are getting a `BEGIN IMMEDIATE` transaction, which prevents write-write conflicts under concurrent access. In reality both branches of the conditional were identical:

```typescript
// Before fix — both branches identical, immediate option silently ignored
const transactionFunction = options?.immediate
  ? db.transaction(callback)   // ← deferred
  : db.transaction(callback);  // ← also deferred

return transactionFunction();
```

`better-sqlite3` exposes `.deferred()`, `.immediate()`, and `.exclusive()` modifiers on the transaction object returned by `db.transaction()`. None of them were wired. Every `BEGIN IMMEDIATE` caller was silently getting `BEGIN DEFERRED`.

## Impact

Under concurrent writes (e.g., a background sync running while a tool handler writes), `BEGIN DEFERRED` can promote to a write lock mid-transaction and hit `SQLITE_BUSY`. `BEGIN IMMEDIATE` acquires the write lock upfront, avoiding promotion failures. Any code that passed `{ immediate: true }` to signal it needed a write-safe transaction was getting no such guarantee.

This is a latent data-integrity bug — it would express itself under concurrent writer load, not in normal single-user operation.

## Fix

```typescript
// After fix — .immediate() modifier wired correctly
export function transaction<T>(
  db: Database.Database,
  callback: () => T,
  options?: TransactionOptions
): T {
  if (options?.immediate) {
    return db.transaction(callback).immediate();
  }
  return db.transaction(callback)();
}
```

## Files Changed

- `src/db/connection.ts` — `transaction()` function
