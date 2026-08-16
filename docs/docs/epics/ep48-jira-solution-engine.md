---
sidebar_position: 48
title: EP-48 Jira Solution Engine
---

# EP-48: Jira Solution Engine

> **Deferred from EP-42** — tickets EP-42-6, EP-42-7 (UI), EP-42-8, EP-42-9, EP-42-10 split out Apr 2026.

| Field | Value |
|-------|-------|
| **Status** | ✅ Done (2026-04-20, UI browser test pending — 48-HUMAN-UAT.md) |
| **Priority** | Medium |
| **Complexity** | Large (4–6 days) |
| **Blocked By** | EP-43 ✅, EP-42 ✅ (schema v23, learnings endpoints) |
| **Schema version** | None — uses v23 tables from EP-42 |
| **ADR** | [ADR-008](../adr/adr-008-ep48-implementation-decisions) |

## Summary

Completes the Jira intelligence story with AI-powered solution proposals, code impact analysis, hierarchical ticket fetch, blast radius detection, and draft PR generation.

---

## Architecture Decisions (from 2026-04-19 analysis)

> Multi-perspective analysis: senior-architect + senior-ml-engineer + senior-data-scientist lenses.

### SKIP: blast-radius-alert.ts (new tool file)

**Decision**: Do NOT create `src/tools/blast-radius-alert.ts`. The code_graph (`getTestCoverage`) already exists from EP-43. In the draft-PR handler, call `getTestCoverage(db, changedFiles)` directly and surface a warning if any changed file has no test coverage. Two sources of truth for coverage data would diverge silently.

### SKIP: confidence field on CODE_IMPACT_TOOL

**Decision**: Remove `confidence` from the analyzeCodeImpact tool schema. It will reliably return `high` (model has no mechanism to distinguish genuine impact from keyword co-occurrence). Replace with a deterministic post-processing check: strip any `affectedFiles` entry not present in the input 15 files.

### SKIP: missingInfo.whyItMatters sub-field (v1)

**Decision**: Start with `missingInfo: string[]` (plain questions). `whyItMatters` adds ~200 output tokens of generic justifications. Add in v2 after validating users act on the questions.

### SKIP: effortEstimate.range as free string

**Decision**: Use `{ days: number, basis: string }` only. Free-string range produces unparseable formats. Drop `range` field.

### SKIP: inject cycle time baseline when n < 5

**Decision**: When `CycleTimeBaseline.warning` is set (n < 5), suppress cycle time from the Sonnet prompt entirely — don't just show a UI warning. A P50 from 2 data points anchors the model worse than no estimate.

### IMPROVE: Issue key validation Zod refinement

**Decision**: Add a shared `issueKeySchema = z.string().regex(/^[A-Z]+-\d+$/, 'Invalid issue key format')` and apply to: JiraAnalyzeSchema.issueKey, draft-PR body, learn POST route (currently uses `[^/]+` only).

### IMPROVE: Fix keyword array truncation in findSimilarLearnings

**Decision**: Both `findSimilarLearnings` and `getCycleTimesForSimilarTickets` currently use only `keywords[0]`. Change to OR-across-all-keywords (cap at 5). Match by keyword overlap count for ranking, not recency. Highest ROI data quality fix.

### IMPROVE: Add fallback flag to CycleTimeBaseline

**Decision**: When `getCycleTimesForSimilarTickets` falls back to all Done tickets, add `fallback: true` to the response. UI shows different copy; Sonnet prompt injection is labelled differently.

### IMPROVE: Gate "similar learning" badge at corpus n >= 10

**Decision**: Do not render the learning badge until `ticket_learnings` for the project has >= 10 entries. Empty corpus produces misleading badges that damage trust.

### IMPROVE: Auto-capture quality gate

**Decision**: Before writing to `ticket_learnings` on auto-capture, validate `solution` is non-empty and >= 30 chars. Log skipped auto-captures.

### IMPROVE: Per-key in-flight guard for 5-call analyze pipeline

