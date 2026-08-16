---
sidebar_label: "ADR-032: Persona Memory Loop"
sidebar_position: 32
---

# ADR-032: Persona Memory Loop — Inbound Reviewer Learning, Brain-Flowed

**Status**: **SUPERSEDED IN PART by [ADR-033](./adr-033-cypher-framework.md) + [ADR-034](./adr-034-cypher-learning-autonomy-engine.md) — 2026-06-16**. The 4-stage `INGEST → CLUSTER → GATE(propose-then-approve) → INJECT` loop this ADR proposed is now the same architectural pattern Cypher's learning substrate ships generically (`cypher_outcomes` ledger → `skill_priors` → `skill_proposals` lifecycle → controlled promotion via human gate). The narrow case "PR reviewer comments → coding rules" folds into Cypher's evolution order as a future signal kind once L1.2 (edit-distance) + L1.3 (CI webhook) trigger. The 33 pending phase-80 work_items are deferred with `blocker_reason='superseded by Cypher learning substrate'`. The 5 already-shipped ACs stay shipped (their infrastructure — Tier-0 boot, persona_observations table — is reused by Cypher). See [Supersession Notice](#supersession-notice-2026-06-16) below.
**Date**: 2026-06-02
**Deciders**: Maaz
**Scope**: Work Intelligence MCP (this repo only). Inside WI; not Claude Code globally, not per-repo.
**Pipeline stages**: Fetch (Ingest sources), Process (Cluster/Extract + raw mirror), Analyze (Promote-via-LLM + extract), Propose (Inject via Brain recall)
**Related**: [ADR-014](./adr-014-self-learning-investigation-brain.md), [ADR-015](./adr-015-mempalace-integration.md), [ADR-016](./adr-016-second-brain-architecture.md), [ADR-024](./adr-024-unified-brain.md), [ADR-030](./adr-030-self-healing-bug-loop.md), [ADR-031](./adr-031-per-bucket-model-effort-config.md), [ADR-033](./adr-033-cypher-framework.md), [ADR-034](./adr-034-cypher-learning-autonomy-engine.md)

---

## Supersession Notice (2026-06-16)

**This ADR was sound design before Cypher's substrate existed; it is now redundant.**

ADR-032 was authored 2026-06-02. ADR-033 (Cypher Framework) was accepted 2026-06-12 and ADR-034 (Cypher Learning & Autonomy Engine) on 2026-06-14. Together they ship the same architectural pattern this ADR proposed — **outcome ledger → priors → human-gated proposals → controlled promotion** — but as a generic substrate rather than a single-purpose pipeline for "PR reviewer comments → coding rules."

### What ADR-033/034 already cover

| ADR-032 stage | Cypher equivalent | Status |
|---|---|---|
| INGEST inbound reviewer comments | `cypher_outcomes` signal_kind enum (`verdict / thumbs / rerun / edit_distance / ci`) | ✅ shipped 2026-06-16 (L1.1: verdict + thumbs + rerun); L1.2 edit_distance + L1.3 CI webhook pulled by their own triggers |
| CLUSTER recurring patterns | CAP-13-LITE per-dispatch trigger + CAP-13-FULL nightly clusterer (L4 in ADR-034) | ✅ CAP-13-LITE shipped 2026-06-14; CAP-13-FULL stub shipped same day; L4 nightly extension awaits trigger |
| GATE propose-then-approve | `skill_proposals` lifecycle (`drafted → verifying → verified → promoted ｜ rejected`) | ✅ shipped 2026-06-14 (CAP-13-FULL) — same shape, hard human gate |
| INJECT learned rules | `skill_priors` Beta posterior + future `(model, bucket, task_class)` routing (L3) | ✅ skill_priors shipped (ADR-033); L3 awaits trigger |

### What's lost by deferring ADR-032

Almost nothing. The unique pieces Persona Memory was building on top of the generic substrate:

- **PR-comment ingestion shape** (multi-paragraph reviewer text, diff context). Cypher's `cypher_outcomes.metadata` JSON column carries arbitrary context; the reviewer-comment shape can be encoded there when L1.2 ships.
- **Code-diff context attachment**. Same — `metadata.diff_ref` or similar when L1.2 wires PR signals.
- **`/setup/persona` UI affordance** (the propose-then-approve operator surface). The `/cypher` visibility panel already renders `skill_proposals`; extending it to surface ledger-derived rule proposals is a small additive slice.

None of these block on the persona-loop tables (`pr_review_comments`, `lessons_learned`, `rule_cards`, `code_diff_outcomes`). They reduce to columns/payloads on `cypher_outcomes` and `skill_proposals`.

### Decision

- **Status**: Proposed → **Superseded in part by ADR-033/ADR-034**.
- **Phase 80 work_items (33 pending ACs)**: marked `deferred` with `blocker_reason='superseded by Cypher learning substrate'`. The 5 already-shipped ACs (PERSONA-A-01, A-03, A-05, A-06, plus C-02/C-03 on synthetic) stay shipped — their work created reusable infrastructure (Tier-0 boot, `user_profile_observations` table) that Cypher already consumes.
- **Reviewer-comment signal**: not lost. When ADR-034 L1.2 (edit-distance) and L1.3 (CI webhook) trigger, reviewer feedback becomes a `cypher_outcomes` row alongside the verdict/thumbs/rerun/CI signals already aggregated. The 4-stage loop runs once across all signal kinds, not once per source.
- **No new code shipped to honor this supersession.** This is a status + work_item bookkeeping change. Phase 80 was already paused (2026-06-14) waiting on Cypher PM stabilization; the supersession formalizes that pause as terminal.

### Resume condition (if ADR-032 ever revives)

If real PR-reviewer signal capture turns out to need shape Cypher's `cypher_outcomes` cannot accommodate (e.g. multi-paragraph free text the brain wants to recall verbatim), reopen this ADR as ADR-032 v2 and propose a *narrowly-scoped* extension that writes to the existing `cypher_outcomes` ledger — never as a parallel pipeline.

---

## Implementation Status (last updated 2026-06-14)

### Pause Notice (2026-06-14)

ADR-032 has been **paused — not deferred, not dropped** — at wave 77a-01 since 2026-06-02. 5 of 38 ACs are shipped (PERSONA-A-01, A-03, A-05, A-06, plus C-02/C-03 on synthetic). The remaining 33 ACs across 77a-02..07, 77b, 77c, 77d, and cross-cutting waves are all pending.

**Why paused.** Between 2026-06-09 and 2026-06-14, work pivoted to ADR-033 Cypher framework. The trigger was a structural realization during ADR-033's PM-lens design (commit `3c771f1`, PM-1): without a project-manager surface that tracks Cypher's own work, the recursion claim (*"Cypher tracks Cypher"*) would rot at day 30. ADR-032 extends the same recall + memory infrastructure to **inbound reviewer feedback**, so it inherits the same rot risk. Shipping the ADR-032 GATE/INJECT loop on top of an unverified Cypher PM lens would compound a known fragility.

**Decision.** Stabilize Cypher PM first — ship PM-4 (auto-link, commit `197c5c1`, 2026-06-14), then drift detector + smoke-failures-into-queue + flaky-section fixes — before resuming ADR-032 wave 77a-02 (ESLint Tier-0 parser).

**Resume condition.** All four of the following land:
1. PM-4 (auto-link Cypher sessions/commits to work_items) — ✅ shipped 2026-06-14 (`197c5c1`)
2. Drift detector (stale `in_progress`, missing commit_sha, dead file_path evidence) — pending
3. Smoke-failures-into-queue (§ 10e + § 11 + race-flap as priority-5 work_items) — pending
4. § 10e (vitest reporter env) and § 11 (bug 1 fixture drift) actually fixed — pending

When all four ship and Cypher PM has shown 1 week of clean drift output, ADR-032 resumes at PERSONA-AC-2 (Tier-0 ESLint parser). The PRD scope, schema v58, and the existing 77a-01 spine remain canonical — no re-design, no re-numbering, just resumption.

**What this is NOT.** Not a deferral (no decision to ship without these ACs), not a drop (no decision to abandon the loop), not a scope cut (the 33 pending ACs remain in scope). The ADR-033 work that pre-empted it is a **prerequisite hardening pass**, not a replacement.

### Source of truth caveat

The remainder of this section is the granular per-AC ledger. The "Status: Proposed" header above stays Proposed until the **whole loop** (INGEST → CLUSTER → GATE → INJECT) is exercised end-to-end on real signal — not just the spine. Status here is granular and honest.

### What ships today (Phase 80 wave 77a-01, commits `0a3c6b0` + `b7a7a0f`)

| Component | Status | Evidence |
|---|---|---|
| Schema v58 — 5 net-new persona tables (`pr_review_comments`, `lessons_learned`, `rule_cards`, `code_diff_outcomes`, `persona_rule_snapshots`) | ✅ **Shipped** | `src/db/migrations/v58_persona_memory_loop.ts`; live DB at v58. PERSONA-A-01. |
| Tier-0 tsconfig parser → 7 strict-family rules (≤200 tok bodies, Hard rule 4) | ✅ **Shipped** | `src/services/persona/parse-tsconfig.ts`. PERSONA-A-03 / A-06. |
| Source-removal retirement path (`status='retired'` + `retired_reason='source_removed'`) | ✅ **Shipped** | Live-tested via synthetic dropout. PERSONA-A-05. |
| `persona-extract` model_config bucket (ADR-031 conformance) | ✅ **Shipped** | `src/services/model-config.ts`; ALL_BUCKETS=9. |
| Per-phase kill switches (`PERSONA_MEMORY_TIER0_ENABLED`, `PERSONA_MEMORY_INGEST_ENABLED`) default OFF | ✅ **Shipped** | `web-server.js` boot block. |
| Boot-once Tier-0 parser run when kill switch flipped | ✅ **Shipped** | `[Persona] Tier-0 boot run: emitted=7 retired=0 errors=0`. |
| Palace dual-write to `reviews` wing | ✅ **Shipped** | mempalace stderr confirms 7 drawers filed at `reviews/tier0`. |
| `recall_memory` wings server-side pushdown | ✅ **Shipped** | `src/services/brain/recall.ts`. |
| `getActivePersonaRules` helper (Hard rule 7 home) | ✅ **Shipped** | `src/services/persona/recall.ts`. |
| `wi-pr-review` (`/api/pr/review`) consults persona rules + cites by `rule_id` | ✅ **Shipped** | `src/routes/pr.ts` + `src/services/analyzer.ts` (`PRReviewInput.personaRules`, `PRReview.citedRuleIds`). Live cite-in-the-wild proof point: synthetic diff with unused parameter → model cited `[tsconfig:noUnusedParameters]` and `[tsconfig:noImplicitAny]` verbatim. |
| Smoke § 19a-thin (4 sub-checks for the vertical slice) | ✅ **Shipped** | `scripts/smoke-bridge.sh` § 19a-thin. |

### What is NOT shipped (the 33 of 38 ACs still pending)

| Component | Status | Wave | Why pending |
|---|---|---|---|
| Tier-0 ESLint parser (PERSONA-A-02) | ❌ Not started | 77a-02 | Repo uses oxlint without `eslint.config.js`; needs decision on whether to parse oxlint or document "no Tier-0 ESLint emits 0 rules". |
| Tier-0 type-helpers `@enforces` parser (PERSONA-A-04) | ❌ Not started | 77a-02 | No `@enforces` JSDoc tags exist in the repo today; PRD allows zero emissions as a pass. |
| Canonical-prose extractor on `CLAUDE.md` + `.claude/rules/*.md` (PERSONA-A-09 / A-10) | ❌ Not started | 77a-03 | Bumps the rule set from 7 to ~15-20 prose-derived candidates. |
| `pr_review_comments` backfill from gh CLI (PERSONA-A-07 / A-08) | ❌ Not started | 77a-04 | Highest external-dep risk (gh tokens + GraphQL vs REST decision). |
| `palace:rebuild` replay path (PERSONA-A-11 / A-12) | ❌ Not started | 77a-05 | Snapshot table exists but the replay hook isn't wired. |
| Hard rule 7 grep guard in smoke (PERSONA-A-13) | ❌ Not started | 77a-06 | Scanner not yet added to smoke-bridge.sh. |
| MINJA red-team smoke § 21 (PERSONA-X-02) | ❌ Not started | 77a-07 | **Hard gate before any flag flips 1 in production** per ADR's Hard Rule. |
| All of CLUSTER stage — `PersonaExtractAgent` weekly cron + Haiku clustering → `lesson_candidates` (PERSONA-B-01..06) | ❌ Not started | 77b | Whole stage pending. No `lesson_candidate` rows exist yet. |
| GATE stage — `/setup/persona` UI (Pending / Active / History tabs), `POST /api/brain/learn { verb: 'promote_lesson' }`, conflict resolution at cosine > 0.92 | ❌ Not started | 77b | Tier-0 rules go straight to active (no candidate stage); the human propose-then-approve gate doesn't exist yet. |
| INJECT stage — `/api/chat` code-shaped routing swap, `applied_count++` citation parser, cosine fallback for paraphrase (PERSONA-C-01..07) | 🟡 **Partial** | 77c | wi-pr-review citation works on synthetic data; chat path unchanged; `applied_count` not incremented. |
| Consolidator — Tier-0 supersession (BLOCKER-4), 7-day-delay outcome verifier, retirement decay, `wi-morning-brief` audit slot (PERSONA-D-01..06) | ❌ Not started | 77d | Whole stage pending. |
| Cross-cutting must-pass before launch — real-PR replay (X-01), latency p95 (X-03), cost ceiling (X-04), kill switch combined (X-05), rollback runbook dry-run (X-06) | ❌ Not started | 77c / 77d gates | Required by PRD § 10 clause 2 before flipping ADR status. |
| Phase 80 retro at `SUMMARY.md` with verdict on `dec_5CBB6AF22D7F4788A384F9832F` | ❌ Not started | end of milestone | Honest current-data verdict: **mixed** — spine works, loop doesn't. |

### Why the ADR header still says "Proposed"

PRD § 10 sets the bar: all 38 ACs pass + BASELINE-anchored metrics hit v1 targets + retro written. We're at **5 of 38 ACs** (PERSONA-A-01, A-03, A-05, A-06, plus C-02/C-03 informally on synthetic). The CLUSTER and GATE stages — the parts that turn ADR-032 from "scaffolding" into a propose-then-approve loop — don't exist yet. Flipping to "Accepted" now would document a state that isn't true.

The honest reading of `dec_5CBB6AF22D7F4788A384F9832F` (the brain's prior self-decision to ship 77a-01 first) at this checkpoint: **vindicated for the spine, undecided for the loop**. The cite-in-the-wild proof point on a synthetic diff means the integration shape works. Whether the loop produces useful rules at scale needs real PR data, which arrives in 77a-04.

---

## The one-paragraph version (for non-technical readers)

When Maaz opens a pull request and a human reviewer leaves a comment — "you missed a null check here", "we don't use lodash" — Claude Code currently has no memory of that feedback. The next PR makes the same mistake. **This ADR proposes WI builds a personal "rule book" from two complementary sources: Tier 0 (already-decided team conventions — ESLint, TypeScript flags, type helpers) parses straight to a rule book; Tier 1 (recurring patterns from PR comments, accept/reject diffs, code-review verdicts, regressions) goes through a propose-then-approve gate at `/setup/persona`.** Both tiers ride the *existing* Brain (ADR-024) — they live as drawer entries in a new "reviews" wing of the MemPalace. Existing brain-calling consumers (BugInvestigator, BugResolver, wi-investigate) gain persona memory with zero code change; the two non-brain-calling skills (`wi-pr-review`, web-UI ChatPanel) need a one-time ~10-line routing swap to `brain.getDecision`. Rules are never silently learned from external prose; only mechanically-enforced configs (lint, tsconfig, type definitions) bypass the gate. Tier 0 gives day-zero coverage; Tier 1 augments it with what the team hasn't written down yet.

---

## Context

WI today has a deep memory stack:

- **MemPalace** (ADR-015/016) — semantic vector + KG. Six wings: `topics`, `conversations`, `meetings`, `entities`, entity-relationships, and (since Phase 71-01) `decisions`.
- **MemoryEnricher** (`src/intelligence/memory-enricher.ts`, 516 lines) — universal-writer pattern. Fire-and-forget writes, content-hash deduplication, KG triple emission. Already used by sync, brain `record_outcome`, investigation orchestrator.
- **Unified Brain** (ADR-024) — five pillars wired:
  - `get_context` — 7-field operational state, TTL-cached `< 100 ms`
  - `get_decision` — structured decision, cached by `(question, user, UTC day)`
  - `verify_claim` — adapter pattern (`github:`, `jira:`, `grep:`)
  - `recall_memory` — fans out across palace + `brain_decisions` + `brain_action_clusters` with recency × confidence ranking
  - `record_outcome` — closes the learning loop, triggers MemoryEnricher
- **claude-mem** (per-session observations) — ~22k-token session timeline, search via `mcp-search.search()`.
- **Investigation flow** — ADR-014 + ADR-018 self-learning loop; surfaces past similar bugs during root-cause analysis.
- **Bug Loop** (ADR-030 A/B/C) — `bug_capture → bug_investigations → bug_resolutions`. Each step calls `/api/brain/decide`, closing the same loop the review feedback should close.

What's missing is **a content layer for code-review-shaped events** — inbound human PR review comments, accepted-vs-rejected diffs, `/code-review` skill outputs vs reality, and Jira regression linkage. None of these signals are persisted today. WI has the ingestion plumbing (GitHub MCP exposes `pull_request_read.get_review_comments`), the storage layer (palace), the recall layer (brain), and the decision-making infrastructure — but the bridge from "reviewer left a comment" to "WI internalizes it as a rule" doesn't exist.

The user's pain in plain English: *"Claude Code does the same thing again and again on each PR. It doesn't detect the mistake other human reviewers point me to. It is like having no memory."*

A naive fix would be a parallel "rule store" — a new SQL table, a new RAG pipeline, a new injection step in the analyzer. That's the design we sketched first (`research-output/wi-persona-memory-design.md`). It works, but it duplicates infrastructure that already exists and creates a bypass path around the Brain. This ADR records the *revised* design that flows the new signals through the existing Brain instead.

---

## Decision

**Add a 7th palace wing — `reviews` — and route signals from two tiers into it.** **Tier 0** (canonical, mechanically-enforced, build-failing-when-violated): ESLint config, TypeScript config, and `@enforces`-tagged type helpers in repos Maaz controls are *parsed*, not inferred — they emit `kind='rule'` palace drawers directly, no gate. **Tier 1** (inferred + soft-canonical): inbound human PR review comments, accept/reject diff outcomes, `/code-review` skill verdicts, Jira regression outcomes, AND human-written prose (ADRs, `## Hard rules` markdown sections, `CLAUDE.md`) go through `lessons_learned` → propose-then-approve gate at `/setup/persona` before becoming `kind='rule'` in palace. Prose-sourced lessons get a "1-click bulk promote" affordance so day-one coverage is fast without bypassing user review. Add four SQL tables (raw GitHub mirror + lessons staging + diff verdicts + persona rule snapshots for palace-rebuild durability). Tier-1 lesson candidates are **dual-written**: the SQL row in `lessons_learned` carries the mutable lifecycle (status, hit_count, promoted_to_rule_id); a palace drawer in the `reviews` wing with `kind='lesson_candidate'` carries the searchable body. The brain only ever reads from palace; SQL is for write-side lifecycle and lifecycle-shaped queries (`status='active' AND hit_count >= 3`). Extend `recall_memory` with optional `wings` / `kind_filter` / `activation_filter` params (backward-compatible defaults). Extend `palace.search()` with an optional `kind` param. Extend `verify_claim` with a `pr_review` adapter. **Do not introduce a new `rule_cards` SQL table.** Rules live as palace drawer entries in the `reviews` wing — citable by id from the brain's decision output. Three of five consumers (BugInvestigator, BugResolver, wi-investigate) gain persona memory with zero code change because they already call the brain; two (`wi-pr-review`, web-UI ChatPanel + `/api/chat`) need a one-time ~10–15 line server-side routing swap in Phase 77c.

The persona is not a database table. The persona is what the Brain returns when called.

### Why brain-flowed (not parallel)

| Concern | Parallel layer (rejected) | Brain-flowed (chosen) |
|---|---|---|
| Where do rules live? | New `rule_cards` SQL table | Palace `reviews` wing as drawer entries with `kind: 'rule'` |
| How does PR review get them? | Direct query to `rule_cards` from analyzer | `brain.get_decision(question)` returns rule citations as evidence |
| How does bug investigator get them? | New code path | Already calls Brain; nothing changes |
| How does code chat get them? | New code path | Already calls Brain; nothing changes |
| Auditing | New audit table | `brain_user_budget_ledger` already covers all brain calls |
| Prompt caching | New cached block in analyzer | Brain's existing system block extended; one cache key |
| Risk of bypass | Any future skill could read `rule_cards` directly and skip the gate | Rules only reachable via `recall_memory`; no bypass possible |
| New code surface | 4 tables, new RAG pipeline, new analyzer step, 8th model bucket | 3 tables, 1 new wing, 1 new adapter, 0 new buckets |

The investigation flow (ADR-014/018) and the bug loop (ADR-030) both already use this exact pattern: signals come in, get extracted, get gated, end up as structured palace content, are recalled by the Brain when relevant. Persona memory becomes the third instance of the same pattern, not a fourth memory system.

### Signal sources, in priority order

Two tiers, by epistemic strength.

**Tier 0 — canonical, mechanically-enforced sources.** Already authoritative AND build-failing. Skip clustering, skip the propose-then-approve gate, skip the lesson_candidate stage. Parse → write directly to the `reviews` wing as `kind='rule'` with `source_kind` recorded. Re-parse on file change (incremental). Restricted to *machine-checked configs in repos Maaz controls* — see hard-scope below. The user is not asked to approve a rule that lint already enforces — that would be theatre.

**Tier 1 — inferred / soft-canonical sources.** Either statistically discovered from review traffic, or human-written prose that is canonical-in-spirit but not machine-enforced. Both go through the cluster (or pre-fill) → lessons_learned → propose-then-approve → palace pipeline.

**Hard scope rule.** Tier 0 auto-promotion is restricted to artifacts that **fail the build** when violated AND that live in repos listed in `PERSONA_TIER0_TRUSTED_REPOS`. The default and v1 value of that env is the WI repo only. The connected customer repos `./repos/example-service/` and `./repos/operations/` are **explicitly out-of-scope for Tier 0 in v1** — they are rsynced without `node_modules`, ESLint degraded-mode resolution would emit a strict subset of the rules CI actually enforces, and a strict-subset rule book is *worse than no rule book* because it teaches the model that the unenforced rules are the universe. Customer-repo learning rides Tier 1 (PR comments + diff outcomes + Jira regressions, all gated). Free-text prose (markdown, ADR sections, docstrings) is **never** Tier 0 regardless of which repo it's in — these route to Tier 1 with a `pre_filled_from='canonical_prose'` tag and a "promote with one click" UI affordance, so the user still sees them on day one but a malicious doc landing in any repo cannot inject a rule. This closes the MINJA vector that an earlier draft of this ADR opened, and the strict-subset vector that the degraded-mode draft opened.

#### Tier 0 — canonical sources (parsed, not inferred, no gate)

| # | Source | Signal strength | What we parse | Update cadence | Repo scope |
|---|---|---|---|---|---|
| T0.1 | **ESLint config** (`.eslintrc*`, `eslint.config.*`) | Build-failing | Each enabled rule + its severity becomes a `kind='rule'` drawer, scoped to the lint config's `files`/`overrides` globs | On config change | WI repo only (see "Degraded resolution" below) |
| T0.2 | **TypeScript config** (`tsconfig*.json`) — `strict`, `noUnusedLocals`, `noImplicitAny`, `exactOptionalPropertyTypes`, etc. | Build-failing (compile error) | Each enabled flag becomes a rule ("never use `any` because `noImplicitAny: true`") scoped by `include`/`exclude` | On config change | All trusted repos |
| T0.3 | **Type definitions in shared packages** (project-internal `Result<T,E>` style helpers, `*.types.ts`) — *only when the type itself enforces* (e.g. branded types, exhaustive enums) | Build-failing when violated | Type names + their JSDoc become rules; ONLY emits a rule when the type definition includes `@enforces` JSDoc tag (explicit opt-in) | On `.d.ts` / `*.types.ts` change | Trusted repos only |

**Degraded resolution for `./repos/example-service/` and `./repos/operations/`:** per CLAUDE.md, those repos are rsynced *without* `node_modules`. ESLint config resolution requires `node_modules` for `extends`/`plugins` chains. Phase 77a's parse-eslint will skip those repos and emit a `degraded_resolution=true` flag in its log. Restoring full Tier 0 ESLint coverage on the connected repos is **deferred to a future phase** (would need either: install lint-only deps, or use a pre-resolved config snapshot).

#### Tier 1 — inferred + soft-canonical sources (gated)

| # | Source | Signal strength | Path | Why |
|---|---|---|---|---|
| T1.0 | **Pre-fill from canonical prose** — repo ADRs (`docs/adr/*.md`, `docs/docs/adr/*.md`), `CLAUDE.md`, `docs/**/*.md` `## Hard rules` / `## Conventions` / `## Don't` / `## Always` sections | Strong but human-written | Pre-fills `lessons_learned` with `source_kind='canonical_prose'`, surfaced in the `/setup/persona` Pending tab with a "1-click bulk promote" affordance | Even authoritative-feeling text is fuzzy enough that one click of human review is cheap insurance against MINJA |
| T1.1 | **Human PR review comments** on PRs Maaz authors | Highest of statistically-mined Tier 1 | Cluster → `lessons_learned` → gate | Direct ground truth (Tufano et al., ICSE 2021) |
| T1.2 | **Accepted vs rejected diffs** when WI suggests a change | High | `code_diff_outcomes` → cluster → `lessons_learned` → gate | Differentiated WI feature |
| T1.3 | **`/code-review` skill findings vs reality** | Medium | 7-day-delay verifier → `lessons_learned` (negative rules) → gate | Patterns of `refuted` findings become suppression rules |
| T1.4 | **Jira regression outcomes** | Slow but high-leverage | BugInvestigator output → `lessons_learned` → gate (with `severity='high'`) | (suggestion, regression) pair signals real harm |

#### Why tiering matters

1. **Day-zero coverage.** A fresh WI install parses its own ESLint + TypeScript configs (Tier 0) and pre-fills the `/setup/persona` Pending tab with the entire prose-doc + ADR rule set as Tier 1 candidates. The user can bulk-promote the prose set in one click on day one. No cold-start problem, no MINJA vector.
2. **No re-asking the user about lint rules.** ESLint already enforces `no-floating-promises`. Surfacing that as a "candidate rule" would be wasted clicks. Tier 0 skips the gate for build-failing rules.
3. **Conflict resolution priority.** When a Tier 1 inferred rule contradicts a Tier 0 canonical rule, the Tier 0 rule wins automatically. Inferred rules can *augment* canonical ones (add nuance, scope, fix idioms) but can't override them.
4. **Update propagation is easy.** When `eslint.config.js` flips a rule from `warn` to `error`, the parser re-runs and the corresponding palace drawer gets `severity` updated. When an ADR's `## Hard rules` section gets a new bullet, the next parse pass adds a new candidate to the Pending tab — the user clicks Promote.
5. **Trust differential reflected in citations.** When the brain returns evidence, Tier 0 rules carry source markers like `lint:no-floating-promises` that the model is told to treat as authoritative; Tier 1 rules carry markers like `inferred:cluster-12` or `canonical_prose:adr-024#hard-rules-3` (after promotion) and the model is told to weigh them but treat as advisory.

#### What Tier 0 parsing actually looks like

For each canonical source we add a small parser under `src/services/persona/parsers/`. Each parser is responsible for one source type and emits `kind='rule'` palace drawers idempotently (content-hash dedup, same as MemoryEnricher elsewhere).

```
src/services/persona/parsers/
  parse-eslint.ts       → loads the ESLint config the project actually uses (resolves
                          extends, plugins, overrides), emits one rule per enabled
                          rule, severity from config. Falls back to surface-level
                          rules-only mode for repos without node_modules.
  parse-tsconfig.ts     → walks tsconfig + all tsconfig.*.json files, emits rules
                          for the strict-family flags that are on
  parse-type-helpers.ts → walks `*.types.ts` and `.d.ts`, emits rules ONLY when
                          a type carries an explicit @enforces JSDoc tag

src/services/persona/canonical-prose-extractor.ts
                        → reads ADRs + prose docs in trusted repos,
                          emits lessons_learned rows with
                          source_kind='canonical_prose' + bulk-promote affordance
                          (NOT a Tier 0 parser — soft-canonical, gated)
```

Each Tier 0 parser runs:
- once on schema migration (initial population),
- via a file-watcher in dev (`fs.watch` over the parsed files),
- via a cron in prod (every 6 hours; cheap),
- on demand via `POST /api/persona/reparse?source=lint|tsconfig|types`.

Output of every parser pass is a list of palace drawer ids it wrote/updated. The diff vs the previous pass is the change set: new rules → tagged `auto-imported` and immediately active (no gate); removed rules → tagged `retired` with `reason='source_removed'` (so if you delete an ESLint rule from your config, the corresponding rule in the palace retires).

The canonical-prose extractor follows a similar shape but emits `lessons_learned` rows with `source_kind='canonical_prose'` instead of palace drawers. The `/setup/persona` UI displays these in Pending with a "Promote all canonical-prose lessons from trusted repos" bulk button — a single click can ratify the entire ADR-derived rule set on day one, but it's still ratified by Maaz, not the upstream commit author.

#### Source-of-truth precedence at recall time

When `recall_memory` returns rules to the brain, ranking is:

```
final_score = base_score × tier_weight × source_weight × recency_factor

tier_weight     = 1.5 if tier=='canonical'  else 1.0
source_weight   = 1.3 if source=='lint'           // build-failing — strongest
                = 1.2 if source=='tsconfig'        // build-failing — strongest
                = 1.1 if source=='canonical_prose' // promoted ADR/doc rule
                = 1.0 if source=='inferred'        // statistically clustered
recency_factor  = canonical ? 1.0 : 1 / (1 + days_old / 30)   // matches existing recall.ts shape
```

This formula matches `recall.ts`'s current `1 / (1 + days_old / 30)` shape rather than introducing a new `exp(-Δdays/half_life)` form (which would require touching every existing recall caller). Canonical rules don't decay — they're explicitly maintained by the parser pass. Inferred rules use the same recency curve recall already implements.

So a lint rule that touches the changed lines outranks an inferred pattern from PR comments. That's correct: the team has *already decided* the lint rule, and the inferred pattern might just be a leakage from a single reviewer's preference.

### Hard rules (non-negotiable)

1. **Never silently learn from prose.** Every candidate rule sourced from human-written text (comments, docs, ADR sections) passes through `/setup/persona` for explicit user approval before it can be cited by the Brain in a way that biases generation. The literature is unambiguous on this — Cursor Memories, Granola, Mem.ai all walked back silent learning.
2. **External prose input never auto-promotes.** Lessons sourced from comments by other reviewers, Jira tickets created by other people, `/code-review` self-reflections, or markdown prose in any repo (including `./repos/example-service/`, `./repos/operations/`) require Maaz clicking Promote. This is the MINJA mitigation (Dong et al. 2025). The narrow exception is **build-failing configs in repos Maaz controls** (T0.1 ESLint, T0.2 TypeScript, T0.3 explicit-`@enforces` types in this WI repo or repos in `PERSONA_TIER0_TRUSTED_REPOS`) — those skip the gate because the rule is already enforced by the build, not just a preference.
3. **Hard cap on injected rules per call.** `recall_memory` returns at most top-N from the `reviews` wing per call (default N=5). Chroma's *Context Rot* research and LongMemEval both confirm Claude 4-class models degrade with too many distractors.
4. **Each rule under 200 tokens — enforced, not declared.** Both parser-side (`canonical-prose-extractor` + Tier 0 parsers) and gate-side (promotion writes a rule) MUST run a 200-token check. Bodies that exceed are either auto-split (separate parser pass step, splitting on bullets or sentence boundaries) or rejected at promotion time with `error: rule_too_long`. Smoke § 17a includes a "no drawer in `reviews` wing exceeds 200 tokens" assertion.
5. **Two distinct 90-day windows, deliberately aligned.** The audit reminder cadence (Hard rule 5 below) and the rule retirement window (consolidator decay) are both 90 days — by design, so the user is reminded to review just before the consolidator would auto-retire long-unused rules. They use one shared `PERSONA_AUDIT_DAYS` env constant (default 90).
6. **Quarterly audit reminder.** A `wi-morning-brief` slot surfaces "you have N rules; M are stale; review them" every `PERSONA_AUDIT_DAYS` days (default 90). CodeRabbit recommends the same cadence.
7. **Brain stays the only retrieval surface.** No skill or endpoint reads `lessons_learned`, `pr_review_comments`, or palace drawers directly. Everything routes through `brain.recall_memory` or `brain.get_decision`. **Enforced** by smoke § 17b: a `grep` check in `src/tools/**` and `src/services/**` (excluding `src/services/brain/` and `src/services/persona/`) MUST find zero direct SELECT/UPDATE on `pr_review_comments`, `lessons_learned`, or `code_diff_outcomes`. Code-review-side enforcement, plus a smoke-test gate.
8. **Tier-0 supersedes Tier-1 on cosine match (conservative threshold).** When a Tier-0 rule (parsed) and a Tier-1 rule (promoted) have body-embedding cosine > 0.95 AND identical normalised `rule_text` (or the same source-rule slug), the Tier-1 rule is auto-retired with `reason='superseded_by_tier0'` and `superseded_by_rule_id` set. The retired rule is excluded from future recall but preserved in `persona_rule_snapshots` for audit. The user sees a one-line entry in the next `/setup/persona` audit reminder ("3 Tier-1 rules retired this week, superseded by lint/tsconfig changes — review?") and can un-retire if the supersession was wrong (rare; the cosine + text check is conservative). Threshold + identity gate are deliberately strict — soft-adjacent rules ("no any" vs "always type returns") will NOT auto-retire, they fall to the same-tier contradiction path. Enforced by Phase 77d consolidator and smoke § 20a / § 20b.

---

## Flow chart

> The flow chart below describes the **Tier 1 (inferred)** pipeline only — that's where the cluster → gate → promote logic lives. **Tier 0 (canonical) is a separate, simpler path:** parsers in `src/services/persona/parsers/` read ADRs / prose docs / ESLint config / TypeScript config / shared type helpers, and emit `kind='rule'` palace drawers directly. No clustering, no `lessons_learned` row, no `/setup/persona` gate. File-watcher in dev, 6-hourly cron in prod, idempotent re-emit via content hash. See "Tier 0 — canonical sources (parsed, not inferred)" above for the full parser inventory.

```
┌─────────────────────────────────────────────────────────────────────┐
│                          1. INGEST                                  │
│                                                                     │
│  GitHub PR review     wi-pr-review     /code-review     BugLoop     │
│  comments (Maaz       suggestion        skill output    outcome     │
│  authored PRs)        kept/edited/      vs merged       (ADR-030)   │
│                       reverted          reality                     │
│         │                  │                │              │        │
│         └──────────┬───────┴────────┬───────┴──────────────┘        │
│                    │                │                               │
│                    ▼                ▼                               │
│         pr_review_comments   code_diff_outcomes                     │
│         (raw GitHub mirror)  (verdict + post-merge)                 │
│         + FTS5               + FTS5                                 │
└────────────────────┬────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     2. CLUSTER / EXTRACT                            │
│                                                                     │
│   Weekly cron, persona-extract bucket (Haiku):                      │
│                                                                     │
│   • Embed surviving comments (heuristic prefilter drops bots,       │
│     "lgtm", emoji, replies-of-replies of depth ≥ 3).                │
│   • Cluster via HDBSCAN; size ≥ 3 + mixed-author = candidate.       │
│   • For each cluster, prompt: "extract a single one-line            │
│     imperative rule + the canonical fix idiom + glob path scope     │
│     + language", paired with 3 highest-resolution-weight exemplars. │
│   • Mine the (comment, before-diff, after-diff) triple per          │
│     Tufano ICSE 2021 — store in lessons_learned with                │
│     extractor_prompt_hash for safe re-extraction later.             │
│   • Same pass for code_diff_outcomes: cluster reverted suggestions  │
│     (negative rule candidates), edited suggestions (positive idiom  │
│     candidates), kept-but-caused-regression (highest-severity       │
│     candidates).                                                    │
└────────────────────┬────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          3. PROMOTE (gate)                          │
│                                                                     │
│   /setup/persona UI surfaces lessons_learned rows where             │
│   hit_count ≥ 3 AND status = 'active' AND not yet promoted.         │
│                                                                     │
│   Three buttons per row:                                            │
│     [Promote to rule]  [Edit + promote]  [Dismiss with reason]      │
│                                                                     │
│   Promote action:                                                   │
│     1. Contradiction check vs existing kind='rule' palace entries   │
│        (cosine > 0.92 → surface side-by-side, hold).                │
│     2. POST /api/brain/learn with verb='promote_lesson':            │
│        - MemoryEnricher writes drawer to 'reviews' wing             │
│          with kind='rule', stable id, evidence_json[],              │
│          frontmatter (activation, globs, severity).                 │
│        - KG triples emitted: (rule) -learned-from-> (pr_url),       │
│          (rule) -applies-to-> (file_glob), etc.                     │
│     3. lessons_learned.status = 'promoted',                         │
│        lessons_learned.promoted_to_rule_id = <palace-drawer-id>     │
│                                                                     │
│   Dismiss action: lessons_learned.status='retired';                 │
│     reason stored as negative training (raises future cluster       │
│     threshold for similar candidates).                              │
└────────────────────┬────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          4. INJECT (via Brain)                      │
│                                                                     │
│   When ANY consumer calls brain.get_decision(question, user):       │
│                                                                     │
│   context_builder.ts now includes:                                  │
│     persona_rules = recall_memory(                                  │
│       pattern: extractKeyTerms(question + diff_hunks),              │
│       wing: 'reviews',                                              │
│       kind_filter: 'rule',                                          │
│       limit: 5,                                                     │
│       activation_filter: matchActivation(file_paths, question)      │
│     )                                                               │
│                                                                     │
│   These flow into the model prompt as evidence, with each rule's    │
│   stable id. The model is instructed (deliberative-alignment        │
│   style) to cite the rule_id when it relies on one in its           │
│   answer/review. WI parses citations and increments                 │
│   `applied_count` on the cited drawers (palace-side counter).       │
│                                                                     │
│   No new RAG step. No new analyzer code path. The Brain just        │
│   returns better-grounded decisions because it has more wings to    │
│   recall from.                                                      │
└─────────────────────────────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          5. CLOSE THE LOOP                          │
│                                                                     │
│   When the user accepts/edits/reverts the model's suggestion:       │
│     POST /api/brain/learn → record_outcome(decision_id, outcome)    │
│                                                                     │
│   This already exists. The new wiring:                              │
│     - When a rule_id was cited in evidence and the suggestion was   │
│       'kept' → palace drawer applied_count++ on that rule.          │
│     - When 'reverted' AND a rule was cited → palace drawer          │
│       refuted_count++. If refuted/total > 0.3 → auto-flag           │
│       is_stale=true; rule is suppressed from recall until reviewed. │
│     - When 'kept' AND post-merge regression detected → palace       │
│       drawer severity is upgraded; rule promoted to canonical.      │
│                                                                     │
│   The same record_outcome surface that bug-investigator + bug-      │
│   resolver already use. Nothing new to wire.                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Schema delta — v57 (four new tables)

The original research design had four tables. The brain-flowed redesign drops `rule_cards` entirely — rules live in the palace as drawer entries, not SQL rows. **However**, the palace is a child process with its own state file (ChromaDB on disk). On `palace:rebuild` (per the README, "replays all SQLite data into MemPalace"), promoted rules with no SQLite source would silently vanish. To prevent this, we add a fourth table — `persona_rule_snapshots` — that mirrors the YAML body of every promoted palace drawer back into SQLite. SQLite is the source of truth; palace is the search-optimized cache. All four FTS-indexed where the existing convention applies (`messages_fts`, `meetings_fts` precedent).

**ID typing convention:** `pr_review_comments.id` uses `INTEGER PRIMARY KEY AUTOINCREMENT` because it's a raw mirror of GitHub state with no semantic id need (the GitHub `node_id` provides cross-system identity). `lessons_learned.id`, `code_diff_outcomes.id`, and `persona_rule_snapshots.rule_id` use ULID `TEXT PRIMARY KEY` because they need stable cross-process ids — the palace drawer id, the citation id the model emits, and the SQL snapshot key are the same string. Citation parsing matches against ULID format `01[A-HJKMNP-TV-Z0-9]{24}`.

**Why these four tables are SQL, not palace.** The earlier framing "no parallel SQL store" referred specifically to the rejected `rule_cards` table — i.e. *rules* should not live in SQL. The four tables here are not a parallel rule store. Each has a specific job that palace is the wrong fit for:

- **`pr_review_comments`** — append-only mirror of GitHub state; needs FTS5 full-text search over diff hunks; needs idempotent re-sync via `UNIQUE(repo, github_comment_id)`. Palace's drawer model doesn't fit append-only ingestion at this volume.
- **`lessons_learned`** — staging area between extraction and promotion. Mutable status field (`active|promoted|retired`); lifecycle queries (`WHERE status = 'active' AND hit_count >= 3`) are SQL-shaped. Palace doesn't expose query-by-arbitrary-field.
- **`code_diff_outcomes`** — verdict ledger; mostly numeric counters and timestamps; no semantic search need.
- **`persona_rule_snapshots`** — durability mirror of palace state; the WHOLE POINT is that it's SQL so palace state-loss is recoverable. Putting it in palace would be circular.

Hard rule 7 (Brain stays the only retrieval surface) still holds: no consumer reads any of these directly — everything routes through the brain, enforced by smoke § 17e's grep check. The tables are SQL because they're plumbing, not because they're a parallel knowledge store.

### Table 1: `pr_review_comments` — raw GitHub mirror

A faithful, idempotent mirror of inbound review comments on PRs Maaz authored. Append-only-ish via `UNIQUE(repo, github_comment_id)` for safe re-sync. Denormalized booleans (`is_seed`, `is_bot`, `is_pr_author`) for hot-path scans without joins.

```sql
CREATE TABLE pr_review_comments (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  github_comment_id        INTEGER NOT NULL,
  github_node_id           TEXT NOT NULL,
  repo                     TEXT NOT NULL,
  pr_number                INTEGER NOT NULL,
  pr_author                TEXT NOT NULL,
  pr_title                 TEXT,
  pr_html_url              TEXT,
  parent_review_id         INTEGER,
  in_reply_to_id           INTEGER,
  is_seed                  INTEGER NOT NULL DEFAULT 0,
  commenter_login          TEXT NOT NULL,
  commenter_type           TEXT NOT NULL,
  is_bot                   INTEGER NOT NULL DEFAULT 0,
  author_association       TEXT,
  is_pr_author             INTEGER NOT NULL DEFAULT 0,
  path                     TEXT NOT NULL,
  side                     TEXT,
  line                     INTEGER,
  start_line               INTEGER,
  original_line            INTEGER NOT NULL,
  original_start_line      INTEGER,
  position                 INTEGER,
  original_position        INTEGER,
  commit_id                TEXT,
  original_commit_id       TEXT NOT NULL,
  diff_hunk                TEXT NOT NULL,
  subject_type             TEXT,
  body                     TEXT NOT NULL,
  body_text                TEXT,
  is_outdated              INTEGER NOT NULL DEFAULT 0,
  thread_resolved          INTEGER NOT NULL DEFAULT 0,
  thread_resolved_by       TEXT,
  thread_resolved_at       TEXT,
  resolution_outcome       TEXT,
  resolving_commit_sha     TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  ingested_at              TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo, github_comment_id)
);
CREATE INDEX idx_prrc_pr           ON pr_review_comments(repo, pr_number);
CREATE INDEX idx_prrc_seed_outcome ON pr_review_comments(is_seed, resolution_outcome)
  WHERE is_seed = 1 AND is_bot = 0;

CREATE VIRTUAL TABLE pr_review_comments_fts USING fts5(
  body, body_text, path, diff_hunk,
  content='pr_review_comments', content_rowid='id',
  tokenize='porter unicode61'
);
```

### Table 2: `lessons_learned` — Tier 1 extraction staging area

Ungated agent reflections — what the weekly cron produces from clustering Tier 1 (inferred) signals only. **Tier 0 sources skip this table entirely** — they parse straight to palace `kind='rule'` drawers, because the team has already approved them by committing them.

**Dual-write contract.** Every row inserted here also gets a palace drawer in the `reviews` wing with `kind='lesson_candidate'` and the same ULID id, written by `MemoryEnricher.enrichLessonCandidate` (Phase 77b). The SQL row is the **lifecycle source-of-truth** (status, hit_count, promoted_to_rule_id are mutated here); the palace drawer is the **search source-of-truth** (the brain only reads palace). On promotion, the SQL row's status flips to `'promoted'`, `promoted_to_rule_id` is set, and a new `kind='rule'` drawer is written; the `kind='lesson_candidate'` drawer is retired (status='retired' in its frontmatter; the next palace search excludes retired drawers). Recall never fans out to this SQL table — Hard rule 7's grep gate (§ 17e) enforces.

```sql
CREATE TABLE lessons_learned (
  id                     TEXT PRIMARY KEY,
  source_kind            TEXT NOT NULL,
  source_ref             TEXT NOT NULL,
  rule_text              TEXT NOT NULL,
  rationale              TEXT,
  generalization         TEXT,
  category               TEXT,
  google_axis            TEXT,
  severity               TEXT NOT NULL DEFAULT 'low',
  before_snippet         TEXT,
  after_snippet          TEXT,
  applies_to_path_glob   TEXT,
  applies_to_language    TEXT,
  extractor_model        TEXT NOT NULL,
  extractor_prompt_hash  TEXT NOT NULL,
  embedding              BLOB,
  hit_count              INTEGER NOT NULL DEFAULT 1,
  miss_count             INTEGER NOT NULL DEFAULT 0,
  last_seen_at           TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active',
  promoted_to_rule_id    TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_ref, extractor_prompt_hash)
);
CREATE INDEX idx_lessons_source  ON lessons_learned(source_kind, status);
CREATE INDEX idx_lessons_recency ON lessons_learned(last_seen_at DESC);

