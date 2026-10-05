---
sidebar_position: 1
title: Cypher loop trace — demo run
---

# Cypher loop trace — demo run

> **Auto-generated** by `npm run demo:trace` (`scripts/demo-loop-trace.mjs`).
> Reproducible: set `ANTHROPIC_API_KEY` and re-run — this page is overwritten from the loop's own `cypher_steps` audit rows, never hand-faked.

## Run facts

- **Goal:** What happened with the PROJ-101 widget rollout on acme/widgets? Summarize the work, the postmortem, and any open items.
- **Session:** `cyp_demo_66e2029b-9500-48e2-b65b-0d87e3fc9508` · posture=`generic` · task_class=`generic` · user=`demo`
- **Database:** `./data/demo.db`
- **Generated:** 2026-10-05T12:11:25.145Z · engine=loop · max_iterations=10
- **Loop verdict:** `success` (cypher_sessions.outcome=`success`)
- **Surface:** "## PROJ-101 — Widget rollout on `acme/widgets`

Here's what the message trail shows (5 linked items across Teams, Jira, and Email; all from the same incident cluster). Heads-up: `acme/widgets` isn't an indexed repo in this environment, so t…"
- **Tool calls:** 10 · duration 40952ms
- **Tokens:** input 9597 · output 2348 · cache-read 76742 · cache-write 489
- **Beta-prior snapshot at entry:** count=0, success_rate=null (cold start)

## SCOPE refine

No SCOPE pass ran — single-pass execute (CYPHER_REFINEMENT_ENABLED not set; see ADR-039 AC-7). The loop went straight to the execute-phase tool loop.

## Eligible tool surface (posture=generic)

The catalog exposes 48 tools to the model for this posture; the loop picked 10 of them. "Why eligible" per pick is the catalog's own description.

