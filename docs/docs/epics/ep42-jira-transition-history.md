---
sidebar_position: 42
title: EP-42 Jira Intelligence Layer
---

# EP-42: Jira Intelligence Layer

> **Merged epic** — absorbs EP-47 (Jira Intelligence Layer, designed Apr 2026). EP-47 is archived.

| Field | Value |
|-------|-------|
| **Status** | ✅ Done (EP-42-1 through EP-42-5 ✅, EP-42-7 endpoints ✅ — EP-42-6/8/9/10 deferred → EP-48) |
| **Priority** | High |
| **Complexity** | Large (6–8 days) |
| **Blocked By** | EP-43 recommended (code graph — blast radius degrades gracefully without it) |
| **Schema version** | v23 ✅ — `jira_transitions` + `ticket_learnings` + new columns on `jira_analysis` / `jira_issues`; `jira_issue_cache` renamed to `jira_issues` |
| **Supersedes** | EP-29 (Jira Deep Analysis) — extends, does not break existing analysis |

## Summary

Jira is currently three disconnected surfaces:
- **Saturn Board** (RapidBoard scrape) and **My Issues** (separate page) — no unified view
- **Per-ticket AI analysis** (EP-29) — 3 Claude calls, text-only, no memory of past work
- **No transition tracking** — tickets have only current status; cycle time, velocity, and blocker detection are impossible

This epic merges and upgrades everything into a single **Jira Intelligence Layer**:

1. **Transition history** — `jira_transitions` table records every status change; enables cycle time, velocity, stuck detection
2. **Unified list + filter chips** — one page, one endpoint, chips for Mine / Saturn / Sprint / Backlog / Epic
3. **Hierarchical ticket fetch** — lazy-load epic children → linked issues on demand
4. **example-service-aware analysis** — code impact (rg on repos/example-service), effort baseline from cycle time history, missing-info detection
5. **Solution proposal engine** — Claude proposes root cause + files to change + test strategy; generates draft PR via `gh`
6. **Blast radius alerting** — flags untested files in the solution tab
7. **Implementation memory** — `ticket_learnings` table; resolved tickets store how they were solved; injected into future analyses

---

## Architecture Decisions

### Transition History — Two Paths (MCP vs Browser Scraper)

> **April 2026 update**: The  Jira MCP Server (`jira`) is now available and returns authoritative transition timestamps via `jira_get_issue_dates`. This changes the transition detection approach depending on which data source is active. See [EP-46](./ep46-jira-mcp-adapter) and [ADR-006](../adr/adr-006-jira-mcp-fallback).

Never update, only insert. Schema and query layer are identical for both paths.

#### Path A: MCP Active (`JIRA_SOURCE=mcp` or `auto` with MCP succeeding)

`jira_get_issue_dates` returns the full status-change history with actual Jira timestamps:

```typescript
// jira_get_issue_dates response shape:
{
  statusChanges: [
    { from: 'Open', to: 'In Progress', timestamp: '2026-04-10T09:12:00.000+0000' },
    { from: 'In Progress', to: 'Done', timestamp: '2026-04-15T14:33:00.000+0000' },
  ]
}
```

For each status change in the response, call `recordTransition()` with the **actual** Jira timestamp as `transitioned_at`. This means cycle times are accurate even for tickets that were never synced during a particular status.

```typescript
for (const change of dates.statusChanges) {
  recordTransition(db, issue.key, projectKey,
    change.from, change.to, new Date(change.timestamp)
  );
}
```

#### Path B: Browser Scraper Active (`JIRA_SOURCE=browser` or MCP fallback)

The Jira DOM scrape doesn't expose transition timestamps — only current status. Diff detection on sync:

```typescript
const lastTransition = getLastTransition(db, issue.key);
if (lastTransition?.to_status !== issue.status) {
  recordTransition(db, issue.key, projectKey, lastTransition?.to_status ?? null, issue.status);
}
```

`transitioned_at` defaults to `datetime('now')` — this is "status changed at time-of-sync", an approximation. Cycle times are less accurate (bounded by sync frequency, typically 15 minutes).

**Practical result**: MCP path gives true cycle times from Jira's audit log. Browser path gives approximate cycle times — still useful for trends, just not sub-hour accurate.

**Unique constraint** on `(issue_key, to_status, transitioned_at)` prevents duplicates. For the MCP path, use the actual Jira timestamp (seconds precision); for the browser path, the default `datetime('now')` ensures each sync's detected transition has a unique timestamp.

**Cycle time definition**: duration from first `In Progress` → first `Done`, in hours. `NULL` if ticket hasn't reached Done yet.

---

### Unified List — Single Endpoint, Client-Side Filter

Each filter maps to a different Jira data source. With the MCP path, all filters use JQL via `jira_search` — no separate scrapers needed per board type. With the browser scraper path, scrapers stay specialized (RapidBoard DOM ≠ My Issues DOM). Unification is at the **API surface and UI layer**:

```
GET /api/jira/issues?filter=mine|saturn|sprint|backlog
```

Returns `{ issues, cached_at, isRefreshing, stale }` — last cached data always present, even while refresh runs. Client shows a stale banner when `cached_at > 5 minutes ago`.

**JQL mapping (MCP path)**:
```
mine     → assignee = currentUser() ORDER BY updated DESC
saturn   → project = BDS AND component = Saturn ORDER BY updated DESC
sprint   → project = BDS AND sprint in openSprints() ORDER BY updated DESC
backlog  → project = BDS AND sprint is EMPTY ORDER BY updated DESC
```

