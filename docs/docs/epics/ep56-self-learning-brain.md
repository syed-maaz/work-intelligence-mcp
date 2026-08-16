---
id: ep56-self-learning-brain
title: EP-56 — Self-Learning Bug Investigation Brain
---

# EP-56 — Self-Learning Bug Investigation Brain

| Field | Value |
|-------|-------|
| Sprint | Sprint 12 |
| Status | ✅ Done (2026-04-21) |
| ADR | [ADR-014](../adr/adr-014-self-learning-investigation-brain.md) |
| Schema | v36 (`pattern_feedback`, `tool_effectiveness`, `hypothesis_accuracy`) |
| Depends On | EP-55 ✅ (investigation_sessions, codebase_knowledge, InvestigationOrchestrator) |
| Effort | 1 session (3 plans) |

## Problem

Phase 55 (ADR-013) delivers a 3-layer ReAct investigation engine that can debug regressions like a senior developer. But every investigation starts from identical priors — the same tool weights, the same pattern confidence levels — regardless of how many investigations have completed before it.

After 10–20 investigations this is wasteful:
- Some tools (`gitLogWindow`) prove reliable for `dep-upgrade` bugs; others (`traceCallGraph`) rarely produce signal for that root cause type
- Patterns extracted from resolved bugs (e.g. PROJ-15257 SMRDP dep-upgrade) are directly reusable for future similar tickets
- Predicted root cause types are testable hypotheses — if they're wrong, the system should know

## Solution

A feedback layer that records and applies learning after each investigation concludes. Four self-learning mechanisms:

1. **Pattern Confidence Scoring** — patterns gain/lose confidence via `±0.10/0.15` deltas per feedback event
2. **Hypothesis Accuracy Tracking** — `predicted_root_cause` vs `actual_root_cause` tracked per concluded session; filled when user confirms fix via `PUT /outcome`
3. **Tool Effectiveness Learning** — per `(tool_name, root_cause_type)` composite key; `effectiveness_score = led_to_conclusion / invocations`
4. **Architecture Knowledge Decay + Refresh** — entries older than `KNOWLEDGE_TTL_DAYS=30` deleted and re-indexed on next `runFullSync`

## Decisions Made

1. **Incremental confidence, not full retraining** — small deltas keep the system deterministic and auditable without GPU or serving infrastructure (ADR-014 Decision 1)
2. **Tool effectiveness keyed per rootCauseType** — prevents cross-contamination between bug classes (ADR-014 Decision 2)
3. **Outcome confirmation is opt-in** — `was_correct` only filled on explicit `PUT /outcome` call; no automated git-blame inference (ADR-014 Decision 3)
4. **Knowledge TTL is soft decay** — stale rows deleted + re-indexed; never rejects queries mid-session (ADR-014 Decision 4)
5. **BrainStatsPanel is developer-facing** — diagnostic only; not in the main ticket investigation flow (ADR-014 Decision 5)
6. **ALLOWED_SESSION_COLS allowlist** — `updateSession` validates column names at runtime to prevent SQL injection via dynamic SET clause (code review fix WR-002)

## Schema v36

Three new tables added on top of Phase 55's v35 foundation:

```sql
CREATE TABLE IF NOT EXISTS pattern_feedback (
  id               INTEGER PRIMARY KEY,
  pattern_id       INTEGER NOT NULL REFERENCES codebase_knowledge(id),
  session_id       INTEGER NOT NULL REFERENCES investigation_sessions(id),
  confirmed        INTEGER NOT NULL DEFAULT 0,
  contradicted     INTEGER NOT NULL DEFAULT 0,
  confidence_delta REAL NOT NULL DEFAULT 0.0,
  recorded_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pattern_id, session_id)
);

CREATE TABLE IF NOT EXISTS tool_effectiveness (
  id                  INTEGER PRIMARY KEY,
  tool_name           TEXT NOT NULL,
  root_cause_type     TEXT NOT NULL,
  invocations         INTEGER NOT NULL DEFAULT 0,
  led_to_conclusion   INTEGER NOT NULL DEFAULT 0,
  effectiveness_score REAL NOT NULL DEFAULT 0.0,
  last_updated        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tool_name, root_cause_type)
);

CREATE TABLE IF NOT EXISTS hypothesis_accuracy (
  id                   INTEGER PRIMARY KEY,
  session_id           INTEGER NOT NULL UNIQUE REFERENCES investigation_sessions(id),
  issue_key            TEXT NOT NULL,
  predicted_root_cause TEXT NOT NULL,
  predicted_fix_owner  TEXT,
  actual_root_cause    TEXT,
  actual_fix_owner     TEXT,
  was_correct          INTEGER,
  fix_applied_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_hypothesis_accuracy_issue_key ON hypothesis_accuracy(issue_key);
CREATE INDEX IF NOT EXISTS idx_pattern_feedback_pattern_id ON pattern_feedback(pattern_id);
```