- `brain_recall` — Recall similar past decisions, clusters, and palace drawers for a goal pattern. Use early in dispatch to ground reasoning in prior work — ca…
- `cypher_self_assess` — Read Cypher's own track record on (posture, task_class, user). Returns confidence (Beta posterior), tier_used (T0–T3), n_similar_tasks, rece…
- `brain_decide` — Generate a structured decision with rationale + evidence + alternatives for a specific question. EXPENSIVE — uses the `decide` bucket (Opus …
- `brain_verify` — Verify a factual claim against authoritative sources (GitHub MCP, Jira MCP, code grep, build logs). Use when a claim's truth matters for the…
- `brain_context` — Fetch the current operational context for the user: sprint, stuck Jiras, today's calendar, open investigations, stale warnings. Use when the…
- `palace_search` — Search the MemPalace semantically across all wings for drawers matching a natural-language query. Use to ground reasoning in prior captured …
- `palace_recall` — Recall drawers from a specific MemPalace wing, optionally filtered by query. Use when the relevant wing is known (e.g. "decisions" or "inves…
- `fts_search` — Find messages across Jira, Teams, Email, and GitHub via the WI BM25 FTS5 index. Use when you need verbatim quotes, source IDs, or evidence s…
- `code_graph_blast_radius` — List direct and transitive dependents of a file in a configured repo. Use when sizing a PR risk, planning a refactor, or asking "what else d…
- `code_graph_owners` — List code owners for a file — CODEOWNERS entries plus recent contributors ranked by commit count. Use before tagging a reviewer or routing a…
- `code_graph_test_coverage` — Find tests that exercise a given file in a configured repo. Use when proposing a fix to estimate which test files will need to run, or when …
- `code_graph_reindex` — Force a code-graph re-index of configured repos. Use after a fresh rsync or when blast_radius/test_coverage look stale. Burns CPU for 1-10 m…
- `wi_search` — Fast LOCAL-ONLY search across the already-synced Jira / Teams / Email / GitHub messages (WI FTS5 index — no live fetch). Use as a broad firs…
- `wi_investigate` — Run a 3-layer ReAct bug investigation on a Jira ticket — traces git log, feature flags, dep bumps, call graph, code changes into a confidenc…
- `wi_pr_review` — AI-assisted PR review enriched with linked Jira tickets, past similar-change patterns, ownership map, and risk flags. Call when reviewing a …
- `wi_blast_radius` — Compute blast radius for a file change — direct and transitive dependents, affected tests, and a risk score. Call before proposing edits to …
- `wi_update_context` — Flush the current Claude Code session into Work Intelligence — investigations, decisions, bugs, code edits — to all four memory surfaces. Ca…
- `wi_bug_resolve` — Mark a single WI bug as resolved or wont-fix by its numeric ID. Call when a captured bug has been fixed (commit landed) or explicitly declin…
- `wi_bug_resolve_all` — Trigger the BugResolverAgent on every matching proposed bug to attempt actual resolution. Call when the investigator has produced patches th…
- `wi_sync` — Trigger a full background sync of Jira, Teams, Email, and GitHub and report what changed. Call when the user reports staleness or before a p…
- `wi_jira_analyze` — Run the 5-parallel AI analysis pipeline on a Jira ticket — classify, effort, plain-English explanation, solution proposal, code impact. Call…
- `wi_pre_meeting` — Generate pre-meeting context — attendees with recent activity, past meetings with this group, open action items, linked Jira tickets. Call b…
- `wi_morning_brief` — Generate the morning briefing — calendar with pre-meeting context, open Jiras, overnight Teams activity, open action items. Call once per da…
- `wi_action_items` — List open action items across Jira, Teams, and Email. Call when the user asks "what do I owe" or planning the day; do NOT call as a search s…
- `wi_bug_report` — Capture a bug into the WI bugs table with idempotent fingerprinting (same payload increments occurrence_count). Call when the user describes…
- `wi_search_all` — Cross-source search: returns the local FTS result across Jira/Teams/Email/GitHub immediately, and kicks a live Outlook+Jira scrape in the ba…
- `wi_teams_search` — FTS5 search across Teams messages and meeting transcripts, ranked and grouped by chat with missing-transcript alerts. Call when the user ref…
- `wi_daily_digest` — Get the AI-generated daily activity digest for a topic — key events, decisions, open items in the last 24h. Call when the user asks for a to…
- `wi_check_links` — Validate [[wikilinks]] across the WI auto-memory directory and report unresolved refs. Read-only — never writes. Call when memory drift is s…
- `wi_skill_install` — Install or re-verify the WI skill catalog into the user Claude Code skill directory (idempotent symlink wiring). Call after a fresh clone or…
- `wi_save_to_ticket` — Append investigation findings or session notes to a Jira ticket investigation_notes field. Call when the user says "save this to ticket"; do…
- `cypher_project_create` — Register a new project so tasks can be opened under it. Idempotent — calling twice with the same id returns the existing row unchanged. Use …
- `cypher_project_list` — List all known projects. Call this FIRST when uncertain whether a project slug exists before cypher_task_create or cypher_project_create. Re…
- `cypher_task_create` — Create a new persistent task that survives bridge restarts and spans multiple dispatches. Use when starting a multi-dispatch work unit (PR r…
- `cypher_task_list` — List open (or filtered) tasks. Call to find an existing task_id for a goal before creating a new one — avoids duplicate tasks. Returns task …
- `cypher_task_close` — Close a task when the work is done or abandoned. Sets status='closed' and records a reason. Call this at the end of the final dispatch for a…
- `cypher_task_show_context` — Read the curator-distilled context for a task: summary, open_questions, things_tried, dispatch count. Call at the start of a dispatch when t…
- `cypher_task_recurate` — Flag a task's context for re-curation on the next dispatch. Use when the existing context is from an older curator format (rendered block sh…
- `cypher_grant_create` — Persist a permission grant so subsequent matching tool calls skip the confirm prompt. Use AFTER the user has said yes — e.g. 'yes, and you c…
- `cypher_grant_list` — List existing permission grants. Use to check whether a similar grant already exists before issuing a new one. Filter by status (defaults to…
- `cypher_grant_revoke` — Revoke an active permission grant by id. Use when the user wants to take back a previously-issued approval or when a grant has outlived its …
- `cypher_compact_context` — Fold older tool results into a single summary so the dispatch can continue when context fills up before the hard 200K cap. Pass the iteratio…
- `cypher_gc_run` — Run the GC retention sweep across cypher_steps (rollup → summary), cypher_sessions (weekly rollup), permission_uses (90d delete), dispatch_s…
- `smoke_run` — Run the npm run smoke:bridge suite (or a single section) to verify bridge behaviour. Call after non-trivial bridge/service/db changes before…
- `typecheck_run` — Run npm run typecheck against the root (and optionally web/) TypeScript projects. Call after TS edits to catch type regressions before smoke…
- `clarify` — Pause the loop and surface a question to the user. Call when reasoning is genuinely blocked on missing information that the user alone can s…
- `cypher_record_outcome` — Write a cypher_outcomes row to close the loop with a verdict. Call exactly once at the end of a dispatch — the loop terminator. Do NOT call …
- `emit_sub_task_event` — Emit a structured event to the PM tier during execution (ADR-053). Use when you hit a question, produce a partial result, hit a blocker, or …

## Turn-by-turn annotated trace

### Turn 0 — tool `brain_recall`

- **Stage:** `execute` (tool_use row)
- **Tool picked:** `brain_recall`
  - **Why eligible:** Recall similar past decisions, clusters, and palace drawers for a goal pattern. Use early in dispatch to ground reasoning in prior work — call ONCE per dispatch, near the start.
  - **Input:** ```json
{"pattern":"PROJ-101 widget rollout acme/widgets postmortem"}
```
  - **Recall lanes hit:** query-only (no lane filter) — query `PROJ-101 widget rollout acme/widgets postmortem`
- **Model reasoning (iteration):** "I'll ground this in prior work and search across sources. Let me start with a couple of independent lookups."
- **EXECUTE:** `completed` in 2ms

### Turn 1 — tool `wi_search`

- **Stage:** `execute` (tool_use row)
- **Tool picked:** `wi_search`
  - **Why eligible:** Fast LOCAL-ONLY search across the already-synced Jira / Teams / Email / GitHub messages (WI FTS5 index — no live fetch). Use as a broad first-pass when grounding a goal in prior work. For an exhaustive LIVE fetch + extraction across all sou…
  - **Input:** ```json
{"query":"PROJ-101 widget rollout"}
```
  - **Recall lanes hit:** query-only (no lane filter) — query `PROJ-101 widget rollout`
- **EXECUTE:** `completed` in 1ms

### Turn 2 — tool `fts_search`

- **Stage:** `execute` (tool_use row)
- **Tool picked:** `fts_search`
  - **Why eligible:** Find messages across Jira, Teams, Email, and GitHub via the WI BM25 FTS5 index. Use when you need verbatim quotes, source IDs, or evidence snippets for a keyword or phrase. Skip when the goal is semantic recall of past decisions — use brain…
  - **Input:** ```json
{"limit":20,"query":"PROJ-101 widget"}
```
  - **Recall lanes hit:** query-only (no lane filter) — query `PROJ-101 widget`
- **Model reasoning (iteration):** "Thin results. Let me dig deeper on the ticket itself and any postmortem/open items."
- **EXECUTE:** `completed` in 3ms

### Turn 3 — tool `wi_search`

- **Stage:** `execute` (tool_use row)
- **Tool picked:** `wi_search`
  - **Why eligible:** Fast LOCAL-ONLY search across the already-synced Jira / Teams / Email / GitHub messages (WI FTS5 index — no live fetch). Use as a broad first-pass when grounding a goal in prior work. For an exhaustive LIVE fetch + extraction across all sou…
  - **Input:** ```json
{"query":"widget rollout postmortem"}
```
  - **Recall lanes hit:** query-only (no lane filter) — query `widget rollout postmortem`
- **EXECUTE:** `completed` in 1ms

### Turn 4 — tool `wi_search`

- **Stage:** `execute` (tool_use row)
- **Tool picked:** `wi_search`
  - **Why eligible:** Fast LOCAL-ONLY search across the already-synced Jira / Teams / Email / GitHub messages (WI FTS5 index — no live fetch). Use as a broad first-pass when grounding a goal in prior work. For an exhaustive LIVE fetch + extraction across all sou…
  - **Input:** ```json
{"query":"cache invalidation rollback widget open items action"}
```
  - **Recall lanes hit:** query-only (no lane filter) — query `cache invalidation rollback widget open items action`
- **Model reasoning (iteration):** "There's a topic cluster here. Let me pull the rest of the thread."
- **EXECUTE:** `completed` in 2ms

### Turn 5 — tool `wi_teams_search`

- **Stage:** `execute` (tool_use row)
- **Tool picked:** `wi_teams_search`
  - **Why eligible:** FTS5 search across Teams messages and meeting transcripts, ranked and grouped by chat with missing-transcript alerts. Call when the user references a Teams conversation by topic; do NOT call when the user has a Jira key (use wi_jira_analyze…
  - **Input:** ```json
{"query":"PROJ-101 widget rollout cache"}
```
  - **Recall lanes hit:** query-only (no lane filter) — query `PROJ-101 widget rollout cache`
- **EXECUTE:** `failed` in 2034ms — see result below

### Turn 6 — tool `fts_search`

- **Stage:** `execute` (tool_use row)
- **Tool picked:** `fts_search`
  - **Why eligible:** Find messages across Jira, Teams, Email, and GitHub via the WI BM25 FTS5 index. Use when you need verbatim quotes, source IDs, or evidence snippets for a keyword or phrase. Skip when the goal is semantic recall of past decisions — use brain…
  - **Input:** ```json
{"limit":20,"query":"PROJ-101 OR widget OR rollout OR postmortem","sortBy":"recency"}
```
  - **Recall lanes hit:** query-only (no lane filter) — query `PROJ-101 OR widget OR rollout OR postmortem`
- **EXECUTE:** `completed` in 0ms

### Turn 7 — tool `fts_search`

- **Stage:** `execute` (tool_use row)
- **Tool picked:** `fts_search`
  - **Why eligible:** Find messages across Jira, Teams, Email, and GitHub via the WI BM25 FTS5 index. Use when you need verbatim quotes, source IDs, or evidence snippets for a keyword or phrase. Skip when the goal is semantic recall of past decisions — use brain…
  - **Input:** ```json
{"limit":20,"query":"rollout"}
```
  - **Recall lanes hit:** query-only (no lane filter) — query `rollout`
- **EXECUTE:** `completed` in 2ms

### Turn 8 — tool `fts_search`

- **Stage:** `execute` (tool_use row)
- **Tool picked:** `fts_search`
  - **Why eligible:** Find messages across Jira, Teams, Email, and GitHub via the WI BM25 FTS5 index. Use when you need verbatim quotes, source IDs, or evidence snippets for a keyword or phrase. Skip when the goal is semantic recall of past decisions — use brain…
  - **Input:** ```json
{"limit":20,"query":"widget"}
```
  - **Recall lanes hit:** query-only (no lane filter) — query `widget`
- **EXECUTE:** `completed` in 0ms

### Turn 9 — tool `cypher_record_outcome`

- **Stage:** `execute` (tool_use row)
- **Tool picked:** `cypher_record_outcome`
  - **Why eligible:** Write a cypher_outcomes row to close the loop with a verdict. Call exactly once at the end of a dispatch — the loop terminator. Do NOT call mid-loop or speculatively; outcomes update Beta priors and double-writes corrupt the learning signal…
  - **Input:** ```json
{"note":"Summarized PROJ-101 widget rollout from 5-message cluster across teams/jira/email: rollout state, postmortem root cause, and open items (PROJ-102 flake, PROJ-103 migration, rollback window).","outcome":"success","session_id":"cyp_current"}
```
- **Recall lanes hit:** none (this call is not a recall-lane query)
- **Model reasoning (iteration):** "I have the full thread (5 messages, ids 1–5, all from the same cluster). That's enough to answer. Note: `acme/widgets` isn't a configured repo here (only `operations` is indexed), so this is message-sourced only — no code-graph available."
- **EXECUTE:** `completed` in 0ms

## Loop close

- **Verdict:** `success`
- **Outcome note (model):** "Summarized PROJ-101 widget rollout from 5-message cluster across teams/jira/email: rollout state, postmortem root cause, and open items (PROJ-102 flake, PROJ-103 migration, rollback window)."
- **Beta-prior update:** verdict signal written to `cypher_outcomes` — signal_kind=verdict, value=0.8, metadata.verdict=success.
- **skill_priors:** 0 row(s) present (keyed by skill/task_class; the loop does not write skill_priors directly — learn.ts is the sole writer, so a demo run leaves priors untouched).
