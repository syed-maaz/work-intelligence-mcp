# Smoke Test Protocol — non-negotiable

> A task is **not done** until smoke tests pass on the surface it touched.
> `npm run typecheck` and `npm run build` are necessary but **not sufficient** — both can pass while runtime behavior is broken (missing env var, schema race, wrong endpoint URL, stale `dist/`, broken CSS variable).

This rule applies to any change in `web-server.js`, `src/services/**`, `src/tools/**`, `src/intelligence/**`, `src/connectors/**`, `src/db/**`, `web/src/**`.

## The protocol

After completing an important task or implementation, **before claiming "done"**, follow this sequence:

```
1. typecheck       npm run typecheck    (root + cd web && npx tsc --noEmit if UI touched)
2. build           npm run build        (refreshes dist/ — agents won't see your TS changes otherwise)
3. restart         lsof -ti :3132 | xargs kill -9; sleep 1; npm run web:bridge &
4. smoke           npm run smoke:bridge        (bridge changes)
                   npm run smoke:ui            (UI changes, requires Vite running on :5175)
                   npm run smoke:all           (anything touching both)
5. only then       declare the task done
```

If a smoke test fails, **do not declare the task done** — the failure is your finding to fix or flag.

## What each smoke script covers

### `npm run smoke:bridge` — `scripts/smoke-bridge.sh`

Bridge must already be running on `:3132`. Checks (exit 1 on any failure):

