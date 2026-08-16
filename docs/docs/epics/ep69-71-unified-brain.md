---
sidebar_position: 69
title: EP-69 / EP-70 / EP-71 — Unified Brain
---

# EP-69 / EP-70 / EP-71 — Unified Brain Build-Out

**Status:** ✅ Done — shipped 2026-05-17 → 2026-05-18 (Phases 69 / 70 / 71)
**Milestone:** v1.0.x
**Source ADR:** [ADR-024: Unified Brain API](../adr/adr-024-unified-brain)
**GSD record:** `.planning/phases/69-foundation-brain/`, `70-brain-consumers/`, `71-brain-learning/`, plus consolidated `69-71-unified-brain/VERIFICATION.md`
**Schema:** v45 (4 new tables: `brain_decisions`, `brain_clusters`, `brain_verifications`, `brain_user_budget_ledger`)

## Goal

Establish the **Unified Brain API** — a single, structured decision/recall/verify/learn surface that every consumer (Web UI, MCP server, OpenClaw plugin) calls instead of reinventing context assembly. Replace ad-hoc per-feature context fetches with a typed pipeline that caches by `(question, user, day)` and persists every decision for the learning loop.

## What was built

### Phase 69 — Foundation Brain (5 plans)

| Plan | Deliverable |
|---|---|
| 69-01 | Schema v45 migration — 4 new brain tables (`brain_decisions`, `brain_clusters`, `brain_verifications`, `brain_user_budget_ledger`) with `cache_key TEXT NOT NULL UNIQUE` on `brain_decisions` |
| 69-02 | `GET /api/brain/context` — TTL-cached operational context (sprint, stuck Jiras, noise clusters, calendar, investigations, stale-data warnings). < 100 ms warm |
| 69-03 | Cluster signature + manual override on `brain_clusters.root_cause` (mitigates T-69-02 cluster misgrouping) |
| 69-04 | Stale-data warnings surfaced via `wi_brain_context` |
| 69-05 | `POST /api/brain/decide` — full decision pipeline: cache lookup → context-build → recall → Claude Sonnet (forced tool_use) → verify → budget check → persist |
| 69-06 | Foundation smoke test — single-consumer baseline before consumer wiring |

### Phase 70 — Brain Consumers (5 plans)

| Plan | Deliverable |
|---|---|
| 70-01 | Atlas: replace `context-cache.ts` with `/api/brain/context` call |
| 70-02 | Atlas tools — `wi_decide`, `wi_verify`, `wi_recall` registered in OpenClaw plugin |
| 70-03 | Web UI: ChatPanel routes verb-led questions (`should I…`, `do I…`) to `/api/brain/decide` |
| 70-04 | MCP server: 5 brain tools registered in `src/server.ts` (`get_context`, `get_decision`, `verify_claim`, `recall_memory`, `record_outcome`) |
| 70-05 | Cross-consumer parity test — same `(question, user, day)` triple returns the same `decision_id` from any consumer |

### Phase 71 — Brain Learning (5 plans)

| Plan | Deliverable |
|---|---|
| 71-01 | `POST /api/brain/learn` — write outcome (success / failed / abandoned) to `brain_decisions`; fans out to `MemoryEnricher.decisions` wing |
| 71-02 | `POST /api/brain/verify` — claim verification via `verifiers/` adapter pack (GitHub MCP, Jira MCP, code grep, build log); per-adapter circuit breaker (3 fails → 30 s open) |
| 71-03 | Proactive scan cron — confidence ≥ 0.85 + 24 h per-cluster cooldown surfaces high-signal recurring patterns into `proactive_queue` |
| 71-04 | Recurring-pattern badges in the UI — joins on cluster signatures |
| 71-05 | `POST /api/brain/recall` — palace + `brain_decisions` retrieval, ranked recency × confidence |

## Key files

```
src/services/brain/
  ├── decision-engine.ts          # /decide core: cache → context → recall → AI → verify → persist
  ├── context-builder.ts          # TTL-cached operational context
  ├── recall.ts                   # RRF over palace + brain_decisions + KG
  ├── verify.ts + verifiers/      # Claim verification dispatcher + adapters
  ├── learn.ts                    # /learn: outcome write + MemoryEnricher fan-out
  ├── budget.ts                   # brain_user_budget_ledger (per-user daily $ + tool-calls bucket)
  ├── action-cluster-detector.ts  # Cluster signature + manual override
  ├── proactive-scan.ts           # Cron — confidence ≥ 0.85 + 24h cooldown
  ├── staleness-detectors.ts      # Stale-data heuristics
  └── anthropic-tool-use.ts       # brainToolCall — forced tool_use, no AIAnalyzer dependency

src/tools/
  ├── brain-get-context.ts        # MCP tool: get_context
  ├── brain-get-decision.ts       # MCP tool: get_decision
  ├── brain-verify-claim.ts       # MCP tool: verify_claim
  ├── brain-recall-memory.ts      # MCP tool: recall_memory
  └── brain-record-outcome.ts     # MCP tool: record_outcome

src/db/migrations/v45_brain_tables.ts
```

## Cache key contract (locked in ADR-024)

```
cache_key = sha256(normalizeQuestion(question) ‖ user ‖ utcDayIso())
```

- `UNIQUE` constraint on `brain_decisions.cache_key`
- Two users asking the same question on the same day get **separate** decisions
- Same user asking the same question on the same day within TTL gets a **cached** decision (~200 ms)
- First (uncached) decision takes 5–25 s depending on context complexity

## Verification verdict

From `.planning/phases/69-71-unified-brain/VERIFICATION.md` (2026-05-18):
- **16 plans · 63 checks · 36 PASS · 20 FAIL · 7 PARTIAL**
- BUG-001 through BUG-004 (raised in `.planning/ADR-REVIEW.md`) closed during the 2026-05-18 audit
- Open follow-ups: GAP-002 (skill output schema lock), GAP-003 (proactive pattern match), GAP-004 (decision audit query tool), REDUNDANCY-001 (CostGateClassifier → budget check). See [known-gaps](../architecture/known-gaps).

## Threats and mitigations (ADR-024)

| Threat | Mitigation | Verdict |
|---|---|---|
| T-69-01 — cost runaway + cross-user collision | `cache_key UNIQUE` + daily per-user budget | ✅ |
| T-69-02 — cluster misgrouping | Composite signature + manual override | ✅ |
| T-70-01 — UI / Atlas / MCP drift | Cross-consumer parity test | ✅ (assertion now on `cache_key` primitive) |
| T-71-01 — verification adapters bypass auth | Reuse `McpClient` token store + per-adapter circuit breaker | ✅ |
| T-71-02 — proactive scan spams alert feed | Confidence ≥ 0.85 + 24 h per-cluster cooldown | ⚠ partial (cooldown stored in process Map — see known-gaps) |

## Related

- [ADR-024 — Unified Brain API](../adr/adr-024-unified-brain) — locked design
- [ADR-016 — Second Brain Architecture](../adr/adr-016-second-brain-architecture) — palace foundation
- [ADR-017 — Always-On Agent Architecture](../adr/adr-017-always-on-agent-architecture) — CDC pipeline this builds on
- [EP-72 — Atlas Operational Surface](./ep72-atlas-operational-surface) — directly downstream
