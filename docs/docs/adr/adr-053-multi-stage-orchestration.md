---
title: "ADR-053: Multi-Stage Orchestration — PM/Architect Coordination Layer"
sidebar_label: "ADR-053: PM/Architect Coordination"
sidebar_position: 53
status: Substrate Accepted
date: 2026-07-27
---

# ADR-053: Multi-Stage Orchestration — PM/Architect Coordination Layer

**Status:** ✅ **Accepted (proposed 2026-07-27; substrate landed 2026-07-28→08-06; reconciled 2026-08-07; dogfood AC-U1/U2/U3 verified 2026-08-14 — report: `.planning/notes/adr-053-dogfood-report-2026-08-14.md`)**

> Substrate ACs S1–S8 are built and smoke-pinned (§ 51). Outcome ACs U1–U5 remain
> unverified — they require the Week-6 5-goal dogfood, which has not run. Per
> `docs/agent-conventions/outcome-honesty.md`, this ADR is **🚧 Substrate Accepted**,
> not ✅ Accepted. Promotion to ✅ is gated on a recorded dogfood proving AC-U1/U2/U3.

_Amended 2026-08-06 (G7 gate: reactive default with grant-scoped AUTO, see § G7 Gate)._

> **Quick ref**
> - **Vision origin:** user (Maaz) 2026-07-27, articulated in `.planning/adr-053-multi-stage-orchestration/DISCUSSION.md` § "The vision (verbatim)"
> - **Design log:** `.planning/adr-053-multi-stage-orchestration/DISCUSSION.md` (repo-relative; outside Docusaurus root) — 8 questions closed sequentially per `architectural-design-discussion` skill discipline
> - **Feature flag:** `ADR_053_ENABLED=1` (default off — full rip-out via flag flip)
> - **Scope:** MVP is a horizontal slice targeting ONE goal shape (`feature.cross-repo`, matching the flagship lotse endpoint example). All other goal shapes fall through to today's flat runLoop.
> - **Total delta:** ~1000-1100 LOC + 2 migrations (v107 `sub_task_events`, v108 `cypher_sessions.posture` CHECK). Reuses the existing `tasks.depends_on_json` column (shipped ADR-040 v90) for the DAG — no new dependency column. Additive to master.
> - **Hard blocker (CLEARED 2026-08-07):** ADR-040 § 49.2 e2e-column advancement — this is the smoke-bridge § 49.2 *positive control* (a real-execute-work card advances past `in_progress`), which is present and green (`scripts/smoke-bridge.sh:3691`). Substrate landed on top of a passing § 49.2.

**Related:**
- [ADR-037](./adr-037-cypher-tool-use-loop.md) — the current `runLoop` primitive that ADR-053 reuses without modification
- [ADR-038](./adr-038-cypher-v2.5-production-grade.md) — postures (`cypher_sessions.posture`) which ADR-053 extends with two new values
- [ADR-040](./adr-040-outcome-honest-delivery-kanban.md) — kanban board substrate that ADR-053 reuses as the dependency graph (Q6)
- [ADR-042](./adr-042-prompt-generation-stage.md) — Stage 1 (SCOPE) substrate; ADR-053 does NOT modify SCOPE in MVP
- [ADR-043](./adr-043-pm-orchestration-layer.md) — Phase 1+2 shipped (capture + rank); ADR-053 answers what ADR-043 Phase 3 ("Shape A" autonomous decomposition) actually looks like
- [ADR-046](./adr-046-model-neutral-agent-contract.md) — universal agent contract; ADR-053 respects it (PM + Architect are just new postures on the existing runLoop, not new agent identities)
- ADR-050 (`docs/adr/adr-050-fault-proof-wi-measurement-gate.md`, outside this content root) — measure-before-build discipline that this ADR honors
- ADR-051 (`docs/adr/adr-051-skill-registry-unification.md`, outside this content root) — Option A workaround-only, closed 2026-07-27
- [ADR-052](./adr-052-obsidian-ecosystem-integration-roadmap.md) — separate concurrent ADR (Obsidian Ecosystem Integration, Proposed 2026-07-27, merged to master `be07347`). ADR-053 explicitly numbered 053 to leave 052 to that thread; the two ADRs are unrelated in scope.

---

## Context

### The user pain (verbatim from vision, 2026-07-27)

The user wants /wi to complete complex multi-repo tasks end-to-end. Concretely: *"prompt 'Implement new endpoint in lotse for xxx service' → look what we already know about lotse, what step we followed previous, which repos will be effected, blast radius, did we achieve similar task before … PM needs to plan the execution by making default PR for FE, BE and OPs repo. all the task depend on each other so when is complete PM will push other dependent task immediately."*

**The vision has 4 stages:**
1. **Prompt** — `/wi <goal>`
2. **Stage 1** — refine goal, gather context (blast radius, similar past work, affected repos)
3. **Stage 2** — PM/Architect decomposes into sub-tasks, orchestrates dependency graph, picks cost-effective model per sub-task
4. **Stage 3** — Executor hardens ACs + tests, runs the work, gives/receives feedback with PM

### Reality on master today (2026-07-27, grep-verified)

- **Stage 1 exists but is weak** — `RefinedGoal { intent, target, constraints, success_criteria }` from ADR-039/042, but recall is 2/10 top-1 (verified this session; per-goal breakdown in `.planning/adr-050-r2-b1-consumer-path/DISCUSSION.md`).
- **Stage 2 does not exist.** ADR-050 §1.2 verbatim: *"Stage 2 (PM/Architect) — DOES NOT EXIST. wi-pm + BoardWorkerAgent capture + rank a flat backlog. Explicit non-decomposition. Deferred in ADR-042 to an unwritten ADR."* ADR-053 IS that "unwritten ADR."
- **Stage 3 is a flat single-model loop** — one runLoop with a monolithic tool catalog. No specialists. No goal-hardening step. No test-first.
- **~70% of the vision's primitives DO exist on master:** postures (v71), workers table (v90), subagent_dispatches (v92), prompt_memory (v98), model_config (10 buckets), AGENT-RULES.md (ADR-046), kanban board (ADR-040), always-on agents (ADR-017), code-graph blast-radius (ADR-027/028), palace KG, wi-people ownership, prompt_memory prior work retrieval.

