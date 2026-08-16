---
sidebar_label: "ADR-043: PM Orchestration Layer"
sidebar_position: 43
title: "ADR-043: PM Orchestration Layer — Conversation → Prioritized Backlog"
status: Accepted (Phases 1+2 / Shapes C+B, 2026-07-18) — /pm capture + ranker + board + endpoints live-verified (smoke:pm 19/19, smoke:pm:scenarios 17/17, >3d dogfood). Phase 3 (Shape A / AC-A1 autonomous capture) still Substrate Accepted, dormant behind PM_AGENT_ENABLED + WI_STAGE1_ENABLED, gated on ADR-042.
date: 2026-07-15
---

# ADR-043: PM Orchestration Layer — Conversation → Prioritized, Assignable Backlog

**Status:** ✅ **Accepted (Phases 1+2 / Shapes C+B) — 2026-07-18.** Phase 1 (Shape C — data + ranker + endpoints + BoardWorkerAgent filter) and Phase 2 (Shape B — `/pm` skill) are **live-verified** against organic usage: `PM_ORCHESTRATION_ENABLED=1` on since 2026-07-15 (>3 days dogfood, 84 non-smoke cards), `smoke:pm` 19/19 and `smoke:pm:scenarios` 17/17 green (re-run 2026-07-18, HEAD `6d93293`), no ranker/priority drift. **Phase 3 (Shape A) remains 🚧 Substrate Accepted** — `capturePmTicket()` + `mapRefinedIntent()` (task-memory.ts), `PMAgent` tenant (pm-agent.ts), migration v100, and the AC-A1 intent-routing hook in `loop.ts` are all landed but **dormant** behind `WI_STAGE1_ENABLED=1 AND PM_ORCHESTRATION_ENABLED=1`, and AC-A1 cannot be live-verified until ADR-042 Stage 1 reliably produces `refined_goal.intent`. Shape A acceptance is tracked separately and gated on ADR-042 (card `tsk_7081cc8f6a4a`).

> **Quick ref**
> - **Use now (Phases 1+2):** `PM_ORCHESTRATION_ENABLED=1` + `OUTCOME_HONEST_KANBAN_ENABLED=1`
> - **Skill:** `skills/wi-pm/SKILL.md` — `/pm capture`, `/pm next`, `/pm backlog`, `/pm prioritize`
> - **Smoke:** `npm run smoke:pm` (19/19), `npm run smoke:pm:scenarios` (17/17)
> - **API:** `GET /api/board/backlog`, `POST /api/board/tasks`
> - **Phase 3 (dormant):** also needs `PM_AGENT_ENABLED=1` + `WI_STAGE1_ENABLED=1` — gated on [ADR-042](./adr-042-prompt-generation-stage.md) outcome acceptance

**Related:**
- [ADR-040](./adr-040-outcome-honest-delivery-kanban.md) — the Kanban board (`tasks`/`workers`/`/board`). ADR-043's backlog IS the ADR-040 board, extended with priority/effort/intent and a PM brain on top. The board is the *substrate*; ADR-043 is the *manager*.
- [ADR-042](./adr-042-prompt-generation-stage.md) — 3-stage Cypher (prompt-gen → planner → executor). **Load-bearing dependency for Shape A:** the PM's autonomous capture hook consumes `refined_goal.intent` produced by Stage 1. Shape A cannot land before ADR-042 does.
- [ADR-033](./adr-033-cypher-framework.md) — Cypher. The PM decides *what* Cypher works on next; Cypher decides *how*.
- `.claude/rules/adr-vs-ticket.md` — decision→ADR, build/fix→board card. The PM is the mechanism that files those cards from conversation, closing the ADR-041-class miscategorization at the source (LLM intent-classification + user confirmation replaces "the agent reads the rule and picks").
- **Housekeeping:** ✅ resolved (2026-07-16) — the legacy draft that shared this number was renumbered to `.planning/drafts/adr-045-general-task-fallback-draft.md` (2026-07-13, GAP-003 Tier 3 topic — unrelated; its internal title + AC-IDs bumped to ADR-045). Note: 044 was already taken by the fetcher-module ADR, so 045 is the free slot. The numbering collision no longer blocks landing.

---

## Context

**User vision (2026-07-15, verbatim intent):** *"I keep talking to you, discussing new problems and tasks, we design ADRs and you implement. But all this should sit under one dedicated PM — agent or skill, not sure yet. If I ask you to execute/plan/brainstorm, the PM should know about it. Actual orchestration — but not by making a planning document inside `.claude`; make actual documents, tickets, assign weight, prioritize, assign to a worker. And when I ask 'what's needed', the PM gives me: this is the backlog, this comes first."*

