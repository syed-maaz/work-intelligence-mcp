---
sidebar_position: 4
title: Known Gaps & Bugs
---

# Known Gaps & Bugs

> Published view of the live ledger at [`/.planning/ADR-REVIEW.md`](https://github.com/your-org/work-intelligence-mcp/blob/main/.planning/ADR-REVIEW.md). **The source file is authoritative** — when an item moves from open to closed there, this page is regenerated.
>
> **Last verified:** 2026-05-21

## Legend

- **Severity:** P0 production broken now · P1 high leverage · P2 medium · P3 quality/maintenance
- **Type:** `BUG` confirmed broken · `GAP` designed but not wired · `REDUNDANCY` can simplify · `FEATURE` new capability · `REFACTOR` structural · `DOC` documentation
- **Status:** `[ ]` open · `[x]` closed

---

## ✅ Closed since last audit

| ID | Description | Closed |
|---|---|---|
| BUG-001 | CorrelationAgent digest payload shape — confirmed non-issue | 2026-05-18 |
| BUG-002 | CDC events `jira-update` + `calendar-change` unsubscribed | 2026-05-18 |
| BUG-003 | `pruneExpiredResearch` never scheduled — research cache unbounded | 2026-05-18 |
| BUG-004 | `brain_decisions.cache_key` collision — verified present (UNIQUE column) | 2026-05-18 |
| DOC-001 | ADR-023 architecture diagram + 7 structural issues | 2026-05-19 |
| DOC-002 | ADR-024 placeholder stubs filled with shipped Phase 69–71 content | 2026-05-19 |
| FEATURE-003 | `wi_pr_create` `dry_run` safety gate | 2026-05-20 |
| A-1 | CORS allow-list + bearer auth (replaced `*`) | 2026-05-20 |
| A-2 | Per-agent isolation in boot block + `/api/agents/health` | 2026-05-20 |
| A-3 | `ensureLedger` schema race | 2026-05-20 |
| A-4 | CorrelationAgent local-time → UTC | 2026-05-21 (Bundle A) |
| A-6 | `dist/` freshness check on startup | 2026-05-21 (Bundle C) |
| A-9 | Prompt rollback endpoint (`GET /api/prompts` + `POST /api/prompts/rollback`) | 2026-05-21 (Bundle C) |
| A-10 | Palace uptime banner in Topbar | 2026-05-21 (Bundle C) |
| U-1 | Sidebar IA — 4 grouped sections | 2026-05-20 |
| U-5 | wi_pr_create dry-run default | 2026-05-20 |
| U-7 | Real 404 page (replaces soft redirect) | 2026-05-21 (Bundle B) |
| U-8 | `<ErrorBoundary>` around routes | 2026-05-21 (Bundle B) |
| U-9 | Budget widget in topbar | 2026-05-21 (Bundle C) |
| U-17 | Severity-coloured proactive badge | 2026-05-21 (Bundle B) |
| U-18 | Mark-decision-wrong button on `DecisionCard` | 2026-05-21 (Bundle B) |
| REDUNDANCY-001 | `CostGateClassifier` → deterministic budget check | 2026-05-21 (Bundle A) |
| FEATURE-001 | Alert dedup with 4 h cooldown | 2026-05-21 (Bundle A) |
| **Partial advances** | | |
| FEATURE-002 | Streaming brain decide via SSE (3 stages + result) | 2026-05-20 (OP-7) — long ops still pending |
| U-10 | Linkify MVP + structured brain evidence (`evidence-schema.ts`, tool schema, normalize on read) | 2026-05-21 |
| U-14 | `<StaleBanner>` on Dashboard, Weekly, Topic Expert, Investigation, Jira Report | 2026-05-21 |
| U-2–U-6, U-11–U-13, U-15–U-16, U-19 | UX sprint (chat-primary, setup, glossary, confidence, search sort, …) | 2026-05-21 |
| REFACTOR-001 | `src/routes/` scaffold + 3 brain routes extracted (~150 LOC). Pattern documented + ADR-026. ~6300 LOC + ~14 families still in `web-server.js`. | 2026-05-21 — opening pass complete |

## 🟡 Open — production bugs (P0)

_None right now._ All four P0 items closed during the 2026-05-18 audit.

## 🟡 Open — high-leverage gaps (P1)

### GAP-002 — `wi-investigate` skill output schema not locked ✅ 2026-05-21
**ADR:** ADR-022 (Dual-Engine Bug Investigation)
**Risk:** `synthesizeReports()` silently breaks when the CLI skill doesn't return a `confidence` field. Dual-engine synthesis provides no value over ReAct alone.
**Fix:** Add a required JSON output block to `wi-investigate/SKILL.md`; validate in `runSkillInvestigation()`.

## 🟡 Open — medium-priority items (P2)

### GAP-003 — Investigation pattern memory never activates proactively ✅ 2026-05-21
**ADRs:** ADR-013, ADR-014.
**State:** `findSimilarInvestigation()` exists and works, but only runs on explicit `POST /api/jira/investigate`. New tickets arriving via sync are never matched against known patterns.
**Fix:** In ChangeWatcher `jira-update` handler, call `findSimilarInvestigation()`; if match > 0.7, write to `proactive_queue`.

### GAP-004 — Decision audit trail not queryable by Atlas ✅ 2026-05-21
**ADR:** ADR-024 (Unified Brain API)
**State:** `brain_decisions` records every decision but there's no `wi_decisions_history` tool. A user cannot ask "why did you tell me to work on X last week?"
**Fix:** New `GET /api/brain/decisions` endpoint + `wi_decisions_history` tool wrapping it.

### DOC-003 — ADR-020 gap list (G1–G16) is stale vs ADR-024
**ADR:** ADR-020 (Proactive Intelligence Brain)
**State:** Several of ADR-020's documented gaps may be resolved by ADR-024's unified brain. Status unaudited.
**Fix:** Read ADR-020 G1–G16 against `web-server.js` chat handler + brain endpoints; annotate each `[FIXED in ADR-024]`, `[STILL OPEN]`, or `[SUPERSEDED — brain handles this now]`. Transfer still-open gaps here.

### FEATURE-002 (partial) — Streaming for the other long ops
**State:** Brain decide is streaming via `/api/brain/decide/stream` since 2026-05-20. `wi_jira_analyze` (~15 s), `wi_sync` (~30 s), `wi_jira_investigate` (~30 s) still return synchronous JSON.
**Fix:** Extend the SSE pattern from `decide/stream` to those three endpoints.

## 🟡 Open — refactoring / maintenance (P3)

### REFACTOR-001 — Extract `web-server.js` route handlers into modules
**Context:** 6.3 k LOC monolith with no test hooks. Modularize to `src/routes/{brain,jira,teams,pr,…}.ts`.
**Status:** ADR-002 ("Single server now, extractable later") tracks this as accepted-but-deferred.

### REFACTOR-002 — Four-Stage Pipeline violations (GAP-P1 through GAP-P5)
**Context:** 5 documented violations of `Fetch → Process → Analyze → Propose` (see [architecture/index](./index#known-pipeline-gaps)). Some may now be closed by AlertScorerAgent.
**Action:** Audit each gap; either fix (move to correct stage) or document the architectural exception explicitly.

### Connector duplicates (queued — added by 2026-05-20 audit)
- `src/connectors/jira.ts` (`JiraConnector`) — only used by tests + README example; production uses `jira-adapter.ts` / `jira-browser.ts`
- `src/connectors/outlook-calendar.ts` (`OutlookCalendarConnector`) — only referenced by its own definition + an EP-25 doc; superseded by `mac-calendar.ts`
- `src/connectors/README.md` — predates ADR-006 / EP-46 and uses the orphan `JiraConnector` as an example

**Action:** Get user confirmation, then remove and update the barrel `connectors/index.ts`.

---

## ⛔ Don't invest further

Per ADR-REVIEW PART 7:

| Feature | ADR | Reason to stop |
|---|---|---|
| Obsidian smart clusters | ADR-004 | MemPalace is now the semantic layer. Obsidian is read-only output. |
| n8n HTTP transport (EP-16) | ADR-020 | Never shipped. Superseded by MCP + Atlas. |
| Standalone semantic search (EP-37) | ADR-020 | `rrfFuse()` exists but was never connected. Use brain endpoints. |
| Weekly pattern analysis (EP-38) | ADR-020 | Low value, 7-day cache, already built. No further work. |

---

## Execution order (next 10 working hours of doc fixes)

1. ~~GAP-002~~ — wi-investigate output schema ✅
2. ~~GAP-003~~ — proactive pattern match ✅
3. ~~GAP-004~~ — `wi_decisions_history` tool ✅
4. DOC-003 — audit ADR-020 G1–G16 (2 h)
5. Connector cleanup (1 h, pending user confirmation)
**Larger projects:**
- REFACTOR-001 — extract remaining 14 route families from web-server.js (2–3 days)
- FEATURE-002 — streaming for `wi_jira_analyze` / `wi_sync` / `wi_investigate` (1 day)
- REFACTOR-002 — fix the 5 four-stage-pipeline violations (1 day)

---

*If you fix one of these items, update both this page and `.planning/ADR-REVIEW.md` in the same commit. The two must agree.*
