---
sidebar_label: "ADR-037.5: CAP-13 (Plan-Shape Self-Extension)"
sidebar_position: 37.5
title: "ADR-037.5: CAP-13 — Plan-Shape Self-Extension (α-LITE first, FULL deferred)"
status: Accepted (α-LITE shipped 2026-06-25; α-FULL deferred per D2)
date: 2026-06-24
---

# ADR-037.5: CAP-13 — Plan-Shape Self-Extension

**Status:** **Accepted (α-LITE shipped 2026-06-25; α-FULL deferred per D2).** Originally Proposed v1 2026-06-24, then invalidated within 90 minutes by an adversarial audit (`.planning/audits/2026-06-24-adr-037-5-audit.md` § F2: the loop has no skill-ranking step, so v1's D1 was structurally impossible). Rewritten as v2 against **option α** from the redesign workflow at `.planning/cap-13-redesign/SYNTHESIS.md` — reframe CAP-13 around **plan shapes**, not skills. α-LITE shipped end-to-end on 2026-06-25 across five atomic commits (`ab71dd7` loop integration, `5528f87` endpoint, `5631e04` 41 unit tests, `a02387d` smoke § 25, `be64d74` ADR-038 D8 + ADR-034 L4 cross-doc patches, `327ada2` CLAUDE.md env-var docs). Smoke ratchets 104 → 108. The substrate prerequisite — the `loop.ts:624` empty-hash bug that left 737/737 production sessions with `prior_count=0` — was fixed first in `c26a89f` with 6 regression tests. α-FULL (drafter + lifecycle) remains explicitly deferred per D2; un-defer trigger is documented as `≥ 50 plan_shape_gap_observed rows × ≥ 3 distinct plan_shape_hash × ≥ 75% non-smoke`.

**Companion docs:**

- [ADR-037](./adr-037-cypher-tool-use-loop.md) — the loop architecture this design is anchored against; Phase 7 (deleting `run.ts` 2026-07-21) is the deadline by which the pipeline's skill abstraction disappears entirely.
- [ADR-038](./adr-038-cypher-v2.5-production-grade.md) D8 (Self-model) — re-pointed to consume `plan_shape_gap_observed` instead of the pipeline-era `skill_gap_observed`. Patched in the same commit as this ADR rewrite.
- [ADR-034](./adr-034-cypher-learning-autonomy-engine.md) L4 (Self-evolution detector) — same re-pointing.
- [ADR-033](./adr-033-cypher-framework.md) § Decision § 10 — the original "Cypher writes Cypher" framing. v2 explicitly **downgrades** the strong form of this framing; CAP-13-LITE doesn't write Cypher — it notices gaps.

**Prerequisites (both shipped 2026-06-24, ahead of this ADR):**

- `getEffectivePriors` in `src/services/cypher/learn.ts` — commit `f330069` / merge `575cdba`. Forward-looking reader; vestigial for the α path (α doesn't read `skill_priors`).
- `loop.ts:624` posterior-read fix — commit `e18f1d4` / merge `c26a89f`. The substrate prerequisite. Pre-fix, `snapshotPriors` was called with an empty plan_shape_hash, so 737/737 production sessions had `prior_count=0`. Post-fix, the post-loop write uses the real hash. **Without this fix α-LITE would write opportunistically against zero-prior rows forever.**

---

## Context

### Why CAP-13 still matters

[ADR-033 § Decision § 10](./adr-033-cypher-framework.md) introduced **CAP-13 — self-extension**: when Cypher's catalog has a gap, it proposes a patch (skill, tool, posture variant) for human review. The original framing was *"Cypher writes Cypher"* — agentic self-improvement.

The 2026-06-14 spike (`.planning/spikes/2026-06-14-cap-13-original/`) implemented this against the v1.4 9-stage pipeline. The pipeline's `investigate` stage picked a `chosen_skill` per dispatch; `skill_priors` accumulated Beta posteriors per `(skill, task_class)`; CAP-13 fired when the top-ranked skill's posterior mean dropped below 0.3.

The loop (ADR-037, cutover 2026-06-23) deliberately dissolved the "skill" concept. The loop picks tools via tool-use at every iteration; the posterior unit is `plan_shape_hash` (`(posture, ordered_tool_sequence)`), not `(skill, task_class)`. Phase 7 (2026-07-21) deletes `run.ts` and the entire skill-ranking layer that fed it.

**The architectural truth (verified by audit):**

| Concept | Pipeline (EOL 2026-07-21) | Loop (current) |
|---|---|---|
| `chosen_skill` | Set by `investigate` stage | Never set |
| `skill_priors` | Read by ranker, written by `recordSkillOutcome` | Never read or written |
| Decision unit | Skill (single output) | Tool calls (multiple per dispatch) |
| Posterior signal | Per-`(skill, task_class)` Beta | Per-`(user, plan_shape_hash)` historical rate |

CAP-13 in the form the spike envisioned cannot survive the loop. v1 of this ADR pretended otherwise. v2 acknowledges the mismatch and rebuilds CAP-13 against the loop's actual posterior model.

### What changes architecturally

| Spike concept (pipeline-era) | v2 concept (loop-era) |
|---|---|
| `skill_gap_observed` table | **`plan_shape_gap_observed` table** (new) |
| `chosen_skill` per session | `plan_shape_hash` per session (already populated post-fix) |
| `skill_priors.mean < 0.3` gate | **`cypher_sessions.prior_success_rate < 0.3 AND prior_count >= 5`** gate |
| `clusterGaps()` by task_class | Cluster by `plan_shape_hash` (later — α-FULL only) |
| `draftProposal()` → SKILL.md | **Undefined** — α-FULL's hard problem; deferred indefinitely |
| `promoteProposal()` → live skill | Undefined for v2; deferred to α-FULL |

### What "Cypher writes Cypher" becomes

The strong form of ADR-033 § 10 — *"Cypher drafts new SKILL.md + minimal implementation + tests, runs typecheck + smoke locally, files a `skill_proposals` row, Human [Promote] activates"* — does not survive v2. Three reasons:

1. **Plan shapes aren't skills.** A low-success plan_shape doesn't tell you what's missing — it tells you what's there doesn't work. The intervention category is ambiguous: it could be a new tool, a new posture filter, a new system-prompt rule, or a rephrased goal.
2. **The drafter has no canonical output type.** SKILL.md was the drafter's target in the spike. In the loop, what would the drafter produce? A tool? A posture? A prompt addendum? The answer requires data we don't have yet.
3. **The corpus is empty.** At the time of writing, 17 distinct `plan_shape_hash` values exist across 737 sessions; exactly one has ≥5 runs and it's the discipline-curl smoke fixture. The threshold cannot be tuned against this data.

**v2's honest framing:** *"Cypher notices its catalog's plan-shape gaps."* No drafter. No proposal lifecycle. Just observation. The strong "Cypher writes Cypher" framing is **preserved as a future possibility** — it can be revived in α-FULL if and when the corpus argues for it — but it is no longer load-bearing for any other ADR.

---

## Decision

### D1 — Ship CAP-13-LITE only

α-LITE = recognition only. No drafting, no proposals table, no HTTP endpoints for proposals lifecycle. The shipped surface is:

- **A new table** `plan_shape_gap_observed` (schema v69) that captures observed catalog gaps.
- **A recognition hook** in `loop.ts` that opportunistically writes a row when a completed dispatch's `(plan_shape_hash, user)` posterior is below threshold.
- **A read-only listing endpoint** `GET /api/cypher/plan-shape-gaps` for the corpus-inspection UI.
- **Env-var gates** for kill-switch + threshold tuning.

### D2 — α-FULL is explicitly deferred

The full proposal lifecycle (clusterGaps → draftProposal → createProposal → runVerify → promoteProposal) is NOT shipped under this ADR. Rationale (from the workflow synthesis):

> *"α-FULL requires committing to one intervention category for v1. Picking the wrong one (e.g. 'tool addition' when most gaps are actually 'tool ordering hints') sinks the effort. The data to decide isn't available until α-LITE has soaked."*

**Un-defer trigger for α-FULL:** `plan_shape_gap_observed` accumulates ≥ 50 rows across ≥ 3 distinct plan_shape_hash values on real (non-smoke) traffic. When that condition fires, a follow-up ADR (or an extension of this one) ratifies α-FULL's drafter target.

### D3 — Recognition hook fires post-loop, opportunistically

Insertion point: `src/services/cypher/loop.ts`, immediately after the post-loop UPDATE that persists `plan_shape_hash` + priors (the same UPDATE introduced by the 2026-06-24 substrate fix at commit `e18f1d4`). At that point in the loop, the authoritative `(plan_shape_hash, prior_count, prior_success_rate)` tuple is in scope.

Pseudocode:

```typescript
// After: opts.db.prepare('UPDATE cypher_sessions SET plan_shape_hash = ?, …').run(…)
if (
  priorsAtCompletion.prior_count >= GAP_MIN_RUNS &&        // default 5
  priorsAtCompletion.prior_success_rate !== null &&
  priorsAtCompletion.prior_success_rate < GAP_THRESHOLD && // default 0.3
  !isSmokeUser(opts.user) &&
  !isSmokeProbe(opts.goal)
) {
  try {
    insertPlanShapeGapObserved(opts.db, { … });
  } catch (err) {
    process.stderr.write(`[cypher-cap13-lite] gap-observe write failed (non-fatal): ${err.message}\n`);
  }
}
```

**Hard rules for the hook:**

- **Opportunistic.** A write failure must not crash the loop. `try/catch` swallow with stderr log.
- **Off the hot path.** No additional model call, no additional DB read beyond the insert. Pure SQL write.
- **Idempotent on `(session_id, plan_shape_hash)`.** A UNIQUE constraint prevents double-writes if the hook somehow fires twice for the same dispatch.
- **Smoke exclusion.** `isSmokeUser` checks `opts.user IN ('smoke', 'system')`. `isSmokeProbe` checks `opts.goal LIKE '%smoke%' OR opts.goal LIKE '%probe%' OR opts.goal LIKE '%sanity%' OR opts.goal LIKE '%phase 5 day-0%'`. Both filters acknowledged as fragile-v1 per audit F6; replace with a dedicated `cypher_sessions.is_smoke_probe BOOLEAN` column in v2 if the corpus is polluted.

### D4 — Schema v69 — `plan_shape_gap_observed`

```sql
CREATE TABLE plan_shape_gap_observed (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT    NOT NULL,
  plan_shape_hash       TEXT    NOT NULL,
  posture               TEXT    NOT NULL,
  tool_sequence_json    TEXT    NOT NULL,    -- JSON array of tool names invoked
  goal                  TEXT    NOT NULL,    -- truncated to 500 chars
  user                  TEXT    NOT NULL,
  prior_count           INTEGER NOT NULL,
  prior_success_rate    REAL    NOT NULL,
  iterations            INTEGER NOT NULL,    -- tool_calls.length on the failing dispatch
  verdict               TEXT    NOT NULL,    -- the dispatch's loop verdict
  status                TEXT    NOT NULL DEFAULT 'observed'
                          CHECK(status IN ('observed','reviewed','acted_on','dismissed')),
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  reviewed_at           TEXT,
  reviewed_by           TEXT,
  reviewer_note         TEXT,
  UNIQUE(session_id, plan_shape_hash),       -- idempotency key
  FOREIGN KEY (session_id) REFERENCES cypher_sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX idx_plan_shape_gap_observed_status_shape
  ON plan_shape_gap_observed(status, plan_shape_hash, created_at);
```

**Schema notes:**

- `goal` truncated to 500 chars at write time. The migration enforces no constraint; the application layer truncates. The goal is human-readable context for review, not load-bearing identifier.
- `tool_sequence_json` is the same sequence that fed `planShapeHash`. Captured here for human review without joining back to a derived structure.
- `prior_count` / `prior_success_rate` snapshot at the time of recognition. Subsequent posterior updates do NOT propagate.
- `status` is intentionally not a state machine yet — α-LITE only writes `'observed'`. The other values are reserved for α-FULL's lifecycle.

### D5 — HTTP read surface

One route: `GET /api/cypher/plan-shape-gaps`. Returns paginated rows from `plan_shape_gap_observed`. Optional query params: `status=observed|reviewed|acted_on|dismissed`, `limit` (default 50, max 200), `offset`. No PII handling beyond the goal-truncation already done at write time.

No POST routes. α-FULL's lifecycle endpoints (`/draft`, `/verify`, `/promote`, `/reject`) are NOT added under this ADR.

### D6 — Env-var gates

| Var | Default | Purpose |
|---|---|---|
| `CAP13_LITE_ENABLED` | `'1'` (on) | Kill switch. Set to `'0'` to disable the recognition hook entirely. Bridge restart not required (the hook reads env at every fire). |
| `CAP13_GAP_THRESHOLD` | `'0.3'` | Posterior threshold below which the gate fires. Per audit F3, the 0.3 number is taken from the spike but is empirically untuned — the corpus needed to validate it is what α-LITE accumulates. |
| `CAP13_MIN_PRIORS_RUNS` | `'5'` | Minimum `prior_count` required for the gate to fire. Rejects newly-seen plan shapes with no historical signal. |

### D7 — Hard rules preserved from the spike (relevant ones)

These transfer despite the architectural shift:

- **Opportunistic write** — failure never blocks the loop.
- **No PII** — goal is truncated; no other free-text fields.
- **Single owner for writes** — only the loop writes to `plan_shape_gap_observed`. No HTTP endpoint, no other service.
- **Idempotent** — UNIQUE constraint enforces.

These do NOT transfer (specific to α-FULL, deferred):

- Sandbox at `skills/.proposals/` — no draft is produced.
- Rate-limit 2 drafts/hour — no drafter to limit.
- `draft_category='write'` warning — no draft category.
- LLM-drafter (CAP-13-DRAFTER-EVAL) — no LLM call.

---

## Consequences

### What ships

- Schema migration `v69_plan_shape_gap_observed.ts`.
- `src/services/cypher/loop.ts` recognition-hook insert + helper functions for env-gate reads and smoke-filter logic.
- `web-server.js` route handler for `GET /api/cypher/plan-shape-gaps`.
- Smoke section `§ ??` asserting hook fires correctly under both gate-pass and gate-fail conditions.
- Unit tests covering: env-disabled (kill switch), gate-pass (writes row), gate-fail at threshold (no write), gate-fail at min-runs (no write), smoke-exclusion (no write), failure mode (try/catch swallow), idempotency (UNIQUE).

### What dies

- The v1 of this ADR (preserved in `git log` only).
- The dependency from ADR-038 D8 to a skill-keyed CAP-13 — D8 re-pointed to `plan_shape_gap_observed` (and to direct aggregation of `cypher_sessions` posteriors) in the same commit as this ADR rewrite.
- The dependency from ADR-034 L4 to `skill_gap_observed` — L4 re-pointed similarly.

### What changes downstream

- ADR-038 D8 designs Self-model against `plan_shape_gap_observed` + `cypher_outcomes` aggregated by `(plan_shape_hash, task_class)`. D8 can now ratify without waiting for CAP-13's drafter.
- ADR-034 L4's nightly self-evolution detector becomes substrate-independent: clusters over `cypher_outcomes` by goal-text similarity AND `plan_shape_gap_observed` rows. Both inputs are queryable today.
- The 11 historical `skill_gap_observed` rows (from 2026-06-15 smoke fixtures) become orphaned. Not deleted, not queried, not load-bearing. Future cleanup as part of a Phase 7-adjacent purge.

### Risks

| Risk | Mitigation |
|---|---|
| The 0.3 threshold catches zero rows in production | Default to env-tunable; document that the threshold is empirically untuned at v1; surface gap-fire counts in `/api/system-health` so we can see whether the gate is firing too rarely / too often |
| Corpus stays sparse — α-LITE produces zero rows for weeks | Acknowledged. Un-defer trigger for α-FULL is `≥ 50 rows across ≥ 3 distinct plan_shape_hash`; if that never fires, α-FULL never ships, and that's an honest outcome. |
| Smoke exclusion's `LIKE` filter is fragile | Acknowledged per audit F6. Replace with a `cypher_sessions.is_smoke_probe BOOLEAN` column in a follow-up if pollution becomes a problem. |
| Recognition hook adds latency to the loop hot path | The hook is a single SQL INSERT + a wrapped try/catch. Worst-case latency ~5 ms. Smoke section asserts loop completion is unchanged. |
| α-LITE bit-rots because no consumer reads its corpus | Tasks #41 (this ADR) + #45 (ADR-038 D8 + ADR-034 L4 patches) explicitly wire downstream readers. If those don't materialize, α-LITE's value is just observability — defensible. |

### What this ADR does NOT decide

- α-FULL's drafter target (tool? posture? prompt rule? something else?). Deferred until corpus argues for it.
- α-FULL's promotion lifecycle (`drafted → verifying → verified → promoted | rejected`). Deferred.
- Whether `skill_priors` and `getEffectivePriors` (the work from CAP-12-FIX) ever get consumed. They stand on their own for historical analysis; α doesn't read them. If they bit-rot too, that's an ADR-040-class cleanup decision.
- Whether the strong-form "Cypher writes Cypher" narrative ever returns. v2 explicitly downgrades it; an α-FULL ratification could revive it.
- The fate of the 11 historical `skill_gap_observed` rows or the column itself on `cypher_sessions`. Pure orphan data; harmless.

---

## Open questions

1. **Should `plan_shape_gap_observed` get a `task_class` column?** The spike's `skill_gap_observed` carried it (computed from goal text via classifier). α-LITE could compute task_class at hook time too, but the classifier lives in `run.ts` (EOL 2026-07-21). If we want task_class, we either lift the classifier into a shared util or skip the field for v1. **Default: skip for v1; revisit if α-FULL needs it.**
2. **Should the gate require `verdict IN ('mixed', 'failed')`?** The current gate is shape-keyed; it would fire even for a `verdict='success'` dispatch whose plan_shape's historical rate is < 0.3. That's defensible (the rate is the load-bearing signal, not the per-dispatch verdict), but it's worth flagging. **Default: gate is shape-only; the verdict of the firing dispatch is recorded for review but doesn't gate.**
3. **What's the right `CAP13_GAP_THRESHOLD` once the corpus exists?** The spike's 0.3 was inherited untuned. Once `plan_shape_gap_observed` has 50+ rows we can tune; pre-tuning would be guessing.

---

## References

### Audit chain

- `.planning/audits/2026-06-24-adr-037-5-audit.md` — the adversarial audit that invalidated v1's D1
- `.planning/cap-13-redesign/SYNTHESIS.md` — workflow synthesis recommending α
- `.planning/cap-13-redesign/analysis-alpha.md` — full α analysis
- `.planning/cap-13-redesign/analysis-beta.md` — β analysis (rejected)
- `.planning/cap-13-redesign/analysis-gamma.md` — γ analysis (rejected after Maaz answered "yes" to specific gap pain)

### Spike (read-only reference)

- `.planning/spikes/2026-06-14-cap-13-original/` — 26 files, 14,346 LOC, README explains origin
- Source branch: `adr-032-blocker-fixes-and-prd` tip `bbb92a0` (2026-06-14)

### Prerequisites (already shipped)

- `f330069` — CAP-12-FIX `getEffectivePriors` (vestigial for α; useful for historical analysis)
- `e18f1d4` — loop.ts:624 substrate fix (mandatory; α-LITE writes against this fix's output)

### Related ADRs

- [ADR-033](./adr-033-cypher-framework.md) § 10 — original CAP-13 stake; strong-form framing downgraded by this ADR
- [ADR-034](./adr-034-cypher-learning-autonomy-engine.md) L4 — patched in the same commit
- [ADR-037](./adr-037-cypher-tool-use-loop.md) Phase 7 — deletion date 2026-07-21 makes pipeline-era CAP-13 architecturally impossible
- [ADR-038](./adr-038-cypher-v2.5-production-grade.md) D8 — Self-model; substrate dependency on this ADR explicit in the D8 section
