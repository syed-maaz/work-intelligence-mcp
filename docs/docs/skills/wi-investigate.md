---
sidebar_label: "wi-investigate"
---

# /wi-investigate

Run a 3-layer ReAct bug investigation on a Jira ticket. Traces git log, feature flags, dependency bumps, call graph, and code changes to produce a confidence-scored root-cause report.

## Usage

```
/wi-investigate <TICKET-KEY>
```

**Example:**
```
/wi-investigate PROJ-15257
```

## What It Does

Invokes the [Investigation Engine](../adr/adr-013-intelligent-bug-investigation.md) via `POST /api/jira/investigate`, then polls until complete and renders the full result.

### Three Investigation Layers

| Layer | What It Searches |
|-------|-----------------|
| **Layer 1 — Knowledge Base** | Codebase ownership map, architecture snapshots, past bug patterns |
| **Layer 2 — Temporal** | Git log window around regression date, feature flag diffs, dependency version changes |
| **Layer 3 — Symptom-Driven** | Call graph traversal from symptom code path, changed file content, grep for related symbols |

### Investigation Tools (10)

- `git_log_window` — commits between regression date ± buffer
- `get_flag_diff` — feature flag status transitions
- `get_dep_diff` — package.json version changes
- `trace_call_graph` — code_graph table traversal
- `read_changed_files` — content of modified files (5 files × 400 lines)
- `get_ownership` — who owns which paths
- `get_bug_history` — pattern matching against past investigations
- `grep_code` — keyword search in repos
- `get_pr` — PR metadata from GitHub
- `call_claude_code` — semantic code research (EP-67)

## Output

```
## Bug Investigation: PROJ-15257

Confidence: 0.82 (High — root cause confirmed)

### ReAct Trace
Iteration 1: [thought] Check git log around Apr 17 regression date
  → git_log_window(from="2026-04-14", to="2026-04-20")
  → Found: 3 commits. PR #6107 stands out: "promote FF_RM_11372 to prod"

Iteration 2: [thought] Verify feature flag status change
  → get_flag_diff(flag="FF_RM_11372", commit="abc123")
  → FF_RM_11372: false → true (promoted in operations PR #6107)

...

### Conclusion
Root cause: Feature flag FF_RM_11372 promoted in acme/operations PR #6107 on Apr 17.
This enabled a new recommendation engine path that was not yet compatible with SMRDP.
Proposed fix: Roll back flag in operations/config/flags.yaml, line 42.

### Evidence Trail
- Commit abc123 (operations PR #6107)
- Feature flag FF_RM_11372 state change
- Code path: src/recommendations/engine.ts:156
```

## Confidence Scale

| Score | Meaning |
|-------|---------|
| ≥ 0.8 | High — root cause confirmed, fix is actionable |
| 0.5–0.79 | Medium — likely root cause, verify manually |
| < 0.5 | Low — hypothesis only, more signals needed |

## After Investigation

The skill will ask: **"Save this investigation to the Jira ticket?"** — on yes, it calls `/wi-save-to-ticket` automatically.

For broader analysis (effort, solution, code impact), use [`/wi-jira-analyze`](./wi-jira-analyze) after.

## Prerequisites

- Bridge running: `npm run web:bridge`
- Connected repos populated in `./repos/example-service` and `./repos/operations`
- Jira MCP token valid (check with `/wi-health`)

## Output contract (orchestrator / dual-engine)

When `InvestigationOrchestrator` runs this skill as a Claude CLI subprocess (ADR-022), the
response must be **structured JSON**, not free-form markdown. Schema:
`src/intelligence/skill-output-schema.ts` (validated with Zod). Required fields per finding:
`rootCauseType`, `rootCause`, `fixOwner`, `isExternalDep`, `confidence`, `example-serviceAction`.
If validation fails, synthesis falls back to the ReAct engine report only.

Interactive `/wi-investigate` in chat still uses the HTTP bridge (`POST /api/jira/investigate`)
and renders the markdown trace below — the JSON contract is for the subprocess path only.

## Related

- [`/wi-jira-analyze`](./wi-jira-analyze) — Broader 5-parallel ticket analysis
- [`/wi-save-to-ticket`](./wi-save-to-ticket) — Save findings to Jira
- [`/wi-ticket-links`](./wi-ticket-links) — Summarize linked content from the ticket
- [ADR-013: Intelligent Bug Investigation](../adr/adr-013-intelligent-bug-investigation.md)
