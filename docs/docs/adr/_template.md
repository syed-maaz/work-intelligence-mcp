---
sidebar_label: "ADR Template"
sidebar_position: 999
title: "ADR-NNN: Template"
status: Proposed (YYYY-MM-DD)
date: YYYY-MM-DD
deciders: <name> (<id>)
---

# ADR-NNN: <One-line title>

**Status:** 📝 **Proposed (YYYY-MM-DD)**

Status badges (use exactly one):
- 📝 **Proposed (YYYY-MM-DD)** — design under discussion, no ACs verified
- 🚧 **Substrate Accepted (YYYY-MM-DD)** — substrate ACs pass; outcome ACs pending or in dogfood
- ✅ **Accepted (YYYY-MM-DD)** — both substrate AND outcome ACs pass — see [`.claude/rules/outcome-honesty.md`](../../../.claude/rules/outcome-honesty.md)
- 🔄 **Superseded by ADR-NNN (YYYY-MM-DD)** — historical only
- ❌ **Rejected (YYYY-MM-DD)** — explored, not pursued — keep doc for record

**Related:**
- [ADR-NNN](./adr-NNN-slug.md) — one-line on the relationship

---

## Context

What's broken / missing / changing. **Frame in user terms first**, then technical terms. Bad framing: *"the catalog hint is non-binding."* Good framing: *"the user types `/wi <goal>` and Cypher tells the user to run a skill manually instead of dispatching it."*

If the change has no user-facing impact (e.g. pure refactor), say so explicitly and skip the user-flow ACs below. Substrate ACs alone are legitimate for ADRs of that kind.

## Decision

What we're doing. Diagrams welcome (mermaid). Be specific about the user-facing contract this delivers.

## Acceptance Criteria

> **Hard rule from `.claude/rules/outcome-honesty.md`:** The AC table starts with user-flow ACs. Substrate ACs come below. An ADR with zero user-flow ACs MUST justify the absence in the row labeled "Why no user-flow ACs" — typically because the change is pure infrastructure / refactor / migration with no user-visible behavior yet.

### Phase 1 — User flows (the bar for ✅ Accepted)

These ACs verify the user-facing contract. Their verification commands MUST exercise the actual user flow against the live bridge, not just the helper functions. Smoke checks for these go in `npm run smoke:outcome`, not `npm run smoke:bridge`.

| # | AC | Verification |
|---|----|--------------|
| AC-U1 | When user does `<specific input>`, system produces `<specific output>`. The system did the work, not the user. | `npm run smoke:outcome -- --section NN` |
| AC-U2 | When user does `<edge case input>`, system handles it `<specific way>` (clarifying question, graceful halt, etc.). | `npm run smoke:outcome -- --section NN.M` |

### Phase 2 — Substrate (the bar for 🚧 Substrate Accepted)

These ACs verify the building blocks. Necessary but not sufficient.

| # | AC | Verification |
|---|----|--------------|
| AC-S1 | `<column / function / module>` exists and returns `<shape>`. | unit test path + smoke section number |
| AC-S2 | Migration vNN runs clean on a fresh DB AND on a v(NN-1) DB. | `sqlite3` schema check after migration |

### Phase 3 — Rollout safety

| # | AC | Verification |
|---|----|--------------|
| AC-R1 | Env-flag gate exists; setting flag=0 reverts behavior without restart. | smoke section that toggles flag mid-stream |
| AC-R2 | Rollback procedure documented at top of `## Operations` section below. | grep for rollback procedure |

## Operations

How to enable / disable / rollback the change. Include exact env-var names, exact commands.

## Consequences

### Positive
- ...

### Negative / cost
- Token cost of new model calls per dispatch: ~$0.XX. Budget impact: ...
- Schema migration migrates N existing rows in ~T seconds on production data size of M.
- ...

### Neutral
- ...

## Trade-offs explored

| Alternative | Why rejected |
|---|---|
| Alt A | ... |
| Alt B | ... |

## Open questions

1. **Q-1:** ... — proposed answer: ... — gate where this gets resolved: ...
2. ...

## Verification snapshot at acceptance time

Filled in when status changes to ✅ Accepted:

- Master HEAD: `<sha>`
- Schema version: `vNN`
- Smoke counts: substrate `NNN/M`, outcome `NN/N`
- Cypher session that closed this work: `cyp_<id>` (closed with `verified_outcome_via='<smoke|user_observed|self_reported>'`)
- Dogfood evidence (if applicable): `<path to .planning/<feature>-dogfood-result.md>`

---

## How to use this template

1. Copy this file to `docs/docs/adr/adr-NNN-<slug>.md`.
2. Replace `NNN` with the next free ADR number (check `docs/docs/adr/index.md`).
3. Fill in the title, frontmatter, and body.
4. **Write the user-flow ACs FIRST.** If you can't write them, the design isn't ready — stay in `📝 Proposed`.
5. Submit for review.
6. As work ships:
   - When substrate ACs pass → status `🚧 Substrate Accepted`.
   - When user-flow ACs pass → status `✅ Accepted`.
   - Update `docs/docs/adr/index.md` with the new entry.
7. Open follow-up cards for any AC that's calendar-bound (e.g. dogfood) — those carry the responsibility to flip 🚧 → ✅ when verification lands.

Loaded by `.claude/rules/outcome-honesty.md` as the authoritative ADR shape.