CREATE VIRTUAL TABLE lessons_learned_fts USING fts5(
  rule_text, rationale, generalization, before_snippet, after_snippet,
  content='lessons_learned', content_rowid='id',
  tokenize='porter unicode61'
);
```

`source_kind` enum (Tier 1 only — Tier 0 sources don't land here): `'pr_comment' | 'code_review_miss' | 'bug_resolution' | 'jira_regression'`.
`status` enum: `'active' | 'promoted' | 'retired'`.
`promoted_to_rule_id` points to the palace drawer id once promoted (not a SQL FK — palace has no SQL surface).

### Table 3: `code_diff_outcomes` — verdict ledger

Every AI-suggested edit's lifecycle: did the user keep it, edit it, or revert it? Did the merged change cause a regression? This is the highest-fidelity training data WI can collect — and nobody else has it because nobody else sees the post-merge regression linkage.

```sql
CREATE TABLE code_diff_outcomes (
  id                     TEXT PRIMARY KEY,
  source                 TEXT NOT NULL,
  source_ref             TEXT NOT NULL,
  repo                   TEXT,
  file_path              TEXT NOT NULL,
  suggestion             TEXT NOT NULL,
  suggestion_hash        TEXT NOT NULL,
  rule_ids_cited         TEXT,
  verdict                TEXT NOT NULL,
  user_edit              TEXT,
  user_reason            TEXT,
  outcome_after_merge    TEXT,
  jira_regression_key    TEXT,
  recorded_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_diff_verdict ON code_diff_outcomes(verdict, recorded_at DESC);
CREATE INDEX idx_diff_source  ON code_diff_outcomes(source, recorded_at DESC);
CREATE INDEX idx_diff_rules   ON code_diff_outcomes(rule_ids_cited)
  WHERE rule_ids_cited IS NOT NULL;
```

`source` enum: `'wi_pr_review' | 'code_review_skill' | 'bug_resolver' | 'wi_chat'`.
`verdict` enum: `'kept' | 'edited' | 'reverted'`.
`outcome_after_merge` enum: `'clean' | 'reverted' | 'caused_regression'` (filled async by a 7-day-delay job).
`rule_ids_cited` is a JSON array of palace drawer ids — closes the citation loop so the brain knows which rules were applied vs ignored.

### Table 4: `persona_rule_snapshots` — palace-rebuild durability

SQLite-side mirror of every promoted palace drawer's YAML body. Without this, a `palace:rebuild` (which only replays SQLite-sourced data) silently nukes the rule book. With this, the rebuild script gets a `replayPersonaRules()` step that walks `persona_rule_snapshots` and re-emits every drawer to the `reviews` wing. SQLite is the source of truth for promoted rules; palace is the search-optimized cache.

```sql
CREATE TABLE persona_rule_snapshots (
  rule_id              TEXT PRIMARY KEY,           -- palace drawer id (ULID)
  body_yaml            TEXT NOT NULL,              -- full YAML frontmatter + body
  body_hash            TEXT NOT NULL,              -- sha256 for diff detection
  applied_count        INTEGER NOT NULL DEFAULT 0, -- atomic counter (see below)
  refuted_count        INTEGER NOT NULL DEFAULT 0,
  last_applied_at      TEXT,
  is_canonical         INTEGER NOT NULL DEFAULT 0,
  is_stale             INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'pending_review' | 'retired'
  promoted_from        TEXT,                       -- lessons_learned.id or canonical_prose ref
  superseded_by_rule_id TEXT,                      -- BLOCKER-4: set when Hard rule 8 retires this rule
  retired_reason       TEXT,                       -- 'superseded_by_tier0' | 'source_removed' | 'decayed' | 'user_dismissed' | NULL
  promoted_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_persona_status ON persona_rule_snapshots(status, is_canonical);
CREATE INDEX idx_persona_superseded ON persona_rule_snapshots(superseded_by_rule_id)
  WHERE superseded_by_rule_id IS NOT NULL;
```

**Counters: where they live (and where they don't).** `applied_count`, `refuted_count`, `last_applied_at`, `is_canonical`, and `is_stale` are SQL columns on `persona_rule_snapshots` and **are NOT serialized into `body_yaml`**. `body_yaml` is a counter-free template — stable frontmatter (id, kind, title, category, severity, activation, globs, description, evidence, promoted_from, approved_by, approved_at, conflicts_with) plus the rule body. At every read site that needs a "complete" drawer (palace re-emit, `palace:rebuild` replay, `/setup/persona` UI render, citation evidence assembly inside the brain), the renderer overlays the counter columns from the same SQL row. There is exactly one source-of-truth for the counters: the SQL columns. This is why `MemoryEnricher.enrichRuleApplication` is `UPDATE persona_rule_snapshots SET applied_count = applied_count + 1 ...` followed by a re-emit of `render(body_yaml, current_counters)` — the SQL UPDATE is atomic, and the re-emit cannot serialize a stale counter because it reads the SQL row in the same transaction (`BEGIN; UPDATE …; SELECT …; COMMIT;`). A crash between UPDATE and re-emit leaves palace one read behind, but the next read corrects via the same render path.

This also closes the per-rule write-lock concurrency open question. SQLite's per-row locking is the lock; `body_yaml` is immutable post-promotion (only changes when the rule is re-promoted with edits, which goes through the gate again).

### What lives in the palace, not SQL

A *promoted rule* is a palace drawer entry in the `reviews` wing with this shape (drawer body is YAML-frontmatter markdown — same convention MemoryEnricher already uses for `decisions` wing):

```
---
id: rule_01J9V3K5R8M2W1H4F7B6T9
kind: rule
title: Never mutate context.headers in oRPC middleware
category: api-misuse
severity: high
activation: globs
globs:
  - lib-backend-core/**/middleware/*.ts
  - lib-backend-core/getApplyExpressMiddleware/**
description: |
  The oRPC→Express adapter merges context.headers → req.headers AFTER
  middleware. Direct mutation gets clobbered. Publish via
  next({ context: { headers: { ...context.headers, foo: 'bar' } } }).
evidence:
  - kind: pr
    ref: org/example-service#3918
    note: "PROJ-15702 fix landed 2026-05-20 — search-provider proxy 401 / infinite loop"
  - kind: pr
    ref: org/example-service#3858
    note: "PR that changed the merge order, 2026-05-19"
promoted_from: lessons_learned/01J9V0Y7B3K1P2W8X5N4Q6
approved_at: 2026-06-15T09:14:33Z
applied_count: 0
refuted_count: 0
last_applied_at: null
is_canonical: false
is_stale: false
conflicts_with: []
---
# NOTE (BLOCKER-3 fix): applied_count, refuted_count, last_applied_at,
# is_canonical, is_stale shown above are illustrative only — they are NOT
# stored in body_yaml. They live in persona_rule_snapshots SQL columns and
# are overlaid at render time. body_yaml carries only stable metadata + the
# rule body. See "Counters: where they live (and where they don't)" below.

The rule, in plain English (≤200 tokens):

In any oRPC middleware that needs to publish a header, ALWAYS use
next({ context: { headers: { ...context.headers, ... } } }) and NEVER
mutate context.express.req.headers directly. The adapter merges
context.headers into req.headers AFTER your middleware runs, which
silently clobbers direct mutations.
```

Why YAML frontmatter? Same reason Cursor uses it: human-readable, diffable, easy to edit in the `/setup/persona` UI, and the activation knobs (`globs`, `description`, `activation`) are exactly the four-mode model the production tools converged on.

`applied_count` and `refuted_count` live in the drawer's frontmatter but are bumped by `record_outcome` writes. MemoryEnricher gets a new method `enrichRuleApplication(rule_id, outcome)` that does the in-place YAML edit and re-emits the drawer. Same fire-and-forget pattern as the rest of MemoryEnricher.

### Schema migration shape

```ts
// src/db/schema.ts migrations array — entry 57
{
  version: 57,
  description: 'ADR-032: persona memory loop — pr_review_comments, lessons_learned, code_diff_outcomes',
  up: (db) => {
    db.exec(/* sql above */);
  }
}
```

Plus a one-time `model_config` insert: no new bucket needed (uses existing `agents` bucket for the weekly cron — already configured per ADR-031).

---

## Brain integration — how every existing consumer benefits

The whole point of brain-flowed design is that **no consumer needs to change**. Here is what each consumer looks like before and after.

### `wi-pr-review` skill — biggest beneficiary

**Today:** the `wi-pr-review` skill (`skills/wi-pr-review/SKILL.md`) is a Claude Code-side skill that orchestrates several server endpoints — `POST /api/pr/enrich` (pulls Jira context + ownership map), `GET /api/code-graph/blast-radius`, plus the `analyzer.chat()` surface for the actual review reasoning. There is **no** dedicated `analyzer.reviewPullRequest()` method; the prose composition happens inside the skill via `analyzer.chat`. No persona memory anywhere.

**After:** the skill calls `/api/brain/decide` instead, with `question` shaped as the review prompt and `evidence_needed` listing the rule wing. The brain assembles context including top-N persona rules from the `reviews` wing, scoped by file paths in the diff, and returns a structured decision. The model has to cite rule_ids in its output. Skill code change: ~10 lines.

```ts
// before (src/tools/pr-review.ts)
const review = await analyzer.chat({ system: prSystemPrompt, user: diffMessage });

