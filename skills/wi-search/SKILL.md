---
name: wi-search
description: "Cross-source search: all, teams, palace, ask, code. Subcommand-dispatch."
trigger_phrases:
  - "search everything"
  - "full-text search"
  - "search all sources"
  - "teams search"
  - "semantic search"
  - "code search"
argument-hint: "<subcommand> [args]"
allowed-tools: [Bash]
metadata:
  bucket: E-thick
  run_script: run.sh
  invocation: "bash skills/wi-search/run.sh <subcommand>"
  subcommands:
    - name: all
      description: "Cross-source FTS search across Jira, Teams, Email, GitHub."
      invocation: "bash skills/wi-search/run.sh all <query> [--since YYYY-MM-DD] [--sources ...]"
    - name: teams
      description: "Search Teams messages and meeting transcripts."
      invocation: "bash skills/wi-search/run.sh teams <query> [--since YYYY-MM-DD] [--meetings-only]"
    - name: palace
      description: "Query MemPalace knowledge graph with natural language."
      invocation: "bash skills/wi-search/run.sh palace <question>"
    - name: ask
      description: "Topic expert question across all sources."
      invocation: "bash skills/wi-search/run.sh ask <question> [--project KEY] [--since YYYY-MM-DD]"
    - name: code
      description: "Run Claude Code research against connected repos."
      invocation: "bash skills/wi-search/run.sh code <research question>"
  endpoints:
    - GET /api/search-all
    - GET /api/teams-updates
    - GET /api/palace/status
    - POST /api/notebooks/default/chat
    - GET /api/topic-expert
    - POST /api/jira/analyze
  reads_tables: []
  writes_tables: []
  writes_mutating: false
  related_skills: [wi-palace-query, wi-jira]
  triggers: []
  born: 2026-07-24
  last_verified: 2026-07-24
  model:
    provider: anthropic
    tier: haiku
    override: null
    rationale: "Dispatches to scripts; LLM only renders output."
---

# wi-search

## Purpose

Search across all Work Intelligence data sources — Jira, Teams, Email, GitHub, MemPalace knowledge graph, and connected code repos.

## When to use

- `wi-search all <query>` for cross-source search
- `wi-search teams <query>` for Teams-specific search
- `wi-search palace <question>` for knowledge graph queries
- `wi-search ask <question>` for topic expert synthesis
- `wi-search code <question>` for code research

## Subcommands

| Subcommand | Args | Purpose |
|---|---|---|
| `all` | <query> [--since] [--sources] | Cross-source FTS with AI synthesis. |
| `teams` | <query> [--since] [--meetings-only] | Teams messages + meeting transcripts. |
| `palace` | <question> | Semantic knowledge graph query. |
| `ask` | <question> [--project] [--since] | Topic expert with narrative synthesis. |
| `code` | <question> | Claude Code research with OPRO prompts. |

## Endpoints touched

- Search, Teams, Palace, Topic Expert, Code Research endpoints.

## Failure modes

- Bridge unreachable: start with `npm run web:bridge`.
- 0 results: check sync status.

## Related work

- Migration plan: `.planning/skill-merging/PLAN.md`

## Changelog

- 2026-07-24 — merged from wi-search-all, wi-teams-search, wi-palace-query, wi-ask-topic, wi-code-research (see PLAN.md § 4).
