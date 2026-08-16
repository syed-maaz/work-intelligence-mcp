# MCP Connector Spec — contributing a new connector

Scope: how to add a new data source (connector) that the Fetcher stage (ADR-044) pulls from, normalizes, and persists into SQLite. Read this before touching `src/fetcher/`, `wi.config.json`, or `.env.example`.

## 1. Overview

A connector is a transport-specific **fetch source**: it talks to one external system (REST API, MCP server, or a real browser), normalizes the result into `UnifiedMessage[]`, and hands it to the FETCH pipeline for dedup + persistence.

```
FETCH → PROCESS → ANALYZE → PROPOSE
   │
   ├── source (REST / MCP / browser)  → adapter (fetch fn) → UnifiedMessage[] → orchestrator → SQLite
   └── everything downstream reads from SQLite (never re-hits the connector)
```

- Data model contract: `src/fetcher/sources/types.ts` (`UnifiedMessage`, `MessageSource`, `ConnectorErrorType`).
- Facade contract: `src/fetcher/types.ts` (`FetchSource`, `FetchStatus`, `FetchProgress`, `DataSource`).
- Orchestrator + isolation: `src/fetcher/orchestrator.ts` (`SourceSpec`, `fetchOneSource`, `fetchStream`).
- Transport is driven by `wi.config.json` → `connectors.<name>.mode`: `api` (REST), `mcp` (HTTP MCP client), `browser` (Chrome profile via `browser-session.ts`). One connector can expose multiple modes. The orchestrator stays mode-agnostic — you only implement the fetch fn.

## 2. Connector anatomy

| Piece | Location | Role |
|---|---|---|
| Source file | `src/fetcher/sources/<name>.ts` | The adapter + fetch logic. Pure module. |
| Message contract | `src/fetcher/sources/types.ts` | Extend `MessageSource` with your source enum member. |
| Facade wiring | `src/fetcher/index.ts` / callers of `fetchStream` | Register a `SourceSpec` for the orchestrator. |

A source file must export:

1. A **fetch function**: `(config?, since?) => Promise<UnifiedMessage[]>` (or adopt the `SourceSpec.fetch` signature `(signal: AbortSignal) => Promise<UnifiedMessage[]>` when wired through the orchestrator).
2. **One `MessageSource` enum member** — add e.g. `Linear = 'linear'` shipped to `src/fetcher/sources/types.ts` and set every returned message's `source` field to it.

`SourceSpec` shape (see `src/fetcher/orchestrator.ts`):

```ts
export interface SourceSpec {
  source: FetchSource;                    // must also be a MessageSource
  fetch: (signal: AbortSignal) => Promise<UnifiedMessage[]>;
  release?: () => Promise<void> | void;   // free browser slot / lock on timeout
  timeoutMs: number;                      // per-source timeout
}
```

## 3. Config contract

### `wi.config.json` → `connectors.<name>`

```json
"connectors": {
  "linear": {
    "enabled": false,
    "mode": "api",
    "api": { "apiKeyEnvVar": "LINEAR_API_KEY" }
  }
}
```

- `enabled` (bool, default `false`) — global kill switch. Nothing fetches until this flips on.
- `mode` — `api` | `mcp` | `browser` (| `graph` for MS Graph-backed connectors). Pick per transport.
- Token entry points are declared as **env var names, not values**: `tokenEnvVar`, `apiKeyEnvVar`, `teamIdEnvVar`, etc. The `wi-config.ts` accessor reads `process.env[name]` at call time. This lets deployers rename env vars without code changes.
- The JSON schema lives in `wi.config.schema.json` (validates `wi.config.json`). The **capabilities manifest** lives in root `capabilities.json` — per-connector `modes`, `capabilities`, `config.requiredEnv`, `dataIngested` — and is consumed by `src/services/connector-registry.ts` (`getCapabilitiesManifest`, `getConnectorStatuses`) to drive the `/api/connectors` surface. Add your connector to all three: `wi.config.json`, `wi.config.schema.json`, `capabilities.json` (+ the `ConnectorsConfig` interface in `src/services/wi-config.ts`).

### Env var naming convention

`<NAME>_TOKEN` for auth secrets (e.g. `SLACK_TOKEN`, `LINEAR_API_KEY`), `<NAME>_DOMAIN`/`<NAME>_URL` for endpoints, and reuse the shared browser vars (`BROWSER_PROFILE_PATH`, `BROWSER_HEADLESS`) for browser mode. Add your entries to `.env.example` with a `# Optional — <Name>` comment and an inline example.

