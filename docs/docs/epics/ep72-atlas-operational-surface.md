---
sidebar_position: 72
title: EP-72 — Atlas Operational Surface
---

# EP-72 — Atlas Operational Surface

**Status:** ✅ Done — shipped 2026-05-20 (Phase 72, milestone v1.1)
**Source ADR:** [ADR-025: Atlas Operational Surface](../adr/adr-025-atlas-operational-surface)
**GSD record:** `.planning/phases/72-atlas-operational-surface/` (5 plans, 5 summaries)
**Schema:** v46 (additive: `bucket TEXT DEFAULT 'brain'` column on `brain_user_budget_ledger`)

## Goal

Lift OpenClaw / Atlas from a "smart chat" to an **operational agent with parity to the Web UI** by exposing the bridge's existing surface as 17 thin `wi_*` tool wrappers — registered byte-identically across the OpenClaw plugin and the MCP server from a **single tool manifest**.

**Hard constraints (per ADR-025):**
- No new bridge endpoints
- No new tables (only one additive schema delta — v46 `bucket` column)
- Tool cap: 20 (T-72-01)
- Tools live in **Propose** stage (no logic creep)
- Bridge stays the single integration surface

## What shipped (5 plans, 5/5 complete)

### Plan 72-01 — Tool manifest + first 7 tools
`src/tools/manifest.ts` — 530-line declarative manifest:
- Exports `TOOL_MANIFEST: ToolEntry[]` (flat array, no nesting)
- Exports `buildHandler(entry, opts)` (colocated, no separate handler file)
- Imports only `zod` (no server-only modules)
- Tools 1–7 declared: `wi_search`, `wi_jira_get`, `wi_jira_stuck`, `wi_jira_analyze`, `wi_jira_metrics`, `wi_brain_context`, `wi_brain_learn`
- 23-case test suite for manifest shape contract + `buildHandler` runtime behavior

### Plan 72-02 — Tools 8–11 (PR + action items + topics)
`wi_pr_list`, `wi_pr_create`, `wi_action_items`, `wi_topics` added to manifest.

### Plan 72-03 — Tools 12–17 (teams + calendar + digest + code-graph + teammates + sync)
`wi_teams`, `wi_calendar`, `wi_digest`, `wi_code_graph`, `wi_teammates`, `wi_sync` added. Total tools: 17.

### Plan 72-04 — Round-trip parity test suite
`tests/openclaw/operational-parity.test.ts` — every tool exercised against the live bridge:
- Response Zod-parses against declared `outputSchema`
- Top-level key set equality verified (CI fails on shape drift)
- HTTP 4xx/5xx maps to `{ ok: false, error: { code, message } }`
- CI runs on every PR; failure blocks merge

### Plan 72-05 — Guardrails + docs
- **Schema v46** — `bucket TEXT DEFAULT 'brain'` column on `brain_user_budget_ledger` + composite UNIQUE index `(user, day_iso, bucket)`. Idempotent. No backfill.
- **Per-session tool-call budget** — default 30 calls/session, configurable via `WI_TOOL_CALL_BUDGET`. Counts logged under `bucket='tool_calls'`. Enforced in MCP `buildHandler` via `makeMcpBudgetCheck(db)`.
- **Plugin version handshake** — `min_wi_tools_version: 1` on `GET /api/status`; plugin warns if `wi_tools_version < bridge_min_required`.
- **Legacy MCP deprecation** — 10 pre-existing tools get `[DEPRECATED — use wi_<x>]` description prefix (`search_messages`, `get_action_items`, `get_daily_digest`, `configure_topic`, `get_jira_report`, `get_teams_updates`, `search_all`, `ask_topic_expert`, `get_topic_suggestions`, `dismiss_topic_suggestion`). Removal scheduled for Phase 74.
- **`src/openclaw/plugin/README.md`** — usage example per tool (DOCS-01).
- **ADR-025 Implementation Status table** flipped to ✅ Shipped (DOCS-02).

## Tool surface — final

17 operational `wi_*` tools (in manifest order):

```
1.  wi_search          — POST /api/search-all
2.  wi_jira_get        — GET, discriminatedUnion(issues/my_issues/saturn/board)
3.  wi_jira_stuck      — GET /api/jira/stuck
4.  wi_jira_analyze    — POST, discriminatedUnion(analyze/investigate), 30s timeout
5.  wi_jira_metrics    — GET, discriminatedUnion(cycle_time/velocity/learnings)
6.  wi_brain_context   — GET /api/brain/context
7.  wi_brain_learn     — POST /api/brain/learn
8.  wi_pr_list         — GET, discriminatedUnion(list/watched/review)
9.  wi_pr_create       — POST, discriminatedUnion(create/post_review) ⚠ dry_run pending (FEATURE-003)
10. wi_action_items    — GET, discriminatedUnion(all/pending_review)
11. wi_topics          — mixed GET/POST, discriminatedUnion(list/expert/configure)
12. wi_teams           — mixed GET/POST, discriminatedUnion(updates/chats/meetings)
13. wi_calendar        — GET /api/calendar/upcoming
14. wi_digest          — GET, discriminatedUnion(morning/daily/weekly)
15. wi_code_graph      — GET, discriminatedUnion(blast_radius/owners/test_coverage)
16. wi_teammates       — GET, discriminatedUnion(list/expert)
17. wi_sync            — mixed GET/POST, discriminatedUnion(all/status), 30s timeout
```

## Tool contract

- 2xx → `{ ok: true, data }`
- 4xx/5xx → `{ ok: false, error: { code, message } }`
- Header `X-WI-Consumer: atlas | mcp`
- Query `?user=<name>` forwarded
- Default 8 s timeout; long-running ops 30 s (configurable via `WI_TOOL_TIMEOUT_MS`)
- Discriminated unions used for any tool fronting > 1 endpoint

## Key files

```
src/tools/manifest.ts                              # SINGLE SOURCE OF TRUTH for wi_* tools
src/server.ts                                       # MCP registration (spreads TOOL_MANIFEST.map)
src/openclaw/plugin/src/wi-tools.ts                # Atlas registration (imports same manifest)
src/openclaw/plugin/README.md                       # Per-tool usage examples (DOCS-01)
src/db/migrations/v46_budget_bucket.ts              # Schema v46 — bucket column
src/services/brain/budget.ts                        # bucket-aware checkDailyBudget / recordSpend
tests/tools/manifest.test.ts                        # 23-case manifest contract suite
tests/openclaw/operational-parity.test.ts           # CI-blocking parity tests
tests/db/v46_migration.test.ts                      # Migration tests (idempotency, backfill, down)
tests/openclaw/version-handshake.test.ts            # min_wi_tools_version handshake
```

## Open follow-ups (from `.planning/ADR-REVIEW.md`)

- **FEATURE-003** — `wi_pr_create` `dry_run: boolean` safety gate (P1) — currently opens real PRs
- **FEATURE-002** — Streaming tool responses for long ops (P2) — deferred until MCP streaming spec stabilizes
- **Phase 74** — Remove the 10 legacy MCP tools after telemetry confirms no external dependents

## Related

- [ADR-025 — Atlas Operational Surface](../adr/adr-025-atlas-operational-surface) — source design
- [ADR-023 — OpenClaw Plugin](../adr/adr-023-openclaw-plugin) — plugin host
- [ADR-024 — Unified Brain API](../adr/adr-024-unified-brain) — upstream context
- [EP-69 / EP-70 / EP-71 — Unified Brain](./ep69-71-unified-brain) — directly upstream
- [EP-68 — OpenClaw Plugin](./ep68-openclaw-plugin) — directly upstream