// after
const decision = await brain.getDecision({
  question: `Review this PR diff for correctness, style, and team conventions:\n${diff}`,
  evidence_needed: [
    `pr_review:${pr.url}`,         // new adapter — see below
    `recall:reviews:${files.join(',')}`,
  ],
});
const review = decision.decision; // already structured, already grounded
```

Cost: the brain wraps the same Opus call the analyzer was doing, plus a ~50ms vector-search hop. No net cost increase given prompt caching.

### Web-UI chat (ChatPanel + `/api/chat`)

There is no `wi-chat` skill on disk — the chat surface is the React `ChatPanel` component in `web/src/components/shell/ChatPanel.tsx` that POSTs to `/api/chat` (handler in `web-server.js`). For code-shaped prompts (detected by the existing classifier in the chat handler), routing changes from `analyzer.chat()` direct → through `brain.getDecision`. ~10–15 line change to the `/api/chat` handler.

**Today:** `/api/chat` calls `analyzer.chat()` with a session memory that includes recent messages but no structured rules.

**After:** chat path is unchanged for casual conversation. When the user asks for code (detected by the existing classifier), the chat handler fans through `brain.getDecision` with the user's prompt + open file paths as evidence. Brain pulls relevant persona rules. Citations propagate to `code_diff_outcomes` if the user pastes the suggestion into a file.

### `BugInvestigatorAgent` (ADR-030 Phase B)

**Already calls Brain.** Just gets richer context. When the agent investigates a bug whose stack trace points at `lib-backend-core/middleware/`, it now sees the oRPC-headers rule in evidence — and may correctly identify the bug as "this code violates rule X" rather than re-deriving the cause from scratch. Net cost: unchanged. Net quality: higher.

### `BugResolverAgent` (ADR-030 Phase C)

**Already calls Brain.** When generating a patch, the resolver gets persona rules in the same evidence stream. The patch follows the rules. If the suggested patch violates a rule, the rule's `applied_count` won't increment because the model didn't cite it; the cron eventually flags it as a near-miss for the propose-then-approve UI. No net cost.

### Investigation flow (`wi-investigate`)

**Already calls Brain.** When investigating BDS-XXXXX in `lib-auth/`, the brain now surfaces:

- past bug fixes in lib-auth (from `bug_resolutions` — already wired)
- past reviewer style preferences in lib-auth (from `reviews` wing — new)
- past Jira regressions linked to lib-auth (from `reviews` wing where `source_kind='jira_regression'` — new)

All in one `recall_memory` call. The investigation prompt becomes meaningfully richer with zero new code in `wi-investigate`.

### `recall_memory` — the load-bearing change (signature extension)

The fan-out in `src/services/brain/recall.ts` already merges three sources:

1. `palace.search(pattern, wing?, limit?)` — current signature, no `kind` filter
2. `brain_decisions` LIKE
3. `brain_action_clusters` LIKE

Adding the `reviews` wing requires three coordinated signature changes — this is **not** a drop-in extension; it touches the brain's recall API plus the palace adapter:

**Change 1: `recall.ts` — new optional params (backward-compatible defaults)**

```ts
// before — actual signature in src/services/brain/recall.ts:47
export async function recallMemory(args: {
  db: Database.Database;
  pattern: string;
  palace?: PalaceClient | null;
  limit?: number;
  now?: () => number;
}): Promise<RecallResult[]>

