---
sidebar_label: "ADR-039: Cypher Refinement Phase"
sidebar_position: 39
title: "ADR-039: Cypher Refinement Phase — Two-Pass Loop for Goal Scope Before Execution"
status: Accepted — AC-7 two-pass loop wired 2026-06-29; dogfood pending
date: 2026-06-26
---

# ADR-039: Cypher Refinement Phase — Two-Pass Loop for Goal Scope Before Execution

**Status:** ✅ **Accepted — AC-7 two-pass loop wired 2026-06-29** (refiner mini-loop body in `runLoop` commit `6e50914`; bridge SCOPE→EXECUTE chain commit `9e04b9b`). The full two-pass behavior is now reachable behind `CYPHER_REFINEMENT_ENABLED=1`. Open ACs at end-of-spec time: AC-13 (`npm run wi:opro:dry-run` script — one-line `package.json` chore), AC-19 (2-week dogfood — calendar-bound), AC-19a (per-phase token-spend telemetry — needs v88 `cypher_steps.phase` column). Originally accepted as substrate 2026-06-26; full behavior reached master 2026-06-29 after the [completeness audit](../../../.planning/cypher/adr-039-audit-2026-06-29.md) found that the T8 rollout commit `f63e54c` had never been merged (substrate was passing smoke only because of stale `dist/` artifacts; rescue in commit `fd41d4c`).

> **AMENDMENT NOTICE (2026-07-15) — partial supersede by [ADR-042](./adr-042-prompt-generation-stage.md).**
> ADR-042 reframes this "SCOPE / refinement phase" as **Stage 1 (Prompt Generation)** of a 3-stage Cypher pipeline and changes the *shape* of the code path. Precise delta:
> - **Survives unchanged:** the `refined_goal` JSON artifact/shape, its persistence to `cypher_sessions.refined_goal` + `scope_iters`, and the `CYPHER_REFINEMENT_ENABLED` gate. Everything in this ADR about *what the refiner produces* still stands.
> - **Superseded:** the *mechanism* — this ADR's multi-round refiner mini-loop (`CYPHER_SCOPE_MAX_ITERS`, 3–4 sequential LLM calls) is replaced by ADR-042's `1a parallel mechanical fetch → 1b single LLM pass → generate|ask`. The 3–4 round loop was the cause of the 60s SCOPE wall-clock halts.
> - **Reason:** ADR-042 § Context + the v98 recognition audit (2026-07-15). This is a *shape* fix, not a rejection — ADR-039's contract is intact; its implementation strategy is being replaced.
> ADR-042 is `📝 Proposed`; until it reaches Substrate-Accepted, this ADR's mechanics remain the shipped behavior.


**Related:**
- [ADR-021](./adr-021-claude-code-research-engine.md) — Claude Code Research Engine. ADR-039 adds a 5th trigger type (`goal_refinement`) to its PromptEvolver + OPRO + TextGrad + A/B machinery.
- [ADR-037](./adr-037-cypher-tool-use-loop.md) — Cypher Tool-Use Loop. ADR-039 splits `runLoop` into a `scope` phase + `execute` phase with shared session, shared catalog, separate system prompts.
- [ADR-034](./adr-034-cypher-learning-autonomy-engine.md) — learning engine. Reused unchanged; the new `user_verdict` signal flows through the same `prompt_outcomes` table (declared inline in `src/db/schema.ts:1202`, not in a migration file).
- [ADR-033](./adr-033-cypher-framework.md) — "tools, not stages" framing. ADR-039 inherits the same pattern: the scope/execute split is a phase boundary on tool catalogs, not new stages.
- [ADR-036](./adr-036-cypher-cli-primary.md) — CLI-primary world. ADR-039's `/wi` two-pass behavior reaches all CLI surfaces uniformly.
- [CYPHER.md](../../../CYPHER.md) — canonical identity. ADR-039 reinforces "Cypher thinks before acting" by making the thinking phase explicit.

---

## Context

Today `/wi <goal>` routes a user's raw text straight into `runLoop`, which interprets the goal implicitly at iteration 0 and starts picking tools. Three structural gaps result:

### 1. Classification asks the wrong question

`classifyClarity()` (`src/services/cypher/clarify.ts`, 257 lines, phase 82c) is a real LLM call with a tool schema. It returns `{ clear, reason, questions[] }` and can ask up to 3 clarifying questions with concrete defaults. The mechanism works — the **framing is wrong**. Read `clarify.ts:65-84`:

> "You are Cypher's ambiguity classifier. Given a user goal and a catalog of available skills, decide whether the goal is specific enough that a single skill is clearly the best fit."

The prompt asks the model to disambiguate **which skill to pick**. Not which env, which version, what "done" looks like, or what's out of scope. So even when clarifying questions fire, they ask "did you mean wi-investigate or wi-jira-analyze?" — never "which env are you targeting?" or "what's the acceptance criteria?"

### 2. The skill / plugin dictionary is catalogued but not consulted during recall

`src/services/cypher/skill-discovery.ts` scans `~/.claude/skills` and `~/.claude/plugins/marketplaces` at boot, upserts the `skill_catalog` table with description, `trigger_phrases`, and `task_classes` from each SKILL.md's frontmatter. The table is read by `fetchCatalogEntries()` to feed the clarifier's skill-pick decision. But:

- `task_classes` frontmatter is **not** consulted by the refiner to decide which signals to pull. A skill tagged `task_classes: [investigate, bug-resolution]` could tell Cypher "this looks investigate-shape → fetch palace + jira + ADRs first" without an LLM call.
- `trigger_phrases` are **not** matched against the user's goal text for cheap pre-classification.
- Plugin-supplied tools are catalogued but **not** dynamically merged into `runLoop`'s tool registry per request.

The dictionary is lost signal during refinement.

### 3. Tool execution is serial even when independent

`runLoop` executes `tool_use` blocks one at a time, even when the model emits multiple in a single response. Anthropic's API supports multi-tool_use per turn, and `Promise.all` would parallelize independent calls in ~15 lines. Today's serial execution makes agentic recall too slow to do well — the loop gives up early and refines on partial context.

### Why a single-pass loop can't fix this

The current loop optimizes "did the tool calls succeed" — it has no separate signal for "did we solve the right problem." Iter-0 interpretation is implicit and never produces an inspectable, persistable artifact. Without an explicit scope phase, refinement either doesn't happen or happens at iter-0 with no quality signal to drive OPRO mutation.

---

## Decision

`runLoop` runs in **two phases per dispatch**: `scope` and `execute`. Both phases share the same session, the same tool catalog, and the same `cypher_sessions` row, but use **different system prompts** and have **different stopping criteria**.

### Phase shape

```
raw goal → SCOPE phase ──→ refined_goal (structured) ──→ EXECUTE phase → surface
              │                       │
              │                       ▼
              │              cypher_sessions.refined_goal
              │                       │
              └─→ scope_iters         ▼
                                Layer A learning
                              (goal_refinement trigger)
```

### Scope phase

- **System prompt:** "Build a scope-complete brief, don't solve yet." Sourced from `PromptEvolver.buildPrompt('goal_refinement', ctx)` — new trigger type registered in ADR-021's existing machinery.
- **Tool catalog:** read-only subset. MAY call `palace.recall`, `palace.search`, `search_all`, `code-graph.read`, `code-graph.who-owns`, `jira.search`, `brain.recall`. MUST NOT call any tool that writes, commits, pushes, or has external side-effects. Enforced in `tool-catalog.ts` by a `phase: 'scope' | 'execute' | 'both'` field per tool.
- **Catalog signal:** the refiner receives the `skill_catalog` task_classes filtered by trigger_phrase match against the raw goal. The classifier may use this as a hint when deciding which signals to pull. The hint is non-binding (the model can ignore it).
- **Parallel tool_use:** within scope phase, independent `tool_use` blocks emitted in the same model response execute in parallel via `Promise.all`.
- **Clarification:** if scope phase determines `clear=false`, it emits up to 3 questions and halts with `asked_user`. Questions are about **scope** (env, version, AC, out-of-scope), **not** skill-pick. `clarify.ts` system prompt is rewritten to this framing.
- **Stopping criteria:** scope phase exits when (a) the refiner emits a structured brief with required fields populated, OR (b) `scope_iters` reaches `CYPHER_SCOPE_MAX_ITERS` (default 3), OR (c) clarifying-Q halt.
- **Output:** `refined_goal` JSON object persisted to `cypher_sessions.refined_goal` with shape:

```json
{
  "intent": "investigate | build | review | analyze | other",
  "target": "...",
  "constraints": ["..."],
  "success_criteria": ["..."],
  "out_of_scope": ["..."],
  "linkage": {
    "jira": ["BDS-..."],
    "prs": ["#..."],
    "adrs": ["ADR-..."],
    "files": ["src/..."]
  },
  "expected_output_shape": "rca | patch | brief | code | answer",
  "evidence_cited": [
    { "source": "palace.recall", "ref": "...", "snippet": "..." }
  ]
}
```

### Execute phase

- **System prompt:** today's `runLoop` system prompt, unchanged, but now prepended with the `refined_goal` brief as authoritative context.
- **Tool catalog:** full catalog including write/commit/push tools, gated by the existing path classifier and confirm flow.
- **Stopping criteria:** unchanged from today's `runLoop`.
- **Persistence:** writes to `cypher_outcomes` as today, plus a new `cypher_outcomes.refined_goal_id` foreign key linking back to the scope phase output.

### Layer A self-improvement (ADR-021 extension)

A 5th `triggerType` is added to `PromptEvolver`: `goal_refinement`. The seed template lives in `src/intelligence/prompt-seeds.ts`. `QualityScorer` runs on the refined brief (not the final answer for this trigger type) and writes to `prompt_outcomes`. OPRO + TextGrad + A/B mutate the refiner template nightly via the same machinery that already mutates `jira_analyze | chat | investigate | alert`.

A new column `prompt_outcomes.user_verdict` captures user disagreement with the loop's self-reported verdict — `useful | wrong_question | wrong_scope | unrated`. This is the signal that finally lets OPRO learn about *prompt clarity*, not just *output quality*.

### Rollout

Behind `CYPHER_REFINEMENT_ENABLED` env flag, **defaulted off** for ≥2 weeks of dogfood. Smoke gate added at `scripts/smoke-bridge.sh § 36 — scope phase` covering: scope-phase tool-catalog filter (refuses write tools), refined_goal persisted with all required fields, clarify-Q halt round-trips correctly, parallel tool_use in scope phase, OPRO trigger registered.

Implementation lives entirely inside `src/services/cypher/loop.ts`. No dependency on `run.ts` (slated for deletion 2026-07-21 per [ADR-037 § Phase 7](./adr-037-cypher-tool-use-loop.md)); the two-week dogfood window has zero interaction with the Phase 7 calendar gate.

---

## Acceptance Criteria

Single source of truth for "is ADR-039 done." Each row is independently testable.

### Phase 1 — Foundation (T0–T2)

| # | AC | Verification |
|---|----|--------------|
| AC-1 | ADR-039 merged to `master` with explicit `scope` vs `execute` boundary spec | `git log docs/docs/adr/adr-039-*.md` shows merge commit; sidebar renders on docs site |
| AC-2 | `clarify.ts` system prompt rewritten from skill-pick framing to scope-build framing; questions ask env/version/AC/scope-out, **not** "which skill?" | unit test in `tests/cypher/clarify-scope-questions.test.ts` asserts 10 fuzzy goals produce scope questions, 0 produce skill-pick questions |
| AC-3 | Migration v85 adds `cypher_sessions.refined_goal TEXT` (JSON) and `cypher_sessions.scope_iters INTEGER` (next free slot as of master `b6d4454`: `CURRENT_SCHEMA_VERSION = 84` in `src/db/schema.ts:44`; `v64`/`v65` already taken by ADR-034 cypher_outcomes work) | `npm run build` clean; `npm run smoke:bridge` § 11 passes with new schema |
| AC-4 | Spike report `.planning/spikes/2026-06-26-catalog-signal-audit/REPORT.md` exists with: (a) count of skills in `skill_catalog`, (b) % with non-empty `task_classes`, (c) % with non-empty `trigger_phrases`, (d) recommendation: use field as-is / fix seed data / derive from trigger_phrases | report file exists with all 4 sections populated |

