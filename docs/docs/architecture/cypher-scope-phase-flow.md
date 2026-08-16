# Cypher SCOPE (refinement) phase — flow map & the 60s-halt bug

> **Status:** live investigation doc, 2026-07-14. Cause 1 fixed; Cause 2 open.
> **Code:** `src/services/cypher/loop.ts` (SCOPE block ~L917–L1310), `src/services/cypher/tool-catalog.ts` (`effectiveToolPhase` L2256, `getCatalogForPhase` L2280).
> **Companion memory:** `memory/bug_scope_phase_heavyweight_tool_leak.md`.

## What the SCOPE phase is

`/wi <goal>` runs a **two-pass loop** (ADR-039), gated by `CYPHER_REFINEMENT_ENABLED=1`:

1. **SCOPE (plan)** — take the fuzzy goal, gather cheap context, emit a structured `refined_goal` JSON brief. Read-only. Budgeted at **60s** (`CYPHER_SCOPE_MAX_WALLCLOCK_MS`).
2. **EXECUTE (do)** — the brief drives the real work with the full toolbox.

The bug: SCOPE routinely halts at 60s with `"wall-clock budget (60000ms) exhausted after 1 iter(s)"` — before it can hand off to EXECUTE.

## Diagram 1 — What actually happens, in order (real probe timings, session `cyp_4165ee97fc7a`)

```mermaid
sequenceDiagram
    autonumber
    participant U as You
    participant L as SCOPE loop
    participant M as Model via proxy
    participant T as Tool handlers
    participant W as Wall-clock guard 60s

    U->>L: goal "check code-scanning alerts on lotse"
    Note over L: scopeStartMs = now

    rect rgb(230,245,230)
    Note over L,W: ITER 1 — elapsed 0s
    L->>W: budget check OK
    L->>M: refine? system + catalog + goal
    M-->>L: 2.5s — stop_reason tool_use
    L->>T: brain_recall
    T-->>L: 26ms OK
    L->>T: wi_search
    T-->>L: 42ms OK
    end

    rect rgb(255,245,220)
    Note over L,W: ITER 2 — elapsed ~2.5s
    L->>W: budget check OK
    L->>M: here are tool results, refine
    M-->>L: 13.9s — end_turn, prose no JSON
    end

    rect rgb(255,235,210)
    Note over L,W: ITER 3 — elapsed ~16s
    L->>W: budget check OK
    L->>M: still no JSON, retry
    M-->>L: 13.2s — end_turn
    end

    rect rgb(255,225,200)
    Note over L,W: ITER 4 — elapsed ~30s
    L->>W: budget check OK
    L->>M: refine
    M-->>L: 9.8s — end_turn, VALID brief finally
    end

    rect rgb(255,205,205)
    Note over L,W: ITER 5 attempt — elapsed ~64s
    L->>W: budget check FAILS 64s over 60s
    W-->>U: HALT wall-clock exhausted
    end

    Note over U,W: brief produced at iter 4 ~64s but guard already fired
```


**The load-bearing fact:** tools (green) cost **68ms total**. The four model calls (2.5 + 13.9 + 13.2 + 9.8 ≈ **40s**) are the problem. Add growing message history and the 4th round lands past 60s.

## Diagram 2 — The two independent roads to the same cliff

```mermaid
flowchart TD
    G([You give a goal]) --> LLM{Refiner model picks what to do}

    LLM -->|end_turn - just reasons| ROUNDS[Needs 3-4 rounds, ~12s each]
    LLM -->|tool_use - calls a tool| WHICH{Which tool from scope catalog}

    WHICH -->|light: brain_recall, wi_search, fts_search| FAST[Returns under 100ms]
    WHICH -->|HEAVY: wi_investigate 25s, typecheck_run 30s, wi_search_all browser-scrapes| SLOW[Blocks 25-90s]

    FAST --> ROUNDS
    SLOW --> CLIFF[60s budget blown]
    ROUNDS --> RACE{Total time vs 60s}
    RACE -->|fast day under 60s| OK([Brief produced, EXECUTE runs])
    RACE -->|slow day 4 rounds over 60s| CLIFF
    CLIFF --> HALT([HALTED])

    style SLOW fill:#ffcccc
    style CLIFF fill:#ff9999
    style HALT fill:#ff6666
    style OK fill:#ccffcc
    style FAST fill:#ccffcc
```


- **Road 1 (right, red) — heavy tool.** Model calls a tool that does *real work* mid-plan. **FIXED 2026-07-14:** `effectiveToolPhase` now excludes any untagged tool with `estimated_duration_ms > 3000` from the SCOPE catalog (scope 28→20 tools). Road closed.
- **Road 2 (left, amber) — too many rounds.** Even with only light tools, the model takes 3-4 turns @ ~12s to write valid JSON. **OPEN, dominant.**

## Why those specific tools were dangerous (your literal question)

| Tool | Declared `est_ms` | What the handler *actually* does | In SCOPE after fix? |
|---|---|---|---|
| `wi_investigate` | 25000 | Dispatches a full investigation **subagent** (its own LLM + tool calls) | ❌ excluded |
| `typecheck_run` | 30000 | Runs `tsc` over the repo | ❌ excluded |
| `wi_search_all` | 60000 | Launches **headless Chrome**, scrapes Outlook (90s timeout) + 100 Jira issue pages one-by-one over HTTP | ❌ excluded |
| `wi_jira_analyze` | 12000 | LLM analysis of a Jira issue | ❌ excluded |
| `brain_verify` | 8000 | Hits GitHub/Jira MCP servers | ❌ excluded |
| `wi_search` | 1000 | SQLite FTS query | ✅ kept |
| `fts_search` | 1200 | SQLite FTS query | ✅ kept |
| `brain_recall` | 500 | SQLite/palace lookup | ✅ kept |

The trap: a tool's **declared duration ≠ its real cost**, and some "search"-named tools secretly do heavy I/O (`wi_search_all` = browser automation). The duration-number fix catches them *because* their declared durations were honestly high — but a future tool that *under*-declares would still slip through. That's the argument for eventually tagging by **category** (browser/subagent/network), not just duration.

## Fix status

- **Cause 1 (heavy-tool leak):** ✅ fixed — `effectiveToolPhase` duration fallback. `SCOPE_UNTAGGED_MAX_DURATION_MS = 3000`.
- **Cause 2 (round-count × latency race):** ⬜ open. Candidate fixes:
  - **(a) prompt-tighten** the refiner to emit the JSON brief in **1 round** (cuts round count — biggest lever).
  - **(b) raise** `CYPHER_SCOPE_MAX_WALLCLOCK_MS` to ~90s (safety cushion).
  - **(c) harder prompt-cache** the refiner system prompt + shrink catalog hint (cuts per-call tokens → latency).
  - Recommended: **(a) + (b)**.
