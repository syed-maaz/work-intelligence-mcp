---
name: wi-people
description: "People and ownership lookup: teammate profiles, domain experts, code owners. Use for goals like 'who owns <path>', 'find an expert on <topic>', 'who is <name>'. Subcommand-dispatch."
triggers:
- who owns
- who wrote most of
- find an expert
- teammate
- owner of
- who is

---

# wi-people

## Purpose

People and ownership lookup for Work Intelligence — find teammate profiles, domain experts, and code owners.

## When to use

- `wi-people teammate <name>` when you need a teammate's full profile
- `wi-people expert <topic>` when you need to find who knows a domain
- `wi-people owner <path>` when you need to know who owns a code file

## Subcommands

| Subcommand | Args | Purpose |
|---|---|---|
| `teammate` | <name or email> | Cross-system profile: activity, expertise, code ownership, Jira. |
| `expert` | <skill or topic> | Ranked expert recommendations with evidence. |
| `owner` | <file-path> | Code ownership with blast radius and risk score. |

## Endpoints touched

- `GET /api/teammates?q=` — teammate fuzzy search
- `GET /api/teammates/expert?skill=` — expert lookup
- `GET /api/code-graph/owners?path=` — code ownership
- `GET /api/code-graph/blast-radius?file=` — blast radius

## Failure modes

- Bridge unreachable: start with `npm run web:bridge`.
- Path not found in code graph: suggest reindexing via `POST /api/code-graph/index`.

## Related work

- Migration plan: `.planning/skill-merging/PLAN.md`

## Changelog

- 2026-07-24 — merged from wi-teammate, wi-find-expert, wi-who-owns (see PLAN.md § 4).
