---
name: wi-brief
description: "Briefings and summaries: morning catch-up, daily topic digest, weekly engineering health. Use for goals like 'morning briefing', 'daily on <topic>', 'weekly report'. Subcommand-dispatch."
triggers:
- morning briefing
- daily
- weekly
- give me my
- brief me
- digest

---

# wi-brief

## Purpose

Time-based briefings for Work Intelligence — morning catch-up, daily topic digests, and weekly engineering health reports.

## When to use

- `wi-brief morning` to start your day with meeting context and open issues
- `wi-brief daily <topic>` to catch up on a topic's activity from the last 24h
- `wi-brief weekly` for the engineering velocity and health report

## Subcommands

| Subcommand | Args | Purpose |
|---|---|---|
| `morning` | — | Calendar, Jira, action items, overnight activity. |
| `daily` | <topic> [--date] | Activity digest for a configured topic. |
| `weekly` | [--project] [--week] | Velocity, cycle time, action items, patterns. |

## Endpoints touched

- Morning brief, calendar, Jira, digest, weekly report.

## Failure modes

- Bridge unreachable: start with `npm run web:bridge`.

## Related work

- Migration plan: `.planning/skill-merging/PLAN.md`

## Changelog

- 2026-07-24 — merged from wi-morning-brief, wi-daily-digest, wi-weekly-report (see PLAN.md § 4).