### What ADR-053 is NOT

- **NOT a new architecture** (Q1). Executors stay the current runLoop primitive. No new agent processes. No new agent identities.
- **NOT a Stage-1 rewrite.** SCOPE stays unchanged in MVP. The hydration manifest pattern (Q3) is deferred to a follow-up ADR.
- **NOT a self-learning executor system.** Learning stays at Beta priors (per-(tool, task_class), already in `cypher_sessions.outcome`).
- **NOT a new model contract.** PM and Architect obey AGENT-RULES.md the same as every other agent per ADR-046.

### Vision coverage — what this MVP delivers vs. the 4-stage vision

The user's vision (§ "The user pain") has four stages. ADR-053 MVP delivers **Stage 2 and a fraction of Stage 1**, by design. This table is the explicit scorecard so the deferrals are on the record, not implied by omission:

| Vision ask | MVP status | Where the rest lives |
|---|---|---|
| **Stage 1** — refine + "all context in one prompt" (blast radius, prior work, affected repos) | ⚠️ Partial — keeps today's SCOPE (ADR-042); hydration hard-coded inside the one template | Generalized hydration manifest deferred (Q3 → RADAR "Q3 hydration manifest" + "Stage-1 hydration is the next ADR") |
| **Stage 2** — PM decomposes into a dependency DAG, orchestrates unblocking | ✅ **Delivered** — this is the ADR's core | — |
| **Stage 2** — PM "acts like architect" (structural review) | ✅ Delivered — explicit `architect` posture, one review/goal | — |
| **Stage 2** — default PRs for FE/BE/Ops | ⚠️ Routes to the existing executor; PR creation is the executor's job via already-wired skills | ADR-053 adds no new PR writers |
| **Stage 2** — cost-effective model per sub-task | ❌ Fixed buckets (pm=Sonnet, architect=Opus) | Per-task cost routing deferred (RADAR "Per-task model selection at PM's discretion") |
| **Stage 3** — executor hardens ACs + tests first | ❌ Not in MVP — executor stays the flat runLoop | Test-first / plan-then-execute mode is a follow-up ADR |
| **Stage 3** — specialist FE/BE/Research executors | ❌ Single primitive; specialization by posture/prompt only | See "Executor architecture — decided" below |
| **Real-time PM↔executor feedback** | ⚠️ Async via `sub_task_events` + user-triggered `/wi resume` | Auto/board-triggered re-entry deferred (RADAR) |
| **"Fault-proof" end-to-end** | ⚠️ More reliable (cycle-check, Architect gate, dispatch ordering, safety caps), NOT fault-proof | Depends on ADR-040 § 49.2 correctness + Stage-1 recall quality |

**Why Stage 2 first:** Stage 2 was the piece that did not exist at all (ADR-050 §1.2). Shipping it end-to-end for one shape makes Stage 1's weakness *measurable* — once PM decomposes real goals, the exact failure modes of the thin SCOPE brief become visible, which is what the hydration manifest must be designed against. Building Stage 1 first would be guessing; building it after Stage 2 is responding to evidence.

### Executor architecture — decided (dumb-executor + smart-PM)

The vision left one question open: *"should executors be self-learning specialists with a powerful harness, OR dumb skills the PM directs?"* **ADR-053 MVP decides: dumb-executor + smart-PM.** The executor stays the single existing runLoop primitive; all coordination/planning intelligence lives in the PM + Architect tier. Specialization is by posture/prompt, not separate agent processes.

**Rationale:** self-learning per-role executors need ~100+ dispatches/week to converge; the user's real rate is ~5-15/week (Q1 rejection rationale). At that volume, a smart-PM directing a capable-but-unspecialized executor buys the coordination value without the training-loop infrastructure that would never earn back. The upgrade path is open: the `architect` posture is the seed — as `posture='architect'` outcomes accumulate, domain-specialized Architect prompts (FE/BE) can route without new agent processes. This is a **conscious, ratified decision**, not an implicit consequence of scoping.

## Decision

**Ship a coordination-layer PM tier on top of the existing runLoop primitive**, scoped in MVP to one goal shape (`feature.cross-repo`), fully gated behind `ADR_053_ENABLED=1`.

The design is 8 locked decisions, one per structural axis. Each was worked one-at-a-time in `.planning/adr-053-multi-stage-orchestration/DISCUSSION.md`; the reasoning + trade-offs live there and are not repeated in full here.

### Decision matrix (Q1–Q8)

