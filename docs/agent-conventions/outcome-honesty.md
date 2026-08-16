# Outcome-honesty — non-negotiable

> Every slice of work — code commit, ADR, design change, schema migration — must distinguish between **substrate-done** (the parts exist) and **outcome-done** (the user gets what they asked for). Substrate-done is necessary; outcome-done is the actual bar. We measure both, and we do not let substrate-done masquerade as done.

Trigger: this rule loads when editing anything under `docs/docs/adr/`, `.planning/`, `scripts/smoke*.sh`, `src/services/cypher/`, `web-server.js`, or when authoring a new ADR / acceptance criteria / smoke check.

The rule exists because of GAP-001 and GAP-002 (`.planning/gaps/`). Read those before changing this file — they're the auditable evidence for why the rule is shaped the way it is.

## The two states every slice has

Every slice produces TWO states, and they're independently tracked:

| State | Meaning | How verified |
|---|---|---|
| **substrate-done** | All the building blocks exist. Schema columns added. Helper functions returning correct shapes. Smoke section pinning the wiring. Typecheck clean. | Substrate ACs in the ADR, substrate smoke sections, unit tests asserting return shapes |
| **outcome-done** | A user can execute the user-facing flow the slice was authored to enable, and the system does the work. The system did not return a placeholder, an `{error: ...}`, or instructions for the user to do the work themselves. | Outcome ACs in the ADR, outcome smoke sections (under `npm run smoke:outcome`), session closer's `verified_outcome_via` field |

A slice declared "done" without **both** states verified is a violation of this rule. "Accepted — substrate only" is a legitimate intermediate state; "Accepted" without qualifier means both states are verified.

## What a user-flow AC looks like

Every ADR's AC table MUST include at least one row of this shape, at the TOP of the table (above substrate ACs):

```markdown
| AC-U1 | When user does <input>, system produces <output>. The system did the work, not the user. | Verification command that executes the flow and asserts on the result. |
```

Concrete examples:

- ✅ **Good outcome AC:** *"When user types `/wi do an investigation for PROJ-15702`, system dispatches wi-investigate as a subagent and returns its structured root-cause report. The user does not run any skill manually. Verified by `npm run smoke:outcome -- --section 40` which fires the dispatch and asserts the final surface contains the wi-investigate output schema."*
- ✅ **Good outcome AC:** *"When user closes a task with `cypher_task_close`, the worktree is torn down and the row reflects `worktree_status='torn_down'`. Verified by integration test that creates a task, closes it, checks fs and DB state."*
- ❌ **Bad (substrate-shaped):** *"`getCatalogHint()` returns a non-empty string for goal text matching catalog descriptions."* (Tests the helper, not the outcome.)
- ❌ **Bad (intent-shaped):** *"User experience improves when refinement is enabled."* (No verification command. No measurable outcome.)

## The four hard constraints (no exceptions)

### 1. No `STUB` / placeholder handlers in production paths

If a tool handler returns `{error: 'not_yet_wired_*'}` or any sentinel placeholder, the slice that introduces it MUST also include the work to replace it OR the slice is rejected. The `STUB` pattern was the proximate cause of GAP-001; the smoke gate now refuses commits where `STUB(` appears in `src/services/cypher/tool-catalog.ts` (see `.claude/hooks/no-stub-handlers.sh` once shipped).

### 2. An ADR is not `Accepted` until its outcome ACs pass

Substrate ACs passing means "Accepted — substrate only" in the frontmatter. Full `Accepted` requires outcome ACs to be passing too. Index status badges MUST distinguish:

- 📝 **Proposed** — no ACs yet
- 🚧 **Substrate Accepted** — substrate ACs pass; outcome ACs pending or in dogfood
- ✅ **Accepted** — both substrate AND outcome ACs pass

The retrofitting work for substrate-only-accepted ADRs (033, 037, 038 at minimum) is tracked at `.planning/gaps/GAP-002-outcome-blind-testing.md` § Tier 4.

### 3. Cypher session outcome verdicts MUST cite their verification source

When closing a session via `cypher_record_outcome`, the caller MUST set the `verified_outcome_via` field to one of:

- `smoke` — a smoke section was run after the work and passed
- `user_observed` — the user explicitly confirmed the user-facing flow works
- `self_reported` — neither of the above; the session author closed based on substrate evidence only

Sessions closed with `self_reported` get **lower weight** in Beta prior updates than `smoke` or `user_observed`. This breaks the Cause-3 feedback loop in GAP-002 § 4 — discipline no longer self-grades.

Pre-AC-T9 sessions are grandfathered as `self_reported` (the default).

### 4. Smoke gate splits substrate vs outcome

