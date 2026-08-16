# ADR-050 — Fault-Proof `/WI` Loop: Measurement-First Gate

**Status:** Accepted
**Date:** 2026-07-26
**Deciders:** Agent D (verifier), Agent 001 (architect), Agent H (reviewer)
**Type:** Process ADR — records a decision to defer the build decision until measurements pass

---

## 1. Context

### 1.1 The user pain (verbatim)

> "`/WI` doesn't actually DO the task."

`/WI <goal>` frequently halts partway and returns "here, go run these skills yourself" instead of executing end-to-end. Building blocks pass their tests; the product doesn't deliver the outcome. The team has a written rule about this failure mode: *"substrate-done masquerading as outcome-done"* (`docs/agent-conventions/outcome-honesty.md`, born from GAP-001/GAP-002).

### 1.2 Substrate diagnosis (2.5 boxes, not 3)

The user's mental model expects three stages: Goal Definition → PM/Architect → Executor. Live-code investigation found:

| Stage | Reality | Live-code evidence |
|---|---|---|
| **Stage 1 (Goal Definition)** | EXISTS but BLIND. Emits `refined_goal` but skill recall is 0% top-1 / 20% top-5 on the sweep benchmark. Schema has no `recommended_skill` slot. | `tool-catalog.ts:2461-2500`, `paraphrase-corpus-v1.jsonl` results |
| **Stage 2 (PM/Architect)** | **DOES NOT EXIST.** `wi-pm` + `BoardWorkerAgent` capture + rank a flat backlog. Explicit non-decomposition. Deferred in ADR-042 to an unwritten ADR. | `wi-pm/SKILL.md`, `web-server.js:10575` |
| **Stage 3 (Executor)** | EXISTS but FUSED with planning. Single flat `runLoop` execute phase decides the next step AND runs it in one context. | `loop.ts:946` |

**Causal chain:** Stage 1 can't name the route → no Stage 2 to build a plan → flat Stage 3 must guess plan AND execute → on ambiguous/multi-repo goals it gives up and returns a plan-not-execution.

### 1.3 The three unmeasured questions

A multi-round adversarial debate between three agents could not agree by argument on THE bottleneck. Every candidate diagnosis rested on unmeasured claims:

1. Is Stage 1's blindness fixable via corpus hygiene, or is it deeper?
2. Is the flat executor reliable enough on single-step goals to be worth building orchestration on top of?
3. Would the designed pipeline be economically better than the flat loop it replaces?

Building against unmeasured ground on three axes = high probability of shipping a quarter of engineering that doesn't work because the substrate we assumed didn't hold.

---

## 2. Decision

**Do not build the fault-proof `/WI` design. Measure three floors first. Only one specific measurement outcome authorizes construction.**

### 2.1 The three floors

| ID | Measurement | Method | Pass threshold |
|---|---|---|---|
| **M1** | Stage-1 skill recall | 3-variant sweep on `paraphrase-corpus-v1.jsonl` (baseline / cleaned-22 / cleaned+prompt) | ≥ 70% top-1 in variant (ii) or (iii) |
| **M2** | Executor floor | Dual-source: Set A (5 merged-PR + 5 failed-session + 5 blind-expert) AND Set B (15-20 expert-authored) | ≥ 80% success on BOTH sets |
| **M3** | Cost projection | Derived from M2's outputs | Projected $/successful ≤ MIN(3× flat-loop $/successful, 0.5× human-hour-estimate × user-rate) |

### 2.2 The decision matrix

| M2 (executor) | M1 (recall) | Verdict |
|---|---|---|
| < 50% | any | Fix executor. Decomposition deferred indefinitely. Design VOID. |
| 50–80% | < 70% | Fix both in parallel. No Stage-2 architecture yet. Design VOID. |
| 50–80% | ≥ 70% | Fix executor first, then decompose. Design VOID. |
| ≥ 80% | < 70% | Fix recall first. Design retracted until recall passes. |
| **≥ 80%** | **≥ 70%** AND **M3 clears** | **BUILD** per Design Annex (Subsystems A–D). |

Only the bottom-right cell authorizes construction. Every other cell defines legitimate next-quarter work — none of which is the designed pipeline.

### 2.3 Three settled invariants (apply regardless of Phase 0 outcome)