---

### Hierarchical Fetch — Two Paths (MCP vs Browser)

**MCP path**: Use JQL to fetch epic children and linked issues — no Playwright navigation needed.

```typescript
// scrapeEpicChildren() replacement for MCP path:
async function fetchEpicChildrenMcp(epicKey: string): Promise<JiraIssue[]> {
  // jira_search with parent JQL
  return jiraSearch(`parent = ${epicKey} ORDER BY updated DESC`);
}

// scrapeLinkedIssues() replacement for MCP path:
async function fetchLinkedIssuesMcp(issueKey: string): Promise<LinkedIssue[]> {
  const detail = await jiraGetIssue(issueKey, { fields: 'issuelinks' });
  return detail.issuelinks ?? [];
}
```

No `withJiraLock()` needed — MCP calls are stateless HTTP, not a shared browser session. Multiple callers can run concurrently.

**Browser scraper path** (unchanged):

A sprint board has 40–80 tickets. Eagerly fetching all epic children + linked issues = 80–200 additional Playwright navigations = 2+ minutes. Lazy fetch: user expands one epic = 1 nav = instant feel. Each level cached in DB after first load. Respects `withJiraSyncLock` / `withJiraReadLock` (see ARCH-42-B).

---

### Effort Signal — Cycle Time as Baseline

Instead of vibes-based effort guessing, use real data:

```
getLastTransitionsForSimilarTickets(db, keywords)
→ FTS5 search on jira_issues.summary for similar titles
→ get their cycle_time_hours from jira_transitions
→ median cycle time = effort baseline injected into solution prompt
```

---

### Implementation Memory — `ticket_learnings` Flywheel

Each resolved ticket stores:
- What the solution was (markdown)
- Which files were changed
- Traps hit (freeform)
- Actual cycle time (from `jira_transitions` if available)
- A 1536-dim embedding (once EP-37 is available)

On analysis of a new ticket, FTS5 (or semantic) search finds similar past tickets and injects them into the solution prompt:
> "Note: Similar ticket PROJ-2341 was resolved by updating `session.ts` timeout from 5s to 15s. Took 2 days. Trap: unit tests mock the timer."

---

## Cost & Performance Budget

> Target: sub-$0.05 per analyzed ticket; sub-200ms for all read endpoints; zero browser wait for on-demand hierarchy when sync is idle.

### AI Call Budget per Ticket Analysis

| Call | Model | Est. Input Tokens | Est. Output Tokens | Est. Cost |
|------|-------|------------------|--------------------|-----------|
| Call 1: Summary (existing) | Haiku | ~2,000 | ~400 | $0.0006 |
| Call 2: Effort (existing) | Haiku | ~1,500 | ~200 | $0.0004 |
| Call 3: Explanation (existing) | Haiku | ~1,500 | ~300 | $0.0005 |
| Call 4: Code Impact (new) | Haiku | ~3,000 | ~300 | $0.0009 |
| Call 5: Solution Proposal (new) | Sonnet | ~4,000 | ~600 | $0.018 |
| **Total per ticket** | | | | **~$0.020** |

5 calls run in `Promise.allSettled` — wall-clock time = longest single call (~3–5s), not sum.

### Cost Reduction Levers

1. **Cache analysis results** — `jira_analysis` table already caches; re-analyze only when ticket status changes or user explicitly requests. Most tickets are analyzed once.
2. **Skip Code Impact when file count > 15** — prevents expensive Haiku calls on noisy `rg` results (see GAP-40-E → ARCH-42-E).
3. **Solution call only on user click** — don't auto-run `proposeSolution()` on page load; trigger on "Analyze" button click. Avoids Sonnet cost for tickets the user never opens.
4. **Learnings context cap** — inject at most 3 past learnings into the solution prompt. Additional learnings add cost with diminishing returns.
5. **Notebook freshness check before inject** — don't inject notebook into analysis calls (only into chat). Analysis has its own context; mixing notebook into analysis adds ~3k tokens × 5 calls = ~15k extra tokens/ticket ≈ $0.004 wasted.

### DB Query Performance

All hot-path queries are covered by existing indexes. Verify these exist in migration v23:

```sql
-- Transition analytics (velocity, stuck detection)
CREATE INDEX idx_jira_trans_project ON jira_transitions(project_key, transitioned_at);
CREATE INDEX idx_jira_trans_status  ON jira_transitions(to_status);

-- Learning lookup (FTS already covers summary search)
CREATE INDEX idx_learnings_project ON ticket_learnings(project_key);

-- Ensure FTS5 table exists for jira_issues (needed for getCycleTimesForSimilarTickets)
-- If not already created in prior migrations, add to v23
```

`getWeeklyVelocity()` aggregates 8 weeks of transitions — runs in &lt;10ms on &lt;10k rows. No materialized view needed until &gt;100k transitions.

---

## DB Schema (Migration v22 → v23)

