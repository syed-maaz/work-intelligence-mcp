# Environment Variables

> Full reference for `.env`. `CLAUDE.md` links here instead of inlining this — it's reference, not turn-by-turn guidance.

## Required

```
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_PATH=./data/intelligence.db   # defaults to in-memory if unset
```

## Anthropic / browser / sync

```
ANTHROPIC_BASE_URL=...   # proxy override — triggers custom auth headers in AIAnalyzer
BROWSER_PROFILE_PATH=... # Chrome profile path (chrome://version → "Profile Path"); required for browser connectors
BROWSER_HEADLESS=false   # show browser window (default: true / headless)
BROWSER_EXECUTABLE=...   # path to Chrome executable (optional override)
SYNC_INTERVAL_MS=900000  # background sync interval in ms (default: 15 min)
SYNC_TEAMS_UNREAD_ONLY=1 # bridge full sync: unread badge only (default: incremental since last sync)
TEAMS_UNREAD_ONLY=1      # teams-sync CLI: same opt-in fast mode
TEAMS_SINCE_DAYS=90      # teams-sync: days of history to load
```

`NOTEBOOK_REFRESH_INTERVAL_MS=3600000` — minimum interval (ms) between background refreshes of any single topic notebook (updateNotebook cost-reduction Option 4, 2026-06-23). The sync loop and targeted Teams-sync trigger respect this gate; user-facing `GET /api/notebooks/:topicName` always refreshes on demand and resets the gate. Set to `0` to disable (refresh every sync cycle). See `.planning/updatenotebook-cost-reduction/01-*.md § 7 Option 4`.

## Jira

```
JIRA_BOARD_URL=...       # default Jira board URL for search_all
JIRA_PROJECT_KEY=...     # default Jira project key
JIRA_SOURCE=auto         # mcp | browser | auto (default: auto)
                         #   mcp: Jira MCP server only (requires one-time mcp-setup)
                         #   browser: Playwright scraper only (requires BROWSER_PROFILE_PATH)
                         #   auto: try MCP first, fall back to browser on any error
JIRA_MCP_URL=...         # override MCP server URL (default: https://mcp.example.com/jira)
```

No `JIRA_MCP_TOKEN` needed — tokens are managed automatically in SQLite via `McpClient`.
One-time setup: `npm run mcp-setup -- --name my-jira --url https://mcp.example.com/jira`

## MemPalace

```
MEMPALACE_PATH=...       # palace data directory (unset → palace disabled, zero regression)
MEMPALACE_PYTHON=...     # override Python path for MemPalace (default: auto-detect python3)
```

## Code Graph Indexer (ADR-027 v2)

```
CODE_GRAPH_INTERVAL_MS=...       # incremental cadence in ms. Default 1h. Agent ticks on a
                                 # 60s heartbeat, reads persisted UTC due_at rows from
                                 # sync_state; Sunday 03:17 UTC full sweep is wall-clock-aligned.
                                 # Manual force-refresh after rsync:
                                 #   POST /api/code-graph/index {"repo":"example-service"|"operations"|"all"}
CODE_GRAPH_INDEX_DISABLED=1      # kill-switch. When set, the CodeGraphIndexer agent is NOT
                                 # registered at boot. Use when indexing is wedged and you need
                                 # to inspect state without the agent racing manual probes. (item #5)
CODE_GRAPH_INDEX_TIMEOUT_MS=600000  # audit F-027-1: hard deadline around indexer.indexRepo /
                                 # indexChangedSince so a hung indexer can't hold the per-repo
                                 # lock indefinitely. Default 600000 (10 min). Same shape as the
                                 # Jira-analyse spinner fix (commit 49be41c).
```

## Bug pipeline (ADR-030)