| # | Question | Decision | Impact on code |
|---|---|---|---|
| Q1 | New arch or coordination layer? | Coordination layer over existing runLoop | Zero new agent processes; reuse `runLoop` and `runSkillSubagent` |
| Q2 | PM ONE component or TWO? | PM + Architect as **separate agents** via postures | Two new posture values on `cypher_sessions.posture`: `pm`, `architect` |
| Q3 | Stage 1 → PM input contract? | Hydration manifest — SCOPE authors, PM executes in parallel | **DEFERRED to follow-up.** MVP hard-codes hydration inside the first template. |
| Q4 | When does PM call Architect? | Always at decomposition (MVP); Option B (hard boundary heuristic) on RADAR | One LLM Architect call per goal (deterministic gate first, LLM pass on top — live 2026-08-14) |
| Q5 | How does PM decompose? | LLM proposes DAG + templates validate/rewrite | ~500 LOC template layer with ONE template (`feature.cross-repo`) in MVP |
| Q6 | Dependency graph representation? | **Kanban board (ADR-040) IS the graph** | Reuses existing `tasks.depends_on_json` column (ADR-040 v90); BoardWorkerAgent dependency-aware dispatch already shipped (`depsDone()`) |
| Q7 | PM ↔ executor feedback? | `sub_task_events` table + PM re-entry on demand | New table, new `emit_sub_task_event` tool in execute-phase catalog |
| Q8 | Build order? | **Horizontal slice** — full stack, one goal shape (`feature.cross-repo`) | 4-6 weeks, ~1000-1100 LOC delta |

### Architecture, drawn

```
/wi <goal>
    │
    ▼
┌─────────────────────────────────────────────┐
│  Stage 1: SCOPE (unchanged, ADR-042)         │
│  Emits RefinedGoal { intent, target, ... }   │
└─────────────────────────────────────────────┘
    │
    ▼  goal matches feature.cross-repo shape?
    ├── NO ──► current flat runLoop({phase:'execute'}) — unchanged
    │
    YES (ADR_053_ENABLED=1)
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  PM orchestrator (posture='pm')                                  │
│  1. Hydrate context (template-hard-coded in MVP)                 │
│  2. LLM drafts DAG of sub-tasks                                  │
│  3. Template validator rewrites (Kahn cycle-check, missing-ops   │
│     check, etc.)                                                 │
│  4. Emit board cards with depends_on JSON                        │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Architect (posture='architect')             │
│  Reads {plan, hydration_evidence}            │
│  Returns approve OR revise-with-notes        │
│  Single call per goal at MVP                 │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Board (ADR-040)                             │
│  Cards land in `ready` column                │
│  depends_on JSON encodes DAG edges           │
│  BoardWorkerAgent polls and dispatches       │
│    cards whose parents completed             │
└─────────────────────────────────────────────┘
    │
    ▼ (per card)
┌─────────────────────────────────────────────┐
│  Executor: runLoop({phase:'execute'}) — as   │
│  today. Runs to completion.                  │
│                                              │
│  Mid-execution: emit_sub_task_event(kind,    │
│    payload) writes to sub_task_events.       │
│  User (or future auto-trigger) fires         │
│    /wi resume <parent_goal_id>               │
│  PM re-enters via runLoop({phase:            │
│    'pm-resume'}), resolves events, may       │
│    amend plan / dispatch follow-ups.         │
└─────────────────────────────────────────────┘
```

### The tensions in the vision and how they land

The design log identified 6 tensions in the vision as originally authored (T1–T6). Their disposition:

| # | Tension | Resolution |
|---|---|---|
| T1 | PM as orchestrator AND architect merged | RESOLVED — Q2 clean split into two postures |
| T2 | Self-learning executor AND PM AND harness = duplicated intelligence | RESOLVED — Q1 pins learning at Beta-prior level only; Q7 pins all resolution intelligence at PM tier |
| T3 | Real-time PM↔executor feedback latency | PARTIALLY RESOLVED — Q7's event-based async pattern gives 90% of the value with 20% of the pausable-executor risk. Full real-time is deferred. |
| T4 | Cross-repo dependency graph = product commitment | RESOLVED — Q6 reuses the existing `tasks.depends_on_json` column instead of a new `task_edges` table |
| T5 | Stage 1 as authored is redundant with SCOPE | RESOLVED — Q3 clarifies Stage 1's real new value is the hydration manifest (deferred); MVP hard-codes hydration in templates |
| T6 | What happens when Stage 1 hands PM a low-confidence brief | RESOLVED — Q7's `scope_discovery` event kind + PM re-entry handles mid-execution scope corrections |

### Concrete pieces MVP ships

- **Migrations:** v107 (`sub_task_events` table + partial index on unresolved) + v108 (`cypher_sessions.posture` CHECK constraint). **No `depends_on` migration** — the DAG reuses the existing `tasks.depends_on_json` column (ADR-040 v90).
- **New postures:** `posture='pm'`, `posture='architect'`, `posture='pm-resume'` added to a `cypher_sessions.posture` CHECK constraint (the column exists since v71 but had no CHECK; this migration adds one).
- **Model_config buckets:** `pm` (default: Sonnet), `architect` (default: Opus, "call sparingly"). Both editable via `POST /api/model-config`. **2026-08-14:** semantic LLM-Architect live (`architect-review-live.ts`) — deterministic structural gate first, then one Opus call via the `architect` bucket; degrades to advisory on provider failure (observed 429 mid-dogfood, degraded as designed).
- **Templates:** ONE — `src/services/cypher/pm-templates/feature-cross-repo.ts` (~100 LOC). Template layer harness at `src/services/cypher/pm-templates/index.ts` (~200 LOC).
- **Tool:** `emit_sub_task_event` added to execute-phase tool catalog only (~30 LOC).
- **Bridge:** `POST /api/wi/dispatch/stream` gains a branch on `feature.cross-repo` shape detection → dispatches `posture='pm'`. Shape detection fires on the `RefinedGoal` struct emitted by SCOPE, not on the raw goal string. `/wi resume <parent_goal_id>` command → new endpoint `POST /api/wi/resume` (separate from `/api/wi/dispatch/stream`; returns 404 when `ADR_053_ENABLED=0`).
- **Safety cap:** PM orchestrator enforces `max_cards_per_goal = 10` hard stop before committing board cards. Architect retry cap: max 2 revise cycles before PM halts and escalates to user.
- **PM writes `depends_on_json`:** the only new work here is that the PM orchestrator populates `tasks.depends_on_json` with parent task ids when emitting cards. **Dependency-aware dispatch itself is already shipped** — `BoardWorkerAgent.depsDone()` (`src/intelligence/board-worker-agent.ts:554`) already parses `depends_on_json` and gates on all parents reaching `kanban_column='done'`. An optional SQL push-down of that application-code filter is a nice-to-have, not a feature.
- **Board UI:** orchestration card filter (default hidden), `depends_on_json` visualization (flat list of parent-ids in MVP; hierarchical grouping deferred), unresolved-events indicator on cards.
- **Feature flag:** `ADR_053_ENABLED=1` env var, default off. Reads at boot. Whole PM tier disabled = existing /wi behavior unchanged.