**The problem in user terms:** work is born in conversation (brainstorm → ADR → implement) but lives nowhere durable and prioritized. It scatters across `.claude/plans/*.md` scratch files, ADRs (some miscategorized — see ADR-041), and memory. There is no single surface that answers *"what is the backlog, and what should I do first?"* The user has to hold priority in their head.

**Why now:** the board (ADR-040) exists and was just cleaned of pollution, so there's a trustworthy `tasks`/`workers` substrate to build the PM on. What's missing is the **brain**: (1) turning conversation into real tickets, (2) weighting/prioritizing them, (3) answering "what's next."

**The observation surface is not a gap.** Cypher already sees every `/wi` dispatch and persists it as a `cypher_sessions` row with `goal`, `refined_goal`, `chosen_skill`, `outcome`. That's the conversation. There is no separate chat-hook missing — the hook has 855 rows in it today. Shape A hooks into Cypher's own Stage 1 refiner, not into a new external observer.

**What exists vs. the gap** (grounds this ADR in reuse, not rebuild):

| Vision need | Exists today | Gap ADR-043 fills |
|---|---|---|
| Real tickets w/ state | ✅ ADR-040 `tasks` + `/board` (48 live cards: 12 done / 11 e2e / 3 in_progress / 21 ready / 1 review) | — |
| Assign to worker | ✅ `workers` (4 slots) + `BoardWorkerAgent` 30s tick | assign by *fit/intent*, not just FIFO on `created_at` |
| Priority / effort | ❌ | **new: `priority` + `effort_points` + `intent` columns + ranker** |
| "What's next / backlog?" | ❌ | **new: `computeBacklogRank()` + `GET /api/board/backlog`** |
| Conversation → ticket | ❌ (manual via ADR/plan) | **new: `/pm capture` skill + Cypher Stage 1 intent-routing hook** |
| Observe the conversation | ✅ `cypher_sessions` is the conversation | — (was mistakenly framed as a gap in v1) |
| Route execute/plan/brainstorm | ✅ Cypher dispatch | PM decides *what* to route |

## Decision

Build a **PM Orchestration Layer** over the existing board, in three capabilities:

1. **CAPTURE** — turn conversation into a real board card. Two entry paths:
   - **Explicit (Shape B, `/pm capture`):** user runs the skill; LLM proposes `title / intent / priority / effort_points`; user confirms.
   - **Autonomous (Shape A, via Cypher):** Cypher Stage 1 (ADR-042) classifies `refined_goal.intent`; when intent is non-execute (`brainstorm | plan | decide`), Cypher short-circuits — instead of dispatching Stage 2, it files a card and closes the session with `outcome='captured_to_board'`. Same `POST /api/board/tasks` primitive both paths use.
2. **PRIORITIZE** — every card carries `priority` (0-100, user-set or LLM-proposed) and `effort_points` (nullable Fibonacci: 1/2/3/5/8/13) and `intent`. A pure function `computeBacklogRank(db)` produces a ranked backlog; blocked and dep-unready cards sink; age bumps `ready` cards slowly.
3. **ANSWER** — `/pm next`, `/pm backlog` return the ranked backlog with **explicit per-signal contributions** (see AC-U2 for the pinned schema — not a black-box "why"). Queryable in plain language.

```mermaid
flowchart LR
    U([user: /wi &lt;anything&gt;]) --> S1[Cypher Stage 1<br/>ADR-042 refiner<br/>classifies intent]
    S1 -->|intent=execute| S2[Stage 2 Planner<br/>→ Stage 3 Executor]
    S1 -->|intent∈{brainstorm,plan,decide}| CAP
    U -.->|/pm capture &lt;text&gt;| CAP

    subgraph PM [PM Orchestration Layer]
      CAP[CAPTURE → POST /api/board/tasks<br/>title, intent, priority, effort_points]
      PRI[PRIORITIZE → computeBacklogRank<br/>PMAgent 30s tick refreshes]
      ANS[ANSWER → GET /api/board/backlog<br/>/pm next, /pm backlog]
    end

    CAP --> B[(ADR-040 board:<br/>tasks + workers)]
    B --> PRI
    PRI --> ANS
    B -->|BoardWorkerAgent picks<br/>WHERE intent='execute'<br/>ORDER BY rank_score| DIS[dispatch → Cypher execute path]
    ANS --> U2([user: 'this is the backlog,<br/>do this first'])

    style PM fill:#e8f4ff
    style S1 fill:#fff0d0
```

