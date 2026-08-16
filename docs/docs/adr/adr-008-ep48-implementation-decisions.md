---
sidebar_position: 8
title: ADR-008 EP-48 Jira Solution Engine Design Decisions
---

# ADR-008: EP-48 Jira Solution Engine — Key Implementation Decisions

| Field | Value |
|-------|-------|
| **Date** | 2026-04-19 |
| **Status** | ✅ Accepted |
| **Deciders** | Project owner |
| **Epic** | EP-48 (Jira Solution Engine — deferred from EP-42) |
| **Depends on** | ADR-006, ADR-007, EP-43 (code_graph), EP-46 (McpClient) |

---

## Context

EP-48 consolidates four features deferred from EP-42 (EP-42-6, EP-42-8, EP-42-9, EP-42-10) into a single deliverable. These features were deferred to keep EP-42 scoped and because they benefit significantly from EP-43 (code graph) and EP-46 (MCP adapter). This ADR captures the key implementation decisions made during analysis.

---

## Decision 1: MCP path for hierarchy fetch is stateless (no lock needed)

**Decision:** EP-48-1 (hierarchical fetch) uses `jira_search` JQL (`parent = "{key}"`) via McpClient on the MCP path. No mutex or lock is needed.

**Rationale:** McpClient makes HTTP calls to a stateless MCP server. There is no shared browser session to protect. The `withJiraReadLock` / `withJiraSyncLock` tiered mutex (ARCH-42-B) was introduced specifically for JiraBrowserConnector, which runs a single shared Playwright session. MCP path is inherently concurrent-safe.

**Browser path:** `scrapeEpicChildren()` + `scrapeLinkedIssues()` in `jira-browser.ts` must still use `withJiraReadLock` (shared browser session).

---

## Decision 2: Solution proposal triggered on user click only

**Decision:** `proposeSolution()` (Sonnet) is called only when the user explicitly clicks "Analyze" in the UI — never on page load or during background sync.

**Rationale:** Sonnet cost per call is ~$0.015–0.018. The Jira report page loads many tickets; auto-triggering on load would make each page view expensive. User intent signals the analysis is actually needed.

---

## Decision 3: 5-call analyze pipeline via Promise.allSettled

**Decision:** `POST /api/jira/analyze` runs 5 AI calls concurrently via `Promise.allSettled`. Individual call failures surface as partial results — they do not fail the entire analysis.

The 5 calls:
1. `classifyIssue()` — Haiku
2. `estimateEffort()` — Haiku
3. `explainForNonTechnical()` — Haiku
4. `proposeSolution()` — Sonnet (new)
5. `analyzeCodeImpact()` — Haiku, gated (new)

**Rationale:** Partial results are more useful than no results. A single slow or failing AI call should not block the other four. `allSettled` is the correct primitive.

---

## Decision 4: analyzeCodeImpact gated at 15-file match count

**Decision:** `analyzeCodeImpact()` is skipped (returns null) when the code graph file match count exceeds 15.

**Rationale:** Without full EP-43 indexing, a high file count indicates the code graph may be incomplete or the query too broad. Results above 15 files tend to be noise. The gate also prevents excessive token consumption on large blast radii.

**File hallucination guard:** The `analyzeCodeImpact` system prompt explicitly instructs Claude to only reference files that appear in the provided match list — never invent paths.

---

## Decision 5: Draft PR uses execFileSync, not exec

**Decision:** `POST /api/jira/ticket/:key/draft-pr` must use `execFileSync('gh', [...args])` with an array of arguments — never `exec()` or `execSync()` with a string command.

**Rationale:** `exec()` passes the command through a shell (`/bin/sh -c`). If `key` is not validated, a crafted issue key like `PROJ-1; rm -rf ~` becomes a shell injection vector. `execFileSync` with an array bypasses the shell entirely — no injection possible even with a malformed key.

**Validation:** Issue key must match `/^[A-Z]+-\d+$/` before any shell invocation. Reject immediately with 400 if it does not match.

**Startup check:** Server startup validates `gh` availability and logs a warning if not found (non-fatal — endpoint returns 503 when called).

---

## Decision 6: Confirmation dialog required before draft PR creation

**Decision:** The "Draft PR" button in the Solution tab must show a confirmation dialog before calling `POST /api/jira/ticket/:key/draft-pr`.

**Rationale:** Draft PR creation has external side effects (creates a GitHub PR visible to the team). It cannot be undone silently. The confirmation dialog makes the action explicit and prevents accidental triggers.

---

## Decision 7: Learnings injection into proposeSolution

**Decision:** Up to 3 most recent `ticket_learnings` rows for the same epic/component are fetched and injected into the `proposeSolution()` system prompt alongside the P25/P50/P75 cycle time baseline.

**Rationale:** Learnings encode team-specific patterns (e.g. "always run migration scripts in two phases", "this service requires a feature flag"). Injecting them grounds the solution proposal in institutional knowledge rather than generic advice.

**Schema:** `ticket_learnings` table exists as of v23. No new schema change needed for EP-48.

---

## Consequences

- EP-48 requires no schema changes (uses v23 tables: `jira_transitions`, `ticket_learnings`, `jira_issues`, `jira_analysis`).
- Browser path adds 2 new methods to `JiraBrowserConnector` (`scrapeEpicChildren`, `scrapeLinkedIssues`).
- `analyzer.ts` gains 2 new methods (`proposeSolution`, `analyzeCodeImpact`) and a new tool schema file or inline tool definitions.
- `web-server.js` gains 2 new endpoints: `GET /api/jira/epic/:key/children` and `POST /api/jira/ticket/:key/draft-pr`.
- `JiraReportPage.tsx` gains 2 new tabs in AnalysisCard (Solution, Code Impact) and EpicRow lazy expansion.
- Cost budget: ~$0.020/ticket (3 Haiku + 1 Sonnet + 1 Haiku code impact).
