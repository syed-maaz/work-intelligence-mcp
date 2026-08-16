# Self-Healing Bug Loop — Architecture (Phase A + B)

**Status:** Phase A shipped 2026-05-31 (Phase 74). **Phase B shipped 2026-05-31 (Phase 75)** — `BugInvestigatorAgent` live, `/bugs` Investigation tab renders structured findings, Re-investigate button wired. **Phase C shipped 2026-06-01 (Phase 76)** — `BugResolverAgent` live (re-scoped: WI fixes its OWN source, local-commit only, never pushes; `BUG_RESOLVER_ENABLED=0` default). Phase D (auto-merge against customer repos) gated on Phase 76 soak.
**Source ADR:** [ADR-030 — Self-Healing Bug Loop](../adr/adr-030-self-healing-bug-loop.md)
**Schema migration:** v53 (Phase A — five tables, atomic) + v54 (Phase B — `bugs.last_investigation_id` + `bug-investigator` model_config bucket)
**Scope fence:** Phase A is **capture-only**, Phase B is **AI-assisted triage** — no PR generation (Phase C), no auto-merge (Phase D).

## What this delivers

A **global error log for WI itself.** Before Phase A the answer to "what just broke?" was "tail the stderr and hope." After Phase A every uncaught throw on the bridge, every agent tick error, and every web-UI render error or unhandled rejection is captured by fingerprint into a single SQLite table, deduplicated via UPSERT, and browsable on a `/bugs` page. `/api/system-health.bugs` aggregates the state for dashboards.

This is the substrate the next three phases extend — but Phase A is *useful on its own* even if no other phase ever ships.

## The four-stage pipeline mapping

```
FETCH → PROCESS → ANALYZE → PROPOSE
                  │   │
                  │   └── Phase B: BugInvestigatorAgent fills this stage in
                  └────── Phase A: Process (capture + UPSERT + severity)
```

- **Process:** capture endpoints + UPSERT dedupe + severity recompute against the ring buffer.
- **Analyze:** **Phase B** — `BugInvestigatorAgent` polls `status='new'` bugs, gathers evidence, calls the brain via the `bug-investigator` budget bucket, writes `bug_investigations` rows. See [bug-investigator-agent.md](./bug-investigator-agent.md).
- **Propose:** `/bugs` page (Investigation tab now renders the live `bug_investigations` row when present, plus a Re-investigate button) + Sidebar entry + `/api/system-health.bugs` block.

## Capture surfaces

Three error surfaces all funnel into the same `bugs` table via the same fingerprint algorithm. The table doesn't care where the error came from beyond the `source` enum — but the bridge knows where, so Phase B/C/D can branch on it.

### 1. Bridge — `process.on('uncaughtException')` + `process.on('unhandledRejection')`

Registered in `web-server.js` immediately after `const db = getDatabase()`. Every uncaught throw and every unhandled rejection passes through `captureToInternalEndpoint('bridge', err, { phase })`, which calls `captureBug(db, payload)` from `src/routes/bugs.ts` directly — **never via HTTP**, because the HTTP path itself may be what just crashed. The capture is wrapped in inner try/catch that swallows secondary errors silently.

We **deliberately override** Node's default uncaughtException-causes-exit behaviour. The capture loop is more useful than a crashed bridge. If a fatal logic bug puts the bridge in an unrecoverable state, the next request will surface it via 5xx + a fresh capture row.

```
[Bugs] uncaughtException: Phase74SyntheticUncaught
```

is the stderr line you'll see per uncaught throw.

### 2. Agent — `withAgentTick` catch arm

Every agent tick goes through `withAgentTick(name, fn)` in `web-server.js`. The catch arm now calls `captureBug` with `source='agent'` and `context: { agent: name }` **before** the existing flaky → degraded escalation. The agent stays alive — `markAgentCrashed` is intentionally NOT called. The whole point is best-effort capture without changing the agent lifecycle.

If `captureBug` itself throws, an inner try/catch swallows it and writes one stderr line so we don't lose the original error.

### 3. Web UI — `componentDidCatch` + `window.onerror` + `unhandledrejection`

