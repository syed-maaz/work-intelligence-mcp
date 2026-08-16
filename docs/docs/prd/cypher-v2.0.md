---
sidebar_label: "Cypher v2.0"
sidebar_position: 3
---

# Cypher v2.0 — Product Requirements Document

> **STATUS: DRAFT (2026-06-17).** Defines the milestone that delivers the ADR-037 tool-use loop. Supersedes the pipeline framing in [ADR-033 § 4](../adr/adr-033-cypher-framework.md#4-framework-contract-locked-track-g); CAP-12, CAP-13, CAP-14, runtime topology § 9, and core/project boundary § 10 from ADR-033 carry forward unchanged.
>
> **Branch:** `docs/cypher-mermaid-followup` (PRD lives here; implementation phases land on their own branches per the execution plan).
> **Architectural decisions:** [ADR-037 — Cypher Tool-Use Loop](../adr/adr-037-cypher-tool-use-loop.md) (primary); [ADR-036 — CLI-Primary Surface](../adr/adr-036-cypher-cli-primary.md) (consumer surface); [ADR-034 — Cypher Learning Engine](../adr/adr-034-cypher-learning-autonomy-engine.md) (Beta priors loop, unchanged).
> **Doctrine:** [`CYPHER.md`](../../../CYPHER.md) at repo root.
> **Execution plan:** [`.planning/cypher/11-ADR-037-EXECUTION-PLAN.md`](../../../.planning/cypher/11-ADR-037-EXECUTION-PLAN.md).
> **Predecessor:** [Cypher v1.4](./cypher-v1.4.md) shipped 2026-06-12. v1.4 ships the pipeline; v2.0 replaces the pipeline with a loop.

---

## 1. Mission

**v2.0 ships Cypher as one reactive agentic loop.** The 9-stage pipeline that v1.4 delivered (`run.ts`, 733 LOC, sequential stages) is replaced with a 200-LOC tool-use `while` loop that lets the model pick the next move based on what just happened. Brain, Palace, the wi-* skills, the code graph, smoke tests — all become uniform tools the loop calls. Brain is no longer special; it's one tool among many.

The user-visible surface (`/wi <goal>` from the CLI, `/api/wi/dispatch` for non-streaming callers) is preserved. The audit ledgers (`cypher_sessions`, `cypher_steps`, `cypher_outcomes`) are preserved with one schema-compatible change (`step_kind` flips from `stage` to `tool_call` on new rows; old rows stay readable). The learning loop (Beta priors, ADR-034 L1) is preserved end-to-end.

Everything else — the control flow, the system prompt, the way new skills enter the catalog, the `result_meta` contract for outer ReAct consumers like Hermes — is new in v2.0.

---

## 2. Why v2.0 (not v1.5)

v2.0 is a major version bump because v2.0 changes **the shape of execution**, not just its surface or its priors:

| Dimension | v1.4 | v2.0 |
|---|---|---|
| Control flow | 9 sequential stages (`route → research → investigate → … → outcome`) | One `while` loop; model picks next tool each iteration |
| Implementation | `src/services/cypher/run.ts` (733 LOC, deleted in Phase 6) | `src/services/cypher/loop.ts` (~200 LOC, new) |
| Tool catalog | Skills hardcoded into stages | Uniform tool definitions registered at boot |
| Per-tool audit | `cypher_steps.step_kind = 'stage'` | `cypher_steps.step_kind = 'tool_call'` (new rows; old rows stay) |
| Outer-ReAct contract | Surface text only | Surface + structured `result_meta` (ADR-037 D14) |
| Brain's status in the runtime | Coordinator | One tool in the catalog |
| Confirm gate | Stage-level | Per-tool-call (ADR-037 D5) |
| Background-agent invocation | Stage-coupled | First-class tool category (ADR-037 D13) |

A v1.5 increment would imply additive change. ADR-037 deletes a primitive and substitutes another. That's a v2.

---

## 3. Personas (unchanged from v1.4)

Same as [v1.4 § 3](./cypher-v1.4.md#3-personas). Maaz remains primary (portfolio engineer working concurrently across WI / example-service / operations / future projects). Read-only Docusaurus consumers remain secondary. The portfolio model and project envelope rules from v1.4 § 4 carry forward — the loop adopts them as system-prompt context, not as new infrastructure.

---

## 4. What v2.0 changes

### 4.1 The `while` loop

The whole control flow is the cycle in [ADR-037 D1](../adr/adr-037-cypher-tool-use-loop.md#d1--the-loop-primitive): `controller_call → stop_reason → tool_use blocks → execute → append → budget check → controller_call`. Three exits — `end_turn` (success), budget exhaustion, defensive cli-class guard. The model holds strategy; the loop just executes.

### 4.2 Brain becomes a tool

`brain.recall`, `brain.decide`, `brain.verify`, `brain.context` are catalog entries. The HTTP surface (`/api/brain/*`) stays for non-Cypher consumers (web UI chat panel, direct MCP callers, n8n flows). Both paths converge on the same `decision-engine.ts`. **This duplicate surface is the v2.5 risk #4** — flagged, accepted as cost in v2.0, addressed later.

### 4.3 `result_meta` for outer ReActs

Every dispatch returns `{ surface, result_meta }`. `result_meta.outcome ∈ {success, partial, blocked, needs_user_input, budget_exhausted, error}` is the structured handoff for Hermes / n8n / MCP — no more prose-matching for retry/escalate decisions. Spec: ADR-037 D14, with the disambiguation table that distinguishes `result_meta.outcome` (outer-ReAct contract) from `cypher_outcomes.verdict` (priors loop ledger).

### 4.4 Postures, not agents

Roles like "PR reviewer," "bug investigator," "PM" are **postures of the same loop** — system-prompt addendum + tool catalog filter + Beta priors over (tool, task class). Not separate agents. Not multi-agent orchestration. One reactive loop that adopts a costume per dispatch. The "agent" word is reserved for ADR-017 ambient tenants (BugInvestigatorAgent, OrchestratorAgent — long-running, event-driven, separate from Cypher).

### 4.5 Skill lifecycle stays human-gated

CAP-13 (birth) and CAP-14 (retirement) carry forward exactly. Auto-signals qualify a skill for a gate; a human still ratifies the transition. No silent activation, no silent retirement. See [`CYPHER.md` § Self-extension and consolidation](../../../CYPHER.md#self-extension-and-consolidation-cap-13--cap-14) for the state machine.

**Registration mechanism by version.** v2.0 ships with hand-written `ToolDefinition` registration: every CAP-13 birth approved between v2.0 ship and v2.5 ship adds a tool definition by hand, same pattern Phase 2 used for the ~36 existing wi-* skills. v2.5 W2 ships codegen from SKILL.md frontmatter (see [v2.5 PRD § Risk #2](./cypher-v2.5.md#risk-2--catalog-migration-is-tedious)) — at that point, new skills become "drop a SKILL.md, run the codegen." Runtime self-registration (Cypher proposes a tool definition inline as part of a Phase 1 plan, user confirms via the propose-confirm primitive) is a **v2.5 tracked open question, not a commitment** — the failure mode (a Cypher-authored JSON schema that miss-validates an input the loop later passes is a runtime crash hours after approval) carries a high promotion bar. Cross-link: [ADR-037 D21](../adr/adr-037-cypher-tool-use-loop.md#d21--cap-13-registration-mechanism). To capture friction evidence during the v2.0→v2.5 window, `cap13_birth_decisions` gains a `skipped_reason TEXT NULL` column recording why a birth gate didn't approve — feeds the v2.5 W2 acceptance gate with data, not vibes.

### 4.6 Priors get richer keys (Layer-2 learning enrichment)

v1.4 keys Beta priors on `tool` alone — one `(α, β)` per skill, averaged across every dispatch that ever ran it. v2.0 keys priors on `(tool, task_class)` — same Pass-1 mechanism (per-dispatch outcome → credit to the skills that ran), same persistence, but the loop's posture context propagates into the credit assignment. Concretely: `brain.recall` carries one `prior_mu` for the "PR review" posture and a different `prior_mu` for the "bug investigate" posture, instead of one number averaging both.

This is a free side effect of running as a loop with postures — postures already carry a task-class signal, the credit-assignment layer just stops throwing it away. **No schema break:** `cypher_outcomes` already records the posture; v2.0's selector keys on `(tool, task_class)` instead of `(tool)`.

What v2.0 does **not** do: move learning from per-dispatch to per-tool-call. That's Pass-2 (Layer-3 in the learning axis), shadow-shipped per ADR-034 L1.1 and gated by ≥100 closed dispatches + ±15% smoke agreement. See [v2.5 risk #3](./cypher-v2.5.md#risk-3--pass-2-priors-over-engineering) for the forcing function.

### 4.7 Plan-Confirm-Act with self-learning

The loop is **two-phase**: every dispatch first proposes a plan, then executes it. Posture is a property of the proposed plan, not of the dispatch contract. Cross-link: [ADR-037 D15–D18](../adr/adr-037-cypher-tool-use-loop.md#d15--plan-confirm-act-control-flow). Source-of-truth discussion: [`.planning/cypher/12-V2-V2.5-DESIGN-DISCUSSION.md`](../../../.planning/cypher/12-V2-V2.5-DESIGN-DISCUSSION.md) Q-1.1 / Q-1.10–Q-1.13.

**Two-phase control flow.** Phase 1 (cold-start): goal → reason → render plan → wait for user `confirm` / `correct` / `halt` → execute. Phase 2-soft (warm, priors recognise the pattern): same render, no wait — proceeds after a 3-second veto window unless the user vetoes. Plan visibility is preserved in both phases; the only difference is whether Cypher waits for explicit confirmation. Phase 2-hard (silent execution from priors) is rejected — the user always sees the plan before tool calls fire.

**Phase 2 trigger predicate.** Phase 2-soft activates iff all three legs hold:

```
runs_phase_2_soft(goal, plan_shape) =
    count(confirmed_dispatches_with_similar_plan_shape) >= CYPHER_PHASE2_COUNT_MIN
  AND
    success_rate(those_dispatches) >= CYPHER_PHASE2_RATE_MIN
  AND
    user_session_pref != 'always_phase_1'
```

If any leg fails, fall back to Phase 1. Plan-shape similarity at v2.0 launch = exact match on `(posture, tool_call_sequence)` ignoring tool arguments. Embedding-based similarity is a v2.5 enrichment.

**Confirmation protocol.** Free-text reply with starter-list pattern match and length-aware re-prompt fallback:

```
on_user_reply(reply):
    normalized = lowercase(strip(reply))
    if starts_with_any(normalized, ["yes","y","go","do it","confirm",
                                    "ok","okay","lgtm","ship","proceed"])
       AND length(normalized) <= 20:           → confirm
    elif starts_with_any(normalized, ["no","stop","wait","cancel",
                                       "halt","abort","hold"])
       AND length(normalized) <= 20:           → halt
    elif length(normalized) > 20:              → correct (re-propose with reply as guidance)
    else:                                      → re-prompt with disambiguation message
```

Slash-commands rejected (ceremony tax). Classifier-based interpretation rejected (model-call-to-read-one-word). Each confirmation logs `cypher_steps.confirmation_method ∈ {pattern_confirm, pattern_halt, length_correct, reprompt_confirm, reprompt_halt, reprompt_correct}` so misclassification rates are measurable post-launch and the cutoff tunable.

**No-timeout policy.** Phase 1 blocks indefinitely on user reply. No `verdict='timeout'` value. Three mitigations replace what a timeout would have done:

1. **Explicit `/stop` works at any moment** — from the dispatch terminal or any other terminal pointing at the same bridge. Halts the loop, closes the session with `verdict='halted'`.
2. **Terminal-disconnect detection** — when the MCP transport closes (terminal closed, tmux pane killed), the bridge closes the active dispatch with `verdict='abandoned'`.
3. **Bridge-startup cleanup sweep** — on bridge boot, rows in `cypher_sessions` with `state='awaiting_confirm'` older than 24 hours close with `verdict='abandoned'`. 24 hours is the floor for resource hygiene; tighter cutoffs risk killing real overnight-thinking sessions.

**Phase 2-soft 3-second veto window.** After plan render, Cypher waits `CYPHER_PHASE2_VETO_DELAY_MS` (default 3000ms) before firing the first tool call. The sleep is interruptible by `/stop`. Subsequent tool calls fire normally without per-call delays. Setting the env var to `0` disables the window for trusted batch sessions.

**Stop semantics — wait-then-halt.** A single `halt_requested: bool` flag on the dispatch context, checked at exactly two points: (i) before the next tool call, (ii) at the top of each loop iteration. **In-flight tool calls always complete.** No mid-call cancellation in v2.0. The audit trail records `cypher_outcomes.halt_after_call_id` (which `cypher_steps` row was the last completed call before halt fired) and `cypher_outcomes.halt_requested_at` (when `/stop` was received, distinct from `closed_at`). Trade-off accepted: a slow destructive call (large `git_commit`, hung `jira_update`) cannot be stopped mid-flight; the user waits for it to finish before halt takes effect. Mid-call cancellation (Option 2) was rejected for partial-write risk; read/write-split halt (Option 3) was rejected as v2.0 scope.

**Non-interactive caller policy.** `wi_dispatch` accepts an optional `confirm_mode ∈ {interactive, auto, reject}` parameter, default `interactive`:

| `confirm_mode` | Behavior |
|---|---|
| `interactive` (default) | Interactive transport (CLI / Hermes stdio with TTY) → run Phase 1 normally. Non-interactive transport (n8n / cron / HTTP-without-stdin) → reject with `verdict='rejected_non_interactive'`. |
| `auto` | Skip the Phase 1 wait regardless of transport. Plan still rendered into `cypher_steps` for audit; proceeds straight to execution. Effectively forces Phase 2-soft with zero veto window. |
| `reject` | Always reject without rendering a plan. Useful for capability-probe / dry-run callers. |

`cypher_sessions` records `confirm_mode_requested` (caller intent) and `confirm_mode_used` (actual behavior). Existing n8n / cron flows must update to pass `confirm_mode='auto'` on cutover; the break is loud (the verdict tells callers exactly what happened) and the migration is mechanical.

**Configuration surface.** All Plan-Confirm-Act behavior is env-var-tunable:

| Env var | Default | Purpose |
|---|---|---|
| `CYPHER_PHASE2_COUNT_MIN` | `3` | Phase 2-soft count gate — minimum confirmed dispatches with same plan-shape |
| `CYPHER_PHASE2_RATE_MIN` | `0.8` | Phase 2-soft success-rate modulator — minimum success rate over the count |
| `CYPHER_CONFIRM_MODE` | `auto` | Per-session override `{auto, always}`; `always` forces Phase 1 every dispatch |
| `CYPHER_PHASE2_VETO_DELAY_MS` | `3000` | Veto window between Phase 2-soft plan render and first tool call |
| `CYPHER_HIDE_ENGINE_BADGE` | unset | Phase 4 cutover-visibility opt-out (suppresses `[engine: loop]` / `[engine: pipeline]` prefix) |

Defaults are educated guesses; v2.5 W1 derives evidence-based values from real dispatch data. Inline per-dispatch override remains available via `/wi --confirm <goal>`.

**Schema additions (additive across `cypher_sessions`, `cypher_steps`, `cypher_outcomes`):** `cypher_sessions.{phase, plan_shape_hash, prior_count, prior_success_rate, confirm_mode_requested, confirm_mode_used}`; `cypher_steps.confirmation_method`; `cypher_outcomes.{halt_after_call_id, halt_requested_at}`. New `verdict` values (Contract A, internal): `halted`, `abandoned`, `rejected_non_interactive` — these map to existing `result_meta.outcome` values via the verdict→outcome translation in `wi_dispatch`; Contract B stays at six values frozen at v2.0 ship.

---

## 5. What v2.0 keeps from v1.4

The following ship intact:

- **9-step task contract** (ADR-033 § 4) — reframed as system prompt, not as pipeline stages. The contract is **the moves a senior engineer has available**, not a sequence to follow.
- **CAP-12 (multi-model routing)** — per-bucket model+effort migration completed at v1.4 (Phase 76 / ADR-031). No change.
- **CAP-13 (self-extension)** + **CAP-14 (skill consolidation)** — both unchanged. Cap of ~30 wi-* skills still applies; auto-detect signals still feed Maaz-gated approval.
- **Project portfolio model** (ADR-033 § 10) — WI / example-service / operations / future projects. Loop reads project signal from goal + path mentions exactly as v1.4 did.
- **Beta priors learning loop** (ADR-034 L1, Pass-1) — every closed dispatch updates priors; the loop reads `prior_mu` into tool descriptions. Persistence and update mechanism are unchanged from v1.4. **What changes is the key**, not the loop — see § 4.6 for the Layer-2 enrichment to `(tool, task_class)`.
- **`cypher_sessions` / `cypher_steps` / `cypher_outcomes`** schema — same tables, additive change to `step_kind` enum.
- **No autonomous mode** — Cypher runs reactively when invoked. No cron, no overnight watcher, no ambient action.

---

## 6. Phases (execution plan reference)

Six phases, gated. Full detail in [`.planning/cypher/11-ADR-037-EXECUTION-PLAN.md`](../../../.planning/cypher/11-ADR-037-EXECUTION-PLAN.md):

| Phase | Scope | Effort | Status |
|---|---|---|---|
| **0** | Doc alignment (ADR-033 status header, ARCHITECTURE.md § 5, ADR-035 annotation, sidebar link) | ~30 min, doc-only | Not started |
| **1** | Spike on `scripts/spike-cypher-loop.ts` — 5 tools, 1 heavy goal, deletable | 1–2 days | Not started |
| **2** | Build production tool catalog (~30+ wi-* skills, 36 as of 2026-06-17, plus brain/palace/code-graph/smoke). Every `ToolDefinition` follows three default-shape rules — (i) `posture_eligibility: string[]` (list of posture names, no predicate functions); (ii) `input_schema:` JSON schema literal (static object, no runtime assembly); (iii) `description:` string OR `description_from: "SKILL.md"`. Per-field opt-out via `codegen_exempt: { reason: <text>, fields: [<names>] }`. | 3–5 days | Not started |
| **3** | Build production loop controller `src/services/cypher/loop.ts` behind `CYPHER_LOOP_ENABLED=0` flag | 3–5 days | Not started |
| **4** | CLI cutover (4a–4d): wi-router dual-schema renderer → smoke green → flag default-on → 2 weeks stable → drop old-schema branch. Cutover visibility: `[engine: loop]` / `[engine: pipeline]` prefix on first stream chunk of every dispatch (suppressible via `CYPHER_HIDE_ENGINE_BADGE`); rollback announcement (`[engine: rollback to pipeline at <ts>]`) on next dispatch's first stream chunk if `CYPHER_LOOP_ENABLED` flips `1`→`0` mid-window; `cypher_sessions.engine TEXT NOT NULL DEFAULT 'loop'` column added — **retained post-Phase-6** as historical postmortem signal. | 2–3 weeks elapsed | Not started |
| **5** | HTTP cutover for non-streaming callers; ADR-036 D9 compatibility shim preserves legacy response shape | 2–3 days | Not started |
| **6** | Sunset `run.ts` (-733 LOC); mark ADR-033 § 4 superseded; update ARCHITECTURE.md § 5. Delete the engine-badge renderer in the same PR that deletes `run.ts`. **`cypher_sessions.engine` column is NOT deleted** — retained as postmortem signal even after only one engine remains in the codebase. | 1 day | Not started |

Phase 0 unblocks doc readers. Phases 1–3 build behind a flag — production keeps running on v1.4's pipeline. Phase 4 is the user-visible cutover with a 2-week stability window before the rollback branch is dropped. Phase 5 closes the non-streaming surface. Phase 6 deletes the predecessor.

**Phase 2 codegen-exempt target.** Phase 2 closes with **N=0 `codegen_exempt` skills** as the target. A non-zero count is not a blocker but flags the default rules for review before Phase 6 closes — if multiple skills need exemptions, the default shape is wrong and v2.5 W2 codegen will be a partial rewrite rather than mechanical. Each exempt skill must declare a plain-text `reason` that a code reviewer can validate against the v2.5 W2 audit. Cross-link: [discussion log Q-1.5 sub-question 2](../../../.planning/cypher/12-V2-V2.5-DESIGN-DISCUSSION.md).

---

## 7. Acceptance criteria

v2.0 is "shipped" when **all** of the following hold:

1. **Phase 6 complete:** `run.ts` deleted; ARCHITECTURE.md § 5 reflects the loop; ADR-033 § 4 carries the superseded marker.
2. **Smoke green for 2 consecutive weeks** with `CYPHER_LOOP_ENABLED=1` as the default — `npm run smoke:bridge` and `npm run smoke:all` both passing across all canonical sections.
3. **No regressions in `result_meta` contract** — every closed dispatch in the audit period returns a parseable `result_meta` with a valid `outcome` value.
4. **Token economics within bounds** — median dispatch under $0.50, p95 under $2 (sanity check; tighter SLOs are a v2.5 concern).
5. **Beta priors continue to update** — `cypher_outcomes.verdict` writes follow ADR-034 L1 Pass-1 rules; D7 classifier flips `mixed` → `success`/`failed` on the next reply.
6. **CAP-13 self-extension still gated** — no skill activates or retires without Maaz approval; the only thing that changed is *where* the skill enters the catalog (tool-definition registration vs SKILL.md file).
7. **ADR-036 D9 compatibility holds** — every existing client (CLI, web UI, n8n, MCP) keeps working without code changes during cutover.
8. **G-7 smoke gates** — the following sub-tests must all pass. Cross-link: [discussion log](../../../.planning/cypher/12-V2-V2.5-DESIGN-DISCUSSION.md) Q-1.10 / Q-1.11 / Q-1.12 / Q-1.13 / Q-1.4 / Q-1.5.

   **Plan-Confirm-Act gates (Q-1.10 / Q-1.11 / Q-1.12 / Q-1.13):**
   - (i) Phase 2 trigger predicate is unit-tested with synthetic prior history; defaults `N_min=3 / R_min=0.8` produce expected phase choices on a 20-case truth table.
   - (ii) All six `confirmation_method` paths are exercised — `pattern_confirm`, `pattern_halt`, `length_correct`, `reprompt_confirm`, `reprompt_halt`, `reprompt_correct` — and each writes the correct value to `cypher_steps.confirmation_method`.
   - (iii) `/stop` from a second terminal halts an `awaiting_confirm` dispatch; session closes with `verdict='halted'`.
   - (iv) Bridge restart with a 25-hour-old `awaiting_confirm` row closes it as `verdict='abandoned'` via the cleanup sweep; rows < 24 hours are left alone.
   - (v) Phase 2-soft `/stop` during the 3-second veto window halts before any tool call fires; the interruptible sleep is cancelled.
   - (vi) `/stop` during an artificial 10-second mock tool call halts **after** the call completes (not before); `cypher_outcomes.halt_after_call_id` correctly identifies the in-flight call; no further tool calls fire after halt.
   - (vii) Non-interactive transport + default `confirm_mode='interactive'` = rejected with `verdict='rejected_non_interactive'` and no plan rendered.
   - (viii) Non-interactive transport + `confirm_mode='auto'` = runs without Phase 1 wait; plan is recorded into `cypher_steps` for audit.
   - (ix) Interactive transport + `confirm_mode='reject'` = rejected without rendering plan.

   **Cutover visibility gates (Q-1.4):**
   - (x) `[engine: loop]` / `[engine: pipeline]` prefix appears on the first stream chunk of every Phase 4 dispatch when `CYPHER_HIDE_ENGINE_BADGE` is unset, with correct value matching the active flag; setting `CYPHER_HIDE_ENGINE_BADGE=1` suppresses the prefix.
   - (xi) Toggling `CYPHER_LOOP_ENABLED=1` → `0` mid-session causes the rollback announcement line (`[engine: rollback to pipeline at <ts>]`) to render on the next dispatch's first stream chunk.
   - (xii) `cypher_sessions.engine` is non-null and matches the served engine for every closed dispatch in the 2-week audit window.

   **Outcome-contract gates (Q-1.3):**
   - (xiii) All six verdict→outcome translations produce correct external `result_meta.outcome` values; an unmapped synthetic verdict surfaces as `outcome='error', unmapped=true` (forces the gap-detection path that feeds Flavor A reviews).

   **ToolDefinition gates (Q-1.5):**
   - (xiv) Every `ToolDefinition` either follows all three default-shape rules (`posture_eligibility: string[]`, `input_schema:` JSON literal, `description:` string or `description_from`) OR declares `codegen_exempt` with a non-empty `reason` and explicit `fields` list.
   - (xv) `cap13_birth_decisions.skipped_reason` is a writable column on the live schema; smoke can insert a synthetic deferred birth with a reason and read it back.

---

## 8. Out of scope — pushed to [v2.5](./cypher-v2.5.md)

Four risks are accepted as cost in v2.0 and pushed to v2.5 with explicit mitigation work:

1. **Token-economics hardening** — v2.0 ships if median is under $0.50 / p95 under $2; v2.5 sets per-class SLOs and adds budget-shaping primitives (max-iter, max-tokens, max-wallclock) per posture.
2. **Catalog migration ergonomics** — v2.0 walks every wi-* skill by hand once (~30+ skills today, 36 as of 2026-06-17) under the three default-shape rules from § 6 Phase 2, with a per-field `codegen_exempt: { reason, fields }` escape hatch for genuinely novel skills (target N=0 exempt at Phase 2 close). v2.5 W2 ships the codegen + smoke-test scaffolding so adding a non-exempt skill is "drop a SKILL.md, run the codegen." Runtime self-registration (Cypher proposes a `ToolDefinition` inline as a Phase 1 plan) is a v2.5 **tracked open question** — promotion gated behind ≥12 CAP-13 birth approvals on the codegen path + design doc on the wrong-schema-equals-future-runtime-crash failure mode + schema smoke harness. Cross-link: [discussion log Q-1.5](../../../.planning/cypher/12-V2-V2.5-DESIGN-DISCUSSION.md).
3. **Pass-2 priors over-engineering** — v2.0 keeps Pass-1 as the floor and leaves Pass-2 in shadow mode. v2.5 either earns Pass-2 promotion with real evidence or formally deprecates it; no mid-state.
4. **Brain HTTP surface duplication** — v2.0 keeps `/api/brain/*` because non-Cypher consumers exist. v2.5 audits whether each consumer still needs the parallel surface or can call through the loop. Architectural framing (loopless-tool pattern vs legacy) is deferred entirely to v2.5; v2.0 makes no commitment about HTTP route additions either way. Cross-link: [discussion log Q-1.2](../../../.planning/cypher/12-V2-V2.5-DESIGN-DISCUSSION.md).

Full v2.5 plan: [Cypher v2.5 PRD](./cypher-v2.5.md).

---

## 9. Open questions

These will be resolved during the implementation phases; recorded here so they don't get lost:

- **D9** — Pass-2 promotion gate. ADR-037 D9 says ≥100 closed dispatches + ±15% smoke agreement + operator flag flip. Whether Pass-2 ever earns promotion is a v2.5 question (risk #3); v2.0 just ships Pass-1 priors continuing to update.
- **Hermes-side retry policy on `outcome=blocked`.** Cypher only guarantees the structured `result_meta`. The retry count (once? exponential? until budget?) is a Hermes-side ADR. Tracked in [ADR-037 § Open questions](../adr/adr-037-cypher-tool-use-loop.md#open-questions).
- **External MCP catalog shape.** Today: Jira/GitHub MCP lives inside `brain.verify` adapters and inside `wi-*` skills. Target (per ADR-037 D3): first-class catalog entries (`jira.fetch`, `github.fetch`). Migration timing is part of Phase 2's tool catalog work; not its own phase.

---

## 10. References

- **Doctrine:** [`CYPHER.md`](../../../CYPHER.md)
- **Architectural decisions:** [ADR-037](../adr/adr-037-cypher-tool-use-loop.md) (loop), [ADR-036](../adr/adr-036-cypher-cli-primary.md) (CLI surface), [ADR-034](../adr/adr-034-cypher-learning-autonomy-engine.md) (priors), [ADR-033](../adr/adr-033-cypher-framework.md) (predecessor framework — § 4 superseded by ADR-037; § 9, § 10, CAP-12/13/14 carry forward)
- **Predecessor PRD:** [Cypher v1.4](./cypher-v1.4.md)
- **Successor PRD:** [Cypher v2.5](./cypher-v2.5.md)
- **Execution plan:** [`.planning/cypher/11-ADR-037-EXECUTION-PLAN.md`](../../../.planning/cypher/11-ADR-037-EXECUTION-PLAN.md)
- **Architecture overview:** [`ARCHITECTURE.md` § 5](../architecture/index.md)
