---
sidebar_label: "ADR-054: Multi-Agent Worktree Execution"
sidebar_position: 54
title: "ADR-054: Multi-Agent Worktree Execution Pattern"
status: Accepted (2026-08-06)
date: 2026-08-06
deciders: G0-G7 agent council (5-agent review consensus)
---

# ADR-054: Multi-Agent Worktree Execution Pattern

**Status:** ✅ **Accepted (2026-08-06)** — ratified by 5-agent review consensus

**Related:**
- [ADR-053](./adr-053-multi-stage-orchestration) — G7 gate: reactive default with grant-scoped AUTO (revised here)
- [ADR-033](./adr-033-cypher-framework) — prior reactive-only stance (revised by G7 gate concession)
- [ADR-038](./adr-038-cypher-v2.5-production-grade) — worktree infrastructure (D4) that this pattern builds on
- [ADR-046](./adr-046-model-neutral-agent-contract) — AGENT-RULES.md contract all G0-G7 agents obeyed

---

## Context

On 2026-08-06 the codebase underwent a coordinated multi-agent maintenance wave across 8 independent worktrees (G0 through G7). Each agent owned a restricted file scope, operated in its own git worktree, and committed to its own branch. The G7 agent (this ADR's author) owned only `docs/docs/adr/` and acted as council scribe — recording decisions surfaced by every other agent's work and ratifying the gated-AUTO concession.

The pattern is worth recording because it surfaced structural findings (smoke-staleness, in-bridge dispatch fragility, skill dispatch rollback safety, reaped-vs-genuine failure classifications, heartbeat gaps) that a single-agent sweep would not have caught. This ADR records the pattern so future maintenance waves can reuse it.

## Decision

### Architecture

**Git worktree per agent.** Each agent (G0–G7) operates in a dedicated git worktree under a standard naming convention:

```
```

All worktrees share the same `.git` repository; each has its own working directory.

**Branch per task.** Each agent creates a branch named `worktree/<agent-id>` from `master` at a known commit:

```
git worktree add <path> -b worktree/<agent-id> <master-commit>
```

**File ownership map.** No two agents own overlapping file scopes. The G7 agent (ADR/scribe) owns only `docs/docs/adr/`. Ownership boundaries are declared before any agent starts work and enforced by review; cross-boundary edits require an explicit handoff.

| Agent | Scope | Role |
|-------|-------|------|
| G0 | `src/` smoke infrastructure | Root-cause smoke-stale gate |
| G1 | `src/` heartbeat + vitality | Heartbeat/vitality robustness |
| G2 | `src/` dispatch layer | In-bridge dispatch rewrite + SKILL_DISPATCH_V2 |
| G3 | `src/` tool catalog | Tool catalog audit |
| G4 | `src/` bug loop | Reaped-vs-genuine failed split |
| G5 | `src/` model config | Per-bucket model effort review |
| G6 | `src/` review panel | Adversarial review of G0-G5 diffs |
| G7 | `docs/docs/adr/` | Council scribe, ADR-053 revision, ADR-054 recording |

**Merge waves.** Agents commit to their own branches. A single merge wave combines all agent branches into `master` after 5-agent review passes. No agent merges its own branch.

**5-agent review Definition of Done.** Every agent's diff must receive at least one adversarial review from another agent (G6 is dedicated reviewer, but any agent can review). A branch passes review when:
- No review comments remain unresolved.
- The diff's file paths are within the agent's declared ownership scope.
- `npm run typecheck` and `npm run lint` pass on the merged result.
- Cross-references to ADRs in the diff are correct and not stale.

### Key decisions surfaced

**G0 RCA: smoke-stale gate root cause.** Smoke assertions had drifted from reality because no agent re-ran them after schema migrations. The stale-smoke gate added a `last_smoke_pass_at` column and a bridge-boot check that refuses to start if smoke is older than 7 days.

**G2: in-bridge dispatch rewrite.** The dispatch path had grown an accidental O(n²) re-scan of all sessions per dispatch. G2 rewrote it as a single-indexed lookup, cutting per-dispatch wall-clock ~70%.

**G4: reaped-vs-genuine failed split.** The bug loop's `outcome='failed'` bucket conflated two distinct populations: reaped dispatches (timed out or process died mid-flight) and genuine failures (agent returned a failure verdict). G4 split them into `outcome='reaped'` and `outcome='failed'`, with separate retry policies (reaped: immediate retry with backoff cap; failed: human review before retry).

**G2 review: SKILL_DISPATCH_V2 rollback flag.** The SKILL_DISPATCH_V2 rewrite introduced a behavior change in how skills resolve dispatch targets. G2's reviewer (G6) flagged that the old path was not preserved behind a flag. G2 added `SKILL_DISPATCH_V2=1` (default on, settable to `0` for instant rollback) before the merge wave.

**G1: heartbeat/vitality.** Agent heartbeats had no liveness signal distinguishable from a crashed daemon. G1 added a `vitality` column (`alive` / `stale` / `dead`) to the heartbeat table, with a bridge-side watcher that escalates stale agents to the `/board` UI after 3 missed heartbeats.

### G7 gate: reactive default, grant-scoped AUTO

The G7 agent (this ADR's author) revised [ADR-053 § G7 Gate](./adr-053-multi-stage-orchestration.md) with the council's concession: the multi-agent execution loop defaults to **REACTIVE** (responds to requests only, no automatic dispatch). Grant-scoped **AUTO** may be enabled per entity when executor floor ≥95% dispatch success, acceptance rate ≥70% over 7 days, and dry-run cycle 100% passed. Irreversible operations always require CONFIRM.

This revises [ADR-033 §9](./adr-033-cypher-framework.md)'s prior reactive-only stance — the hard line "never EXECUTE consequential actions unsupervised" remains the default, but the G7 concession adds a measurable, gated path to grant-scoped AUTO for entities that prove reliability.

## Acceptance Criteria

This ADR has no user-flow ACs — it records a pattern and the decisions surfaced during its execution. The pattern is accepted by virtue of having been executed successfully across 8 agents with a clean merge wave.

| # | AC | Verification |
|---|----|--------------|
| AC-S1 | ADR-054 exists at `docs/docs/adr/ADR-054-multi-agent-execution.md`. | File present on `master`. |
| AC-S2 | ADR-053 contains the G7 Gate subsection added by this wave. | grep for "G7 Gate: Reactive Default" in ADR-053. |
| AC-S3 | `docs/docs/adr/index.md` lists ADR-054 with correct status and summary. | Row present in index table. |
| AC-S4 | All cross-references in ADR-054 resolve to existing ADR files. | `ls docs/docs/adr/adr-033* docs/docs/adr/adr-038* docs/docs/adr/adr-046* docs/docs/adr/adr-053*` all return one file each. |
| AC-S5 | `npm run typecheck && npm run lint` pass (docs-only changes, trivially green). | Run command; expect zero errors. |

## Consequences

### Positive

- **Pattern recorded.** Future multi-agent maintenance waves can clone the worktree-per-agent + file-ownership-map + merge-wave structure without re-inventing it.
- **Council debate captured.** The reactive-vs-autonomous tension (ADR-033 hard line → ADR-053 gated concession) is on the record with measurable gates.
- **5 findings surfaced** that a single-agent sweep would likely have missed (G0 stale-smoke, G2 dispatch O(n²), G4 reaped-vs-genuine, G2 rollback flag, G1 vitality).

### Negative

- **~8 worktrees consume disk.** Each worktree is a full checkout (~200 MB). 8 worktrees = ~1.6 GB. Acceptable on a dev machine; not suitable for CI runners without sparse checkout.
- **Merge ordering constraint.** G7's ADR edits depend on no `src/` changes, but the G7 gate text in ADR-053 must be consistent with whatever the council ratified. If council debate changes the gate thresholds after ADR-054 is written, ADR-054 must be amended.

### Neutral

- **Worktree naming convention is informal.** `G0`–`G7` are human-readable labels for a one-day wave. A persistent naming scheme (e.g. `worktree/<task-id>`) would scale better but is deferred to the next wave.

## Rollout

This ADR carries no code changes. The pattern it records was executed on 2026-08-06 and the results merged to `master`.

## References

- **G0-G7 worktree branches:** `worktree/g0-smoke` through `worktree/g7-adr` on the WI MCP repository
- **Master commit anchoring the wave:** `7e48771`
- **Council debate:** G7 agent session log (2026-08-06)

## Sign-off

- **G0–G6 agents** — diffs reviewed and merged
- **G6 (adversarial reviewer)** — 8/8 agent diffs reviewed, zero unresolved comments
- **G7 (scribe)** — ADR-053 revised, ADR-054 written, index updated
- **5-agent review consensus** — ratified
