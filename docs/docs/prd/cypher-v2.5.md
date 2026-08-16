---
sidebar_label: "Cypher v2.5"
sidebar_position: 4
---

# Cypher v2.5 — Product Requirements Document

> **STATUS: PLANNING (2026-06-17).** Defines the milestone that hardens the v2.0 loop after it has shipped and earned production evidence. v2.5 does not exist independently of v2.0 — it is the explicit risk-mitigation queue we agreed to defer rather than fold into the v2.0 cutover.
>
> **Predecessor:** [Cypher v2.0](./cypher-v2.0.md) — must be at acceptance § 7 before v2.5 work begins.
> **Architectural decisions referenced:** [ADR-038](../adr/adr-038-cypher-v2.5-production-grade.md) (primary — the v2.5 architectural commitment), [ADR-037](../adr/adr-037-cypher-tool-use-loop.md), [ADR-034](../adr/adr-034-cypher-learning-autonomy-engine.md), [ADR-033](../adr/adr-033-cypher-framework.md).
> **Doctrine:** [`CYPHER.md`](../../../CYPHER.md).

---

## 1. Mission

v2.5 takes the four risks that v2.0 accepted as cost and turns them into work with explicit evidence gates. v2.0 is the architectural cutover; v2.5 is the *production-hardening* pass that closes the gaps the cutover deliberately left open.

**Constraint:** v2.5 ships nothing without evidence pulled from real v2.0 production usage. No speculative engineering. The risks below become work items only when v2.0's audit data shows they actually bite.

---

## 2. The four risks (and how v2.5 handles each)

### Risk #1 — Loop economics are bad

**The risk:** A 200K-context model in a `while` loop can burn tokens fast if the model gets indecisive. v2.0 ships if median dispatch is under $0.50 / p95 under $2, but those are sanity bounds, not SLOs.

**Why deferred:** v2.0's spike (Phase 1) is the *first* place we'll measure real loop cost. Setting per-class SLOs before measuring is making numbers up. Phase 1 produces 3–5 spike runs at most; production usage at v2.0 acceptance gives us hundreds of dispatches across light/heavy/error paths. v2.5 inherits real percentiles.

**v2.5 work:**

- **W1.1 — Per-posture SLOs.** Once 200+ closed dispatches exist post-v2.0, derive median + p95 + p99 cost separately for each posture (PR review, bug investigate, PM, generic) and each complexity tier (light vs heavy). Set SLOs at p95 with 20% headroom.
- **W1.2 — Budget-shaping primitives.** ADR-037 D6 already gives us `max_iterations`, `max_tokens`, `max_wallclock_ms`. v2.5 makes them per-posture defaults instead of dispatch-wide constants. Light dispatches get tight budgets; heavy investigations get loose ones.
- **W1.3 — Cost-aware controller hints.** When `tokens_used / max_tokens > 0.7`, the system prompt picks up a soft instruction to wrap up. Not a hard cap (D6 keeps the hard cap), a steering signal. Earned by W1.1 telling us where the inflection is.
- **W1.4 — Token-economics smoke section.** Add `npm run smoke:bridge § 24 — token economics` that asserts median dispatch cost stays under SLO over the last N closed dispatches. Regression detector, not a gate on a single dispatch.

**Acceptance gate:** SLO violations dropping by ≥40% from v2.0 baseline OR violations being entirely concentrated in a known posture with explicit budget exception.

---

### Risk #2 — Catalog migration is tedious

**The risk:** v2.0 Phase 2 walks every wi-* skill by hand (~30+ skills today, 36 as of 2026-06-17) to produce tool definitions (JSON schema, category, description with priors, handler wiring). This is a one-time slog; the worry is that *adding the next skill* after v2.0 is also slog-shaped, which discourages CAP-13 self-extension.

**Why deferred:** v2.0 has to do the migration once regardless. v2.5 builds tooling around the *shape* the v2.0 migration converged on — codegen, schema-derivation, smoke-test scaffolding — but doing that before the migration is premature. We don't know which patterns repeat until 38 of them exist.

**v2.5 work:**