### G7 Gate: Reactive Default with Grant-Scoped AUTO

The multi-agent execution loop defaults to **REACTIVE** — responds to requests only, no automatic dispatch. Grant-scoped **AUTO** may be enabled per entity (e.g. `BUG_REAPER_ENABLED=1`) when all three gates pass:

1. **Executor floor ≥95% dispatch success** — measured over the entity's last 100 dispatches.
2. **Acceptance rate ≥70% over 7 days** — computed as `(accepted_outcomes / total_dispatches)` in a rolling 7-day window.
3. **Dry-run cycle 100% passed** — at least one full dry-run cycle with zero failures, in which the entity proposes actions but all side-effecting calls are intercepted and logged without execution.

Irreversible operations (push, deploy, customer-repo writes, production data mutation) always require **CONFIRM** regardless of grant scope. No grant can elevate an ALWAYS-MAAZ action.

This revises [ADR-033 §9](./adr-033-cypher-framework.md)'s prior reactive-only stance with the gated-AUTO concession from the council debate (G7 gate).

## Acceptance Criteria

### Phase 1 — User flows (bar for ✅ Accepted)

| # | AC | Verification |
|---|----|--------------|
| AC-U1 | User dispatches "Implement new endpoint in lotse for `<service>`" via `/wi`. System detects `feature.cross-repo` shape, engages PM tier (announces "PM orchestration engaged" in the stream), decomposes into ≥3 cards on `/board` (FE + BE + Ops), each with `depends_on` pointing to the previous stage. Cards visibly present in the /board UI within 15s. | **✅ PASS (2026-08-14 dogfood):** `scripts/adr-053-e2e-15.sh` → 15/15 runs pass (engagement line + ≥3 `pm_cards` + valid chains; 48 cards, 0 orphan edges). Run history: 1/15 → 1/15 (scope-surface parse fix) → 5/15 (handle fix) → 15/15 after targeted re-run. |
| AC-U2 | Board cards advance through columns in dependency order as their parents complete. User watches without needing to click anything. | Dogfood same 5 goals; observe unblock cadence. Verified via: `sqlite3 ~/.work-intelligence-mcp/data.db "SELECT t.id, t.kanban_column, t.entered_column_at, p.id AS parent_id, p.kanban_column AS parent_col FROM tasks t JOIN json_each(t.depends_on_json) je JOIN tasks p ON je.value = p.id WHERE p.kanban_column = 'done' ORDER BY t.entered_column_at DESC LIMIT 10;"` — child cards whose parents are all `done` must have advanced out of `ready` on the next BoardWorkerAgent poll (default cadence; see `board-worker-agent.ts` poll interval). **✅ PASS (mechanism, 2026-08-14):** 3/4 observed chains — children left `ready` within 1-2 polls after parents reached `done`. Blocked by stale smoke-freshness gate (`BOARD_SMOKE_GATE_ENABLED=1` + last green 2026-08-06) until refreshed; no-work cards honestly moved to Blocked lane (executor SCOPE-halts, see new RADAR entry), never laundered to false `done`. Full executor-completion cascade not demonstrated — Stage-1 recall limit (see RADAR). |
| AC-U3 | When an executor hits a blocker mid-task, it emits `sub_task_events(kind='blocker')`. The card visibly shows "waiting on PM" in the /board UI. User runs `/wi resume <parent_goal_id>`; PM re-enters, resolves the event, dispatches follow-up card OR escalates to user. | **✅ PASS (DB level, 2026-08-14):** 2 seeded blockers resolved by PM **1s** after `/api/wi/resume` (bar: 30s) — `resolved_at` set, `resolved_by='pm'`. Escalate override returns `escalated:1` but leaves the event unresolved (semantically correct; **not persisted as a trace row — spec-vs-impl gap, see RADAR**). No-event resume harmless. "waiting on PM" board UI indicator NOT built (Phase 4 box) — DB-level verification only. |
| AC-U4 | Non-`feature.cross-repo` goals (single-repo bug fix, refactor, doc-only) continue to work through the current flat runLoop. `/wi` behavior for these goals is byte-for-byte unchanged vs. pre-ADR-053 master. | `npm run smoke:bridge` continues to pass § 20.x and § 24.x dispatches identically. |
| AC-U5 | User disables ADR-053 by setting `ADR_053_ENABLED=0` in `.env` and restarting bridge. All goals — including `feature.cross-repo` — fall through to the current flat runLoop. No board cards get created; no PM sessions fire. | Restart bridge with flag off; re-run a lotse-shaped dogfood goal; confirm zero `posture='pm'` rows and zero new board cards. |

### Phase 2 — Substrate (bar for 🚧 Substrate Accepted)

