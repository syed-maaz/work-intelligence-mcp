---
title: "BUG-14: DATABASE_PATH default mismatch"
sidebar_label: "BUG-14: DB path mismatch"
---

# BUG-14: Default `DATABASE_PATH` differs between code and docs

| | |
|---|---|
| **Severity** | Silently Wrong |
| **Status** | 📋 Documented |
| **File** | `src/db/connection.ts:21` |
| **Discovered** | April 2026 technical audit |

## Description

The code default in `connection.ts`:

```typescript
const defaultPath = path.join(os.homedir(), '.work-intelligence-mcp', 'data.db');
// Resolves to: ~/.work-intelligence-mcp/data.db
```

`CLAUDE.md` documentation states:

```
DATABASE_PATH=./data/intelligence.db   # defaults to in-memory if unset
```

These are two different paths. The "defaults to in-memory if unset" statement in `CLAUDE.md` is also false — the code defaults to `~/.work-intelligence-mcp/data.db`, not `:memory:`.

## Impact

A developer following `CLAUDE.md` who sets `DATABASE_PATH=./data/intelligence.db` will create a file at `./data/intelligence.db`. If they later run without the env var set, the server silently opens `~/.work-intelligence-mcp/data.db` instead — a completely different database with no data. They may spend time debugging why their synced data is gone.

This is a documentation-code drift issue rather than a code bug. No data is lost — both paths are valid SQLite file locations. The confusion is in which database is active.

## Recommended Fix

Update `CLAUDE.md` to reflect the actual code default:

```markdown
DATABASE_PATH=~/.work-intelligence-mcp/data.db   # default if unset
```

Additionally, `getDatabase()` could log the resolved path to stderr on startup so it is always visible:

```typescript
console.error(`[DB] Using database at: ${databasePath}`);
```

## Tracking

Low-priority documentation fix. No code change required.