Three browser-side capture paths in `web/src/`:

- `components/shell/ErrorBoundary.tsx::componentDidCatch` — POSTs to `/api/bugs/report` on any React render error. Includes the `componentStack`. **Always-on** (dev + preview + production), because `componentDidCatch` typically receives good stacks even after Vite minification.
- `main.tsx` — `window.addEventListener('error')` and `window.addEventListener('unhandledrejection')` for non-React errors (`setTimeout` callbacks, async work outside render cycles). **Dev/preview only** — Vite minifies production builds and breaks `top_frame` extraction. Phase B will add server-side source-map resolution before re-enabling production capture.

All three POST `{ source: 'web-ui', errorName, message, stack, ... }` to `/api/bugs/report`. The bridge handles them identically to bridge/agent captures.

## Fingerprint + normalization

Source: `src/services/bugs/fingerprint.ts`. **Pure functions only** — no DB, no fs, no network, no `Date.now()`. Determinism is the contract: same input → same fingerprint, byte-for-byte.

### The five normalization rules (locked in ADR-030)

Order matters: lowercase first so the placeholder sentinels stay uppercase and survive subsequent passes.

| # | Rule | Example |
|---|------|---------|
| 4 (early) | Whitespace trim + lowercase + collapse internal whitespace | `   Already Lowercase  ` → `already lowercase` |
| 2a | UUIDs → `<HASH>` | `9f3e1d2c-8a4b-...` → `<HASH>` |
| 2b | Hex runs ≥ 8 chars (after UUIDs) → `<HASH>` | `commit ab12cd34ef56` → `commit <HASH>` |
| 1 | Digit runs ≥ 3 → `<N>` | `Listening on port 3132` → `listening on port <N>` |

Path rule first among substitutions so the digits inside a path don't become `<N>`.

### Top-frame extraction (the wrapper allowlist)

`extractTopFrame(stack)` walks the stack, top-down, returning the first frame that:

- Is NOT in `node_modules`, AND
- Is NOT in the wrapper allowlist:
  - `withAgentTick` (web-server.js)
  - `node_modules/express` (error middleware)
  - `componentDidCatch` (React ErrorBoundary)
  - `ErrorBoundary` (the same boundary, by name)
  - `uncaughtException` / `unhandledRejection` (the bridge shims themselves)
  - `captureToInternalEndpoint` (the helper that calls the shims)

Returns `null` when only library/wrapper frames are present (the "everything is library code" case).

### The hash

```ts
sha256(`${source}|${errorName}|${normalizedMessage}|${topFrame ?? ''}`)
  .digest('hex')
  .slice(0, 16);
```

16-char prefix = 2^64 collision space. Real collisions get caught by the SQLite `UNIQUE` constraint and degrade to two distinct errors sharing one row — acceptable for Phase A. Phase B may revisit if the rate matters in practice.

**Source is in the hash.** A bridge throw and an agent throw with identical errorName + message + topFrame produce DIFFERENT fingerprints. This is intentional: Phase B's recursion guard will need to filter by `source != 'bug-investigator'`, and the rest of the system reasons about bugs per-surface.

## Schema (v53 — five tables, atomic)

`v53_bug_capture_tables.ts` — see [database-schema.md](./database-schema.md) for the full DDL with all CHECK / UNIQUE / FK constraints. High-level shape:

| Table | Phase A populated? | Purpose |
|-------|-------------------|---------|
| `bugs` | ✅ | Captured exceptions. UNIQUE(fingerprint) is the UPSERT key. |
| `bug_occurrences` | ✅ | Ring buffer of timestamps per bug. ON DELETE CASCADE from bugs. |
| `bug_investigations` | empty | Phase B target. |
| `auto_merge_blocklist` | empty | Phase D target. |
| `auto_merge_audit` | empty | Phase D target. |

Five tables ship together so Phase B/C/D extend by adding columns rather than another migration.

### The recursion-guard placeholder

`bugs.source` CHECK enum includes `'bug-investigator'` so Phase B's polling SELECT can use:

```sql
WHERE status='new'
  AND source != 'bug-investigator'
  AND investigation_attempts < 3
```

without another migration. Phase A doesn't have an investigator; the smoke explicitly round-trips a `source='bug-investigator'` row to prove the value is accepted today.

The `investigation_attempts` column ships in v53 too, so Phase B's anti-recursion-cap (`AND investigation_attempts < 3`) doesn't need DDL.

### Slot history (v52 → v53)

PLAN.md drafted Phase A's migration as v52. While Phase 74 was paused mid-execution, Tier 2 admin UI (`model_config`) shipped to v52 first. Phase A's bug-capture migration was renumbered v53 with no DDL changes. The `slot_change_log` annotation in PLAN.md frontmatter is the canonical pattern for documenting forced renumbers.

## Severity recomputation (a real query, not a guess)

Severity is recomputed against `bug_occurrences` on every UPSERT. Critical: it's never derived from `occurrence_count + last_seen_at`.

```ts
function computeSeverity(db, bugId, source): 'low' | 'medium' | 'high' {
  // Agent crash-loop shortcut — 5 hits in 10 minutes.
  if (source === 'agent') {
    const n = COUNT(bug_occurrences WHERE bug_id = ? AND seen_at > now - 10min);
    if (n >= 5) return 'high';
  }
  // General rules — same windows for all sources.
  if (COUNT(... > now - 1hour) >= 10) return 'high';
  if (COUNT(... > now - 1day)  >= 5)  return 'medium';
  return 'low';
}
```

The recomputation runs **after** the occurrence is inserted in the same transaction, so the ring-buffer query sees the row we just added. If the new severity is non-low, an `UPDATE bugs SET severity = ?` follows. Three indexed `COUNT(*)` queries; cheap enough that we don't bother caching.

## The capture transaction

`src/routes/bugs.ts::captureBug(db, payload)`:

```
TRANSACTION {
  // 1. UPSERT in one statement — no SELECT-then-INSERT race window.
  upsert = INSERT INTO bugs (fingerprint, source, error_name, message,
                             top_frame, first_seen_at, last_seen_at,
                             occurrence_count, status, severity,
                             context_json, investigation_attempts)
           VALUES (?, ?, ..., 1, 'new', 'low', ..., 0)
           ON CONFLICT(fingerprint) DO UPDATE SET
             occurrence_count = occurrence_count + 1,
             last_seen_at     = excluded.last_seen_at
           RETURNING id, occurrence_count;

  // 2. Append to bug_occurrences in the same transaction.
  INSERT INTO bug_occurrences (bug_id, seen_at) VALUES (?, ?);
}

// 3. Recompute severity post-transaction (cheap, three indexed COUNTs).
severity = computeSeverity(db, id, source);
if (severity !== 'low') UPDATE bugs SET severity = ? WHERE id = ?;
```

