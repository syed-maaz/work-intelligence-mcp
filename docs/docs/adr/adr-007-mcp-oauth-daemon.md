---
sidebar_position: 7
title: ADR-007 Universal MCP OAuth Client Daemon
---

# ADR-007: Universal Headless MCP OAuth Client Daemon

| Field | Value |
|-------|-------|
| **Date** | 2026-04-19 |
| **Status** | ✅ Accepted |
| **Deciders** | Project owner |
| **Epic** | [EP-46](../epics/ep46-jira-mcp-adapter) |
| **Supersedes** | ADR-006 (`claude -p` subprocess approach — abandoned) |

---

## Context

After EP-46's initial implementation, three approaches to calling  Jira MCP were investigated and failed:

| Approach | Result | Root cause |
|---|---|---|
| `StreamableHTTPClientTransport` + `JIRA_MCP_TOKEN` env var | ❌ 401 Invalid token |  Jira MCP uses OAuth2 DCR — PAT tokens are rate-limited by a different proxy |
| `claude -p` subprocess | ❌ `jira_search` not available | Subprocess doesn't load project-scoped MCP servers from `~/.claude.json` |
| Read token from macOS Keychain | ❌ Token always stale | Claude Code holds live token in-memory only; keychain entry is not updated during a session |

**Root cause (confirmed upstream):** Claude Code is an *interactive MCP client*, not a session service. Its OAuth token is process-bound, session-scoped, and in-memory authoritative. There is no supported API to share, export, or flush tokens. This is an intentional security boundary. ([anthropics/claude-code#28262](https://github.com/anthropics/claude-code/issues/28262))

**Key insight from POC (2026-04-19):** The  Jira MCP server at `mcp.jira.example.com` supports:
- OAuth 2.1 + PKCE
- Dynamic Client Registration (`POST /register`)
- Token refresh (`POST /token` with `refresh_token` grant)
- Direct Streamable HTTP tool calls with `Authorization: Bearer`

This means **we can own the OAuth client lifecycle ourselves**, completely independent of Claude Code.

---

## Decision

**Build a universal headless MCP OAuth client (`McpClient`) that:**
1. Does Dynamic Client Registration once at setup time
2. Stores `client_id`, `access_token`, `refresh_token`, `expires_at` in SQLite
3. Auto-refreshes tokens before expiry (refresh tokens rotate — always fresh)
4. Calls MCP tools directly via HTTP — no subprocess, no Claude Code dependency
5. Works for **any** HTTP MCP server that supports OAuth 2.1 (jira, github-tools, etc.)

**One-time setup per MCP server:**
```bash
npm run mcp-setup -- --name jira --url https://mcp.jira.example.com/mcp
# Opens browser for PKCE auth — done once, works forever
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  web-server.js / JiraMcpAdapter / GitHub sync               │
│  (consumers — just call McpClient.callTool())               │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  McpClient  (src/connectors/mcp-oauth-client.ts)            │
│                                                             │
│  getAccessToken()                                           │
│    ├─ read from SQLite mcp_oauth_tokens                     │
│    ├─ if valid → return immediately                         │
│    └─ if expired → POST /token (refresh) → save → return   │
│                                                             │
│  callTool(toolName, args)                                   │
│    ├─ getAccessToken()                                      │
│    ├─ POST MCP_URL with Bearer token                        │
│    └─ parse SSE response → return text                      │
└──────────────────────────┬──────────────────────────────────┘
                           │  Bearer token (auto-refreshed)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│   Jira MCP:   https://mcp.jira.example.com/mcp            │
│  GitHub MCP:     https://mcp.github.com/mcp          │
│  (any OAuth 2.1 HTTP MCP server)                            │
└─────────────────────────────────────────────────────────────┘

SQLite DB (mcp_oauth_tokens table — schema v26)
┌──────────────┬─────────────────────────────┬──────────────┐
│ server_name  │ jira                    │ github-tools │
│ client_id    │ 2ZfDlHB49CWNWIqq...        │ abc123...    │
│ access_token │ eyJhbGci... (15min TTL)     │ eyJhbGci...  │
│ refresh_token│ VDFi_WXF... (rotates)       │ xyz789...    │
│ expires_at   │ 1776624536000               │ ...          │
└──────────────┴─────────────────────────────┴──────────────┘
```

---

## OAuth Flow (one-time setup)

```
scripts/mcp-setup.ts                  mcp.jira.example.com
      │                                       │
      │  POST /register (DCR)                 │
      │──────────────────────────────────────►│
      │◄──────────────────────────────────────│ { client_id }
      │                                       │
      │  Start local HTTP server :3999        │
      │  Print auth URL to terminal           │
      │                                       │
      │  [user opens URL in browser]          │
      │                                       │
      │                                       │  GET /authorize?client_id=...
      │                                       │◄──────────────────
      │                                       │  [user logs in, approves]
      │                                       │──────────────────►
      │  GET /callback?code=...               │
      │◄──────────────────────────────────────│
      │                                       │
      │  POST /token (code exchange + PKCE)   │
      │──────────────────────────────────────►│
      │◄──────────────────────────────────────│ { access_token, refresh_token }
      │                                       │
      │  saveToken(db, { serverName,          │
      │    clientId, accessToken,             │
      │    refreshToken, expiresAt })         │
      │                                       │
      ✅  Done — runs headlessly forever      │
```

---

## Token Refresh Flow (automatic, every ~14 minutes)

```
McpClient.callTool()
      │
      ├─ getAccessToken()
      │       │
      │       ├─ read from DB: expiresAt = now + 5s → expired
      │       │
      │       │  POST /token
      │       │  grant_type=refresh_token
      │       │  refresh_token=<stored>         ──────────────►  MCP
      │       │  client_id=<stored>             ◄────────────── { access_token, refresh_token* }
      │       │
      │       │  * refresh tokens rotate on each use
      │       │    new refresh_token saved to DB immediately
      │       │
      │       └─ return new access_token
      │
      └─ POST mcp.jira.example.com/mcp
         Authorization: Bearer <fresh_token>
```

---

## Adding a New MCP Server (e.g. GitHub)

```bash
npm run mcp-setup -- --name github-tools --url https://mcp.github.com/mcp
```

Then in code:
```typescript
const client = new McpClient(db, 'github-tools');
const raw = await client.callTool('list_pull_requests', {
  owner: 'my-org', repo: 'my-repo', state: 'open'
});
```

That's it. Token management is identical for all servers.

---

## Why not existing OSS solutions?

| Project | Why not used |
|---|---|
| `mcp-proxy` (punkpeye) | Transport bridge only — doesn't handle OAuth client |
| `@aiwerk/mcp-bridge` | Would work, but adds external dep + Docker; our SQLite-based approach is 150 LOC and zero new deps |
| `supergateway` | Same — transport layer only, assumes you already have a token |
| MCP Rust SDK OAuthState | Rust — not Node.js |
| ContextForge | External service; not open source enough for corp environment |

The official `@modelcontextprotocol/sdk` (`StreamableHTTPClientTransport`) was not used because it triggers its own OAuth flow and doesn't accept pre-existing tokens. Raw `fetch()` + our own token management is simpler and gives us full control.

---

## Consequences

**Positive:**
- Zero dependency on Claude Code session — works headlessly 24/7
- Universal — identical code for jira, github-tools, any HTTP MCP server
- Fast — direct HTTP, no subprocess (~1-2s vs ~80s for `claude -p`)
- No rate limiting — MCP endpoint is separate from Jira REST API
- Automatic token refresh — refresh tokens rotate, always fresh
- One-time setup — `npm run mcp-setup` once per server, never again

**Negative:**
- Requires one-time interactive browser auth per MCP server
- If both access + refresh tokens expire (no usage for extended period), re-run `npm run mcp-setup`
- `mcp_oauth_tokens` table contains sensitive tokens — DB file should have restricted permissions

---

## Files

| File | Purpose |
|---|---|
| `src/connectors/mcp-oauth-client.ts` | Universal `McpClient` class + token storage helpers |
| `src/connectors/jira-adapter.ts` | `JiraMcpAdapter` uses `McpClient` for all Jira fetches |
| `scripts/mcp-setup.ts` | One-time PKCE setup CLI |
| `src/db/schema.ts` | Schema v26: `mcp_oauth_tokens` table |

---

## POC Verification (2026-04-19)

```
✅ OAuth metadata discovery: GET /.well-known/oauth-authorization-server → 200
✅ Dynamic Client Registration: POST /register → client_id issued
✅ PKCE auth flow: browser redirect → code captured on localhost:3999
✅ Token exchange: POST /token → access_token + refresh_token
✅ jira_search: POST /mcp with Bearer → 3 BDS issues returned
✅ No rate limiting (mcp.jira.example.com ≠ jira.example.com)
```