// after
export async function recallMemory(args: {
  db: Database.Database;
  pattern: string;
  palace?: PalaceClient | null;
  limit?: number;
  now?: () => number;
  // new — all optional, all default to today's behaviour
  wings?: string[];                  // default: ['decisions', 'topics', 'reviews']
  kind_filter?: 'rule' | 'lesson_candidate';
  activation_filter?: { file_paths?: string[]; question?: string };
}): Promise<RecallResult[]>
```

Defaults preserve today's behaviour: existing callers pass none of the new params and get the same results plus reviews-wing hits. **Every call site is unchanged**, but the implementation needs to honour the wings list and the filters.

**Change 2: `palace-client.ts` — new optional `kind` param on `search`**

```ts
// before — actual signature in src/intelligence/palace-client.ts:222
async search(query: string, wing?: string, limit = 5): Promise<string>

// after
async search(query: string, wing?: string, limit = 5, options?: { kind?: string }): Promise<string>
```

The MemPalace MCP tool needs a corresponding `kind` parameter on its `search` action. If the palace process doesn't yet expose it, the wrapper falls back to client-side filtering (load drawer body, regex `kind: <value>` in the YAML frontmatter). Slower but works against any palace version. Open Question 7 (added in this revision) tracks the upstream palace change.

**Change 3: SQL counter snapshot for palace state durability**

`palace:rebuild` (per the README, "replays all SQLite data into MemPalace") would silently wipe promoted rules — they have no SQLite source today. Add a `persona_rule_snapshots` table (see Schema delta § Table 4 — added in this revision) so the SQLite side carries the source of truth and rebuild can repopulate the wing.

### Caller swap — what actually changes per consumer

| Consumer | Today | After 77c | LOC | Notes |
|---|---|---|---|---|
| `BugInvestigatorAgent` (ADR-030) | Calls `brain.getDecision` | Same call; richer recall result | 0 | True drop-in |
| `BugResolverAgent` (ADR-030) | Calls `brain.getDecision` | Same call; richer recall result | 0 | True drop-in |
| `wi-investigate` skill | Calls `/api/brain/decide` | Same call; richer recall result | 0 | True drop-in |
| `wi-pr-review` skill | Calls `/api/pr/enrich` + `/api/pr/review` (which today wraps `analyzer` directly) | Calls `/api/brain/decide` with PR-shaped question + `evidence_needed: ['pr_review:...']` | ~10–15 | Real routing change. The skill's flow is unchanged from the user's PoV but the server side switches to brain-first |
| Web-UI ChatPanel + `/api/chat` | Calls `analyzer.chat()` directly | For code-shaped prompts (detected by existing classifier), routes through `brain.getDecision` | ~10–15 | Real routing change in `web-server.js` chat handler |

So three out of five consumers gain persona memory with **truly zero** code change. Two consumers — `wi-pr-review` and the chat handler — need a real ~10–15 line server-side migration in Phase 77c. The Consequences section (below) is updated to match this honest scope.



### `verify_claim` — new adapter

Add a `pr_review` verifier adapter under `src/services/brain/verifiers/`:

```ts
// pr-review-verifier.ts
export async function verifyPrReview(
  db: Database,
): Promise<VerifyResult> {
  const parsed = parseVerifierSpec(spec);
  // Look up matching pr_review_comments rows
  // Return { verified, evidence, confidence }
}
```

This lets a consumer ask the brain: "did reviewer X approve a change of this kind in the past?" and get a structured answer. Useful for `wi-pr-review` when proposing a self-review verdict — it can pre-check whether the PR's likely reviewer has historically been strict on the patterns the diff touches.

### `record_outcome` — the universal write path

Already exists. Already triggers MemoryEnricher. Two new MemoryEnricher methods:

```ts
// New: writes a lesson_candidate drawer to the 'reviews' wing
async enrichLessonCandidate(lesson: LessonRow): Promise<void>

