# Work Intelligence MCP

[![CI](https://img.shields.io/github/actions/workflow/status/YOUR-GITHUB-USERNAME/work-intelligence-mcp/ci.yml?branch=main&label=build&logo=github&style=flat-square)](https://github.com/YOUR-GITHUB-USERNAME/work-intelligence-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/YOUR-GITHUB-USERNAME/work-intelligence-mcp/pulls)

A local-first AI brain for engineering work. Ingests Jira, Teams, Outlook, GitHub, and calendar into SQLite, layers a Unified Brain on top, and exposes everything as MCP tools (for Claude Code / Cursor) and as an HTTP bridge (for the web UI). All data stays on your laptop.

```
Clients ──► MCP stdio  ┐
                       ├──► server.ts ──► services ──► SQLite (data.db) ──► MemPalace (KG + ChromaDB)
Web UI / Atlas ─► HTTP ┘     │              │
                             ▼              ▼
                          connectors    AIAnalyzer / Brain
                       (Jira, Teams,     (Haiku + Sonnet)
                        Outlook, GitHub,
                        calendar)
```

## Status (2026-05-21)

- **Schema:** v46 — `src/db/schema.ts`
- **Milestone:** v1.1 Phase 72 complete (Atlas Operational Surface) + Sprint 21 hygiene complete
- **Tool surface:** 5 brain MCP tools + 18 `wi_*` operational tools + 10 deprecated legacy tools
- **HTTP bridge:** ~80 endpoints; 20 routes in `src/routes/` (REFACTOR-001 in progress)
- **Smoke:** 27 bridge checks + UI checks via `npm run smoke:all`

## Start here

**[`GETTING-STARTED.md`](GETTING-STARTED.md)** — install, run bridge + UI, smoke tests, mental model (read this first).

| If you are… | Read |
|---|---|
| **An agent** (Claude Code, Cursor) | `CLAUDE.md` then `ARCHITECTURE.md` |
| **A human** new to the codebase | `ARCHITECTURE.md` then `docs/docs/architecture/` |
| **Adding a feature** | `.planning/PROJECT.md` → `.planning/ROADMAP.md` |
| **Fixing a bug** | `.planning/ADR-REVIEW.md` (the live "what's broken" ledger) |
| **Operating the system** | `docs/docs/getting-started/` |

The full Docusaurus site:

```bash
npm run docs:install && npm run docs:start
# → http://localhost:3000
```

## Run

```bash
# Terminal 1 — HTTP bridge (port 3132)
npm run web:bridge          # refuses to start if dist/ is older than src/

# Terminal 2 — React UI (port 5175)
npm run web:dev

# Or run the MCP stdio server directly:
npm run dev
```

## Verify before declaring done

```bash
npm run typecheck           # root + cd web && npx tsc --noEmit
npm run build               # refresh dist/ so the bridge picks up TS changes
npm run smoke:bridge        # 16-check end-to-end bridge smoke (~1.5 s)
npm run smoke:ui            # Playwright UI smoke (needs web:dev on :5175)
npm run smoke:all           # both
```

Full smoke-test protocol: [`.claude/rules/smoke-tests.md`](.claude/rules/smoke-tests.md).

Required `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_PATH=./data/intelligence.db
BROWSER_PROFILE_PATH=...        # Chrome profile (chrome://version → "Profile Path")
GITHUB_TOKEN=ghp_...
MEMPALACE_PATH=~/.work-intelligence-mcp/palace
```

Full reference: [`docs/docs/getting-started/configuration.md`](docs/docs/getting-started/configuration.md).

## Claude Desktop / Cursor config

```json
{
  "mcpServers": {
    "work-intelligence": {
      "command": "node",
      "args": ["/path/to/work-intelligence-mcp/dist/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "your-key",
        "DATABASE_PATH": "/path/to/data.db"
      }
    }
  }
}
```

## License

MIT — see [LICENSE](LICENSE). No cloud sync, no telemetry, all data local.

<!-- topics: work-intelligence, mcp, llm-agents, rag, agentic-ai, local-first, sqlite, typescript, claude-code, personal-assistant -->
