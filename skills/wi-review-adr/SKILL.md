---
name: wi-review-adr
description: Multi-dimensional review of an ADR, PRD, or long-form design doc. Reads the target doc + its cross-referenced context files, produces a structured markdown review across N dimensions (default 8 — architectural soundness, AC coverage, testing discipline, doc-vs-code drift, threat model, cost model, rollout safety, meta-consistency). Read-only. Closes GAP-003 Tier 1 for review-shape /wi goals.
trigger_phrases:
  - "review this ADR"
  - "review this PRD"
  - "review this design doc"
  - "adr review"
  - "8-dimension review"
  - "fresh-eyes review"
allowed-tools:
  - Read
  - Grep
  - Bash
argument-hint: "<path-or-slug> [--dimensions <n>] [--focus <axis>]"
triggers:
- review this adr
- audit this document
- fresh-eyes review
- 8-dimension review
- review adr
- review gap doc
- review prd
---

# wi-review-adr

Produces a fresh-eyes structured review of a design document (ADR / PRD / gap doc / plan). The skill is the answer to `/wi review adr-040 across 8 dimensions` — the exact goal shape that halted at Cypher's SCOPE-iter-cap on 2026-07-05 because the loop had no file-read primitive (see [GAP-003](../../.planning/gaps/GAP-003-loop-catalog-completeness.md) for the failure trace).

## When to use

- `/wi review adr-NNN` — comprehensive review of a specific ADR
- `/wi audit docs/docs/prd/cypher-v2.5.md` — same shape on a PRD
- `/wi fresh-eyes review .planning/gaps/GAP-XXX.md` — cold-read review of a gap doc
- Any goal shaped as *"read this document and tell me what's wrong / what needs work / how it holds up on axis X"*

## When NOT to use

- **Skill-shaped goals** — if the goal fits `wi-search`, `wi-investigate`, `wi-pr-review`, etc., use those directly. This skill is the fallback for review-shape goals no other skill fits.
- **Code review of a specific PR** — use `wi-pr-review` (which has git+GitHub context) instead of pointing this skill at the diff.
- **Fixing what the review surfaces** — this skill is read-only. Its output is markdown, not patches.

## Invocation shape

```bash
# By slug (looks under docs/docs/adr/ and .planning/gaps/ and docs/docs/prd/)
/wi review adr-040
/wi review gap-003
/wi review cypher-v2.5

# By explicit path
/wi review docs/docs/adr/adr-040-outcome-honest-delivery-kanban.md

# Custom dimension count
/wi review adr-040 --dimensions 5

# Focused axis (single dimension deeper rather than 8 shallower)
/wi review adr-040 --focus threat-model
```

The Cypher SCOPE phase should route these to this skill via the refiner's `recommended_skill='wi-review-adr'` output.

## The 8 default review dimensions

The dimensions were selected to catch the classes of drift audits of this codebase have historically surfaced:

1. **Architectural soundness** — does the design coherently solve the stated problem? Are the primitives at the right altitude?
2. **AC coverage** — do the acceptance criteria actually verify the load-bearing claims, or are they substrate-shaped ("row exists") when they should be outcome-shaped ("behavior happened")?
3. **Testing discipline** — is the smoke suite (or equivalent) exercising the user-flow contract, or only the schema? Any "AC-U row exists" without "AC-U behavior observed"?
4. **Doc-vs-code drift** — does the ADR describe machinery that shipped code implements differently (see ADR-040 §3.3 Sonnet-vs-Haiku for the canonical example)?
5. **Threat model** — what's the abuse surface (prompt injection, cost blowup, silent regression, DB corruption)? Are the defenses named and testable?
6. **Cost model** — is the money/compute budget explicit? Does the ADR name what happens when budgets are hit (degrade gracefully, hard stop, silent skip)?
7. **Rollout safety** — is there a feature flag? Default-off? Kill-switch? Rollback path?
8. **Meta-consistency** — does the ADR practice what it preaches? An ADR about "outcome-honest delivery" is a category error if its own ACs are substrate-only.

Fewer dimensions (`--dimensions 5`) drop items 5-8 first (threat/cost/rollout/meta) since they're the most context-heavy. More dimensions (`--dimensions 12`) add: deployment ordering, migration reversibility, observability, and prior-art comparison.

## What the skill produces

Structured markdown with:

- **TL;DR** — 2-3 sentence verdict + top-N issues named
- **Per-dimension section** (`## 1. <dimension>` through `## N.`) — each with: verdict, evidence-cited findings (with file:line refs), suggested edits or ADR patch language
- **Cross-cutting: doc drift table** — any place the doc says one thing and the code does another
- **What was NOT reviewed** — deferred axes, out-of-scope items, "would need code changes to verify" gaps
- **Verification snapshot** — files read, dimensions covered, review scope

## Context files the skill reads

For an ADR-shaped review, the skill loads:

1. **The target doc itself** (obviously)
2. **The ADR index** (`docs/docs/adr/index.md`) — for adjacent ADRs and cross-references
3. **Any file the target doc links to** via markdown links (up to a reasonable depth, capped)
4. **The corresponding gap docs** — matches on the ADR's "Closes GAP-N" language
5. **The main codebase files the ADR names** — via grep on file paths mentioned in the doc

For a gap doc, it swaps step 4 for the ADR(s) that reference the gap. For a PRD, it loads the linked ADRs and any smoke test files that assert PRD ACs.

## What this skill does NOT do

- **Does not modify any file.** Read-only by design.
- **Does not run smoke tests.** If the review needs to know "does this smoke actually pass?", it names the smoke section and recommends running it — doesn't run it.
- **Does not access external services.** No Jira, no GitHub API, no Anthropic completions beyond the review generation itself.
- **Does not review its own output.** If you want a review of the review, invoke this skill a second time on the review output — but usually a bug when needed suggests the dimensions weren't right, not that the review is wrong.

## Failure modes

- **Target doc not found** — skill returns a specific "no doc at path X, searched: [list]" message. Cypher should not iter-cap on this — it should relay the error and clarify with user.
- **Doc too large to review in one pass** — cap at ~15k words; larger docs get chunked with an explicit "chunk 1/N covered §1-§4" header.
- **No cross-referenced files found** — degrades gracefully to reviewing the doc alone with a "context-unavailable" note in the verification snapshot.

## Cross-references

- **GAP-003 Tier 1** — this skill closes AC-H1/H2/H3 (the "ship wi-review-adr" tier).
- **GAP-003 Tier 2** — the file-read primitive question (AC-H4-H7). Deferred pending its own ADR.
- **GAP-003 Tier 3** — the `general_task` fallback (AC-H8-H11). Deferred pending its own ADR.
- **ADR-040 §2.4 DoD** — reviews produced by this skill are Tier-0 (`self_reported`) evidence; they don't count as `user_observed` verification per the outcome-honesty rule. The user still owns the acceptance judgment.

## Notes for future maintenance

- If the 8 default dimensions drift as the codebase matures, edit the table in this SKILL.md and add a "dimensions changelog" section. Do NOT silently mutate the review shape — the audit trail of "what did wi-review-adr check when it ran on <date>" needs to be reconstructable.
- If you find yourself wanting to add "this skill should also run tests" — DON'T. That's `wi-audit-adr` (with write access) or a new skill. This one stays read-only. Feature creep on read-only skills is how substrate-blindness returns.
