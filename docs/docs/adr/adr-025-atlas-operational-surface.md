---
sidebar_label: "ADR-025: Atlas Operational Surface"
sidebar_position: 25
---

# ADR-025: Atlas Operational Surface

**Status**: Accepted — Shipped 2026-05-20
**Date**: 2026-05-18
**Deciders**: Maaz
**Epics**: EP-72 (proposed)
**Supersedes**: —

**Traceability**:
- Predecessor ADRs: [ADR-023 OpenClaw Plugin](./adr-023-openclaw-plugin.md), [ADR-024 Unified Brain](./adr-024-unified-brain.md)
- Branch: `PROJ-15257-fix-context-links-knowledge-migration` — current planning branch
- Driving conversation: 2026-05-18 — *"OpenClaw should be able to perform [the same] task[s with] help of work intelligence mcp or endpoints"*
- Plugin source: `src/openclaw/plugin/src/wi-tools.ts` (today: 3 brain tools — `wi_decide`, `wi_verify`, `wi_recall`)
- MCP server: `src/server.ts` (today: 15 tools — 5 brain (`get_context`, `get_decision`, `verify_claim`, `recall_memory`, `record_outcome`) + 10 pre-existing operational (`search_messages`, `get_action_items`, `get_daily_digest`, `configure_topic`, `get_jira_report`, `get_teams_updates`, `search_all`, `ask_topic_expert`, `get_topic_suggestions`, `dismiss_topic_suggestion`))
- Bridge: `web-server.js` (today: ~80 REST endpoints; OpenClaw plugin reaches 3 of them, MCP server reaches ~15)

---

## Context

ADR-023 shipped the OpenClaw plugin (Phase 68). ADR-024 shipped the Unified Brain API (Phases 69–71, completed 2026-05-18). The current MCP/plugin surface is **uneven** across the two consumer layers:

- **OpenClaw plugin** (`wi-tools.ts`) — 3 tools: `wi_decide`, `wi_verify`, `wi_recall` (brain only).
- **MCP server** (`src/server.ts`) — 15 tools: the 5 brain tools (`get_context`, `get_decision`, `verify_claim`, `recall_memory`, `record_outcome`) plus 10 operational tools that pre-date ADR-024 (`search_messages`, `get_action_items`, `get_daily_digest`, `configure_topic`, `get_jira_report`, `get_teams_updates`, `search_all`, `ask_topic_expert`, `get_topic_suggestions`, `dismiss_topic_suggestion`).

The Web UI calls **~80 endpoints**. The OpenClaw plugin reaches 3 (~4%); the MCP server reaches ~15 (~19%). The two layers expose **different tools under different names**. Concretely, this means Atlas can reason about a decision but cannot *act on the underlying data*:

- Atlas can ask "should we ship?" but cannot list open PRs.
- Atlas can verify a claim against Jira but cannot show the user which tickets are stuck.
- Atlas can recall prior decisions but cannot pull the morning brief that frames today's context.
- Every operational ask routes the user back to the Web UI, breaking the agent flow.
- A user moving between Claude Code (MCP) and OpenClaw (plugin) sees two different tool inventories with two different naming conventions.

This is not a feature gap in the bridge — every endpoint already exists, has tests, and is consumed by the UI. The gap is in **MCP tool surface**: thin tool wrappers around endpoints that already work, registered consistently across both consumer layers. Without them, OpenClaw cannot keep pace with the UI as a daily driver, and the Atlas persona collapses back into a "smart chat" instead of a working operational agent.

> **Atlas** is the OpenClaw chat persona introduced in ADR-023. References to "Atlas" in this ADR mean the user-facing agent that calls these tools.

The Four-Stage Pipeline (`fetch → process → analyze → propose`) is preserved: tool wrappers live in **Propose**, calling existing endpoints that already span the prior three stages. No new business logic, no new sync paths.

---

## Decision

Expose the Web UI's operational surface to OpenClaw and MCP clients as **15 thin operational tool wrappers** over existing bridge endpoints, plus **lift the OpenClaw plugin's brain-tool coverage from 3 to 5** to match the MCP server. Tools live in two layers that already exist:

