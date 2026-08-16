---
sidebar_position: 1
title: Quick Start
---

# Quick Start

Get the server running and connected to Claude Code.

## Prerequisites

- Node.js 20+
- npm
- Claude Code CLI (`claude` command) or VS Code with Claude Code extension
- Google Chrome installed (for Jira scraping)
- Your Chrome profile logged into `jira.example.com` via SSO

---

## 1. Install Dependencies

```bash
cd work-intelligence-mcp
npm install
npx playwright install chromium   # installs browser binaries for Playwright
```

---

## 2. Configure Environment

The `.env` file at the project root holds all configuration. Edit it:

```bash
# Required — Anthropic Claude API


# Required for Jira scraping — path to Chrome profile with active SSO session
# Find this at chrome://version → "Profile Path"
BROWSER_HEADLESS=true

# Required — must point to the real Chrome binary (NOT Playwright's bundled Chromium)
# Reason: Chrome encrypts cookies with macOS Keychain; only the same Chrome binary can decrypt them
BROWSER_EXECUTABLE=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome

# Jira board config (for npm run report CLI)
JIRA_DOMAIN=jira.example.com
JIRA_BOARD_URL=https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=BDS
JIRA_PROJECT_KEY=BDS
JIRA_SINCE_DAYS=2
```

:::

:::warning Chrome Profile
The scraper reuses your existing Chrome SSO session — it does NOT log in for you.
Make sure you can open `https://jira.example.com` in Chrome without being prompted for a password.
:::

---

## 3. Build

The MCP server runs from compiled JavaScript. Always build before connecting:

```bash
npm run build
```

:::caution Rebuild after changes
Every time you modify TypeScript source files, run `npm run build` again.
Claude Code connects to `dist/server.js` — if you don't rebuild, it runs stale code.
:::

---

## 4. Register with Claude Code

The MCP server is already registered if you're working in the `work-intelligence-mcp` directory — the config is stored in `~/.claude.json`. Verify it:

```bash
claude mcp list
# Expected: work-intelligence: node --env-file=... dist/server.js - ✓ Connected
```

If it shows `✗ Failed to connect`, make sure `npm run build` has been run.

If the server is not listed at all, see [MCP Registration](./mcp-registration) to add it manually.

---

## 5. Use It

### Via Claude Code CLI

```bash
cd work-intelligence-mcp
claude
```

Then ask naturally:

```
Show me the BDS active sprint
```

```
What issues are assigned to me in BDS?
```

```
Use get_jira_report with projectKey "BDS" and boardUrl "https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=BDS"
```

### Via CLI script (no Claude, just the report)

```bash
npm run report                        # recent BDS issues (last 2 days)
JIRA_MODE=sprint npm run report       # active sprint
JIRA_MODE=mine npm run report         # issues assigned to you
npm run report > /tmp/bds.md && open /tmp/bds.md   # save and open
```

---

## 6. Run Tests

```bash
npm run test:run     # all unit tests
npm run typecheck    # TypeScript type check
```

---

## Development Mode

```bash
npm run dev          # tsx watch mode — auto-restarts on source changes (for CLI scripts)
npm run typecheck    # zero-error TypeScript check
```

Note: `npm run dev` runs `src/server.ts` directly via `tsx` — useful for testing the server locally, but Claude Code always uses the compiled `dist/server.js`. Run `npm run build` to update what Claude Code sees.

---

## Docs Site

```bash
cd docs && npm install && npm start
# Opens at http://localhost:3000
```