### Phase 2 — Phase mechanics (T3–T5)

| # | AC | Verification |
|---|----|--------------|
| AC-5 | `tool-catalog.ts` exposes `phase: 'scope' \| 'execute' \| 'both'` per tool; scope phase refuses write/commit/push tools at registry level | unit test asserts `getCatalogForPhase('scope')` returns only read tools; smoke § 36.1 verifies refusal |
| AC-6 | `loop.ts` executes independent `tool_use` blocks in parallel via `Promise.all`; serial fallback when any tool declares `parallelizable: false` | unit test with mocked tools asserts 3 parallel calls complete in `max(t1, t2, t3)` not `sum(...)`; smoke § 36.2 timing assertion |
| AC-6a | **Registry shape (locked by T5 commit `02b801c`).** `ToolDefinition.parallelizable?: boolean` is an optional per-tool field; **default = `true`** (omitted ⇒ parallelizable). Mutating / state-changing tools opt out by declaring `parallelizable: false` explicitly. `loop.ts` partitions a dispatch's `tool_use[]` into `parallelGroup = slots.filter(s => isToolParallelizable(s.tool))` and `serialGroup = slots.filter(s => !isToolParallelizable(s.tool))`; the parallel group is dispatched together via `Promise.all`, then the serial group runs sequentially **after** the parallel batch (halt-aware, re-checking `halt_flag` before each serial call). Helper `isToolParallelizable(tool)` exported from `tool-catalog.ts` is the single source of truth; unknown / missing tools default to parallelizable so error paths don't accidentally serialize. | `tests/services/cypher/loop-parallel.test.ts` covers a 3-tool mixed batch (2 parallel + 1 serial) and asserts the serial tool observes state written by the parallel batch (proving the partition ordering). |
| AC-6b | **Ordering invariant — required for Anthropic API conformance.** Within a single dispatch, the `tool_result` blocks appended to message history MUST be ordered to match the **original `tool_use[]` order emitted by the model**, NOT the completion order of the parallel batch. The same applies to `tool_calls` and `cypher_steps.stage_index` recording — both walk `slots` in original index order during the recording pass, regardless of which group each slot ran in. This is a correctness property: the Anthropic Messages API pairs `tool_result` to `tool_use` by position within the user turn, so out-of-order results break the contract even when individual calls succeed. | `tests/services/cypher/loop-parallel.test.ts` case 2 asserts final `tool_result[]` order matches input `tool_use[]` order under a mixed parallel+serial batch with deterministic-slow + deterministic-fast tools; `cypher_steps.stage_index` monotonicity is asserted in the same case. |
| AC-7 | `runLoop` accepts a `phase` parameter; scope phase exits on (a) brief emitted, (b) `CYPHER_SCOPE_MAX_ITERS` reached, (c) clarify halt | unit test covers all three exit paths; smoke § 36.3 round-trips a clarify halt |
| AC-8 | `refined_goal` JSON validates against schema (intent / target / constraints / success_criteria / out_of_scope / linkage / expected_output_shape / evidence_cited) — missing required fields fail the phase with `verdict=halted` | schema in `src/services/cypher/refined-goal-schema.ts`; unit test for 5 valid + 5 invalid shapes |

### Phase 3 — Catalog-aware recall (T4)

| # | AC | Verification |
|---|----|--------------|
| AC-9 | Refiner receives `skill_catalog.task_classes` filtered by `trigger_phrases` matching the raw goal as a hint in the scope-phase system prompt | unit test: goal "investigate PROJ-15702" produces hint mentioning `investigate` and `bug-resolution` task_classes when those are in catalog |
| AC-10 | Catalog-signal hint is non-binding — refiner may ignore it (no hard-coded tool dispatch from hint alone) | unit test: refiner with mocked LLM that ignores hint still produces a valid `refined_goal` |

### Phase 4 — Layer A self-improvement (T6–T7)