```typescript
if (currentVersion < 23) {
  db.exec(`
    -- Transition history (EP-42 original)
    CREATE TABLE IF NOT EXISTS jira_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_key TEXT NOT NULL,
      project_key TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      transitioned_at TEXT NOT NULL DEFAULT (datetime('now')),
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(issue_key, to_status, transitioned_at)
    );
    CREATE INDEX IF NOT EXISTS idx_jira_trans_issue   ON jira_transitions(issue_key);
    CREATE INDEX IF NOT EXISTS idx_jira_trans_project ON jira_transitions(project_key, transitioned_at);
    CREATE INDEX IF NOT EXISTS idx_jira_trans_status  ON jira_transitions(to_status);

    -- Implementation memory (EP-47 original)
    CREATE TABLE IF NOT EXISTS ticket_learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_key TEXT NOT NULL UNIQUE,
      project_key TEXT NOT NULL,
      summary TEXT NOT NULL,
      solution TEXT NOT NULL,
      files_changed TEXT,
      traps TEXT,
      cycle_time_hours REAL,
      learned_at TEXT NOT NULL DEFAULT (datetime('now')),
      embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_learnings_project ON ticket_learnings(project_key);

    -- New columns on existing tables
    ALTER TABLE jira_analysis ADD COLUMN code_impact TEXT;
    ALTER TABLE jira_analysis ADD COLUMN solution TEXT;
    ALTER TABLE jira_analysis ADD COLUMN blast_radius TEXT;
    ALTER TABLE jira_issues ADD COLUMN linked_issues TEXT;
    ALTER TABLE jira_issues ADD COLUMN parent_key TEXT;
  `);
  db.prepare('UPDATE schema_version SET version = 23').run();
}
```

---

## New Queries — `src/db/queries.ts`

### Transition history

```typescript
export interface JiraTransition {
  id: number;
  issue_key: string;
  project_key: string;
  from_status: string | null;
  to_status: string;
  transitioned_at: string;
}

export function getLastTransition(db: Database, issueKey: string): JiraTransition | null
export function recordTransition(
  db: Database,
  issueKey: string,
  projectKey: string,
  fromStatus: string | null,
  toStatus: string
): void

// Hours from first In Progress to first Done; null if not done yet
export function getCycleTime(db: Database, issueKey: string): number | null

export interface VelocityStats {
  project_key: string;
  week_of: string;
  completed_count: number;
  avg_cycle_time_hours: number;
  stuck_count: number;  // same status > 3 days
}
export function getWeeklyVelocity(db: Database, projectKey: string, weeks?: number): VelocityStats[]

// For effort signal: find similar tickets by FTS on title, return their cycle times
export function getCycleTimesForSimilarTickets(
  db: Database,
  keywords: string[],
  limit?: number
): Array<{ issue_key: string; summary: string; cycle_time_hours: number }>
```

### Implementation memory

```typescript
export interface TicketLearning {
  id: number;
  issue_key: string;
  project_key: string;
  summary: string;
  solution: string;
  files_changed: string[] | null;
  traps: string | null;
  cycle_time_hours: number | null;
  learned_at: string;
  embedding: Buffer | null;
}

export function saveLearning(db: Database, learning: Omit<TicketLearning, 'id' | 'learned_at'>): void
// INSERT OR REPLACE

export function getLearning(db: Database, issueKey: string): TicketLearning | null

export function findSimilarLearnings(db: Database, keywords: string[], limit?: number): TicketLearning[]
// FTS5 on summary; if embeddings available, semantic rerank
```

---

## New Connector Methods — `src/connectors/jira-browser.ts` and `src/connectors/jira-adapter.ts`

### Transition detection (wired into both paths after each issue upsert in sync)

**Browser scraper path** — diff-based detection (unchanged):
```typescript
const lastTransition = getLastTransition(db, issue.key);
const lastStatus = lastTransition?.to_status ?? null;
if (lastStatus !== issue.status) {
  recordTransition(db, issue.key, issue.projectKey, lastStatus, issue.status);
}
```

**MCP path** — authoritative history from `jira_get_issue_dates` (new):
```typescript
// Called inside JiraMcpAdapter.fetchMessages() after fetching each issue
const dates = await jiraGetIssueDates(issue.key, { include_status_changes: true });
for (const change of dates.statusChanges ?? []) {
  recordTransition(db, issue.key, projectKey,
    change.from, change.to, new Date(change.timestamp)
  );
  // recordTransition must accept optional transitioned_at: Date param
  // to use actual Jira timestamp instead of datetime('now')
}
```

Update `recordTransition()` signature in `src/db/queries.ts`:
```typescript
export function recordTransition(
  db: Database,
  issueKey: string,
  projectKey: string,
  fromStatus: string | null,
  toStatus: string,
  transitionedAt?: Date  // NEW: actual timestamp; defaults to now() when absent
): void
```

### Lazy hierarchy fetch (browser scraper path only)

```typescript
// Called on-demand when user expands an epic row in UI — browser scraper path
scrapeEpicChildren(epicKey: string): Promise<JiraIssue[]>
// Opens jira/browse/:epicKey, extracts child issue table
// Caches: UPDATE jira_issues SET parent_key = epicKey WHERE key IN (children)

// Called on-demand when user expands linked issues section — browser scraper path
scrapeLinkedIssues(issueKey: string): Promise<{ type: string; key: string; title: string }[]>
// Opens jira/browse/:issueKey, extracts "Issue Links" section
// Stores as JSON in jira_issues.linked_issues
```

Both respect `withJiraLock()` mutex (browser path only; MCP path uses direct API calls).

> **When `JIRA_SOURCE=auto` (default)**: the lazy hierarchy endpoints (`/api/jira/epic/:key/children`, `/api/jira/issue/:key/links`) should call through `createJiraDataSource()` which internally uses JQL for MCP or DOM scraping for browser. The endpoint handlers don't need to know which path is active.

---

