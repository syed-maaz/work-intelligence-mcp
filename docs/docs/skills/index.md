---
sidebar_label: "Claude Skills"
sidebar_position: 1
---

# Claude Code Skills

Work Intelligence ships **22 slash commands** for Claude Code — invoke them directly from any Claude session instead of opening the web UI.

## Prerequisites

1. The bridge must be running: `npm run web:bridge` (port 3132)
2. Skills are registered globally at `~/.claude/skills/work-intelligence/`
3. Invoke any skill with `/wi-<name> [arguments]`

---

## Quick Reference

| Skill | Command | One-liner |
|-------|---------|-----------|
| [Dual-Engine Investigation](#dual-engine) | `/wi-investigate PROJ-12345` | How the web UI runs both ReAct + skill in parallel |
| [Investigate Bug](#wi-investigate) | `/wi-investigate PROJ-12345` | 3-layer ReAct bug investigation |
| [Jira Analyze](#wi-jira-analyze) | `/wi-jira-analyze PROJ-12345` | 5-parallel AI ticket analysis |
| [Jira Report](#wi-jira-report) | `/wi-jira-report BDS` | Sprint health report |
| [Teams Search](#wi-teams-search) | `/wi-teams-search "auth"` | FTS5 search across Teams + meetings |
| [Ask Topic](#wi-ask-topic) | `/wi-ask-topic "what decisions on auth?"` | Cross-source NL synthesis |
| [Morning Brief](#wi-morning-brief) | `/wi-morning-brief` | Calendar + issues + action items |
| [Pre-Meeting](#wi-pre-meeting) | `/wi-pre-meeting standup` | Context card before a meeting |
| [Daily Digest](#wi-daily-digest) | `/wi-daily-digest BDS` | AI digest of last 24h activity |
| [Action Items](#wi-action-items) | `/wi-action-items` | Your open action items |
| [Who Owns](#wi-who-owns) | `/wi-who-owns src/auth/login.ts` | Code ownership + blast radius |
| [Search All](#wi-search-all) | `/wi-search-all "FF_RM_11372"` | Cross-source FTS + AI summary |
| [Blast Radius](#wi-blast-radius) | `/wi-blast-radius src/auth/` | Dependency blast radius for a change |
| [PR Review](#wi-pr-review) | `/wi-pr-review org/repo#42` | Work-context PR review |
| [Find Expert](#wi-find-expert) | `/wi-find-expert auth middleware` | Best-match teammate for a skill |
| [Weekly Report](#wi-weekly-report) | `/wi-weekly-report` | Velocity, trends, patterns |
| [Save to Ticket](#wi-save-to-ticket) | `/wi-save-to-ticket PROJ-12345` | Save investigation to Jira |
| [Sync](#wi-sync) | `/wi-sync` | Trigger + monitor full sync |
| [Palace Query](#wi-palace-query) | `/wi-palace-query "why did auth break?"` | Semantic KG search |
| [Ticket Links](#wi-ticket-links) | `/wi-ticket-links PROJ-12345` | Extract + summarize all ticket links |
| [Code Research](#wi-code-research) | `/wi-code-research "how does login work?"` | Self-evolving codebase research |
| [Correlate](#wi-correlate) | `/wi-correlate` | Discover cross-topic relationships |
| [Teammate](#wi-teammate) | `/wi-teammate alice chen` | Teammate profile + expertise |
| [Health](#wi-health) | `/wi-health` | Full system health check |

---

## Skill Groups

### Investigation & Analysis
> Use when debugging a ticket, understanding code impact, or researching a change.

- [`Dual-Engine Investigation`](./wi-dual-engine) — How the web UI combines ReAct + skill engines
- [`/wi-investigate`](./wi-investigate) — Full ReAct bug investigation (git, flags, deps, call graph)
- [`/wi-jira-analyze`](./wi-jira-analyze) — 5-parallel AI checks on any ticket
- [`/wi-ticket-links`](./wi-ticket-links) — Fetch and summarize everything linked from a ticket
- [`/wi-code-research`](./wi-code-research) — Self-evolving Claude Code research engine
- [`/wi-blast-radius`](./wi-blast-radius) — Impact analysis for a file or PR

### Daily Workflow
> Replace your morning tab-opening routine with a single command.

- [`/wi-morning-brief`](./wi-morning-brief) — Calendar + issues + action items in one view
- [`/wi-pre-meeting`](./wi-pre-meeting) — Context card 30 min before any meeting
- [`/wi-daily-digest`](./wi-daily-digest) — What happened in a topic today
- [`/wi-action-items`](./wi-action-items) — Your open items across all sources
- [`/wi-weekly-report`](./wi-weekly-report) — Velocity, trends, and patterns for the week

### Search & Discovery
> Find information across Jira, Teams, Email, and GitHub without opening each tab.

- [`/wi-search-all`](./wi-search-all) — Cross-source FTS with AI synthesis
- [`/wi-teams-search`](./wi-teams-search) — Teams messages + meeting transcripts
- [`/wi-ask-topic`](./wi-ask-topic) — Natural language Q&A over all sources
- [`/wi-palace-query`](./wi-palace-query) — Semantic KG search (MemPalace)
- [`/wi-correlate`](./wi-correlate) — Discover hidden cross-domain relationships

### Jira
> Deep Jira intelligence without leaving Claude Code.

- [`/wi-jira-report`](./wi-jira-report) — Sprint health report
- [`/wi-save-to-ticket`](./wi-save-to-ticket) — Save findings back to a ticket

### Code & Team
> Code ownership, PRs, and teammate expertise.

- [`/wi-who-owns`](./wi-who-owns) — Ownership lookup for any path
- [`/wi-pr-review`](./wi-pr-review) — Work-context PR review
- [`/wi-find-expert`](./wi-find-expert) — Best teammate for a skill or area
- [`/wi-teammate`](./wi-teammate) — Full teammate profile

### System
> Ops, sync, and health.

- [`/wi-sync`](./wi-sync) — Trigger full sync, monitor completion
- [`/wi-health`](./wi-health) — System health dashboard
