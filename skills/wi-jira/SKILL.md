---
name: wi-jira
name: wi-jira
description: "Jira lifecycle operations: deep ticket analysis, sprint board reports, linked context summarization, and saving notes back to Jira. Use for goals like 'analyze JIRA-1234', 'board report for JIRA', 'summarize what happened on <KEY>'. Subcommand-dispatch."
triggers:
- summarize what happened on
- analyze
- jira
- ticket
- board report
- JIRA-

argument-hint: "<subcommand> [args]"
allowed-tools: [Bash]
metadata:
  bucket: E-thick
  run_script: run.sh
  invocation: "bash skills/wi-jira/run.sh <subcommand>"
  subcommands:
    - name: analyze
      description: "Run 5-parallel AI analysis pipeline on a Jira ticket."
      invocation: "bash skills/wi-jira/run.sh analyze <TICKET-KEY>"
    - name: report
      description: "Fetch sprint board report with AI analysis."
      invocation: "bash skills/wi-jira/run.sh report <PROJECT-KEY> [--board <url>]"
    - name: ticket-links
      description: "Extract and summarize all linked content from a ticket."
      invocation: "bash skills/wi-jira/run.sh ticket-links <TICKET-KEY>"
    - name: save
      description: "Save investigation findings to a Jira ticket."
      invocation: "bash skills/wi-jira/run.sh save <TICKET-KEY> [--notes \"text\"]"
  endpoints:
    - POST /api/jira/analyze
    - GET /api/jira-report
    - PUT /api/jira/analysis/:key/notes
  reads_tables: []
  writes_tables: []
  writes_mutating: false
  related_skills: [wi-investigate, wi-pm]
  triggers: []
  born: 2026-07-24
  last_verified: 2026-07-24
  model:
    provider: anthropic
    tier: haiku
    override: null
    rationale: "Dispatches to scripts; LLM only renders output."
---

# wi-jira

## Purpose

Full Jira lifecycle integration — analyze tickets with AI, fetch sprint reports, extract linked context, and save investigation notes.

## When to use

- `wi-jira analyze <key>` when you need AI deep-dive on a ticket
- `wi-jira report <key>` when you need sprint health
- `wi-jira ticket-links <key>` when you need linked content summary
- `wi-jira save <key>` when you need to persist findings

## Subcommands

| Subcommand | Args | Purpose |
|---|---|---|
| `analyze` | <TICKET-KEY> | AI analysis: classify, effort, explanation, solution, code impact. |
| `report` | [PROJECT-KEY] [--board <url>] | Sprint health: blocked issues, velocity, risks, recommendations. |
| `ticket-links` | <TICKET-KEY> | Extract linked tickets, PRs, docs, URLs with AI synthesis. |
| `save` | <TICKET-KEY> [--notes "text"] | Persist investigation findings to ticket. |

## Endpoints touched

- `POST /api/jira/analyze` — trigger analysis
- `GET /api/jira-report?projectKey=&boardUrl=` — sprint report
- `GET /api/jira/analyses?key=` — cached analysis
- `PUT /api/jira/analysis/:key/notes` — save notes

## Failure modes

- Bridge unreachable: start with `npm run web:bridge`.
- Invalid ticket key: check format (e.g. JIRA-12345).

## Related work

- Migration plan: `.planning/skill-merging/PLAN.md`

## Changelog

- 2026-07-24 — merged from wi-jira-analyze, wi-jira-report, wi-ticket-links, wi-save-to-ticket (see PLAN.md § 4).