## New AIAnalyzer Methods — `src/services/analyzer.ts`

```typescript
// 4th parallel call: code impact (model: EXTRACTION_MODEL / Haiku)
async analyzeCodeImpact(
  issue: { key: string; summary: string; description: string },
  relatedFiles: Array<{ repo: string; file: string; symbol?: string }>,
  blastRadius: BlastRadiusNode[]
): Promise<string>

// 5th parallel call: solution proposal (model: DIGEST_MODEL / Sonnet — needs reasoning depth)
async proposeSolution(
  issue: { key: string; summary: string; description: string },
  codeContext: { files: string[]; snippets: Record<string, string> },
  pastLearnings: TicketLearning[],
  effortBaseline?: { medianHours: number; similarTickets: string[] }
): Promise<{ solution: string; missingInfo: string[] }>
```

**Prompt shape for `proposeSolution`**:
```
You are a senior engineer on the example-service platform.
Given: ticket metadata + affected files (from keyword search) + past learnings + cycle-time baseline.

Produce:
1. Root cause hypothesis
2. Files to change and what to change
3. Test strategy
4. Implementation sketch (pseudocode or real code)
5. Missing info: what would make this analysis more certain?
```

---

## New Endpoints — `web-server.js`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/jira/issues?filter=mine\|saturn\|sprint\|backlog` | Unified issue list (replaces separate saturn/my-issues) |
| GET | `/api/jira/epic/:key/children` | Lazy-fetch epic children |
| GET | `/api/jira/issue/:key/links` | Lazy-fetch linked issues |
| POST | `/api/jira/analyze` | Extended: 5 parallel calls (3 existing + code_impact + solution) |
| GET | `/api/jira/analysis/:issueKey` | Unchanged |
| POST | `/api/jira/ticket/:key/learn` | Save implementation learning |
| GET | `/api/jira/ticket/:key/learn` | Get learning for a ticket |
| GET | `/api/jira/learnings?project=BDS&q=...` | Search all learnings |
| POST | `/api/jira/ticket/:key/draft-pr` | Generate draft PR via `gh pr create --draft` |
| GET | `/api/jira/blast-radius/:key` | File coverage alerts for affected files |
| GET | `/api/jira/velocity?project=BDS&weeks=8` | Weekly throughput + avg cycle time |
| GET | `/api/jira/cycle-time?issue=PROJ-123` | Cycle time for one ticket (hours) |
| GET | `/api/jira/stuck?project=BDS&days=3` | Issues in same status > N days |

---

## UI — `web/src/pages/JiraReportPage.tsx`

### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  Saturn Board        Updated 4m ago  ● 3 analyzed    [↻] [Sync] │
│  [All 42] [Sprint 12] [Backlog 30] | [Auth 8] [Payments 5]      │
│  ⚠ Data is 18m old — refresh for latest                         │
├──────────────────────────────────────────────────────────────────┤
│  ┌─ Current Sprint (12) ─────────┐  ┌─ Backlog (30) ──────────┐ │
│  │ ━━━━━━━━━━ (blue accent line) │  │ ━━━━ (gray accent line) │ │
│  │                               │  │                         │ │
│  │  ▸ EPIC Auth Refactor    [3]  │  │  ▸ EPIC Payments   [5]  │ │
│  │    PROJ-1201 Fix token…  ●     │  │    PROJ-888 ...          │ │
│  │      Analysis|Effort|Solution │  │                         │ │
│  │      ─────────────────────    │  │                         │ │
│  │      Root cause: ...          │  │                         │ │
│  │      ⚠ No unit test           │  │                         │ │
│  │      [Draft PR] [✓ Learned]   │  │                         │ │
│  └───────────────────────────────┘  └─────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### Component additions to existing redesigned page

The **UI redesign was already implemented** (Apr 2026) with filter chips, priority bars, and refined analysis card. The following are **additive** changes on top of that:

1. **Velocity strip** — slim bar below the filter row: `Sprint velocity: 8 tickets/wk avg · 3.2d cycle time · 2 stuck`
2. **4th tab "Solution"** in `AnalysisCard` — `proposeSolution()` output, `missingInfo` as yellow callout
3. **5th tab "Code Impact"** — `analyzeCodeImpact()` output + blast radius warning badges
4. **EpicRow expansion** — click expands to load children from `/api/jira/epic/:key/children`
5. **"Mark as Learned"** button in analysis card → slide-in form (solution + files + traps)
6. **Similar learning badge** on ticket row — "♻ PROJ-2341 solved in 1d — see learnings"
7. **"Draft PR" button** in Solution tab — only shown when solution analysis complete

### New `VelocityStrip` component

```
┌──────────────────────────────────────────────────────┐
│  Sprint velocity: 8/wk  ·  Avg cycle: 3.2d  ·  2 stuck  [View trends ▸]  │
└──────────────────────────────────────────────────────┘
```

Small single-line strip between the filter chips and the two-column board. Clicking "View trends" opens a minimal chart drawer showing the 8-week velocity bar chart.

---

## New Tool — `src/tools/blast-radius-alert.ts`

```typescript
export interface BlastRadiusAlert {
  file: string;
  type: 'no_unit_test' | 'no_e2e' | 'high_downstream';
  detail: string;
}

export function checkTestCoverage(files: string[]): BlastRadiusAlert[]
// For each file: check existsSync(file.replace('.ts', '.test.ts')) etc.
// Without EP-43: file-system check only
// With EP-43: also check code_graph downstream consumer count

export function checkBlastRadius(db: Database, files: string[]): BlastRadiusAlert[]
// Requires EP-43; no-ops when code_graph unavailable
```