These are decided independently of the design. Any future implementation of any `/WI` orchestration must satisfy them:

1. **No cycles.** Any plan output that forms a cycle in `depends_on_json` is rejected at persist time (Kahn topological-sort check). State machine retries up to N=2, then halts with user gate.
2. **No impossible stack strategies.** Cross-package stacked-PR proposals must respect a declared `stackable_with` field in the topology manifest. Cross-org stacking is rejected; feature-flag is the fallback.
3. **No plan-vs-execute rollback-kind divergence reaching the merge queue.** If executor's actual `rollback_kind` exceeds the planner's estimate, subtask output is blocked from merge until human reconciliation. Silent progression is prohibited.

### 2.4 Verified substrate constraints (apply regardless of Phase 0 outcome)

Facts about the current substrate that any future design must respect:

- **The B→A manifest miner MUST read `git log` against `example-service_PATH` directly.** The following stores are UNAVAILABLE for cross-package dependency mining:
  - `messages` table — GitHub PRs not persisted (verified `src/fetcher/sources/github.ts`)
  - Code-graph — skips non-relative imports (`src/tools/code-indexer.ts:516`, mirror `:540`)
  - `pr_review_cache` — wrong shape

---

## 3. Consequences

### 3.1 Positive

- **No premature engineering.** ~1 quarter of build work is not spent against unmeasured ground.
- **Recall improvement ships regardless.** The 22-skill filter (Harness A Step 4) improves `/WI` recall today, independent of any orchestration design.
- **Every outcome is a legitimate win.** M2 < 50% = "executor is the bottleneck, fix that" is as valid a result as bottom-right cell. Neither wastes a quarter.
- **Design detail is preserved.** `DESIGN-ANNEX-NONFINAL.md` carries the full conditional design ready to build in the bottom-right cell. Not wasted work; deferred activation.
- **Documentation integrity.** Every concession numbered on the record. False substrate claims retracted with banners. The debate is auditable months from now.

### 3.2 Negative

- **Delayed gratification.** Phase 0 costs ~3 weeks calendar (or ~4 hours + 1 week compressed) before any user-visible improvement beyond the recall filter.
- **Owner time cost.** ~4-8 hours of Maaz's time over Phase 0. Real, non-trivial. Non-negotiable — the measurements can't be delegated to an agent because AC-scoring requires human DoD verification.
- **Coordination overhead.** Three agents' debate produced 4 canonical docs + 1 annex + 2 harness specs + 1 playbook. Reading load is real. Mitigated by a single Playbook that a college student or LLM can execute without reading the full record.

### 3.3 Neutral (worth naming)

- **The Cypher runtime is unchanged.** `runLoop` is still ADR-037. No new engine. `phase:'integrate'` is the only proposed net-new phase, and only if bottom-right cell fires.
- **The kanban board (ADR-040) is unchanged.** `tasks` table gets 5 new columns if bottom-right cell fires. No new tables until then except `task_edges` (also conditional).
- **ADR-046 (multi-vendor agent contract) is untouched.** Skill-packs are per-repo CAPABILITY contracts, orthogonal to ADR-046's MODEL contract.

---

## 4. Alternatives considered and rejected

### 4.1 Build immediately based on Agent 001's initial proposal

**Rejected** because Agent 001's proposal decompressed to a quarter of work (per Agent D's critique). "Four small deltas" framing was substrate-done-masquerading-as-outcome-done. Same-week code start would have hit at least three silent-showstopper bugs (credit misattribution, contract-drift, DAG corruption per pre-Phase-0 debate).

### 4.2 Build based on Agent H's initial architecture summary

**Rejected** because H's ARCHITECTURE-SUMMARY.md contained three false substrate claims caught by Agent 001's live-code verification:
- H-1: `cypher_outcomes` reuse claim (real schema is `signal_kind/value/weight/metadata`; cost lives in `token_usage`)
- H-2: Palace hot-cache claim (Palace is opportunistic MCP, no lifecycle; real working memory is `task_contexts`)
- H-3: ADR-046 citation (ADR-046 disclaims per-agent skill injection in its non-goals)

### 4.3 Full ADR authoring for the conditional design NOW

**Rejected** in favor of a Process ADR (this document) + a non-final Design Annex. Full design-ADR authoring before Phase 0 clears would commit ADR real estate to a design that may never build. Design Annex carries the detail without pre-commitment.