**The PM does NOT replace Cypher or the board.** It sits above them: board = storage, Cypher = execution, **PM = what-to-work-on-and-why**. The intent-routing hook is a *choice inside Cypher's refiner*, not a competing orchestrator.

### The ranker (initial formula — tune from logs, not from theory)

```
rank_score =
    priority                                          # 0..100, user- or LLM-set
  - blocked_penalty      (999 if blocked=1 else 0)    # blocked sinks below all
  - deps_penalty         (100 × count_deps_not_done)  # unready deps sink hard
  + age_bonus            (min(30, days_since_created))# stale ready cards float
  - effort_penalty       (effort_points × 0.5 or 0)   # small tilt to easy first
```

Store `rank_score` as a **computed value at query time** (not persisted) so tuning weights doesn't need migrations. Log the per-pickup scores for 1 week; adjust weights when a real "wrong top card" is observed. Every returned item includes its `reasons: [{signal, value, weight, contribution}]` breakdown (AC-U2).

## Shape sequencing — resolved (was "open question")

The v1 of this ADR framed A/B/C as an *undecided user choice*. The revision resolves it: **sequencing is dependency-ordered, not risk-ordered.** Each shape is a proper superset of the prior; each is independently shippable and reversible.

| Shape | What it is | Depends on | Ships when |
|---|---|---|---|
| **C — data + ranker + endpoint** | `priority`/`effort_points`/`intent` columns, `computeBacklogRank()`, `GET /api/board/backlog`, `POST /api/board/tasks`, `BoardWorkerAgent` filters `intent='execute'` + orders by `rank_score` | Nothing new (all substrate exists) | **Phase 1 — Day 1, unconditional** |
| **B — `/pm` skill** | `/pm capture`, `/pm next`, `/pm backlog`, `/pm prioritize`, `/pm effort` | Shape C | **Phase 2 — Day 3-4, after 3+ days dogfood of C** |
| **A — Cypher intent-routing + PMAgent tenant** | Cypher Stage 1 hook: non-execute intent → `capturePmTicket()` instead of Stage 2. `PMAgent` tenant (patterned on `BoardWorkerAgent`) for ranker refresh, dedup via v98 embeddings, staleness flags | Shape B **+ ADR-042 Stage 1 landing** | **Phase 3 — after ADR-042 accepts** |

Shape A is not aspirational infrastructure work — it's **~220 LOC across three files** once ADR-042 exists: a hook at the SCOPE→EXECUTE boundary (`loop.ts` area), a `capturePmTicket()` helper, and a `PMAgent` tenant mirroring the existing `BoardWorkerAgent`.

## Acceptance Criteria

> Per `.claude/rules/outcome-honesty.md`, user-flow ACs come first. **Phases 1+2 (Shapes C+B) verified 2026-07-18.** Phase 3 (Shape A) substrate verified; live AC-A1 gated on ADR-042.

### Phase 1 (Shape C) — Substrate

| # | AC | Verification |
|---|----|--------------|
| AC-S1 | Migration `v99_adr043_pm_layer.ts` adds `priority INTEGER NOT NULL DEFAULT 50`, `effort_points INTEGER NULL CHECK (effort_points IS NULL OR effort_points IN (1,2,3,5,8,13))`, `intent TEXT NOT NULL DEFAULT 'execute' CHECK (intent IN ('brainstorm','plan','execute','decide'))`, and index `tasks_backlog_rank_idx(intent, kanban_column, priority DESC, created_at)`. | schema check; existing 48 rows keep defaults, no rebuild. |
| AC-S2 | `POST /api/board/tasks` accepts `{title, goal_text, acceptance_text, intent, priority, effort_points, depends_on_json?}` and returns the created row. Same auth/flag envelope as `PATCH /api/board/tasks/:id`. | curl create → `GET /api/board/tasks` shows it. |
| AC-S3 | `computeBacklogRank(db)` returns tasks ordered by `rank_score` desc; blocked and dep-unready cards sink; formula terms observable in `reasons`. | unit test with 8 fixture rows exercising each formula term. |
| AC-S4 | `GET /api/board/backlog?limit=20` returns `{top_task_id, backlog: [{id, rank_score, reasons: [{signal,value,weight,contribution}]}]}`. `sum(contribution) == rank_score ± 0.01`. | curl smoke + unit test on contribution sum invariant. |
| AC-S5 | `BoardWorkerAgent` filters `WHERE intent = 'execute'` when advancing `ready → in_progress`; brainstorm/plan/decide cards stay in `ready` until user promotes. Cards ordered by `rank_score` desc, not `created_at`. | unit test: high-priority execute card jumps FIFO; brainstorm card is never picked. |
| AC-R1 | Env flag `PM_ORCHESTRATION_ENABLED` gates the new endpoints, ranker, and BoardWorkerAgent behavior. `=0` (default) keeps the board on today's ADR-040 semantics. | toggle test. |

