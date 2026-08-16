---
id: ep55-bug-investigation-engine
title: EP-55 — Bug Investigation Engine
---

# EP-55 — Bug Investigation Engine

| Field | Value |
|-------|-------|
| Sprint | Sprint 12 |
| Status | ✅ Done (2026-04-21) |
| ADR | [ADR-013](../adr/adr-013-intelligent-bug-investigation) |
| Schema | v35 (`codebase_knowledge`, `subsystem_owners`, `investigation_sessions`) |
| Depends On | EP-43 ✅ (`code_graph` table), EP-44 ✅ (PR Intelligence), EP-50 ✅ (TicketDetailPanel) |
| Effort | ~5 waves (5 plans) |

## Problem

When a regression bug lands (e.g. PROJ-15257 — BIS links blank since Apr 17), the current Jira analysis pipeline reads ticket text and guesses a fix without checking git history, dependency bumps, or code ownership. This wastes hours: the Saturn team investigates code they don't own, and the real fix owner (e.g. SMRDP) gets notified late.

Post-mortem on PROJ-15257: the correct root cause (feature flag `FF_RM_11372_KNOWLEDGE_APIS_MIGRATION` promoted in `acme/operations` PR #6107 on Apr 17) was available in the operations git log within seconds. The AI analysis pipeline never checked the operations repo — it anchored on the smrdp Component.js path from domain knowledge in the system prompt instead.

## Goal

Build a 3-layer ReAct investigation engine that reasons like a senior developer:

1. **Layer 1 — Knowledge Base**: Index ADRs, CLAUDE.md, ownership map into SQLite so the AI has architectural context without hallucinating.
2. **Layer 2 — Temporal**: Extract regression date from ticket text → `gitLogWindow(since, until)` → detect dependency bumps.
3. **Layer 3 — Symptom-Driven Code**: `traceCallGraph()` from symptom file → detect cross-repo boundaries → `signalExternalDep()`.
4. **ReAct Orchestrator**: Wire layers 1–3 into a max-8-iteration loop. `git_log_window` is always iteration 1 for regression bugs. Conclude with structured `InvestigationReport` (rootCause, fixOwner, confidence, proposedFix).
5. **UI**: "Investigate" tab in `TicketDetailPanel` with live streaming trace and `ConclusionCard`.

## Decisions Made

1. **ReAct loop, not one-shot prompt** — Sequential tool calls build evidence incrementally. Max 8 iterations prevents runaway cost. See ADR-013.
2. **git_log_window first** — For any ticket with a regression date signal, temporal investigation runs before code reading. This is the single rule that would have solved PROJ-15257 in iteration 1.
3. **Ownership map** — Hard-coded `DEFAULT_OWNERSHIP_MAP` in `src/intelligence/ownership-map.ts`. Seeded from CODEOWNERS if present. Prevents proposing Saturn fixes for SMRDP-owned code.
4. **Pattern memory** — Completed investigations with confidence ≥ 0.8 are saved to `codebase_knowledge` (type=`pattern`). Subsequent similar tickets short-circuit the loop via `findSimilarInvestigation()`.
5. **202 async endpoint** — `POST /api/jira/investigate` returns immediately; client polls `GET /api/jira/investigation/:key`. ReAct trace is persisted incrementally so the UI can stream it.
6. **Chat hypotheses injected** — User messages in the chat panel that contain causal language ("I think", "probably", "maybe") are detected and injected into the ReAct system prompt as priority investigation hints.

## New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/jira/investigate` | Start async investigation — returns `202 { issueKey, status: "running" }` |
| GET | `/api/jira/investigation/:key` | Poll for results — returns session with `reactTrace[]` and `report` |

## New Files

| File | Purpose |
|------|---------|
| `src/intelligence/ownership-map.ts` | `DEFAULT_OWNERSHIP_MAP` + `getOwnership(file, repo)` |
| `src/intelligence/knowledge-indexer.ts` | `KnowledgeIndexer` — scans example-service ADRs/CLAUDE.md into `codebase_knowledge` |
| `src/intelligence/tools/git-log-window.ts` | `gitLogWindow(repo, since, until)` — git log with dep bump detection |
| `src/intelligence/tools/dep-diff.ts` | `extractDepChanges()` — package.json diff between commits |
| `src/intelligence/tools/call-graph-tracer.ts` | `traceCallGraph()` — walks `code_graph` table, detects cross-repo boundaries |
| `src/intelligence/tools/file-reader.ts` | `readFile()` / `readChangedFiles()` — capped at 5 files × 400 lines |
| `src/intelligence/tools/external-dep-signal.ts` | `evaluateExternalDepSignal()` — synthesizes dep bump + trace boundary |
| `src/intelligence/investigation-orchestrator.ts` | `InvestigationOrchestrator` — ReAct loop, tool dispatch, report builder |
| `src/intelligence/pattern-extractor.ts` | `extractAndSaveBugPattern()` — saves high-confidence results to knowledge base |
| `src/db/queries/investigation.ts` | Session CRUD: create/append/complete/get/findSimilar/getArchitecture |
| `web/src/components/jira/InvestigatePanel.tsx` | Live trace view + `ConclusionCard` + polling |

## Schema (v35)

```sql
CREATE TABLE codebase_knowledge (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL, area TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('architecture','ownership','pattern','dependency','subsystem')),
  title TEXT NOT NULL, content TEXT NOT NULL, source_file TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo, area, type, title)
);

CREATE TABLE subsystem_owners (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL, path_glob TEXT NOT NULL,
  team TEXT, owner TEXT, notes TEXT,
  UNIQUE(repo, path_glob)
);

CREATE TABLE investigation_sessions (
  id INTEGER PRIMARY KEY,
  issue_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed')),
  regression_date TEXT, regression_date_confidence TEXT,
  hypothesis TEXT, conclusion TEXT, confidence REAL, owner_team TEXT,
  react_trace TEXT DEFAULT '[]', report_json TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
);
```

## Acceptance Criteria

- [x] `POST /api/jira/investigate` returns 202 immediately (non-blocking)
- [x] `GET /api/jira/investigation/:key` returns running session with partial trace while in progress
- [x] PROJ-15257 mock replay: `rootCauseType === 'dep-upgrade'`, `isExternalDep === true`, `proposedFix === null`
- [x] `git_log_window` is always iteration 1 tool call for regression bugs
- [x] Loop terminates ≤ 8 iterations in all scenarios
- [x] Pattern match short-circuits loop when prior investigation found (confidence ≥ 0.75)
- [x] "Investigate" tab renders in `TicketDetailPanel`
- [x] `ConclusionCard` shows confidence %, fix owner badge, example-service action
- [x] External dep flag shown in orange/red badge; internal in green
- [x] Pattern saved to `codebase_knowledge` after completion (confidence ≥ 0.8)
- [x] All unit + integration tests pass: `npm run test:run`
- [x] `npm run typecheck` passes (zero errors)
- [x] Startup log shows `[knowledge] indexed=N skipped=0` on first run

## Known Gaps (Sprint 13 candidates)

- **GAP-55-A**: Engine only calls `git_log_window` on `example-service` by default — never checks `operations` in iteration 1. PROJ-15257 root cause (feature flag flip in `acme/operations` PR #6107) was missed because of this.
- **GAP-55-B**: No `get_flag_diff` tool — `cluster-setup/feature-flags.yaml` changes are invisible to all existing tools.
- **GAP-55-C**: System prompt contains hardcoded SMRDP/recommended-links domain hints that caused anchoring bias, leading the model to conclude before checking operations.
- **GAP-55-D**: No cross-repo pre-loop timeline — both repos' commits ±3 days of regression date are not correlated before reasoning begins.
- **GAP-55-E**: `conclude` has no gate requiring at least one operations tool call for non-`code-regression` root cause types.

## Wave Plan

| Wave | Plan | Builds |
|------|------|--------|
| 1 | 55-01 | Schema v35, ownership map, knowledge indexer, investigation DB helpers, layer 1 tests |
| 1 | 55-02 | Regression date extractor, gitLogWindow, dep diff tool, layer 2 tests |
| 1 | 55-03 | traceCallGraph, readChangedFiles, signalExternalDep, layer 3 tests |
| 1 | 55-04 | InvestigationOrchestrator, POST/GET endpoints, PROJ-15257 integration tests |
| 1 | 55-05 | InvestigatePanel UI, api.ts additions, pattern extractor |