**Decision**: Add `const analyzingKeys = new Set<string>()` in web-server.js. Gate `runAll()` with a 409 if issueKey is already in-flight. Remove on completion (both success and error). Prevents double-write race on jira_analysis rows.

### IMPROVE: Add `failed` status to jira_analysis

**Decision**: The current state machine is `pending → done`. Add `failed` as a terminal state written in the outermost catch of `runAll()`. UI shows a retry button instead of stuck pending state.

### IMPROVE: Browser path needs a global withBrowserLock

**Decision**: `scrapeEpicChildren` and `scrapeLinkedIssues` must route through a browser mutex. The two existing chain mutexes (`withSaturnLock`, `withMyIssuesLock`) are list-level. Collapse or add a third for ticket-level fetches. MCP path is stateless — no mutex needed.

### IMPROVE: Prompt structure for proposeSolution

**Decision**: Use structured user-turn format:
```
## Ticket
<key, summary, description, type, priority>

## Affected Files (from analyzeCodeImpact)
<file paths with one-line descriptions>

## Past Learnings (≤3 selected)
<formatted as: Learning [N] (from PROJ-NNN, YYYY-MM-DD): summary. Outcome: what worked/avoid>

## Cycle Time Baseline
P25: Xd | P50: Yd | P75: Zd (includes queue + blocked time; coding effort ~30–50% of P50)

## Your task
Propose a solution using the propose_solution tool.
```

System prompt must: (1) state role + "only reference files explicitly provided", (2) define field semantics clearly, (3) set calibration anchor for missingInfo ("only raise when answer changes files or approach"), (4) NOT restate output structure from tool schema.

### IMPROVE: temperature settings

**Decision**: `analyzeCodeImpact` → `temperature: 0` (extraction task). `proposeSolution` → `temperature: 0.2` max (generative but must minimize hallucination). Consistent with all other extraction calls in analyzer.ts.

### IMPROVE: Validate filesToChange against provided files

**Decision**: After `proposeSolution` returns, strip any path in `filesToChange` not present in the analyzeCodeImpact input files or explicit DB-backed file list. Flag stripped paths as `unverified` before persisting to jira_analysis.

---

## Recommended Implementation Order

```
Phase 1 (Foundation)
  EP-48-2: Mark as Learned UI form
  + Add issueKeySchema Zod refinement to all three routes

Phase 2 (Analyzer extension)
  EP-48-3: proposeSolution() + analyzeCodeImpact() in AIAnalyzer
  + Import getCycleTimesForSimilarTickets in web-server.js
  + Expand POST /api/jira/analyze to 5-call allSettled
  + Add per-key in-flight guard + failed status

Phase 3 (Fetch layer)
  EP-48-1: scrapeEpicChildren + scrapeLinkedIssues (browser path)
  + withBrowserLock for ticket-level browser fetches
  + JQL path (MCP, no mutex)

Phase 4 (New endpoints)
  EP-48-5: POST /api/jira/ticket/:key/draft-pr
  + Reuse getTestCoverage() from queries (no blast-radius-alert.ts)
  + Issue key validation, execFileSync array form

Phase 5 (Background)
  DS-42-B: Wire auto-capture in recordTransition (In Progress → Done)
  + Quality gate: solution >= 30 chars before saveLearning
```

---

## Tickets

### EP-48-1: Hierarchical Fetch (was EP-42-6)

Lazy-load epic children and linked issues on demand.

**Browser path:**
- `scrapeEpicChildren(session, epicKey)` in `src/connectors/jira-browser.ts`
- `scrapeLinkedIssues(session, issueKey)` — scrapes "Linked Issues" section
- Both must use `withBrowserLock` (ticket-level, distinct from list-level mutexes)

**MCP path (stateless, no mutex):**
- `fetchEpicChildrenMcp(epicKey)` — JQL `parent = ${epicKey}`
- `fetchLinkedIssuesMcp(issueKey)` — `jira_get_issue` with `fields: issuelinks`

