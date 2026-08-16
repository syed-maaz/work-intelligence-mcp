---
name: wi-bug
description: "Bug lifecycle operations: capture new bugs, resolve by ID, or bulk-resolve proposed bugs. Use for goals like 'there's a bug in <module>', 'resolve bug <id>', 'close proposed bugs'. Subcommand-dispatch."
triggers:
- there is a bug
- there's a bug
- bug in
- resolve bug
- capture bug
- negative-zero

---

# wi-bug

## Purpose

Manage bug lifecycle in Work Intelligence — capture new bugs from any source (bridge, agent, web-ui, sync), resolve individual bugs by ID, or trigger the BugResolverAgent to auto-fix proposed bugs.

## When to use

- `wi-bug report` when a user reports an error, crash, or anomaly
- `wi-bug resolve <id>` when a bug has been verified as fixed or rejected
- `wi-bug resolve-all` when you want to attempt automated resolution of investigated bugs

## Subcommands

| Subcommand | Args | Purpose |
|---|---|---|
| `report` | [--source <val>] <error_name> <message> | Capture a bug. Idempotent — re-reporting increments occurrence_count. |
| `resolve` | <bug_id> [resolved\|wont-fix] [--note "reason"] | Mark a single bug as resolved or wont-fix. |
| `resolve-all` | [--severity <val>] [--source <val>] [--cap N] | Trigger BugResolverAgent on proposed bugs. |

## Endpoints touched

- `POST /api/bugs/report` — report a new bug
- `POST /api/bugs/:id/resolve` — resolve a bug
- `GET /api/bugs?status=proposed` — list proposed bugs

## Failure modes

- If bridge is not running: `curl: (7) Failed to connect`. Start with `npm run web:bridge`.
- Missing error_name or bug_id: script returns error JSON.
- Bug not found (HTTP 404): check the ID from wi-health or /bugs UI.

## Related work

- Migration plan: `.planning/skill-merging/PLAN.md`
- Source skills preserved in git history

## Changelog

- 2026-07-24 — merged from wi-bug-report, wi-bug-resolve, wi-bug-resolve-all (see PLAN.md § 4).
