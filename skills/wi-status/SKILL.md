---
name: wi-status
description: "Your work status and system health: what's next, item status, code impact, health checks, and sync. Use for goals like 'what am I working on', 'status of <id>', 'is the bridge healthy'. Subcommand-dispatch."
triggers:
- is bridge healthy
- what am I working on
- status of
- work status
- is the bridge
- healthy right now

---

# wi-status

## Purpose

Read-only Cypher PM lens queries and system health. View pending work items, check individual item status, find items touching a file, run health checks, and trigger syncs.

## When to use

- `wi-status next [N]` to see what's pending
- `wi-status status <id>` to inspect a specific item
- `wi-status impact <path>` to find items touching code
- `wi-status health` for system health dashboard
- `wi-status sync` to trigger a data refresh

## Subcommands

| Subcommand | Args | Purpose |
|---|---|---|
| `next` | [limit] | Top-N pending work items (priority-sorted, unblocked first). |
| `status` | <work-item-id> | Full status, evidence, and linked data for one item. |
| `impact` | <file-path> | Work items referencing a file path. |
| `health` | — | Bridge, sync, palace, tokens, errors. |
| `sync` | [--topic] | Trigger full or topic-specific background sync. |

## Endpoints touched

- Cypher PM API (next, status, impact)
- System health, palace, sync, tokens, errors

## Failure modes

- Bridge unreachable: most subcommands will fail — start with `npm run web:bridge`.
- Work item not found (404): check the ID format.

## Related work

- Migration plan: `.planning/skill-merging/PLAN.md`

## Changelog

- 2026-07-24 — extended from 3 modes (next/status/impact) to 5 (added health, sync). Merged from wi-health, wi-sync (see PLAN.md § 4).
