---
sidebar_position: 3
title: MCP Registration & Claude Code
---

# MCP Registration & Claude Code

This page explains how the Work Intelligence MCP server is registered, why we edit `.claude.json` directly, and how Claude Code picks it up.

---

## How MCP Registration Works

Claude Code stores all MCP server configurations in a single file:

```
~/.claude.json
```

This file is Claude Code's global state — it stores session history, project settings, tool usage counts, and crucially, **per-project MCP server registrations** under `projects["<absolute-path>"].mcpServers`.

### Why per-project scope?

MCP servers are scoped to the directory you opened Claude Code in. This means:
- `work-intelligence` is only available when you're in the `work-intelligence-mcp` directory
- It won't interfere with other projects (like `example-service`)
- Different projects can have different MCP servers

---

## Why We Edit `.claude.json` Directly

The `claude mcp add` CLI command exists but has a quirk — when passed many `--env` flags in a single command, it can silently produce an empty registration (command and args saved as empty strings). We hit this during setup.

The reliable approach is to write the JSON directly into `.claude.json`:

```json
// ~/.claude.json
{
  "projects": {
      "mcpServers": {
        "work-intelligence": {
          "type": "stdio",
          "command": "node",
          "args": [
          ],
          "env": {}
        }
      }
    }
  }
}
```

Key points:
- `type: "stdio"` — the MCP server communicates over stdin/stdout (the standard for local MCP servers)
- `--env-file=...` — loads the `.env` file using Node.js 20's built-in flag, so all env vars (API keys, browser path, Jira config) are available without hardcoding them into `.claude.json`
- `env: {}` — empty because env vars come from `.env` via the `--env-file` flag, not from here

---

## Verifying the Registration

```bash
# Check server is registered and healthy
claude mcp list

# Expected output:
# work-intelligence: node --env-file=... dist/server.js - ✓ Connected
```

If it shows `✗ Failed to connect`, run `npm run build` first — the server runs from compiled `dist/` files, not TypeScript source.

---

## The Build Requirement

The MCP server is written in TypeScript. Claude Code runs it as plain Node.js (`node dist/server.js`), so it must be compiled first:

```bash
npm run build   # compiles src/ → dist/
```

**You must rebuild after every code change.** The server Claude Code connects to is the compiled version. If you change `src/server.ts` or any tool and don't rebuild, Claude Code is still running the old code.

```bash
# Development workflow
npm run typecheck   # catch errors first
npm run build       # compile
# Claude Code auto-restarts the server on next tool call
```

---

## How Claude Code Connects

When you open a Claude Code session in the `work-intelligence-mcp` directory:

1. Claude Code reads `~/.claude.json`, finds the `mcpServers` entry for this project path
2. It spawns the server as a child process: `node --env-file=.env dist/server.js`
3. It sends a `tools/list` JSON-RPC request over stdin
4. The server responds with all 5 tool descriptors
5. Claude Code registers those tools — they're now available in every conversation in this session

The connection persists for the session lifetime. The server process is kept alive and reused for all tool calls.

---

## MCP Protocol Basics

The server uses the **Model Context Protocol** over stdio:

```
Claude Code  ──stdin──►  work-intelligence server
             ◄─stdout──
```

Every tool call is a JSON-RPC 2.0 message:

```json
// Claude Code sends:
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_jira_report",
    "arguments": {
      "projectKey": "BDS",
      "boardUrl": "https://jira.example.com/issues/?jql=..."
    }
  }
}

// Server responds:
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "# BDS Team — Jira Report\n..." }]
  }
}
```

The `text` content is what Claude sees and uses to answer your question.

---

## VS Code vs CLI

The same `~/.claude.json` config works for both:

| Interface | How to use |
|-----------|-----------|
| **Claude Code CLI** | `cd work-intelligence-mcp && claude` — server auto-connects |
| **VS Code extension** | Open the `work-intelligence-mcp` folder — server auto-connects |
| **Other projects** | Server is NOT available (scoped to this directory) |

To make it available globally in all projects, change the scope:

```bash
claude mcp add work-intelligence ... --scope global
```

But for now project scope is intentional — the Jira scraper launches Chrome and that's not something you want running in every session.
