---
id: adr-015-mempalace-integration
title: ADR-015 — MemPalace Integration for Self-Learning Investigation Brain
---

# ADR-015 — MemPalace Integration: Self-Learning Investigation Brain

| Field | Value |
|-------|-------|
| Status | ⛔ **Superseded by [ADR-016](./adr-016-second-brain-architecture)** (2026-04-26) |
| Sprint | 13 |
| Deciders | Maaz |
| Epic | EP-57 |
| Date | 2026-04-24 |

:::warning Historical reference only
This ADR describes the original `execFileSync` PalaceClient (v1) — a per-call subprocess that blocked the event loop for ~594 ms on every MemPalace operation. It was replaced by the persistent MCP child process via `StdioClientTransport` in **ADR-016 (Second Brain Architecture)**, which dropped per-call latency to 5–20 ms.

Read [ADR-016](./adr-016-second-brain-architecture) for the current architecture. ADR-015's body is preserved here so the original integration rationale and the EP-57 touch-point list remain searchable.
:::

---

## Context

The Bug Investigation Engine (EP-55) shipped in Sprint 12 with a working 3-layer ReAct architecture. PROJ-15257 was the first real test. The engine produced a plausible but **wrong** conclusion: it concluded the root cause was a UI5 async API breaking change in `smrdp-ui-plugins`. The actual root cause was `FF_RM_11372_KNOWLEDGE_APIS_MIGRATION` being promoted from "In Progress" → "Approved for Activation" in `acme/operations` PR #6107 (merged 2026-04-17T10:54Z).

Post-mortem identified four structural gaps:

| Gap | Description |
|-----|-------------|
| GAP-55-A | Engine never calls `git_log_window(repo='operations')` — only scans example-service |
| GAP-55-B | No `get_flag_diff` tool — feature-flags.yaml status transitions completely invisible |
| GAP-55-C | System prompt hardcodes "check SMRDP plugin first" — anchors model before evidence |
| GAP-55-D | No conclude gate — engine can conclude `config-change` without any operations check |

Additionally, the engine has no semantic memory: `findSimilarInvestigation()` uses BM25 keyword matching. A future ticket "BIS panel shows nothing" will not match the prior PROJ-15257 investigation stored as "recommended links blank".

---

## Decision

