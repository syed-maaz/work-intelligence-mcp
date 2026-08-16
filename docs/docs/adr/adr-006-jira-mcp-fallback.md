---
sidebar_position: 6
title: ADR-006  Jira MCP with Browser Fallback
---

# ADR-006:  Jira MCP Adapter with Browser Scraper Fallback

| Field | Value |
|-------|-------|
| **Date** | 2026-04-19 |
| **Status** | ✅ Accepted (amended 2026-04-19: CLI subprocess approach) |
| **Deciders** | Project owner |
| **Epic** | [EP-46](../epics/ep46-jira-mcp-adapter) |

## Context

Work Intelligence MCP originally accessed Jira via `JiraBrowserConnector` — a Playwright scraper that opens `jira.example.com` in a headless Chrome session and extracts issue data from the DOM. This approach was chosen because no stable API access was available at the time (see [ADR-003](./adr-003-jira-rest)).

In April 2026,  released the ** Jira MCP Server** (`jira` MCP server), which exposes `jira.example.com` through a proper OAuth2-authenticated REST API.

### Auth Problem (Amendment — 2026-04-19)

The initial implementation used `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` to call `mcp.jira.example.com` directly from `web-server.js`. This failed with `{"detail":"Invalid token."}` because:

- The  Jira MCP server uses **OAuth2 DCR** (Dynamic Client Registration) managed entirely by Claude CLI.
- The OAuth session is stored in Claude CLI's internal credential store — it is **not accessible as a static env var**.
- `JIRA_MCP_TOKEN` env var attempts were futile: Claude CLI holds the token in memory and refreshes it automatically; no equivalent mechanism exists for a standalone Node process.
- The user routes Claude through a **HAI proxy** (`ANTHROPIC_BASE_URL`), so the OAuth session is additionally tied to that proxy's auth flow — not extractable.

## Decision (amended 2026-04-19: direct keychain token approach)

**`JiraMcpAdapter` calls the  Jira MCP server directly via HTTP**, reading the OAuth access token from the macOS keychain (`Claude Code-credentials`) and auto-refreshing it using the stored refresh token.

The earlier `claude -p` subprocess approach was abandoned because:
- `claude -p` subprocesses do NOT inherit project-scope MCP OAuth tokens
- Each subprocess creates a new OAuth client registration requiring a new browser auth flow
- `ANTHROPIC_BASE_URL` (HAI proxy) is required for Claude but doesn't affect the MCP endpoint
- The real fix: read the token Claude Code already has from the macOS keychain directly

```
web-server.js  →  execFile('claude', ['-p', '--output-format', 'json', prompt])
                       ↓
               Claude CLI  (holds valid OAuth session for jira)
                       ↓
               mcp.jira.example.com  →  jira.example.com API
```

The subprocess receives a structured prompt instructing it to call `jira_search` and return a flat JSON array. `JiraMcpAdapter` parses that JSON and maps it to `UnifiedMessage[]`.

### Why CLI subprocess over direct HTTP

| Approach | Auth | Pros | Cons |
|----------|------|------|------|
| `StreamableHTTPClientTransport` | Static token in env var | Zero subprocess overhead | Token not accessible; fails with "Invalid token" |
| **`claude -p` subprocess** ✅ | OAuth session from Claude CLI | Works with HAI proxy; token auto-refreshes | ~5–10s latency per call; cached by TTL |
| Keychain extraction | macOS Keychain | No subprocess | Claude CLI doesn't store token in Keychain |
| Proxy endpoint | New HTTP endpoint on bridge | Single process | Circular: bridge would call itself; same auth problem |

### Why this is acceptable (and good enough)

- **Latency is hidden**: Saturn/MyIssues cache has a 1-hour TTL. The 5–10s `claude -p` call runs once per hour, in the background, non-blocking. DB-warmed data serves immediately on page load.
- **Auth is permanent**: The OAuth session persists as long as Claude CLI is installed and authenticated. No rotation, no expiry management needed.
- **Single source of truth**: The same Claude CLI session used interactively is used programmatically. No divergence between "what Claude can see" and "what web-server can see".
- **Fallback still present**: `JiraAutoAdapter` catches any subprocess failure and falls back to the browser scraper.

### Selection

```
JIRA_SOURCE=mcp        # use CLI subprocess MCP adapter
JIRA_SOURCE=browser    # use Playwright scraper directly
JIRA_SOURCE=auto       # try CLI subprocess, fall back to browser (default)
```

## Consequences

**Positive**:
- Works correctly with HAI proxy and Claude's OAuth session — no token management needed
- Richer data than the browser scraper: comments, labels, epic links
- Browser dependency (`BROWSER_PROFILE_PATH`) becomes optional
- `withSaturnLock()` / `withMyIssuesLock()` can eventually be removed (MCP path is stateless)

**Negative**:
- `claude -p` subprocess adds ~5–10s latency per call — acceptable only because of the 1-hour TTL
- Subprocess approach is unusual; `claude` binary must be in PATH when `web-server.js` runs
- Prompt-based extraction is less precise than direct API calls — Claude normalises the JSON but may occasionally misformat edge cases (mitigated by try/catch + browser fallback)

## Implementation References

- Epic: [EP-46 Jira MCP Adapter](../epics/ep46-jira-mcp-adapter)
- Adapter: `src/connectors/jira-adapter.ts` — `JiraMcpAdapter.callViaCli()`
- Fallback connector: `src/connectors/jira-browser.ts` (unchanged)
- Primary callers: `src/tools/jira-report.ts`, `src/tools/search-all.ts`, `web-server.js`
