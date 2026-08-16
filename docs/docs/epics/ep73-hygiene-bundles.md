---
sidebar_position: 73
title: EP-73 — Architecture & UX Hygiene Bundles
---

# EP-73 — Architecture & UX Hygiene Bundles

**Status:** ✅ Done — shipped 2026-05-20 → 2026-05-21
**Source:** Senior architect + senior UX review against the freshly-centralized docs (see `.planning/ADR-REVIEW.md`)
**ADRs:** [ADR-026](../adr/adr-026-route-module-extraction) (new); fixes verified against ADR-002, ADR-021, ADR-024, ADR-025

## Goal

Close every P0 / P1 finding from the architect + UX review while establishing two structural patterns that the rest of the codebase will follow: **smoke-test discipline** (`scripts/smoke-bridge.sh`, `npm run smoke:*`) and **route module extraction** (ADR-026).

The work was sequenced as four bundles, each ending with a smoke checkpoint:

```
Bundle A (agent + safety)
  ↓
Bundle B (UX polish)
  ↓
REFACTOR-001 opening pass
  ↓
Bundle C (observability)
```

## What shipped

### Bundle A — agent & safety hygiene (3 items)

| ID | Item | Impact |
|---|---|---|
| **A-4** | CorrelationAgent: `getHours()` → `getUTCHours()` so the schedule gate matches the UTC cache key | Nightly digest no longer skips/double-fires on DST boundaries |
| **REDUNDANCY-001** | `CostGateClassifier` rewritten as a deterministic check against `brain_user_budget_ledger` (`research` bucket). No more Haiku call to decide whether to spend tokens. | Cost: ~200–400 Haiku tokens saved per research invocation. Latency: ~1 ms vs ~1 s |
| **FEATURE-001** | Alert dedup in `OrchestratorAgent.scoreAlert` — signature = `(severity, normalized subject)` hashed via `json_extract(payload, '$._dedup_signature')`. Configurable `ALERT_COOLDOWN_MS` (default 4 h). | Recurring CI failures no longer spam `proactive_queue` |

**Files:** `web-server.js`, `src/intelligence/cost-gate.ts`, `src/services/orchestrator-agent.ts`

### Bundle B — UX polish (5 items)

| ID | Item | Files |
|---|---|---|
| **U-7** | Real 404 page (`NotFoundPage`) — shows attempted URL + 5 suggested destinations | `web/src/pages/NotFoundPage.tsx` (new), `App.tsx` |
| **U-8** | `<ErrorBoundary scope="route">` around `<Routes>` — single-page crash no longer blanks the app | `web/src/components/shell/ErrorBoundary.tsx` (new), `App.tsx` |
| **U-17** | Severity-coloured proactive badge: `Urgent` (red), `Attention` (amber), `Proactive` (accent). Explicit `[HIGH]/[MEDIUM]/[LOW]` prefix wins over keyword heuristics | `web/src/components/shared/ChatMessage.tsx` |
| **U-10 phase 1.5** | `MD_COMPONENTS` exported from `lib/linkify.tsx`, wired into all 6 markdown surfaces: `ChatMessage`, `ChatFeedPanel`, `TeamsUpdatesPage`, `JiraReportPage`, `PRReviewPage`, `MarkdownPanel`, `DailySummarySection`. Existing styled overrides keep their styling AND get linkified | `web/src/lib/linkify.tsx`, +6 markdown surfaces |
| **U-18** | "Did this help?" buttons on `DecisionCard` — Worked / Didn't work / Abandoned → `POST /api/brain/learn`. Closes the learning loop from the UI | `web/src/components/brain/DecisionCard.tsx`, `web/src/lib/api.ts` |

### REFACTOR-001 — opening pass (architectural)

See [ADR-026](../adr/adr-026-route-module-extraction) for the full design. Summary:

- **New `src/routes/` directory** with `_types.ts` (`RouteHandler`, `RouteContext`), `_util.ts` (TS-native `json` / `readBody`), and `README.md` (live status table + 7-step checklist).
- **`src/routes/brain.ts`** — 3 of 6 brain routes extracted (`learn`, `verify`, `recall`) — ~150 LOC moved out of `web-server.js`.
- **Dispatcher loop** added to `web-server.js`: walks `EXTRACTED_ROUTES` before the legacy if-chain. Each match returns the response; non-matches fall through.
- **Smoke harness extended** with 3 new checks against the extracted routes — these become the contract.
- **Pattern documented** at `src/routes/README.md` with a 7-step extraction checklist, per-family migration order, and pitfall list.

Remaining: ~6300 LOC across 14 families. Order (lowest-risk first): `pr → action-items → topics → digest → brain (remainder) → jira → teams → calendar → teammates → code-graph → sync → notebooks → misc`.

### Bundle C — observability (5 items)