This is the [Review Finding #2 fix](../adr/adr-030-self-healing-bug-loop.md#review-findings--2026-05-30): Phase A's UPSERT is one statement, not the SELECT-then-INSERT-or-UPDATE that the v0 ADR sketched. SQLite's row-level locking inside `ON CONFLICT DO UPDATE` is what guarantees atomicity.

## Endpoints

Source: `src/routes/bugs.ts`. Wired into `EXTRACTED_ROUTES` in `web-server.js`. See [api-reference/bugs.md](../api-reference/bugs.md) for full request/response shapes.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/bugs/report` | Single capture entry point. Idempotent via UPSERT. |
| `GET` | `/api/bugs` | List bugs (filters: `status`, `source`, `severity`, pagination). |
| `GET` | `/api/bugs/:id` | Single bug + last 50 occurrences + (Phase B) investigation. |
| `POST` | `/api/bugs/:id/resolve` | Body `{ resolution: 'resolved' \| 'wont-fix', note? }`. |

`/api/system-health.bugs` is part of the existing `/api/system-health` endpoint, not a new route. The `bugs` block looks like:

```json
{
  "bugs": {
    "total": 42,
    "new": 3,
    "investigating": 0,
    "proposed": 0,
    "auto_merged_24h": 0,
    "resolved_24h": 5,
    "top_fingerprints": [
      { "fingerprint": "ab12cd34ef567890", "error_name": "TypeError",
        "occurrence_count": 12, "severity": "medium" }
    ],
    "investigator_status": "not-implemented",
    "auto_merge_cooldown_until": null
  }
}
```

Phase A returns `investigator_status: 'not-implemented'` and `auto_merged_24h: 0`. Phase B/D fill those in.

## Web UI — `/bugs` page

Source: `web/src/pages/BugsPage.tsx`. Sidebar entry under the "System" group between "System Health" and "Setup".

**Layout:** header strip + filter row + table on the left; side panel for selected row on the right.

- **Filters:** status (all / new / investigating / proposed / resolved / wont-fix), source (all / bridge / agent / web-ui / sync / bug-investigator), severity (all / low / medium / high).
- **Table columns:** severity badge, source, error name + message, occurrence count, last-seen relative time, status badge.
- **Side panel:** error / where (top frame) / stats / context (formatted JSON) / **Investigation** — live render of the latest `bug_investigations` row when present (root_cause + confidence Badge + files-to-change list + collapsed `<details>` for `suggested_patch` + Re-investigate button), or a "agent will pick this up on the next tick" placeholder when null / recent occurrences (last 50) / Mark resolved + Won't fix buttons.
- **Polling:** 30 s via TanStack Query while the tab is visible.

EP-28 density tokens throughout (`px-3 py-1.5 text-xs` for table rows; `px-3 py-2 text-xs font-semibold` for headers; CSS variables only — `var(--bg)`, `var(--fg)`, `var(--muted)`, etc.).

The Investigation tab in Phase B renders the structured `bug_investigations` row when one exists. The Re-investigate button (POST `/api/bugs/:id/reinvestigate`) resets `status='new'`, clears `last_investigation_id`, and zeroes `investigation_attempts` so the next agent tick picks the row up.

## Kill-switch env vars (documented now, gated later)

Three env vars documented in `CLAUDE.md` Environment block; bridge boot reads two of them and prints one stderr line so future phases lean on the contract without a doc-update commit.

| Var | Default | Phase | What it gates |
|-----|---------|-------|---------------|
| `BUG_INVESTIGATOR_ENABLED` | `1` | B | When `0`, Phase B's `BugInvestigatorAgent` won't register. Phase A captures bugs regardless. |
| `BUG_AUTO_MERGE` | `0` | D | When `1`, Phase D's auto-merge gate may fire. Even with this on, the seven-condition gate must pass. |
| `BUG_INVESTIGATOR_MAX_PER_HOUR` | `10` | B | Phase B brain-budget cap; routes through `src/services/brain/budget.ts`. |

Bridge boot prints (every restart):

```
[Bugs] config: BUG_INVESTIGATOR_ENABLED=1 BUG_AUTO_MERGE=0
```

Smoke § 11g asserts all three vars stay documented in `CLAUDE.md` (doc-drift gate).

## Smoke gates

`scripts/smoke-bridge.sh` § 11 — seven assertions on the bug-capture loop:

| # | Check |
|---|-------|
| 11a | `POST /api/bugs/report` first-call returns `is_new:true`. Per-run-unique error-name avoids fingerprint stickiness across runs. |
| 11b | Same payload again → `is_new:false`, `occurrence_count:2`. UPSERT, not double-insert. |
| 11c | `/api/system-health.bugs.total >= 1` after capture. |
| 11d | `source='bug-investigator'` round-trips. Recursion-guard placeholder. |
| 11e | `GET /api/bugs` lists captured rows with `total >= 2`. |
| 11f | Denied origin gets NO CORS headers on `/api/bugs/report`. |
| 11g | `BUG_INVESTIGATOR_ENABLED`, `BUG_AUTO_MERGE`, `BUG_INVESTIGATOR_MAX_PER_HOUR` all documented in `CLAUDE.md`. |

`scripts/smoke-ui.mjs` § 19 — three assertions on the `/bugs` page:

- Page renders (`[data-test="bugs-page"]` present).
- Sidebar entry visible (`a[href="/bugs"]` present).
- Either the table or the empty state is rendered.

> **Known harness flake.** `smoke-ui § 19` is currently flaky in headless Playwright — the page renders perfectly in real Chrome (verified by DevTools snapshot showing all captured bugs, filters, and side panel) but Playwright's `page.goto` times out repeatedly. Suspected cause: TanStack Query's 30s polling interferes with `domcontentloaded` / `load` / `commit` wait events when multiple polling pages are visited in sequence. Selectors are correct against the real DOM. Fix tracked as a follow-up.

## Verification done at ship time

- `npm run typecheck` clean (root + web).
- 45 new vitest cases (10 schema migration + 19 fingerprint + 14 routes + 2 captureBug-via-route).
- `SKIP_BRAIN_LIVE_CALL=1 npm run smoke:bridge` — 61 passed, 0 failed.
- End-to-end synthetic uncaughtException via `GET /internal/throw-uncaught?msg=...` (dev-only test fixture) → bug row written, bridge survived, stderr line printed.
- Real Chrome browse of `/bugs` — DevTools snapshot confirmed 7 captured bugs + filters + sidebar entry + side panel functional.

## Phase B/C scope

Phase B + Phase C are **live**. Phase 77 (customer-repo fixes) is the only sketched stage.

### Phase B (75) — `BugInvestigatorAgent` + Brain integration ✅ shipped 2026-05-31

Live since Phase 75. Always-on agent polls:

```sql
SELECT * FROM bugs
 WHERE status='new'
   AND source != 'bug-investigator'
   AND investigation_attempts < 3
 ORDER BY severity DESC, last_seen_at DESC
 LIMIT 1
```

For each bug: gathers evidence (stack + git log + ADR-027 v2 blast-radius + brain recall of similar `bug_investigations`), calls `runDecision()` through the `bug-investigator` brain-budget bucket (`BUG_INVESTIGATOR_MAX_PER_HOUR=10` default), writes a `bug_investigations` row, increments `investigation_attempts`. **No PR generation** — Phase B is AI-assisted triage, period.

UI: `/bugs` page Investigation tab now renders the live investigation block (root cause, confidence Badge, files-to-change list, collapsed `<details>` for the suggested patch) plus a Re-investigate button that resets `status='new'` and clears `last_investigation_id` so the agent picks the row up on its next tick. Killswitch smoke (`scripts/smoke-bug-killswitch.sh`) asserts `BUG_INVESTIGATOR_ENABLED=0` → agent absent from `/api/agents/health`.

Full agent reference: [bug-investigator-agent.md](./bug-investigator-agent.md).

### Phase C (76) — `BugResolverAgent` ✅ shipped 2026-06-01 — re-scoped

Live since Phase 76. Re-scoped from "Draft-PR generation" to **"WI fixes its OWN source code, local-commit only"**.

The agent is **manually triggered** — no polling. User clicks "Resolve this" on a `proposed` bug → `POST /api/bugs/:id/resolve-attempt` flips status `'proposed'` → `'resolving'` and enqueues the agent. The agent:

1. Loads the latest `bug_investigations` row (Phase B output).
2. Classifies every file in `files_to_change` via `src/services/bugs/path-classifier.ts` — binary `ALLOWED` / `BLOCKED`. Sibling-repo paths (`./repos/example-service/*`, `./repos/operations/*`) and outside-repo paths (`~/.claude/**`, `/tmp`, `..` escapes) fail BLOCKED → `'unable-to-resolve'`.
3. `git apply --check` the suggested patch in the WI repo root.
4. `git apply` + `npm run typecheck` (root + `web/` if web files were touched). Typecheck failure → `git checkout -- .` revert + `'unable-to-resolve'`.
5. `git commit -a -m "auto-fix: bug #<id> — <root_cause first 60>"` on the **current branch**. **NEVER pushes.**
6. Writes one `bug_resolutions` audit row regardless of outcome (commit_sha on success, failure_reason on failure).

UI: `/bugs` BugDetailPanel renders a "Resolve this" button (Wand2 icon, primary variant) on `'proposed'` bugs. Status badge variants extended for `'resolving'` (info, animated), `'auto-resolved'` (success, with commit SHA tooltip + `git push` reminder), `'unable-to-resolve'` (danger, with failure reason). The detail query polls every 2s while `status='resolving'` and stops once terminal.

**Killswitch:** `BUG_RESOLVER_ENABLED=0` default — opt-in. Agent does NOT register, endpoint returns 400 `resolver_disabled`. Smoke gate: `scripts/smoke-bug-resolver-killswitch.sh` (4 assertions).

**Phase 76 NEVER touches the customer repos under `./repos/`.** That's Phase 77 territory.

Full agent reference: [bug-resolver-agent.md](./bug-resolver-agent.md).

### Phase 77 — Customer-repo fixes (out of scope for Phase 76)

Phase 76 was originally going to be "Phase D — auto-merge". The 2026-05-31 re-scope split that into two distinct concerns:

- **Phase 76 (this — shipped):** WI fixes WI's own bugs, locally, on the current branch. No remote, no PR.
- **Phase 77 (future):** WI fixes bugs found IN its customers (`./repos/example-service`, `./repos/operations`) via PR generation against THOSE repos. Different scope, different safety story (those repos have their own CI / approval gates / production deploys), different killswitch (`BUG_AUTO_MERGE=0`).

The two killswitches are independent — `BUG_RESOLVER_ENABLED=1` does NOT enable `BUG_AUTO_MERGE`. The expected default for a long time is `BUG_RESOLVER_ENABLED=1` (after soak), `BUG_AUTO_MERGE=0`.

## Operational lessons (carried forward)

1. **Slot collision risk is real.** Tier 2 model_config shipped to v52 while Phase 74 was paused. PLAN.md frontmatter `slot_change_log` is the new pattern for documenting forced renumbers.
2. **Capture must be best-effort.** Every capture path is wrapped in try/catch. A capture failure must NEVER crash the originating surface.
3. **Severity is a query, not a guess.** All severity decisions go through `bug_occurrences` ring-buffer queries.
4. **Source is part of the fingerprint.** Same name+message+frame from different surfaces produces different rows.
5. **The recursion guard ships in the schema.** `bugs.source` CHECK enum includes `bug-investigator`; Phase B uses `WHERE source != 'bug-investigator'` without a migration.
6. **Capture overrides Node's exit-on-uncaught default.** The capture loop is more useful than a crashed bridge.
7. **`/internal/throw-uncaught` stays.** PLAN.md called for removal in Phase B; we left it in (gated behind `NODE_ENV !== 'production'`) because Phase B's killswitch smoke will use it anyway.

## References

- [ADR-030 — Self-Healing Bug Loop](../adr/adr-030-self-healing-bug-loop.md) — full design + Review Findings 2026-05-30
- [bug-investigator-agent.md](./bug-investigator-agent.md) — Phase B agent reference (polling, evidence, brain budget, killswitch)
- [bug-resolver-agent.md](./bug-resolver-agent.md) — Phase C agent reference (path classifier, apply pipeline, audit row, killswitch)
- [api-reference/bugs.md](../api-reference/bugs.md) — REST API reference (incl. `/api/bugs/:id/reinvestigate`, `/api/bugs/:id/resolve-attempt`)
- [web-ui/bugs-page.md](../web-ui/bugs-page.md) — UI reference
- [database-schema.md](./database-schema.md#self-healing-bug-capture-v53) — schema v53 + v54 + v55 + v56 detail
- `.planning/phases/74-adr-030-phase-a-self-healing-capture/` — Phase A PLAN.md + 6 SUMMARY.md
- `.planning/phases/75-adr-030-phase-b-bug-investigator/` — Phase B PLAN.md + 7 SUMMARY.md
- `.planning/phases/76-bug-resolver-agent/` — Phase C PLAN.md + SUMMARY.md
- `memory/project_adr030_phase_a.md` + `memory/project_adr030_phase_b.md` + `memory/project_adr030_phase_c.md` — auto-memory; lessons + commit lists