| # | AC | Verification |
|---|----|--------------|
| AC-11 | `PromptEvolver.buildPrompt('goal_refinement', ctx)` returns a non-empty template. Requires widening the `TriggerType` union in `src/intelligence/cost-gate.ts:28` from `'jira_analyze' \| 'chat' \| 'investigate' \| 'alert'` to `'jira_analyze' \| 'chat' \| 'investigate' \| 'alert' \| 'goal_refinement'`, plus extending every `Record<TriggerType, ...>` literal and `TriggerType`-typed dispatch across the closed surface: `SEED_TEMPLATES` in `src/intelligence/prompt-seeds.ts` (v1 seed registered), template selection in `src/intelligence/prompt-evolver.ts`, scorer dispatch in `src/intelligence/quality-scorer.ts` (`QualityScorer.score()`), and the OPRO trigger sweep in `src/intelligence/prompt-evolution-jobs.ts`. Verification: `npm run typecheck` clean AND `grep -rn "'goal_refinement'" src/intelligence/` returns hits in all 5 files; unit test asserts non-empty `buildPrompt` return + presence in `prompt_templates` table after `seedTemplatesIfEmpty()` |
| AC-12 | `QualityScorer` runs on `refined_goal` for the `goal_refinement` trigger (not on final answer); writes to `prompt_outcomes` (`src/db/schema.ts:1202`) | smoke § 36.4 dispatches a fuzzy goal, verifies `prompt_outcomes` row with `trigger_type='goal_refinement'` is created |
| AC-13 | OPRO nightly job includes `goal_refinement` in its trigger sweep; A/B promotion mechanic active. Depends on AC-11's `TriggerType` widening — without the union extension, the OPRO sweep in `src/intelligence/prompt-evolution-jobs.ts` will not iterate `goal_refinement` even with the v1 seed present (the sweep iterates the closed `TriggerType` union, not seed-table rows). | log assertion: `npm run wi:opro:dry-run` lists `goal_refinement` in trigger types iterated |
| AC-14 | Migration v86 adds `prompt_outcomes.user_verdict TEXT CHECK (user_verdict IN ('useful','wrong_question','wrong_scope','unrated'))` to the inline-declared `prompt_outcomes` table in `src/db/schema.ts:1202` (column-add, not create-table; existing column `user_feedback INTEGER` is unrelated) | schema verification; smoke § 36.5 inserts/reads each verdict value |
| AC-15 | At least one UI surface (CypherSessions page or `/wi` SSE footer) accepts and writes `user_verdict` for a closed session | manual: dispatch a `/wi`, mark verdict via UI, query `prompt_outcomes` and confirm row updated |

### Phase 5 — Rollout safety

| # | AC | Verification |
|---|----|--------------|
| AC-16 | All refinement code gated behind `CYPHER_REFINEMENT_ENABLED=1`; default off | grep + unit test asserting `runLoop` is single-pass when flag absent |
| AC-17 | `scripts/smoke-bridge.sh § 36` passes 5/5 (catalog filter, parallel timing, clarify round-trip, prompt_outcomes write, user_verdict write) — flag on AND off | CI run with both flag states |
| AC-18 | `npm run typecheck` clean; `npm run smoke:bridge` total pass count grows by ≥5 (never drops) | CI output |
| AC-19 | Two-week dogfood: ≥20 `/wi` dispatches with flag on; ≥15 emit a `refined_goal` row; user_verdict captured on ≥10; OPRO writes at least one `goal_refinement` template revision | SQL query against `cypher_sessions`, `prompt_outcomes`, `prompt_templates` |
| AC-19a | Per-phase token-spend telemetry captured: scope-phase token usage written to `cypher_steps` and aggregated separately from execute-phase usage. The 2-week dogfood review computes `scope_phase_tokens / total_dispatch_tokens` per dispatch (median + p90) | SQL query against `cypher_steps` joined to `cypher_sessions` for refinement-enabled dispatches |
| AC-20 | Rollback: flipping `CYPHER_REFINEMENT_ENABLED=0` mid-flight restores single-pass `runLoop` without restart side-effects | smoke § 36.6 toggles flag between dispatches and asserts behavior |

### Phase 6 — Documentation