### Phase 2 (Shape B) — User flows via `/pm` skill

| # | AC | Verification |
|---|----|--------------|
| AC-U1 | User runs `/pm capture &lt;text&gt;` → LLM proposes `{title, intent, priority, effort_points}` inline → user confirms → a real board card exists. Not a `.claude/plans` file. | smoke: capture → `GET /api/board/tasks` shows it with all four PM fields populated. |
| AC-U2 | User runs `/pm next` → returns the top card with `rank_score` and `reasons` breakdown. Contributions sum to score (invariant from AC-S4). User can read *why* this card is top (not just that it is). | smoke: assert response shape matches pinned JSON schema; assert top-card `rank_score` == `max(backlog[].rank_score)`. |
| AC-U3 | User runs `/pm prioritize &lt;id&gt; &lt;N&gt;` (or `/pm bump &lt;id&gt;`) → subsequent `/pm next` reflects new order. | smoke: mutate → re-query → order changed. |
| AC-U4 | Skill discoverable by trigger phrases (`backlog`, `what's next`, `what should I do`, `add to backlog`, `prioritize`) via existing `skill-discovery.ts`. Mirrored into `~/.hermes/skills/` per cross-agent-skill-sharing. | `SELECT * FROM skill_catalog WHERE skill_name='/pm'`. |

### Phase 3 (Shape A) — Autonomous capture via Cypher

| # | AC | Verification |
|---|----|--------------|
| AC-A1 | Cypher Stage 1 (ADR-042) classifies `refined_goal.intent`. When intent ∈ `{brainstorm, plan, decide}`, Cypher does NOT dispatch Stage 2 — it calls `capturePmTicket(db, session, refined_goal)`, closes the session with `outcome='captured_to_board'`, and surfaces `"filed as card #N in ready. /pm next for backlog."` **Note (2026-07-15):** `refined_goal.intent` is a free-form verb (`investigate\|build\|fix\|…`), NOT the 4-value enum — `mapRefinedIntent()` bridges the two (doing-verbs→execute→NOT captured; brainstorm/plan/decide→captured). The hook (`shouldCaptureToBoard`/`captureToBoard` in `pm-capture-hook.ts` + the guarded block in `loop.ts`) is **dormant** until `WI_STAGE1_ENABLED=1 AND PM_ORCHESTRATION_ENABLED=1`. | Logic unit-tested (`tests/board/pm-phase3.test.ts` — flag gating, verb→enum, non-execute routing, malformed-goal fallback, surface string). **Live end-to-end smoke gated on ADR-042 Stage 1 landing.** |
| AC-A2 | Mid-session capture: Cypher during Stage 3 can call `capturePmTicket()` with `parent_task_id = current_task` to file follow-up work without derailing the current session. | ✅ unit test — `capturePmTicket` with `parent_task_id` links the child card; `pm-phase3.test.ts`. |
| AC-A3 | `PMAgent` tenant registered next to `BoardWorkerAgent`. 30s tick: refresh `rank_score` (query-time recompute for observability — not persisted, per § ranker); flag `stalled=1` on cards in `ready > PM_STALL_DAYS` (default 14, reusing the v97 flag); un-stall re-touched cards. **Dedup (Q-3) deferred** per the ADR (needs a worker thread to stay non-blocking; reuses v98 machinery when it lands). | ✅ agent registered in `web-server.js` boot (gated); tick unit-tested (rank recompute, stall flag, un-stall, disabled no-op) — `pm-phase3.test.ts`. |
| AC-A4 | Env flag `PM_AGENT_ENABLED=0` default-off (per AC-R1 rollout safety). Flip is one env var + restart; no code change. Rollback = `=0` + restart. | ✅ unit test — tick returns `skipped='disabled'` when flag off; registration skipped in boot when `PM_AGENT_ENABLED!=1`. |
| AC-R2 | CAPTURE (either path) NEVER triggers dispatch/execution automatically — brainstorm/plan/decide cards sit in `ready` until user promotes them via `/pm bump` or PATCH. | ✅ unit test — captured non-execute card is absent from the BoardWorkerAgent pick filter (`intent='execute'` clause); double-guaranteed by the `tsk_` prefix. |

## Operations

### Env flags