// New: in-place update to a rule drawer's applied_count / refuted_count
async enrichRuleApplication(
  ruleId: string,
  outcome: 'kept' | 'edited' | 'reverted',
): Promise<void>
```

Both are fire-and-forget, follow the existing pattern, share the existing palace-disabled-graceful-degradation behaviour.

---

## Failure modes and explicit mitigations

The literature is explicit about what kills these systems. Each failure mode has a concrete mitigation.

| Failure mode | Source | Mitigation in this design |
|---|---|---|
| **Memory bloat → context rot** | Chroma 2024 *Context Rot* research; LongMemEval (Wu et al. 2024) showed -30% accuracy on long histories | Hard cap top-5 rules per `recall_memory` call. Persona summary block (cached) ≤ 2k tokens. Each rule ≤ 200 tokens. |
| **Persona drift / contradictory rules** | Cursor forum: "rules ignored after a while" | Contradiction check at *promotion* time, not retrieval time. `/setup/persona` Conflicts tab; cosine > 0.92 between two rules → side-by-side resolution required. |
| **Rule fatigue → model ignores rules** | Same root cause as bloat | `applied_count` / `refuted_count` tracking on each palace drawer. `is_stale` auto-flag when `refuted / total > 0.3` → suppressed from recall until reviewed. |
| **Memory poisoning (MINJA)** | Dong et al. 2025, [arXiv:2503.03704](https://arxiv.org/abs/2503.03704) | All `lessons_learned` rows from external content (PR comments by other people, Jira tickets created by others) carry `source_kind` that requires explicit human approval at `/setup/persona`. Self-reflection lessons (`source_kind='code_review_miss'`) may auto-promote ONLY at very high `hit_count` thresholds (≥ 10) AND with `severity='nit'` (suppressing-only, never raising). |
| **Silent learning erodes trust** | Cursor / Granola / Mem.ai all walked it back | Propose-then-approve hard gate at `/setup/persona`. Every rule has visible `applied_count`, `refuted_count`, `last_applied_at`. Reasons-for-dismissal stored as negative training. |
| **Stale conventions (codebase moved on)** | MSR literature; recent Cursor user reports | 90-day half-life on lesson recency; `is_canonical` floor for rules with `applied_count >= 5`; codebase-mutation detector via climbing `false_positive_count`. |
| **Squash-merge destroys audit trail** | Standard GitHub workflow concern | Ingestion fallback: compare comment-time diff vs merged-HEAD diff at the same lines, instead of walking per-commit history. Mirrors what already works in code-graph-indexer. |
| **Bot noise** | dependabot, sonarqube-bot, copilot-bot, coderabbitai, snyk-bot | `is_bot` denormalized column + `KNOWN_BOTS` allowlist; bot comments persist in `pr_review_comments` for completeness but are excluded from clustering and lesson extraction. |
| **One-off nits inflated to rules** | Generic class of false positives | Cluster threshold `size >= 3 AND mixed_author = true`. A single reviewer's pet peeve can't become a rule; needs reinforcement from at least two distinct reviewers. |
| **Rule recall dominates the prompt** | Prompt-engineering classic | Activation filtering: rules with `activation='globs'` only fire when a glob matches the changed paths. `activation='intelligent'` requires cosine > τ between query and rule's `description` field. `activation='manual'` is excluded from auto-recall entirely. |
| **Citation-parser fragility silently retires useful rules** | Open question raised in ADR review | Retirement is gated on `last_recalled_at` (set every time `recall_memory` returns the rule, regardless of whether the model cites it), NOT only on `applied_count`. A rule with `applied_count=0 AND last_recalled_at < 60d ago` is NOT retired — it's recalled-but-not-cited, which may be the citation parser missing the citation, not the rule being useless. Phase 77c also adds a fuzzy-match fallback: if the model's reasoning text cosine-matches an active rule's body above τ, the rule's `applied_count` increments even without an explicit citation. |
| ** enterprise GHES rate limits** | Public docs: ~5000 req/hour primary, secondary limits at 900 req/min, 100 concurrent | Daily cron uses ETag-aware fetch with `If-None-Match`; persists `last_synced_at` per `(repo, pr_number)`; exponential backoff on 403/429. First-run backfill restricted to 30 days (open question 2). GraphQL preferred over REST per open question 1 — one round-trip per PR vs three. |
| **Palace process restart loses in-flight writes** | PalaceClient is a child Python process; ChromaDB reloads from disk, in-flight writes vanish | Counters live in SQLite (`persona_rule_snapshots` columns) — atomic UPDATE survives palace restart. `body_yaml` is counter-free (BLOCKER-3 fix); the rendered drawer overlays counters at re-emit time. Drawer body is re-emitted on next read (lazy reconciliation); a startup hook in PalaceClient detects missing drawers via `persona_rule_snapshots` row count vs palace search count and triggers a `replayPersonaRules()` step that calls `render(body_yaml, current_counters)` per row. |
| **Cron infrastructure mismatch** | None of WI's existing agents are weekly-cadence; current pattern is per-tick agents | Reuse the BugInvestigatorAgent shape (per ADR-030) — register Tier 0 file-watcher and Tier 1 weekly clusterer as ticking agents with 60s heartbeat reading a `last_run_at` column from `persona_rule_snapshots`/`lessons_learned`; agent does work only when due. No new cron daemon. Env: `PERSONA_TIER0_INTERVAL_MS` (default 6h), `PERSONA_TIER1_INTERVAL_MS` (default 7d). |
| **Tier 0 parser ambition exceeds time budget** | ADR review HIGH-3 finding | `parse-eslint`, `parse-tsconfig`, `parse-type-helpers` are in 77a scope (3 parsers, not 5). Originally-planned `parse-adr` and `parse-prose-doc` moved to canonical-prose-extractor (T1.0, gated, lighter regex shape). `parse-type-helpers` tightened to require explicit `@enforces` JSDoc tag. ESLint runs full-resolution only (against `PERSONA_TIER0_TRUSTED_REPOS`, default WI-only). The strict-subset-degraded-mode path on customer repos is removed from v1 — see BLOCKER-2 fix above. |

### Feature flags introduced by this ADR

Following the ADR-030 pattern of explicit env-flag tables.

| Flag | Default | Phase | Behaviour when set |
|---|---|---|---|
| `PERSONA_MEMORY_TIER0_ENABLED` | `0` | 77a | When `1`, Tier 0 parsers (eslint, tsconfig, type-helpers) run on schema migration, file change, and 6h cron. When `0`, parsers don't register at all (no palace writes from Tier 0). |
| `PERSONA_MEMORY_INGEST_ENABLED` | `0` | 77a | When `1`, `pr-review-ingest.ts` runs the daily cron + 30-day backfill on first run. When `0`, no GitHub fetches happen and `code_diff_outcomes` write hooks no-op. |
| `PERSONA_MEMORY_EXTRACT_ENABLED` | `0` | 77b | When `1`, weekly cluster + Haiku extraction runs and pre-fill from canonical prose runs. When `0`, `lessons_learned` table is read-only (existing rows preserved, no new ones added). |
| `PERSONA_MEMORY_INJECT_ENABLED` | `0` | 77c | When `1`, `recall_memory` includes the `reviews` wing in its fan-out and `wi-pr-review` + chat handler route through `brain.getDecision`. When `0`, the new wing is silent — Active rules in `/setup/persona` exist but don't bias generation. |
| `PERSONA_TIER0_TRUSTED_REPOS` | `""` (only the WI repo) | 77a | Comma-separated list of repo absolute paths whose mechanically-enforced configs Tier 0 may auto-promote from. v1 default is the WI repo only. `./repos/example-service/` and `./repos/operations/` are **explicitly NOT in v1's default** and adding them is gated on a future ADR — see BLOCKER-2 in the v1 review. Empty value = WI repo only. |
| `PERSONA_AUDIT_DAYS` | `90` | 77d | Audit reminder cadence + rule retirement window. Single shared constant — see Hard rule 5. |
| `PERSONA_TIER0_INTERVAL_MS` | `21600000` (6h) | 77a | Tier 0 file-watcher cron heartbeat. |
| `PERSONA_TIER1_INTERVAL_MS` | `604800000` (7d) | 77b | Tier 1 weekly clusterer heartbeat. |

---

## Implementation phases

The design is sized for one phase but the user's brain (literally — see [recorded decision](#recorded-brain-self-decision-2026-06-02) below) recommended slicing it into a thin v0 + a richer v1 to match the current backlog. We follow that advice.

### Phase 77a — Tier 0 parsers + canonical-prose pre-fill + Tier 1 logging (1.5 weeks)

**Goal:** ship a working day-one rule book (Tier 0 build-failing configs auto-promoted; canonical prose pre-filled in Pending for 1-click bulk approval) and start collecting the Tier 1 training signal in parallel.

**Tier 0 (mechanically-enforced sources — auto-promoted, no gate):**

- Schema v57 migration (4 tables: `pr_review_comments`, `lessons_learned`, `code_diff_outcomes`, `persona_rule_snapshots`).
- `src/services/persona/parsers/parse-eslint.ts` — loads resolved ESLint config; emits one `kind='rule'` palace drawer per active rule, scoped by config's `files`/`overrides` globs, severity from config. **Single mode in v1: full resolution only.** Runs only against repos in `PERSONA_TIER0_TRUSTED_REPOS` (default: WI repo) which by definition have `node_modules`. The "degraded mode" path the earlier draft contemplated for `./repos/example-service/` and `./repos/operations/` is **explicitly removed from v1** — see Hard scope rule above. Restoring Tier-0 ESLint coverage on customer repos is deferred to a future ADR (would need lint-only dep install OR a pre-resolved snapshot AND a strict-subset-safety story).
- `src/services/persona/parsers/parse-tsconfig.ts` — walks all `tsconfig*.json` files including `references`; emits rules for the strict-family flags that are on (`strict`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes`, `noImplicitReturns`).
- `src/services/persona/parsers/parse-type-helpers.ts` — **explicit opt-in only.** Uses TypeScript compiler API to walk public `*.d.ts` and `*.types.ts`; emits a rule ONLY when a type carries an explicit `@enforces` JSDoc tag (e.g. `@enforces: prefer over Promise<T> for fallible operations`). No implicit derivation from `@deprecated` / `@example` (too noisy).
- File watcher in dev (`fs.watch`) + 6-hourly cron in prod runs the parsers; output is content-hash dedup'd via existing MemoryEnricher pattern.
- Each emitted rule is mirrored to `persona_rule_snapshots` via the SQL-side write path described in Schema § Table 4 — this is what makes the rule book survive `palace:rebuild`.
- **Token-cap enforcement at parse time.** Rules whose body exceeds 200 tokens are split on bullet boundaries (or sentence boundaries) before emission. If splitting fails, the rule is rejected with a logged warning rather than silently truncated.
- Behind feature flag `PERSONA_MEMORY_TIER0_ENABLED=0` by default; flip to `1` after smoke passes.