1. `src/openclaw/plugin/src/wi-tools.ts` — Atlas plugin tools (slash commands + LLM tool calls)
2. `src/server.ts` — MCP server tools (consumed by Claude Code, OpenClaw, future MCP clients)

Both layers register the **same tools** under the **same names** going forward: `wi_<verb>_<object>`. See *Naming compatibility* below for how this reconciles with existing MCP tool names.

**Why 15 operational tools, not more or fewer**: 15 tools cover every Web UI surface a user invokes manually in a typical day (search, list, analyze, brief, mutate). Going lower forces tool fan-out via free-form parameters (rejected — see *Alternatives Considered #2*). Going higher tracks endpoint count, not user intent — multiple endpoints fold into one tool with a `kind` discriminator (e.g. `wi_jira_get` covers 4 endpoints; see *Tool Contract* for the schema pattern). The cap is set in T-72-01.

No tool contains business logic. Each tool is:

```ts
{
  name: "wi_<x>",
  description: "...",
  inputSchema: zod schema,
  handler: async (input) => fetch(`${WI_BRIDGE_URL}/api/<endpoint>`, {...}).json()
}
```

This is the same pattern as the existing 3 Atlas plugin tools. ADR-025 is a **scale-out** of an already-validated pattern, not a new architecture.

### Naming compatibility (cross-layer rename)

The MCP server's 10 pre-existing operational tools (`search_messages`, `get_jira_report`, `search_all`, `ask_topic_expert`, etc.) collide functionally with several of the new 15 (`wi_search`, `wi_jira_get`, `wi_topics`). Rather than maintain two parallel names per capability, Phase 72 takes the following approach:

- **Pre-existing MCP tools are kept** under their current names through Phase 72 to avoid breaking external Claude Code clients that may already invoke them.
- **New `wi_*` tools are registered alongside** them on the MCP server and wrap the same endpoints. Both names work; the `wi_*` names are the recommended forward path.
- **Deprecation window**: pre-existing names get a `description` prefix `[DEPRECATED — use wi_<x>]` added in Plan 72-05. Removal is deferred to Phase 74 (post-v1.1) once telemetry confirms no external clients depend on them.
- **OpenClaw plugin** registers only the `wi_*` names — no compatibility burden, since the plugin only ever shipped 3 tools.

---

## The 15 Tools

Tools are grouped by domain. Each row lists the tool name, the bridge endpoint it wraps, and the operational capability it unlocks for Atlas.

### Search & Discovery

| Tool | Endpoint | Capability |
|---|---|---|
| `wi_search` | `POST /api/search-all` | Cross-source search (Jira + Teams + Email + GitHub) |

### Jira

| Tool | Endpoint(s) | Capability |
|---|---|---|
| `wi_jira_get` | `GET /api/jira/issues`, `/my-issues`, `/saturn/issues`, `/board` | List tickets by filter |
| `wi_jira_stuck` | `GET /api/jira/stuck` | Identify stuck tickets and reasons |
| `wi_jira_analyze` | `POST /api/jira/analyze`, `POST /api/jira/investigate` | Analyze or investigate a single ticket |
| `wi_jira_metrics` | `GET /api/jira/cycle-time`, `/velocity`, `/learnings` | Team metrics + post-incident learnings |

### Pull Requests

| Tool | Endpoint(s) | Capability |
|---|---|---|
| `wi_pr_list` | `GET /api/pr/list`, `/watched-summary`, `/review` | List/inspect open and watched PRs |
| `wi_pr_create` | `POST /api/pr/create`, `POST /api/pr/post-review` | Open a PR or post a review |

### Action Items & Topics

| Tool | Endpoint(s) | Capability |
|---|---|---|
| `wi_action_items` | `GET /api/action-items`, `/pending-review` | What does the user owe |
| `wi_topics` | `GET /api/topics`, `POST /api/topic-expert`, `POST /api/configure-topic` | Topic ops + ask-topic-expert |

### Communication & Calendar

| Tool | Endpoint(s) | Capability |
|---|---|---|
| `wi_teams` | `POST /api/teams-updates`, `GET /api/teams/chats`, `/meetings/recent` | Teams chat + meeting search |
| `wi_calendar` | `GET /api/calendar/upcoming` | Today's meetings |

### Briefings

| Tool | Endpoint(s) | Capability |
|---|---|---|
| `wi_digest` | `GET /api/morning-brief`, `/daily-summary`, `/weekly-report` | Brief the user |

### Code Intelligence

| Tool | Endpoint(s) | Capability |
|---|---|---|
| `wi_code_graph` | `GET /api/code-graph/blast-radius`, `/owners`, `/test-coverage` | Blast radius / owners / coverage |

### People & Sync

| Tool | Endpoint(s) | Capability |
|---|---|---|
| `wi_teammates` | `GET /api/teammates`, `/teammates/expert` | Find subject-matter experts |
| `wi_sync` | `POST /api/sync/all`, `GET /api/sync/status` | Trigger or check sync |

**Tool count after Phase 72**:
- **OpenClaw plugin**: 3 brain tools today → 5 brain tools + 15 operational = **20 tools** (lift coverage from 3 to 20).
- **MCP server**: 15 tools today (5 brain + 10 legacy operational) → 5 brain + 15 new `wi_*` operational + 10 legacy (deprecated) = **30 names registered**, collapsing to **20 canonical** once the 10 legacy names are retired in Phase 74.
- **End state (post-Phase 74)**: both layers register the same 20 tools under the same `wi_*` names.

---

## Architecture

```
┌──────────────────────┐    ┌──────────────────────┐
│  Web UI              │    │  OpenClaw / Atlas    │
│  (web/src/...)       │    │  (.openclaw/...)     │
│                      │    │                      │
│  fetch(/api/X)       │    │  wi_X tool call      │
└────────┬─────────────┘    └────────┬─────────────┘
         │                           │
         │                           ▼
         │                ┌──────────────────────┐
         │                │  wi-tools.ts (Atlas) │
         │                │  + src/server.ts MCP │
         │                │  thin wrappers       │
         │                └────────┬─────────────┘
         │                         │
         ▼                         ▼
   ┌──────────────────────────────────────────┐
   │   web-server.js (bridge — port 3132)     │
   │   ~80 REST endpoints, single source      │
   │   of truth                               │
   └──────────────────────────────────────────┘
                      │
                      ▼
            SQLite + Palace + connectors
```

**Key property**: the bridge is the single integration surface. UI and OpenClaw are peer clients — neither owns logic the other lacks.

---

## Tool Contract

Every tool follows this exact shape. The contract is locked so Atlas can rely on it without per-tool prompt engineering.

```ts
{
  name: string,                        // "wi_<verb>_<object>"
  description: string,                 // 1–2 sentences, describes when to call
  inputSchema: ZodSchema,              // strict; required fields explicit
  handler: async (input) => Promise<{
    ok: boolean,
    data?: unknown,                    // endpoint response on 2xx
    error?: { code: string, message: string },  // on 4xx/5xx
  }>
}
```

**Consumer identity**: tools set header `X-WI-Consumer: atlas` (or `mcp` when invoked via MCP server). Today only `/api/brain/decide` and `/api/brain/context` read this header (`web-server.js:2002`, `web-server.js:2044`); the remaining bridge endpoints accept it harmlessly. Phase 72 plan 72-04 audits which of the 15 wrapped endpoints need to start honoring it for budget/audit purposes.

**User identity**: today the bridge derives user from `?user=` query param with fallback to the consumer string. Tools forward it as `?user=<name>` on every call:

- **OpenClaw plugin** — reads from the active OpenClaw session (already known on every slash command / tool call).
- **MCP server** — reads from `WI_DEFAULT_USER` environment variable on startup (single-user assumption matches Claude Code today). If unset, falls back to the consumer string `mcp` and the bridge returns `?user=mcp` rows. Multi-user MCP is out of scope (see *Out of scope*).
- **No new header is introduced** — this matches the existing UI behavior.

**Error mapping**: HTTP 4xx/5xx → `{ ok: false, error: { code, message } }`. Atlas sees a structured error and can plan a retry or hand off to the user.

**Timeouts**: 8s default per tool, configurable via `WI_TOOL_TIMEOUT_MS`. Long-running endpoints (`/api/jira/investigate`, `/api/sync/all`) get 30s.

**`kind` discriminator pattern** (used by `wi_jira_get`, `wi_pr_list`, `wi_digest`, `wi_jira_metrics`, `wi_topics`, `wi_teams`, `wi_code_graph`): when one tool fronts multiple endpoints, the schema requires a `kind` literal that picks the endpoint at runtime. Example:

```ts
// wi_jira_get
inputSchema: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("issues"),       jql: z.string() }),
  z.object({ kind: z.literal("my_issues"),    user: z.string().optional() }),
  z.object({ kind: z.literal("saturn"),       sprint: z.string().optional() }),
  z.object({ kind: z.literal("board"),        boardId: z.number() }),
])

// handler routes on `input.kind` to /api/jira/{issues|my-issues|saturn/issues|board}
```

This keeps each tool's surface narrow, preserves type-safe LLM tool descriptions, and contains endpoint growth without inflating the tool list (T-72-01).

---

## Implementation

A single phase, single wave, one executor. Mechanical scale-out — no design decisions to make per-tool.

### Phase 72 — Atlas Operational Surface (proposed, ~2 days)

| Plan | Tools shipped | Files modified |
|---|---|---|
| 72-01 | `wi_search`, `wi_jira_get`, `wi_jira_stuck`, `wi_jira_analyze`, `wi_jira_metrics`, `wi_brain_context`, `wi_brain_learn` + tool manifest scaffold | `src/tools/manifest.ts` (new), `src/openclaw/plugin/src/wi-tools.ts`, `src/server.ts` |
| 72-02 | `wi_pr_list`, `wi_pr_create`, `wi_action_items`, `wi_topics` | `src/tools/manifest.ts`, `wi-tools.ts`, `src/server.ts` |
| 72-03 | `wi_teams`, `wi_calendar`, `wi_digest`, `wi_code_graph`, `wi_teammates`, `wi_sync` | same |
| 72-04 | Parity test suite — every tool round-trips through bridge; response shape locked in CI | `tests/openclaw/operational-parity.test.ts` |
| 72-05 | Guardrails — per-session tool-call budget (v46 migration + ledger reuse), plugin version handshake, legacy MCP description prefix `[DEPRECATED — use wi_<x>]` | `src/db/migrations/v46_*.ts`, `src/services/brain/budget.ts`, `src/openclaw/plugin/src/wi-tools.ts`, `src/server.ts` |

**No new endpoints. No new tables.** One additive schema delta only — migration v46 appends a nullable `bucket TEXT` column to `brain_user_budget_ledger` (default `'brain'`, see T-72-02). No backfill, no data migration; pre-existing rows keep their implicit `bucket='brain'` semantics.

Each plan is ~5–6 tool wrappers. A single executor agent can ship all of them in 1–2 days because each tool is ~30 LOC of glue.

### Definition of Done (per tool)

1. Zod schema accepts the documented input
2. Handler calls the documented endpoint and returns `{ok, data}` or `{ok:false, error}`
3. Atlas can call it as a slash command (`/wi_jira_stuck`) and as an LLM tool call
4. MCP server exposes it under the same name
5. Round-trip parity test passes (see definition below)
6. README in `src/openclaw/plugin/` lists the new tool with one usage example

### Round-trip parity (Plan 72-04 definition)

A tool is "parity-passing" when, given the same input, the bridge response shape matches the schema declared in the tool's manifest entry — verified by:

1. Zod `parse` on the response succeeds (no extra fields, no missing required fields).
2. The set of top-level keys in the response equals the set declared in the manifest's `outputSchema` (logged on mismatch — CI fails).
3. HTTP 4xx/5xx maps cleanly to `{ ok: false, error: { code, message } }` with `code` matching one of the documented error codes for that endpoint.

**Not** in scope for parity: response *contents* (data values), latency, ordering. Those are endpoint-level concerns, not tool-wrapper concerns.

---

## Existing Surface Mapped (Do Not Duplicate)

| Existing | Why we are not changing it |
|---|---|
| `/api/brain/*` (5 endpoints) | Already shipped (ADR-024). MCP server already registers 5 brain tools (`get_context`, `get_decision`, `verify_claim`, `recall_memory`, `record_outcome`). OpenClaw plugin registers 3 today (`wi_decide`, `wi_verify`, `wi_recall`); Phase 72 adds the missing 2 (`wi_brain_context`, `wi_brain_learn`) so plugin parity matches MCP. No brain endpoint logic is touched. |
| Web UI pages | Stay as the rich-rendering view layer. No UI logic moves into tools. |
| AIAnalyzer | Brain endpoints already mediate AI calls. Tools never call the analyzer directly. |
| Sync loop | Tools call `POST /api/sync/all`; they do not implement sync. |

---

## Threats

| ID | Threat | Mitigation |
|---|---|---|
| T-72-01 | Tool count explosion as endpoints grow | Cap at 20 tools; new endpoints must justify a tool *or* fold into an existing one (e.g. add a `kind` parameter to `wi_jira_get` rather than ship `wi_jira_get_my_issues`). Reviewed each phase. |
| T-72-02 | Atlas chains tools into expensive sequences (e.g. `wi_search` → 50× `wi_jira_get`) | Per-session tool-call budget enforced in `wi-tools.ts` (default 30 calls/session, configurable). Reuses the existing `brain_user_budget_ledger` table by namespacing rows under a new `bucket` column value `tool_calls` (existing rows are implicit `bucket='brain'`). Migration v46 adds a single nullable `bucket TEXT` column with default `'brain'` and one composite index `(user, day_iso, bucket)`. No new table. |
| T-72-03 | Bridge endpoint changes break tool contracts silently | Parity test (Plan 72-04) round-trips every tool; CI fails on shape drift. Mirror of ADR-024's T-70-01 mitigation. |
| T-72-04 | Tool descriptions drift from endpoint behavior | Description text is generated from a single source: `src/tools/manifest.ts` (top-level, importable by both `src/server.ts` and `src/openclaw/plugin/src/wi-tools.ts`). Plugin re-exports via the bundled artifact already shipped with the OpenClaw plugin — no new build step. |
| T-72-05 | Stale OpenClaw plugin (user runs old `wi-tools.ts`) | Plugin version check on startup; Atlas warns if `wi_tools_version < bridge_min_required`. |

---

## Alternatives Considered

1. **Move all UI logic into OpenClaw** — Rejected. Web UI's value is rich rendering (graphs, tables, inline cards). Chat-only UX is wrong for those flows.
2. **One mega-tool `wi_call(endpoint, params)`** — Rejected. Loses type safety, makes tool descriptions useless to the LLM, and turns Atlas into a thin shell over `curl`. The whole point of MCP is structured, named capabilities.
3. **Generate tools from an OpenAPI spec** — Deferred. The bridge has no OpenAPI spec today. Authoring one is its own project (~3 days). For 15 tools, hand-written wrappers are faster and produce better descriptions for the LLM. Revisit at >30 tools.
4. **Push everything through `/api/brain/decide`** — Rejected. `/decide` is for *judgments*, not lookups. Routing `wi_jira_stuck` through it would hallucinate when the answer is just a SQL query.

---

## Consequences

**Positive**:

- Atlas reaches operational parity with the Web UI for read-heavy and common-mutation flows.
- The bridge stays the single integration surface — no logic creep into clients.
- New endpoints can be exposed to Atlas with ~30 LOC, not a new ADR.
- Web UI and OpenClaw stay testable in isolation but converge on the same data.
- ADR-024's brain stays the *reasoning* layer; ADR-025's tools become the *action* layer. The split is clean.

**Negative**:

- 15 new tools to maintain. Mitigated by the manifest pattern (T-72-04) and parity tests (T-72-03).
- Atlas has more rope: a poorly-prompted session could chain tools wastefully. Mitigated by per-session budget (T-72-02).
- OpenClaw plugin updates become coupled to bridge endpoint changes. Mitigated by version handshake (T-72-05).

**Neutral**:

- One additive schema delta (v46, see T-72-02) — nullable column, no backfill, no data migration.
- No effect on Web UI behavior.
- No effect on the brain pillars or any prior ADR's contracts.

---

## Implementation Status

**Status**: Shipped 2026-05-20. All Phase 72 plans complete.

**Prerequisites (already in place):**

| Component | State | Notes |
|---|---|---|
| Atlas plugin tool layer | ✅ exists | `src/openclaw/plugin/src/wi-tools.ts` — 3 brain tools today |
| MCP server tool layer | ✅ exists | `src/server.ts` — 15 tools today (5 brain + 10 legacy operational) |
| Bridge endpoints (15 wrapped) | ✅ live | All exist, tested, used by Web UI |
| `brain_user_budget_ledger` | ✅ live | Schema v45 — extended with `bucket` column in v46 |
| `X-WI-Consumer` header support | ✅ partial | Read by `/api/brain/decide` and `/api/brain/context`; other endpoints ignore it harmlessly |

**Phase 72 deliverables (this ADR):**

| Component | State | Shipped | Notes |
|---|---|---|---|
| 15 new `wi_*` operational tool wrappers | ✅ Shipped — 2026-05-20 | Plans 72-01 through 72-03 | All 15 tools in `src/tools/manifest.ts` |
| 2 new `wi_*` brain tool wrappers (plugin parity) | ✅ Shipped — 2026-05-20 | Plan 72-01 | `wi_brain_context`, `wi_brain_learn` in manifest |
| Tool manifest | ✅ Shipped — 2026-05-20 | Plan 72-01 | `src/tools/manifest.ts` — single source of truth |
| Parity test suite | ✅ Shipped — 2026-05-20 | Plan 72-04 | `tests/openclaw/operational-parity.test.ts` |
| Per-session budget enforcement | ✅ Shipped — 2026-05-20 | Plan 72-05 | Schema v46 + `bucket` param in budget.ts + `makeMcpBudgetCheck` in server.ts |
| Plugin version handshake | ✅ Shipped — 2026-05-20 | Plan 72-05 | `checkWiToolsVersion()` in wi-tools.ts; `min_wi_tools_version: 1` in `/api/status` |
| Legacy MCP tool deprecation | ✅ Shipped — 2026-05-20 | Plan 72-05 | `[DEPRECATED — use wi_<x>]` prefix on all 10 legacy tools; removal Phase 74 |

**What was built (summary):**
- `src/tools/manifest.ts` — 17-entry TOOL_MANIFEST + `buildHandler` (Plans 72-01 to 72-03)
- `src/server.ts` — MCP server wired with `wi_*` default branch + `makeMcpBudgetCheck` (Plans 72-02, 72-05)
- `src/openclaw/plugin/src/wi-tools.ts` — `registerWiOperationalTools` (17 tools), `WI_TOOLS_VERSION = 1`, `makeSessionBudgetCheck`, `checkWiToolsVersion` (Plans 72-01 to 72-05)
- `src/db/migrations/v46_budget_bucket.ts` — schema v46 bucket column + index (Plan 72-05)
- `src/services/brain/budget.ts` — `bucket` param added to `checkDailyBudget` and `recordSpend` (Plan 72-05)
- `tests/openclaw/operational-parity.test.ts` — round-trip parity tests (Plan 72-04)
- `tests/openclaw/version-handshake.test.ts` — version handshake tests (Plan 72-05)
- `tests/db/v46_migration.test.ts` — migration tests (Plan 72-05)
- `src/openclaw/plugin/README.md` — 20-tool reference (Plan 72-05)

---

## Future Extensions (post-v1.1)

1. **Streaming tools** — `wi_chat_stream` for long-running queries with partial responses (after MCP streaming spec stabilizes).
2. **Composite tools** — `wi_morning_session` chains `wi_digest` + `wi_jira_stuck` + `wi_action_items` in one call. Only ship after observing real Atlas usage; premature now.
3. **Web UI tool palette** — surface the same 20 tools in the Web UI command palette so users see one consistent capability list across both clients.
4. **OpenAPI generation** — once tool count exceeds 30, generate from spec instead of hand-writing.
5. **Phase 74 legacy tool removal** — remove the 10 deprecated MCP tools (`search_messages`, `get_jira_report`, etc.) once telemetry confirms no external clients depend on them.

---

## Related

- [ADR-023 OpenClaw Plugin](./adr-023-openclaw-plugin.md) — established the plugin layer this ADR scales out
- [ADR-024 Unified Brain API](./adr-024-unified-brain.md) — the reasoning layer this ADR complements
- [Decision: Four-Stage Pipeline](../architecture/index.md) — tools live in Propose; no pipeline change