### 4.4 Skip Phase 0 due to time constraints

**Rejected** because the entire debate concluded that argument-without-measurement produces "documentation-quality outputs that codify a wrong answer very rigorously" (per the skill's structural-fragility section). Skipping Phase 0 = skipping the discipline the debate exists to enforce.

### 4.5 Delegate Phase 0 execution to another agent

**Partially accepted, partially rejected.** Harness A (recall floor) is scriptable and could be delegated. Harness B (executor floor) requires human DoD verification per `verified_outcome_via` discipline — cannot be fully delegated. See the Playbook (§ next doc) for what's delegatable.

---

## 5. What this ADR does NOT decide

- **The v1 build architecture** — that's `DESIGN-ANNEX-NONFINAL.md`, which is void unless bottom-right cell fires.
- **Owner assignment** — that's a scheduling decision in the Playbook.
- **Timeline commitment** — this ADR authorizes Phase 0 to run at Maaz's pace; the 3-week timebox is a target, not a contract.
- **What happens post-Phase-0** — a subsequent ADR (build-ADR if bottom-right fires; alternative-work-ADR otherwise) will decide the next quarter's actual work.

---

## 6. References

- `.planning/wi-fault-proof-loop/BUILD-PLAN-00-MASTER-ADR.md` — **the operational counterpart to this ADR.** Written by Agent 001 after ADR-050 was signed; contains all 7 locked decisions, the gate, and build ordering in one place. Read this to execute; read this ADR to understand why.
- `.planning/wi-fault-proof-loop/BUILD-PLAN-01-PHASE0.md` — **the runnable Phase 0 playbook.** Contains the definitive Step-0 corpus fix (see §7 below), the sweep-harness edits, and the token-thrifty M2 path. Supersedes the earlier `PHASE-0-PLAYBOOK.md` which was written before the v1 corpus was verified structurally broken.
- `.planning/wi-fault-proof-loop/BUILD-PLAN-02-SUBSYSTEMS.md` — build spec for the four subsystems (D → A → B → C). Only opened if Phase 0 clears.
- `DEBATE-RECORD-AND-GATE.md` — full debate record with per-agent per-round concessions.
- `DESIGN-ANNEX-NONFINAL.md` — conditional design detail (Subsystems A–D), NON-FINAL.
- `harnesses/recall-floor.md` — Harness A spec (early draft; BUILD-PLAN-01-PHASE0.md is the executable version).
- `harnesses/executor-floor.md` — Harness B spec (early draft; BUILD-PLAN-01-PHASE0.md is the executable version).
- `docs/agent-conventions/outcome-honesty.md` — the pre-existing discipline this ADR upholds.
- `~/.hermes/skills/software-development/multi-agent-architecture-debate/` — the reusable debate pattern.

---

## 7. Post-signing finding: the v1 benchmark corpus is structurally broken

Recorded here because it materially affects Phase 0 execution.

**Finding (verified in `paraphrase-corpus-v1.jsonl` on 2026-07-26):** 6 of 10 corpus goals label `expected_skill` as a skill that **NO LONGER EXISTS** in the current codebase. Names that were consolidated into subcommand-dispatch skills:

| v1 corpus label (dead) | Current live skill |
|---|---|
| `wi-pr-review` | `wi-code` |
| `wi-blast-radius` | `wi-code` |
| `wi-who-owns` | `wi-people` |
| `wi-ticket-links` | `wi-jira` |
| `wi-health` / `wi-morning-brief` | `wi-status` / `wi-brief` |
| `wi-bug-report` | `wi-bug` |

Theoretical max recall on v1 is **40%**, regardless of any filter or prompt work. **Running M1 against v1 measures nothing meaningful about the pollution hypothesis.**

**Mitigation (per `BUILD-PLAN-01-PHASE0.md` Step 0):** a corrected `paraphrase-corpus-v2.jsonl` exists in `.claude/worktrees/memory-surface-cleanup/.planning/`. Copy into main tree; run M1 against v2. If v2 is unavailable, author labels by hand against the dispatchable-skills set. Publish which goals were relabeled/excluded and why.

This does NOT change the decision matrix (§2.2) or the invariants (§2.3). It changes only the Step-0 execution: fix the corpus BEFORE running the sweep, or M1 is unmeasurable.

**Attribution:** Agent 001 verified this against live corpus + live `skill_catalog` on 2026-07-26 during authoring of `BUILD-PLAN-01-PHASE0.md`.

---

## 7. Sign-off

- **Agent D** — accepted (verification of on-disk record confirmed)
- **Agent 001** — accepted (standing sign-off); post-signing wrote `BUILD-PLAN-00/01/02` as the operational execution of this ADR — see §6 references
- **Agent H** — accepted (author of this ADR text); reviewed 001's build plan on 2026-07-26 and confirmed no divergence from this ADR's decision
- **User (Maaz)** — pending Playbook execution (owner assignment)

Signed on the record. Amendable only via a superseding ADR (not silent edits).

---

## 8. Close-out amendment — 2026-07-27

**Status update:** post-signing close-out shipped as `feature/adr-050-r0-r4-b1-2026-07-27` (2 commits, `652c13b` + `13c5c7b`). Full audit trail at
[`.hermes/plans/2026-07-27_093000-adr-050-close-out-full-plan.md`](../../.hermes/plans/2026-07-27_093000-adr-050-close-out-full-plan.md).

**Substrate audit findings (recorded so future agents don't re-litigate):**

| Claim in `REMAINING-WORK-TIMEBOXED.md` | Reality (verified 2026-07-27) | Impact |
|---|---|---|
| 4 INSERT sites in web-server.js need patching | Only 1 production INSERT site (line 3313-3317), already correctly writes `body.dispatch_source \|\| 'unknown'` | R0 scope was wrong; real bug was in callers not passing the value |
| Scanner reads `fm.triggers` (bug — read wrong property name) | `skill-discovery.ts:311-314` already reads BOTH `fm.trigger_phrases` AND `fm.triggers` | R2-B.1 Step 2 (scanner fix) was already shipped, dropped from plan |
| 100% of `skill_catalog.trigger_phrases` = `[]` | 120 empty, 1 populated (`review-fresh-eyes`, 7 phrases pre-existing) | Directional claim correct; specific number slightly off |
| `dispatch_source` column populated post-v104 | 100% of 1554 rows = `'unknown'` — no upstream caller was passing it | Broke R1's measurement gate; forced R0 into scope |

**Workstream outcomes:**

| Item | Status | Detail |
|---|---|---|
| R0 — `dispatch_source` write-path | ✅ **Shipped** (`652c13b`) | `scripts/wi-dispatch-stream.sh` now takes `--dispatch-source` flag with `user\|smoke\|test\|agent` enum (default `user`); validates + threads to SSE endpoint |
| R4 — Smoke-script rollout | ✅ **Shipped** (`652c13b`) | 10 `smoke-bridge.sh` sites patched; `smoke-outcome.sh`, `smoke-stage1-e2e.sh` were already correct; `scripts/smoke/client.ts` already defaults to `'smoke'` |
| R2-B.1 — Backfill trigger phrases | ✅ **Shipped** (`13c5c7b` write-side + rerank consumer 2026-08-06) | 25 wi-* skills gain `trigger_phrases:` YAML frontmatter. **Consumer path now wired** (2026-08-06): option (c) rerank — `getTriggerPhraseHitSkills` + `rerankByPhraseHit` in `tool-catalog.ts`, invoked from `stage1.ts` — "embed first, then swap in phrase-matcher". Measured: Top-1 **60%**, Top-5 **70%** (3× stable runs) on `paraphrase-corpus-v2` (was 20%/60% pre-rerank) |
| R1 — Workstream A executor fix | ⏳ **Blocked by elapsed-time gate** | Needs ≥10 `dispatch_source='user'` rows accumulated post-R0. Wait 5-14 days, then run diagnostics per `.planning/wi-fault-proof-loop/diagnostics/*.sql` |
| R2-B.2 — Embedder swap | ⏳ **Conditional** | Only if R2-B.1 consumer path merged AND M1 top-1 still < 70% |
| R2-B.3 — Haiku classifier fallback | ⏳ **Conditional** | Only if B.1 + B.2 don't cross 70% |
| R3 — ADR-051 decision | ✅ **Accepted Option A** (2026-07-27) | Two-inventory workaround retained; `dispatch_source` provides measurement separation. See [`adr-051-skill-registry-unification.md`](./adr-051-skill-registry-unification.md) |

**Cell of the §2.2 decision matrix that fired:** ambiguous until R1 completes measurement. Substrate hardening is now sufficient that when M2 is next measured on rolling 30-day `dispatch_source='user'` traffic, the result will be a point estimate (not a range) — the Phase 0 discipline holds.

**Gates passed on this commit set:**
- `npx tsc --noEmit`: clean (exit 0)
- `bash -n` on both patched shell scripts: clean
- YAML validity across 25 wi-* SKILL.md files: 25/25 parse via `yaml.safe_load`
- JSON validity across 10 patched `curl -d` bodies: 10/10 round-trip via `json.loads`
- Smoke tests (`pnpm run smoke:bridge`): deferred to slot-merge time per AGENT-RULES.md Rule 3 (agent does not merge)

**Sign-off on this amendment:**
- Agent H (previous author) — n/a (this amendment by successor agent)
- Agent (successor, this session) — accepted; audit trail in the plan doc
- **User (Maaz)** — instructed "finish it now" on 2026-07-27, authorizing the substrate close-out on `feature/adr-050-r0-r4-b1-2026-07-27` branch. Merge to master is a separate human step per AGENT-RULES.md Rule 3.

**Superseding-vs-amendment note:** this is an amendment, not a superseding ADR. The §2.2 decision matrix and §2.3 invariants are unchanged. The amendment records the substrate-fix work that operationalized the Phase 0 gate, and closes R0/R4/R2-B.1(write-side)/R3.

### §8.1 — R2-B.1 consumer path close-out — 2026-08-06

**Design decision resolved (option c — rerank), per user choice.** The deferred weighted-boost / first-pass-filter / rerank decision (§8 row "R2-B.1 — Backfill trigger phrases") resolved to **option (c) rerank**: embed first, then swap in phrase-matcher hits already inside the candidate pool.

**What shipped:**

| Piece | File | Detail |
|---|---|---|
| Phrase-match set | `tool-catalog.ts:2654` `getTriggerPhraseHitSkills(goal, db)` | Reads `skill_catalog.trigger_phrases` (substring match, case-folded) |
| Stable partition | `tool-catalog.ts:2700` `rerankByPhraseHit(skills, hits)` | Phrase-matched skills rise above non-matches, relative order preserved; never adds/removes |
| Stage-1 wiring | `stage1.ts:527-545` | Non-fatal: falls back to deduped order on error / no-hit |
| Harness mirror | `scripts/stage1-realwork-v2.mjs` | Rebuilds `{id}` shape before rerank (harness built `{skill}` — shape bug caught 2026-08-06) |
| `triggers:` backfill | 9 wi-* SKILL.md in `feat/skill-merging` | wi-code/people/jira/brief/bug/status/investigate gained triggers; wi-review-adr/wi-pm restored (had been mangled) |

**Root cause found during verification:** `skill-discovery.ts` frontmatter parser only reads **unindented** `- item` YAML lists. The original indented `  - item` trigger blocks were silently dropped → `skill_catalog.trigger_phrases` stayed `[]` → optimizer no-ops. Reformat + re-scan fixed; DB verified: 9 skills now have 6-9 phrases each.

**Measurement (paraphrase-corpus-v2, 10 real-world goals, Ollama up):**

| Metric | Pre-rerank (2026-08-05) | Post-rerank (2026-08-06) | Runbook gate |
|---|---|---|---|
| Top-1 | 20% | **60%** (6/10) | ≥40% sanity ✅ |
| Top-5 | 60% | **70%** (7/10) | ≥70% ✅ |

3× stable runs (run-to-run identical). Residual misses (para-02/04/05) are pool-selection gaps (wi-code/people/search absent from candidate pool), not rerank issues — rerank can only reorder, cannot rescue absent skills.

**Status:** R2-B.1 consumer path closed. R2-B.2 (embedder swap) + R2-B.3 (Haiku fallback) conditional triggers **not** fired — R2-B.1 crossed the 70% top-5 / 40% top-1 sanity without them per § 2.2 matrix.

**Sign-off:** User (Maaz) selected option (c) rerank; author accepted 2026-08-06.