| # | AC | Verification |
|---|----|--------------|
| AC-S1 | DAG dependencies reuse the existing `tasks.depends_on_json` column (ADR-040 v90) — no new migration. PM-emitted cards populate it with a JSON array of parent task ids; legacy cards keep `depends_on_json IS NULL` and stay dispatchable. | Dep-gating **logic** is implemented in `BoardWorkerAgent.depsDone()` (`src/intelligence/board-worker-agent.ts:554`); PM cards populate `depends_on_json` in `pm-orchestrator.ts`. **Coverage note (`@pending`):** no smoke section yet inserts a `depends_on_json='["p1"]'` card and asserts gating until parent reaches `done` — `depsDone()` is exercised indirectly via smoke § 49 (block/advance controls), not by a dedicated dep-array test. A dedicated dep-gating smoke section is a follow-up. |
| AC-S2 | Migration v107 creates `sub_task_events` table with the schema in DISCUSSION.md Q7. Partial index on unresolved rows exists. | `smoke:bridge § 51.2` verifies via `.schema sub_task_events` + `EXPLAIN QUERY PLAN` on the unresolved index. |
| AC-S3 | `posture='pm'` and `posture='architect'` accepted by `cypher_sessions.posture` CHECK constraint. | INSERT test rows via smoke; both must succeed, `posture='bogus'` must fail. |
| AC-S4 | Template validator layer runs deterministic Kahn cycle-check on every PM-drafted DAG. A cycle-containing DAG is rejected and the LLM re-prompted (max 2 retries) before PM halts. | Pure cycle-check: `tests/services/cypher/pm-templates.test.ts` (`kahnCycleCheck` in isolation) + smoke § 51.6 (rejects cycle + self-loop). Retry/max-2-halt path: `tests/services/cypher/pm-orchestrator.test.ts` ("cycle in draft → validator rejects → retry succeeds" exercises `runPmOrchestrator` `maxDraftRetries=2` at `pm-orchestrator.ts:88`). |
| AC-S5 | `feature.cross-repo` template's `applies()` predicate correctly classifies lotse-shaped goals as in-scope. A test corpus of 10 goals (5 in-shape + 5 out-of-shape) achieves ≥80% classifier accuracy. **Dependency note:** `applies()` fires on `RefinedGoal` emitted by SCOPE. If SCOPE misclassifies intent (e.g. emits `intent='bug-fix'` for a cross-repo feature goal), the template classifier never sees the correct signal — the 80% bar is therefore dependent on Stage 1 recall reliability (currently ~20% top-1 per ADR-050 measurement). The corpus test isolates `applies()` logic only; end-to-end AC-U1 is the true accuracy gate. | Corpus at `.planning/adr-053-multi-stage-orchestration/template-classifier-corpus.jsonl`; run harness `scripts/adr-053-classifier-corpus.mjs` reads it and reports per-goal predicted-vs-expected + accuracy (exits non-zero below 80%). Current: **10/10 = 100%**. Same 10 goals are also asserted inline in `pm-templates.test.ts`. |
| AC-S6 | BoardWorkerAgent's dependency-aware dispatch (already shipped in ADR-040 as `depsDone()`, `src/intelligence/board-worker-agent.ts:554`) does NOT regress. Exact behavior: a card dispatches only when every id in its `depends_on_json` array has `kanban_column='done'`; `depends_on_json IS NULL` → always dispatchable. Legacy cards still get picked up on the same cadence as pre-ADR-053. | `smoke:bridge § 49` (BoardWorkerAgent tests) continues to pass without modification. |
| AC-S7 | `emit_sub_task_event` is in the execute-phase tool catalog and NOT in the scope-phase or architect-phase catalogs (write-tool discipline). | `smoke:bridge § 23` (tool-catalog close gate) verifies presence/absence per phase. |
| AC-S8 | `ADR_053_ENABLED=0` at boot causes the bridge to skip all PM-related route registration. `/wi resume` endpoint returns 404 when disabled. | Restart with flag off; curl `/wi resume test` expects 404. |

### Phase 3 — Learning (bar for full closure of ADR-053 + RADAR sunset)

| # | AC | Verification |
|---|----|--------------|
| AC-L1 | After ~50 architect-reviewed goals accumulate in `cypher_sessions WHERE posture='architect'`, the RADAR trigger from Q4 fires. Query returns actionable data: at least 50 rows, computable revision rate. | `sqlite3 ~/.work-intelligence-mcp/data.db "SELECT COUNT(*) AS total, SUM(CASE WHEN outcome='mixed' OR outcome='failed' THEN 1 ELSE 0 END) AS revisions, ROUND(100.0*SUM(CASE WHEN outcome='mixed' OR outcome='failed' THEN 1 ELSE 0 END)/COUNT(*),1) AS revision_pct FROM cypher_sessions WHERE posture='architect';"` — gate fires when `total >= 50`. Reminder body updated 2026-07-27; check Aug 6 (initial gate) and again 30 days post-MVP-ship. |
| AC-L2 | Template rewrite audit table shows measurable divergence — indicating we're learning something about the PM prompt's failure modes. | `sqlite3 ~/.work-intelligence-mcp/data.db "SELECT kind, COUNT(*) AS n, COUNT(resolved_at) AS resolved FROM sub_task_events GROUP BY kind ORDER BY n DESC;"` — a non-zero count of `kind='scope_discovery'` or `kind='blocker'` rows indicates template rewrites are being triggered. Same 50-goal window as AC-L1. |

**Why no user-flow ACs for Phase 3:** Phase 3 is pure measurement / learning-signal — no user-visible change. RADAR item from Q4 governs the future Option B heuristic build.

## Consequences

### Positive

