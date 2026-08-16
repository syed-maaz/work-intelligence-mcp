# ADR-051 — Skill-Registry Unification: Bridge Routing vs User-Facing Skill Inventory

**Status:** Accepted — Option A (workaround-only)
**Date:** 2026-07-26 (drafted); accepted 2026-07-27
**Author:** Agent H (drafted); accepted by Maaz
**Parent ADR:** [ADR-050](./adr-050-fault-proof-wi-measurement-gate.md)
**Trade-off analysis:** [adr-051-tradeoff-analysis.md](./adr-051-tradeoff-analysis.md)
**Discovered during:** Phase 0 execution — M1 recall-corpus authoring

**Decision:** Accept Option A (workaround-only). Rationale in the trade-off analysis §
"Recommendation — Option A". The 5 consolidated wrapper skills (`wi-code`, `wi-people`,
`wi-brief`, `wi-jira`, `wi-bug`) remain user-facing CLI conveniences; Stage 1 continues
to rank against `SKILL_ROUTES` primitives only. v104's `dispatch_source` column already
provides the measurement separation this drift previously interfered with.

**Follow-up (this close-out):**
1. Rename this file from `-DRAFT.md` → `.md` (done)
2. Update recall-corpus authoring guidance to label against `SKILL_ROUTES` primitives (deferred; belongs
   to `.planning/wi-fault-proof-loop/BUILD-PLAN-01-PHASE0.md` § Step 0 corpus-fix — already documented there)
3. Startup drift check between `SKILL_ROUTES` keys and `~/.hermes/skills/wi/` directory contents
   (deferred as opportunistic; not gating any current workflow)

**Sign-off:**
- Agent H — recommended Option A (see trade-off analysis)
- User (Maaz) — accepted Option A on 2026-07-27; instructed to "finish it now"
- Agent 001 / Agent D — review deferred (their sign-offs were requested; not blocking on the workaround-only outcome)

---

## 1. Context

While preparing Phase 0's M1 measurement (Stage-1 skill recall), we discovered that the WI system has **two out-of-sync skill inventories**:

### Inventory A — `SKILL_ROUTES` in `src/services/cypher/skill-dispatch.ts` (line 104)

The bridge's routing table. 29 entries total:
- **18 dispatchable** (`mode: 'get'|'post'`) — bridge can invoke directly via HTTP; Stage-1 hint corpus can recommend these
- **11 cli-only** (`mode: 'cli-only'`) — invocation-only via CLI; Stage-1 does NOT surface these

Dispatchable set includes: `wi-search`, `wi-investigate`, `wi-status`, `wi-blast-radius`, `wi-pr-review`, `wi-find-expert`, `wi-morning-brief`, `wi-ticket-links`, `wi-teammate`, `wi-daily-digest`, `wi-jira-report`, `wi-teams-search`, `wi-action-items`, `wi-health`, `wi-palace-query`, `wi-bis-regression`, `wi-sync`, `wi-search-all`.

### Inventory B — user-facing skills at `~/.hermes/skills/wi/`

The user-facing skill inventory. Includes 28+ skills of which 5 are **consolidated wrapper skills** created 2026-07-24:
- `wi-code` — dispatches to `wi-blast-radius` + `wi-pr-review` + correlate via `bash skills/wi-code/run.sh`
- `wi-people` — dispatches to `wi-teammate` + `wi-find-expert` + owner-lookup
- `wi-brief` — dispatches to `wi-morning-brief` + `wi-daily-digest` + weekly
- `wi-jira` — dispatches to `wi-jira-report` + `wi-ticket-links` + analyze + save
- `wi-bug` — dispatches to bug report/resolve endpoints via `run.sh`

These 5 are **shell-orchestrated dispatchers** (`allowed-tools: [Bash]`, `bucket: E-thick`) that fan out to multiple bridge endpoints and compose their output.

### The gap

**Stage 1 cannot recommend the consolidated wrappers.** They're not in `SKILL_ROUTES`, so the ranking never surfaces them even when the user's goal semantically maps to `wi-code` (blast-radius / pr-review) or `wi-jira` (ticket-links / analyze).

