# Connectors

All connectors are **disabled by default**. Nothing is fetched, and no external API is called, until you enable a connector in `wi.config.json` and provide its credentials in `.env`.

```json
{
  "connectors": {
    "jira": { "enabled": false, "mode": "mcp", "mcp": { "clientName": "jira", "url": "", "tokenEnvVar": "JIRA_MCP_TOKEN" } }
  }
}
```

See `wi.config.schema.json` for the full schema (it validates `wi.config.json`).

## Connector table

| Connector | Modes | Enabled flag (`wi.config.json`) | Required env vars (`.env`) | Data ingested |
|---|---|---|---|---|
| **jira** | `mcp` (MCP client), `browser` (automated browser), `both` | `connectors.jira.enabled` | MCP: `JIRA_MCP_URL`, `JIRA_MCP_TOKEN`; API: `JIRA_DOMAIN`, `JIRA_EMAIL`, `JIRA_API_TOKEN`; browser: `BROWSER_PROFILE_PATH`, `BROWSER_HEADLESS` | Issues (default list / board), JQL searches, issue investigation + analysis notes |
| **github** | `api` (REST), `mcp` (MCP client), `both` | `connectors.github.enabled` | API: `GITHUB_TOKEN`; MCP: `GITHUB_MCP_TOKEN`, `GITHUB_MCP_URL` | Pull requests, commits, file contents, code search, PR enrichment + review |
| **slack** | `api` | `connectors.slack.enabled` | `SLACK_TOKEN`, `SLACK_TEAM_ID` | Messages, channels, threads, action items, morning-brief signals |
| **linear** | `api` | `connectors.linear.enabled` | `LINEAR_API_KEY` | Issues/cycles for teams on Linear instead of Jira |
| **outlook** | `browser`, `graph` (Microsoft Graph) | `connectors.outlook.enabled` | Graph: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`; browser: `BROWSER_PROFILE_PATH`, `BROWSER_HEADLESS` | Mail watch, calendar, action items, digests |
| **teams** | `browser`, `graph` | `connectors.teams.enabled` | Graph: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`; browser: `BROWSER_PROFILE_PATH`, `BROWSER_HEADLESS` | Chats, meeting transcripts, team updates, FTS search |

Notes:

- `mode` selects the transport. For Jira/GitHub, `mcp` uses your own MCP server (configured in `wi.config.json` and `JIRA_MCP_*` / `GITHUB_MCP_*` env); `api` uses REST directly.
- Browser modes (Jira browser mode, Teams, Outlook) drive a real browser with your Chrome profile. This is the most fragile transport — see README limitations.
- Env var names are not fixed in code: each connector declares its token env var (`tokenEnvVar`, `apiKeyEnvVar`, etc.) in `wi.config.json`, so you can point connectors at different env var names without code changes.

## How to enable a connector

1. Edit `wi.config.json`: set `"enabled": true` for the connector (and pick a `mode` if it has one).
2. Copy `.env.example` to `.env` (if you have not already) and fill in that connector's env vars listed above.
3. Add the repos you want indexed to `wi.config.json` → `repos` (array of `{ name, localPath, githubSlug?, defaultBranch? }`).
4. Restart the server (`npm start`).

Disable a connector by setting `"enabled": false` and restarting — the server stops fetching from it (data already in SQLite remains queryable).

## Bridge endpoints per connector surface

The bridge (`localhost:3132`) exposes the ingested data as HTTP endpoints. Skills and the web UI talk to these:

| Endpoint | Purpose |
|---|---|
| `GET /api/board/issues` | Kanban board issues (board view) |
| `GET /api/jira/issues?filter=...` | Jira issues via JQL/filter |
| `POST /api/pr/enrich` | AI-generated PR description/review enrichment |
| `GET /api/code-graph/blast-radius?file=...` | What changes when this file changes |
| `GET /api/teams-updates?query=...` | FTS search over Teams chats + meeting transcripts |
| `GET /api/action-items` | Open action items (filter by status/assignee/topic) |
| `GET /api/morning-brief` | Composite daily brief (digest + alerts + workload) |
| `GET /api/bis-regression/plan` | Regression-check plan for a ticket + PR |

Endpoints return data from the local SQLite store (plus live fetches where configured). Protect the bridge with `MCP_BRIDGE_TOKEN` if you expose it beyond localhost — see SECURITY.md.
