---
id: ep57-mempalace-integration
title: EP-57 — MemPalace Integration
---

# EP-57 — MemPalace Integration

| Field | Value |
|-------|-------|
| Sprint | Sprint 13 |
| Status | ✅ Done (2026-04-24) |
| ADR | [ADR-015](../adr/adr-015-mempalace-integration) |
| Schema | None (MemPalace is an external local process) |
| Depends On | EP-55 ✅ (InvestigationOrchestrator), EP-56 ✅ (recordConcludeSignals) |
| Effort | 1 session (5 waves) |

## Problem

Sprint 12 delivered a working investigation engine, but PROJ-15257 post-mortem revealed two structural gaps:

1. **Cross-repo blindness** — the engine only calls `git_log_window` on `example-service`. The actual root cause of PROJ-15257 was a feature flag flip in `acme/operations` PR #6107 (`FF_RM_11372_KNOWLEDGE_APIS_MIGRATION` promoted to "Approved for Activation"). This was completely invisible to all existing tools.

2. **No semantic recall** — `findSimilarInvestigation()` uses keyword matching. A future ticket saying "BIS panel shows nothing" won't match a prior investigation filed under "recommended links blank". Vector search would catch this; keywords don't.

A third gap: after investigations complete, there is no machine-readable record of *which tools led to the conclusion vs. which were dead ends*. The diary mechanism in Phase 56 is a proxy, but it doesn't surface as context in the next investigation's system prompt.

## Solution

