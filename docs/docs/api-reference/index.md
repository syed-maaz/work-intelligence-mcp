---
sidebar_label: "API Reference"
sidebar_position: 1
---

# Tool & Endpoint Reference

> **Tool surface source of truth:** `src/server.ts` (lines 132+) and `src/tools/manifest.ts`.
> **Last verified:** 2026-05-21 (post Bundles A/B/C + REFACTOR-001 opening pass).

The Work Intelligence MCP exposes its capabilities through three layers:

1. **5 canonical brain MCP tools** — the Unified Brain API (ADR-024)
2. **17 `wi_*` operational tools** — declared once in `src/tools/manifest.ts`, registered by both the MCP server and the OpenClaw plugin (ADR-025)
3. **10 legacy MCP tools** — kept with `[DEPRECATED — use wi_<x>]` prefix; scheduled for removal in Phase 74

Plus the **HTTP bridge** (`web-server.js`) which exposes ~80 REST endpoints that the `wi_*` tools wrap.

All MCP tools communicate via stdio JSON-RPC. All HTTP endpoints accept JSON bodies and return JSON.

---

## 1. Brain tools (canonical, Unified Brain ADR-024)

These five tools form the **stable public surface**. All inputs are JSON-validated; all responses are structured (no free-text parsing).

| Tool | Input | Returns |
|---|---|---|
| `get_context` | `{}` | Current operational context: sprint status, stuck Jiras, noise clusters, calendar events, open investigations, relevant memory, stale-data warnings. TTL-cached (60 s warm, < 100 ms). |
| `get_decision` | `{ question: string, user: string, context?: object }` | `{ decision, rationale, evidence[], confidence, next_actions[], alternatives[] }`. Cached by `cache_key = sha256(normalize(question) ‖ user ‖ utcDayIso())`. First call ~5–25 s; cached < 200 ms. |
| `verify_claim` | `{ claim: string, evidence_needed?: string[] }` | `{ verified: boolean, evidence[], confidence, adapter_results }`. Adapters: `github_api_check`, `jira_status`, `code_grep`, `build_log`. |
| `recall_memory` | `{ query: string, limit?: number }` | Past patterns + outcomes from MemPalace + `brain_decisions`, ranked recency × confidence. |
| `record_outcome` | `{ decision_id: string, outcome: 'success' \| 'failed' \| 'abandoned', notes?: string }` | Confirms the learning loop write. Updates `brain_decisions` + MemoryEnricher decisions wing. |

Example: ask the brain what to work on:

```json
{ "name": "get_decision",
  "arguments": {
    "question": "What should I work on today?",
    "context": { "timezone": "Europe/Berlin" }
  }
}
```

---

## 2. `wi_*` operational tools (ADR-025)

All 17 declared in `src/tools/manifest.ts` (`TOOL_MANIFEST` array). The same file is consumed by `src/server.ts` (MCP) and `src/openclaw/plugin/src/wi-tools.ts` (Atlas) — they register byte-identical descriptions, schemas, and endpoints.

**Tool contract:**
- 2xx → `{ ok: true, data }`
- 4xx/5xx → `{ ok: false, error: { code, message } }`
- Sends header `X-WI-Consumer: atlas|mcp`
- Forwards `?user=<name>` query
- Default timeout 8 s; long-running ops get 30 s (`/api/jira/investigate`, `/api/sync/all`)