**Discovery evidence** (from Phase 0 M1 corpus audit):
- v1 paraphrase corpus labeled 6/10 goals with names that no longer exist (`wi-pr-review` was renamed, etc.) — max recall structurally 40%
- v2 paraphrase corpus (fix attempt, 2026-07-25) labeled 5/10 goals with the NEW consolidated wrapper names (`wi-code`, `wi-people`, `wi-brief`, `wi-jira`, `wi-bug`) — which are ALSO unmeasurable because they're not in `SKILL_ROUTES`
- The v3 corpus authored for Phase 0 M1 sidesteps by relabeling back to the underlying dispatchable primitives (`wi-pr-review`, `wi-blast-radius`, etc.)

**Neither v1 nor v2 was structurally winnable as-designed.** The registry drift is 8+ weeks old and undetected until now.

---

## 2. The core question

Is this a routing bug or an architecture question?

**Read A: routing bug** — the 5 consolidated wrappers SHOULD be in `SKILL_ROUTES` and Stage 1 SHOULD be able to recommend them. Fix: register the wrappers.

**Read B: architecture question** — the consolidated wrappers are architecturally different (shell-orchestrated multi-endpoint composition, not single-endpoint HTTP). Making Stage 1 recommend them requires design work on what "dispatchable" means and how the bridge invokes shell wrappers.

The debate has not been had. Phase 0's M1 measurement uses a workaround (v3 corpus labels the primitives, not the wrappers). This ADR captures the actual question.

---

## 3. Three options (not yet decided)

### Option A — B-thin: workaround only (Phase 0 M1 approach)

**What:** Relabel the recall corpus to only reference skills in `SKILL_ROUTES`. Don't register the wrappers.