**Soft-canonical prose (T1.0 — pre-filled, gated):**

- `src/services/persona/canonical-prose-extractor.ts` — reads ADRs (`docs/**/adr*.md`, `docs/docs/adr/*.md`), `CLAUDE.md`, and `docs/**/*.md` in trusted repos. Finds `## Decision` / `## Hard rules` / `## Conventions` / `## Don't` / `## Always` sections; per-bullet writes to `lessons_learned` with `source_kind='canonical_prose'`, `extractor_prompt_hash` set so re-extraction is idempotent.
- `/setup/persona` Pending tab gets a "Bulk-promote canonical prose from trusted repos (N candidates)" button.
- This is **not** a Tier 0 parser — it's gated. Even an ADR's `## Hard rules` section needs one click to ratify, because the ADR may have been written by someone who isn't Maaz.

**Tier 1 (inferred sources — data collection only this phase):**

- Extend `GitHubMcpClient` with `getReviewComments(owner, repo, prNumber)` and `getReviewThreads(...)` wrapping the existing `pull_request_read` MCP tool methods.
- New `src/services/pr-review-ingest.ts` (Process stage). Daily cron pulls last 30 days of Maaz-authored PRs; backfills `pr_review_comments`. Filter bots; compute `resolution_outcome`; mine the (comment, before, after) triple for `fixed` threads.
- New `code_diff_outcomes` write hooks in `wi-pr-review` and the web-UI chat handler — every AI suggestion gets a row with initial `verdict='kept'` (overwritten by 7-day delay job).
- Behind feature flag `PERSONA_MEMORY_INGEST_ENABLED=0` by default.

**Smoke tests added in this phase:**

- Smoke § 17a (Tier 0 parsers): each parser produces ≥ N rule drawers on the WI repo; deleting a rule from `eslint.config.js` retires the corresponding palace drawer on next pass; **no drawer in the `reviews` wing exceeds 200 tokens**.
- Smoke § 17b (Tier 1 ingestion): backfill produces ≥ N rows for a known PR; `code_diff_outcomes` row is created for a manual chat suggestion.
- Smoke § 17c (canonical-prose extractor): WI's own `CLAUDE.md` + `.claude/rules/*.md` produce ≥ N `lessons_learned` rows with `source_kind='canonical_prose'`.
- Smoke § 17d (palace-rebuild durability): promoted rule + manual `palace:rebuild` reproduces the rule in the `reviews` wing from `persona_rule_snapshots`.
- Smoke § 17e (Hard rule 7 enforcement): grep over `src/tools/**` and non-persona `src/services/**` finds zero direct SELECT/UPDATE on the new tables.

**What you'd see at the end of this phase:** `/setup/persona` Active tab populated with 30+ Tier 0 rules (lint, tsconfig, opted-in `@enforces` types). Pending tab populated with N canonical-prose candidates ready for one-click bulk-promote. Tier 1 SQL tables filling silently. Phase 77b can be planned with real numbers from the 30-day backfill.

**Scope-reduction note vs the previous draft of this phase:** the original draft listed 5 parsers including `parse-adr.ts` and `parse-prose-doc.ts` as Tier 0 auto-promoting. Per the ADR review, those are MINJA vectors when the parsed repos are externally controlled. They moved to T1.0 (gated, pre-filled) so a malicious upstream commit cannot silently inject a rule. `parse-type-helpers` was tightened from "any JSDoc" to "explicit `@enforces` tag" to avoid emitting rules from incidental documentation. Scope reduced; safety improved.


### Phase 77b — v1 extraction + propose-then-approve UI (1.5 weeks)

**Goal:** turn the collected signal into surface-able lesson candidates.

- New `AIAnalyzer.extractReviewLesson()` method using the existing `agents` model_config bucket. Weekly cron clusters comments via embeddings + HDBSCAN, prompts Haiku for one-line rules + glob scopes.
- MemoryEnricher additions: `enrichLessonCandidate(lesson)` writes drawer to `reviews` wing with `kind='lesson_candidate'`.
- `/setup/persona` page (React UI). Three tabs: Pending / Active / History. Promote / Edit / Dismiss buttons.
- New endpoint `POST /api/brain/learn` extension: `verb='promote_lesson'` writes a `kind='rule'` drawer; `verb='dismiss_lesson'` records the dismissal reason as negative training.
- Behind same feature flag: `PERSONA_MEMORY_EXTRACT_ENABLED=0` by default.
- Smoke § 18: cluster of 3 manually inserted comments produces 1 lesson_candidate; promotion via API writes a kind='rule' drawer; dismissal records reason.

### Phase 77c — v1 injection (0.5 weeks)

**Goal:** rules in the brain's recall path actually bias generation.

- Extend `recall_memory` to fan out to the `reviews` wing (with `kind_filter` and `activation_filter` parameters).
- Update `wi-pr-review` and `wi-chat` to call `brain.getDecision` instead of `analyzer.*` directly. ~10-line skill change each.
- Citation parsing: when the model's response references a rule_id from the evidence, increment `applied_count` on that drawer via `MemoryEnricher.enrichRuleApplication`.
- Smoke § 19: PR review with a known-active rule cites that rule_id; `applied_count` increments; subsequent `recall_memory` ranks it higher.

### Phase 77d — feedback closure + nightly consolidation (0.5 weeks)

**Goal:** stop the rule list from rotting.

- 7-day-delay job for `code_diff_outcomes.outcome_after_merge`.
- Nightly Letta-style consolidation cron:
  - **Tier-0 supersession (new — Hard rule 8).** For each pair (tier0, tier1) where both are status='active' and body-embedding cosine > 0.95 AND identical normalised `rule_text` (or same source-rule slug): tier1 → status='retired', `superseded_by_rule_id`=tier0.rule_id, `retired_reason`='superseded_by_tier0'. Always automatic, no user prompt; surfaces in the next audit reminder. Threshold + identity gate are deliberately strict — soft-adjacent rules fall to the same-tier contradiction path below.
  - **Same-tier contradiction (legacy — promotion-time check, also runs nightly).** For each pair (rule_a, rule_b) of the SAME tier with cosine > 0.92: mark both `pending_review`; surfaces in `/setup/persona` Conflicts tab; the user picks one or merges before either can be recalled.
  - Decay: rules with `applied_count = 0 AND created_at > PERSONA_AUDIT_DAYS AND is_canonical = 0 AND last_recalled_at < 60d ago` → status='retired'.
  - Stale detection: `refuted_count / total > 0.3` → `is_stale=true`.
  - Persona summary regen for the cached system block.
- Quarterly audit reminder via `wi-morning-brief`.
- Smoke § 20: dry-run of the consolidator on a synthetic dataset produces expected promotions, retirements, conflict surfaces.

### Total: ~4 weeks for one engineer

Each phase ships independently behind the env flag. **Phase 77a is no longer logging-only** — Tier 0 parsers give the system a populated rule book before the first PR review. Phase 77b adds the inferred-rule pipeline on top. If Phase 77a's Tier 1 data shows we're getting fewer than 5 useful comments/week, Phase 77b is downscoped to "Tier 1 lessons stay as candidates only, never auto-promoted, manual review required" and Phase 77c+d push out.

---

## `/setup/persona` UI sketch