| Tool | Wraps | Notes |
|---|---|---|
| `wi_search` | `POST /api/search-all` | Cross-source FTS (Jira + Teams + Email + GitHub) |
| `wi_jira_get` | `/api/jira/issues` · `/my-issues` · `/saturn/issues` · `/board` (discriminated by `kind`) | `kind: 'issues' \| 'my_issues' \| 'saturn' \| 'board'` |
| `wi_jira_stuck` | `GET /api/jira/stuck` | Stuck-ticket detection |
| `wi_jira_analyze` | `POST /api/jira/analyze` · `POST /api/jira/investigate` | 30 s timeout |
| `wi_jira_metrics` | `/api/jira/cycle-time` · `/velocity` · `/learnings` | Post-incident learnings + velocity |
| `wi_brain_context` | `GET /api/brain/context` | Plugin-side parity with `get_context` |
| `wi_brain_learn` | `POST /api/brain/learn` | Plugin-side parity with `record_outcome` |
| `wi_decisions_history` | `GET /api/brain/decisions` | Audit trail — past decisions with rationale (`user`, `since`, `limit`) |
| `wi_pr_list` | `/api/pr/list` · `/watched-summary` · `/review` | List + inspect PRs |
| `wi_pr_create` | `POST /api/pr/create` · `POST /api/pr/post-review` | ⚠ Opens real PRs. `dry_run` safety gate tracked as FEATURE-003 in [known-gaps](../architecture/known-gaps) |
| `wi_action_items` | `/api/action-items` · `/pending-review` | What you owe |
| `wi_topics` | `/api/topics` · `POST /api/topic-expert` · `POST /api/configure-topic` | Topic CRUD + topic expert |
| `wi_teams` | `POST /api/teams-updates` · `/api/teams/chats` · `/meetings/recent` | Teams chat + meeting search |
| `wi_calendar` | `GET /api/calendar/upcoming` | Today's meetings |
| `wi_digest` | `/api/morning-brief` · `/daily-summary` · `/weekly-report` | Briefings |
| `wi_code_graph` | `/api/code-graph/blast-radius` · `/owners` · `/test-coverage` | Multi-repo code intelligence |
| `wi_teammates` | `/api/teammates` · `/teammates/expert` | Subject-matter expert lookup |
| `wi_sync` | `POST /api/sync/all` · `GET /api/sync/status` | Trigger / check sync. 30 s timeout. |

For full Zod schemas, read `src/tools/manifest.ts` directly — that file is the truth. CI parity tests (`tests/openclaw/operational-parity.test.ts`) fail the build on any drift.

---

## 3. Legacy MCP tools (DEPRECATED — use `wi_*` instead)

Kept for backward compatibility. Each carries `[DEPRECATED — use wi_<x>]` in its description.

| Legacy tool | Replacement |
|---|---|
| `search_messages` | `wi_search` |
| `get_action_items` | `wi_action_items` |
| `get_daily_digest` | `wi_digest` |
| `configure_topic` | `wi_topics` |
| `get_jira_report` | `wi_jira_get` |
| `get_teams_updates` | `wi_teams` |
| `search_all` | `wi_search` |
| `ask_topic_expert` | `wi_topics` |
| `get_topic_suggestions` | `wi_topics` |
| `dismiss_topic_suggestion` | `wi_topics` |

Removal scheduled for **Phase 74** once telemetry confirms no external dependents.

---

## 4. HTTP bridge endpoints

The bridge at `localhost:3132` (started by `npm run web:bridge`) exposes ~80 REST endpoints that the `wi_*` tools wrap. The web UI consumes the same surface directly.

**Key endpoint families:**

| Family | Endpoints | Notes |
|---|---|---|
| `/api/brain/*` | `context`, `decide`, **`decide/stream`** (SSE), `verify`, `recall`, `learn`, **`budget`** | Unified Brain (ADR-024). `decide/stream` is the streaming variant (OP-7). `budget` returns daily call + token spend (Bundle C.4). `learn`/`verify`/`recall` are now served from `src/routes/brain.ts` (REFACTOR-001). |
| `/api/jira/*` | `issues`, `my-issues`, `board`, `stuck`, `analyze`, `investigate`, `cycle-time`, `velocity`, `learnings` | Jira intelligence layer |
| `/api/teams/*` | `chats`, `meetings/recent` | + `POST /api/teams-updates` for search |
| `/api/pr/*` | `list`, `watched-summary`, `review`, `create` *(dry_run=true default)*, `post-review` *(dry_run=true default)* | PR intelligence (EP-44, EP-54). Safe-by-default: callers must pass `dry_run: false` explicitly to actually open a PR or post a review. |
| `/api/code-graph/*` | `blast-radius`, `owners`, `test-coverage`, `index` (POST) | Multi-repo code intelligence (EP-43) |
| `/api/teammates*` | `/`, `/expert` | Teammate profiles (EP-45) |
| `/api/calendar/upcoming` | — | Mac Calendar source post-EP-51 |
| `/api/morning-brief` · `/daily-summary` · `/weekly-report` | — | Cached AI summaries; stale responses surface via `<StaleBanner>` (U-14) |
| `/api/action-items` · `/api/pending-review` | — | What you owe |
| `/api/topics` · `/api/topic-expert` · `/api/configure-topic` | — | Topic management |
| **`/api/prompts`** · **`/api/prompts/rollback`** | GET list, POST rollback `{trigger_type, version}` | Self-evolving prompts rollback (Bundle C.2 / A-9). Lists all versions, atomically swaps active. |
| `/api/sync/*` | `all` (POST), `status` (GET) | Manual sync trigger |
| **`/api/agents/health`** + agents block in `/api/system-health` | — | Per-agent isolation registry (OP-5 / A-2). Shows `ready / healthy / flaky / degraded / crashed / disabled`. |
| `/api/status` · `/api/system-health` · `/api/palace/status` | — | Health + diagnostics. Includes `embeddingsAvailable` (EP-62). |
| `/api/events` | — | Server-sent events drain from `proactive_queue` (EP-61, EP-62) |
| `/api/knowledge/ingest` · `/api/knowledge/events` | — | Cross-repo edit ingestion (ADR-018) |