---

## Implementation Tickets

### ✅ EP-42-1: Schema Migration v23
`jira_transitions`, `ticket_learnings` tables created. `jira_issue_cache` renamed to `jira_issues`. New columns on `jira_analysis` (code_impact, solution, blast_radius) and `jira_issues` (linked_issues, parent_key). FK guard trigger on `jira_transitions`. `CURRENT_SCHEMA_VERSION = 23`. Build passes.

### ✅ EP-42-2: Transition Detection in Connector
`getLastTransition()`, `recordTransition()`, `getCycleTime()`, `getWeeklyVelocity()` (with week-over-week deltas), `getCycleTimesForSimilarTickets()` (P25/P50/P75 distribution) added to `src/db/queries.ts`. `saveLearning()`, `getLearning()`, `findSimilarLearnings()` added. Transition diff wired into `refreshSaturnCache()` and `refreshMyIssuesCache()` in `web-server.js` — every sync records a transition when status changes. Non-fatal (wrapped in try/catch).

### ✅ EP-42-3: Analytics Endpoints
`GET /api/jira/velocity?project=BDS&weeks=8`, `GET /api/jira/cycle-time?issue=PROJ-123`, `GET /api/jira/stuck?project=BDS&days=3` added to `web-server.js`. Uses `getWeeklyVelocity()`, `getCycleTime()` from queries barrel. Stuck query is raw SQL (finds issues with no newer transition after N days). All endpoints imported and smoke-tested.

### ✅ EP-42-4: VelocityStrip UI
`web/src/components/shared/VelocityStrip.tsx` — slim single-line strip showing `Sprint velocity: X/wk · Avg cycle: Xd · N stuck` with trend icon (TrendingUp/Down/Minus) and amber alert for stuck count. Reads `/api/jira/velocity` + `/api/jira/stuck`. Renders nothing until transitions accumulate. Wired into `JiraReportPage.tsx` between filter chips and stale warning. `VelocityStats` + `TicketLearning` types + `jiraVelocity/jiraStuck/jiraIssues/getTicketLearning/saveTicketLearning/searchLearnings` api methods added to `web/src/lib/api.ts`.

### ✅ EP-42-5: Unified Issue Endpoint
`GET /api/jira/issues?filter=mine|saturn|sprint|backlog` in `web-server.js`. Serves from existing `saturnCache`/`myIssuesCache` — no new fetch. `sprint` filter: excludes Done/Closed/Resolved/Cancelled. `backlog` filter: only To Do/Open/Backlog. Returns `{ filter, issues, cachedAt, isRefreshing }`.

### ✅ EP-42-7: Implementation Memory (DB + endpoints)
`GET /api/jira/ticket/:key/learn`, `POST /api/jira/ticket/:key/learn`, `GET /api/jira/learnings?project=BDS&q=...` in `web-server.js`. Uses `getLearning()`, `saveLearning()`, `findSimilarLearnings()` from queries barrel. UI form ("Mark as Learned" in AnalysisCard) is **pending** — endpoints are ready.

### EP-42-8: Solution Proposal + Code Impact Tabs
`proposeSolution()` + `analyzeCodeImpact()` in `analyzer.ts`. 5-call `Promise.allSettled` in `POST /api/jira/analyze`. 4th + 5th tabs in `AnalysisCard`. Inject cycle-time baseline + learnings into solution prompt.

### EP-42-9: Blast Radius Alerts
`src/tools/blast-radius-alert.ts`. Alerts inline in Solution/Code Impact tab. File-system test check (no EP-43 needed).

### EP-42-10: Draft PR Generation
`POST /api/jira/ticket/:key/draft-pr` → `gh pr create --draft`. "Draft PR" button in Solution tab, only when solution exists. Confirmation dialog before running `gh`.

---

## Recommended Execution Order

```
EP-42-1 (schema)
  → EP-42-2 (transition detection) + EP-42-7 (learnings DB)   [parallel]
    → EP-42-3 (analytics endpoints)
    → EP-42-4 (VelocityStrip)
    → EP-42-5 (unified endpoint)
    → EP-42-6 (hierarchy)
    → EP-42-8 (solution + code impact — needs EP-42-7 learnings)
      → EP-42-9 (blast radius)
      → EP-42-10 (draft PR)
```

EP-42-1 through EP-42-4 are the original EP-42 work (transition history + velocity).
EP-42-5 through EP-42-10 are the former EP-47 work (intelligence layer). All share schema, connector, and UI.

---

## Key Code Locations

| File | Change |
|------|--------|
| `src/db/schema.ts` | Migration v23: `jira_transitions` + `ticket_learnings` + new columns |
| `src/db/queries.ts` | Transition queries + learning queries (see above) |
| `src/connectors/jira-browser.ts` | Transition detection + `scrapeEpicChildren()` + `scrapeLinkedIssues()` |
| `src/services/analyzer.ts` | `proposeSolution()` + `analyzeCodeImpact()` |
| `src/tools/blast-radius-alert.ts` | NEW — `checkTestCoverage()` + `checkBlastRadius()` |
| `web-server.js` | 12 new/updated endpoints; 5-call analyze; velocity analytics |
| `web/src/pages/JiraReportPage.tsx` | VelocityStrip + 2 new tabs + EpicRow expand + learning form |
| `web/src/lib/api.ts` | `TicketLearning`, `VelocityStats`, `JiraTransition` types; new api methods |

