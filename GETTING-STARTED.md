# Getting Started — Work Intelligence MCP

> **New here?** Read this page first, then [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full system map.

## What this project is

Work Intelligence MCP is your **operational brain**: it syncs Jira, Teams, email, and calendar into SQLite, runs AI analysis on that data, and exposes everything through:

1. **HTTP bridge** (`npm run web:bridge`) — port **3132** — REST + SSE for the web UI and Atlas
2. **MCP server** (`npm run dev`) — stdio — Claude Desktop / Cursor tools
3. **Web UI** (`npm run web:dev`) — port **5175** — dashboard, chat, Jira report, PR review

Data always flows in four stages — no shortcuts:

```
FETCH → PROCESS → ANALYZE → PROPOSE
```

Connectors pull raw data → SQLite + FTS5 → Claude interprets → UI / MCP / alerts surface results.

## Prerequisites

| Requirement | Notes |
|-------------|--------|
| Node.js 20+ | `npm install` at repo root |
| `.env` | Copy from `.env.example`; set `ANTHROPIC_API_KEY` at minimum |
| Chrome profile (optional) | `BROWSER_PROFILE_PATH` for Teams/Jira browser connectors |
| Connected repos (optional) | `./repos/<your-repo>`, `./repos/<your-second-repo>` for code graph + investigation |

## Quick start (5 minutes)

```bash
# 1. Install
npm install
cd web && npm install && cd ..

# 2. Configure
cp .env.example .env
# Edit .env — add ANTHROPIC_API_KEY

# 3. Build + run bridge
npm run build
npm run web:bridge

# 4. In a second terminal — web UI
npm run web:dev
```

Open **http://localhost:5175**. The UI talks to the bridge at **http://localhost:3132**.

**First visit:** open **http://localhost:5175/setup** for a checklist (API key, browser profile, GitHub, initial sync). Chat is the homepage (`/`).

### Platform notes (macOS)

| Feature | macOS | Linux / Windows |
|---------|-------|-----------------|
| Teams / Jira browser scrape | Yes (with `BROWSER_PROFILE_PATH`) | Yes |
| Outlook live fetch | Yes | Limited — browser only |
| Calendar watcher | Yes (AppleScript) | Not supported |

### Verify it works

```bash
npm run build
lsof -ti :3132 | xargs kill -9 2>/dev/null; sleep 1
npm run web:bridge &
sleep 5
npm run smoke:bridge
```

You should see **27 passed, 0 failed** (smoke count grows as routes are added).

## Mental model — where things live

| You want to… | Start here |
|--------------|------------|
| Understand the whole system | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| See every file and what it does | [`docs/docs/architecture/components.md`](docs/docs/architecture/components.md) |
| Call HTTP endpoints | [`docs/docs/api-reference/index.md`](docs/docs/api-reference/index.md) |
| Use Atlas / MCP tools | `src/tools/manifest.ts` — 18 `wi_*` tools |
| Change a route | `src/routes/` — extracted handlers; see [`src/routes/README.md`](src/routes/README.md) |
| Run agents (sync, alerts, meeting prep) | Boot block in `web-server.js` — check `/api/agents/health` |
| Debug “what's broken” | [`.planning/ADR-REVIEW.md`](.planning/ADR-REVIEW.md) + [`docs/docs/architecture/known-gaps.md`](docs/docs/architecture/known-gaps.md) |
| Agent workflow rules | [`CLAUDE.md`](CLAUDE.md) |

## Key concepts

### Unified Brain (ADR-024)

Five pillars exposed as MCP tools and HTTP routes:

- **Context** — `GET /api/brain/context` / `wi_brain_context`
- **Decide** — `POST /api/brain/decide` (+ SSE stream)
- **Verify** — `POST /api/brain/verify`
- **Recall** — `POST /api/brain/recall`
- **Learn** — `POST /api/brain/learn` / `wi_brain_learn`
- **History** — `GET /api/brain/decisions` / `wi_decisions_history` — audit past decisions

### Investigation engine (ADR-013 / ADR-022)

`POST /api/jira/investigate` runs a ReAct loop over git, flags, and code. Skill `/wi-investigate` wraps it for Claude Code. When a **new** Jira ticket matches a past investigation (≥ 0.7 confidence), you get a proactive notification in the chat feed.

### Smoke tests (required before “done”)

| Command | When |
|---------|------|
| `npm run smoke:bridge` | Any bridge / route / agent change |
| `npm run smoke:ui` | Sidebar, chat, linkify, React pages |
| `npm run smoke:all` | Cross-boundary changes |

Full protocol: [`.claude/rules/smoke-tests.md`](.claude/rules/smoke-tests.md)

## Common tasks

### Sync Teams / Jira now

```bash
npm run teams-sync
# Jira: use wi_sync or the web UI sync control; MCP: npm run mcp-setup for jira
```

### Morning brief

Web UI → **Daily** section, or skill `/wi-morning-brief`.

### Investigate a ticket

```bash
curl -X POST http://localhost:3132/api/jira/investigate \
  -H "Content-Type: application/json" \
  -d '{"key":"JIRA-12345"}'
```

Or in Claude Code: `/wi-investigate JIRA-12345`.

### List brain decisions this week

```bash
curl "http://localhost:3132/api/brain/decisions?user=you&since=2026-05-14&limit=20"
```

Or Atlas tool: `wi_decisions_history`.

## Documentation map

| Doc | Audience |
|-----|----------|
| **GETTING-STARTED.md** (this file) | New developers |
| **ARCHITECTURE.md** | System overview + processes |
| **docs/docs/intro.md** | Docusaurus landing (mirrors architecture) |
| **docs/docs/adr/index.md** | All ADRs with status |
| **docs/docs/epics/index.md** | Shipped epics by sprint |
| **README.md** | One-screen repo status |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Bridge returns wrong/stale behavior | `npm run build` then restart bridge; check startup for `dist/` freshness warning |
| `/api/agents/health` shows `crashed` | Read stderr from `npm run web:bridge`; fix that agent before trusting answers |
| CORS errors from UI | Set `MCP_BRIDGE_ALLOWED_ORIGINS=http://localhost:5175` in `.env` |
| Palace banner amber | `MEMPALACE_PATH` unset or Python env broken — `npm run check:palace` |
| Smoke fails on agents | Wait for boot (`sleep 5`); smoke polls up to 20s |

## What's next in the codebase

Active hygiene work is tracked in [`.planning/ADR-REVIEW.md`](.planning/ADR-REVIEW.md). **REFACTOR-001** is moving routes out of `web-server.js` into `src/routes/` (~19 of ~80 done). Prefer extracting the next family from [`src/routes/README.md`](src/routes/README.md) before adding new inline handlers.

---

*Last updated: 2026-05-21 — Sprint B (GAP-002/003/004) + newcomer doc pass.*
