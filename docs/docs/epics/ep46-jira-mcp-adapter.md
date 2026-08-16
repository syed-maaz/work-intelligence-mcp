---
sidebar_position: 46
title: EP-46 Jira MCP Adapter with Scraper Fallback
---

# EP-46: Jira MCP Adapter with Scraper Fallback

| Field | Value |
|-------|-------|
| **Status** | ✅ Complete (2026-04-19) |
| **Priority** | High |
| **Blocked By** | None |
| **Schema version** | v26 (`mcp_oauth_tokens` table) |
| **ADR** | [ADR-006](../adr/adr-006-jira-mcp-fallback) · [ADR-007](../adr/adr-007-mcp-oauth-daemon) |
| **Sprint** | 7 |

## Summary

Introduce a `JiraDataSource` abstraction over two implementations — `JiraMcpAdapter` (primary, uses the  Jira MCP server) and `JiraBrowserConnector` (fallback, existing Playwright scraper). All callers (`jira-report.ts`, `search-all.ts`, `web-server.js`) route through the adapter with no API changes. Source is controlled by `JIRA_SOURCE=mcp|browser|auto` env var.

## Architecture (Final — ADR-007)

The initial implementation used `StreamableHTTPClientTransport` with `JIRA_MCP_TOKEN`. Three approaches were investigated and failed (see [ADR-006](../adr/adr-006-jira-mcp-fallback) and [ADR-007](../adr/adr-007-mcp-oauth-daemon) for root cause details). The final solution is a **universal headless MCP OAuth client** that owns the OAuth lifecycle completely independently of Claude Code:

```
JiraMcpAdapter
      │
      ▼
McpClient (src/connectors/mcp-oauth-client.ts)
  ├─ getAccessToken() → reads mcp_oauth_tokens (SQLite), auto-refreshes if expired
  └─ callTool(name, args) → POST mcp.jira.example.com/mcp with Bearer token
                            → parse SSE response → return text
```

**One-time setup** (run once, works forever):
```bash
npm run mcp-setup -- --name jira --url https://mcp.jira.example.com/mcp
# Opens browser → PKCE auth → token saved to SQLite → auto-refreshes forever
```

Adding any new MCP server (GitHub, etc.):
```bash
npm run mcp-setup -- --name github-tools --url https://mcp.github.com/mcp
```

**Schema v26**: `mcp_oauth_tokens` table stores `client_id`, `access_token`, `refresh_token`, `expires_at` per server.

## Decisions Made

- **Adapter, not replacement** — `JiraBrowserConnector` is preserved unchanged; the adapter sits in front of it
- **`JIRA_SOURCE=auto` is the default** — tries MCP first, falls back to browser on any error; no silent data loss
- **Same `fetchMessages()` signature** — adapter must match the existing `DataSource` interface so callers need zero changes
- **Own OAuth lifecycle** — `McpClient` does Dynamic Client Registration + PKCE once; rotates refresh tokens automatically; zero Claude Code session dependency
- **Universal design** — identical `McpClient` code works for jira, github-tools, or any HTTP MCP server with OAuth 2.1
- **Mutexes become optional** — `withSaturnLock()` / `withMyIssuesLock()` in `web-server.js` guard the shared browser session; they are irrelevant when MCP is the active path
- **Schema v26** — added `mcp_oauth_tokens` table (one row per registered MCP server)

## Tickets

### EP-46-1: `JiraDataSource` Interface + Factory

**File**: `src/connectors/jira-adapter.ts` (new file)

```typescript
export interface JiraDataSource {
  fetchMessages(
    config: Record<string, unknown>,
    since?: Date
  ): Promise<UnifiedMessage[]>;
}

type JiraSourceMode = 'mcp' | 'browser' | 'auto';

export function createJiraDataSource(
  session: BrowserSessionManager,
  mode?: JiraSourceMode
): JiraDataSource
```

- Reads `JIRA_SOURCE` env var (default: `'auto'`)
- `'browser'` → returns `new JiraBrowserConnector(session)`
- `'mcp'` → returns `new JiraMcpAdapter()`
- `'auto'` → returns `new JiraAutoAdapter(session)` (tries MCP, falls back to browser)

**Verification**: `grep -r 'createJiraDataSource' src/` returns 4+ call sites after migration.

---

### EP-46-2: `JiraMcpAdapter` Implementation

**File**: `src/connectors/jira-adapter.ts` (same file, separate class)

```typescript
export class JiraMcpAdapter implements JiraDataSource {
  async fetchMessages(
    config: Record<string, unknown>,
    since?: Date
  ): Promise<UnifiedMessage[]>
}
```

**Internal logic**:
1. Extract `projectKey` and `boardUrl` from `config`
2. Derive JQL: `project = {projectKey} AND updated >= "{since.toISOString()}" ORDER BY updated DESC`
3. Call `jira_search` (paginated, up to 200 issues, 50 per page)
4. For each issue, call `jira_get_issue` to fetch comments
5. For each issue, call `jira_get_issue_development_info` to fetch linked PRs
6. Map results to `UnifiedMessage[]`:
   - One `UnifiedMessage` per issue (`source: 'jira'`, `source_id: issue.key`)
   - One `UnifiedMessage` per comment (`source: 'jira'`, `source_id: '{key}-comment-{id}'`)
7. Populate `metadata.jira` with: `issueKey`, `projectKey`, `status`, `priority`, `assignee`, `epicKey`, `labels`, `transitions` (from `jira_get_issue_dates` if available), `pullRequests`

