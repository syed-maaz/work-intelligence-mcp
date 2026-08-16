# ADR-051 — Skill-Registry Unification: Trade-off Analysis & Recommendation

**Status:** Superseded — recommendation adopted; see [adr-051-skill-registry-unification.md](./adr-051-skill-registry-unification.md) for the accepted decision (Option A, 2026-07-27)
**Date:** 2026-07-26
**Author:** Agent H
**Parent ADR:** ADR-050 (Fault-Proof `/WI` Loop Measurement Gate)
**Blocking:** ADR-050 Workstream C's downstream implementation (partly)

---

## The problem in 60 seconds

The WI system has **two skill inventories out of sync**:

**Inventory A** — `SKILL_ROUTES` in `src/services/cypher/skill-dispatch.ts` (18 dispatchable + 11 CLI-only = 29 total). This is what the bridge can invoke directly. Stage-1 recall ranks against this.

**Inventory B** — user-facing skills at `~/.hermes/skills/wi/` (28 skills). This is what appears when the user types `/wi-<something>`. Includes 5 **consolidated wrapper skills** (`wi-code`, `wi-people`, `wi-brief`, `wi-jira`, `wi-bug`) that shell-orchestrate multiple bridge endpoints.

**The gap:** Stage 1 cannot recommend the 5 consolidated wrappers because they're not in `SKILL_ROUTES`. Users see the wrappers in their skill inventory but the ranker never surfaces them. This drift is 8+ weeks old and undetected until 2026-07-26 Phase 0 M1 corpus preparation.

**Discovered during Phase 0 M1** when v2 paraphrase corpus was labeled against wrapper names — Stage 1 couldn't hit any of those labels because the wrappers aren't dispatchable. v3 corpus relabels to underlying primitives as a workaround.

---

## The three options

### Option A — Workaround only (do nothing structural)

**What:** Keep the two inventories separate. Downstream measurement filters on `dispatch_source` from v104 to separate real vs synthetic dispatches. Recall corpora label against `SKILL_ROUTES` primitives only.

**Effort:** ~0 hours code. Just document that the two inventories exist and the workaround is intentional.