| # | AC | Verification |
|---|----|--------------|
| AC-21 | `CYPHER.md` updated with one paragraph describing the scope phase + a link to ADR-039 | grep `CYPHER.md` for `ADR-039` returns ≥1 hit |
| AC-22 | `ARCHITECTURE.md` data-flow diagram updated to show two-phase loop | diagram present; section text mentions scope/execute split |
| AC-23 | `.claude/rules/cypher-discipline.md` adds rule: "scope phase MUST NOT call write/commit/push tools" | grep returns the rule **AND** the rule cites AC-5 by anchor (`#ac-5`) **AND** `cypher-discipline.md` cross-links the registry enforcement site in `src/services/cypher/tool-catalog.ts` (the `getCatalogForPhase('scope')` filter from AC-5) |

---

## Implementation Plan (mapped to Kanban tasks)

Order is enforced by Kanban `parents` links. Each task maps to one or more ACs.

| Task | Title | Parents | ACs delivered |
|------|-------|---------|---------------|
| T0 | Write ADR-039 + AC table | — | AC-1 |
| T1 | Spike: audit `skill_catalog.task_classes` quality | — | AC-4 |
| T2 | Pivot `clarify.ts` system prompt (skill-pick → scope-build) | — | AC-2 |
| T3 | Migration v85 — `refined_goal`, `scope_iters` columns | T0 | AC-3 |
| T4 | Catalog-aware recall — `tool-catalog.ts` reads `task_classes` + phase field | T0, T1, T3 | AC-5, AC-9, AC-10 |
| T5 | Parallel `tool_use` in `loop.ts` (Promise.all) | — | AC-6, AC-6a, AC-6b |
| T6 | `goal_refinement` trigger in `PromptEvolver` + seed template | T0, T3 | AC-11, AC-12, AC-13 |
| T7 | `user_verdict` column (migration v86) + UI capture | T0, T6 | AC-14, AC-15 |
| T8 | Smoke gate § 36 + env-flag rollout + docs sync | T2, T4, T5, T6, T7 | AC-7, AC-8, AC-16, AC-17, AC-18, AC-19, AC-19a, AC-20, AC-21, AC-22, AC-23 |

Visual:

```
T0 (ADR) ─┬──→ T3 (migration) ─┬─→ T6 (trigger) ──→ T7 (verdict) ─┐
          │                    │                                   │
          ├──→ T4 (catalog) ←──┘                                   │
          │                                                        │
T1 (spike) ┘                                                       │
                                                                   │
T2 (clarify prompt) ──────────────────────────────────────────────→ T8
                                                                   │
T5 (parallel loop) ───────────────────────────────────────────────→ T8
```

---

## Consequences

### Positive

- Cypher finally has an inspectable, persistable, queryable artifact for "what did Cypher think the user meant?" — the `refined_goal` JSON column. Today that decision is implicit and invisible.
- Clarifying questions become useful: they ask about scope, not about which-skill, which is the actual ambiguity in 90% of real goals.
- Layer A's OPRO machinery — which has been quietly running on `jira_analyze | chat | investigate | alert` since May — starts learning prompt-quality patterns for goal refinement too. Zero new evolution infrastructure.
- `tool-catalog.ts` gains a phase boundary, which is independently useful for the safety story (write tools never reachable during pure scoping).
- Parallel `tool_use` benefits the execute phase too — a free speedup for today's loop.

### Negative

- Latency: scope phase adds 1–3 model calls before execute starts. Mitigated by parallel tool_use within the phase and the `scope_iters` cap.
- Cost: ~2× model calls per dispatch on average. Acceptable for `/wi` traffic volume; quantified during the 2-week dogfood via AC-19a (scope-phase % of total dispatch cost) and reviewed against AC-19's qualitative signal.
- Schema migration adds two columns to a hot table (`cypher_sessions`). Migration v85 must be tested under load — borderline trivial given table size, but called out.
- Adds a new failure mode: scope phase produces a malformed `refined_goal`. AC-8 catches this with schema validation; the fallback is `verdict=halted` and a re-dispatch with a clarifying question.

### Neutral

