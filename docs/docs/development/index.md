---
sidebar_label: "Development Guide"
sidebar_position: 1
---

# Development Guide

Guide for contributors and agents working on the Work Intelligence MCP project.

## Prerequisites

- **Node.js** 20.x or higher
- **npm** 10.x or higher
- **TypeScript** 5.7 (installed via `npm install`)
- **Claude Desktop** (for manual integration testing)

## Project Setup

```bash
# Install dependencies
npm install

# Type check (zero errors expected)
npm run typecheck

# Build to dist/
npm run build

# Start in dev mode (watch + auto-restart)
npm run dev
```

## Project Structure

```
src/
├── server.ts                  # MCP server entry point — 4 tools registered here
├── tools/
│   ├── configure-topic.ts     # configure_topic handler
│   ├── search-messages.ts     # search_messages handler + SQL
│   ├── action-items.ts        # get_action_items handler + SQL
│   └── digest.ts              # get_daily_digest handler
├── services/
│   ├── analyzer.ts            # AIAnalyzer — Claude API calls
│   ├── sync.ts                # SyncService + DataSource interface
│   └── config.ts              # ConfigService
├── connectors/
│   ├── types.ts               # Shared types (UnifiedMessage, DataSource, ConnectorError)
│   ├── browser-session.ts     # [EP-1] Playwright browser manager (TODO)
│   ├── teams-browser.ts       # [EP-2] Teams scraper (TODO)
│   ├── outlook-browser.ts     # [EP-3] Outlook scraper (TODO)
│   ├── jira.ts                # Jira REST API connector
│   ├── teams.ts               # DEAD — Graph API (to be deleted in EP-9)
│   ├── email.ts               # DEAD — Graph API (to be deleted in EP-9)
│   └── graph-auth.ts          # DEAD — Azure OAuth (to be deleted in EP-9)
└── db/
    ├── schema.ts              # SQLite schema + migration runner
    ├── connection.ts          # DB init + singleton
    └── queries.ts             # [EP-7] upsertMessage, getSyncState (TODO)
```

## Definition of Done

Before marking any ticket as complete:

1. `npm run typecheck` — zero errors
2. `npm run lint` — zero warnings
3. `npm test` — all tests pass (when tests exist for the ticket)
4. All acceptance criteria checkboxes in the epic page checked
5. No files modified outside the epic's file scope
6. No untyped `any` without an explanatory comment
7. `UnifiedMessage` shape and `DataSource` interface unchanged

## Component Ownership Map

Agents must not modify files outside their epic scope:

| Epic | Files In Scope |
|------|---------------|
| EP-1 | `src/connectors/browser-session.ts` (new) |
| EP-2 | `src/connectors/teams-browser.ts` (new) |
| EP-3 | `src/connectors/outlook-browser.ts` (new) |
| EP-4 | `src/connectors/jira.ts`, `src/services/sync.ts` (additive) |
| EP-5 | `src/services/sync.ts`, `src/server.ts` |
| EP-6 | `src/services/analyzer.ts` |
| EP-7 | `src/db/schema.ts`, `src/db/queries.ts` (new) |
| EP-8 | `src/tests/**` (new), `package.json` (devDeps + scripts) |
| EP-9 | `src/connectors/teams.ts`, `email.ts`, `graph-auth.ts` (delete) |

## Key Conventions

### Types: Always import from `types.ts`

All connectors share types from `src/connectors/types.ts`. Never redefine `UnifiedMessage`, `ConnectorError`, `DataSource`, etc.

```typescript
import {
  UnifiedMessage, MessageSource,
  ConnectorError, ConnectorErrorType,
  RateLimitConfig
} from './types.js';
```

### Connectors: Never touch the DB

Connectors return `UnifiedMessage[]`. They do not import from `src/db/**`. The sync pipeline writes to DB.

### Error mapping

Browser connectors must map errors to `ConnectorError`:

```typescript
// Login redirect detected
throw new ConnectorError('Session expired', ConnectorErrorType.Authentication);

// Navigation timeout
throw new ConnectorError('Page timeout', ConnectorErrorType.Network);
```

### source_id: Stable identifiers

Every `UnifiedMessage` needs a `source_id` that is stable across calls for the same message. Preferred strategy:

1. Use a DOM `data-*` attribute (Teams message ID, email internet-message-id)
2. Fallback: `crypto.createHash('sha256').update(sender + timestamp + content.slice(0, 50)).digest('hex')`

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | — | Claude API (required) |
| `DATABASE_PATH` | `~/.work-intelligence-mcp/data.db` | SQLite file location |
| `SYNC_INTERVAL_MS` | `900000` (15 min) | Sync frequency |
| `BROWSER_PROFILE_PATH` | — | Chrome user data directory for SSO |
| `BROWSER_HEADLESS` | `true` | Run browser headlessly |
| `BROWSER_EXECUTABLE` | system Chrome | Path to Chrome binary |
| `JIRA_DOMAIN` | — | e.g. `company.atlassian.net` |
| `JIRA_EMAIL` | — | Your Jira account email |
| `JIRA_API_TOKEN` | — | Jira personal API token |

## Testing

Tests live in `src/tests/` (added in EP-8). Until EP-8 is complete, run:

```bash
npm run typecheck   # Verify types
npm run build       # Verify compilation
```

When EP-8 is done:
```bash
npm test            # Run all tests
npm run test:watch  # Watch mode
```

## Debugging the MCP Server

To debug with Claude Desktop:

1. Build: `npm run build`
2. Add `--inspect` to the node args in `claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "work-intelligence": {
         "command": "node",
         "args": ["--inspect", "/path/to/dist/server.js"]
       }
     }
   }
   ```
3. Open `chrome://inspect` → "Open dedicated DevTools for Node"

View MCP server logs:
```bash
# macOS
tail -f ~/Library/Logs/Claude/mcp-server-work-intelligence.log
```

## Adding a New MCP Tool

1. Create `src/tools/my-tool.ts` — implement handler and export tool definition
2. Register in `src/server.ts` — add to `ListToolsRequestSchema` handler and `CallToolRequestSchema` switch
3. Write unit test in `src/tests/my-tool.test.ts`
4. Add to the API Reference docs

## Adding a New Data Source

The extraction boundary is the `DataSource` interface in `src/services/sync.ts`:

```typescript
interface DataSource {
  fetchMessages(config: Record<string, unknown>, since?: Date): Promise<UnifiedMessage[]>;
}
```

Any class that implements this interface can be registered in `SyncService`. In the future, it can be extracted into its own MCP server without changing the DB or tools layer — see [ADR-002](../adr/adr-002-single-server).

Steps:
1. Create connector file in `src/connectors/`
2. Implement `DataSource`
3. Register in `SyncService` (EP-5 wires all connectors)

## VS Code Setup

Recommended extensions: `dbaeumer.vscode-eslint`, `esbenp.prettier-vscode`, `ms-vscode.vscode-typescript-next`

`.vscode/settings.json`:
```json
{
  "editor.formatOnSave": true,
  "typescript.tsdk": "node_modules/typescript/lib"
}
```