---

---

## Implementation Gaps & Recommendations

> Post-completion analysis from senior-architect, senior-ml-engineer, senior-prompt-engineer, and senior-data-scientist lenses. Apply these during implementation — they amend individual tickets above.

---

### ARCH-42-A: Rename `jira_issue_cache` → `jira_issues` in Migration v23

**Problem**: The table holding Jira ticket data is currently named `jira_issue_cache`. This name implies a throwaway cache, but `jira_transitions.issue_key` creates a permanent FK-like dependency on it. Calling it "cache" invites future developers to drop it or add `DROP TABLE IF EXISTS` in migrations. No migration currently creates an explicit FK — causing orphaned `jira_transitions` rows if issues are deleted.

**Fix in EP-42-1**: In the v23 migration, add:
```sql
-- Rename to reflect source-of-truth status
ALTER TABLE jira_issue_cache RENAME TO jira_issues;

-- Explicit FK protection (SQLite enforces with PRAGMA foreign_keys=ON)
-- Note: SQLite doesn't support ADD CONSTRAINT; enforce at application layer
-- Add a CHECK trigger instead:
CREATE TRIGGER IF NOT EXISTS trg_jira_trans_fk
  BEFORE INSERT ON jira_transitions
BEGIN
  SELECT RAISE(ABORT, 'FK violation: issue_key not in jira_issues')
  WHERE NOT EXISTS (SELECT 1 FROM jira_issues WHERE key = NEW.issue_key);
END;
```

Also update all `FROM jira_issue_cache` references in `queries.ts` and `web-server.js`.

---

### ARCH-42-B: Tiered Lock — Read vs Write for `withJiraLock()` (Browser Scraper Path Only)

**Scope**: This issue is specific to the browser scraper path (`JIRA_SOURCE=browser`). When `JIRA_SOURCE=mcp`, MCP calls are stateless HTTP and do not share a browser session — no mutex is needed at all, and this entire concern is moot.

**Problem (browser path)**: The current single `withJiraLock()` mutex is held for the duration of any Jira browser operation — including full sync (2–5 minutes). `scrapeEpicChildren()` and `scrapeLinkedIssues()` (EP-42-6) are on-demand calls initiated by user clicks. If a background sync is running, the user click blocks for minutes. This makes the lazy hierarchy feel broken.

**Fix in EP-42-6**: Promote `withJiraLock()` to a tiered lock:

```typescript
// web-server.js
const jiraWriteLock = { active: false };   // sync: exclusive, long
const jiraReadQueue: (() => void)[] = [];  // on-demand: runs after sync

async function withJiraSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  // Waits for any running sync to finish; blocks new on-demand calls
  jiraWriteLock.active = true;
  try { return await fn(); }
  finally {
    jiraWriteLock.active = false;
    jiraReadQueue.splice(0).forEach(r => r()); // drain waiting reads
  }
}

async function withJiraReadLock<T>(fn: () => Promise<T>): Promise<T> {
  if (jiraWriteLock.active) {
    await new Promise<void>(r => jiraReadQueue.push(r)); // wait for sync to finish
  }
  return fn(); // multiple reads can run concurrently after sync
}
```

Use `withJiraSyncLock` in `runFullSync()`. Use `withJiraReadLock` for `scrapeEpicChildren()`, `scrapeLinkedIssues()`.

---

### ARCH-42-C: Shell Injection Guard for Draft PR Endpoint

**Problem**: `POST /api/jira/ticket/:key/draft-pr` will run `gh pr create` with the issue key in the command. Without validation, a crafted key like `PROJ-123; rm -rf /` becomes a shell injection.

**Fix in EP-42-10** — validate issue key before any shell call:

```typescript
// In draft-pr handler, before running gh:
const ISSUE_KEY_RE = /^[A-Z]+-\d+$/;
if (!ISSUE_KEY_RE.test(issueKey)) {
  return res.status(400).json({ error: 'Invalid issue key format' });
}

// Also check gh is available at server startup (not per-request):
// server startup in web-server.js:
import { execSync } from 'child_process';
try {
  execSync('which gh', { stdio: 'ignore' });
} catch {
  console.warn('[EP-42] gh CLI not found — Draft PR feature will be disabled');
  process.env.GH_AVAILABLE = 'false';
}

// In handler:
if (process.env.GH_AVAILABLE === 'false') {
  return res.status(503).json({ error: 'gh CLI not installed — cannot create PRs' });
}
```

Use `child_process.execFile` (not `exec`) to pass arguments as an array — eliminates injection entirely:
```typescript
import { execFileSync } from 'child_process';
execFileSync('gh', ['pr', 'create', '--draft', '--title', title, '--body', body], { cwd: repoPath });
```

---

### ARCH-42-D: Replace `chatWithContext()` with Purpose-Built Jira AI Methods

**Problem**: The current `POST /api/jira/analyze` uses `chatWithContext()` for 3 analysis calls. This is the wrong method — `chatWithContext()` uses a conversational system prompt ("You are a helpful assistant..."), returns `suggestedFollowUps` that are meaningless in an analysis context, and has no Jira-specific tool schema.

**Fix in EP-42-8**: Add dedicated `analyzeJiraTicket()` method to `AIAnalyzer` (replaces the current 3-call approach):