Layer [MemPalace](https://github.com/mempalace/mempalace) on top of the existing investigation engine as an **additive sidecar** — nothing in the existing process is replaced. MemPalace runs as a separate Python process, exposed via its 29 MCP tools. The orchestrator calls it at two points: before the ReAct loop (read) and after conclude (write).

**Constraint**: All existing SQLite tables, query helpers, `recordConcludeSignals`, `extractAndSaveBugPattern`, `findSimilarInvestigation`, and the ReAct loop structure remain untouched. MemPalace is optional — if not installed, all palace calls are no-ops via a graceful `PalaceClient` fallback.

## Touch Points

### 1 — `PalaceClient` wrapper (`src/intelligence/palace-client.ts`)

Thin wrapper around `McpClient` for MemPalace's MCP server. Exposes only the methods the orchestrator needs:

```ts
export class PalaceClient {
  async search(query: string, wing?: string, limit?: number): Promise<string>
  async kgQuery(entity: string): Promise<string>
  async kgAdd(subject: string, predicate: string, object: string, start?: string): Promise<void>
  async addDrawer(wing: string, room: string, content: string): Promise<void>
  async diaryWrite(agent: string, entry: string, topic: string): Promise<void>
  async diaryRead(agent: string, n?: number): Promise<string>
}
```

`InvestigationOrchestrator` receives `private palace?: PalaceClient` as an optional constructor param. All palace calls are guarded: `if (!this.palace) return`.

---

### 2 — Pre-loop context enrichment (`queryPalaceMemory`)

Called in `investigate()` after `findSimilarInvestigation()` check, before `buildSystemPrompt()`.

Two parallel calls:
- `mempalace_search(query="<title> <description>", wing="investigations", limit=5)` — semantically similar past investigations
- `mempalace_kg_query` filtered by regression date window — surfaces flags/deps that changed around that date

Result injected as a new `## Memory Palace Context` section in `buildSystemPrompt()`. For PROJ-15257 this would have surfaced `FF_RM_11372` before the model formed any hypothesis.

---

### 3 — Post-conclude write (`writeToPalace`)

Called in `investigate()` after `completeInvestigation()`, non-blocking (fire-and-forget `.catch`):

1. **`mempalace_add_drawer`** — full investigation report JSON as drawer in `wing=investigations, room=<rootCauseType>`
2. **`mempalace_kg_add`** — if root cause involved a flag or dep: `(entity, "caused-regression", issueKey, start=regressionDate)`
3. **`mempalace_diary_write`** — summary of which tools led to conclusion vs. dead ends, keyed to issueKey

---

### 4 — `get_flag_diff` investigation tool

New entry in `INVESTIGATION_TOOLS` and `dispatchTool`:

```ts
{
  name: 'get_flag_diff',
  description: 'Show feature flag status changes in operations/feature-flags.yaml between two dates.',
  input_schema: {
    properties: {
      since: { type: 'string', description: 'Start date YYYY-MM-DD' },
      until: { type: 'string', description: 'End date YYYY-MM-DD' },
    },
    required: ['since', 'until'],
  },
}
```

Implementation: `git log --diff-filter=M -- cluster-setup/feature-flags.yaml` in the operations repo, then `git show` the file at each commit, parse YAML, diff `Status` fields. Returns structured list: `flag, from_status, to_status, commit, author, date`.

---

### 5 — Parallel operations git scan in iteration 1

In `buildSystemPrompt()`, add to investigation rules:

> For UI/frontend regression bugs, call `git_log_window` on **both** `example-service` and `operations` in the same iteration. Never conclude config-change or dep-upgrade root cause without at least one operations repo check.

And add a `conclude` gate: if `rootCauseType !== 'code-regression'` and no `git_log_window(repo='operations')` or `get_flag_diff` call exists in the trace, reject the conclude with an injected message.

---

### 6 — `palace-seeder.ts` (one-time bootstrap)

`src/intelligence/palace-seeder.ts` — reads `cluster-setup/feature-flags.yaml` from `./repos/operations`, writes one KG triple per flag for its current status. Run once at startup if palace is empty. Subsequent updates happen incrementally via touch point 3.

---

### 7 — `web-server.js` wiring (Wave 5)

- Startup seeder: `if (process.env.MEMPALACE_PATH)` → fire-and-forget `runPalaceSeeder()` after auto-sync loop starts
- Investigation handler: conditionally instantiate `PalaceClient` and pass as 6th param to `InvestigationOrchestrator` constructor

## Acceptance Criteria

- [x] `PalaceClient` instantiates cleanly; all methods return empty strings / no-op when MemPalace MCP server is not running
- [x] `queryPalaceMemory()` runs before `buildSystemPrompt()` and injects results when palace has relevant content
- [x] `writeToPalace()` fires after `completeInvestigation()` without blocking the return value
- [x] `get_flag_diff` tool returns flag status changes for a date range from the operations repo
- [x] `git_log_window(repo='operations')` is called in iteration 1 for any ticket where regression date confidence > 0.5
- [x] `conclude` with `rootCauseType='config-change'` and zero operations tool calls → rejected, injected reminder
- [x] `npm run typecheck` passes (zero errors)
- [x] If `MEMPALACE_PATH` env var unset, all palace calls are no-ops — existing behavior 100% preserved
- [x] Palace seeder log appears at web server startup when `MEMPALACE_PATH` is set

## Setup

```bash
pip install mempalace
mempalace init ~/.work-intelligence-mcp/palace

# Add to .env:
MEMPALACE_PATH=~/.work-intelligence-mcp/palace
```

Register the MCP server (one-time):
```bash
claude mcp add mempalace -- python -m mempalace.mcp_server --palace ~/.work-intelligence-mcp/palace
```

## Files Changed

| File | Change |
|------|--------|
| `src/intelligence/palace-client.ts` | New — `PalaceClient` wrapper |
| `src/intelligence/palace-seeder.ts` | New — one-time KG bootstrap from operations feature flags |
| `src/intelligence/investigation-orchestrator.ts` | Add `palace?: PalaceClient` param, `queryPalaceMemory()`, `writeToPalace()`, `get_flag_diff` tool, operations parallel scan rule, conclude gate |
| `web-server.js` | Pass `PalaceClient` to `InvestigationOrchestrator` constructor when `MEMPALACE_PATH` set; startup seeder |
| `.env` (docs) | `MEMPALACE_PATH` optional env var |