`npm run smoke:bridge` keeps the substrate checks it has today (column existence, schema shape, route registration, etc.) — fast, no Anthropic calls, run on every commit per the smoke-tests rule.

`npm run smoke:outcome` (new) fires real user-flow scenarios end-to-end, including real Anthropic calls. Budgeted to run nightly + on PR merge (not on every commit — outcome tests cost real money). Sections in `smoke:outcome` MUST assert on the **product behavior**, not the substrate plumbing.

The two suites together are the gate. `smoke:bridge` says "the parts work." `smoke:outcome` says "the product works." Both green is the bar.

## What this rule does NOT mean

- **Not every commit needs an outcome test.** A schema migration that adds a NULL column has no user-facing flow yet; substrate AC is fine. The outcome AC lands with the slice that USES the column for a user-visible behavior.
- **Not every ADR needs heavyweight E2E tests.** A small ADR with one user flow needs one outcome AC. A foundation-tier ADR with 12 D-slices needs at least one outcome AC per D-slice (the v2.5 retrofit at GAP-002 Tier 4 does exactly this).
- **Not every failure is a process failure.** Bugs happen. The rule catches a specific class of bugs: ones where the substrate is correct, the tests are green, and the product still doesn't deliver. If smoke catches a real failure, the system is working.

## The pattern that triggered this rule

Read once, then move on:

```
ADR-033 line 662: "The user types the chosen /wi-X themselves."
                  ↓ ↓ ↓ this is the design intent
ADR-037: ships the loop with this contract → smoke verifies the loop runs → 0 ACs
ADR-038: 12 D-slices of substrate (schema + helpers + smoke) → 0 outcome ACs
ADR-039: refinement substrate + advisory hint → 26 ACs, all substrate-shaped
2026-06-29 morning: user types "/wi do the regression test for PR #4553"
                  ↓ ↓ ↓ Cypher halts 3× and tells user to run wi-bis-regression
The user did Cypher's job. Six layers of gates were green. The product was broken.
```

The rule exists so that the next 100 commits don't repeat this pattern. **Substrate-pass is not done.** Done is when a user can do the thing.

## Enforcement

- **`.claude/hooks/cypher-discipline.sh`** — extended to require sessions touching smoke-gated paths to set `verified_outcome_via`.
- **`.claude/hooks/no-stub-handlers.sh`** — pre-commit hook that fails when `STUB(` appears in `src/services/cypher/tool-catalog.ts`. **Status: shipped 2026-06-29, not yet wired into PreToolUse** — activates once GAP-001 AC-G5 lands and the 19 existing STUBs are replaced. Until then, manually invokable for audit: `bash .claude/hooks/no-stub-handlers.sh`.
- **`scripts/smoke-bridge.sh`** — gains a meta-section that asserts the outcome-honesty rule file exists + is loaded by the session, so this rule cannot silently rot.
- **ADR template at `docs/docs/adr/_template.md`** — every new ADR starts from a copy of this; the AC table starts with outcome ACs (substrate ACs are below them).

## When you're tempted to skip outcome ACs

You will be tempted. The reasons will sound reasonable:

> "It's just a small slice. Substrate AC is enough."

Substrate ACs were enough for ADR-037, the entire tool-use loop. They weren't enough. They never are.

> "I can't write an outcome AC because the integration isn't wired yet."

Then the slice isn't done. It's substrate-done. Use the `🚧 Substrate Accepted` badge and open a follow-up card for the integration. Don't promote to ✅ until the outcome AC passes.

> "Outcome ACs cost real money to verify."

Yes. About $0.01–$0.05 per Anthropic call. The cost of GAP-001 — a senior engineer (the user) discovering that the product they've shipped doesn't work — is the time it takes them to lose trust in the discipline. That cost dwarfs any smoke-suite Anthropic bill.

> "The dogfood window is the outcome verification."

Sometimes true. AC-19 in ADR-039 is calendar-bound dogfood. That's a legitimate outcome AC if the dogfood actually measures outcome (it does). The dogfood needs a measurement script (`scripts/adr-039-dogfood-check.sh` is the template). Hand-waving "we'll know it works when we dogfood" without a measurement script is not a passing outcome AC.

Cross-references:
- `.planning/gaps/GAP-001-subagent-dispatch.md` — the symptom this rule was written from
- `.planning/gaps/GAP-002-outcome-blind-testing.md` — the per-pattern generalization
- `.claude/rules/smoke-tests.md` — substrate smoke discipline (companion rule)
- `.claude/rules/cypher-discipline.md` — session-open discipline (companion rule)
- `docs/docs/adr/_template.md` — the template that enforces this rule for new ADRs