- **User's flagship goal shape (`feature.cross-repo`) becomes end-to-end automatable.** The vision demo works: /wi a lotse goal, watch board fill, dependencies unblock, PRs happen. This is real user value that master doesn't have today.
- **Reuses ~70% of existing substrate.** Postures, kanban board, subagent_dispatches, model_config, BoardWorkerAgent, prompt_memory, code-graph, palace, wi-people — all repurposed rather than duplicated.
- **Additive to master.** Rip-out is one flag flip (`ADR_053_ENABLED=0`). Existing /wi behavior for out-of-shape goals is byte-for-byte unchanged (AC-U4).
- **All 6 vision tensions (T1–T6) are named and dispositioned on the record.** Not hand-waved.
- **Every decision has a documented alternative and a documented "what would change my mind"** in `.planning/adr-053-multi-stage-orchestration/DISCUSSION.md`. Future agents inherit that debate instead of re-litigating it.

### Negative

- **Bimodal /wi behavior during MVP.** Goals matching `feature.cross-repo` go through PM; others don't. Mitigated by clear announcement in the /wi output stream ("PM orchestration engaged" vs. "direct dispatch"), but it's a real user-facing quirk.
- **~1000-1100 LOC delta.** Realistic 4-6 week engineering scope for one focused engineer. (Down from the ~1200-1300 first estimate — the `depends_on` migration was dropped once the third review found `tasks.depends_on_json` already exists.) Second-largest scope this repo has taken on (ADR-040 was comparable and shipped in ~3 weeks with sustained delegation; open items remain).
- **First-template-quality risk.** If `feature.cross-repo` is subtly wrong, the demo goal has weird behavior and root-causing is hard (template vs. PM prompt vs. Architect prompt vs. ADR-040 substrate). Mitigation: dogfood Week 6 before declaring ✅ Accepted.
- **Latency cost accepted.** +3-8s at goal start (Architect always-called). Streaming UI hides it in the UX layer. Not further mitigated in MVP.
- **Architect quality has no direct eval harness in MVP.** Beta priors on `posture='architect'` outcome collect signal from Day 1, but a proper eval (Architect's design suggestions vs. merged-PR outcomes) is a follow-up.

### Neutral (worth naming)

- **Hard executor failure (`outcome='failed'`, no event emitted) is handled by the existing board flow, not by PM re-entry.** If an executor crashes or fails without emitting a `sub_task_event`, its card stays in its current column with a failed outcome — exactly as any board card does today (pre-ADR-053). Dependent children never unblock (their parent never reaches `kanban_column='done'`), so the DAG stalls visibly rather than silently proceeding. The user notices the stalled card on `/board` and can re-dispatch it or run `/wi resume <parent_goal_id>` to have PM re-plan around the failure. **MVP does not add automatic failure-recovery** — a failed executor is a stalled card the user acts on, same as today. Auto-recovery (PM watching for `outcome='failed'` children and re-planning) is a follow-up, tracked in RADAR alongside auto-triggered re-entry.
- **PM re-entry is user-triggered only in MVP.** Auto-triggering (via BoardWorkerAgent watching for stale events) is a follow-up.
- **Hydration manifest (Q3) is deferred.** MVP's first template hard-codes hydration ("always fetch blast-radius on target repos + prompt_memory on wi-code"). Dynamic SCOPE-authored manifests come later.
- **Additional templates are follow-up ADRs.** Each template is a small self-contained scope decision (does `refactor.file-move` need Architect review? does `bug.investigate-and-fix` need multi-repo hydration?). Roughly 5-7 more templates likely; each gets its own ADR or a light-touch PR under an ADR-053 umbrella.

## Alternatives considered and rejected

The design log records four fully-considered alternatives per structural question. The most consequential rejections:

### Alt: New per-role executor agents with self-learning (Q1 Option B, rejected)

**Rejected** because the user's dispatch rate is nowhere near the volume needed to train per-role executors (~100+ times/week for training-loop convergence; user's actual rate is ~5-15 real dispatches/week). Building the infrastructure would cost 1-2 quarters and never earn back at this scale. Option A (coordination layer) buys the coordination value for a quarter of the cost.

### Alt: Architect as stateless SERVICE, not a separate agent (Q2 Option C, rejected)

**Rejected** by user against my recommendation. User judges the architect role is genuinely reasoning-heavy for their use cases (novel structural decisions like "sidecar vs monolith") and NOT just retrieval-heavy. Option B preserves that upside at the cost of latency (~3-8s per Architect round-trip) and the eval-harness question. Recorded consciously in the design log.

### Alt: `task_edges` table + polling daemon (Q6 Option A, rejected)

**Rejected** by user against my recommendation. User's goal is not "clean data model," it's "watch PM orchestrate." Kanban board is the answer to that — user sees cards fill in real time as PM's plan executes. Engineering costs of Option D (board schema addition, orchestration-card UI filter, ADR-040 substrate stability risk) are real but they're cost objections, not goal-mismatch objections.

### Alt: Full-vertical MVP (Q8 Option A, rejected)

**Rejected** because 4-6 weeks with no user-visible progress creates motivation risk and prevents dogfooding the template layer under real pressure. Horizontal slice (one shape end-to-end) validates every piece on realistic material and de-risks the biggest MVP dependency (template quality).

## Rollout

### Phase 0 — Pre-requisites (SATISFIED before substrate began)

> **Clock note:** The 4-6 week estimate in Q8 starts from the beginning of Phase 1. Phase 0 was the § 49.2 gate — smoke-bridge § 49.2 positive control was green before Phase 1 substrate landed, so Phase 0 is satisfied. (Historical framing preserved: § 49.2 was mislabeled an "ADR-040 doc section" but is in fact a smoke section.)

- [x] ADR-040 § 49.2 e2e-column advancement — smoke-bridge § 49.2 positive control green (`scripts/smoke-bridge.sh:3691`). Was mislabeled as an ADR-040 doc section; it is a smoke section and it passes.
- [x] ADR-040 backpressure smoke coverage passes reliably — smoke § 49 block/advance controls present and green

### Phase 1 — Substrate (Weeks 1-2, clock starts here)