```
╔══════════════════════════════════════════════════════════════════╗
║  Persona Memory                                       [⚙ Settings]║
╠══════════════════════════════════════════════════════════════════╣
║                                                                    ║
║  [ Pending (3) ] [ Active (12) ] [ History (47) ]                 ║
║                                                                    ║
║  ┌─ Pending lesson #1 ─────────────────────────────────── 4 hits ┐║
║  │                                                                ║
║  │  Rule:  Always null-check the result of Map.get() before      │║
║  │         calling .property on it                                │║
║  │                                                                │║
║  │  Why:   Map.get() returns undefined for missing keys; reviewer│║
║  │         flagged this on PRs #4055, #4082, #4091. All three   │║
║  │         comments were resolved with the same .has() check fix.│║
║  │                                                                │║
║  │  Scope: src/**/*.ts, src/**/*.tsx                             │║
║  │  Severity: medium                                             │║
║  │                                                                │║
║  │                                                                │║
║  │  [Promote to rule]  [Edit + promote]  [Dismiss with reason]   │║
║  └────────────────────────────────────────────────────────────────┘║
║                                                                    ║
║  ┌─ Pending lesson #2 ─────────────────────────────────── 3 hits ┐║
║  │  ...                                                           │║
║  └────────────────────────────────────────────────────────────────┘║
║                                                                    ║
╚══════════════════════════════════════════════════════════════════╝
```

The Active tab shows the same shape but for promoted rules with `applied_count`, `refuted_count`, `last_applied_at`. The History tab shows retired rules + dismissed lessons with the dismissal reasons.

A "Conflicts" badge appears on the tab header when the consolidator has detected at least one cosine > 0.92 pair; clicking opens a side-by-side view forcing resolution before either rule can be cited.

---

## Alternatives considered

### Alt 1 — Parallel `rule_cards` SQL table (the original v0 sketch)

Reviewed in `research-output/wi-persona-memory-design.md`. Rejected because it duplicates infrastructure (palace, recall, citation tracking), creates a bypass path around the Brain (any future skill could read the SQL table directly), and adds more code surface (4 tables + new RAG pipeline + new analyzer step + 8th model bucket).

### Alt 2 — Fine-tune Opus on the user's PR review history

Rejected: Anthropic does not offer fine-tuning on Opus 4.x. Even if it did, weights can't be updated daily as new feedback lands; review threads become outdated faster than retrain cycles. A per-developer fine-tune is also a much larger trust surface than a propose-then-approve rule list. Refact.ai ships a LoRA-based local-personalization layer; their own benchmarks report a few-percent acceptance-rate bump that's hard to attribute, and it requires a GPU. Wrong tool.

### Alt 3 — Use Cursor Rules / Claude Code CLAUDE.md only (manual rules, no learning)

This is what most production tools have converged on (Cursor, Claude Code, Aider, Continue, Cline). It's load-bearingly correct as a baseline — and WI already has `.claude/rules/*.md`. The gap is that manual rules don't capture *recurring* feedback. The user's stated pain is "WI keeps making the same mistakes other reviewers point out" — that's a learning problem, not an authoring problem. Manual rules complement the design (and they survive in `.claude/rules/` unchanged), but they don't replace it.

### Alt 4 — Use Claude Code's auto-memory as the storage layer

Anthropic ships a memory tool primitive (`memory_20250818`, file-system-shaped: `view`/`create`/`str_replace`/`insert`/`delete`/`rename`, scoped to `/memories`). WI could implement the storage backend over its own SQLite. Rejected for the rule layer because palace already does this better — semantic search, KG triples, cross-wing recall — and reusing it keeps memory infrastructure unified. The Anthropic memory tool may still be useful for *session-scoped* working memory inside `wi-chat`, but that's a separate decision.

### Alt 5 — Just inject `.claude/rules/persona.md` into the analyzer's cached system block

Lightweight version: skip extraction, skip palace, skip everything. Maaz hand-writes a rules file when he notices a recurring miss. The analyzer caches it.

This is the right *fallback* and we keep the door open for it (rules promoted via the UI can also export to `.claude/rules/persona.md` for portability), but it doesn't address the discovery problem — Maaz has to *notice* the miss and *write* the rule. The whole point of the system is to surface candidates he hasn't noticed yet.

---

## Open questions

Each question carries a **target phase** for resolution and an owner field. ADR-030's pattern: questions left dangling at "Accepted" status block the merge.

| # | Question | Resolve before | Owner | Detail |
|---|---|---|---|---|
| 1 | GraphQL vs REST for PR review-threads ingestion | 77a planning | TBD | GraphQL `pullRequest.reviewThreads` gives `isResolved`+`isOutdated`+threading in one round-trip. REST needs 2-3 calls.  enterprise GitHub MCP exposes `pull_request_read` (REST-shaped). Need to confirm GraphQL pass-through availability; if absent, ingestion uses REST + `position == null` heuristic for outdated detection. |
| 2 | First-run backfill window | 77a planning | TBD | 30 / 90 / 1 year / 5 years? 30 is safe (low rate-limit risk); 5 years gives the richest cluster signal but takes 1-2 hours and may exceed secondary rate limits on  GHES. **Recommendation:** 30 days for first run; explicit `POST /api/persona/backfill?days=N` to expand later per-quarter. |
| 3 | Cluster size threshold | 77b planning | TBD | Default `size >= 3 AND mixed_author = true`. For low PR traffic, may surface < 5 candidates total. Drop to `size >= 2` for first pass? (Risk: more single-reviewer pet peeves promoted.) **Recommendation:** start at 3 + mixed-author; relax only if data justifies. |
| 4 | Citation parser robustness | 77c | TBD | Resolved in this ADR revision: fuzzy-match fallback (cosine compare model reasoning vs active rule body) is in scope for 77c, NOT deferred. See Failure modes "Citation-parser fragility silently retires useful rules". |
| 5 | Rule export to `.claude/rules/persona/` | 77d (optional) | TBD | When a rule is promoted, optionally also write a file `.claude/rules/persona/<rule_id>.md` for git visibility + cross-machine portability. **Recommendation:** add as 77d optional task; default off behind `PERSONA_EXPORT_TO_FS=0`. |
| 6 | Per-PR-author scoping | Phase 77+1 (deferred) | TBD | Mine PRs Maaz reviewed (not just authored) so persona captures his reviewing voice. Useful for `wi-pr-review` self-consistency. **Recommendation:** explicitly out of scope for Phase 77; revisit after one quarter of soak. |
| 7 | Palace MCP `kind` parameter | 77c | TBD | `palace.search()` needs a `kind` filter to scope recall to `kind='rule'` only. If upstream MemPalace MCP doesn't expose it yet, the wrapper falls back to client-side filtering (load drawer body, regex `kind:` in YAML). Slower but works. Track whether to upstream a contribution. |

---

## Recorded brain self-decision (2026-06-02)

When this ADR was first drafted, the question "should WI build the persona memory loop?" was put to the brain via `POST /api/brain/decide`. The brain's structured output is preserved here for honesty:

> **Decision id:** `dec_5CBB6AF22D7F4788A384F9832F`
>
> **Decision:** *Defer building the full persona memory loop; instead, ship a thin v0 that only logs PR review comments + accept/reject diff outcomes into the existing Palace memory store behind a feature flag, and revisit scope after Saturn-93's 43-day backlog is triaged.*
>
> **Rationale:** *The sprint is 43 days overdue with 40+ stuck tickets and 4 open investigations already failing to reach root cause within budget. Committing to a four-source learning loop now adds a complex new system on top of an unhealthy backlog and unclustered noise. A logging-only v0 captures the training signal cheaply so a richer loop can be justified later with real data, rather than designed speculatively.*
>
> **Confidence:** 0.62
> **Outcome:** pending

**This ADR overrides the brain's recommendation.** The brain advised "thin v0, log only, defer richer scope." This ADR ships a 4-phase build with Tier 0 parsers, canonical-prose pre-fill, a UI page, a recall-fan-out extension, a verifier adapter, and a nightly consolidator. That is materially richer than "log only."

**Justification for the override:** Tier 0 parses already-mechanically-enforced configs (lint, tsconfig, opt-in `@enforces` types). The cost of getting it wrong is bounded — rules retire automatically when the source rule is removed (§ Phase 77a, "Output of every parser pass... removed rules → tagged `retired`"). Day-zero coverage matters because PR traffic is low: a "log only" v0 might surface zero useful Tier 1 candidates for the first 4-6 weeks while the user sees no value.

**Override evaluation gate.** The override will be evaluated against this brain decision's outcome at end of Phase 77a:

- If Tier 0 parsers consume more than 1.5 weeks of engineering time, the brain was right — record outcome `failed` against `dec_5CBB6AF22D7F4788A384F9832F`, scope down 77b.
- If Tier 0 ships in budget AND surfaces meaningful day-one rules, override was correct — record outcome `success`.
- If Tier 0 ships in budget BUT produces noisy rules requiring constant retirement, mixed — record outcome `mixed` and re-spec 77b.

Either way the brain's decision and this ADR's override both get a verdict, recorded in `brain_decisions.outcome` per the existing learning loop.

---

## Consequences

### Positive

- **Closes the user's stated pain.** PRs stop accumulating the same review comments. WI's review skill catches the recurring patterns reviewers flag.
- **Three of five existing brain consumers gain persona memory free.** BugInvestigatorAgent, BugResolverAgent, and `wi-investigate` already call the brain — they benefit on day one of Phase 77c shipping (where the recall fan-out is extended) with zero per-consumer code changes. `wi-pr-review` and the web-UI chat handler need a one-time ~10–15 line routing swap each in 77c — small but real, called out honestly. Tier 0 rules are visible in `/setup/persona` from day 77a; injection at recall time waits until 77c.
- **One memory architecture, not two.** Persona memory becomes the third instance of the same pattern (signals → stage → gate → palace → recall) used by investigations and the bug loop. Reduces conceptual surface.
- **Auditable.** Every promoted rule has `evidence_json` with PR/Jira/bug references. Every `recall_memory` call goes through `brain_user_budget_ledger`. No bypass paths.
- **Differentiated.** Grounded in inbound human PR review comments + post-merge regression linkage — signals nobody else (Cursor, Copilot, CodeRabbit, Greptile) ingests in the same shape.
- **Low cost.** Cached persona summary + top-5 RAG = ~$0.006 per review on Opus 4.8 with caching. Weekly Haiku batch ≈ $0.08/week. Under 10% of total review cost.
- **Failure-mode-honest.** Stale detection auto, contradiction check at promotion, hard recall caps, MINJA mitigation, quarterly audit reminder all built in.

### Negative

- **Cold-start awkwardness mitigated by Tier 0.** Phase 77a now produces a populated rule book on day one (parsed lint/tsconfig/ADRs/prose docs). The cold-start period is now confined to Tier 1: Phase 77b's first cron may surface zero candidates if PR traffic is low, but the persona system already has substance from canonical sources. Worst case, Phase 77b is delayed and the system runs on Tier 0 alone for a quarter — still a win over today's "no memory at all".
- **Propose-then-approve has friction.** Maaz has to click Promote occasionally. Cursor, CodeRabbit, etc all show this is acceptable, but it's not zero-touch.
- **Citation parsing fragility.** If the model declines to cite rule_ids, `applied_count` doesn't increment and the rule's signal-of-usefulness goes dark. Mitigation: open question 4 — fuzzy fallback.
- **Squash-merge edge cases.**  example-service uses squash-merge for some PRs. The (comment, before, after) triple extraction loses fidelity in those cases; we fall back to comment-time-vs-merged-HEAD diff.
- **GraphQL adoption pressure.** Best ingestion path uses GraphQL; existing GitHub MCP wraps REST. Either we bring a GraphQL passthrough into `GitHubMcpClient` or we accept some signal loss on the REST-only path. Open question 1.
- **Coupling to brain.** If the Brain has an outage or returns degraded results, persona-aware features degrade with it. Same risk as ADR-024 generally, just extended to one more consumer.

### Neutral

- **Data growth.** `pr_review_comments` for 5 years of typical engineering PRs ≈ 7,500 rows × ~2KB each ≈ 15MB. `lessons_learned` and `code_diff_outcomes` are smaller. Negligible vs the existing 287 MB SQLite.
- **No new model_config bucket.** Reuses `agents` bucket for the cron. `decide` bucket already covers the brain calls.

---

## Implementation status

