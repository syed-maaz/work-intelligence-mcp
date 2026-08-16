---
title: "BUG-04: Migrations not transactional"
sidebar_label: "BUG-04: Non-atomic migrations"
---

# BUG-04: Migrations not wrapped in transactions

| | |
|---|---|
| **Severity** | 🔴 Breaking |
| **Status** | ✅ Fixed |
| **File** | `src/db/schema.ts:110–335` |
| **Discovered** | April 2026 technical audit |
| **Fixed in** | Direct code fix (April 2026) |

## Description

Each migration function called `db.exec(...)` directly without wrapping the DDL in a transaction:

```typescript
// Before fix — no transaction wrapper
() => {
  db.exec(`
    ALTER TABLE meetings ADD COLUMN transcript TEXT;
    ALTER TABLE meetings ADD COLUMN topics TEXT;
    -- ...more DDL...
    CREATE VIRTUAL TABLE messages_fts USING fts5(...);
    CREATE TRIGGER messages_ai ...;
  `);

  // Version bump is outside any transaction
  db.prepare('INSERT OR REPLACE INTO schema_metadata ...').run('schema_version', '3');
},
```

## Failure Scenario

If a migration fails partway through — for example, if `ALTER TABLE meetings ADD COLUMN transcript` succeeds but the `CREATE VIRTUAL TABLE messages_fts` statement fails due to a syntax error, disk error, or SQLite version limitation — the database is left in a **partial state**:

- The `transcript` column exists (migration partially applied)
- `messages_fts` does not exist
- `schema_version` is still `2` (version bump never ran)

On the next server startup, the migration runner sees version 2 and tries to re-run migration `2→3`. This immediately fails with:

```
SqliteError: duplicate column name: transcript
```

The database is now **permanently broken** — every startup attempt fails, and the only recovery is to delete the DB file and lose all data.

## Fix

Each migration is now wrapped in `db.transaction()()`. The version bump runs inside the same transaction, so either the entire migration commits or nothing does:

```typescript
// After fix — atomic migration
for (let version = fromVersion; version < CURRENT_SCHEMA_VERSION; version++) {
  const migration = migrations[version];
  if (migration) {
    db.transaction(() => {
      migration();  // all DDL + version bump inside one transaction
    })();
  }
}
```

If any statement inside a migration throws, the transaction rolls back and `schema_version` stays at the previous value. The next startup can safely retry the migration from scratch.

## Note on PRAGMA Inside Transactions

`PRAGMA journal_mode = WAL` cannot be run inside a transaction in some SQLite builds. This is why WAL mode was moved to `getDatabase()` (see [BUG-05](./bug-05-wal-mode-not-active)) and removed from migration `2→3` before this fix was applied.

## Files Changed

- `src/db/schema.ts` — `applyMigrations()` loop