```typescript
// src/services/analyzer.ts

// Tool schema for code impact analysis
const CODE_IMPACT_TOOL = {
  name: 'code_impact_analysis',
  input_schema: {
    type: 'object',
    properties: {
      affectedFiles: {
        type: 'array',
        maxItems: 8,                          // hard cap — prevents noise without EP-43
        items: { type: 'string' },
        description: 'Source files most likely to need changes. Only list files explicitly in the provided context.'
      },
      impactSummary: { type: 'string', maxLength: 300 },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
    },
    required: ['affectedFiles', 'impactSummary', 'confidence']
  }
};

// Tool schema for solution proposal (embeds effort to prevent tab contradiction)
const SOLUTION_PROPOSAL_TOOL = {
  name: 'solution_proposal',
  input_schema: {
    type: 'object',
    properties: {
      rootCause: { type: 'string' },
      filesToChange: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      testStrategy: { type: 'string' },
      implementationSketch: { type: 'string' },
      effortEstimate: {
        type: 'object',
        description: 'Effort estimate derived from cycle-time baseline — this is the single source of truth for effort',
        properties: {
          days: { type: 'number' },
          basis: { type: 'string' },        // "P50 from 8 similar tickets: 2.3d"
          range: { type: 'string' }          // "P25–P75: 1.5d – 3.8d"
        }
      },
      missingInfo: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },   // "Is X affected?"
            whyItMatters: { type: 'string' } // "Determines whether we need Y"
          }
        },
        maxItems: 3
      }
    },
    required: ['rootCause', 'filesToChange', 'testStrategy', 'effortEstimate', 'missingInfo']
  }
};
```

**Critical system prompt rule for `analyzeCodeImpact`**:
```
"CRITICAL: Only reference files that were explicitly provided in the context. Do NOT hallucinate file paths. If you are uncertain which files are affected, set confidence: 'low' and explain in impactSummary."
```

**`missingInfo` prompt rule**:
```
"For each missing piece of information, formulate a direct question an engineer could answer in under 2 minutes. Bad: 'Need more context about the auth flow.' Good: 'Is the session token stored in Redis or in-process memory?'"
```

---

### ARCH-42-E: `analyzeCodeImpact` File Count Gate (Without EP-43)

**Problem**: Without EP-43's code graph, `rg` keyword search on the example-service repo can return 40–60 matching files for a generic term like "auth". Passing all 40 files to Claude produces noise, not analysis.

**Fix in EP-42-8**: Gate `analyzeCodeImpact` behind a file count check:

```typescript
// In POST /api/jira/analyze handler:
const relatedFiles = await searchRepoFiles(db, issue.summary, issue.description);

if (relatedFiles.length > 15) {
  // Too many matches without code graph — skip code impact call
  analysisResults.codeImpact = {
    skipped: true,
    reason: `${relatedFiles.length} files matched — install EP-43 code graph for precise blast radius`,
    affectedFiles: []
  };
} else {
  // Run analyzeCodeImpact with bounded file list
  analysisResults.codeImpact = await analyzer.analyzeCodeImpact(issue, relatedFiles.slice(0, 15), []);
}
```

The "skipped" state is surfaced in the Code Impact tab as an informational message, not an error. Users know to trigger EP-43 for accurate results.

---

### DS-42-A: Cycle Time Statistical Framing (P25/P75/N)

**Problem**: Passing a single median cycle time to Claude ("similar tickets took 2.3 days") is statistically weak when based on 5–15 tickets. Claude presents this as a fact rather than a distribution. Engineers need range awareness.

**Fix in `getCycleTimesForSimilarTickets()`** — return full distribution:

```typescript
export interface CycleTimeBaseline {
  p25: number;            // 25th percentile hours
  p50: number;            // median hours
  p75: number;            // 75th percentile hours
  n: number;              // sample size
  sampleKeys: string[];   // issue keys in sample (for traceability)
  warning?: string;       // "Low confidence: n=3" when n < 5
}

export function getCycleTimesForSimilarTickets(
  db: Database, keywords: string[], limit = 20
): CycleTimeBaseline | null
```

Pass to `proposeSolution()` prompt as:
```
"Historical cycle time for similar tickets (n=12): P25=1.5d · P50=2.3d · P75=3.8d
Note: Cycle time includes queue/blocked time, not pure engineering effort. P25 is achievable if unblocked; P75 is realistic if there are dependencies."
```

**Expose caveat in UI**: `VelocityStrip` shows `Avg cycle: 2.3d` with tooltip "Includes blocked/waiting time, not engineering effort alone".

---

### DS-42-B: Auto-Capture Learnings on `status → Done` (Default Path)

**Problem**: "Mark as Learned" button in the analysis card will achieve 10–20% capture rate (users forget, close the tab, or skip it). At 10-20%, the `ticket_learnings` flywheel never accumulates enough signal to be useful.

**Fix**: Make auto-capture the default on every `In Progress → Done` transition detection:

```typescript
// In jira-browser.ts, inside the transition detection block:
if (toStatus === 'Done' && fromStatus === 'In Progress') {
  const existingLearning = getLearning(db, issue.key);
  if (!existingLearning) {
    // Auto-capture with existing analysis if available
    const analysis = getJiraAnalysis(db, issue.key);
    if (analysis?.solution) {
      saveLearning(db, {
        issue_key: issue.key,
        project_key: issue.projectKey,
        summary: issue.summary,
        solution: analysis.solution,
        files_changed: null,        // user fills in via "Mark as Learned" form
        traps: null,
        cycle_time_hours: getCycleTime(db, issue.key),
        embedding: null
      });
    }
  }
}
```

