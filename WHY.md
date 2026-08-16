# Why Work Intelligence exists

## The problem

An engineer's day is spread across Jira, GitHub, Teams, Slack, and email. The cost is not the switching itself — it is that every switch resets context. "What was I doing on that bug from Monday?" means re-reading tickets, re-scrolling threads, re-finding the PR that changed the file, and re-deriving what matters. Much of that is mechanical, and it happens dozens of times a day.

## The idea

Give the machine the job of keeping work context. WI is a personal MCP server that ingests your work data into a local SQLite store, then runs agents that actually use it: an investigation engine that walks a bug ticket to a root cause with an evidence trail and a confidence score, a PM orchestration layer that turns conversation into a ranked backlog, and the Cypher loop — a senior-engineer agent that plans, verifies its own evidence, and only then acts.

The design constraint that shaped everything: the agent must be able to prove what it did. Cypher records every step, classifies every path it writes to, and confirms outbound actions. The bug investigator cites the files, commits, and feature flags behind its verdict and scores its own confidence.

## What it demonstrates

- MCP server design — tools, skills, and an HTTP bridge over one local data store
- Multi-agent orchestration — a loop controller, dispatch layer, and composing agents
- Evidence-verified agent loops — audit trails, confidence scores, path-safety fences
- SQLite schema evolution at scale — 95+ versioned migrations, forward-only with a ledger
- Config-driven architecture — connectors, repos, paths, feature flags, and secret env-var names, all in `wi.config.json`

## Lessons learned

Agents are only as honest as their verification loop; a conclusion without a cited evidence trail is a guess. Writing to a filesystem is a security boundary — classify before you write, confirm before you push. Feature flags and kill-switches are how a personal tool survives a year of extension. The most durable code is schema migrations, smoke tests, and small composable services.

The project asks one question: what happens when your tools stop dumping data on you and start maintaining the context for you?