| # | Check | Verifies |
|---|---|---|
| 1 | `GET /api/status` returns 200 with expected keys | Liveness, no startup crash |
| 2 | `GET /api/agents/health` lists ≥ 7 agents, none `crashed` | Per-agent isolation (OP-5 / A-2) |
| 3 | `GET /api/system-health` includes `agents` block | Agent rollup wired |
| 4 | Disallowed origin gets NO `Access-Control-Allow-Origin`; allow-listed origin gets echo | CORS lockdown (OP-4 / A-1) |
| 5 | `OPTIONS` preflight → 204 with CORS headers | CORS preflight |
| 6 | `POST /api/pr/create` without `dry_run` returns `dry_run: true` + `preview` | PR safety gate (OP-2 / U-5) |
| 7 | `GET /api/brain/decide/stream` emits ≥ 3 stage events + a `result` event; cache HIT path returns in < 3 s | Streaming brain decide (OP-7 / U-3) |
| 8 | `POST /api/search-all` rejects invalid `sortBy`; accepts `recency` at schema layer | Search sort (U-15) |
| 10c | Two parallel POSTs to `/api/code-graph/index` get exactly one 202 + one 409 | Race window closed (ADR-027 v2 item #3) — soft check, may flap on timing |
| 10e | `tests/code-graph/lock.test.ts` runs clean via vitest | Deterministic race-closure invariant (the HARD gate behind § 10c) |

Token cost: one Claude Sonnet call on first run per UTC day for the seeded "What is 1 plus 1?" question (~1k input tokens, ~$0.005). To skip even that:

```bash
SKIP_BRAIN_LIVE_CALL=1 npm run smoke:bridge
```

### `npm run smoke:killswitch` — `scripts/smoke-killswitch.sh`

Closes ADR-027 v2 follow-up #3. Spawns a child bridge on port `:3133` with `CODE_GRAPH_INDEX_DISABLED=1`, a hermetic temporary `DATABASE_PATH`, and palace disabled. Asserts:

| # | Check | Verifies |
|---|---|---|
| 1 | Child bridge becomes live on `:3133` within 30s | Boot path with kill-switch on still works |
| 2 | stderr contains `disabled via CODE_GRAPH_INDEX_DISABLED=1` | Kill-switch branch fired |
| 3 | `/api/agents/health` does NOT list `CodeGraphIndexer` | Agent skipped, not just degraded |
| 4 | Total agent count is exactly 8 (vs the normal 9) | No silent re-registration via a different code path |

The child bridge is torn down on exit (including failed exits). Uses a fresh `/tmp/wi-killswitch-test-$$.db` so the real DB is untouched. Heavier than `smoke:bridge` (one full bridge boot + schema migration on a fresh DB), so it lives behind its own script. `smoke:all` chains it after `smoke:bridge`.

```bash
npm run smoke:killswitch
```

### `npm run smoke:ui` — `scripts/smoke-ui.mjs`

Vite dev server must be running on `:5175` (`npm run web:dev`). Uses headless Playwright Chromium. Checks (exit 1 on any failure):

| # | Check | Verifies |
|---|---|---|
| 1 | `/` renders full-page chat; chat toggle hidden on homepage | Chat primary (U-6) |
| 2 | Sidebar renders 4 group labels + Chat, Dashboard, Setup, Glossary nav | Sidebar IA (U-1) |
| 3 | Linkify on homepage chat (Jira, PR, @mention, URL) | Linkify (U-10) |
| 4 | `/setup`, `/glossary`, `/search-all` sort toggles, `/system-health` macOS note | UX pages (U-11–U-19) |
| 3a | ≥ 2 Jira-key anchors with `https://jira.example.com/browse/` hrefs | Jira-key chip |
| 3b | ≥ 1 PR-ref anchor with `/pr-review?pr=...` href | PR chip |
| 3c | ≥ 1 `@mention` span | Mention chip |
| 3d | ≥ 1 bare-URL anchor | URL link |
| 4 | Saves `/tmp/ui-sidebar.png`, `/tmp/ui-chat.png`, `/tmp/ui-full.png` | Visual evidence |

First-time only: `npx playwright install chromium` (~90 MB, ~25 s).

### `npm run smoke:all`

Runs both sequentially. Bridge AND Vite must be running. Use after any change that crosses the API boundary.

## When to run which

| You changed… | Run |
|---|---|
| `web-server.js` route handler, middleware, agent boot block | `smoke:bridge` |
| `src/services/brain/**`, `src/tools/**` (logic the bridge dispatches to) | `smoke:bridge` (after `npm run build`) |
| `src/db/schema.ts`, any migration | `smoke:bridge` + sqlite schema spot-check |
| `web/src/components/**`, `web/src/pages/**`, store, Tailwind | `smoke:ui` |
| Both backend AND UI (e.g. new endpoint + new page) | `smoke:all` |
| Connectors, sync, Playwright scrapers | `smoke:bridge` (verify the bridge boot block didn't regress) **plus** the connector-specific manual check (e.g. `npm run teams-sync` for Teams) |
| Documentation only | No smoke needed |

## Failure-mode dictionary (when you see these in smoke output)

| Symptom in smoke output | Likely cause | First action |
|---|---|---|
| `Bridge not reachable at http://localhost:3132` | Bridge isn't running or crashed at boot | `tail -50 /tmp/bridge.out` or wherever you logged stderr |
| `Denied origin got CORS headers — leak!` | A new route hard-coded `Access-Control-Allow-Origin: '*'` | Search the diff for `'*'` and replace with `...(res._corsHeaders || {})` |
| `Expected ≥7 agents, got N` | One or more agents crashed at boot | `curl -s localhost:3132/api/agents/health \| jq '.agents[] \| select(.status=="crashed")'` |
| `POST /api/pr/create did NOT default to dry_run` | Someone removed the `dry_run !== false` gate. CRITICAL — Atlas can now open real PRs | Revert the diff and restore the gate before anything else |
| `SSE emitted only N stage events (expected ≥3)` | `runDecision` lost its `onStage` calls, or the route stopped wiring them | Check `src/services/brain/decision-engine.ts` and `/api/brain/decide/stream` route |
| `Expected groups: Daily, Search, Work, System` not found | Sidebar NAV groups regressed | Check `web/src/components/shell/Sidebar.tsx` `NAV` constant |
| `jira keys: 0 / PR refs: 0 / @mentions: 0 / URLs: 0` | Linkify broke or `MD_COMPONENTS` was removed from `ChatMessage` | Check `ChatMessage.tsx` is still passing `components={MD_COMPONENTS}` to `ReactMarkdown` |

## How to add a new smoke check

When you ship a non-trivial feature, **extend the relevant smoke script in the same commit**.

- Bridge endpoint → add a section to `scripts/smoke-bridge.sh` with `pass`/`fail` helpers.
- UI surface → add an assertion (DOM query or screenshot diff) to `scripts/smoke-ui.mjs`.

A smoke check is good enough when it would have failed the day before your feature shipped. It does **not** need to test every code path — that's what unit tests are for.

## Why this exists

Smoke testing isn't redundant with `typecheck` or unit tests. It catches:

- Runtime config drift (env var not loaded, wrong `dist/` path).
- Cross-module wiring breaks that don't show up in types (route registered to wrong handler, missing `await import`).
- Schema-vs-code mismatches (migration didn't run, `ensureLedger` raced).
- Build-time vs deploy-time gaps (stale `dist/`).
- Side-effect regressions (CORS leak, hard-coded constants, agent boot crash).

Every smoke-detectable bug that ships to the bridge means the daemon serves wrong answers until someone notices. With ~80 endpoints and 8 background agents, the floor for "I'll just notice" is too low.
