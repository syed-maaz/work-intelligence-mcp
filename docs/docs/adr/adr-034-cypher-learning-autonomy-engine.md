---
sidebar_label: "ADR-034: Cypher Learning & Autonomy Engine"
sidebar_position: 34
title: "ADR-034: Cypher Learning & Autonomy Engine — Evidence-Pulled, Not Waterfall"
status: Accepted (2026-06-14, post-CAP-12-FIX + CAP-13 patch round)
date: 2026-06-14
---

# ADR-034: Cypher Learning & Autonomy Engine — Evidence-Pulled, Not Waterfall

**Scope**: Work Intelligence MCP. Defines the engine that makes Cypher *measurably* self-improve — the measurement substrate, the learning algorithm, dynamic model routing, self-evolution proposals, and bounded autonomous execution.
**Relationship to [ADR-033](./adr-033-cypher-framework.md)**: ADR-033 §10 *described* closed-loop learning behaviors but gave them **no measurement substrate**. This ADR provides that substrate and the algorithms that act on it. 033 §10 is the behavior contract; **034 is the engine that satisfies it.** This ADR does not re-decide anything in 033 (CAP-12 buckets, CAP-13/14, the PM lens, `granted_permissions`, the authority matrix) — it references them.
**Builds on (shipped — verified 2026-06-14)**:
- `skill_priors` Beta table (033 schema v59).
- The Cypher session/step spine + `cypher_sessions.outcome` (v59).
- The PM lens `work_items` + `work_item_links` + complexity scorer (v60).
- **CAP-12-FIX (v61 + v62, commits `e494486` + `c33b59e`)** — `cypher_sessions.skill_actually_invoked` JSON column + `recordSkillOutcomes` plural form + `/wi-record-outcome --used` flag + `pre_fix_runs` hybrid backfill marker. **Closes the credit-assignment bias** (priors were updating from `chosen_skill` regardless of whether the skill ran). The outcome signal in 033 is now honest at the per-skill level — Layer 1 of this ADR *expands* that signal; it does not create it.
- **CAP-13-LITE (v63, commit `4e73e69`)** — `skill_gap_observed` table + `run.ts` plan-stage trigger using `getEffectivePriors` with `pre_fix_runs` downweight at 0.2. Records "no candidate had effective_mean ≥ 0.5" rows per dispatch. Recognition step of the self-extension loop. **Layer 4 of this ADR *extends* this** with nightly clustering + cross-project signal; it does not duplicate it.
- **CAP-13-FULL stub — NEVER MERGED to master (clarified 2026-06-24).** Originally drafted in commits `7ffce96` / `6fd56f4` / `a0d1afb` / `8f18bcd` on branch `adr-032-blocker-fixes-and-prd` (2026-06-14): `skill_proposals` table + `clusterGaps` (≥3-row clusters) + `draftProposal` (stub-v1 template; LLM swap deferred under `CAP-13-DRAFTER-EVAL`) + structural verifier + 7 HTTP routes + 18 unit tests. Schema numbers (branch v61–v64) collided with master's independent v61–v66 work, the branch fell 159 commits behind master, and the integration was wired into the v1.4 pipeline being deleted on 2026-07-21 per ADR-037 Phase 7. **Re-imagining against the loop and the v68 schema baseline is ratified in [ADR-037.5](./adr-037-5-cap13-skill-self-extension.md).** Read-only snapshot of the spike preserved at `.planning/spikes/2026-06-14-cap-13-original/`.
**Related**: [ADR-014](./adr-014-self-learning-investigation-brain.md) (brain priors/decay precedent), [ADR-024](./adr-024-unified-brain.md), [ADR-031](./adr-031-per-bucket-model-effort-config.md) (buckets), [ADR-033](./adr-033-cypher-framework.md).

---

## Executive summary

Cypher is supposed to get better the more it's used. **As of 2026-06-14, the per-skill credit assignment is honest** (CAP-12-FIX shipped earlier today: priors move only for skills actually invoked, contaminated pre-fix runs are flagged for downweight). What's still missing is a **multi-signal outcome ledger** that aggregates the user verdict with mechanical signals (CI, merge, rerun-detector, edit-distance) so "did this engagement actually help?" can be measured without a single source of truth being noise. This ADR adds that ledger, then layers Bayesian priors with decay + Thompson sampling, learned per-`(model, bucket, task_class)` routing, a nightly pattern detector that *extends* CAP-13-LITE's per-dispatch recognition, and bounded sprint decomposition.

