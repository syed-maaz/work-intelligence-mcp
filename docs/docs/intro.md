---
sidebar_position: 1
slug: /
title: Work Intelligence MCP
---

# Work Intelligence MCP

> **The canonical architecture document lives at the repo root: [`ARCHITECTURE.md`](https://github.com/your-org/work-intelligence-mcp/blob/main/ARCHITECTURE.md).**
> This page is the web-friendly mirror. When the two disagree, the root file wins.

A local-first AI brain for engineering work. It pulls **Microsoft Teams, Outlook, Jira, and GitHub** into SQLite, layers a **Unified Brain** (ADR-024) and **Cypher** (ADR-033 / ADR-036 / ADR-037) on top, and exposes everything through three surfaces:

- **MCP stdio** — for Claude Code / Cursor
- **HTTP bridge** — for the web UI and CLI skills
- **Background agents** — 11 autonomous loops (meeting prep, bug investigator, code-graph indexer, ...)

All data stays on your laptop. The only outbound traffic is to Anthropic (for AI) and the source systems (for data).

**Last verified:** 2026-06-20 · **Schema:** v63 (v64 in flight) · **Milestones:** Cypher v1.4 shipped; ADR-036 live code work complete (PHASE-86-02-A/B/C); **Cypher v2.0 PRD locked** (ADR-037 loop); **v2.5 architectural commitment** ([ADR-038](adr/adr-038-cypher-v2.5-production-grade.md)).

> **Cypher doctrine** lives at [`CYPHER.md`](https://github.com/your-org/work-intelligence-mcp/blob/main/CYPHER.md) at the repo root. Read it for the persona contract — what Cypher *is* (not just what it does).

---

## System architecture

```mermaid
graph TB
    subgraph Clients["Clients"]
        CC["Claude Code / Cursor<br/>(MCP stdio)"]
        WEB["Web UI (Vite React :5175)"]
        ATLAS["Atlas / OpenClaw plugin"]
    end

    subgraph Server["Server processes (one machine)"]
        MCP["MCP server<br/>src/server.ts"]
        BRIDGE["HTTP bridge<br/>web-server.js :3132<br/>+ SSE + agents"]
    end

    subgraph Tools["Tool surface — src/tools/manifest.ts"]
        BRAIN["5 brain MCP tools<br/>(get_context, get_decision,<br/>verify_claim, recall_memory,<br/>record_outcome)"]
        WI["17 wi_* tools<br/>(search, jira, pr, action_items,<br/>topics, teams, calendar, digest,<br/>code_graph, teammates, sync, …)"]
        DEPR["10 deprecated tools<br/>(removal: Phase 74)"]
    end

    subgraph Engine["Engine"]
        AI["AIAnalyzer<br/>Haiku + Sonnet"]
        BRAINS["services/brain/<br/>decision · recall · verify · learn"]
        SYNC["SyncService<br/>15-min loop"]
        INV["Investigation orchestrator<br/>(ReAct, max 8 iter)"]
    end

    subgraph Storage["Local storage"]
        DB[("data.db<br/>SQLite v46 WAL")]
        PAL[("MemPalace<br/>ChromaDB + KG")]
    end

    subgraph External["External sources"]
        JIRA["jira.example.com (MCP / browser)"]
        TEAMS["teams.microsoft.com (browser)"]
        OUTLOOK["outlook.office.com (browser)"]
        GITHUB["github.com (MCP)"]
        ANTHROPIC["api.anthropic.com"]
    end

    CC --> MCP
    WEB --> BRIDGE
    ATLAS --> BRIDGE
    MCP --> Tools
    BRIDGE --> Tools
    Tools --> Engine
    Engine --> Storage
    Engine --> External
```

## What ships today

| Surface | Status |
|---|---|
| 5 canonical brain MCP tools | ✅ Live |
| 17 `wi_*` operational tools (manifest-driven) | ✅ Live (Phase 72) |
| 10 legacy tools — `[DEPRECATED]` prefix | ✅ Live (back-compat) |
| Web UI (Dashboard, Topic Expert, Jira Report, Teams Updates, PRs, Teammates, Brain Status…) | ✅ Live |
| Background agents (MeetingPrep, AlertScorer, Correlation, ChangeWatcher) | ✅ Live |
| MemPalace (semantic recall + KG) | ✅ Live |
| Self-evolving prompts (OPRO + TextGrad + A/B) | ✅ Live (ADR-021) |
| OpenClaw plugin — 3 brain tools + 17 `wi_*` tools | ✅ Live |

## Quick links

| If you are… | Read |
|---|---|
| Wiring this into Claude Code | [`getting-started/quick-start`](./getting-started/quick-start) → [`getting-started/configuration`](./getting-started/configuration) |
| Trying to understand the system | [`architecture/index`](./architecture/index) → [`architecture/data-flow`](./architecture/data-flow) |
| Looking for the schema | [`architecture/database-schema`](./architecture/database-schema) |
| Tracking what shipped when | [`epics/index`](./epics/index) |
| Reading decisions and why | [`adr/index`](./adr/index) |
| Checking what's currently broken | [`architecture/known-gaps`](./architecture/known-gaps) |

---

:::tip Using This Site
- **Cmd/Ctrl + K** — search across all docs
- **Left sidebar** — browse by category
- **Right sidebar** — jump to sections on this page
:::