**MCP tool calls used**:
- `mcp__jira__jira_search` — paginated issue list
- `mcp__jira__jira_get_issue` — comments, full description
- `mcp__jira__jira_get_issue_development_info` — linked PRs/branches/commits
- `mcp__jira__jira_get_issue_dates` — status transition history (optional, skipped on error)

**Anti-patterns**:
- Do NOT call `jira_get_issue` for every issue in the initial list if only summary data is needed — batch with `jira_search fields='*all'` first, then fetch detail only for issues that have comments or PRs
- Do NOT invent MCP tool names; only the 14 tools listed in the server documentation exist

**Verification**: `JIRA_SOURCE=mcp npm run report` completes without browser launch.

---

### EP-46-3: `JiraAutoAdapter` (try-MCP-then-browser)

**File**: `src/connectors/jira-adapter.ts` (same file)

```typescript
class JiraAutoAdapter implements JiraDataSource {
  constructor(private session: BrowserSessionManager) {}

  async fetchMessages(
    config: Record<string, unknown>,
    since?: Date
  ): Promise<UnifiedMessage[]> {
    try {
      const mcp = new JiraMcpAdapter();
      return await mcp.fetchMessages(config, since);
    } catch (err) {
      // log: '[jira-adapter] MCP failed, falling back to browser: ' + err.message
      const browser = new JiraBrowserConnector(this.session);
      return browser.fetchMessages(config, since);
    }
  }
}
```

**Verification**: Setting `JIRA_SOURCE=auto` and temporarily breaking the MCP path (e.g. passing invalid projectKey) causes browser scraper to run and data to still arrive.

---

### EP-46-4: Migrate Callers to `createJiraDataSource()`

Replace direct `JiraBrowserConnector` instantiation in 4 locations:

| File | Line(s) | Change |
|------|---------|--------|
| `src/tools/jira-report.ts` | 114–119 | Replace `new JiraBrowserConnector(session)` with `createJiraDataSource(session)` |
| `src/tools/search-all.ts` | 195–198 | Replace `new JiraBrowserConnector(session)` with `createJiraDataSource(session)` |
| `web-server.js` | 158–160 | Replace `new JiraBrowserConnector(session)` with `createJiraDataSource(session)` |
| `web-server.js` (Saturn) | 99–100 | `getSaturnIssues()` in `dist/tools/saturn-board.js` — check if it instantiates `JiraBrowserConnector` directly; if so, thread `createJiraDataSource` through its signature |

**Verification**: `grep -r 'new JiraBrowserConnector' src/ web-server.js` returns 0 results.

---

### EP-46-5: Update Environment Documentation

**File**: `CLAUDE.md` (project root), `.env.example` (if present)

Add to optional env vars section:
```
JIRA_SOURCE=auto   # jira data source: mcp | browser | auto (default: auto)
                   # mcp: use jira MCP server only
                   # browser: use Playwright scraper only
                   # auto: try mcp first, fall back to browser on error
```

**File**: `docs/docs/architecture/index.md` or relevant section — note that `BROWSER_PROFILE_PATH` is no longer required when `JIRA_SOURCE=mcp`.

---

### EP-46-6: Update ADR-003

**File**: `docs/docs/adr/adr-003-jira-rest.md`

Add a note that ADR-003 is superseded by ADR-005 for the `jira.example.com` ( on-prem) instance. The original REST API connector it describes applies to Jira Cloud (Atlassian) — a different instance.

---

## Key Code Locations (After Implementation)

- `src/connectors/jira-adapter.ts` — new file: `JiraDataSource`, `JiraMcpAdapter`, `JiraAutoAdapter`, `createJiraDataSource()`
- `src/connectors/jira-browser.ts` — unchanged (still the fallback)
- `src/tools/jira-report.ts:114` — caller migrated
- `src/tools/search-all.ts:195` — caller migrated
- `web-server.js:158` — caller migrated (My Issues)
- `web-server.js:99` — caller migrated (Saturn)
- `CLAUDE.md` — `JIRA_SOURCE` env var documented

## MCP Tools Reference ( Jira MCP Server)

The `jira` MCP server exposes these tools (read-only, PI2_2026):

| Tool | Used In | Purpose |
|------|---------|---------|
| `jira_search` | `JiraMcpAdapter.fetchMessages()` | Paginated JQL issue list |
| `jira_get_issue` | `JiraMcpAdapter.fetchMessages()` | Full issue + comments |
| `jira_get_issue_development_info` | `JiraMcpAdapter.fetchMessages()` | Linked PRs, branches, commits |
| `jira_get_issue_dates` | `JiraMcpAdapter.fetchMessages()` | Status transition history |
| `jira_get_project_components` | `get_jira_report` enrichment | Team/component breakdown |
| `jira_get_project_versions` | Future: release tracking | Fix versions |
| `jira_get_transitions` | Future: workflow analysis | Available transitions |
| `jira_get_worklog` | Future: cycle time tracking | Time logged per issue |

## Acceptance Criteria

- [x] `JIRA_SOURCE=mcp npm run report` produces a Jira report without launching a browser
- [x] `JIRA_SOURCE=browser npm run report` uses the Playwright scraper exactly as before
- [x] `JIRA_SOURCE=auto` (default) uses MCP; if MCP throws, browser scraper runs transparently
- [x] `grep -r 'new JiraBrowserConnector' src/ web-server.js` returns 0 results
- [x] `npm run typecheck` passes with 0 errors
- [x] `npm run build` succeeds
- [x] `UnifiedMessage.metadata.jira` includes `pullRequests` and `transitions` when MCP path is active
- [x] `CLAUDE.md` and env docs list `JIRA_SOURCE` with all three values explained
- [x] ADR-003 updated to note ADR-006 supersedes it for `jira.example.com`
