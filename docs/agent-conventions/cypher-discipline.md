# Cypher discipline — non-negotiable

> Every non-trivial code slice must open a Cypher session **BEFORE** the first edit, and close it with an outcome **AFTER** the work ships.
> Skipping the open call breaks the learning loop: priors stay stale, credit-assignment never fires, and Cypher's "did this skill choice help me ship?" signal is lost.

This rule applies to any change in `web-server.js`, `src/services/**`, `src/tools/**`, `src/intelligence/**`, `src/connectors/**`, `src/db/**`, `scripts/smoke-bridge.sh`, `scripts/smoke-ui.mjs`. (Same set as the smoke-tests rule.)

## Loop is the only engine (post-2026-06-24)

ADR-037 Phase 7 (delete `src/services/cypher/run.ts`, ~733 LOC) is **pre-decided to land 2026-07-21**. All quality gates cleared one day post-cutover; the only remaining gate is the 4-week calendar safety margin. The legacy 9-stage pipeline is end-of-life.

**Implications you need to internalize:**

1. **Always open Cypher sessions through `scripts/wi-dispatch-stream.sh`.** The wrapper hits `/api/wi/dispatch/stream` which runs `runLoop` (the loop engine). Raw `curl POST /api/wi/dispatch` (non-streaming) still exists for outcome-close only — using it to *open* a session bypasses the loop and is a regression. See § Opening a session below.
2. **`CYPHER_LOOP_ENABLED=0` is the rollback escape hatch until 2026-07-21, then it is gone.** Don't write code or docs that assume the pipeline path stays. Anything you author between now and 2026-07-21 should treat `runLoop` as the only engine.
3. **The engine badge (`[engine: loop]` prefix on the first stream chunk) is also EOL.** It made sense during the dual-engine window. Don't add new code that branches on `engine === 'pipeline'`.
4. **If you find yourself touching `src/services/cypher/run.ts` for any reason other than the Phase 7 deletion**, stop. The file is dead code in a retention window. Touching it now suggests either (a) you're solving a problem that already moved to `loop.ts`, or (b) you're scope-creeping the Phase 7 deletion PR.

The Apple Reminders entries that gate the deletion are documented in `.planning/cypher/15-SHADOW-MODE-METRICS.md § Phase 7 — pre-decided (landing 2026-07-21)`:

- `BFBEB7D4-468C-49FE-9A5B-D0E6EEB4658E` — 2026-07-07 09:00 local — regression check + pre-stage the deletion PR
- `22E2CEC9-212A-451A-85A6-2B28F07B7F65` — 2026-07-21 09:00 local — actually land the PR

## What counts as "non-trivial"

- New files in `src/services/`, `src/tools/`, `src/db/migrations/`
- New endpoints (route handlers in `web-server.js`)
- Schema bumps (`CURRENT_SCHEMA_VERSION` change in `src/db/schema.ts`)
- Cross-module wiring (services depending on new services)
- New MCP tools (entries in `TOOL_MANIFEST`)
- New smoke sections (§ blocks in `scripts/smoke-bridge.sh`)
- Hook additions to `.claude/hooks/`

If you're not sure, err on the side of opening a session — Cypher logs the dispatch and learns from it whether or not the work was "non-trivial enough".

## The protocol

```
1. open       Cypher.dispatch({goal: "<one sentence>", task_class: "build-feature", user: "maaz"})
              → loop runs synchronously; row lands at status='done' with the loop's self-reported outcome
2. (work)     edits, commits, smoke
3. close      Cypher.dispatch({session_id, goal: "<same>", outcome: "success"|"mixed"|"failed"})
              → status='done', priors update via Beta posterior
```

Concretely (shell):

```bash
# Open (routes through ADR-037 tool-use loop via SSE — exercises runLoop end-to-end)
eval "$(bash scripts/wi-dispatch-stream.sh \
  --goal "add work-context vocab to mode detector" \
  --task-class "build-feature" \
  --confirm-mode "auto")"
# After eval: $session_id, $verdict, $surface, $iterations, $duration_ms, $engine
# are set as shell variables (env-var-shell-style stdout from the wrapper).
SESSION_ID="$session_id"

# (work)

# Close — recording the outcome stays on the non-streaming endpoint; this
# call hits recordSkillOutcomes (no LLM, no loop), so streaming would add
# nothing. Same shape as before the loop cutover.
curl -fsS -X POST http://localhost:3132/api/wi/dispatch \
  -H 'content-type: application/json' \
  -d "{\"session_id\":\"$SESSION_ID\",\"goal\":\"<same>\",\"outcome\":\"success\",\"task_class\":\"build-feature\"}"
```

**Why `scripts/wi-dispatch-stream.sh` and not raw `curl POST /api/wi/dispatch`?**
The non-streaming `/api/wi/dispatch` endpoint runs `runCypher` (the legacy 9-stage pipeline in `src/services/cypher/run.ts`). It satisfies the discipline hook by creating a `cypher_sessions` row, but **it never invokes the ADR-037 tool-use loop**. The streaming endpoint `/api/wi/dispatch/stream` is the canonical entry point to `runLoop` — and `scripts/wi-dispatch-stream.sh` is a one-shot SSE consumer that holds the connection until `event: done`, then prints the result on stdout as shell-sourceable env-vars. End result: every discipline-driven session exercises the loop, writes a `cypher_outcomes` verdict row with real `iterations`, and produces the live telemetry that Phase 7 monitors.

**Post-2026-06-24 lifecycle:** the pipeline path is end-of-life (Phase 7 lands 2026-07-21). Between now and then, the dual-engine code stays in master as the rollback insurance, but **never use the non-streaming endpoint to open a session**. After 2026-07-21 the distinction disappears (both `/api/wi/dispatch` and `/api/wi/dispatch/stream` will route to `runLoop`); update this rule when that happens.