| Flag | Default | Phase | Effect |
|------|---------|-------|--------|
| `PM_ORCHESTRATION_ENABLED` | `0` | 1+2 | `=1` → ranker, backlog endpoint, BoardWorkerAgent intent filter, `/pm` skill endpoints |
| `PM_AGENT_ENABLED` | `0` | 3 | `=1` → PMAgent tenant registers (stall flags, rank refresh) |
| `PM_AGENT_INTERVAL_MS` | `30000` | 3 | PMAgent tick cadence |
| `PM_STALL_DAYS` | `14` | 3 | Days in `ready` before `stalled=1` |
| `WI_STAGE1_ENABLED` | `0` | 3 | Required for AC-A1 live hook (ADR-042 dependency) |
| `OUTCOME_HONEST_KANBAN_ENABLED` | — | all | Board substrate prerequisite |

### Ship / rollback

- **Ship order**: Phase 1 (Day 1) → dogfood 3 days → Phase 2 (Day 3-4) → dogfood while ADR-042 lands → Phase 3.
- **Effort**: Phase 1 ~230 LOC, Phase 2 ~200 LOC, Phase 3 ~220 LOC. Total ~650 LOC across three shippable slices.
- **Rollback**: `PM_ORCHESTRATION_ENABLED=0` reverts board to ADR-040 semantics; `PM_AGENT_ENABLED=0` disables autonomous capture while keeping `/pm` skill usable. Data columns stay (harmless with defaults).
- **Numbering housekeeping**: ✅ done (2026-07-16) — renumbered draft to `adr-045-general-task-fallback-draft.md`.

## Consequences

### Positive
- One durable, prioritized backlog replaces scattered plans/ADRs/memory as the source of "what's next."
- Reuses ADR-040 board + workers + v98 embeddings — mostly integration + a brain + one Cypher hook, not a rebuild.
- Fixes the ADR-041-class miscategorization at the source (Cypher classifies intent + files a *ticket* rather than an ADR draft).
- Ranker `reasons` breakdown makes AC-U2 falsifiable in a way "did the response contain 'why'?" would not have been.

### Negative / cost
- Shape A adds an autonomy path (Cypher files cards without asking). Mitigated by (a) Stage 1 already reasoning about intent, (b) capture is idempotent and reversible via delete, (c) flag-gated default-off, (d) no execution consequence — cards sit until promoted.
- Ranker formula is only as good as its inputs; a naive priority ceiling (everything = 100) collapses ranking. Priority-inflation is the failure mode to watch; mitigate by logging pickup scores and reviewing weekly.
- Yet another layer above Cypher — must not become a competing orchestrator. The Stage 1 hook (Shape A) is the *only* PM→Cypher control path; everywhere else Cypher drives.

### Neutral
- `kanban_order` (v90) and `priority` (v99) coexist: `kanban_order` = within-column manual drag position; `priority` = cross-column business rank. Keep both. UI drag-drop semantics unchanged.

## Trade-offs explored

| Alternative | Why deferred/rejected |
|---|---|
| Keep using `.claude/plans` + ADRs | The status quo the user is explicitly moving away from — no priority, no query, scatters. |
| Build Shape A first (autonomy up front) | Depends on ADR-042 (Substrate Accepted, outcome pending); C→B shippable today and de-risks A's contract by proving the primitives it will call. |
| Use an external tracker (Jira/Linear) | The user wants it *in* WI, driven by Cypher's own intent classification — external trackers can't consume `refined_goal.intent`. |
| Persist `rank_score` in the tasks row | Would need migrations to tune weights. Query-time computation with a covering index is fast enough at 48 cards (and will remain so at 500). |
| Add `weight` as a free-form number | Fibonacci `effort_points` with a CHECK constraint gives usable estimation without decision paralysis. User can override the LLM's proposal. |

## Open questions

1. **Q-1 (Shape sequencing):** ~~A/B/C — user decides~~ — **RESOLVED** in the revision: dependency-ordered C→B→A. Shape A gated on ADR-042 Stage 1.
2. **Q-2 (priority setter):** user-only, LLM-proposed, or hybrid? **Proposed:** LLM proposes at capture; user overrides via `/pm prioritize`. Log both to compare drift.
3. **Q-3 (dedup threshold):** at what cosine similarity does PMAgent (Shape A) merge two `ready` cards? **Proposed:** ≥0.90 auto-flag as `parent_task_id` link + surface to user; ≥0.75 surface without linking. Tune from real duplicate observations.
4. **Q-4 (effort setter):** LLM-estimated or user-set at capture? **Proposed:** LLM estimates, user adjusts inline before confirming (same UX as `intent`).
5. **Q-5 (intent granularity):** the 4-value CHECK (`brainstorm/plan/execute/decide`) may be too coarse. Add `research`? `spike`? **Deferred** to first real miscategorization — don't pre-invent buckets.