Layer [MemPalace](https://github.com/mempalace/mempalace) on top of the existing EP-55 engine as an **additive sidecar**. No existing behavior is replaced.

Three principles govern the integration:

1. **Additive only**: All existing SQLite tables, ReAct loop structure, `recordConcludeSignals`, `extractAndSaveBugPattern`, and `findSimilarInvestigation` remain untouched. MemPalace augments, not replaces.

2. **Graceful degradation**: `PalaceClient` wraps all palace calls with `try/catch`. If `MEMPALACE_PATH` is unset or the palace MCP server is unavailable, every palace call returns `''`/`void`. The investigation engine runs identically to EP-55. Zero configuration = zero behavior change.

3. **Minimal coupling**: `InvestigationOrchestrator` receives `palace?: PalaceClient` as an optional constructor param. The palace is called at exactly two points: pre-loop (read) and post-conclude (write). No palace dependency anywhere else.

---

## What Changes

### New Touch Points

| Point | When | What |
|-------|------|------|
| `queryPalaceMemory()` | Before `buildSystemPrompt()` | Semantic search for similar past investigations + temporal KG query for entities near regression date |
| `writeToPalace()` | After `completeInvestigation()`, fire-and-forget | Drawer (full report JSON) + KG triple (causal entity → issueKey) + diary (productive vs. dead-end tools) |

### New Investigation Tool: `get_flag_diff`

Calls `git log` + `git show` on `cluster-setup/feature-flags.yaml` in the operations repo. Parses `Status:` fields before/after each commit in a date window. Returns structured list: `flagName: "oldStatus" → "newStatus"`.

This tool makes feature flag status transitions **visible to the investigation engine** for the first time.

### Updated System Prompt Rules

Rule 1 updated: call `git_log_window` on **both** `example-service` and `operations` in the first iteration.

Rule 6 added: before concluding `config-change`, `dep-upgrade`, or `external-service` — at least one of `get_flag_diff` or `git_log_window(repo='operations')` is required. Enforced by both the prompt rule and a lightweight runtime conclude gate.

### Conclude Gate

After any `conclude` tool call, the gate checks:
```
if rootCauseType ∈ {config-change, dep-upgrade, external-service}
AND no operations tool call in reactTrace
→ reject conclude, inject "GATE REJECTED" message, continue loop
```

The gate is a safety net. The system prompt rule teaches the model to comply; the gate catches the rare case where the model ignores the rule.

### `palace-seeder.ts` (one-time bootstrap)

Runs at web server startup. Parses `repos/operations/cluster-setup/feature-flags.yaml` with a line-by-line state machine (no YAML parser dependency), writes KG triples:
- `(flagName, "has-status", currentStatus)`
- `(flagName, "activated-on", startDate)` — from `Date[].Start`
- `(flagName, "active-in-cluster", clusterName)` — for each `true` cluster

Idempotent. `kgAdd` is a no-op if triple already exists.

---

## Alternatives Considered

### Alternative 1: Add `get_flag_diff` Only (No MemPalace)

Addresses GAP-55-B and GAP-55-D (via the gate). Does not address semantic recall gap.

**Rejected because**: The semantic recall problem will grow as the investigation corpus grows — more tickets = more vocabulary diversity = more BM25 false negatives. MemPalace is already installed; the marginal cost of the sidecar is 2 methods added to the orchestrator.

### Alternative 2: sqlite-vec Extension for Vector Search

Add `sqlite-vec` (SQLite native vector extension), embed investigation reports, do ANN search in `findSimilarInvestigation()`.

**Rejected because**: `sqlite-vec` requires OS/arch-specific native binary compilation — a build dependency with no fallback. Also has no KG equivalent for temporal entity linking. MemPalace provides both vector search and KG in a single local Python package.

### Alternative 3: Store Investigations in claude-mem Plugin

Use the existing `claude-mem` plugin to store/recall investigation observations.

**Rejected because**: `claude-mem` is a Claude Code tool, not an in-process API. The investigation engine runs in a Node.js async IIFE inside `web-server.js` — it cannot call MCP tools. MemPalace is callable via its Python CLI from any Node.js process.

---

## Consequences

### Positive

- **PROJ-15257 replay passes**: With seeded KG, pre-loop context surfaces `FF_RM_11372` before iteration 1. Gate ensures operations check happens before any config-change conclusion.
- **Semantic recall grows over time**: Every completed investigation enriches the palace. Future similar tickets get context injected "for free" from the pre-loop semantic query.
- **Tool effectiveness learning**: Diary entries record productive vs. dead-end tools per root cause type. Future investigations in the same area inherit this guidance via pre-loop diary context.
- **Zero regression risk**: `MEMPALACE_PATH` unset → behavior 100% identical to EP-55.

### Negative / Trade-offs

- **Python subprocess latency**: `PalaceClient` uses `execFileSync` to call the mempalace CLI. Each call adds ~100–300ms. Pre-loop calls run in `Promise.all()` (max not sum). Post-conclude writes are fire-and-forget. Net impact: ~300ms per investigation.
- **External process dependency**: MemPalace must be installed at `MEMPALACE_PATH`. If removed, investigations fall back silently — but the env var must be cleared or startup will log errors.
- **YAML parsing without a parser**: `palace-seeder.ts` uses a line-by-line state machine. Significant format changes to `feature-flags.yaml` will reduce triple count (logged at startup — a drop is detectable).

---

## Knowledge Graph Design

```
Palace wing: investigations
  Rooms: config-change | dep-upgrade | code-regression | external-service | unknown

KG triples (examples):
  (FF_RM_11372_KNOWLEDGE_APIS_MIGRATION, "has-status",        "Approved for Activation")
  (FF_RM_11372_KNOWLEDGE_APIS_MIGRATION, "activated-on",      "2026-04-17")
  (FF_RM_11372_KNOWLEDGE_APIS_MIGRATION, "active-in-cluster", "feat-test")
  (FF_RM_11372_KNOWLEDGE_APIS_MIGRATION, "caused-regression", "PROJ-15257")
  (@types/openui5@1.146.0,               "dep-upgrade-in",    "example-service")

Diary agent: "investigator"
  Entries: per issueKey — productive tools, dead-end tools, root cause type
```

---

## PROJ-15257 Replay Walkthrough

With EP-57 in place and palace seeded:

```
Pre-loop:
  queryPalaceMemory("BIS recommended links not showing", regDate=2026-04-17)
  → kgQuery("changes near 2026-04-17")
  → Returns: FF_RM_11372: activated-on=2026-04-17, active-in-cluster=feat-test

System prompt ## Memory Palace Context section now contains this KG hit.

Iteration 1 (parallel):
  git_log_window(repo='example-service', since='2026-04-14', until='2026-04-20')
  git_log_window(repo='operations', since='2026-04-14', until='2026-04-20')
  get_flag_diff(since='2026-04-14', until='2026-04-20')
  → get_flag_diff returns: FF_RM_11372: "In Progress" → "Approved for Activation"

Iteration 2:
  read_file(repo='operations', file='cluster-setup/feature-flags.yaml', ...)
  → confirms FF_RM_11372 is the knowledge APIs migration flag

Iteration 3:
  conclude:
    rootCauseType: "config-change"
    rootCause: "FF_RM_11372_KNOWLEDGE_APIS_MIGRATION promoted to Approved for Activation on 2026-04-17 in operations PR #6107"
    fixOwner: "Platform / Knowledge team"
    confidence: 0.92

  Conclude gate: rootCauseType='config-change' AND get_flag_diff ∈ trace → GATE PASSES
```


---

## Implementation Plan

See `.planning/phases/57-mempalace-integration/` for 5-wave execution plan:

| Wave | Deliverable |
|------|-------------|
| 57-01 | `palace-client.ts` + `palace-seeder.ts` |
| 57-02 | `queryPalaceMemory()` + system prompt injection |
| 57-03 | `writeToPalace()` + post-conclude write |
| 57-04 | `get_flag_diff` tool + conclude gate |
| 57-05 | `web-server.js` wiring + smoke test |

## Files Changed

| File | Change |
|------|--------|
| `src/intelligence/palace-client.ts` | NEW — `PalaceClient` wrapper, 6 methods, graceful no-op fallback |
| `src/intelligence/palace-seeder.ts` | NEW — parse feature-flags.yaml, write KG triples at startup |
| `src/intelligence/investigation-orchestrator.ts` | ADD `palace?` param, `queryPalaceMemory()`, `writeToPalace()`, `get_flag_diff` tool, conclude gate, updated system prompt rules |
| `web-server.js` | Pass `PalaceClient` to orchestrator when `MEMPALACE_PATH` set; run seeder at startup |
