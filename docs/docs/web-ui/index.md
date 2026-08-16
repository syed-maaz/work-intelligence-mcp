---
title: "Web UI"
sidebar_label: "Web UI"
sidebar_position: 5
---

# Work Intelligence Web UI

A local React single-page app that exposes all 8 MCP tools through a browser interface. No cloud, no deployment — runs entirely on `localhost`.

## Architecture

```
Browser (localhost:5173)
    ↓  Vite proxy (/api/* → :3132)
web-server.js  (localhost:3132)
    ↓  Node.js imports
dist/  (compiled MCP tools)
    ↓
~/.work-intelligence-mcp/data.db  (SQLite)
```

Two processes run side-by-side:
- **`web-server.js`** — HTTP bridge that wraps all MCP tools as REST endpoints
- **Vite dev server** — serves the React SPA and proxies API calls

## Quick Start

```bash
# 1. Build the MCP server
npm run build

# 2. Terminal A — start the HTTP bridge
npm run web:bridge
# → Listening on http://localhost:3132

# 3. Terminal B — start the web UI
npm run web:install   # first time only
npm run web:dev
# → Opens at http://localhost:5173
```

## Pages

| Page | URL | What it does |
|------|-----|--------------|
| Dashboard | `/` | Stats, recent messages, open actions, meetings, sync state |
| Topic Expert | `/topic-expert` | Ask a natural language question across all sources |
| Jira Report | `/jira-report` | Live Jira board scrape + AI analysis |
| Teams Updates | `/teams-updates` | Search synced Teams messages and transcripts |
| Search All | `/search-all` | Cross-source search: Outlook + Jira + Teams |
| Action Items | `/action-items` | Browse and filter AI-extracted action items |
| Daily Digest | `/digest` | AI-generated topic summary for a given day |
| Topics | `/topics` | Configure monitored projects |
| [Bugs](./bugs-page) | `/bugs` | Browse captured bugs from bridge / agents / web-UI (ADR-030 Phase A) |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘K` / `Ctrl+K` | Open command palette — jump to any page |
| `Escape` | Close command palette |

## Output Display

Every tool output page has a **Rendered / Raw toggle**:
- **Rendered** — markdown formatted as HTML (headings, tables, code blocks)
- **Raw** — monospace preformatted text with a copy button

## Theme

Three modes, cycled with the sun/moon icon in the top bar:
- **System** — follows your OS dark/light setting
- **Light** — off-white background
- **Dark** — near-black background

## Tool Requirements

| Tool | Requires |
|------|---------|
| Dashboard | Bridge running |
| Topic Expert | `ANTHROPIC_API_KEY` for AI synthesis; `GITHUB_TOKEN` for GitHub |
| Jira Report | `BROWSER_PROFILE_PATH` + `BROWSER_EXECUTABLE` |
| Teams Updates | Teams data synced via `npm run teams-sync` |
| Search All | `BROWSER_PROFILE_PATH` + `BROWSER_EXECUTABLE` |
| Action Items | Data synced first |
| Daily Digest | `ANTHROPIC_API_KEY` |
| Topics | Bridge running |

## Project Structure

```
web/
  index.html
  vite.config.ts          ← proxy /api/* → localhost:3132
  package.json
  tailwind.config.ts
  src/
    main.tsx              ← entry, QueryClient, theme init
    App.tsx               ← React Router routes
    globals.css           ← CSS variables (auto dark/light), prose styles
    lib/
      api.ts              ← typed fetch client
      utils.ts            ← cn(), formatRelative(), formatDate()
    store/
      ui.ts               ← Zustand: theme, sidebar, command palette
    components/
      shell/              ← AppShell, Sidebar, Topbar, StatusBar, CommandPalette
      shared/             ← MarkdownPanel, SkeletonCard, EmptyState, SourceBadge, ConnectionGuard
      ui/                 ← Button, Badge, Card, Input, Select, Textarea, Tabs
    pages/                ← one file per route

web-server.js             ← HTTP bridge (port 3132)
```

## web-server.js API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | DB stats + connection health |
| GET | `/api/topics` | List configured topics |
| GET | `/api/action-items` | List action items (`?topic=&status=&assignee=`) |
| GET | `/api/messages/recent` | Last N messages (`?limit=&source=`) |
| GET | `/api/meetings/recent` | Last N meetings (`?limit=`) |
| GET | `/api/sync-state` | Sync state per topic/source |
| POST | `/api/search` | Full-text search |
| POST | `/api/search-all` | Cross-source live search |
| POST | `/api/digest` | Generate daily digest |
| POST | `/api/jira-report` | Live Jira board report |
| POST | `/api/teams-updates` | Search Teams messages |
| POST | `/api/topic-expert` | Ask topic expert question |
| POST | `/api/configure-topic` | Create/update topic |

## Troubleshooting

**"Bridge server not reachable"** — The web UI shows a warning banner. Run `npm run web:bridge` in a separate terminal.

**Jira/Search All returns error** — `BROWSER_PROFILE_PATH` must be set in your `.env`. Browser tools require Chrome with active SSO session.

**No data on Dashboard** — Run `npm run teams-sync` to populate the database first.

**GitHub missing from Topic Expert** — Add `GITHUB_API_URL` and `GITHUB_TOKEN` to `.env`.