## Verification snapshot at Substrate Accepted (2026-07-15)

Phase 1+2 verification, taken at commit-time:

- **Master HEAD (Substrate Accepted tip):** `b5012543cfb2` (commit `b501254`, feat(adr-043): /pm skill + dedicated smoke — Phase 2)
- **Branch:** `fix/board-worker-block-nowork` (3 ADR-043 commits: `f54f90e` docs, `4094578` substrate, `b501254` skill+smoke)
- **Schema version:** `v99` (`CURRENT_SCHEMA_VERSION = 99`, migration `v99_adr043_pm_layer.ts` applied to live DB at `~/.work-intelligence-mcp/data.db`)
- **Unit tests:** 16/16 green — `tests/board/ranker.test.ts` (12) + `tests/board/worker-intent-filter.test.ts` (4). Plus 62/62 unaffected existing tests (task-memory 45, c1-worktree 17). `PATH=$HOME/.nvm/versions/node/v24.7.0/bin:$PATH npx vitest run tests/board/ tests/services/cypher/task-memory.test.ts tests/services/cypher/c1-worktree.test.ts`.
- **AC smoke:** `bash scripts/smoke-pm.sh` → 19/19 assertions green (`npm run smoke:pm`).
- **Real-life scenarios:** `bash scripts/smoke-pm-scenarios.sh` → 10 scenarios / 17/17 assertions green (`npm run smoke:pm:scenarios`). Covered:
  1. Morning triage — highest-priority unblocked execute wins
  2. User bump — PATCH priority=100 reorders
  3. Brainstorm capture — sits invisible in default backlog
  4. Dep-chain — dependent sinks to negative rank_score while dep unfinished
  5. Blocked card — sinks below every unblocked card despite priority=100
  6. Effort tiebreak — smaller effort wins on same priority
  7. `/pm next` explanation — contribution-sum invariant holds, 5 signals present
  8. Priority clamp — POST(200)→100, PATCH(-20)→0
  9. Intent promotion — brainstorm→execute surfaces card to pickup
  10. Plan/decide — visible only under intent=all, hidden from default
- **Build/typecheck:** `npm run build` clean, `npx tsc --noEmit` clean.
- **Files landed:**
  - `src/db/migrations/v99_adr043_pm_layer.ts` (new)
  - `src/services/board/ranker.ts` (new, 268 lines)
  - `src/services/cypher/task-memory.ts` (patched — 6 opt-in PM fields, backward-compatible split INSERT+UPDATE)
  - `src/intelligence/board-worker-agent.ts` (patched — `intent='execute'` filter + `ORDER BY priority DESC, created_at ASC`)
  - `web-server.js` (patched — `POST /api/board/tasks`, `GET /api/board/backlog`, `PATCH` extended to accept `priority`/`effort_points`/`intent`)
  - `src/db/schema.ts` (patched — `CURRENT_SCHEMA_VERSION = 99`, v99 wired into migration switch)
  - `skills/wi-pm/SKILL.md` + `~/.claude/skills/work-intelligence/wi-pm/SKILL.md` + `~/.hermes/skills/work-intelligence/wi-pm/SKILL.md` (new)
  - `tests/board/ranker.test.ts` (new)
  - `tests/board/worker-intent-filter.test.ts` (new)
  - `scripts/smoke-pm.sh` + `scripts/smoke-pm-scenarios.sh` (new)
  - `package.json` (added `smoke:pm` + `smoke:pm:scenarios`)

**Path to Accepted:** dogfood 3+ days with `PM_ORCHESTRATION_ENABLED=1`, then re-run scenarios + verify user-flow ACs against organic usage. Not blocked on any external work.

## Verification snapshot at Substrate Accepted — Phase 3 (Shape A) (2026-07-15)

Phase 3 substrate, taken at commit-time:

- **Branch:** `worktree-adr-043-phase3` (isolated git worktree; ADR-042 Stage 1 was being edited concurrently in another terminal — worktree avoids collision on `loop.ts`).
- **Schema version:** `v100` (`CURRENT_SCHEMA_VERSION = 100`, migration `v100_captured_to_board_outcome.ts` widens `cypher_sessions.outcome` CHECK to admit `captured_to_board`; verified on a live-DB copy — widens, idempotent, accepts the value, preserves all 1273 existing outcome rows).
- **Files landed:**
  - `src/db/migrations/v100_captured_to_board_outcome.ts` (new — DROP+ADD dance copied from v87, guards on live CHECK text)
  - `src/services/cypher/task-memory.ts` (patched — `capturePmTicket()` + `mapRefinedIntent()` + `PmIntent` type; execute-intent rejected as a routing error)
  - `src/services/cypher/pm-capture-hook.ts` (new — `shouldCaptureToBoard()` + `captureToBoard()`; extracted so the `loop.ts` insertion stays merge-friendly vs the concurrent ADR-042 edits)
  - `src/services/cypher/loop.ts` (patched — ~12-line guarded AC-A1 block after `persistRefinedGoal`; `Verdict` union + `verdictValue()` + `persistOutcome()` mapping widened for `captured_to_board`)
  - `src/intelligence/pm-agent.ts` (new — `PMAgent` tenant: rank-refresh observability + stall flagging + un-stall; dedup Q-3 deferred)
  - `web-server.js` (patched — `PMAgent` registration behind `PM_AGENT_ENABLED=1`, mirrors BoardWorkerAgent boot block; `PM_AGENT_INTERVAL_MS`/`PM_STALL_DAYS` env)
  - `tests/board/pm-phase3.test.ts` (new — 18 tests: mapRefinedIntent, capturePmTicket, shouldCaptureToBoard/captureToBoard, PMAgent tick)
- **Unit tests:** 18/18 new green; 79/79 across `tests/board/` + `tests/services/cypher/task-memory.test.ts` (no regression — was 61 before, +18 = 79).
- **Build/typecheck:** `npm run build` clean, `npx tsc --noEmit` clean.
- **Env flags added:** `PM_AGENT_ENABLED` (default 0), `PM_AGENT_INTERVAL_MS` (default 30000), `PM_STALL_DAYS` (default 14).

### Honest interpretation

- **What's outcome-verified:** the capture primitive, the routing decision, the intent-enum bridge, the PMAgent tick, and the flag gating are all unit-tested against the real migration chain (v59→v100).
- **What's NOT yet outcome-verified (gated on ADR-042):** the live AC-A1 flow — `/wi <deliberative goal>` → Stage 1 classifies non-execute → card filed → session `captured_to_board`, no Stage 2 dispatch — cannot be exercised end-to-end until ADR-042's `WI_STAGE1_ENABLED` path reliably produces `refined_goal.intent`. The hook is wired and dormant; when Stage 1 lands, flip both flags and the AC-A1 smoke becomes runnable. This is the honest `🚧 Substrate Accepted` boundary per `.claude/rules/outcome-honesty.md`.

### Design decisions made during the build (non-obvious)

- **`captured_to_board` needed a schema migration.** The ADR specified `outcome='captured_to_board'` but the v87 CHECK admits only 6 execution verdicts — closing a captured session would have thrown. v100 widens it. A capture is preserved as its own label (not coalesced to `mixed`) so Beta priors stay clean: no skill ran, so it's not a skill-choice verdict.
- **`refined_goal.intent` is free-form, not the 4-value enum.** The refiner prompt emits `investigate\|build\|fix\|refactor\|ship\|review\|research`; `mapRefinedIntent()` bridges to `brainstorm\|plan\|execute\|decide`, collapsing all doing-verbs to `execute` (dispatched, never captured) and defaulting unknowns to `execute` (fail-safe — a mystery goal is dispatched, not silently parked).
- **The `tsk_` prefix is correct for captured cards.** `createTask` emits `tsk_`, which the BoardWorkerAgent's `id LIKE 'task_%'` filter deliberately skips. Since captured cards are non-execute (and the worker also filters `intent='execute'`), AC-R2 is doubly guaranteed — captured work is a dead-end for the worker until the user promotes it.



**Blocker fixes landed:** BLOCKER-1 (numbering collision) ✅ resolved 2026-07-16 — the draft was renamed to `.planning/drafts/adr-045-general-task-fallback-draft.md` (internal title + AC-IDs bumped to ADR-045; 044 was already the fetcher-module ADR).

## Verification snapshot at acceptance time

**Status → ✅ Accepted (Phases 1+2 / Shapes C+B) — 2026-07-18.** Phase 3 (Shape A / AC-A1 autonomous capture) remains gated on ADR-042 Stage 1 acceptance and stays dormant behind `PM_AGENT_ENABLED` + `WI_STAGE1_ENABLED`; it is NOT covered by this acceptance.