## New Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `PUT` | `/api/jira/investigation/:key/outcome` | Record actual root cause + fix owner after user resolves bug. Fills `was_correct` in `hypothesis_accuracy`. |
| `GET` | `/api/jira/brain/stats` | Returns tool effectiveness table, accuracy by root cause type, pattern count, stale knowledge count. |
| `POST` | `/api/jira/brain/refresh-knowledge` | Manually trigger deletion + re-index of stale `codebase_knowledge` rows. |

## Key Files

| File | Role |
|------|------|
| `src/db/schema.ts` | v36 migration — 3 tables + 2 indexes |
| `src/db/queries/investigation.ts` | All Phase 56 helpers: `recordPatternFeedback`, `upsertToolEffectiveness`, `createHypothesisAccuracy`, `resolveHypothesisAccuracy`, `getTopToolsForRootCauseType`, `getBrainStats`, `getStaleKnowledgeIds` |
| `src/intelligence/investigation-orchestrator.ts` | `recordConcludeSignals()` — wires hypothesis + tool stats recording on conclude |
| `src/intelligence/knowledge-indexer.ts` | `extractAndSaveBugPattern()` pattern feedback loop; `refreshStaleEntries()` TTL decay |
| `web-server.js` | 3 new endpoints; `refreshStaleEntries` wired as step 11 of `runFullSync` |
| `web/src/lib/api.ts` | `BrainStats` interface; `brainStats()`, `brainRefresh()`, `recordOutcome()` |
| `web/src/pages/JiraReportPage.tsx` | `BrainStatsPanel` collapsible diagnostic component |
| `docs/docs/adr/adr-014-self-learning-investigation-brain.md` | Full ADR |

## Acceptance Criteria

- [x] `CURRENT_SCHEMA_VERSION = 36` in `src/db/schema.ts`
- [x] `pattern_feedback`, `tool_effectiveness`, `hypothesis_accuracy` tables created by v36 migration
- [x] `idx_hypothesis_accuracy_issue_key` and `idx_pattern_feedback_pattern_id` indexes exist in v36
- [x] All Phase 56 query helpers exported from `src/db/queries/investigation.ts`
- [x] `ALLOWED_SESSION_COLS` allowlist guards `updateSession` against SQL injection
- [x] `KnowledgeIndexer.refreshStaleEntries()` deletes rows older than `KNOWLEDGE_TTL_DAYS=30` and re-indexes
- [x] `extractAndSaveBugPattern` uses `area` column in pattern SELECT (correct UNIQUE key match)
- [x] `recordConcludeSignals` exported from `investigation-orchestrator.ts`
- [x] After a completed investigation: `hypothesis_accuracy` row created, `tool_effectiveness` rows upserted
- [x] `GET /api/jira/brain/stats` → 200 `{ toolEffectiveness, accuracyByRootCause, patternCount, staleKnowledgeCount }`
- [x] `PUT /api/jira/investigation/INVALID/outcome` → 400 (key format validation)
- [x] `PUT /api/jira/investigation/:key/outcome` with valid body → 200 `{ ok: true }`
- [x] `POST /api/jira/brain/refresh-knowledge` → 200 `{ refreshed: N }`
- [x] `BrainStatsPanel` renders in JiraReportPage without console errors
- [x] `BrainStatsPanel` header expands/collapses panel; "Refresh stale" button calls refresh endpoint
- [x] `docs/docs/adr/adr-014-self-learning-investigation-brain.md` exists
- [x] ADR-014 appears in `docs/sidebars.ts`
- [x] `npm run typecheck` exits 0

## Gaps / Follow-ons

These were explicitly scoped out of EP-56 per ADR-014:

- **EP-57 (planned)**: External repo access — add `smrdp-ui-plugins` to `./repos/` so the investigation engine can read its source, not just identify it as the fix owner
- **EP-57 (planned)**: Feature flag change history — `ff_change_log` table capturing FF toggle events for use alongside `gitLogWindow`
- Cold start: first 10–20 investigations have no learning signal — identical to Phase 55 behavior until history accumulates