- **W2.1 — Tool definition codegen.** A script (`scripts/scaffold-cypher-tool.ts`) that takes a SKILL.md + a handler signature and emits a starter `ToolDefinition` conforming to the three default-shape rules locked in [v2.0 PRD § 6 Phase 2](./cypher-v2.0.md#6-phases-execution-plan-reference) and [discussion log Q-1.5 sub-question 2](../../../.planning/cypher/12-V2-V2.5-DESIGN-DISCUSSION.md): (i) `posture_eligibility: string[]`, (ii) `input_schema:` JSON schema literal, (iii) `description:` string OR `description_from: "SKILL.md"`. Common patterns derived from the existing 38 entries; uncommon ones still need manual review. **W2 codegen iterates only over non-exempt skills** — any `ToolDefinition` declaring `codegen_exempt: { reason, fields }` stays hand-maintained until refactored to fit the defaults (or until v2.5 adds shape constraints that absorb the exempt cases).
- **W2.2 — Schema-from-frontmatter.** SKILL.md frontmatter already declares input expectations informally. v2.5 formalizes this so a SKILL.md update auto-regenerates the JSON schema (or fails the smoke). One source of truth per skill.
- **W2.3 — Catalog smoke at PR boundary.** `npm run smoke:tool-catalog` (introduced in v2.0 Phase 2) gets extended to fail PRs that add a SKILL.md without a matching tool definition. Pre-commit hook, not just CI.
- **W2.4 — CAP-13 onboarding doc.** A 1-page "how to add a new wi-* skill in the loop world" reference that lives next to `CYPHER.md`. Replaces the implicit knowledge that v2.0's manual migration accumulated.

**Acceptance gate:** Time-to-add-a-new-skill drops from "several hours of careful work" to "fill in the codegen + verify" — empirically measured by adding 2 new skills and tracking elapsed time on each.

---

### Risk #3 — Pass-2 priors over-engineering

**The risk:** ADR-034 L1.1 sketches Pass-2 attribution (proportional credit by citation, position, counterfactual). It needs ≥100 closed dispatches + ±15% smoke agreement before promotion out of shadow. The risk is that we ship Pass-2 *infrastructure* in v2.0 (it's already in the spec), the threshold is never reached, and the shadow code rots in the codebase as architectural debt nobody trims.

**The version axis of the learning improvement (read this first).** Cypher's learning loop has three layers, and the version line tells you where each one lives:

| Layer | What it does | Where it ships |
|---|---|---|
| Layer 1 — Pass-1, per-dispatch credit | One outcome row per dispatch; credit goes to every skill that ran in it. Crude — if 3 skills ran and 1 moved the needle, all 3 get equal credit. | v1.4 (already shipping), v2.0 (kept) |
| Layer 2 — `(tool, task_class)` keys | Same Pass-1 mechanism, but priors are keyed on `(tool, task_class)` instead of `tool`. Different postures see different priors for the same tool. Free side effect of the loop having postures. | v2.0 (new) — see [v2.0 PRD § 4.6](./cypher-v2.0.md#46-priors-get-richer-keys-layer-2-learning-enrichment) |
| Layer 3 — Pass-2, per-tool-call proportional credit | Credit is assigned **inside** the loop, every tool call, by citation/position/counterfactual signals. The big shift: from "learning happens once per dispatch" to "learning happens at every tool call." | v2.5 — promote or deprecate (this risk) |

**The v2.5 question is therefore precise:** *should learning move from per-dispatch (Pass-1) to per-tool-call (Pass-2)?* Pass-2 is more expressive — it can tell that 1 of 3 skills actually contributed — but it's also more expensive to compute and harder to validate. Promotion happens only when real evidence (≥100 dispatches + ±15% smoke agreement) shows the expressiveness pays back. Otherwise the simpler Pass-1 wins and the Pass-2 scaffolding gets deleted.

**Why deferred:** Pass-1 + Layer-2 keys is the floor and is sufficient for v2.0. The 100-dispatch threshold won't fire during v2.0 cutover; it's a v2.5-timeline question. Putting the decision in v2.5 forces an explicit "promote or deprecate" choice instead of letting Pass-2 sit in shadow forever.

**v2.5 work:**

- **W3.1 — Pass-2 evidence audit.** At the start of v2.5, count closed dispatches and smoke divergence. If thresholds are met, proceed with W3.2. If not met after 60 days post-v2.0, proceed with W3.3.
- **W3.2 — Pass-2 promotion (if evidence supports it).** Operator flips `CYPHER_PROPORTIONAL_CREDIT=1` default-on. 1-week shadow window per ADR-037 D9. Smoke stays green → priors flip from Pass-1 to Pass-2. If smoke regresses, rollback to Pass-1 and proceed to W3.3.
- **W3.3 — Pass-2 deprecation (if evidence does not support it).** Delete the Pass-2 shadow scaffolding. Update ADR-034 L1.1 status to "deprecated; Pass-1 sufficient." This is the harder path but the honest one — keeping shadow code that never runs is worse than admitting the simpler model wins.

**Acceptance gate:** Either Pass-2 is in production with a smoke-green week behind it, or the shadow scaffolding is gone. No half-measures.

---

### Risk #4 — Brain HTTP surface stays

**The risk:** `/api/brain/*` (recall, decide, verify, context) exists alongside the loop's tool calls because non-Cypher consumers (web UI chat panel, MCP clients calling `wi_brain_context` directly, n8n flows) need a synchronous non-streaming surface. Both paths converge on `decision-engine.ts` so the duplication is thin, but it's still a surface we maintain. The worry is that the parallel surface accumulates divergence — a feature lands on the HTTP route but not in the tool catalog, or vice versa.

**Why deferred:** Removing the HTTP surface in v2.0 would force every consumer onto the loop, which is bigger than v2.0's scope. v2.5 audits each consumer individually and decides per-consumer. Architectural framing (loopless-tool pattern vs legacy) is also v2.5 work — v2.0 made no commitment about HTTP route additions either way. Cross-link: [discussion log Q-1.2](../../../.planning/cypher/12-V2-V2.5-DESIGN-DISCUSSION.md).

**v2.5 work:**

- **W4.1 — Consumer audit.** Enumerate every caller of `/api/brain/*`. For each, ask: (a) does it actually need synchronous non-streaming, (b) could it call `wi_dispatch` with a brain-only goal instead, (c) what's the latency / dependency cost of switching?
- **W4.2 — Migrate the obvious ones.** Any caller where W4.1 says "yes, could switch, low cost" — switch. Web UI chat panel is probably the first candidate (already loop-shaped on the bridge side).
- **W4.3 — Document the irreducibles.** Callers that *must* stay on the HTTP surface (latency-sensitive, third-party, etc.) get explicit documentation of why. Future v3 might revisit; v2.5 just freezes the surface area.
- **W4.4 — Drift detector.** A test that asserts `decision-engine.ts` is the only source of truth — if a feature lands on the HTTP route but not on the tool, smoke fails. Prevents the surface from accumulating divergent behavior.

**Acceptance gate:** Either every caller has documented justification for its surface, or it's been migrated to the loop. The drift detector lands regardless.

---

## 2a. Tracked open questions (not v2.5 commitments)

These are capabilities that v2.0 deliberately did not ship and that v2.5 will not ship by default. They are *named and reachable* so the design space stays open; promotion from "tracked" to "phase plan" requires the gate listed under each.

### Option C — Runtime self-registration of tool definitions

Cypher proposes a `ToolDefinition` JSON inline as part of a Phase 1 plan; the user confirms via the Q-1.10/Q-1.11 propose-confirm primitive; the confirmed definition lands in the catalog at runtime. No separate codegen step — the propose-confirm primitive *is* the registration mechanism.

**Why this is interesting.** It unifies CAP-13 birth with the Phase 1 control flow — one architectural primitive, less surface area. If approved CAP-13 births sit in a TODO column because hand-writing or running W2 codegen is still annoying, Option C is the answer.

**Why this is risky.** Cypher writes a JSON schema that has to validate inputs the loop will later pass. An incorrect schema is a runtime crash hours after approval, in a code path nobody reviewed. Option B (W2 codegen) avoids this by keeping schemas in the developer-review loop.

**Promotion gate (all three legs required):**

1. **Evidence:** ≥12 CAP-13 birth approvals on Option B (W2 codegen) with measured median time-to-register. Data must show codegen friction is high enough to justify runtime self-registration's risk.
2. **Design doc:** explicit treatment of the wrong-schema-equals-future-runtime-crash failure mode. Anyone proposing Option C must answer how a Cypher-proposed JSON schema that miss-validates an input the loop later passes is detected before it crashes a real dispatch.
3. **Schema smoke harness:** runnable test fixture that exercises every Cypher-proposed schema against synthetic inputs *before* the schema is allowed to enter the live catalog. Has to exist as runnable code in a v2.5 phase plan, not as a "we'll write tests" promise.

If any leg fails, Option C stays a tracked open question. The bar is deliberately high because the failure mode is hard to surface and easy to ship.

**Architectural-primitive linkage to Flavor B (below).** Both are the same primitive — Cypher proposes a structured artifact at runtime, user confirms via Phase 1, artifact lands persistently. If Option C ever clears the gate and ships, **Flavor B is a free side effect**; if Option C stays unshipped forever, Flavor B also stays unshipped.

Cross-link: [discussion log Q-1.5 sub-question 3](../../../.planning/cypher/12-V2-V2.5-DESIGN-DISCUSSION.md).

### Flavor B — Runtime extension of `result_meta.outcome` enum

Cypher proposes a new external `result_meta.outcome` value at runtime (e.g., observing a recurring unmapped condition like API rate-limiting); user confirms via the Phase 1 propose-confirm primitive; once confirmed, the value lands in the enum + values-history table without a developer-mediated PR.

**v2.0 ships Flavor A only.** Flavor A is developer-mediated — telemetry surfaces a real gap, a developer reviews it, opens a PR adding the enum value + a row to the values-history table at `docs/docs/architecture/contract-evolution.md`, and the addition lands in the next release. Removals are never allowed; Contract B is closed-at-launch (six values: `success`, `partial`, `blocked`, `needs_user_input`, `budget_exhausted`, `error`) and additive-only post-launch. Cross-link: [discussion log Q-1.3](../../../.planning/cypher/12-V2-V2.5-DESIGN-DISCUSSION.md).

**Why Flavor B is deferred to v2.5.** Cypher proposing new external-contract values at runtime is a CAP-13-adjacent capability that touches several questions v2.0 doesn't answer (who confirms the addition? does the confirmation persist across restarts? what's the rollback if the addition was wrong?). v2.0 telemetry from Flavor A's gap-rate is the input signal for "is Flavor B worth building."

**Promotion gate.** Same architectural primitive as Option C. If Option C clears its gate, Flavor B is a free side effect — the propose-confirm primitive that admits new tool definitions also admits new enum values. Independent shipment of Flavor B without Option C is not planned.

---

## 3. Sequencing

v2.5 work is **not a single coherent phase**. It's four independent work streams gated by independent evidence:

```
v2.0 ships ──┬─→ Risk #1 work begins when 200+ dispatches accumulate
             ├─→ Risk #2 work begins when v2.0's manual migration converges
             ├─→ Risk #3 work begins at v2.0 + 60 days OR threshold met (whichever first)
             └─→ Risk #4 work begins when consumer audit fits in a sprint
```

Streams can run in parallel where they don't conflict. Risk #2 (W2.1–W2.4) might land in week 2 post-v2.0 because its evidence is already accumulated by v2.0's migration. Risk #3 might wait 60 days for the dispatch threshold. There is no "v2.5 is shipped" date — v2.5 is shipped when all four acceptance gates have closed.

---

## 4. Out of scope — pushed to [v3.0]

Anything that breaks the v2.0 architectural shape is out of scope:

- **Multi-agent fan-out beyond the loop.** v2.0 ships one reactive agentic loop. Anything that wants a second loop (parallel investigation across projects, coordinated multi-step PR refactors, etc.) is v3.0 territory.
- **Replacing `decision-engine.ts`.** v2.5 W4 might shrink the HTTP surface; it does not replace the underlying engine.
- **New ADRs.** v2.5's architectural commitment is captured in [ADR-038](../adr/adr-038-cypher-v2.5-production-grade.md) (drafted 2026-06-18, revised 2026-06-19). v2.5 work items beyond ADR-038's scope belong in v3.0.

---

## 5. References

- **Predecessor PRD:** [Cypher v2.0](./cypher-v2.0.md) (must reach § 7 acceptance before v2.5 begins)
- **Doctrine:** [`CYPHER.md`](../../../CYPHER.md)
- **ADRs:** [ADR-038](../adr/adr-038-cypher-v2.5-production-grade.md) (primary), [ADR-037](../adr/adr-037-cypher-tool-use-loop.md), [ADR-036](../adr/adr-036-cypher-cli-primary.md), [ADR-034](../adr/adr-034-cypher-learning-autonomy-engine.md)
- **Execution plan:** [`.planning/cypher/11-ADR-037-EXECUTION-PLAN.md`](../../../.planning/cypher/11-ADR-037-EXECUTION-PLAN.md)
