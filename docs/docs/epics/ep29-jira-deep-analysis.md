---
sidebar_position: 29
title: EP-29 Jira Deep Analysis
---

# EP-29: Jira Deep Analysis

| Field | Value |
|-------|-------|
| **Status** | ✅ Done (code intelligence extension planned — requires EP-43) |
| **Priority** | High |
| **Blocked By** | EP-20 (Saturn Board) |
| **Schema version** | 15 (adds `jira_analysis` table); `code_impact` column added when EP-43 lands |

## Summary

Single "Analyze" button per Jira ticket. Fires 3 parallel Claude calls in the background (code analysis, effort estimation, explanation). Results persisted to `jira_analysis` DB table and survive page refresh. Inline expandable 3-tab card below each ticket row.

## Decisions Made

- **3 parallel calls** (not sequential) so sections fill in as ready
- **202 immediate response** — server returns right away, client polls `GET /api/jira/analysis/:issueKey`
- **DB persistence** — analyses survive page refresh; no re-triggering
- **No chat panel** — results shown inline in the board, not in the chat sidebar
- **rg codebase search** — keywords extracted from ticket title, used to find relevant example-service TypeScript files

## DB Schema (Migration 14 → 15)

```sql
CREATE TABLE IF NOT EXISTS jira_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_key TEXT NOT NULL UNIQUE,
  analysis TEXT,
  effort TEXT,
  explanation TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/jira/analyze` | Fires 3 background AI calls, returns 202 immediately |
| GET | `/api/jira/analysis/:issueKey` | Fetch single persisted row |
| GET | `/api/jira/analyses` | List all rows (loaded on board mount) |

## Key Code Locations

- `web-server.js` — `POST /api/jira/analyze` (lines ~1314–1442)
- `src/db/schema.ts` — migration 14→15
- `src/db/queries.ts` — `saveJiraAnalysis`, `loadJiraAnalysis`, `listJiraAnalyses`, `JiraAnalysisRow`
- `web/src/pages/JiraReportPage.tsx` — `AnalysisCard`, `TicketRow`, `handleAnalyze`, `pendingKeys` polling
- `web/src/lib/api.ts` — `JiraAnalysis` interface, `analyzeTicket()`, `getJiraAnalysis()`, `listJiraAnalyses()`

## UX Flow

1. Hover ticket → "Analyze" button appears (always visible if no analysis yet)
2. Click → 202 back immediately; "Analyzing…" badge appears on ticket row
3. Frontend polls `GET /api/jira/analyses` every 3s while `pendingKeys.size > 0`
4. When `status === 'done'`: badge turns green "Analyzed", chevron appears
5. Click chevron or Analyze → inline card expands with 3 tabs: Analysis | Effort | Explanation
6. "Re-run" button triggers fresh analysis

## Acceptance Criteria

- [x] Single Analyze button per ticket (hover-reveal)
- [x] "Analyzing…" badge persists across page refresh while pending
- [x] "Analyzed" green badge when done
- [x] 3-tab inline card: Analysis, Effort, Explanation
- [x] Results survive page refresh (DB-persisted)
- [x] Re-run triggers fresh analysis
- [x] TypeScript builds clean (`npm run build` + `cd web && npx tsc --noEmit`)

---

## Code Intelligence Extension (requires EP-43)

Once `code_graph` is available (EP-43), the Jira analysis pipeline gets a fourth parallel call and two new data surfaces.

### What changes

**4th parallel AI call: Code Impact**

```javascript
// In POST /api/jira/analyze — add alongside the existing 3 calls:
const codeImpactPromise = (async () => {
  // Extract keywords from ticket title + description
  const keywords = extractKeywords(issue.summary, issue.description);
  // Query code_graph for files matching those keywords via FTS on file_path + symbol
  const relatedFiles = getRelatedFiles(db, 'example-service', keywords);
  // Get blast radius for each matched file
  const blastRadius = relatedFiles.flatMap(f => getBlastRadius(db, 'example-service', f));
  // AI call: summarize code impact
  return analyzer.analyzeCodeImpact(issue, relatedFiles, blastRadius);
})();
```

**4th tab in `AnalysisCard`: Code Impact**

```
Analysis | Effort | Explanation | Code Impact (new)
─────────────────────────────────────────────────
Affected files (3):
  src/auth/login.ts       — LoginService.handleTimeout()
  src/middleware/session.ts — SessionManager.refresh()
  src/api/users.ts        — UserController (indirect)

Blast radius: 7 files total
Cross-repo: operations/k8s/app-deployment.yaml (SESSION_TIMEOUT_MS)

Suggested reviewers: @alice (owns src/auth/), @bob (last touched session)
```

**Inline blast radius badge on ticket row**

When `code_graph` data exists for a ticket, show a small `⬡ 7 files` badge next to the existing "Analyzed" badge. Click expands to the Code Impact tab directly.

### New `AIAnalyzer` method

```typescript
async analyzeCodeImpact(
  issue: { key: string; summary: string; description: string },
  relatedFiles: Array<{ repo: string; file: string; symbol?: string }>,
  blastRadius: BlastRadiusNode[]
): Promise<string>
// Returns markdown: affected files table + blast radius summary + suggested reviewers
// Model: EXTRACTION_MODEL (Haiku) — structured summary, not heavy reasoning
```

### Schema addition to `jira_analysis`

```sql
ALTER TABLE jira_analysis ADD COLUMN code_impact TEXT;
-- Stored as markdown, same pattern as analysis/effort/explanation columns
```

### Files to update (when EP-43 is done)

| File | Change |
|------|--------|
| `web-server.js` | Add 4th parallel call in `POST /api/jira/analyze`; add `code_impact` to save/load |
| `src/db/queries.ts` | Add `code_impact` to `JiraAnalysisRow`, `saveJiraAnalysis`, `loadJiraAnalysis` |
| `src/services/analyzer.ts` | Add `analyzeCodeImpact()` method |
| `web/src/pages/JiraReportPage.tsx` | Add "Code Impact" tab to `AnalysisCard`; add blast radius badge to `TicketRow` |
| `web/src/lib/api.ts` | Add `code_impact?: string` to `JiraAnalysis` interface |
