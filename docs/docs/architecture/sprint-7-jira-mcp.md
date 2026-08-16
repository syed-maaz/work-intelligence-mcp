---
sidebar_position: 6
title: Sprint 7 — Jira Intelligence & Connector Architecture
---

# Sprint 7: Jira Intelligence & Connector Architecture Guide

This document is the centralized implementation guide for the Sprint 7 epics that touch Jira data ingestion, intelligence, and connector architecture. It contains:
- Dependency graph for parallel agent execution
- Per-epic agent-ready prompts with exact file paths, function signatures, and acceptance criteria
- Environment variable changes

---

## Epics in This Guide

| Epic | Title | Schema | Depends On |
|------|-------|--------|------------|
| [EP-46](../epics/ep46-jira-mcp-adapter) | Jira MCP Adapter with Scraper Fallback | None | None | ✅ Done |
| [EP-41](../epics/ep41-topic-health-score) | Topic Health Score | None | None | ✅ Done |
| [EP-42](../epics/ep42-jira-transition-history) | Jira Transition History | v23 | EP-46 recommended | ✅ Done |
| [EP-43](../epics/ep43-multi-repo-code-intelligence) | Multi-Repo Code Intelligence | v24 | None | ✅ Done |
| [EP-44](../epics/ep44-pr-intelligence) | PR Intelligence | None | EP-43 | 🔲 TODO |
| [EP-45](../epics/ep45-teammate-intelligence) | Teammate Intelligence | v25 | EP-43 | 🔲 TODO |
| [EP-48](../epics/ep48-jira-solution-engine) | Jira Solution Engine | None | EP-42 | 🔲 TODO |
| [EP-47](../epics/ep47-jira-intelligence-layer) | Jira Intelligence Layer | None | EP-46 | Archived → EP-42 |

---

## Parallel Execution Plan

**Status as of Apr 2026**: EP-46, EP-41, EP-42, EP-43 are all ✅ Done. EP-44, EP-45, EP-48 are unblocked and ready.

```
✅ Done:
  EP-46 Jira MCP Adapter
  EP-41 Topic Health Score
  EP-42 Jira Intelligence Layer (EP-42-6/8/9/10 → EP-48)
  EP-43 Multi-Repo Code Intelligence (5,197 example-service + 317 operations edges indexed)

Next (parallel, all unblocked):
  EP-44 PR Intelligence — depends on EP-43 ✅
  EP-45 Teammate Intelligence — depends on EP-43 ✅
  EP-48 Jira Solution Engine — depends on EP-42 ✅
```

---

## EP-46: Jira MCP Adapter with Scraper Fallback

**Full doc**: [EP-46](../epics/ep46-jira-mcp-adapter)  
**ADR**: [ADR-006](../adr/adr-006-jira-mcp-fallback)  
**No schema change. 6 independent tickets.**

### EP-46-1: `JiraDataSource` Interface + Factory

**New file**: `src/connectors/jira-adapter.ts`

```typescript
import { BrowserSessionManager } from './browser-session.js';
import { JiraBrowserConnector } from './jira-browser.js';
import type { UnifiedMessage } from '../services/types.js';

export interface JiraDataSource {
  fetchMessages(
    config: Record<string, unknown>,
    since?: Date
  ): Promise<UnifiedMessage[]>;
}

type JiraSourceMode = 'mcp' | 'browser' | 'auto';

export function createJiraDataSource(
  session: BrowserSessionManager,
  mode?: JiraSourceMode
): JiraDataSource {
  const resolved = mode ?? (process.env.JIRA_SOURCE as JiraSourceMode) ?? 'auto';
  if (resolved === 'browser') return new JiraBrowserConnector(session);
  if (resolved === 'mcp') return new JiraMcpAdapter();
  return new JiraAutoAdapter(session);
}
```

**Anti-patterns**:
- Do NOT import from `./jira-browser.js` inside `JiraMcpAdapter` — keep the two implementations isolated
- Do NOT use dynamic imports inside the factory — static imports only

**Acceptance**: `npm run typecheck` passes; `createJiraDataSource` is importable from `src/connectors/jira-adapter.ts`.

---

### EP-46-2: `JiraMcpAdapter` Implementation