Auto-captured learnings show with a `auto: true` flag in the UI. The "Mark as Learned" form pre-fills from the auto-capture and lets users add `files_changed` and `traps`. This lifts capture rate to 80%+.

---

### DS-42-C: VelocityStrip Delta Arrows

**Problem**: `Sprint velocity: 8/wk · Avg cycle: 3.2d · 2 stuck` gives a snapshot but no trend. An engineer looking at this can't tell if 8/wk is improving or declining.

**Fix in `getWeeklyVelocity()`** — compute week-over-week delta in the response:

```typescript
// In VelocityStats (add delta fields):
export interface VelocityStats {
  project_key: string;
  week_of: string;
  completed_count: number;
  avg_cycle_time_hours: number;
  stuck_count: number;
  completed_delta?: number;    // vs prior week (+2 = 2 more tickets done)
  cycle_time_delta?: number;   // vs prior week in hours (+4h = slower)
}
```

VelocityStrip renders:
```
Sprint velocity: 8/wk ↑2  ·  Avg cycle: 3.2d ↓0.4d  ·  2 stuck
```
- Green `↑2` / red `↑` for stuck count = progress at a glance
- `↑` on velocity = good (green), `↑` on cycle time = bad (red), `↑` on stuck = bad (red)

---

### DS-42-D: Dynamic Stuck Threshold Formula

**Problem**: `GET /api/jira/stuck?days=3` uses a hardcoded 3-day threshold. For a team with 2.3d median cycle time, "stuck" should be different than for a team with 8d median cycle time. A static 3 days misclassifies fast teams (everything looks stuck) and slow teams (nothing looks stuck).

**Fix**: Use `1.5 × P50 cycle time for the project` as the stuck threshold:

```typescript
// In getWeeklyVelocity() or as a separate utility:
export function getDynamicStuckThreshold(db: Database, projectKey: string): number {
  const baseline = getCycleTimesForSimilarTickets(db, [], 30); // all tickets for project
  if (!baseline || baseline.n < 5) return 72; // fallback: 3 days
  return baseline.p50 * 1.5;  // 1.5× median — statistically meaningful
}
```

The `GET /api/jira/stuck` endpoint accepts `threshold` override but defaults to dynamic. Surface in VelocityStrip tooltip: "Stuck = in same status > 3.5d (1.5× your team's median)".

---

### DS-42-E: Add EP-42-11 — Learnings Instrumentation Endpoint

**Purpose**: Visibility into the `ticket_learnings` flywheel capture rate and quality.

```
GET /api/jira/learnings/stats
Response:
{
  total_learnings: 24,
  auto_captured: 18,
  user_annotated: 6,
  capture_rate: 0.62,        // learnings / total Done tickets (last 90d)
  with_files_changed: 14,    // richness signal
  with_embedding: 8,
  avg_cycle_time_hours: 19.2,
  by_project: { "BDS": 20, "TURBO": 4 }
}
```

Display in `DigestPage.tsx` → data quality section alongside EP-33 quality scores. Surface `capture_rate < 0.5` as a data quality warning: "Less than half of resolved tickets have learnings — consider enabling auto-capture".

---

### DS-42-F: Embedding Backfill Path (When EP-37 Arrives)

**Problem**: `ticket_learnings.embedding BLOB` is reserved but the backfill path for existing learnings (once EP-37's `EmbeddingService` is available) is undocumented. Without a backfill, only new learnings after EP-37 get semantic search.

**Document in EP-42-1 schema migration** — add a comment and a backfill endpoint:

```typescript
// After EP-37 is deployed, run:
// POST /api/jira/learnings/backfill-embeddings
// → reads all ticket_learnings WHERE embedding IS NULL
// → calls EmbeddingService.embed(summary + ' ' + solution) for each
// → stores result in embedding BLOB
// → rate-limited: 10 per second to avoid OpenAI rate limits
```

The backfill endpoint is a no-op until EP-37 is deployed. Documenting it now ensures EP-42 implementors reserve the column correctly (BLOB, nullable) and don't design around it.

---

## Acceptance Criteria

- [x] `jira_transitions` table created; status change detected and recorded on each sync
- [x] No duplicate transitions (UNIQUE constraint enforced)
- [x] `getCycleTime()` returns hours from first In Progress to first Done
- [x] `getWeeklyVelocity()` returns correct weekly counts
- [ ] `GET /api/jira/stuck` returns issues unchanged for > N days
- [ ] `VelocityStrip` renders sprint velocity + avg cycle time + stuck count
- [ ] Unified `GET /api/jira/issues?filter=` replaces separate saturn/my-issues endpoints
- [ ] Stale data shown immediately with banner; no blank state while refresh runs
- [ ] Epic rows expand to show children (lazy fetch, cached after first load)
- [ ] `proposeSolution()` injects cycle-time baseline + past learnings into prompt
- [ ] Solution + Code Impact tabs visible in `AnalysisCard`
- [ ] "Similar ticket: BDS-XXXX solved in Xh" badge shows on matching rows
- [ ] "Mark as Learned" form saves to `ticket_learnings`
- [ ] Blast radius alerts shown for files with no unit test
- [ ] "Generate Draft PR" creates draft via `gh`; only shown when solution exists
- [ ] All 5 analysis calls fail independently (one failure doesn't block others)
- [x] TypeScript builds clean