**Endpoints:**
- `GET /api/jira/epic/:key/children` — returns child issues array, cached in `jira_issues.parent_key`
- `GET /api/jira/ticket/:key/linked` — returns linked issues, cached in `jira_issues.linked_issues`

**Frontend (`JiraReportPage.tsx`):**
- `EpicRow` expands on click → fetches children
- Issue row "linked issues" section → fetches on expand

---

### EP-48-2: "Mark as Learned" UI (was EP-42-7 UI)

Wire the learnings endpoints (already live in EP-42-7) into the UI.

**Frontend (`JiraReportPage.tsx` `AnalysisCard`):**
- "Mark as Learned" button → slide-in form (solution, files_changed as array, traps)
- On submit: `POST /api/jira/ticket/:key/learn`
- Learning badge: "♻ BDS-XXXX solved in Xd" — only shown when corpus n >= 10 for the project
- `files_changed` must be submitted as array (not string)

---

### EP-48-3: Solution Proposal + Code Impact Tabs (was EP-42-8)

Add two new AI tabs to `AnalysisCard` and expand analyze pipeline.

**`src/services/analyzer.ts` — two new tool-schema methods (NOT chatWithContext):**

```typescript
// tool name: 'code_impact_analysis'
// schema: { affectedFiles: string[] (maxItems:8), impactSummary: string (maxLength:300) }
// NOTE: confidence field is REMOVED (see architecture decisions)
// temperature: 0
analyzeCodeImpact(
  issueKey: string,
  issueContext: { summary: string; description: string },
  codeFiles: Array<{ file: string; snippet?: string }>  // max 15 files
): Promise<{ affectedFiles: string[]; impactSummary: string }>

// tool name: 'solution_proposal'
// schema: { rootCause, filesToChange (maxItems:8), testStrategy, implementationSketch (maxLength:600),
//           effortEstimate: { days: number, basis: string },
//           missingInfo: string[] (maxItems:3) }
// NOTE: missingInfo is string[] not objects (see architecture decisions)
// NOTE: effortEstimate.range field REMOVED
// temperature: 0.2
proposeSolution(
  issueKey: string,
  issueContext: { summary: string; description: string },
  affectedFiles: string[],
  learnings: TicketLearning[],           // max 3, OR-matched, ranked by keyword overlap
  cycleBaseline: CycleTimeBaseline | null // null when n < 5 — do NOT inject
): Promise<{ rootCause: string; filesToChange: string[]; testStrategy: string; implementationSketch: string; effortEstimate: { days: number; basis: string }; missingInfo: string[] }>
```

**`web-server.js` `POST /api/jira/analyze`:**
- Expand to 5 calls via `Promise.allSettled`: existing Analysis + Effort + Explanation + Code Impact + Solution
- Add per-key in-flight guard (`Set<string>`, 409 on duplicate)
- Add `failed` terminal status (written in outermost catch)
- Import `getCycleTimesForSimilarTickets` from queries
- Gate `analyzeCodeImpact` call when file match count > 15 (return stub with warning)
- Validate `filesToChange` from `proposeSolution` — strip paths not in the input file list
- Code Impact call only on user click (triggered by frontend, not on page load)

**`JiraReportPage.tsx` `AnalysisCard`:**
- 4th tab: **Solution** — `proposeSolution()` output, `missingInfo` as amber callout
- 5th tab: **Code Impact** — `analyzeCodeImpact()` output, badge for unverified file paths

---

### EP-48-4: Blast Radius Alerts (simplified from EP-42-9)

**Decision**: No new `blast-radius-alert.ts` tool file. Instead:

- In `POST /api/jira/ticket/:key/draft-pr` handler: call `getTestCoverage(db, changedFiles)` from existing queries
- If any file in `changedFiles` has no test coverage, include a `⚠ No test found for <file>` warning in the response
- Surface these warnings in the Draft PR UI before the confirmation dialog