| ID | Item | Impact |
|---|---|---|
| **A-6** | Startup `dist/` freshness check — 5 sentinel TS/JS file pairs compared on boot; refuse to start if any source is > 1 s newer than its compiled artifact. Bypass: `SKIP_STALE_DIST_CHECK=1` | Eliminates the "I ran my fix but it didn't work" stale-build footgun |
| **A-9** | Prompt rollback endpoint — `GET /api/prompts` lists all template versions per trigger type; `POST /api/prompts/rollback` atomically swaps active version | OPRO / TextGrad / A-B evolved prompts now have a one-call rollback path |
| **A-10** | Palace uptime banner in Topbar — polls `/api/palace/status` every 60 s; when `connected: false` it shows an amber banner: "Recall layer offline — answers may be less complete." | Invisible-degradation problem (the user sees worse answers but doesn't know why) → visible |
| **U-9** | Budget widget in Topbar — `GET /api/brain/budget` reports `calls/max_calls · tokens/max_tokens`. Colour ramp: muted → amber at 80% → red at 95%. Tooltip shows reset time (UTC midnight). | Users see their budget burn before hitting 429 |
| **U-14** | `<StaleBanner>` component (inline + block variants) wired into `DailySummarySection`. Other surfaces follow the one-line pattern: `<StaleBanner stale={x.stale} reason={x.stale_reason} cachedAt={x.cached_at} />` | Stale cached AI output is now visibly labeled, not silently shown |

**Files:** `web-server.js`, `web/src/components/shell/Topbar.tsx`, `web/src/components/shared/StaleBanner.tsx` (new), `web/src/components/shared/DailySummarySection.tsx`

## Smoke evidence

Bridge smoke is now **16 checks** (was 13 at start of this work). All pass in < 2 s:

| Section | Checks | Verifies |
|---|---|---|
| 0–1 | 2 | Liveness, `/api/status` keys |
| 2 | 2 | Agent registry (OP-5) — ≥7 agents, none crashed |
| 3 | 1 | `/api/system-health` agents rollup |
| 4 | 2 | CORS deny + allow (OP-4) |
| 5 | 1 | Preflight 204 |
| 6 | 2 | PR dry-run defaults (OP-2) |
| 7a | 3 | **Extracted brain routes** — `learn` returns 404 for unknown id; `recall` returns results array; `verify` returns verified field (REFACTOR-001) |
| 7b | 3 | Brain decide SSE — cold call emits 3+ stages; cache HIT returns in < 3 s (OP-7) |

UI smoke (Playwright headless): sidebar 4 groups + linkify entity counts both pass. Visual screenshots verify 404 page, topbar budget chip, palace banner, chat panel chips.

Smoke-test protocol documented at [`.claude/rules/smoke-tests.md`](https://github.com/your-org/work-intelligence-mcp/blob/main/.claude/rules/smoke-tests.md). Commands:

```bash
npm run smoke:bridge   # 16-check end-to-end bridge smoke
npm run smoke:ui       # Playwright UI smoke (needs web:dev running on :5175)
npm run smoke:all      # both
```

## Files touched (top-level summary)

```
NEW:
  docs/docs/adr/adr-026-route-module-extraction.md
  docs/docs/epics/ep73-hygiene-bundles.md         (this file)
  scripts/smoke-bridge.sh
  scripts/smoke-ui.mjs
  scripts/smoke-ui-extras.mjs
  src/routes/_types.ts
  src/routes/_util.ts
  src/routes/brain.ts
  src/routes/README.md
  web/src/components/shared/StaleBanner.tsx
  web/src/components/shell/ErrorBoundary.tsx
  web/src/pages/NotFoundPage.tsx
  .claude/rules/smoke-tests.md

MODIFIED (key changes only):
  CLAUDE.md                  — elevated smoke-test rule + canonical commands
  package.json               — smoke:bridge / smoke:ui / smoke:all
  web-server.js              — CORS, auth, agent registry, freshness check, prompts, brain/budget, route dispatcher, dedup
  src/intelligence/cost-gate.ts                  — deterministic budget gate (no more Haiku)
  src/services/orchestrator-agent.ts             — alert dedup with json_extract signature
  src/services/brain/decision-engine.ts          — onStage callback for streaming
  src/services/brain/budget.ts                   — ensureLedger now creates v46-shape table
  src/tools/manifest.ts                          — wi_pr_create dry_run defaults to true
  web/src/App.tsx                                — ErrorBoundary + real 404
  web/src/components/shell/{Sidebar,Topbar,ChatPanel}.tsx
  web/src/components/shared/{ChatMessage,ChatFeedPanel,DailySummarySection,MarkdownPanel}.tsx
  web/src/components/brain/DecisionCard.tsx
  web/src/lib/{api,linkify}.ts
  web/src/pages/{PRReviewPage,JiraReportPage,TeamsUpdatesPage}.tsx
```

## Open follow-ups (tracked in [known-gaps](../architecture/known-gaps))

- **REFACTOR-001 remainder** — 14 route families, ~6300 LOC. Migration order documented in `src/routes/README.md`. 2–3 days.
- **GAP-002** — `wi-investigate` skill output schema (2 h)
- **GAP-003** — proactive pattern match on Jira sync (3 h)
- **GAP-004** — `wi_decisions_history` tool (2 h)
- **DOC-003** — audit ADR-020 G1–G16 vs ADR-024 (2 h)
- **FEATURE-002 remainder** — streaming for `wi_jira_analyze` / `wi_sync` / `wi_investigate` (1 day)
- **U-10 phase 2** — structured evidence schema end-to-end (1 day)
- **U-14 (continued)** — apply `<StaleBanner>` to JiraReport / WeeklyReport / TopicExpert / InvestigationViewer (30 min)
- **U-2, U-4, U-6, U-11, U-12–U-19** — various UX items, see known-gaps.md

## Related

- [ADR-026 — Route Module Extraction](../adr/adr-026-route-module-extraction)
- [`/.planning/ADR-REVIEW.md`](https://github.com/your-org/work-intelligence-mcp/blob/main/.planning/ADR-REVIEW.md) — live ledger
- [`docs/docs/architecture/known-gaps.md`](../architecture/known-gaps) — published view
- [`.claude/rules/smoke-tests.md`](https://github.com/your-org/work-intelligence-mcp/blob/main/.claude/rules/smoke-tests.md) — smoke protocol
- [`src/routes/README.md`](https://github.com/your-org/work-intelligence-mcp/blob/main/src/routes/README.md) — route extraction status