**File**: `src/connectors/jira-adapter.ts` (append to same file)

The adapter calls the `jira` MCP server tools. In TypeScript source these are invoked via the MCP client injected into the server context — the exact call pattern follows the existing MCP tool handler pattern in `src/tools/`.

**Core algorithm**:

```typescript
class JiraMcpAdapter implements JiraDataSource {
  async fetchMessages(config, since) {
    const projectKey = config.projectKey as string;
    const sinceIso = (since ?? new Date(Date.now() - 30 * 86400_000)).toISOString().slice(0, 10);
    const jql = `project = ${projectKey} AND updated >= "${sinceIso}" ORDER BY updated DESC`;

    // 1. Paginated search — max 200 issues, 50 per page
    const allIssues = await paginatedSearch(jql, 50, 200);

    // 2. Fetch details in batches of 10 (comments + dev info)
    const detailed = await Promise.all(
      chunk(allIssues, 10).map(batch =>
        Promise.all(batch.map(issue => fetchIssueDetail(issue.key)))
      )
    ).then(batches => batches.flat());

    // 3. Map to UnifiedMessage[]
    return detailed.flatMap(mapIssueToMessages);
  }
}
```

**MCP tools to call** (exact tool names from the `jira` server):

| Tool | When | Fields to request |
|------|------|-------------------|
| `mcp__jira__jira_search` | paginated list | `summary,status,assignee,priority,issuetype,labels,created,updated` |
| `mcp__jira__jira_get_issue` | per-issue detail | `summary,status,assignee,description,labels,priority,issuetype,comment` |
| `mcp__jira__jira_get_issue_development_info` | per-issue PRs | default fields |
| `mcp__jira__jira_get_issue_dates` | per-issue transitions | `include_status_changes=true` |

**UnifiedMessage shape** for a Jira issue:
```typescript
{
  source: 'jira',
  source_id: issue.key,                        // e.g. 'PROJ-1234'
  subject: issue.summary,
  content: issue.description ?? '',
  author: issue.assignee?.display_name ?? 'Unassigned',
  timestamp: issue.updated,
  topic: config.topicName as string,
  metadata: {
    jira: {
      issueKey: issue.key,
      projectKey,
      status: issue.status.name,
      priority: issue.priority?.name,
      assignee: issue.assignee?.display_name,
      labels: issue.labels,
      pullRequests: devInfo?.pullRequests ?? [],   // from jira_get_issue_development_info
      transitions: dates?.statusChanges ?? [],     // from jira_get_issue_dates
    }
  }
}
```

**Acceptance**: `JIRA_SOURCE=mcp npm run report` completes; output contains issue keys; no browser process launched.

---

### EP-46-3: `JiraAutoAdapter`

**File**: `src/connectors/jira-adapter.ts` (append)

```typescript
class JiraAutoAdapter implements JiraDataSource {
  constructor(private session: BrowserSessionManager) {}

  async fetchMessages(config, since) {
    try {
      return await new JiraMcpAdapter().fetchMessages(config, since);
    } catch (err) {
      process.stderr.write(`[jira-adapter] MCP failed (${(err as Error).message}), falling back to browser scraper\n`);
      return new JiraBrowserConnector(this.session).fetchMessages(config, since);
    }
  }
}
```

**Acceptance**: with `JIRA_SOURCE=auto`, passing a nonexistent project key to the MCP path triggers the catch block and the browser scraper runs.

---

### EP-46-4: Migrate Callers

Replace all `new JiraBrowserConnector(session)` call sites with `createJiraDataSource(session)`:

| File | Approximate Line | Old | New |
|------|-----------------|-----|-----|
| `src/tools/jira-report.ts` | 114 | `new JiraBrowserConnector(session)` | `createJiraDataSource(session)` |
| `src/tools/search-all.ts` | 195 | `new JiraBrowserConnector(session)` | `createJiraDataSource(session)` |
| `web-server.js` | 158 | `new JiraBrowserConnector(session)` | `createJiraDataSource(session)` |
| `web-server.js` (Saturn) | 99 | indirect via `getSaturnIssues()` | check `dist/tools/saturn-board.js`; thread factory if needed |

