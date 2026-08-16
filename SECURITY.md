# Security

## Security posture

Work Intelligence (WI) is a **local-first personal server**. By design:

- All data lives in a local SQLite database and local files on your machine. There is no cloud sync, no telemetry, and no third-party ingestion of your work data beyond the connectors you explicitly enable.
- The bridge HTTP server binds to localhost by default and is intended for local use (Claude Code, the web UI, Atlas/menubar clients on the same machine).
- Connectors are **disabled by default** (`wi.config.json` → `connectors.*.enabled: false`). Nothing is fetched until you turn it on.

This means the server is not a network service and has no multi-tenant attack surface. The main risks are the ones you would expect from a personal developer tool: leaked credentials in version control, path-escape bugs in agent write operations, and accidentally exposed bridge ports.

## Secret handling

- `.env` is gitignored. Secrets live in environment variables, not in the repo.
- `.env.example` contains placeholder values only (`sk-ant-...`, empty strings) — it is safe to commit.
- Connector tokens and API keys are read from environment variables at runtime, never hardcoded:
  - `ANTHROPIC_API_KEY` — LLM provider key (required)
  - `JIRA_MCP_TOKEN`, `JIRA_API_TOKEN` — Jira
  - `GITHUB_TOKEN`, `GITHUB_MCP_TOKEN` — GitHub
  - `SLACK_TOKEN` — Slack
  - `LINEAR_API_KEY` — Linear
  - `AZURE_CLIENT_SECRET` (with `AZURE_TENANT_ID` / `AZURE_CLIENT_ID`) — Teams/Outlook Graph access
  - `MCP_BRIDGE_TOKEN` — optional bearer token for the bridge API
- Which env var a connector reads is itself config-driven: `wi.config.json` points each connector at its token env var name (`tokenEnvVar`), so you can rename/rotate secrets without code changes.
- Never commit `.env`, generated tokens, session cookies, or response bodies that contain secrets. Log lines and temp files from agent runs should be treated as potentially sensitive.

## Path safety (agent write operations)

The Cypher agent loop and the bug-resolver agent can write files. Every target path is classified before any write, commit, or push:

| Category | Meaning | Write | Commit | Push |
|---|---|---|---|---|
| `ALLOWED` | Inside the WI repo root | OK | OK | confirm |
| `CONFIRM_REQUIRED` | Inside a customer repo listed in `wi.config.json` → `repos[]` | confirm | confirm | confirm |
| `BLOCKED` | Anywhere else (system paths, `~/Desktop`, `/tmp`, sibling clones) | refused | refused | refused |

- Paths in the `BLOCKED` category are refused outright — the agent never even asks.
- Paths in customer repos require explicit user confirmation per action.
- `push` always requires confirmation, even inside the WI repo — outbound publication is never automatic.

The classifier is `src/services/cypher/path-classifier.ts`; the bug-resolver has an equivalent fence (`src/services/bugs/path-classifier.ts`). The customer-repo allowlist comes from `wi.config.json`, so it is part of your config, not hardcoded.

## Database

- Storage is a local SQLite file (`DATABASE_PATH`, default `./data/intelligence.db`), opened by the server process only.
- The database is not network-exposed and has no remote access path.
- MemPalace (the memory/embeddings store) is a local directory (`MEMPALACE_PATH`).

## Bridge API

- The bridge binds to `localhost` and runs on the port configured in `wi.config.json` → `bridge.port` (default 3132).
- CORS is allow-listed via `MCP_BRIDGE_ALLOWED_ORIGINS` (default: the local Vite dev-server origins). Origins outside the list get no CORS headers, so browsers block the response.
- Setting `MCP_BRIDGE_TOKEN` requires a bearer token on all requests except OPTIONS and same-origin requests from allow-listed origins. Recommended once you are stable.

## Reporting vulnerabilities

This is a personal project; there is no paid bug bounty program. To report a vulnerability:

- Open a GitHub issue on the repository (prefer not to include live secrets or credentials in the report — redact them, or email the maintainer directly).
- Contact: `<maintainer email — set before release>`

Include: the affected version/commit, a minimal reproduction, and the impact you observed. Reports are handled on a best-effort basis.
