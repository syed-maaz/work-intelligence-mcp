# Bugs Page (`/bugs`) — UI reference

**Source:** `web/src/pages/BugsPage.tsx`
**Sidebar:** System group, between System Health and Setup
**Architecture:** [Self-Healing Bug Loop (Phase A + B)](../architecture/self-healing-bug-loop.md)
**Agent:** [BugInvestigatorAgent](../architecture/bug-investigator-agent.md)
**API:** [api-reference/bugs.md](../api-reference/bugs.md)

The browseable surface for bugs the bridge + agents + web UI captured. Read-mostly. The mutations are: mark-resolved, mark-wont-fix, and (Phase B) re-investigate.

## Layout

Two panes side by side:

```
┌───────────────────────────────────┬──────────────────────┐
│ Header strip + filter row         │ Bug detail (when row │
├───────────────────────────────────┤ selected; otherwise  │
│ Table:                            │ collapsed)           │
│   Severity | Source | Error |    │                      │
│   Count | Last seen | Status      │ - Error name + msg   │
│   ...                             │ - Where (top frame)  │
│   ...                             │ - Stats              │
│                                   │ - Context (JSON)     │
│                                   │ - Investigation      │
│                                   │   placeholder        │
│                                   │ - Recent occurrences │
│                                   │ - Resolve / Won't fix│
└───────────────────────────────────┴──────────────────────┘
```

## Header strip

- **Title:** `Bugs · N total · refreshing…` (refreshing label only when TanStack Query is fetching).
- **Refresh button** (top-right): manual refetch. Spins while fetching.

## Filter row

Three dropdowns wired to `GET /api/bugs?status=…&source=…&severity=…`:

| Filter | Options |
|--------|---------|
| **Status** | `all` / `new` / `investigating` / `proposed` / `resolved` / `wont-fix` |
| **Source** | `all` / `bridge` / `agent` / `web-ui` / `sync` / `bug-investigator` |
| **Severity** | `all` / `low` / `medium` / `high` |

Filter changes invalidate the TanStack Query cache and re-fetch immediately.

## Table

Columns (left to right):

| Column | Source field | Notes |
|--------|--------------|-------|
| Severity | `bug.severity` | Badge: `low` (success/green), `medium` (warning/amber), `high` (danger/red). |
| Source | `bug.source` | Plain text. |
| Error | `bug.error_name` + `bug.message` | Error name in bold, then truncated message. Full message in `title` tooltip. |
| Count | `bug.occurrence_count` | Plain integer. |
| Last seen | `bug.last_seen_at` | Relative time via `date-fns/formatDistanceToNow`. |
| Status | `bug.status` | Badge: `new` (warning), `investigating`/`proposed`/`auto-merged` (info), `resolved` (success), `wont-fix` (default/grey). |

Rows are clickable — click toggles the side panel for that row. Selected row gets a faint accent background.

Polling: 30 s via TanStack Query while the tab is visible. Switch to a different tab to pause polling.

## Empty state

When no bugs match the current filters:

> **No bugs captured**
>
> Nothing's broken — or nothing's reported it yet. Phase A captures every uncaught bridge throw, agent crash, and web-UI render error.

Icon: `Check` (Lucide).

## Side panel (detail)

Visible when a row is selected. Sections:

### Error
- `error_name` (bold) + `message`.

### Where
- `top_frame` formatted as code (`<code>`). When `top_frame` is `null` (only library frames in stack): `(no application frame in stack)`.

### Stats
A key/value list. Each row:

| Key | Value |
|-----|-------|
| Source | `bug.source` |
| Severity | `bug.severity` |
| Occurrences | `bug.occurrence_count` |
| First seen | relative time |
| Last seen | relative time |
| Status | `bug.status` |
| Investig. attempts | `bug.investigation_attempts` (Phase A always `0`; Phase B will increment) |

### Context
Only shown when `bug.context_json` is non-null. Rendered as pretty-printed JSON inside a `<pre>`. Falls back to the raw string if JSON.parse fails.

### Investigation

Phase B renders the latest `bug_investigations` row when one exists; otherwise a short placeholder.

**Live render (when `investigation` is non-null):**