```
BUG_INVESTIGATOR_ENABLED=1       # when 0, BugInvestigatorAgent (Phase B) does not register.
                                 # Phase A captures bugs regardless — this only disables the AI
                                 # investigation step. Default 1.
BUG_AUTO_MERGE=0                 # Phase D: when 1, the auto-merge gate may fire. Default 0. Even
                                 # with this flag, all gates from ADR-030 § Decision must pass.
                                 # 0 converts every Phase D path back to draft-PR-only.
BUG_INVESTIGATOR_MAX_PER_HOUR=10 # Phase B: max brain investigation calls/hour, via
                                 # src/services/brain/budget.ts. Default 10.
BUG_INVESTIGATOR_INTERVAL_MS=300000  # Phase B (75-04): polling cadence in ms. Default 5 min.
                                 # Lower to 60000 in dev; raise to 1800000 once tuning settles.
BUG_RESOLVER_ENABLED=0           # Phase C: when 1, BugResolverAgent registers and
                                 # POST /api/bugs/:id/resolve-attempt enqueues work. Never polls
                                 # (ticks only on enqueue); never pushes from any branch.
                                 # Default 0 (opt-in) — the resolver mutates WI's OWN source
                                 # (git apply + commit), so it must be explicitly enabled.
                                 # Scope: WI source ONLY — never ./repos/, never outside the WI
                                 # repo (sibling/outside paths fail at the path-classifier gate).
```

## Cypher recognition hook — CAP-13-LITE (ADR-037.5 v2, 2026-06-25)

```
CAP13_LITE_ENABLED=1     # kill-switch for the recognition hook in src/services/cypher/loop.ts.
                         # Default 1. '0' disables the hook entirely — no rows to
                         # plan_shape_gap_observed even when gate predicates fire. Read at every
                         # hook fire (no module cache), so flipping mid-bridge takes effect next
                         # dispatch. PRD V-01.
CAP13_GAP_THRESHOLD=0.3  # posterior-rate threshold below which the gate fires. Default 0.3.
                         # Clamped to [0.0,1.0]; non-numeric → default. Empirically untuned at v1
                         # (inherited from the 2026-06-14 spike). PRD V-02.
CAP13_MIN_PRIORS_RUNS=5  # minimum prior_count for the gate to fire. Default 5. Non-negative int;
                         # non-int → default. Rejects newly-seen plan shapes with no history.
                         # PRD V-03.
```

## Cypher loop engine (ADR-037)

```
CYPHER_LOOP_ENABLED=0    # DEFAULT IS LOOP in web-server.js
                         # (useLoop = process.env.CYPHER_LOOP_ENABLED !== '0').
                         # Set to "0" to route /api/wi/dispatch back through the legacy v1.4
                         # pipeline (src/services/cypher/run.ts) — escape hatch. Any other value
                         # (incl. unset) = loop. Phase 7 deletes run.ts (landing 2026-07-21);
                         # switch-back is a one-env-var flip, no code change.
CYPHER_PHASE2_COUNT_MIN=3      # D15/Q-1.10 (Phase 3): min prior confirmed dispatches with the
                              # same plan_shape_hash for Phase 2-soft to activate. Below → Phase 1
                              # (explicit confirm). Default 3.
CYPHER_PHASE2_RATE_MIN=0.8    # D15/Q-1.10: min success rate across those priors for Phase 2-soft.
                              # Range 0..1. Default 0.8. 0 disables the rate gate; 1.0 requires a
                              # perfect track record.
CYPHER_PHASE2_VETO_DELAY_MS=3000  # D16: Phase 2-soft veto window (ms). After plan render the
                              # controller sleeps this long before the first tool call;
                              # interruptible by /stop. Default 3000. 0 disables (trusted
                              # batch/cron). Subsequent tool calls fire without per-call delay.
CYPHER_CONFIRM_MODE=          # D15/Q-1.11: per-session override. Empty (default) = honor D15
                              # count+rate gates. `auto` = skip Phase 1 (Phase 2-soft, zero veto
                              # window). `always` = force Phase 1 every dispatch. Per-dispatch
                              # override: /wi --confirm.
CYPHER_HIDE_ENGINE_BADGE=     # D20: suppress the [engine: loop|pipeline] prefix on the first
                              # stream chunk. Default empty (badge visible). Set 1 once Phase 4
                              # dual-engine rollback signaling is no longer needed.
```

## Connected repos (Sprint 7 — EP-43+)

```
example-service_PATH=./repos/example-service
OPERATIONS_PATH=./repos/operations
GITHUB_TOKEN=ghp_...
example-service_GITHUB=org/example-service
OPERATIONS_GITHUB=org/operations
```