Update imports in each file: remove `JiraBrowserConnector` import, add `createJiraDataSource` from `../connectors/jira-adapter.js`.

**Acceptance**: `grep -r 'new JiraBrowserConnector' src/ web-server.js` → 0 results.

---

### EP-46-5: Env Var Documentation

**Files to update**:
- `CLAUDE.md` optional env section — add `JIRA_SOURCE`
- `.env.example` (if present) — add `JIRA_SOURCE=auto`

```bash
JIRA_SOURCE=auto   # jira source: mcp | browser | auto (default)
                   # mcp    → use jira MCP server only (no browser required)
                   # browser → use Playwright scraper only
                   # auto   → try mcp first, fall back to browser on error
```

Note: `BROWSER_PROFILE_PATH` is not required when `JIRA_SOURCE=mcp`.

---

### EP-46-6: Update ADR-003

**File**: `docs/docs/adr/adr-003-jira-rest.md`

Append at the end:

```markdown
## Superseded (partial)

For `jira.example.com` ( on-premises Jira), this ADR is superseded by [ADR-005](./adr-005-jira-mcp-fallback), which documents the  Jira MCP Server adopted in April 2026. The browser-fallback adapter described in ADR-005 keeps the scraper as a secondary path.

ADR-003 remains valid for Jira Cloud (Atlassian) instances using personal API tokens.
```

---

## New Environment Variables (Sprint 7)

| Variable | Default | Values | Notes |
|----------|---------|--------|-------|
| `JIRA_SOURCE` | `auto` | `mcp \| browser \| auto` | EP-46: selects Jira data source |

Existing variables that become **optional** after EP-46 when `JIRA_SOURCE=mcp`:
- `BROWSER_PROFILE_PATH` — only needed if browser scraper path is used

---

## Verification Checklist (EP-46)

Run these after implementing EP-46:

```bash
# 1. Type safety
npm run typecheck

# 2. Build
npm run build

# 3. MCP path (no browser)
JIRA_SOURCE=mcp npm run report

# 4. Browser path (explicit)
JIRA_SOURCE=browser npm run report

# 5. Default path (auto)
npm run report

# 6. No direct instantiation remaining
grep -r 'new JiraBrowserConnector' src/ web-server.js  # expect 0 results

# 7. Factory used everywhere
grep -r 'createJiraDataSource' src/ web-server.js      # expect 4+ results
```

---

## How the  Jira MCP Changes Other Sprint 7 Epics

### EP-42: Jira Intelligence Layer — Significant Impact

EP-42 was designed assuming the browser scraper as the only Jira data source. With EP-46 landed, several architectural notes change.

**Transition History (EP-42-2 — already done, but MCP path improves quality)**:

EP-42-2 is complete with diff-based detection. When `JIRA_SOURCE=mcp`, the `JiraMcpAdapter` can call `jira_get_issue_dates` to get the actual Jira transition timestamps instead of approximating with the sync time. This means:

- Cycle times become accurate to the minute (not bounded by 15-minute sync intervals)
- Historical backfill is possible for tickets synced for the first time (all past transitions, not just the current status)

To enable this, `recordTransition()` needs an optional `transitionedAt?: Date` parameter. The MCP adapter passes the actual timestamp; the browser path omits it (defaults to `datetime('now')`).

```typescript
// src/db/queries.ts — update signature:
export function recordTransition(
  db: Database, issueKey: string, projectKey: string,
  fromStatus: string | null, toStatus: string,
  transitionedAt?: Date  // actual Jira timestamp from jira_get_issue_dates
): void

// MCP adapter (src/connectors/jira-adapter.ts):
const dates = await jiraGetIssueDates(issue.key, { include_status_changes: true });
for (const change of dates.statusChanges ?? []) {
  recordTransition(db, issue.key, projectKey, change.from, change.to, new Date(change.timestamp));
}
```

**Hierarchical Fetch (EP-42-6 — MCP simplifies this)**:

When MCP is active, `scrapeEpicChildren()` and `scrapeLinkedIssues()` can be replaced by JQL calls:

```typescript
// MCP path: no browser navigation needed
async function fetchEpicChildrenMcp(epicKey: string) {
  return jiraSearch(`parent = ${epicKey} ORDER BY updated DESC`);
}
async function fetchLinkedIssuesMcp(issueKey: string) {
  const detail = await jiraGetIssue(issueKey, { fields: 'issuelinks' });
  return detail.issuelinks ?? [];
}
```

The tiered lock (ARCH-42-B) is a browser-path concern only — MCP calls are stateless HTTP and require no mutex. Implement the tiered lock for the browser fallback path but skip it for MCP.

**Unified Filter Endpoint (EP-42-5 — MCP path uses JQL, not scrapers)**:

```
mine     → jira_search: assignee = currentUser() ORDER BY updated DESC
saturn   → jira_search: project = BDS AND component = Saturn ORDER BY updated DESC
sprint   → jira_search: project = BDS AND sprint in openSprints() ORDER BY updated DESC
backlog  → jira_search: project = BDS AND sprint is EMPTY ORDER BY updated DESC
```

The browser scraper path continues to use the existing cache tables (`jira_issues` with `list_name`). Both paths write to the same `jira_issues` table — the UI is unaware of which path was used.

**Comments in Solution Prompt (EP-42-8 — MCP makes this possible)**:

The browser scraper doesn't fetch issue comments. `jira_get_issue` returns full comment history. Inject the last 3–5 comments into the `proposeSolution()` prompt context:

```typescript
// In JiraMcpAdapter, after fetching issue detail:
const comments = issue.comments?.slice(-5) ?? [];
// Map to context string: "Comment by Alice (Apr 15): confirmed this happens on prod too"
```

This enriches the solution proposal significantly — comments often contain the real root cause that the description omits.

---

### EP-44: PR Intelligence — Minor Enhancement

EP-44 uses `gh` for GitHub operations (unaffected). But the Jira enrichment step can use the MCP adapter instead of reading from the DB cache:

**Current design** (EP-44-2):
```
// Auto-detect Jira key from branch/title → read from jira_issues DB cache
```

**With MCP available**:
```typescript
// When Jira key is detected, fetch live from MCP for richer context:
const jiraIssue = await jiraGetIssue(detectedKey, {
  fields: 'summary,status,description,assignee,labels,priority',
  comment_limit: 3
});
```

This gives the PR review fresh issue state (not stale cache) and includes recent comments. Still falls back to DB cache if MCP fails (consistent with EP-46 `auto` mode).

No changes to EP-44 tickets — this is an implementation detail within EP-44-2's `GET /api/pr/enrich` handler.

---

### EP-43: Multi-Repo Code Intelligence — Not Affected

EP-43 builds the code graph from AST analysis of local repo files. It does not fetch Jira data. No changes needed.

---

### EP-45: Teammate Intelligence — Minor Enhancement

EP-45 builds teammate profiles from Teams messages, commits, and Jira issues. The Jira dimension currently reads from `jira_issues` DB cache.

**With MCP available**: the profile builder can optionally enrich a teammate's Jira workload with live data:

```typescript
// In buildMemberProfile() — Jira workload dimension:
// Current: SELECT * FROM jira_issues WHERE assignee = member.jira_username
// Enhanced: jira_search(`assignee = "${member.jira_username}" AND updated >= "-30d"`)
```

This gives the profile builder current sprint status, not stale cached data. Still optional — falls back to DB query when MCP is unavailable. Implement as a follow-up to EP-45-1 if MCP is stable.

---

### EP-41: Topic Health Score — Not Affected

Pure SQL view computation. No Jira API calls. No changes.

---

## Summary: Sprint 7 MCP Impact Matrix

| Epic | MCP Impact | Action Required |
|------|-----------|-----------------|
| EP-46 | Core deliverable | Implement adapter + factory |
| EP-42 | **High** — transition timestamps, hierarchy, comments in solution | Update `recordTransition()` signature; implement MCP paths for hierarchy endpoints; inject comments into proposeSolution |
| EP-44 | Low — live Jira enrichment in PR context | Optional enhancement in EP-44-2 handler |
| EP-45 | Low — live workload in profiles | Optional enhancement after EP-45-1 |
| EP-43 | None | No changes |
| EP-41 | None | No changes |