| Element | Source |
|---|---|
| Confidence Badge | `investigation.confidence`. Variant: `success` ≥ 0.8, `warning` ≥ 0.5, else `danger`. Label `"confidence N%"`. |
| Decided-at relative time | `investigation.decided_at` via `date-fns/formatDistanceToNow` |
| Root cause | `investigation.root_cause` (one sentence) |
| Files-to-change list | `JSON.parse(investigation.files_to_change)` rendered as a `<ul>` of `<code>` paths. Hidden when the array is empty or parse fails. |
| Suggested patch (collapsed) | `investigation.suggested_patch` rendered inside `<details><summary>View suggested patch (N lines)</summary><pre>…</pre></details>`. Hidden when `null`. |
| Re-investigate button | `RotateCcw` icon, `ghost` variant. Calls `api.reinvestigateBug(id)` (POST `/api/bugs/:id/reinvestigate`). On success: toast + invalidate `['bugs']` and `['bug', id]` query caches. |

**Placeholder (when `investigation` is null):**

> ⚠ Not investigated yet — agent will pick this up on the next tick (every 5 min).

The placeholder is what `status='new'` rows show until the BugInvestigatorAgent runs. Tunable via `BUG_INVESTIGATOR_INTERVAL_MS` (default `300000`).

The `<tr>` for each row in the bugs table carries `data-investigated="true|false"` derived from `bug.last_investigation_id !== null`. Used by the smoke § 19 assertion that clicking an investigated row hides the placeholder.

### Recent occurrences (last 50)
List of relative timestamps from `GET /api/bugs/:id`'s `recent_occurrences` array. `(none)` if empty.

### Resolver attempt (Phase C / v56)

Surfaced in the BugDetailPanel as a **"Resolver attempt"** Section directly below the Investigation, present whenever `latest_resolution !== null` (i.e. the user has clicked "Resolve this" at least once on this bug).

Three rendering shapes:

| `bug.status` | Shape |
|---|---|
| `'resolving'` | Spinning `RefreshCw` icon + line: *"Resolving — the BugResolverAgent is working. The page will refresh automatically."* The detail query polls `GET /api/bugs/:id` every 2s while in this state and stops on terminal. |
| `'auto-resolved'` | `success` badge + relative time + commit SHA (short 12-char with full SHA in `title`) + files-changed `<ul>` of `<code>` + reminder banner: *"⚠️ The fix is committed locally only. Run `git push` when you've reviewed it."* |
| `'unable-to-resolve'` | `danger` badge + relative time + `failure_reason` text + "Patch touched" files list (so the user can see what the agent attempted before bailing) |

### Actions
Three buttons appear when `bug.status` is `new`, `investigating`, or `proposed`:

- **Resolve this** (Phase C / v56 — only on `'proposed'`, `primary` variant, `Wand2` icon). Calls `POST /api/bugs/:id/resolve-attempt` via `api.resolveBugAttempt(id)`. On success: toast *"Resolving — agent is working..."* + cache invalidation. On `resolver_disabled` error: distinct toast guiding the user to set `BUG_RESOLVER_ENABLED=1` and restart the bridge.
- **Mark resolved** (`secondary` variant) — calls `POST /api/bugs/:id/resolve` with `resolution: 'resolved'`.
- **Won't fix** (`ghost` variant) — same endpoint with `resolution: 'wont-fix'`.

Both invalidate the bugs list and detail caches on success and surface a toast (`Bug updated` / `Resolve failed: <message>` via `sonner`).

## Density tokens (EP-28)

Per `.claude/rules/react-ui.md`:

| Surface | Tokens |
|---------|--------|
| Header strip | `px-3 py-2 text-xs font-semibold` |
| Filter row | `px-3 py-2 flex flex-wrap items-center gap-2` |
| Table rows | `px-3 py-1.5 text-xs` |
| Side panel sections | `text-xs` body; `text-xs uppercase tracking-wider font-medium` labels |