**Pros:**
- Zero substrate change
- Unblocks Phase 0 M1 measurement in minutes
- Preserves the consolidated wrappers as user-facing conveniences (they still work when the USER types `/wi-code blast-radius <file>`; Stage 1 just can't recommend the WRAPPER name)

**Cons:**
- Doesn't fix the actual gap
- Users see `wi-code` in their skill list but the ranker never suggests it
- Every recall corpus author has to know the two inventories and choose the right names

**Status:** shipped in Phase 0 as the M1 workaround.

### Option B — B-narrow: add `mode: 'shell'` to `SKILL_ROUTES`

**What:** Extend `SkillRoute` type with a new mode: `{ mode: 'shell', invocation: 'bash skills/wi-<name>/run.sh <subcommand>' }`. Register the 5 wrappers with this mode. Stage 1's ranker treats them as dispatchable; the bridge routes them by shelling out.

**Pros:**
- Bridges the two inventories with minimum code
- Doesn't require rewriting the shell scripts
- Preserves the multi-endpoint composition the wrappers already do

**Cons:**
- Changes what "dispatchable" means in the ranker's semantics (previously = single-HTTP-endpoint; now = also multi-endpoint shell composition)
- Cost/latency profile of shell-orchestrated skills differs from HTTP — Cypher's `verified_outcome_via` DoD assumes HTTP JSON responses
- Streaming behavior unclear (shell wrappers don't stream SSE per current design)
- Security: shell-mode routes bypass the bridge's HTTP-level validation/auth

### Option C — B-wide: convert the 5 wrappers to HTTP endpoints

**What:** Each shell wrapper's `run.sh` becomes a POST endpoint (`/api/wi-code`, `/api/wi-jira`, etc.) that returns structured JSON. Underlying multi-endpoint composition happens server-side. Bridge dispatches HTTP the same as any other skill.

**Pros:**
- Cleanest architecturally — one dispatch pattern
- Full streaming, validation, auth compatibility
- Removes the "two-inventories" concept entirely

**Cons:**
- Real engineering: 5 shell scripts × ~1-2 days each = ~1-2 weeks
- Each wrapper composes 3-4 existing endpoints — either the new endpoint proxies internally (wrapper of a wrapper, not a fix) or the composition is redesigned server-side (real work with architectural implications)
- Loses the "user can invoke via CLI" property the shell wrappers have today

---

## 4. Open questions (NOT decided)

1. **Do shell-orchestrated skills have architectural value the HTTP conversion would destroy?** The 5 wrappers compose 3-4 endpoints each. Is that composition user-facing convenience (CLI shortcut) or a legitimate design pattern? If the former, Option A is fine. If the latter, Option B or C is needed.

2. **Should Stage 1's recommendation be routing-aware (only recommend HTTP-dispatchable) or capability-aware (recommend any skill and let the dispatch layer figure out shell vs HTTP)?** Routing-aware = Option A. Capability-aware = Option B or C.

3. **What's the migration cost of HTTP-ifying 5 shell scripts?** Each dispatches to 3-4 existing endpoints — is the composition worth preserving? Would a new HTTP endpoint just proxy to the underlying primitives (adding a layer without benefit) or does it deserve a real service-level redesign (Option C in full)?

4. **What's the streaming/SSE contract for a "recommended skill" that's shell-mode?** Cypher's loop streams progress. Shell wrappers today don't stream SSE. Do we accept non-streaming shell-mode routes? Do they degrade the loop's UX?

5. **Is `wi-status` (which IS in `SKILL_ROUTES` today with `mode: 'get'`) architecturally the same as the 5 wrappers, or different?** If same, then the 5 wrappers should be registered the same way. If different (`wi-status` is single-endpoint, wrappers are multi-endpoint), then Option B's `shell` mode is the right pattern.

6. **How does this interact with skill_catalog scanner (`skill-discovery.ts:376`)?** The scanner writes discovered skills to `skill_catalog` on every scan. If we register wrappers in `SKILL_ROUTES` but the scanner doesn't know they're now routable, we'll get a new drift.

7. **Any other skill categories currently in inventory-drift?** Investigation only found the 5 consolidated wrappers, but the drift went undetected for 8 weeks. What's the process for keeping the two inventories in sync going forward?

---

## 5. Recommendation (H, non-binding)

**Don't decide during Phase 0.** ADR-050 explicitly retracts design work until Phase 0's three floors clear. Making the routing-vs-architecture call now = building substrate under time pressure = the exact trap Phase 0 exists to catch.

**When Phase 0 completes:**
- If M1 passes on the filter alone (variant ii ≥ 70%), the "recall pollution" hypothesis is confirmed and Option A (workaround) is enough. ADR-051 may not need to close.
- If M1 fails and requires deeper work (variant iii or beyond), then this ADR moves to the top of the queue — because Stage 1 can't route to skills it doesn't know exist.
- If M2 clears (which Phase 0 preliminary data suggests it won't), the design in the annex would need to interact with the consolidated wrappers cleanly — Option B or C becomes load-bearing.

**Timeboxed follow-up:** revisit this ADR within 2 weeks of Phase 0 closing.

---

## 6. Related

- **ADR-050** — Fault-proof `/WI` measurement gate (parent decision)
- **`.planning/wi-fault-proof-loop/BUILD-PLAN-01-PHASE0.md`** — M1 workaround (v3 corpus targets `SKILL_ROUTES` primitives)
- **`src/services/cypher/skill-dispatch.ts:104`** — `SKILL_ROUTES` object literal
- **`src/services/cypher/tool-catalog.ts:2461`** — `getCatalogHintWordOverlap` (the hint corpus reader)
- **`~/.hermes/skills/wi/wi-code/SKILL.md`** and 4 siblings — the consolidated wrapper skill definitions
- **`docs/agent-conventions/outcome-honesty.md`** — the discipline this ADR upholds (deferring substrate work rather than fabricating a decision under time pressure)

---

## 7. Sign-off

- **Agent H** — captured this ADR during Phase 0 M1 corpus audit. Not authorized to decide alone.
- **Agent 001** — should review as author of the substrate verification that revealed the drift.
- **Agent D** — should review as the outcome-honesty enforcer.
- **User (Maaz)** — decides whether to prioritize post-Phase-0.

**Draft status. Not yet reviewed. Not yet decided.**