- Master HEAD: `6d93293` (branch `feat/adr-044-s26-fetch-telemetry`; PM layer merged from master)
- Schema version: `v102` (`CURRENT_SCHEMA_VERSION = 102`; v99 PM layer + v100 `captured_to_board` outcome both applied to live DB at `~/.work-intelligence-mcp/data.db`)
- Smoke counts: `smoke:pm` 19/19 ✓, `smoke:pm:scenarios` 10 scenarios / 17 asserts ✓ (re-run 2026-07-18 against the 136-card organic backlog with `PM_ORCHESTRATION_ENABLED=1`)
- Cypher session that closed this work: `cyp_cfd11f739c30`
- Shape reached: C ✓ / B ✓ / A ⏳ (dormant, gated on ADR-042 — see status note above)
- Dogfood: `PM_ORCHESTRATION_ENABLED=1` live since 2026-07-15 (>3 days organic); 84 non-smoke cards on the board; no ranker drift or priority-inflation observed
- Scenario-4 note: the 2 transient failures on first re-run were **stale-fixture brittleness** (a fixed `top 50` window dropped the correctly-dep-penalized card, rank_score ≈ −16.5, out of view in a 136-card backlog), NOT a ranker regression. Fixed by widening the smoke window (mirrors Scenario 5's top-100 pattern) — product behavior unchanged.

## Audit note — AC-A1 wiring bug (2026-07-24)

**Symptom.** Three sessions closed `outcome='captured_to_board'` on 2026-07-17
(`cyp_755240dcf6bd`, `cyp_7c754e38e425`, `cyp_93cd8034f721`) with the AC-A1
surface string (*"Filed as card #N in ready…"*) presented to the user, but
`cypher_sessions.task_id IS NULL` on all three and the `tasks` table contains
zero rows with `intent IN ('brainstorm','plan','decide')` (`SELECT COUNT(*) …`
= 0 out of 281 tasks — every task is `intent='execute'`). The card the
surface string claimed exists does not exist.

**Root cause (A-hypothesis-2, confirmed).** The capture path in `loop.ts`
built a `capturedResult: LoopResult` from `captureToBoard()`'s return but
the `LoopResult` interface has no `task_id` slot, so `cap.task_id` was
dropped on the floor. `persistOutcome()` never wrote to
`cypher_sessions.task_id` for the captured branch. The `captureToBoard()`
call itself succeeded in creating a `tasks` row *for each session* — but
because that path threw somewhere (or because the migration timing meant
the FK guard fired before v100 shipped), the `try/catch` at `loop.ts:1736-1742`
silently swallowed the error and the code fell through past the return. The
result: the user saw a synthesised "captured" surface, no card row exists,
and the session outcome is a **false surface**. See `.hermes/plans/2026-07-24_123139-adr-40-44-gap-fixes.md`
§ Phase A.

**Fix (this branch — feat/adr-043-a1-capture-wiring).**

1. Extend `LoopResult` with optional `task_id` / `card_number` fields.
2. Populate them from `captureToBoard()`'s return.
3. Widen `persistOutcome()` to `UPDATE cypher_sessions SET task_id = COALESCE(task_id, ?)`
   on the captured branch (guarded — non-capture branches are byte-identical
   to today).
4. Convert the swallowed `try/catch` into a **loud HALT** — a capture
   failure now closes the session `outcome='halted'` with the real error
   surfaced, NOT `captured_to_board` with a synthesised false surface. The
   AC-A1 surface promise ("Filed as card #N") must never be a lie.
5. Repair the 3 orphan sessions via `scripts/repair-orphaned-captures.mjs`
   (one-shot, then deleted).
6. New regression test `tests/services/cypher/pm-capture-hook-integration.test.ts`
   locks the `task_id` round-trip contract.
7. `scripts/smoke-pm.sh` § 25.4 exercises the AC-A1 wiring end-to-end.

**Contract:** a session that closes `outcome='captured_to_board'` MUST have
a non-null `task_id` and MUST have a matching `tasks` row with a
non-execute intent in `kanban_column='ready'`. This is now
regression-tested.

**Honest posture.** Phase 3 (Shape A / AC-A1) status stays 🚧 Substrate
Accepted until a live plan-intent dispatch closes `captured_to_board`
end-to-end with the fix in place (Task A9 smoke). The unit test asserts
the wiring; live end-to-end verification through the bridge is the
remaining gate before flipping to ✅ Accepted.
- Blocker fixes landed: numbering-collision resolved (2026-07-16, draft renumbered to ADR-045); **ADR-042 Stage 1 NOT yet accepted → Shape A stays deferred** (tracked on card `tsk_7081cc8f6a4a`)