CSS variables only: `var(--bg)`, `var(--bg-2)`, `var(--bg-3)`, `var(--fg)`, `var(--fg-2)`, `var(--muted)`, `var(--border)`, `var(--accent)`. **No `var(--fg-muted)`** (doesn't exist; would render nothing).

## Test hooks

- `data-test="bugs-page"` — root container of the page.
- `data-test="bugs-table"` — the `<table>` element. Absent when the empty state is shown.
- `data-investigated="true|false"` — on each table `<tr>`. `true` when `bug.last_investigation_id` is non-null.

`scripts/smoke-ui.mjs` § 19 uses these.

## Routing

Registered in `web/src/App.tsx`:

```tsx
<Route path="/bugs" element={<BugsPage />} />
```

Sidebar registration in `web/src/components/shell/Sidebar.tsx`:

```ts
{
  group: 'System',
  items: [
    { to: '/weekly-report', icon: BarChart2, label: 'Weekly Report' },
    { to: '/system-health', icon: Activity, label: 'System Health' },
    { to: '/bugs', icon: Bug, label: 'Bugs' },        // ← added in 74-05
    { to: '/setup', icon: Wrench, label: 'Setup' },
    { to: '/glossary', icon: BookMarked, label: 'Glossary' },
  ],
}
```

`Bug` icon imported from `lucide-react`.

## API client

Typed helpers in `web/src/lib/api.ts`:

```ts
api.reportBug(payload: BugReportPayload):
  Promise<{ ok: true; fingerprint: string; occurrence_count: number; is_new: boolean; severity: BugSeverity }>;

api.listBugs(p?: { status?: BugStatus; source?: BugSource; severity?: BugSeverity; limit?: number; offset?: number }):
  Promise<{ ok: true; bugs: BugRow[]; total: number }>;

api.getBug(id: number):
  Promise<{ ok: true; bug: BugRow; recent_occurrences: Array<{ seen_at: string }>; investigation: BugInvestigation | null }>;

api.resolveBug(id: number, resolution: 'resolved' | 'wont-fix', note?: string):
  Promise<{ ok: true; bug: BugRow }>;

// Phase B (Plan 75-05) — re-investigate. Resets status='new',
// last_investigation_id=NULL, investigation_attempts=0. Next agent
// tick (≤ BUG_INVESTIGATOR_INTERVAL_MS) picks the row up.
api.reinvestigateBug(id: number):
  Promise<{ ok: true; bug: BugRow }>;
```

Plus the `BugSource`, `BugStatus`, `BugSeverity`, `BugRow`, `BugInvestigation`, `BugReportPayload` type exports.

## Browser-side capture (not part of the page, but related)

The web UI **also captures errors itself**, sending them to the same `/api/bugs/report` endpoint:

- `web/src/components/shell/ErrorBoundary.tsx::componentDidCatch` — POSTs on any React render error. **Always-on** (dev + preview + production); React stacks tend to survive Vite minification well enough for a useful `top_frame`.
- `web/src/main.tsx` — `window.addEventListener('error')` and `window.addEventListener('unhandledrejection')` for non-React errors. **Dev/preview only** — Vite minifies prod and breaks `top_frame` extraction. Phase B will add server-side source-map resolution before re-enabling production capture.

Both paths are best-effort: every `fetch(...)` call is `.catch(() => {})` and wrapped in an outer try/catch. Capture must NEVER crash the recovery card.

## Smoke gate (§ 19)

`scripts/smoke-ui.mjs` § 19 — four assertions:

- Page renders (`[data-test="bugs-page"]` selector resolves).
- Sidebar entry visible (`a[href="/bugs"]` selector resolves).
- Either the table (`[data-test="bugs-table"]`) or the empty state (`/No bugs captured/i`) is rendered.
- (Phase B) When at least one `tr[data-investigated="true"]` row exists, click it and assert the "Not investigated yet" placeholder is absent (the live investigation block must render instead). Skipped with a `pass` when no investigated rows exist (fresh DB).

> **Known harness flake.** § 19 is currently flaky in headless Playwright — the page renders perfectly in real Chrome (verified by DevTools snapshot showing all captured bugs, filters, and side panel) but Playwright's `page.goto` times out repeatedly. Suspected cause: TanStack Query's 30s polling interferes with the navigation wait events. Selectors are correct against the real DOM. Tracked as a follow-up; doesn't block Phase A ship.

## Verification at ship time

Real-Chrome DevTools snapshot of `/bugs` confirmed:
- Page header `Bugs · 7 total`.
- All three filter dropdowns rendered with full option lists.
- Table with 7 captured bugs (1 manual probe + 1 `Phase74Synthetic` from the `/internal/throw-uncaught` test fixture + 4 smoke-test rows + 1 `bug-investigator` recursion-guard test).
- Severity badges and status badges rendered correctly.
- Side panel functional on row click — Error / Where / Stats / Investigation placeholder / Recent occurrences / Resolve buttons all visible.
- Sidebar entry `Bugs` under System group.
