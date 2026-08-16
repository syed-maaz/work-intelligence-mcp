---
sidebar_position: 2
title: Configuration
---

# Configuration

All configuration is via environment variables. There are no config files.

## Environment Variables

### Core (Required)

| Variable | Description | Example |
|----------|-------------|---------|



| Variable | Description | Example |
|----------|-------------|---------|


:::

### Browser (Required for Teams + Outlook sync)

| Variable | Description | Default |
|----------|-------------|---------|
| `BROWSER_PROFILE_PATH` | Path to your Chrome user data directory | — |
| `BROWSER_HEADLESS` | Run browser headless | `true` |
| `BROWSER_EXECUTABLE` | Path to Chrome/Chromium binary | Auto-detected |

:::tip Finding BROWSER_PROFILE_PATH
- **macOS**: `~/Library/Application Support/Google/Chrome/Default`
- **Windows**: `C:\Users\YourName\AppData\Local\Google\Chrome\User Data\Default`
- Or navigate to `chrome://version` in Chrome and copy "Profile Path"
:::

:::warning SSO Session
The browser must already be logged into teams.microsoft.com and outlook.office.com with your work account. The scraper reuses your existing session — it does not log in for you.
:::

### Jira (Optional)

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `JIRA_DOMAIN` | Your Jira instance hostname | — | `jira.example.com` |
| `JIRA_BOARD_URL` | Full RapidBoard URL for your team's board — used by `npm run report` | BDS board | `https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=BDS` |
| `JIRA_PROJECT_KEY` | Jira project key — used by `npm run report` | `BDS` | `MYPROJ` |
| `JIRA_SINCE_DAYS` | How many days back to fetch issues for `recent` mode | `2` | `7` |
| `JIRA_MODE` | Report mode: `recent` (updated in last N days), `sprint` (active sprint), `mine` (assigned to you) | `recent` | `sprint` |

The Jira connector uses **browser scraping** (not the REST API — it is IP-blocked on the corporate Jira Data Center instance). No API token is needed. The browser session at `BROWSER_PROFILE_PATH` must already be logged into Jira via SSO.

RapidBoard URLs (`RapidBoard.jspa?rapidView=...`) are automatically converted to JQL issue navigator URLs before scraping — you can paste the board URL as-is from your browser.

**Report modes:**
```bash
npm run report                        # recently updated issues (JIRA_SINCE_DAYS)
JIRA_MODE=sprint npm run report       # active sprint issues
JIRA_MODE=mine npm run report         # issues assigned to you
```

### Sync

| Variable | Description | Default |
|----------|-------------|---------|
| `SYNC_INTERVAL_MS` | Background sync interval in milliseconds | `900000` (15 min) |

### GitHub (Optional — for `ask_topic_expert`)

| Variable | Description | Example |
|----------|-------------|---------|
| `GITHUB_API_URL` | Base URL of your GitHub instance API | `https://github.com/api/v3` |
| `GITHUB_TOKEN` | Personal access token with `repo` + `read:user` scopes | `ghp_...` |

When set, `ask_topic_expert` fetches live GitHub issues and PRs matching your query. Without these, GitHub is skipped and the answer uses DB data only.

**Getting a GitHub token**: visit `https://github.com/settings/tokens` → New classic token → check `repo` and `read:user` → copy the token.

```
GITHUB_API_URL=https://github.com/api/v3
GITHUB_TOKEN=ghp_your_token_here
```

## Claude Desktop Configuration

Full example `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "work-intelligence": {
      "command": "node",
      "env": {
        "BROWSER_HEADLESS": "true",
        "JIRA_DOMAIN": "jira.example.com",
        "JIRA_BOARD_URL": "https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=BDS",
        "JIRA_PROJECT_KEY": "BDS",
        "JIRA_SINCE_DAYS": "30",
        "SYNC_INTERVAL_MS": "900000"
      }
    }
  }
}
```

## Topic Configuration

Topics are configured via the `configure_topic` MCP tool. Each topic maps to one or more sources:

```json
{
  "name": "Project Alpha",
  "sources": {
    "teams": {
      "channels": [
        "https://teams.microsoft.com/_#/channel/..."
      ]
    },
    "email": {
      "filters": "Project Alpha"
    },
    "jira": {
      "projects": ["ALPHA", "INFRA"]
    }
  }
}
```

Topic configs are stored in the local SQLite database at `~/.work-intelligence-mcp/data.db`.

## Data Storage

All data is stored locally:

```
~/.work-intelligence-mcp/
└── data.db    # SQLite — messages, action items, topics, sync state
```

To reset all data: `rm ~/.work-intelligence-mcp/data.db`. The DB will be recreated on next start.
