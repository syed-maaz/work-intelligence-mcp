---
title: "EP-10: Saturn Team Jira Report"
sidebar_label: "EP-10: Jira Report"
---

# EP-10: Saturn Team Jira Report

| | |
|---|---|
| **Status** | ✅ DONE |
| **Priority** | High |
| **Agent Role** | Jira Report Engineer |
| **Depends On** | [EP-4](./ep4-jira-wiring), [EP-7](./ep7-schema-migration) |
| **Blocks** | — |
| **File Scope** | `src/tools/jira-report.ts` (create), `src/scripts/jira-report.ts` (create), `web/src/pages/JiraReportPage.tsx` (rewrite) |

## Goal

Phase 1 "Fetch & Analytical Report" — scrape the BDS (Saturn team) Jira board, persist issues to the local DB, and produce a structured markdown report showing issues by status, who is working on what, linked Bitbucket PRs, and an AI-generated team health summary.

**Phase 2 (live board UI)** — replaced the form-based report page with a live two-column kanban board (Current Sprint / Backlog) driven by the Saturn cache, with per-ticket chat action buttons.

## What Was Built

### `src/tools/jira-report.ts`
Main `getJiraReport(db, args, session, apiKey?)` function:
1. Scrapes Jira via `JiraBrowserConnector.fetchMessages()` using the BDS board URL
2. Persists all scraped issues to SQLite via `upsertMessage()` (deduped on `source_id`)
3. Normalises raw Jira statuses into 4 buckets: **Blocked / In Progress / Todo / Done**
4. Groups issues by status and assignee, collects open Bitbucket PRs
5. Calls Claude (`claude-sonnet-4-6`) for a concise team health analysis
6. Renders a full markdown report with 8 sections

### `src/scripts/jira-report.ts`
CLI entry point — `npm run report` prints the markdown report to stdout.

### `src/connectors/jira-browser.ts` (enhanced)
- `convertRapidBoardToNavigatorUrl()` — converts RapidBoard URLs to scrapeable JQL navigator URLs
- `scrapeBitbucketPRs()` — extracts linked PRs from the issue development panel (best-effort)

### `web/src/pages/JiraReportPage.tsx` (rewritten — Phase 2)
Old form-based page replaced with a live two-column board:
- **Left column**: Current Sprint — issues matching active sprint statuses (in progress, in review, in testing, code review, active, dev in progress)
- **Right column**: Backlog — all remaining issues
- Uses `['saturn-issues']` React Query cache — zero extra requests if Dashboard has already loaded
- Per-ticket action buttons (hover-reveal): **Analyze**, **Dev Effort**, **Unknown** — each fires a pre-composed prompt into the Smart Chat sidebar via `sendToChat()`
- Refresh button + Sync All button in top bar
- Priority dot color coding (red = blocker/critical, orange = major/high, yellow = medium/normal)

### DB schema (`src/db/schema.ts` v2)
Added columns to `messages`: `source_id`, `subject`, `raw_data`.
Added `sync_state` table for tracking last-sync timestamps per topic+source.

## Decisions Made (Phase 2)

- **Reuse Saturn cache**: `JiraReportPage` pulls from the same `['saturn-issues']` query as `SaturnBoardSection` — no duplicate fetches.
- **Sprint detection**: Issues are split into Sprint vs Backlog client-side by matching status against a known list of sprint-active keywords.
- **Chat via `sendToChat()`**: Action buttons call `sendToChat(prompt)` from `useUIStore`, which opens the chat panel and auto-submits the prompt (see EP-24 for implementation).
- **Old form removed**: The manual JQL form + markdown dump was replaced entirely — the live board is always up to date from the cache.

## Usage

**CLI:**
```bash
npm run report
# or with overrides:
JIRA_SINCE_DAYS=7 npm run report
```

**MCP tool (Claude Desktop / Cursor):**
```
get_jira_report {
  "projectKey": "BDS",
  "boardUrl": "https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=BDS"
}
```

## Report Structure (markdown CLI output)

