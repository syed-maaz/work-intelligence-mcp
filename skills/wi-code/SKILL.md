---
name: wi-code
description: "Code analysis and PR review: blast radius, change impact, pull request review, owners correlation. Use for goals like 'review this PR', 'blast radius for <file>', 'who else uses <module>'. Subcommand-dispatch."
triggers:
- pr review
- review this pr
- blast radius
- break the app
- impact of change
- refactor
- code review

---

# wi-code

## Purpose

Code analysis and review tools — assess change impact, review PRs with work context, and find cross-domain correlations.

## When to use

- `wi-code blast-radius <path>` before merging a change
- `wi-code pr-review <url>` for context-rich PR review
- `wi-code correlate` to surface hidden connections

## Subcommands

| Subcommand | Args | Purpose |
|---|---|---|
| `blast-radius` | <path> \| <PR-URL> | Dependents, risks, affected tests. |
| `pr-review` | <PR-URL> | Work-context PR review with Jira/ownership. |
| `correlate` | [--topic] [--entity] | Cross-domain relationship discovery. |

## Endpoints touched

- Code graph, PR enrichment, Palace health/refresh, Relationships.

## Failure modes

- Bridge unreachable: start with `npm run web:bridge`.

## Related work

- Migration plan: `.planning/skill-merging/PLAN.md`

## Changelog

- 2026-07-24 — merged from wi-blast-radius, wi-pr-review, wi-correlate (see PLAN.md § 4).