| Component | Tier | State | Owner | Phase | Notes |
|---|---|---|---|---|---|
| Schema v57 (4 tables incl. `persona_rule_snapshots`) | — | Not started | TBD | 77a | Migration + smoke § 17a/b/c/d/e |
| `parsers/parse-eslint.ts` | T0 | Not started | TBD | 77a | One drawer per active lint rule; degraded mode for repos sans `node_modules` |
| `parsers/parse-tsconfig.ts` | T0 | Not started | TBD | 77a | Strict-family flags → rules |
| `parsers/parse-type-helpers.ts` | T0 | Not started | TBD | 77a | Explicit `@enforces` JSDoc tag only; uses TS compiler API |
| `canonical-prose-extractor.ts` | T1.0 | Not started | TBD | 77a | Pre-fills `lessons_learned` with `source_kind='canonical_prose'`; ADR + prose docs in trusted repos |
| `persona_rule_snapshots` write path | both | Not started | TBD | 77a | SQL-side mirror; survives `palace:rebuild` |
| `replayPersonaRules()` boot hook | both | Not started | TBD | 77a | Detects palace-vs-SQL drift; re-emits drawers from SQL snapshots |
| Tier 0 file watcher (dev) + cron (prod) | T0 | Not started | TBD | 77a | 6h cron; idempotent re-emit |
| `GitHubMcpClient.getReviewComments` | T1 | Not started | TBD | 77a | Wraps existing `pull_request_read` MCP method |
| `GitHubMcpClient.getReviewThreads` | T1 | Not started | TBD | 77a | GraphQL passthrough; open question 1 |
| `pr-review-ingest.ts` (Process stage) | T1 | Not started | TBD | 77a | Daily cron + backfill |
| `code_diff_outcomes` write hooks | T1 | Not started | TBD | 77a | In `wi-pr-review` and `wi-chat` |
| 7-day-delay outcome verifier | T1 | Not started | TBD | 77d | Cron job |
| `AIAnalyzer.extractReviewLesson` | T1 | Not started | TBD | 77b | Uses `agents` bucket (Haiku) |
| `MemoryEnricher.enrichLessonCandidate` | T1 | Not started | TBD | 77b | Writes to `reviews` wing |
| `MemoryEnricher.enrichRuleApplication` | both | Not started | TBD | 77c | In-place YAML edit + re-emit |
| Palace `reviews` wing | both | Not started | TBD | 77a | Drawer-based; T0 writes from day one |
| `/setup/persona` UI | both | Not started | TBD | 77b | React; 3 tabs (Active populated by 77a) |
| `POST /api/brain/learn` extension | T1 | Not started | TBD | 77b | New verbs `promote_lesson` / `dismiss_lesson` |
| `recall_memory` extension | both | Not started | TBD | 77c | Wing list, kind filter, activation filter, tier-aware ranking |
| `verify_claim` `pr_review` adapter | T1 | Not started | TBD | 77c | New verifier |
| `wi-pr-review` skill swap | both | Not started | TBD | 77c | ~10 line change |
| `wi-pr-review` skill swap | both | Not started | TBD | 77c | ~10–15 line server-side routing change to call `brain.getDecision` |
| `/api/chat` handler swap (web-UI ChatPanel) | both | Not started | TBD | 77c | ~10–15 line change in `web-server.js`; gated by existing classifier |
| Citation parser | both | Not started | TBD | 77c | Bumps `applied_count` on cited drawers; cosine-fallback for paraphrased citations |
| Nightly consolidation cron (registered as ticking agent) | T1 | Not started | TBD | 77d | Cluster + decay + stale detection; reuses BugInvestigatorAgent shape |
| Quarterly audit reminder | both | Not started | TBD | 77d | `wi-morning-brief` slot, gated on `PERSONA_AUDIT_DAYS` |
| Smoke § 17a (Tier 0 parsers + 200-tok cap) | T0 | Not started | TBD | 77a | |
| Smoke § 17b (Tier 1 ingestion) | T1 | Not started | TBD | 77a | |
| Smoke § 17c (canonical-prose extractor) | T1.0 | Not started | TBD | 77a | |
| Smoke § 17d (palace-rebuild durability) | both | Not started | TBD | 77a | |
| Smoke § 17e (Hard rule 7 grep enforcement) | both | Not started | TBD | 77a | |
| Smoke § 18 (extraction + promotion) | T1 | Not started | TBD | 77b | |
| Smoke § 19 (injection + citation + cosine fallback) | both | Not started | TBD | 77c | |
| Smoke § 20 (consolidation dry-run) | T1 | Not started | TBD | 77d | |

## Smoke tests (per ADR-027 v2 expectation)

Each phase ends with a smoke test extension that fails the day before the phase ships and passes after. Names and skeletons:

- **§ 17a — Tier 0 parsers** (Phase 77a)
  - Each parser produces ≥ N rule drawers on a fresh WI install (N varies per parser; ESLint config of WI itself yields ~30+)
  - Rules carry tier=`canonical` and source markers (`lint:`, `tsconfig:`, `type:`)
  - Removing a rule from `eslint.config.js` and re-running the parser retires the corresponding palace drawer (status='retired', reason='source_removed')
  - **No drawer in the `reviews` wing exceeds 200 tokens** (Hard rule 4 enforcement)
  - Degraded-mode parser run on `./repos/example-service/` flags emitted drawers with `degraded_resolution=true` (per the open-question 1 fallback)
- **§ 17b — Tier 1 ingestion** (Phase 77a)
  - `pr_review_comments` row count rises by ≥ N for a known authored PR after backfill
  - `code_diff_outcomes` row count rises by 1 after a manual chat suggestion is dispatched through `/api/chat`
  - Bot comments are filtered out (zero rows where `is_bot = 1` enter `lessons_learned`)
  - Feature flag honored: with `PERSONA_MEMORY_INGEST_ENABLED=0`, no rows written
- **§ 17c — canonical-prose extractor** (Phase 77a)
  - WI's own `CLAUDE.md` + `.claude/rules/*.md` produce ≥ N `lessons_learned` rows with `source_kind='canonical_prose'`
  - Bulk-promote API (`POST /api/brain/learn { verb: 'promote_lessons_bulk', source_kind: 'canonical_prose', repo_filter }`) ratifies them all in one call; corresponding `persona_rule_snapshots` rows materialize
  - `extractor_prompt_hash` ensures rerunning the extractor on the same input produces zero new candidates (idempotent)
- **§ 17d — palace-rebuild durability** (Phase 77a)
  - Promote a rule, kill the palace process, run `npm run palace:rebuild`, restart palace
  - `recall_memory` for the rule's pattern returns the rule (re-emitted from `persona_rule_snapshots` by the boot hook)
  - `applied_count` is preserved across rebuild
- **§ 17e — Hard rule 7 enforcement** (Phase 77a)
  - `grep -rE '(SELECT|UPDATE|INSERT|DELETE)\s+(FROM|INTO)\s+(pr_review_comments|lessons_learned|code_diff_outcomes|persona_rule_snapshots)' src/tools/ src/services/` — excluding `src/services/brain/` and `src/services/persona/` — finds zero matches
  - Smoke fails if any non-persona, non-brain code touches the new tables directly
- **§ 18 — extraction + promotion** (Phase 77b)
  - Synthetic cluster of 3 mixed-author comments produces exactly 1 lesson_candidate after the cron runs
  - `POST /api/brain/learn` with `verb='promote_lesson'` writes a drawer to the `reviews` wing with `kind='rule'` AND mirrors to `persona_rule_snapshots`
  - `lessons_learned.status` flips to `'promoted'`; `promoted_to_rule_id` is set
  - Dismissal records the dismissal reason in `lessons_learned`
  - Contradiction check at promotion: attempting to promote a lesson whose embedding cosine > 0.92 with an existing active rule surfaces a conflict-resolution prompt
- **§ 19 — injection + citation + cosine fallback** (Phase 77c)
  - With one known-active rule scoped to `src/services/**/*.ts`, a PR review of a synthetic diff in that path includes the rule_id in evidence returned by `brain.getDecision`
  - The model's response cites the rule_id verbatim; `applied_count` on the `persona_rule_snapshots` row increments by 1 (atomic SQL UPDATE)
  - **Cosine fallback:** when the model paraphrases the rule without citing the id, but the response cosine-matches the rule body above τ, `applied_count` still increments
  - Subsequent `recall_memory` for the same pattern ranks the rule first per the `tier_weight × source_weight × recency_factor` formula
- **§ 20 — consolidation dry-run** (Phase 77d)
  - Dry-run on a synthetic dataset of 10 rules produces:
    - 2 retired (zero applied, > `PERSONA_AUDIT_DAYS` old, not canonical, NOT recently recalled)
    - 1 stale (refuted/total > 0.3)
    - 1 conflict surfaced (cosine > 0.92 to another rule)
  - **Crucially:** a rule with `applied_count=0` BUT `last_recalled_at < 60d ago` is NOT retired (citation-fragility mitigation)
  - No live writes when `--dry-run` is passed
- **§ 20a — Tier-0 supersession (Hard rule 8 enforcement)** (Phase 77d)
  - Synthetic dataset: 1 Tier-0 rule "no `any`" (source=`tsconfig:noImplicitAny`) + 1 Tier-1 rule "never use the `any` type" (status='active', cosine ≈ 0.97, identical normalised rule_text)
  - Run consolidator dry-run; assert: Tier-1 rule's status flips to 'retired', `superseded_by_rule_id` matches the Tier-0 `rule_id`, `retired_reason='superseded_by_tier0'`
  - Tier-0 rule unchanged. No user prompt is generated (this is the unattended path)
  - Soft-adjacent control case: 1 Tier-0 "no `any`" + 1 Tier-1 "always type your function returns" (cosine ≈ 0.85, different normalised text). Assert: NOT retired by § 20a path; falls through to the same-tier contradiction path (which shouldn't fire either, since they're different tiers — both stay active)
- **§ 20b — Recall excludes superseded rules** (Phase 77d)
  - With the § 20a state in place, `recall_memory` for a query about `any` returns only the Tier-0 rule
  - The retired Tier-1 rule is in `persona_rule_snapshots` (audit) but not in palace `reviews` wing recall results

---

## References

### Production tools surveyed
- [Cursor Rules](https://cursor.com/docs/context/rules) — frontmatter + globs, 4-mode activation
- [Claude Code Memory](https://code.claude.com/docs/en/memory) — two-tier separation, 200-line cap on the index
- [Anthropic Memory Tool](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/memory-tool) — `memory_20250818` primitive
- [Aider conventions](https://aider.chat/docs/usage/conventions.html) — read-only + prompt caching pattern
- [GitHub Copilot custom instructions](https://docs.github.com/en/copilot/concepts/response-customization)
- [CodeRabbit Learnings](https://docs.coderabbit.ai/integrations/learnings) — closest production analog
- [AGENTS.md community spec](https://agents.md/) — cross-tool rule format

### Foundational papers
- [ReasoningBank (Google 2025, arXiv 2509.25140)](https://arxiv.org/abs/2509.25140) — contrastive memory items, MaTTS
- [MemGPT (Packer et al., arXiv 2310.08560)](https://arxiv.org/abs/2310.08560) — memory as virtual paging
- [Voyager (Wang et al., arXiv 2305.16291)](https://arxiv.org/abs/2305.16291) — skill library + LLM-as-critic gate
- [Generative Agents (Park et al., arXiv 2304.03442)](https://arxiv.org/abs/2304.03442) — recency × importance × relevance scoring
- [CoALA (Sumers et al., arXiv 2309.02427)](https://arxiv.org/abs/2309.02427) — 4-tier memory taxonomy
- [Reflexion (Shinn et al., arXiv 2303.11366)](https://arxiv.org/abs/2303.11366) — verbal RL feedback loop
- [CRITIC (Gou et al., ICLR 2024, arXiv 2305.11738)](https://arxiv.org/abs/2305.11738) — external verifier required
- [Letta sleep-time compute (arXiv 2504.13171)](https://arxiv.org/abs/2504.13171) — episodic→semantic consolidation
- [Constitutional AI (Bai et al., arXiv 2212.08073)](https://arxiv.org/abs/2212.08073) — principle-anchored behavior
- [Deliberative Alignment (Guan et al., arXiv 2412.16339)](https://arxiv.org/abs/2412.16339) — cite-the-spec at inference

### Code-review-specific research
- [Tufano et al. *Towards Automating Code Review*, ICSE 2021, arXiv 2101.02518](https://arxiv.org/abs/2101.02518) — canonical (comment, before, after) triple recipe
- [CodeReviewer (Microsoft, arXiv 2203.09095)](https://arxiv.org/abs/2203.09095) — multilingual diff+review dataset
- [AutoCommenter (Google, arXiv 2405.13565)](https://arxiv.org/abs/2405.13565) — production team-style learning architecture
- [Tufano *Code Review Automation Strengths and Weaknesses*, arXiv 2401.05136](https://arxiv.org/abs/2401.05136) — empirical taxonomy of fix types
- [Tufano SLR 2025, arXiv 2503.09510](https://arxiv.org/abs/2503.09510) — current state of the field
- [Google eng-practices "What to look for in a code review"](https://google.github.io/eng-practices/review/reviewer/looking-for.html)

### Failure modes
- [Chroma Context Rot research](https://www.trychroma.com/research/context-rot)
- [LongMemEval (Wu et al., arXiv 2410.10813)](https://arxiv.org/abs/2410.10813)
- [MINJA Memory Injection (Dong et al., arXiv 2503.03704)](https://arxiv.org/abs/2503.03704)

### Anthropic engineering
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Prompt caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)

### GitHub data shape
- [`/pulls/{n}/comments` REST](https://docs.github.com/en/rest/pulls/comments)
- [`/pulls/{n}/reviews` REST](https://docs.github.com/en/rest/pulls/reviews)
- GraphQL `PullRequestReviewThread` with `isResolved`, `isOutdated`, `resolvedBy`

### Internal cross-references
- [ADR-014: Self-learning investigation brain](./adr-014-self-learning-investigation-brain.md) — same pattern, applied to investigations
- [ADR-015: MemPalace integration](./adr-015-mempalace-integration.md) — palace primitives this ADR extends with a 7th wing
- [ADR-016: Second brain architecture](./adr-016-second-brain-architecture.md) — recall-augmented chat foundation
- [ADR-024: Unified Brain](./adr-024-unified-brain.md) — every consumer this ADR's persona memory flows through
- [ADR-030: Self-healing bug loop](./adr-030-self-healing-bug-loop.md) — same `record_outcome → MemoryEnricher → palace` pattern, applied to bugs
- [ADR-031: Per-bucket model+effort config](./adr-031-per-bucket-model-effort-config.md) — `agents` bucket reused for the cron
- Original research synthesis: `research-output/wi-persona-memory-design.md` (parallel-layer first sketch, superseded by this ADR)

---

*End of ADR-032.*