```
# BDS Team — Jira Report
Generated: <date> | Issues: N | Since: <date>

## 📊 Overview          — status counts table
## 🔴 Blocked           — issues needing attention
## 🔄 In Progress       — active issues with PR links
## 📋 Todo / Backlog    — upcoming work
## ✅ Recently Completed
## 👥 By Assignee       — workload breakdown
## 🔗 Open PRs (Bitbucket)
## 🤖 AI Analysis       — Claude team health summary
```

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-10-1 | DB schema migration v2 (source_id, subject, raw_data, sync_state) | ✅ DONE |
| EP-10-2 | `upsertMessage()` + sync state query helpers | ✅ DONE |
| EP-10-3 | `convertRapidBoardToNavigatorUrl()` + Bitbucket PR scraping | ✅ DONE |
| EP-10-4 | `src/tools/jira-report.ts` — scrape, persist, group, render | ✅ DONE |
| EP-10-5 | Wire `get_jira_report` into `src/server.ts` | ✅ DONE |
| EP-10-6 | `src/scripts/jira-report.ts` CLI + `npm run report` | ✅ DONE |
| EP-10-7 | Tests: schema-v2, URL conversion | ✅ DONE |
| EP-10-8 | Manual integration test against real `jira.example.com` | ✅ DONE |
| EP-10-9 | Rewrite `JiraReportPage` as live two-column board with chat actions | ✅ DONE |


## Goal

Phase 1 "Fetch & Analytical Report" — scrape the BDS (Saturn team) Jira board, persist issues to the local DB, and produce a structured markdown report showing issues by status, who is working on what, linked Bitbucket PRs, and an AI-generated team health summary.

## What Was Built

### `src/tools/jira-report.ts`
Main `getJiraReport(db, args, session, apiKey?)` function:
1. Scrapes Jira via `JiraBrowserConnector.fetchMessages()` using the BDS board URL
2. Persists all scraped issues to SQLite via `upsertMessage()` (deduped on `source_id`)
3. Normalises raw Jira statuses into 4 buckets: **Blocked / In Progress / Todo / Done**
4. Groups issues by status and assignee, collects open Bitbucket PRs
5. Calls Claude (`claude-sonnet-4-6`) for a concise team health analysis
6. Renders a full markdown report with 8 sections

### `src/scripts/jira-report.ts`
CLI entry point — `npm run report` prints the markdown report to stdout.

### `src/connectors/jira-browser.ts` (enhanced)
- `convertRapidBoardToNavigatorUrl()` — converts RapidBoard URLs to scrapeable JQL navigator URLs
- `scrapeBitbucketPRs()` — extracts linked PRs from the issue development panel (best-effort)

### DB schema (`src/db/schema.ts` v2)
Added columns to `messages`: `source_id`, `subject`, `raw_data`.
Added `sync_state` table for tracking last-sync timestamps per topic+source.

## Usage

**CLI:**
```bash
npm run report
# or with overrides:
JIRA_SINCE_DAYS=7 npm run report
```

**MCP tool (Claude Desktop / Cursor):**
```
get_jira_report {
  "projectKey": "BDS",
  "boardUrl": "https://jira.example.com/secure/RapidBoard.jspa?rapidView=48792&projectKey=BDS"
}
```

## Report Structure

```
# BDS Team — Jira Report
Generated: <date> | Issues: N | Since: <date>

## 📊 Overview          — status counts table
## 🔴 Blocked           — issues needing attention
## 🔄 In Progress       — active issues with PR links
## 📋 Todo / Backlog    — upcoming work
## ✅ Recently Completed
## 👥 By Assignee       — workload breakdown
## 🔗 Open PRs (Bitbucket)
## 🤖 AI Analysis       — Claude team health summary
```

## Acceptance Criteria

- [x] `getJiraReport()` in `src/tools/jira-report.ts`
- [x] `get_jira_report` MCP tool registered in `src/server.ts`
- [x] `npm run report` CLI script
- [x] RapidBoard URLs automatically converted to JQL navigator URLs
- [x] Bitbucket PRs extracted from issue development panel (best-effort)
- [x] Issues persisted via `upsertMessage()` — re-running does not duplicate
- [x] Status normalised to 4 buckets: Blocked / In Progress / Todo / Done
- [x] All 8 report sections always present (shows "None" when empty)
- [x] AI analysis present when `ANTHROPIC_API_KEY` is set
- [x] `npm run typecheck` passes
- [x] Unit tests pass for URL conversion and DB migration

## Tickets

| ID | Title | Status |
|----|-------|--------|
| EP-10-1 | DB schema migration v2 (source_id, subject, raw_data, sync_state) | ✅ DONE |
| EP-10-2 | `upsertMessage()` + sync state query helpers | ✅ DONE |
| EP-10-3 | `convertRapidBoardToNavigatorUrl()` + Bitbucket PR scraping | ✅ DONE |
| EP-10-4 | `src/tools/jira-report.ts` — scrape, persist, group, render | ✅ DONE |
| EP-10-5 | Wire `get_jira_report` into `src/server.ts` | ✅ DONE |
| EP-10-6 | `src/scripts/jira-report.ts` CLI + `npm run report` | ✅ DONE |
| EP-10-7 | Tests: schema-v2, URL conversion | ✅ DONE |
| EP-10-8 | Manual integration test against real `jira.example.com` | ✅ DONE |