Schema validation: all POST endpoints go through Zod (`src/lib/zod-validators.ts` and per-route schemas). 4xx responses include `{ error: { code, message, details? } }`.

### CORS + auth

- **Allow-list:** only origins listed in `MCP_BRIDGE_ALLOWED_ORIGINS` (default `http://localhost:5175`, `http://127.0.0.1:5175`) receive `Access-Control-Allow-Origin` headers. Any other browser origin gets the response body but no CORS headers, so the browser blocks the script from reading it.
- **Bearer token:** when `MCP_BRIDGE_TOKEN` is set in `.env`, non-allow-listed callers must send `Authorization: Bearer <token>`. The web UI on an allow-listed origin is exempt. When unset, no auth is required (back-compat default). Setting the token is recommended.
- **Preflight:** `OPTIONS` requests get a `204 No Content` with the same CORS headers.

---

## 5. Error handling

| Error | Cause | Fix |
|---|---|---|
| `Redirected to login page` | Jira / Outlook / Teams SSO expired | Open Chrome → visit the site → retry |
| `Executable doesn't exist` | Playwright bundled Chromium missing | `npx playwright install` |
| `NODE_MODULE_VERSION mismatch` | Node version changed since install | `npm rebuild better-sqlite3` |
| `Topic not found` | Topic not configured | `wi_topics` (`configure_topic` legacy) |
| `GitHub skipped: GITHUB_TOKEN not set` | No GitHub creds | Add `GITHUB_API_URL` + `GITHUB_TOKEN` to `.env` |
| `Tool call budget exceeded` | Per-session `wi_*` budget cap | Default 30/session; configurable via `WI_TOOL_BUDGET_MAX` (Phase 72 GUARD-02) |
| `Cache key collision` (should not occur) | Same `(question, user, day)` from two paths | Reach out — `brain_decisions.cache_key` is UNIQUE; collision = bug |

---

## 6. Where to look in code

| Layer | File | Purpose |
|---|---|---|
| Tool registration (MCP) | `src/server.ts` | Authoritative list of all 32 registered tools |
| Tool manifest | `src/tools/manifest.ts` | Single source of truth for the 17 `wi_*` tools |
| Tool handlers (per-tool) | `src/tools/*.ts` | One file per tool's business logic |
| Brain core | `src/services/brain/` | `decision-engine`, `context-builder`, `recall`, `verify`, `learn`, `budget` |
| HTTP routes | `web-server.js` | ~80 REST endpoints (modularization tracked in known-gaps REFACTOR-001) |
| OpenClaw plugin | `src/openclaw/plugin/` | Atlas-side tool registration |

---

## 7. Detailed endpoint references

| Doc | Covers |
|---|---|
| [bugs](./bugs) | ADR-030 Phase A self-healing capture: `POST /api/bugs/report`, `GET /api/bugs`, `GET /api/bugs/:id`, `POST /api/bugs/:id/resolve`, plus the `bugs` block on `/api/system-health`. Schema v53. |

For per-tool schema details, read the manifest. For per-route shape contracts, read the Zod parsers in `web-server.js` or `src/lib/zod-validators.ts`.

---

*The detailed per-tool documentation that previously lived here (for `ask_topic_expert`, `get_jira_report`, `search_all`, etc.) has moved into the tool descriptions themselves (`src/server.ts` lines 132–500) and the manifest. To see exactly what a tool accepts and returns, read its entry in `src/server.ts` or `src/tools/manifest.ts`.*