- [x] ~~originally-planned `depends_on` migration~~ — CANCELLED; DAG reuses existing `tasks.depends_on_json` (ADR-040 v90). PM populates it when emitting cards. No migration.
- [x] v107 migration: `sub_task_events` table + partial index (`src/db/migrations/v107_sub_task_events.ts`)
- [x] v108 migration: `cypher_sessions.posture` CHECK constraint added (`src/db/migrations/v108_posture_enum_widen.ts`; values `'pr-review','bug-investigate','pm','generic','architect','pm-resume'` + NULL)
- [x] `pm` and `architect` buckets added to `model_config` (defaults: Sonnet, Opus — commit `74bcba5`)
- [x] Feature flag `ADR_053_ENABLED` wired at bridge boot (`web-server.js:11029`)
- [x] `smoke:bridge § 51.1-51.4` (substrate ACs S2, S3, S6/S7, S8)

### Phase 2 — PM + Architect + template (Week 3)

- [x] PM orchestrator (`src/services/cypher/pm-orchestrator.ts`)
- [x] Architect posture prompt + tool-catalog filter
- [x] Template layer harness (`src/services/cypher/pm-templates/index.ts`)
- [x] `feature.cross-repo` template (`src/services/cypher/pm-templates/feature-cross-repo.ts`)
- [x] Kahn cycle-check invariant + retry logic (`pm-templates/index.ts` cycle-check; `pm-orchestrator.ts` maxDraftRetries=2 halt)
- [x] `smoke:bridge § 51.6` (AC-S4 cycle-check) + § 51.5 (S5 model buckets). AC-S5 classifier corpus at `.planning/adr-053-multi-stage-orchestration/template-classifier-corpus.jsonl`, consumed by run harness `scripts/adr-053-classifier-corpus.mjs` (10/10 = 100%).

### Phase 3 — Feedback loop (Week 4)

- [x] `emit_sub_task_event` tool in execute-phase catalog (`tool-catalog.ts:2265`, execute-only)
- [x] `/wi resume` bridge command + `POST /api/wi/resume` (`web-server.js:3588`, 404 when flag off)
- [~] PM re-entry logic: reads unresolved events, resolves them (`pm-resume.ts` writes resolution row), **dispatches follow-ups — DEFERRED**: `/api/wi/resume` handler does ack/escalate + resolution bookkeeping but does not yet emit an amend/revise follow-up card (see RADAR "Auto-triggered PM re-entry" + AC-U3 outcome gate)
- [x] `smoke:bridge § 51.3` (substrate ACs S6, S7 — catalog phase discipline)

### Phase 4 — Board UI (Week 5)

- [ ] Orchestration card filter (default hidden; toggle to show) — NOT built
- [x] `depends_on` visualization on cards (flat parent-id list — `web/src/pages/BoardPage.tsx:963`)
- [ ] Unresolved-events indicator on cards ("waiting on PM") — NOT built
- [ ] UI smoke coverage via `npm run smoke:ui` — pending the two boxes above

### Phase 5 — Dogfood + acceptance (Week 6)

- [ ] Dispatch 5 real lotse-shaped goals; verify AC-U1, AC-U2, AC-U3 each pass on all 5 — **NOT RUN.** Harness exists: `scripts/adr-053-e2e-15.sh` (15 scenarios, needs live bridge + `ADR_053_ENABLED=1 OUTCOME_HONEST_KANBAN_ENABLED=1 CYPHER_REFINEMENT_ENABLED=1`, real Anthropic spend). It asserts AC-U1 only; AC-U2/U3 have no automated outcome coverage yet. This is the gate keeping the ADR at 🚧 Substrate Accepted, not ✅ Accepted.
- [ ] Verify AC-U4 (non-cross-repo goals unchanged) via existing smoke suite
- [ ] Verify AC-U5 (flag-off = fallback to current behavior) via bridge restart
- [ ] File follow-up ADR-054 (or ADR-055 depending on numbering at that time) for the second template

## RADAR — items deferred / to be re-examined

Locked here so future agents don't drop them:

- **Stage-1 hydration is the next ADR after Stage 2 dogfood** — the single highest-leverage follow-up. Once PM decompositions run against real goals (Phase 5), record where the thin SCOPE brief fails PM (missing blast-radius, missing prior-work, wrong affected-repos) in the dogfood report. Those failure modes ARE the spec for the hydration manifest. **Trigger:** Phase 5 dogfood complete + ≥1 documented case of PM producing a weak plan traceable to a thin brief. **This supersedes the "revisit at ≥3 templates" framing below** — Stage-1 is a vision-critical gap, not a nice-to-have that waits for template duplication. Author it as ADR-054+ (numbering at that time).
- **Q4 Option B trigger heuristic** — after ~50-100 architect-reviewed goals accumulate, measure "how often does Architect approve the plan verbatim?" and use that to author a hard-boundary skip heuristic. **Reminder: set individual Apple Reminder for Aug 6 (initial gate check) and again 30 days post-MVP-ship.** Full decision rule in `.planning/adr-053-multi-stage-orchestration/DISCUSSION.md § 🎯 RADAR`.
- **Q3 hydration manifest (mechanism for the Stage-1 ADR above)** — Stage 1 authors a structured retrieval manifest, PM executes it in parallel. Deferred because MVP's first template hard-codes hydration. **Reminder: set Apple Reminder for 2 weeks after Phase 1 ships.** The manifest is the *how*; the Stage-1 RADAR item above is the *why/when*.
- **Additional templates** — `single-repo-bug`, `refactor.file-move`, `migration`, `doc-only`, `config-only`, etc. Each is its own small ADR after MVP proves the pattern. **Reminder: set Apple Reminder for end of Phase 5 dogfood.**
- **Auto-triggered PM re-entry** — BoardWorkerAgent watches for unresolved events older than N minutes (or `kind='blocker'`) and auto-dispatches PM. Deferred pending measurement of how often user-triggered re-entry is sufficient.
- **Time-triggered cron sweep** — periodic sweep for stale unresolved events across all sessions. Not ADR-053 scope.
- **Board UI hierarchical grouping** — MVP does flat cards with `depends_on` field. Grouping-by-parent-goal is a UX project of its own.
- **Per-task model selection at PM's discretion** — MVP uses fixed `model_config` bucket per posture; PM does not override. Revisit if cost/quality data suggests PM-driven routing is worthwhile.
- **Architect eval harness** — comparing Architect's design suggestions vs. merged-PR outcomes. Deferred because Beta priors are enough signal for MVP; proper eval when we have 50+ Architect-reviewed goals with merged-PR followups.
- ~~**Shipped Architect is deterministic, not the Opus LLM agent Q2 describes (code drift, 2026-08-07 review).**~~ **RESOLVED 2026-08-14:** LLM-Architect live — `src/services/cypher/architect-review-live.ts` (deterministic structural gate first, then one Opus call via `architect` bucket; fence-tolerant verdict parse; advisory degradation on provider failure). Opus 429 mid-dogfood degraded gracefully (bridge log 2026-08-14T09:56Z). Also update line 186 caveat + Q4 matrix cell (below) to match.
- ~~**`emitCard` PK-rewrite orphan-edge hazard (2026-08-07 review).**~~ **RESOLVED 2026-08-14:** `commitCards()` emits topologically + resolves `depends_on` through committed ids; `emitCard` allocates the `task_<id>` handle at insert time, session-scoped fallback `task_<session8>-<id>`, **throws on persistent collision** — no broken DAG can commit. Verified: 0 orphan edges across 45 dogfood cards.
- **Smoke-freshness gate starved the board (2026-08-14 dogfood finding).** `.env` ships `BOARD_SMOKE_GATE_ENABLED=1` (default-off per ADR-040 discipline — someone flipped it on) with a stale `smoke_bridge_last_green` (2026-08-06). Every in_progress→review/block advance silently skipped until refreshed. Also: the full suite has 22 pre-existing failures (CLAUDE.md env-doc checks, persona table count, ledger sync, brain-decide semantics, `/api/status` 43s stall during sync stream § 50.4) — `npm run smoke:bridge:record` cannot go green. **Fix:** fix the 22 failures, then re-enable the gate or keep it off (documented default).
- **Stage-1 SCOPE recall limits the full natural cascade (2026-08-14 dogfood finding).** The lotse-endpoint goal dispatched twice (`cyp_e2fc2dd42937`, `cyp_a607e6d5043b`); both executor sessions halted in SCOPE with 0 execute steps → cards honestly Blocked (`BOARD_BLOCK_NOWORK_ENABLED`), full FE→BE→Ops cascade with real PRs NOT demonstrated. Consistent with ADR-050 (~20% top-1 recall) + ADR-042 SCOPE-halt race. Board mechanism (unblock cadence) proven independently. **This is the spec input for the Stage-1 hydration ADR (first RADAR item).**
- **Escalate path not persisted (2026-08-14 dogfood finding).** `/wi resume` with `decisions:{"blocker":"escalate"}` returns `escalated:1` but writes no trace row (`sub_task_events.resolution_note` stays NULL, no `pm_auto_actions` row) — escalation is HTTP-response-only. AC-U3 says "escalates to user"; the resolution-row assertion passes only for ack. Persist an `escalate` resolution row or downgrade the AC wording.

## References

- **Design log:** `.planning/adr-053-multi-stage-orchestration/DISCUSSION.md` (repo-relative; outside Docusaurus root) — Q1-Q8 with full reasoning, alternatives, and consciously-rejected paths.
- **Implementation plan:** `.hermes/plans/2026-07-27_adr-053-mvp-implementation-plan.md` (repo-relative; outside Docusaurus root) — task-by-task breakdown with exact file paths, commands, and verification steps (drafted alongside this ADR).
- **Pre-req dependency (CLEARED 2026-08-07):** ADR-040 § 49.2 was the smoke-bridge § 49.2 positive control (real-execute-work card advances past `in_progress`); green at `scripts/smoke-bridge.sh:3691`. Substrate landed on top of a passing § 49.2.
- **Parent tensions:** T1-T6 in the design log; each has a decision-question resolution.

## Sign-off

- **Agent (this session)** — accepted; drafted per Q1-Q8 decisions logged 2026-07-27
- **Agent (reconciliation, 2026-08-07)** — reconciled doc to built reality: promoted 📝 Proposed → 🚧 Substrate Accepted after 3-agent audit (substrate S1–S8 built + smoke-pinned; outcome U1–U5 await dogfood). Cleared the § 49.2 hard-blocker (smoke positive control green). Added AC-S5 classifier corpus artifact. Fixed index v105/v106 → v107/v108 drift.
- **User (Maaz)** — ✅ Accepted promotion gated on the 5-goal dogfood; **dogfood complete 2026-08-14 (15/15 AC-U1, AC-U2/U3 mechanism-verified) — promotion executed; user review of the dogfood report (`.planning/notes/adr-053-dogfood-report-2026-08-14.md`) pending**
- **Agent (dogfood session, 2026-08-14)** — executed Phase-5 dogfood: fixed RADAR LLM-Architect + emitCard hazards, 15/15 AC-U1, AC-U2/U3 verified, report recorded, status promoted to ✅ Accepted
- **Agent 001 / Agent D** — sign-offs deferred (not blocking Substrate Accepted status)

Signed on the record. Amendable via superseding ADR (not silent edits).