**The one rule that governs how this is built: it evolves in use; it is not a waterfall.** We ship the thinnest usable slice, run each capability in **observe-only (shadow) mode** first, and let real usage produce the evidence that promotes it to active and *pulls the next capability into existence*. The only thing built up-front "on faith" is the outcome ledger's mechanical signals — because they are the instruments that tell us what to build next. There is no "build the whole thing, then use it, then fix it" phase. Ever.

---

## The governing principle (non-negotiable): evidence-pulled, not plan-pushed

This is the most important part of this ADR. If a future reader takes one thing, take this.

**We do not build this engine as a 5-week phased plan.** We build it as a loop that mirrors the product itself:

> Cypher gets better from outcomes. The *build of* Cypher gets better from the same outcomes. Same signal, two consumers.

Concretely, every capability below obeys four rules:

1. **Always-shippable, always-in-use.** No capability has a "feature-complete, now integrate and test" stage. The smallest useful version ships and is dogfooded on real `/wi` work immediately. Hardening happens *in place, under load* — not in a separate fix phase.
2. **Shadow → Active → Tuning, never "Done."** Each capability ships in **observe-only mode first** — it records what it *would* do (which skill it *would* pick, which model it *would* route to, which skill it *would* propose) without changing behavior. It is promoted to **active** only when its own recorded data clears an explicit bar. Then it **tunes continuously** from live signal. Nothing is ever frozen as "finished."
3. **Triggers, not timelines.** A capability is built **when the evidence pulls it**, not on a date. "We add dynamic model routing when `model_priors` actually have data," not "in week 3." The Evolution Order below is a list of *triggers*, deliberately **not** a Gantt chart.
4. **Only the instrument is built on faith.** The outcome ledger (Layer 1) is the one thing we build before we have evidence it's needed — because it is *how we get evidence*. Everything after Layer 1 must point at ledger data to justify its own existence.

The anti-pattern this forbids: speccing all five layers, building them over five weeks, then discovering in week six that the priors are random because the signal was never wired. **Build the instrument, use the system, let usage write the roadmap.**

---

## Context

After 033's foundation shipped (Cypher spine v59, PM lens v60), and after the CAP-12-FIX + CAP-13 work was prototyped on `adr-032-blocker-fixes-and-prd` (branch v61–v64, *never merged to master* — re-imagined under [ADR-037.5](./adr-037-5-cap13-skill-self-extension.md)), the strongest *remaining* gap is **multi-signal outcome measurement**:

- `skill_priors` (Beta α/β) is now updated honestly per-skill thanks to CAP-12-FIX's `skill_actually_invoked` array — but the only signal feeding it today is the **user verdict at session close** (`success | mixed | failed`). One signal, subjective, post-hoc.
- 033 §10 lists six closed-loop learning behaviors ("lower the prior when skill X fails 3×…") that *can* now run on honest data, but **the meaning of "fails" is still single-sourced** (just the user's verdict). To act on patterns like "Cypher's diff was merged unchanged" or "smoke broke after this commit" we need mechanical signals.
- CAP-12 routing is **static** — buckets pick a fixed model; there is no learning that Sonnet beats Haiku for TS refactors.
- CAP-13-LITE was designed to recognize per-dispatch gaps (effective_mean < 0.5) and CAP-13-FULL stub was designed to close the lifecycle (cluster → draft-stub → verify → human-gate). **Both live on the unmerged `adr-032-blocker-fixes-and-prd` branch and are re-imagined under [ADR-037.5](./adr-037-5-cap13-skill-self-extension.md).** **What's missing is the *temporal* + *cross-project* dimension** — nightly aggregation, recurring-pattern weighting, encapsulable filtering. L4 below is exactly this extension, and it will consume CAP-13-LITE's output once CAP-13-LITE ships under ADR-037.5.
- The PM complexity scorer + HALT (v60) handle single-goal triage, but multi-wave decomposition is undecided.

Without **mechanical signals to corroborate the user verdict**, every learning layer above runs on one weak input. That is why the multi-signal ledger is Layer 1 of this ADR and everything else is pulled by it.

---

## Decision

Build a learning/autonomy engine as **one foundation + five evidence-pulled capabilities**, governed by the principle above. Schema is **concept + behavior only** here; concrete tables, columns, and migration versions are assigned at implementation time.

> **Schema-version coordination — CORRECTED 2026-06-24.** The 2026-06-14 framing of this line was *"ADR-033's CAP-12-FIX + CAP-13 work has now shipped, claiming v61–v64."* That was incorrect: the work was prototyped on `adr-032-blocker-fixes-and-prd` but never merged to master. Master walked forward with its own v61–v66 numbering for unrelated DDL while the branch sat unmerged. Re-imagining (including the corrected schema numbering, starting from v69+ against master's v68 baseline) is ratified in [ADR-037.5](./adr-037-5-cap13-skill-self-extension.md). The implementer **reads `CURRENT_SCHEMA_VERSION` at write-time** and takes the next free integer. Numbers in this ADR remain indicative, not authoritative.

> **Canonical `task_class` taxonomy (loadbearing).** Priors are keyed by `task_class`. Today the values are informal — `build-feature`, `smoke`, `dispatch`, `docs`, `ops`, `understand`, `refactor`, `documentation`, `*`. **A fluid taxonomy leaks priors** (today's `build-feature` becomes tomorrow's `feature-build` via typo or refactor; the priors split, signal dilutes). Before L2 is promoted from shadow to active, this ADR's implementer MUST: (a) write the canonical enum into `src/services/cypher/task-class.ts` (or equivalent), (b) add a CHECK constraint or write-time validator that rejects unknown values, (c) provide a migration that maps current free-form values to canonical ones. The pattern detector (L4) can propose new task_class values, but only via the human-gated channel — never auto-add. Without this, every prior in this ADR is on shifting sand.

### Layer 1 — Outcome ledger (the seed; the only thing built up-front)

A `cypher_outcomes` ledger records **multiple weighted signals per engagement**, aggregated into one normalized score. This is the instrument.

Signal hierarchy (illustrative weights; tuned from real data):

| Signal | Weight | Captured by |
|---|---|---|
| Tests pass + PR merged unchanged | 1.0 | CI webhook + git diff (Cypher output vs final) |
| User explicit thumbs-up | 0.8 | one-click UI affordance |
| Tests pass + PR merged with edits | 0.5 | edit-distance heuristic |
| No signal within 48h | 0.0 | **treat as unknown — do not update priors** |
| Re-dispatch within 24h, same goal | −0.7 | scheduled `rerun_detector` |
| Smoke fails after a Cypher commit | −0.9 | CI signal |
| User explicit thumbs-down | −1.0 | one-click UI affordance |

**Invariants:** signals are **weighted-aggregated, never single-source** (never move a prior on one weak signal); a missing signal is *unknown*, not *negative*; deterministic signals (CI / merge / rerun) outrank subjective ones; **no LLM judges outcomes** — measurement is mechanical.

**Phased signal landings — explicit, since "ledger v1 = 6 signals" is misleading:**

| Slice | Signals added | Cost | Triggers downstream |
|---|---|---|---|
| **L1.0 (today, post-CAP-12-FIX)** | User verdict via `cypher_sessions.outcome` (existing) — single-signal baseline. | shipped | Honest per-skill prior updates already work via `recordSkillOutcomes` |
| **L1.1 — first new slice** | + `rerun_detector` (pure SQL: same goal text re-dispatched within 24h → −0.7) + thumbs-up/down UI affordance (one-click on the visibility panel) | ~½ day | **2 mechanical signals + verdict** = 3-source aggregation works |
| **L1.2** | + edit-distance heuristic on PR merges (when there *is* a PR; many sessions don't have one) | ~1 day | Distinguishes "merged unchanged" 1.0 from "merged with edits" 0.5 |
| **L1.3** | + CI webhook integration (auth, endpoint, mapping CI run → `cypher_session_id`) | **multi-day** — own slice; do not bundle | Unlocks the 1.0 / −0.9 deterministic signals |
| **L1.4+** | + cross-PR / cross-commit signal traceability (commit ↔ session ↔ work_item ↔ CI run) | ~1 day | Enables L3 cost-quality model routing on real CI data |

Building L1.0 is automatic (it shipped). **Ship L1.1 first** — that's the smallest slice that gives multi-signal aggregation. L1.2/L1.3/L1.4 are pulled by usage, in that order. **Do not bundle L1.3 (CI webhooks) into "Layer 1 v1"** — it has its own auth + mapping + reliability concerns and needs its own slice.

**Storage:** the ledger (and all 034 tables) live in WI `data.db`, consistent with 033's storage placement — all consumers live in WI.

### The five capabilities (pulled by evidence, listed in dependency order — NOT a schedule)

Each row states the **trigger that pulls the capability into existence** and the **mode it ships in**. Build a row only when its trigger fires.

> **Pre-L2 gate — CAP-12-FIX dogfood (the real first link).** L2's priors learn from `skill_actually_invoked` arrays populated by either (a) the auto-execute success path or (b) explicit `--used` flags on `/wi-record-outcome`. As of 2026-06-14 the *plumbing* is in but the *discipline* is not — `wi-investigate.smoke` shows `pre_fix_runs=38` and `post_fix_runs=0`, meaning zero post-CAP-12-FIX honest signal yet. **Until the user dispatches with `--used` (or auto-execute fires) on enough sessions to produce ≥10 honest credit events across ≥2 task_classes, L2's priors are still uninformative.** L2 cannot promote out of shadow until this gate clears. The CAP-13-DRAFTER-EVAL evaluation at 2026-06-21 is the first hard checkpoint where this discipline gets reviewed.

| Capability | What it adds | Pulled into existence when… | Ships in mode |
|---|---|---|---|
| **L2 — Bayesian selection** | Skill priors with **90-day decay** + **Thompson sampling** (not argmax) for skill choice | the ledger (post-CAP-12-FIX dogfood gate above) holds enough honest outcomes that a task-class's priors beat random | **shadow** (log would-pick vs. actual) → active when shadow agrees with good outcomes |
| **L3 — Learned model routing** | `model_priors` per `(model, bucket, task_class)` → dynamic pick *within* a bucket | `model_priors` have accumulated real cost/quality data on the non-reasoning buckets | **shadow** → active **only on `fetch`/`digest`/`agents`**; reasoning lanes stay pinned |
| **L4 — Self-evolution detector** *(extends CAP-13-LITE)* | **Nightly aggregation** over `plan_shape_gap_observed` (v69, shipped 2026-06-25 per [ADR-037.5 v2](./adr-037-5-cap13-skill-self-extension.md)) + `cypher_outcomes`: cluster by goal-text similarity (currently per-task_class only — v2 adds cosine intra-class), apply **encapsulable / 19→5 filter**, fire on **cross-project recurrence** (≥2 projects → ADR-032 promote channel). α-FULL (drafter + `skill_proposals` lifecycle) is deferred per ADR-037.5 v2 D2; L4 consumes the gap-observation rows directly | the per-dispatch trigger (CAP-13-LITE recognition hook, shipped) writes plan-shape-keyed gap rows; L4 clusters them nightly | **observation-only**; never auto-activates; **pure SQL detector with no default LLM** — α-FULL's drafter is the only LLM path and remains deferred until corpus argues for it |
| **L5 — Permission escalation** | `granted_permissions` ledger (concept from 033 §10) so standing grants escalate CONFIRM→AUTO within scope | re-asking friction actually bites — you grant the same action ≥3× | **off by default**; grants are scoped, expiring, revocable; ALWAYS-MAAZ never grantable |
| **L6 — Bounded sprint execution** | Sprint planner (Sonnet) + DAG executor over `work_items` with `parent_sprint_id`; waves dispatch via CAP-11 | the slicer is *proven*: **≥3 successful heavy-path executions** via the 033 complexity scorer, with **≤1 re-dispatch in 24h** for the same goal, across **≥2 distinct task-classes** | **HALT-before-execute** always; AUTO chains, CONFIRM queues, ALWAYS-MAAZ stops (resumable — see design notes); **own budget knob `CYPHER_SPRINT_DAG_BUDGET` separate from `CYPHER_AUTO_EXECUTE_PER_HOUR`** — see Finding 6 below |

**L6 is the riskiest layer and gets the hardest gate** — it is where autonomous-agent projects implode (033 R13, autonomy creep). It is last not by schedule but because its trigger (recurring heavy multi-wave work + a proven slicer) is the slowest to fire.

### Capability design notes (review-hardened 2026-06-14)

Six constraints that the headline rows above gloss over but the implementation must honor:

- **L3 selection is *cost-adjusted*, not accuracy-maximizing.** `model_priors` carry cost + latency per `(model, bucket, task_class)`, and the selector picks the **cheapest model whose learned quality clears the bucket's quality bar** — not the single most-accurate model. Without this, `fetch`/`digest` would converge back onto the expensive model and the whole point of dynamic routing (cost savings on cheap-shaped work) is lost. Hard latency/cost ceilings filter candidates *before* the Thompson sample.
- **L4 detector carries CAP-13's encapsulable filter and a 4th trigger.** Beyond recurring-failure / manual-edit / repeated-investigation, the detector also fires on **cross-project recurrence** (same lesson learned in ≥2 projects → propose promotion via the **ADR-032 gate**, per 033 §3). And every candidate passes CAP-13's **encapsulable gate / 19→5 filter** first (only skill-shaped pains become skills; rule-shaped pains become memory entries) — otherwise proposals are noisy. The detector *proposes*; it never bypasses the human gate or the dogfood (CAP-13 D3).
- **L6 ALWAYS-MAAZ gates are *resumable*, not terminal.** When the DAG hits an ALWAYS-MAAZ node it halts that branch and emits a **resumable checkpoint** (returns the manual action to Maaz). Maaz performs it and signals resume; the executor continues from the next node. The sprint is **never dead-ended** by a manual gate — a missing resume path was the failure the review caught.
- **L6 has its own budget gate, separate from CAP-12-FIX's auto-execute cap.** CAP-12-FIX's `CYPHER_AUTO_EXECUTE_PER_HOUR` (default 30) gates per-dispatch auto-invocations. **L6 fans out into N dispatches under one user intent** — a 5-node DAG could chain 5 dispatches in a single sprint, blowing past the per-dispatch budget without the gate noticing. L6 needs a sibling knob `CYPHER_SPRINT_DAG_BUDGET` (default: cap on total nodes per sprint, e.g. 8; cap on total dispatches per hour summed across active sprints, e.g. 50). The L6 budget reads CAP-12-FIX's budget state and respects it (a sprint pauses if the per-user auto-execute cap is exhausted) but adds its own ceiling on top. Without this, L6 is the autonomy-creep failure mode in concrete numeric form.
- **L2 decay has a floor, paired with retirement.** Decayed priors never shrink below a small evidence floor, and a skill whose decayed evidence falls under that floor is **not silently re-selected on cold data** — it routes to **CAP-14 retirement-review** instead. Decay (down-weight) and CAP-14 (remove) are the paired forgetting mechanism; neither alone is sufficient.
- **L4 detection is pure SQL — no default LLM.** The nightly pattern detector is SQL aggregation over `cypher_outcomes` + `plan_shape_gap_observed` (recurrence counts, edit-pattern grouping); it has **no LLM call and no bucket/budget of its own**. α-FULL's drafter (the SKILL.md path) is deferred per ADR-037.5 v2 D2; if/when it ratifies, the LLM call lives in a separate module from this detector. A future implementer must not add an LLM to the detector itself by default.
- **L2 → L3 is a natural serial dependency (not parallel).** `model_priors` (L3) cannot accumulate until L2 is routing real work through the outcome ledger, so L3's trigger only fires after L2 is active. This is handled by the triggers — no scheduling needed — but don't expect L2 and L3 to be developed in parallel.

### Engine-wide invariants (carried from 033, restated as guardrails here)

- **Human gate on every persistent self-modification.** No auto-activated skills, no self-rewritten thresholds, no self-edited system prompt — ever. (033 R13.)
- **Decay everything, with a floor + retirement pairing.** 90-day half-life on priors, 60-day on memory, but priors never decay below a small evidence floor, and a skill whose evidence falls under it routes to **CAP-14 retirement-review** rather than being silently re-selected on stale data. A learning system without forgetting is a hoarding system that degrades; decay down-weights, CAP-14 removes.
- **Observe-then-act.** Every capability proves itself in shadow before it drives behavior.
- **Reasoning lanes pinned.** `analyse` / `decide` / `bug-investigator` / `bug-resolver` keep `dynamic_routing:false` and empty fallback chains — learned priors may never silently downgrade them.
- **Mechanical measurement.** Outcomes come from CI / merge / rerun / explicit clicks — not from an LLM grading itself.

---

## Consequences

### Positive

- **Learning stops being faith-based.** Once the ledger exists, "is Cypher improving?" becomes a query (week-over-week first-shot success rate per task-class), not a vibe.
- **The build can't run off a cliff.** Evidence-pull + shadow-mode means a capability that doesn't help never gets promoted — you find out from data, in use, not after a five-week build.
- **Routing self-optimizes within safe bounds.** Cheap models win where they're good; reasoning lanes stay protected.
- **The catalog stays personalized and bounded.** Pattern-detector proposals (human-gated) + CAP-14 retirement mean the skill set reflects *your* patterns, earned via evidence.

### Negative

- **Cold start is slow.** Priors are uninformative until ~30–60 days of real usage. Thompson sampling's early exploration is a feature, but the system "feels" most generic exactly when first adopted.
- **Shadow mode adds bookkeeping.** Every capability runs twice (would-do + actual) during its shadow phase. Worth it; not free.
- **Signal capture has real surface area.** CI webhooks, a rerun detector, edit-distance diffing, and UI affordances all have to actually work, or the ledger is noise.

### Risk register

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| L-R1 | **No outcome signal → "learning" is fake.** Priors update from noise. | HIGH | Ledger is Layer 1; nothing downstream promotes out of shadow until the ledger has clean signal. Build the unsexy instrument first. |
| L-R2 | **Self-mutation without a gate → drift.** Cypher silently changes its own behavior. | HIGH | Hard line: every persistent change is human-approved. No auto-activate, no self-rewrite. (033 R13.) |
| L-R3 | **No forgetting → bloat → degradation.** Ancient evidence weighted equally; skills accumulate. | HIGH | Decay everything (90d priors / 60d memory); CAP-14 retirement valve. |
| L-R4 | **Shadow mode that never promotes.** A capability sits in observe-only forever; no one defines the bar. | MED | Each capability ships **with its promotion bar written down** (e.g. "active when shadow-pick matches good-outcome pick ≥X% over N engagements"). No bar = not ready to start. |
| L-R5 | **Signal gaming.** Thresholds/signals become known; behavior drifts to farm good signals. | MED | Multi-signal aggregation; prefer hard CI/merge signals over clickable ones; monthly calibration review. |
| L-R6 | **L6 autonomy creep.** DAG executor acts beyond bounds. | HIGH | HALT-before-execute; AUTO chains only within the authority matrix; ALWAYS-MAAZ stops; gated behind proven slicer + recurring need. |

---

## Alternatives considered

| # | Alternative | Why rejected |
|---|---|---|
| **Alt 1** | **Waterfall build** — spec all 5 layers, build over ~5 weeks, then integrate/use/fix | **Explicitly rejected — this is the whole point of the ADR.** A waterfall discovers in week 6 that priors are random because signal was never wired. Evidence-pull + shadow-mode makes each layer prove itself in use before the next is built. |
| **Alt 2** | **argmax skill/model selection** | Locks in early winners, never explores, brittle on cold start. Thompson sampling explores natively without an explicit ε and is cold-start-safe. |
| **Alt 3** | **LLM judges its own outcomes** | Non-reproducible, gameable, expensive, and circular (the thing being evaluated grades itself). Use mechanical signals (CI/merge/rerun/clicks). |
| **Alt 4** | **Fold this into ADR-033 (as another section / "033 v2")** | 033 is already overloaded and Accepted (immutable per repo rule). This is a coherent, separable decision with its own engine; it earns its own ADR. |
| **Alt 5** | **Dynamic routing on all buckets including reasoning lanes** | Learned priors could silently downgrade `analyse`/`decide`/`bug-*` where wrong answers cost more than 10× the call. Pin reasoning lanes; learn only on `fetch`/`digest`/`agents`. |

---

## Evolution order (pull-triggered — read as triggers, not a timeline)

```
SHIPPED 2026-06-14 (precondition)        ── ADR-033 v1: spine, PM lens, CAP-12-FIX,
                                             CAP-13-LITE recognition, CAP-13-FULL stub
                                             lifecycle. cypher_sessions.outcome is
                                             the single-signal baseline.
        │
        ▼  (gate: ≥10 honest credit events on `skill_actually_invoked`
                  across ≥2 task_classes — checkpoint at 2026-06-21
                  via CAP-13-DRAFTER-EVAL review)
L1.0 BASELINE (already in place)         ── verdict-only signal, post-CAP-12-FIX honest
        │
        ▼  (trigger: ≥10 dispatches with --used or auto-execute)
L1.1 FIRST NEW SLICE                     ── rerun-detector (SQL) + thumbs UI on
                                             /cypher panel. 3-source aggregation.
        │
        ▼  (trigger: PR-shaped sessions become common)
L1.2 EDIT-DISTANCE                       ── merge-with-edits vs merge-unchanged
        │
        ▼  (trigger: CI integration deemed worth the auth/mapping cost)
L1.3 CI WEBHOOK                          ── deterministic 1.0 / -0.9 signals
        │
        ▼  (trigger: ledger has clean outcomes per task-class)
ENABLE LEARNING IN SHADOW                ── L2 priors+decay+Thompson, observe-only
        │
        ▼  (trigger: shadow-pick tracks good outcomes ≥ bar)
PROMOTE L2 TO ACTIVE                     ── skill selection now learned
        │
        ▼  (trigger: model_priors have data on non-reasoning buckets)
L3 dynamic routing (shadow→active)       ── fetch/digest/agents only; reasoning pinned
        │
        ▼  (trigger: skill_gap_observed shows ≥3× recurring patterns
                     OR cross-project recurrence ≥2)
L4 NIGHTLY DETECTOR                      ── extends CAP-13-LITE per-dispatch
                                             recognition with nightly aggregation +
                                             encapsulable filter + cross-project signal.
                                             Feeds existing skill_proposals lifecycle.
        │
        ▼  (trigger: you grant the same action ≥3×)
L5 granted_permissions escalation        ── scoped, expiring, revocable
        │
        ▼  (trigger: heavy multi-wave work recurs AND slicer proven on proof points)
L6 sprint planner + DAG executor         ── HALT-before-execute; the hardest gate;
                                             own CYPHER_SPRINT_DAG_BUDGET budget;
                                             last to fire
```

This is **not a schedule.** Any trigger that never fires means that capability is never built — correctly. The system tells you what it needs by being used.

> **Relationship to v1.4 (ADR-033) — UPDATED 2026-06-14:** ADR-033 v1 *did* ship the Layer-1 baseline as part of CAP-12-FIX (`cypher_sessions.outcome` + `skill_actually_invoked` + honest `recordSkillOutcomes`). The first slice this ADR calls for in fresh code is **L1.1** (rerun-detector + thumbs), which the next implementer picks up after the 2026-06-21 CAP-13-DRAFTER-EVAL review. Do not batch L1.1 with L1.3 (CI webhooks); they have different cost shapes.

---

## Open questions

1. **Promotion bars.** What exact bar moves each capability shadow → active? (Proposed default: shadow-pick matches the better-outcome choice on ≥70% of ≥20 engagements in a task-class.) Tune from first real data.
2. **~~Task-class taxonomy~~ — RESOLVED inline.** Canonical enum + write-time validator + migration mapping current free-form values is now a **load-bearing precondition** for L2 promotion (not "lean: hand-seed and let pattern detector propose"). See the boxed `task_class taxonomy` paragraph in §Decision. The pattern detector (L4) can still propose new values, but only via the human gate.
3. **Rerun-detector window.** 24h default for "same goal re-dispatched" — confirm against real session cadence. (First implementer should query `cypher_sessions` group-by goal-similarity to calibrate before hard-coding.)
4. **Edit-distance threshold** for "merged with edits" (0.5 signal) vs "merged unchanged" (1.0).
5. **L1.1 thumbs UI placement.** Phase-81 visibility panel is the obvious home (one-click on each session row). Confirm with phase-81 owner before bundling into the next visibility-panel iteration vs adding as a separate route.
6. **L6 budget scaling — `CYPHER_SPRINT_DAG_BUDGET` defaults.** Proposed: 8 nodes per sprint, 50 dispatches per hour summed across active sprints. Tune from L6 dogfood once the slicer-proven trigger fires.

*(Resolved during drafting: the ledger lives in WI `data.db`, consistent with 033's storage placement — stated in Layer 1.)*

---

## Cross-references

| Decision | Lives in |
|---|---|
| Closed-loop learning *behaviors* (the contract this engine satisfies) | ADR-033 §10 |
| `skill_priors` Beta table (shipped) | ADR-033 schema v59 |
| CAP-12 buckets + critical-reasoning pin | ADR-033 CAP-12 / ADR-031 |
| CAP-13 proposal gate + dogfood; CAP-14 retirement | ADR-033 §6 |
| `granted_permissions` concept | ADR-033 §10 (engine/implementation here as L5) |
| PM complexity scorer + HALT-before-execute (shipped) | ADR-033 "Cypher PM" §, schema v60 |
| Authority matrix (AUTO / CONFIRM-THEN-DO / ALWAYS-MAAZ) | ADR-033 §1 |

---

## When this ADR is Accepted

- Status: Proposed → Accepted with Maaz signoff.
- **L1.0 baseline (post-CAP-12-FIX) is in place** as of 2026-06-14 (commits `e494486` + `c33b59e` on `adr-032-blocker-fixes-and-prd`). No new code is required for L1.0.
- **L1.1 (rerun-detector + thumbs UI) is the first new slice this ADR calls for** — picked up after the 2026-06-21 CAP-13-DRAFTER-EVAL review confirms ≥10 honest credit events have accumulated. If the ledger is starved (no `--used` discipline), L1.1 is built anyway because rerun-detector is a pure-SQL backfill that doesn't depend on `--used`.
- Every subsequent layer (L1.2, L1.3, L2, L3, L4, L5, L6) is built **only when its trigger fires**, ships in **shadow mode**, and carries a **written promotion bar**.
- A one-line pointer is added to ADR-033 §10 noting the behaviors there are realized by this engine, with an explicit *what's pending* qualifier: CAP-12-FIX (honest priors, on unmerged branch — re-imagined under [ADR-037.5](./adr-037-5-cap13-skill-self-extension.md)) + CAP-13-LITE per-dispatch recognition (re-imagined under ADR-037.5) + CAP-13-FULL stub lifecycle (re-imagined under ADR-037.5).
- The **canonical `task_class` enum** lands as a precondition for L2's shadow→active promotion, not as part of L2 itself.

---

## Implementation status

| Layer | Status | Shipped via | Notes |
|---|---|---|---|
| **L1.0 baseline (verdict-only)** | ✅ shipped | CAP-12-FIX (`e494486`, `c33b59e`) on `adr-032-blocker-fixes-and-prd` (2026-06-14) | `cypher_sessions.outcome` honest per-skill via `skill_actually_invoked`. |
| **L1.1 — rerun-detector + thumbs UI** | ✅ shipped | branch `adr-034-l1-1-thumbs-ui` (2026-06-16). Three commits: schema + aggregation (C1), dispatch wire (C2), endpoint + UI + smoke + docs (C3). | Schema **v64** (`cypher_outcomes` ledger, value/weight/metadata, FK CASCADE, partial index on rerun/thumbs); `src/services/cypher/outcomes.ts` with `aggregateOutcome` (weighted-mean clamped to [-1,1]), `recordOutcomeSignal` (UPSERT on `(session_id, signal_kind, created_by)`), `detectRerun` (24h normalized exact-match SQL window, writes against the EARLIER session); `POST /api/cypher/outcomes` + `GET /api/cypher/outcomes/:id` endpoints with kill-switch routing (`CYPHER_OUTCOMES_DISABLED`, `CYPHER_OUTCOMES_THUMBS_DISABLED`, `CYPHER_OUTCOMES_RERUN_DISABLED`); `ThumbsControl` 👍/👎 affordance on the `/cypher` visibility panel session rows; smoke § 22 (5 sub-checks); 34 vitest cases under `tests/db/v64_migration.test.ts` + `tests/services/cypher/outcomes.test.ts`. PRD: `.planning/phases/87-adr-034-cypher-learning-engine/PRD.md`. |
| **L1.2 — edit-distance heuristic** | ⊘ not started | trigger: PR-shaped sessions become common | Own slice per evolution order. |
| **L1.3 — CI webhook** | ⊘ not started | trigger: CI integration deemed worth the auth/mapping cost | Own multi-day slice. |
| **L2 — Bayesian + Thompson** | ⊘ not started | trigger: ledger has clean outcomes per task-class + ≥10 honest credit events + canonical `task_class` enum landed | Ships in shadow first. |
| **L3 — learned model routing** | ⊘ not started | trigger: `model_priors` accumulated on non-reasoning buckets | Reasoning lanes pinned. |
| **L4 — nightly self-evolution detector** | ⊘ not started | trigger: ≥3 recurring goal-shape clusters OR cross-project recurrence ≥2 | Extends CAP-13-LITE; pure-SQL detector (no LLM). |
| **L5 — granted_permissions escalation** | ⊘ not started | trigger: same action granted ≥3× | Scoped, expiring, revocable. |
| **L6 — sprint planner + DAG executor** | ⊘ not started | trigger: ≥3 successful heavy-path executions + slicer proven | The hardest gate; own budget knob. |

**Each layer ships with a written promotion bar at landing time** — no layer is promoted out of shadow without one.