## 4. Data model

Every record normalized into `UnifiedMessage` (`src/fetcher/sources/types.ts`); persisted rows land in `messages` via `upsertMessage` (`src/db/queries/messages.ts`).

Relevant fields:

- `id` — **source-unique** dedup key. Format `<source>-<natural key>`, e.g. `github-pr-<repo>-<num>`. Stable across sync runs.
- `source` — your `MessageSource` member.
- `subject` — title/headline; nullable.
- `content` — normalized body (HTML/text). Empty string OK.
- `sender: { id, name, email? }` — mapped to `messages.author` on persist.
- `timestamp` / `createdAt` — written to `messages.timestamp` (ISO).
- `channel`/`conversationId` + `metadata` — optional per-source payload, stored JSON-encoded in `messages.metadata` / `raw_data`.

**Dedup** is `(source, source_id)`: `upsertMessage` does `INSERT OR IGNORE` (keeps existing row id so `action_items.source_message_id` links never dangle) then a separate `UPDATE` refreshes mutable fields (content/metadata/raw). Keep `id` stable across fetches or every sync duplicates rows.

## 5. Error isolation rules

The orchestrator's "one slow source must not sink the call" contract (`fetchOneSource`, `src/fetcher/orchestrator.ts`) is mandatory:

1. **30s timeout via AbortController** — accept an `AbortSignal`, honor it (or the orchestrator races/aborts you and emits a `timed_out` envelope). `timeoutMs` is a `SourceSpec` field.
2. **Never throw to the caller.** Any upstream failure → `console.warn('[<Name>] …')` and return `[]`. The `Promise.race` treats a rejection as `error`, but the aggregate never rejects; per-row persist is also best-effort (`try/catch`).
3. **Cleanup** — if you held a browser pool slot or lock, expose `release()` so abort frees it (see the leak-guard note in `orchestrator.ts`).
4. **No new npm deps** — pure `fetch()` (Node 20+ global). A new dependency requires justification in the PR (browser mode ALREADY uses the existing Playwright pool).

## 6. Example walkthrough (Slack, token-REST connector)

`src/fetcher/sources/slack.ts` is the canonical REST-token example (mirrors the older `github.ts`). Steps a new connector should copy:

1. Export a fetch/class taking `{ token?, teamId?, limit?, channel? }` — falling back to `SLACK_TOKEN` / `SLACK_TEAM_ID` env.
2. `slackGet()` does a bounded `fetch()` — `AbortController` + `setTimeout` (default `30_000`), throws on network/timeout/non-ok; the caller isolates via `try/catch`.
3. Guard errors: `console.warn` + return `[]` — never throw into the orchestrator.
4. Map each raw record to `UnifiedMessage` with a **stable dedup id** (`channel_id:ts`) and `source: MessageSource.Slack`.

If your connector is browser-driven instead, reuse `src/fetcher/sources/browser-session.ts` (shared Chrome slot pool) rather than launching your own Playwright.

## 7. Checklist for a new connector

- [ ] `MessageSource` enum member added in `src/fetcher/sources/types.ts`.
- [ ] Source file at `src/fetcher/sources/<name>.ts` exporting a fetch fn → `UnifiedMessage[]`.
- [ ] Config entry in `wi.config.json` — `connectors.<name>` block with `enabled: false` by default.
- [ ] Type for the connector added to `ConnectorsConfig` in `src/services/wi-config.ts` (`src/fetcher/types.ts` is left alone unless the enum changes).
- [ ] Schema/capabilities declaration added to `wi.config.schema.json` + a `capabilities.json` manifest entry (`modes`, `capabilities`, `config.requiredEnv`) — consumed by `src/services/connector-registry.ts`.
- [ ] Env var entries added to `.env.example` (`<NAME>_TOKEN` etc.) + documented in `CONNECTORS.md` connector table.
- [ ] Registry wiring: a `SourceFetcher` `Spec` built from config in the FETCH caller so sync orchestrates it (see `src/fetcher/index.ts` / `adapter` registration).
- [ ] Smoke test proves the isolation contract (timeout → `timed_out`, upstream 500 → `[]`, dedup on source_id runs twice yields no dupes).
- [ ] Docs updated: this spec's checklist bar, `CONNECTORS.md` connector table, `GETTING-STARTED.md` no /company refs anywhere in connector surface.
- [ ] `npm run typecheck && npm run build` clean, web (`cd web && npm run build`) compiles if the connector touches the UI registry.