**Inline badge in Code Impact tab:**
- For each file in `analyzeCodeImpact.affectedFiles`, check `getTestCoverage()` result
- Render `⚠ No test` badge inline

---

### EP-48-5: Draft PR Generation (was EP-42-10)

**Backend:**
- `POST /api/jira/ticket/:key/draft-pr`
- Issue key validation: `issueKeySchema` (shared Zod refinement `/^[A-Z]+-\d+$/`)
- Check `gh` is available at server startup (cached in `process.env.GH_AVAILABLE`)
- `execFileSync('gh', ['pr', 'create', '--draft', '--title', title, '--body', body], { cwd: repoPath })`
- Call `getTestCoverage()` before running gh; include coverage warnings in response
- Requires `solution` to exist in `jira_analysis` — 400 if not

**Frontend:**
- "Draft PR" button in Solution tab — only when `solution` content present
- Show test coverage warnings above confirmation dialog
- Open returned PR URL in new tab

---

## Background: DS-42-B Auto-Capture (Phase 5)

Wire auto-capture in `recordTransition` (both browser and MCP paths):

```typescript
if (toStatus === 'Done' && fromStatus === 'In Progress') {
  const existingLearning = getLearning(db, issue.key);
  if (!existingLearning) {
    const analysis = getJiraAnalysis(db, issue.key);
    const solutionText = analysis?.solution;
    // Quality gate: must have a real solution string
    if (solutionText && solutionText.length >= 30 && !solutionText.startsWith('Error:')) {
      saveLearning(db, {
        issue_key: issue.key,
        project_key: issue.projectKey,
        summary: issue.summary,
        solution: solutionText,
        files_changed: null,
        traps: null,
        cycle_time_hours: getCycleTime(db, issue.key),
        embedding: null,
      });
    }
  }
}
```

---

## Key Code Locations

| File | Change |
|------|--------|
| `src/connectors/jira-browser.ts` | `scrapeEpicChildren()` + `scrapeLinkedIssues()` + `withBrowserLock` |
| `src/connectors/jira-adapter.ts` | `fetchEpicChildrenMcp()` + `fetchLinkedIssuesMcp()` |
| `src/services/analyzer.ts` | `proposeSolution()` + `analyzeCodeImpact()` (tool schema methods) |
| `src/db/queries/jira.ts` | `findSimilarLearnings()` fix: OR-across-all-keywords + ranking |
| `src/db/queries/transitions.ts` | `getCycleTimesForSimilarTickets()` fix: OR-across-all-keywords; add `fallback` flag |
| `web-server.js` | 5-call analyze, per-key guard, failed status, draft-PR endpoint, issueKeySchema |
| `web/src/pages/JiraReportPage.tsx` | Solution tab, Code Impact tab, Mark as Learned form, EpicRow expand |
| `web/src/lib/api.ts` | New api methods for solution, code impact, draft PR |

---

## Acceptance Criteria

- [x] `GET /api/jira/epic/:key/children` returns child issues; EpicRow expands in UI
- [x] `GET /api/jira/ticket/:key/linked` returns linked issues
- [x] "Mark as Learned" form saves via `POST /api/jira/ticket/:key/learn`; learning badge appears when corpus n >= 10
- [x] Solution tab shows `proposeSolution()` output with `missingInfo` callout (string[] not objects)
- [x] Code Impact tab shows `analyzeCodeImpact()` output without confidence field; unverified paths flagged
- [x] `filesToChange` paths validated against provided file list before persisting
- [x] `POST /api/jira/ticket/:key/draft-pr` creates a draft PR via `gh`; issue key validated
- [x] Per-key in-flight guard returns 409 on duplicate analyze requests
- [x] `jira_analysis.status` can reach `failed` (not stuck at `pending`)
- [x] `findSimilarLearnings` uses OR-across-all-keywords (not just keywords[0])
- [x] Cycle time baseline suppressed from Sonnet prompt when n < 5
- [x] `npm run typecheck` passes, `npm run build` passes, all new endpoints curl-tested
