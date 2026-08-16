---
sidebar_position: 11
title: ADR-011 PR Intelligence Overhaul
---

# ADR-011: PR Review as Work-Context Mirror (EP-44 overhaul)

| Field | Value |
|-------|-------|
| **Status** | Implemented (EP-44 ✅ + EP-54 ✅, Sprints 7/11) |
| **Epic** | EP-44 (PR Intelligence) |
| **Schema** | v34 |

## Context

EP-44 built PR Review with 4 hollow data feeds: `testResults` always `[]`, `relatedMeetings` always `[]`, Teams context was a single LIKE keyword returning 5 noisy messages, and blast radius was empty unless `code_graph` was manually indexed. The feature promised work-context synthesis but delivered generic diff analysis.

## Decision

Transform PR Review from a standalone diff-analysis tool into a **work-context mirror**: it reads FROM the existing knowledge graph rather than operating independently.

### What changed

1. **`testResults` removed** from `PRReviewInput` — was always `[]`, misled Claude into generic "no tests" commentary
2. **Meetings context** now queries `meetings` table by Jira key + branch keywords (was always `[]`)
3. **Action items** now queries `action_items` for open tasks linked to Jira key or PR keywords (was never wired)
4. **Teams FTS5** replaces single LIKE — multi-keyword, 10 results, includes author for context
5. **Ticket learnings** injects `solution`/`traps` from `ticket_learnings` for the Jira key
6. **Reviewer suggestions** now sourced from `team_members` + `member_aliases` activity (was hallucinated)
7. **PR review cache** (`pr_review_cache` table, schema v34) — SHA-keyed, never re-runs Claude for same diff
8. **`watched_prs`** table (schema v34) — moves follow state from localStorage to SQLite for future server-side alerts
9. **Work Context card** in UI — shows which meetings/action items/learnings were used, collapsible
10. **Cache badge + Re-analyze button** — user sees when result is cached and can force refresh

### What was NOT changed

- No CI/CD test result integration — test results stay absent (honest > misleading `[]`)
- No auto-posting reviews — user action required (Post to GitHub button remains manual)
- Create PR button kept on PR Review page (user preference)
- Blast radius still requires manual `POST /api/code-graph/index` — no auto-indexing added

## Trade-offs

| Decision | Trade-off accepted |
|----------|--------------------|
| SHA-based cache (no TTL) | Cache never expires on its own — only invalidated by new commits. Old reviews persist. Acceptable since reviews are cheap to regenerate. |
| FTS5 multi-keyword Teams search | Higher recall, possible false positives. Better than zero results from single LIKE. |
| `watched_prs` migration is client-driven | First page load migrates localStorage to DB. Race condition if two tabs open simultaneously — low risk. |
| `testResults` fully removed | Breaks backward compat for any callers passing `testResults`. Only caller is web-server.js, which is fixed simultaneously. |

## Key Files

| File | Change |
|------|--------|
| `src/services/analyzer.ts` | `PRWorkContext` extended; `reviewPR()` prompt rebuilt; `generatePRDescription()` drops `testResults` |
| `src/db/schema.ts` | v34: `pr_review_cache` + `watched_prs` |
| `web-server.js` | `/api/pr/review` — cache check, rich context queries, cache save |
| `web/src/pages/PRReviewPage.tsx` | `WorkContextCard`, cache badge, Re-analyze button |
| `web/src/lib/api.ts` | `PRWorkContextSummary` type; `reviewPR()` accepts `forceRefresh` |