- The refiner CAN ignore the catalog hint (AC-10). This is deliberate — we don't want a hard-coded routing table. The Beta priors in ADR-034 will learn over time whether the hint helps; if it doesn't, OPRO will mutate the refiner template to deprioritize it.
- `user_verdict` may have low engagement (users won't click). That's fine — the column also accepts `unrated` and OPRO can still learn from `verdict=halted` and other implicit signals.

---

## Open Questions

1. **Should the scope phase be skippable on second-call?** When a user re-dispatches a goal with answers to clarifying questions, do we re-scope or trust the answers? **Proposed:** trust the answers (skip scope) on the second turn. **If we adopt this**, add an explicit AC in a future phase gating the skip-scope path on a safety signal — e.g. the user actually answered all questions; no write-tools are about to be requested; `refined_goal` from the prior turn is still valid given last-modified palace age.
2. **Caching `refined_goal` across sessions.** A refined goal for "investigate PROJ-15702" today might be reusable next week. Worth caching keyed on `(raw_goal_hash, last_modified_palace_entry_age)`. Deferred to v2.
3. **Multi-language goals.** Today's `clarify.ts` prompt is English-only. Out of scope for ADR-039; flag for future ADR if needed.

---

## Rejected Alternatives

| Alternative | Why rejected |
|-------------|--------------|
| Build a `/wi-frame` skill that wraps `/wi` with a pre-refinement step | Adds a new slash command, leaves menubar/web-chat unimproved, doesn't get OPRO learning. Refinement belongs inside the bridge so every caller benefits uniformly. |
| Single-fan-out `gather_context` tool that pulls palace + jira + code-graph in parallel as one tool | Wasteful — burns tokens on signals not relevant 70% of the time. The model should decide what to fetch, not pre-fetch everything. The mini-loop pattern in scope phase is strictly better. |
| Add a 10th stage to the legacy pipeline (`scope` stage in `run.ts`) | Pipeline is end-of-life per ADR-037's Phase 7 plan (lands 2026-07-21). Spending engineering capital on it is a regression vector. |
| Inline scope inside iter-0 of the existing single-pass loop | Today's loop already does this implicitly and it doesn't work. Without an explicit phase boundary, the refined goal isn't inspectable, isn't persistable, and OPRO can't learn from it. |

---

## References

- `src/services/cypher/clarify.ts` — phase 82c LLM classifier (the framing target of AC-2)
- `src/services/cypher/complexity.ts` — `scoreComplexity()` task-shape verdict (unchanged)
- `src/services/cypher/skill-discovery.ts` — skill_catalog scanner (input for AC-9)
- `src/services/cypher/tool-catalog.ts` — gains `phase` field per AC-5; **`parallelizable?: boolean` field + `isToolParallelizable()` helper per AC-6a** (T5 commit `02b801c`, 21 mutating tools opt out)
- `src/services/cypher/loop.ts` — gains scope/execute phase split per AC-7; **`Promise.all` partition dispatch + original-tool_use-order result collation per AC-6, AC-6a, AC-6b** (T5 commit `02b801c`)
- `tests/services/cypher/loop-parallel.test.ts` — 3 cases covering AC-6 / AC-6a / AC-6b (parallel timing, mixed-batch order invariant, sequential lower bound) (T5 commit `02b801c`)
- `src/intelligence/prompt-evolver.ts` — gains 5th trigger per AC-11
- `src/intelligence/prompt-seeds.ts` — gains goal_refinement seed per AC-11
- `src/intelligence/prompt-evolution-jobs.ts` — OPRO trigger sweep per AC-13
- `src/db/schema.ts:1202` — `prompt_outcomes` table declared inline (not via migration); receives `user_verdict` column via AC-14
- `src/db/migrations/v85_*.ts` — `refined_goal`, `scope_iters` per AC-3 (next free slot above `CURRENT_SCHEMA_VERSION = 84` at `src/db/schema.ts:44`)
- `src/db/migrations/v86_*.ts` — `user_verdict` per AC-14
- `scripts/smoke-bridge.sh` — § 36 added per AC-17 (§ 17 owned by mode-detector since phase 82c; § 35 is highest currently used)