**Pros:**
- Zero substrate change; nothing new to maintain
- v104 dispatch_source solves the measurement side already
- Preserves the 5 consolidated wrappers as user-facing CLI conveniences (they still work when user types `/wi-code blast-radius <file>` — Stage 1 just can't recommend the WRAPPER name)

**Cons:**
- Users see `wi-code` in their skill list but the ranker never suggests it
- Every corpus author has to know both inventories and label against primitives
- Recall benchmarks measure only 18/28 of user-visible skill capability
- Future scanner bug audits inherit this two-inventory state

**When to pick:** if the consolidated wrappers are architecturally different enough (multi-endpoint composition, subcommand routing) that Stage 1 shouldn't be recommending them anyway. Basically the "these are convenience aliases, not real skills" reading.

---

### Option B — Add `mode: 'shell'` to `SKILL_ROUTES`

**What:** Extend the `SkillRoute` type union to include a shell-orchestrated mode:
```typescript
type SkillRoute =
  | { mode: 'get'; path: string; ... }
  | { mode: 'post'; path: string; ... }
  | { mode: 'cli-only'; ... }
  | { mode: 'shell'; invocation: string };  // NEW
```
Register the 5 consolidated wrappers as `mode: 'shell'` with their `invocation` strings (`bash skills/wi-code/run.sh <subcommand>`, etc.). Stage 1's ranker treats them as dispatchable; the bridge routes them by shelling out (or returning the invocation string to the user to run).

**Effort:** ~4-6 hours.
- Extend `SkillRoute` type
- Update `DISPATCHABLE_SKILLS` filter to include mode: 'shell'
- Add dispatch handler for shell-mode routes (either shell out or return invocation string)
- Register the 5 wrappers with proper invocation strings
- Tests: shell-mode routes surface in Stage-1 rankings; dispatch handler works correctly

**Pros:**
- Bridges the two inventories with minimum code
- Doesn't require rewriting the shell scripts
- Preserves the multi-endpoint composition the wrappers already do
- Stage 1 can now recommend the full user-visible skill inventory (28 skills instead of 18)
- Fastest path to closing the drift

**Cons:**
- Changes what "dispatchable" means in ranker semantics (previously = single-HTTP-endpoint; now = also multi-endpoint shell composition)
- **Cost/latency profile differs from HTTP** — Cypher's `verified_outcome_via` DoD assumes HTTP JSON responses; shell mode doesn't produce those
- **Streaming behavior unclear** — shell wrappers don't stream SSE per current design; if Stage 1 recommends a shell-mode route, the streaming dispatch path breaks
- Security: shell-mode routes bypass the bridge's HTTP-level validation/auth layer
- Two dispatch code paths to maintain forever

**When to pick:** if the wrappers are architecturally legitimate (multi-endpoint composition IS valuable) AND the streaming/DoD concerns are addressable (or acceptable trade-offs).

---

### Option C — HTTP-ify the wrappers

**What:** Each shell wrapper's `run.sh` becomes a POST endpoint that returns structured JSON. The multi-endpoint composition happens server-side. Bridge dispatches HTTP the same as any other skill.

**Effort:** ~3-5 days.
- 5 shell scripts × ~1-2 days each = ~1-2 weeks worst case, ~3-5 days if the compositions are simple
- Design decision per wrapper: does the new HTTP endpoint proxy the underlying 3-4 endpoints internally (wrapper of a wrapper — adds a layer without benefit)? Or does the composition get redesigned server-side (real work with architectural implications)?
- Each endpoint needs its own tests, error handling, streaming behavior
- Migration path: keep shell scripts AND HTTP endpoints during transition, deprecate shell over time

**Pros:**
- Cleanest architecturally — one dispatch pattern
- Full streaming, validation, auth compatibility
- Removes the "two inventories" concept entirely
- Future-proof: any new dispatchable-shape skill fits the HTTP contract

**Cons:**
- **Real engineering commitment.** 3-5 days is not the tail of one session.
- Each wrapper composes 3-4 existing endpoints — either the new endpoint just proxies (adding a layer without benefit) or the composition is redesigned server-side (bigger scope than "unify inventories")
- Loses the "user can invoke via CLI" property the shell wrappers have today
- Migration risk: transition period has BOTH shell scripts and HTTP endpoints; deprecation timing matters

**When to pick:** if the design work is worth doing right (the wrappers aren't just aliases; they represent real composition patterns that deserve first-class server-side implementation).

---

## Trade-off matrix

| | Option A | Option B | Option C |
|---|---|---|---|
| Code cost | 0h | 4-6h | 3-5 days |
| Stage 1 recall of wrappers | ❌ | ✅ | ✅ |
| Streaming compatibility | N/A | ⚠️ Broken for shell-mode | ✅ Full |
| DoD compatibility | N/A | ⚠️ Shell doesn't produce HTTP JSON | ✅ Full |
| Auth/validation coverage | N/A | ⚠️ Shell bypasses bridge layer | ✅ Full |
| CLI-invocation property | ✅ Preserved | ✅ Preserved | ❌ Lost |
| Two dispatch code paths | 0 | 2 | 1 |
| Substrate cleanliness | 2 inventories forever | Bridged | Unified |

---

## Recommendation — Option A (workaround)

**Not because A is architecturally best. Because it's the honest match for the situation.**

Reasoning:

**1. The wrappers are a valid design pattern that shouldn't be forced into a Stage-1 recall list.** They're subcommand-dispatchers meant for users typing `/wi-code blast-radius <file>` — CLI convenience, not "the loop should pick this over the underlying primitive when routing a natural-language goal." A user goal like "what's the blast radius of embedder.ts" more naturally routes to `wi-blast-radius` (the primitive) than `wi-code` (the wrapper). The wrapper's job is CLI ergonomics, not recall targeting.

**2. Phase 0 already shipped the measurement fix.** v104's `dispatch_source` column separates real vs synthetic traffic honestly. The corpus-authoring workaround (label against primitives) is documented in v3 corpus notes. Downstream measurement doesn't NEED the wrappers in the recall list.

**3. Option B has hidden costs on streaming and DoD** that likely need their own ADRs to resolve. Adding shell-mode as a fourth dispatch shape introduces two-path complexity that outweighs the benefit of "5 more skills in the recall list."

**4. Option C is a real substrate rework** that deserves its own ADR after Phase 0 is fully closed and someone has time to design each endpoint properly. Not a Phase-0-adjacent quick win.

**5. The 8-week undetected drift is a monitoring problem, not a design problem.** Add a startup assertion that compares `SKILL_ROUTES` keys against `~/.hermes/skills/wi/` directory contents and warns on drift. That's a ~30-minute fix separate from any of A/B/C.

## What "accepting Option A" means concretely

1. **Document Option A as the decision** in `docs/adr/adr-051-skill-registry-unification.md` (rename to remove DRAFT suffix, add sign-off)
2. **Add a startup drift check** — 30 min work
3. **Update recall-corpus authoring docs** to say "label against SKILL_ROUTES primitives, not wrapper names"
4. **Retire ADR-051 from open decisions.** No implementation phase needed.

**Effort for the whole close-out: ~1 hour.**

## What "accepting Option B" would mean

1. Ship the `mode: 'shell'` type extension + dispatch handler (~4-6h)
2. Register the 5 wrappers
3. Document streaming caveat and DoD caveat
4. Accept two-path maintenance forever

## What "accepting Option C" would mean

1. Design each of 5 endpoints (composition decisions per wrapper)
2. Implement + test each (~1 day per)
3. Migration/deprecation plan for shell scripts
4. Spawn adr-052 for the design work; this ADR just decides "go do C"

---

## Open questions if you don't pick A

**For Option B:**
- How does streaming work for shell-mode routes? Do we accept non-streaming for these, or does the bridge fake SSE from shell output?
- How does `verified_outcome_via` DoD apply when the output isn't HTTP JSON?
- Do shell-mode routes participate in the `--confirm-mode` gating?

**For Option C:**
- Which composition patterns do we preserve vs redesign server-side per wrapper?
- Migration timeline for deprecating shell scripts?
- Do we keep the CLI-invocation property somehow, or accept its loss?

---

## Sign-off blocks

- **User (Maaz):** decides A/B/C
- **Agent 001:** review recommendation
- **Agent D:** review recommendation

If Option A: this doc's next revision removes DRAFT suffix and adds sign-offs, ADR-051 is closed.

If B or C: this doc becomes the reference for follow-up work.

— Agent H, 2026-07-26 (recommendation, non-binding)