## Enforcement

The PreToolUse hook at `.claude/hooks/cypher-discipline.sh` blocks `Edit` / `Write` / `NotebookEdit` against any smoke-gated path when no Cypher session has been started in the last hour (`MAX_AGE_S=3600`, configurable via `CYPHER_SESSION_MAX_AGE_S`). The block message includes the exact wrapper invocation to open one.

Pre-2026-06-23, the hook also required `status='pending'`. After the routing migration to `scripts/wi-dispatch-stream.sh`, the loop runs synchronously and rows land at `status='done'` immediately — so the hook now matches on `started_at` recency only. Discipline intent is "you ran Cypher recently before editing", not "you have a lock open".

The hook reads `cypher_sessions` directly from `~/.work-intelligence-mcp/data.db` — it's <50ms, no LLM cost, no network. The session_id is never looked up by the hook; presence of *any* recent pending session is enough. (Cypher's own learn loop ties session→commit when you close with outcome.)

## Bypass for genuinely-trivial work

```bash
CYPHER_SKIP=1 CYPHER_SKIP_REASON='typo fix in test fixture' <your edit>
```

The bypass is logged to stderr — the user sees it. Use sparingly: comment fixes, typo corrections, `.md` updates that happen to live under `src/` (rare). When in doubt, open a session — it's free and the learning loop benefits.

## Why this exists

Auto-memory and CLAUDE.md describe "build through Cypher" as a hard rule, but rules without enforcement decay. Three failure modes the hook catches:

1. **Skipping the open call** — most common. Model goes "this is small enough" → edit → commit → no session → priors never shift. Hook stops at edit time.
2. **Forgetting to close** — second-most common. Open session is fine; close-with-outcome is what teaches the prior. The hook itself doesn't enforce close (Stop hook would, but that's overreach today). Discipline-by-rule: when smoke green and committed, close the session before SUMMARY.
3. **Bundling multiple slices into one session** — third. If Cypher session A opened to debug bug X, and you mid-flight discover bug Y in a different file, open a SECOND session for Y. Don't fold both into A — credit assignment goes wrong. (Today the hook can't detect this; future enhancement: check if `cypher_sessions.goal` mentions the file being edited.)

## ADR-039 — SCOPE phase MUST NOT call write/commit/push tools (AC-5)

When `CYPHER_REFINEMENT_ENABLED=1`, `runLoop({phase: 'scope', …})` enters a read-only refinement pass before the EXECUTE pass. The SCOPE phase **MUST NOT** dispatch any mutating tool. The enforcement is layered:

1. **Catalog-level (primary gate, AC-5).** `getCatalogForPhase('scope')` in `src/services/cypher/tool-catalog.ts` returns only tools with `phase: 'scope' | 'both'`. The 19 mutators are tagged `phase: 'execute'` so the refiner literally never sees them in its tool list. The list of pinned-execute tools (kept in sync with the registry):
   `brain_decide`, `code_graph_reindex`, `cypher_compact_context`, `cypher_gc_run`, `cypher_grant_create`, `cypher_grant_revoke`, `cypher_project_create`, `cypher_record_outcome`, `cypher_task_close`, `cypher_task_create`, `cypher_task_recurate`, `smoke_run`, `wi_bug_report`, `wi_bug_resolve`, `wi_bug_resolve_all`, `wi_save_to_ticket`, `wi_skill_install`, `wi_sync`, `wi_update_context`.
2. **Smoke contract.** `scripts/smoke-bridge.sh` § 39 pins the substrate (refined-goal validator AC-8, env-flag gate AC-16, rollback safety AC-20, migration columns AC-3 sanity). The full mini-loop body — including a "scope-phase write attempt is refused" assertion — lands in the follow-up card and will extend § 39 with the dispatch-time sub-cases.
3. **Reviewer discipline (this rule).** When you author a new tool, **set `phase` explicitly** in the `TOOL_MANIFEST` entry. Any write/commit/push/mutate semantics → `phase: 'execute'`. Pure read/search/list → `phase: 'scope' | 'both'`. If you can't decide cleanly, default to `'execute'` (safer) and call it out in the PR description so the reviewer can override.

**Why catalog-level wins over runtime-check.** A runtime guard ("if phase==='scope' && tool.mutates, reject") would still allow the refiner LLM to *try* the call, costing a tool_use round-trip and polluting the trace with a refused dispatch. Tagging at the catalog layer means the refiner's tool list is provably write-free at the JSON schema — the LLM has nothing to dispatch.

**Pairing with AC-20 (rollback).** The catalog tag is purely additive: when `CYPHER_REFINEMENT_ENABLED=0`, no scope phase runs, no scope catalog is computed, and the runtime is exactly today's single-pass loop. Rollback never needs to re-tag tools.

Cross-references: ADR-039 § Scope phase (full AC set), `src/services/cypher/tool-catalog.ts` (`effectiveToolPhase()` + `getCatalogForPhase()` + `getCatalogHint()`), `src/services/cypher/refined-goal-schema.ts` (the shape SCOPE emits), `tests/cypher/tool-catalog-phase.test.ts` (12 tests on the catalog filter), smoke § 39 (`scripts/smoke-bridge.sh:2938`).

## What the hook does NOT enforce (yet)

- Closing sessions with an outcome (relies on discipline + the Stop hook's smoke gate as a soft check)
- One-session-per-slice (today: one *open* session is enough; future: match goal text → file paths)
- Cypher-led planning (today: nothing stops you from opening a session purely to bypass the hook; the cure for that is honest goal text + outcome=mixed/failed when the work doesn't ship)

These are policy gaps, not bugs. The hook is the floor; rule discipline is the rest.
