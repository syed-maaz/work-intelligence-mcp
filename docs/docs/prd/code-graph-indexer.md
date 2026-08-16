---
sidebar_position: 1
title: PRD — Code-Graph Indexer Scheduling
---

# PRD: Code-Graph Indexer Scheduling

| Field | Value |
|-------|-------|
| **Status** | 🟡 Proposed — implementation in flight on `feat/post-graphify-action-plan` |
| **Date** | 2026-05-30 |
| **Owner** | Maaz |
| **ADR** | [ADR-027 — Code-Graph Indexer Scheduling](../adr/adr-027-code-graph-indexer-scheduling) |
| **Driving ledger entry** | [`.planning/ADR-REVIEW.md` § graphify (declined 2026-05-30)](https://github.com/your-org/work-intelligence-mcp/blob/main/.planning/ADR-REVIEW.md) item 2 |

## Problem statement

The `code_graph` table has 5,740 real edges across `example-service` and `operations` (verified 2026-05-30: import 3140, test_covers 2198, config_ref 289, env_var 113), but its freshest `indexed_at` is **33–41 days old** because no background agent owns it — population happens only on manual `POST /api/code-graph/index` clicks (handler at `web-server.js:5386-5407`). As a result:

- `call-graph-tracer.ts:108-109` returns *"No code graph entries found"* (read by ReAct as gospel) whether the file is genuinely uncovered or the table is just stale.
- `blast-radius-alert.ts:43-55` collapses every SQL error to *"no impact"* — and the SQL inside that `try` references **non-existent columns** (`dependent_file`, `file`), so it has been silently failing for every file ever queried. That bug is co-fixed by this PRD.
- The manual endpoint has no idempotency guard — two clicks (or one click during the agent run we are about to add) cause duplicate `DELETE FROM code_graph WHERE repo = ?` + full rescans on the same SQLite connection.

We need a scheduled indexer that keeps the table fresh, isolates writers, and surfaces staleness as a first-class metric — without joining the SyncService serial queue that already gave us the *Teams-blocks-Outlook* incident.

## User stories

1. **Maaz running `wi_blast_radius` from Atlas / chat.** Today: gets `impactedCount: 0` whether the file truly has no callers or the table is 33 days stale or the underlying query is broken. Wants: a recent-enough graph so blast-radius matches reality, a working query, and a visible signal when staleness creeps up.
2. **Maaz running `wi_code_graph` for cross-repo navigation.** Today: same problem — empty results indistinguishable from missing data. Wants: results that reflect at most a workday of drift, with a per-repo staleness hint when worse.
3. **An agent (CorrelationAgent / MeetingPrepAgent / ReAct investigation engine) querying `code_graph` indirectly.** Today: takes the `formatTraceSummary` string at face value and reasons forward on stale data. Wants: deterministic freshness so reasoning chains don't compound staleness silently.
4. **CI smoke gate (`scripts/smoke-bridge.sh`).** Today: bridge can ship with the agent crashed and nobody notices until a real query fails. Wants: a smoke check that fails when `CodeGraphIndexer` is missing from `/api/agents/health` or when `staleness_hours > 168`.
5. **An operator clicking `POST /api/code-graph/index` from the Setup UI.** Today: clicking twice in 30 seconds (or clicking during the Sunday sweep) wedges the DB. Wants: a clean `409 { status: 'busy', startedAt }` response and a one-button retry.

## Functional requirements

- **FR-1.** Register a new agent `CodeGraphIndexer` via `registerAgent` / `markAgentReady` / `markAgentCrashed` in the post-boot block of `web-server.js`, parallel to `ResearchCachePrune` (registered at `web-server.js:6409-6418`).
- **FR-2. Two-layer scheduler.** A 60-second `setInterval` heartbeat-dispatcher (Layer A) reads two persisted `due_at` timestamps from `sync_state` (`code-graph:scheduler:incremental_due_at`, `code-graph:scheduler:full_due_at`) and dispatches at most one work-class per heartbeat. Layer B work-classes:
  - **Incremental:** runs when `now >= incremental_due_at`. Default cadence `Number(process.env.CODE_GRAPH_INTERVAL_MS) || 3_600_000` (1 h). On completion, `incremental_due_at = now + interval`.
  - **Full sweep:** runs when `now >= full_due_at`. `full_due_at` is the wall-clock target of the next Sunday 03:17 local, computed by `nextSunday0317Local(now)`. On completion, advance to the next Sunday.
  This replaces the original "4h `setInterval` + in-tick `getDay()===0 && getHours()===3` gate", which would not phase-align to wall-clock and never reliably fire the Sunday sweep.
- **FR-3.** Each incremental run reads its checkpoint from `sync_state` using sentinel rows `(topic_id='0', source IN ('code-graph:example-service', 'code-graph:operations'))`. Missing or unparseable `last_synced_at` → treat as "run a full sweep now".
- **FR-4. Incremental candidate set: mtime OR content-hash mismatch.** Walk every file under `repo.localPath` whose `mtime > last_synced_at` **or** whose stored `sha256(file)` differs from the previous indexed hash, then run a per-file extraction (`indexer.indexSingleFile(repo, relPath)`) that does `DELETE FROM code_graph WHERE repo = ? AND file_path = ?` + re-extract via `ts-morph` and updates the file hash. The hash fallback handles `rsync -a` cases where destination mtime can be set backwards relative to the prior destination state. **Replaces** the broken `git diff HEAD~1` path in `indexChangedFiles`. Uses `findTsFiles` from `src/tools/code-indexer.ts:198` (currently `private`, must be made `public` or exported — co-required change).
- **FR-5.** After each tick completes, call `updateSyncState(db, '0', 'code-graph:<repo>', new Date().toISOString(), edgesAdded)` so the next tick advances forward.
- **FR-6. Sunday full-sweep path.** Call `indexer.syncAll(repo)` for every configured repo. **`syncAll` must be extended to accept an optional repo argument** — its current signature (`src/tools/code-indexer.ts:95-97`) takes no arguments and iterates all repos; the agent needs per-repo bookkeeping so the "I ran a full sweep" timestamp lives next to its existing entry point. The full sweep is the **only** path that catches deletions.
- **FR-7. Shared busy-flag, set synchronously.** The flag (`codeGraphBusy: boolean` + `codeGraphBusyStartedAt: string|null`) is set by the manual `POST /api/code-graph/index` handler **before** `json(res, 202, ...)` writes — not inside the `.then` callback — so an agent dispatch that fires between the 202 response and the work's first SQL call cannot read `busy=false`. Released in `.finally(...)`. If busy, the manual handler returns `409 { status: 'busy', startedAt }`. The agent skips its dispatch if the flag is set, logging `[CodeGraphIndexer] skipped: busy since <iso>`.
- **FR-8. Crash isolation.** Any thrown error inside the dispatch body is caught by `withAgentTick`, which already escalates `flaky → degraded` after 3 consecutive failures. No bare try/catch leakage in the agent body.
- **FR-9.** Expose the agent in `/api/agents/health` (automatic via `withAgentTick`) and add a `codeGraph` block to `/api/system-health` containing `lastIndexedAt`, `staleness_hours`, `row_count_per_repo`, `last_full_sweep_at`, `last_full_sweep_duration_ms`, `busy_rejections_24h`.
- **FR-10. Surface staleness to consumers.** When `call-graph-tracer.ts:108-109` returns its empty-result summary AND `agentHealth.get('CodeGraphIndexer')?.lastSuccessAt` is missing, append `" (indexer has not run yet — see /api/system-health.codeGraph for status)"` to the summary.
- **FR-11. Kill-switch.** `CODE_GRAPH_INDEX_DISABLED=1` skips agent registration entirely (without crashing the bridge) so operators can disable the loop in production-emergency conditions.
- **FR-12. Co-required cleanup — REWRITE, not narrow, `blast-radius-alert.ts:43-55`.** The current SQL queries `dependent_file` and `file`; neither column exists in `code_graph` (real columns are `file_path` and `ref_file`). Rewrite the query to:
  ```ts
  SELECT DISTINCT file_path FROM code_graph
  WHERE ref_file IN (${placeholders})
    AND ref_type IN ('import','test_covers')
  LIMIT 50
  ```
  Map results from `r.file_path` (not `r.dependent_file`). **Then** narrow the catch:
  ```ts
  catch (err) { if (/no such table/.test(err.message)) return { impactedCount: 0, files: [] }; throw err; }
  ```
  Without the rewrite, narrowing alone would convert the existing silent failure into a hard `SQLITE_ERROR: no such column: dependent_file` and break every caller of `analyzeBlastRadius`. Both changes ship in the same commit.
- **FR-13. Watchdog SLA matches its name.** Because the heartbeat dispatcher fires every 60 s, the 30-minute watchdog (force-release of stuck busy-flag) actually fires within ~60 s of the 30-minute mark, not within an interval-period. This was an explicit failure mode in the prior draft.

## Non-functional requirements

- **NFR-1. Pipeline placement.** The agent lives entirely in the **Process** stage (per CLAUDE.md *Four-Stage Pipeline*). It must not call AI, must not hit external APIs, and must not be invoked from a route handler beyond the explicit `/api/code-graph/index` admin endpoint.
- **NFR-2. Steady-state latency.** Incremental tick must complete in under **60 s**, with p95 < **2_000 ms** for the steady "no changed files" case, measured with `performance.now()` and emitted as `lastDurationMs` in the agent health snapshot. The 1 h cadence yields 24 samples/day so p95 is meaningful.
- **NFR-3. Sweep latency target + honest cap.** Sunday full sweep target **5 minutes** for the current corpus. Hard cap **15 minutes**. v1 implements the cap by: detect overrun in the heartbeat dispatcher → mark `degraded`, log to `ingestion_log` with `error_message='sweep-timeout'`, **but does not abort the in-flight ts-morph parse** (ts-morph is synchronous and not externally cancellable). True abort requires the future worker-thread implementation; v1 documents this and relies on `withAgentTick` escalation when sweeps stack up.
- **NFR-4. Re-entrancy.** At most one indexer run per process — the busy-flag, set **synchronously** in the manual route, guards both the manual POST and the agent dispatcher. No SQLite writer contention.
- **NFR-5. Backward compatibility.** Existing `POST /api/code-graph/index` keeps its `202` + fire-and-forget contract on idle. Only new behavior is the `409` when busy.
- **NFR-6. Memory / WAL.** Incremental path uses per-file `DELETE FROM code_graph WHERE repo=? AND file_path=?` + `insertEdge` prepared statement — no full-table DELETEs on the 1 h tick.
- **NFR-7. Observability.** Emit a single stderr line per work-run: `[CodeGraphIndexer] tick: example-service=+12 operations=+0 (842 ms)` for incremental, `[CodeGraphIndexer] sweep: example-service=full operations=full (123456 ms)` for the Sunday sweep.
- **NFR-8. Smoke coverage.** `scripts/smoke-bridge.sh` adds a check that `/api/agents/health` lists `CodeGraphIndexer` with status `ready` or `healthy`, and that `/api/system-health.codeGraph.staleness_hours < 168` (1 week).
- **NFR-9. Independence from sync queue.** The agent runs on its own dispatcher. It does **not** join the SyncService serial queue that owns Teams/Outlook/Jira browser slots — re-introducing that single-mutex would re-create the *Teams-blocks-Outlook* starvation under a new mask.

## Out of scope

- **Indexing `web-intelligence-mcp` itself** as a third target. Deferred. `repos/` today is `example-service` + `operations` only.
- **Tree-sitter / multi-language extractors.** See [ADR-028](../adr/adr-028-defer-tree-sitter); fix the under-emitting ts-morph extractor first.
- **Push-based file watching (chokidar / `fs.watch`).** Considered and rejected — see ADR-027 *Alternatives*.
- **Worker-thread sweep with abortable hard-cap.** Listed as a future extension in ADR-027.
- **A `code_graph_runs` history table.** Existing `ingestion_log` rows tagged `code-graph-<repo>-incremental` vs `-sweep` cover the immediate observability need.
- **`wi_code_graph` manifest changes** (`staleness_warning` field). Listed as a future extension in ADR-027; requires a manifest version bump.
- **Lazy mode** (only run when `wi_code_graph` was queried recently). Defer until metrics show the cost is non-trivial.
- **UI dashboard** for `codeGraph` block beyond `/api/system-health`. Smoke + JSON endpoint are sufficient for v1.

## Acceptance criteria

- **AC-1.** Bridge boot logs include `CodeGraphIndexer` in `[Agents] Boot complete: N agents — { ready: ..., crashed: ... }`. Smoke check (`scripts/smoke-bridge.sh` check #2) sees the agent in `/api/agents/health` with status `ready` or `healthy`.
- **AC-2.** With `CODE_GRAPH_INDEX_DISABLED=1` set, the agent is **not** registered and the bridge boots cleanly; `/api/agents/health` shows the existing 8 agents only.
- **AC-3.** First incremental run on a fresh DB (no `sync_state` rows for `code-graph:example-service`) runs `indexer.syncAll('example-service')` (using the new repo-arg overload), populates the table, and writes the sentinel sync_state rows.
- **AC-4.** Subsequent heartbeats with no file changes walk both repos, find zero `mtime > last_synced_at` AND zero hash-mismatch files, emit `[CodeGraphIndexer] tick: example-service=+0 operations=+0 (Xms)`, and update `last_synced_at` to a fresher value. Tick duration `< 60_000 ms`; p95 over 24 h `< 2_000 ms` (24 samples/day at the 1 h cadence).
- **AC-5.** When a file under `repos/example-service/src/auth/login.ts` is `touch`-ed, the next incremental run re-extracts only that file (`DELETE FROM code_graph WHERE repo='example-service' AND file_path='src/auth/login.ts'` + re-insert), and emits `[CodeGraphIndexer] tick: example-service=+N operations=+0 (Xms)`.
- **AC-6.** On any Sunday at 03:17 local (within ±60 s of the heartbeat granularity), the dispatcher detects `now >= full_due_at` and runs the full sweep for every configured repo. After completion `full_due_at` is advanced to the next Sunday 03:17 local. Subsequent heartbeats the same Sunday skip the sweep branch (idempotent via the persisted timestamp). **The schedule is reachable** because the dispatcher checks a wall-clock target, not an in-tick `getHours()` gate against a free-running setInterval.
- **AC-7.** While the agent is running a full sweep, `POST /api/code-graph/index` returns `HTTP 409 { status: 'busy', startedAt: <iso> }` instead of `202`. While the agent is idle, the manual POST still returns `202` (backward compat).
- **AC-8.** While a manual POST is in-flight (flag set synchronously **before** the 202 response), the agent's next heartbeat logs `[CodeGraphIndexer] skipped: busy since <iso>` and does **not** dispatch — verified by a regression test that fires a manual POST and an agent dispatch within 1 ms of each other.
- **AC-9.** A thrown error inside the dispatch body releases the busy-flag (try/finally), increments `withAgentTick`'s failure counter, and after 3 consecutive failures the agent flips to `degraded` in `/api/agents/health.agents[].status`.
- **AC-10.** A stale busy-flag (`codeGraphBusyStartedAt` older than 30 min) is force-released by the heartbeat dispatcher within ~60 s of the 30-minute mark with stderr `[CodeGraphIndexer] busy-flag stuck — force release`.
- **AC-11.** `/api/system-health` includes a `codeGraph` block with at least `lastIndexedAt`, `staleness_hours`, `row_count_per_repo`, `last_full_sweep_at`, `last_full_sweep_duration_ms`, `busy_rejections_24h`. Smoke check asserts `staleness_hours < 168`.
- **AC-12.** When the agent has never run successfully, `call-graph-tracer.ts:108-109` empty-result summaries include the suffix `" (indexer has not run yet — see /api/system-health.codeGraph for status)"`.
- **AC-13. `blast-radius-alert.ts` returns real impacted-file lists.** The query targets `file_path` / `ref_file` (not `dependent_file` / `file`). A regression test seeds `code_graph` with one row `(repo='example-service', file_path='a.ts', ref_file='b.ts', ref_type='import')` and asserts that `checkBlastRadius(['b.ts'], db)` returns `{ impactedCount: 1, files: ['a.ts'] }` — not the previous silent `{ impactedCount: 0, files: [] }`. Catch only swallows errors whose message matches `/no such table/`; any other SQL error is re-thrown.
- **AC-14.** `npm run build && npm run typecheck` are clean. `npm run smoke:bridge` passes including the new check.
- **AC-15. Mtime-thrash safeguard.** When `changedFiles.length > 1000` in an incremental run (mtime-thrash from `rsync --no-times` or destination-mtime-goes-backwards), the agent falls back to `indexer.syncAll(repo)` (per-repo full rescan) and emits a stderr warning naming the count.
- **AC-16. rsync-mtime-backwards case.** When a file's content has changed (sha256 mismatch) but its destination mtime is older than `last_synced_at` (rsync set it backwards), the file is still re-extracted because the candidate set is `mtime > checkpoint OR hash_mismatch`. Verified by a regression test that overwrites a file and `touch -t 200001011200`-es it.

## Rollout plan

### Phase 1 — Land code, default-off

1. Implement: `findTsFiles` access modifier change, `syncAll(repo?)` overload, `indexer.indexSingleFile()`, content-hash sidecar, the agent registration block, the synchronous busy-flag, the `blast-radius-alert.ts` query rewrite, and the `/api/system-health.codeGraph` field.
2. Ship with `CODE_GRAPH_INDEX_DISABLED=1` set in `.env.example` so default-off until smoke is green.
3. Update `CLAUDE.md` *Environment* block with `CODE_GRAPH_INTERVAL_MS` and `CODE_GRAPH_INDEX_DISABLED`.

### Phase 2 — Enable on dev bridge, watch metrics

1. Unset `CODE_GRAPH_INDEX_DISABLED` on Maaz's local bridge.
2. Watch `lastDurationMs`, `staleness_hours`, `busy_rejections_24h`, agent `failures` over the first 7 days.
3. Confirm Sunday sweep runs at 03:17 (the load-bearing fix vs the prior draft) and finishes under the 5-min target (or the 15-min hard cap).
4. Confirm zero `database is locked` errors in `logs/`.
5. Confirm `wi_blast_radius` returns non-empty results for files that are imported elsewhere — the column-bug regression test was the trigger; this is the wild-data smoke.

### Phase 3 — Smoke gate flips to required

1. Promote the new `scripts/smoke-bridge.sh` check from informational to required.
2. Document the operational runbook (busy-flag stuck, agent crashed, staleness > 168 h) inline in this PRD.
3. Close `.planning/ADR-REVIEW.md` § graphify item 2.

### Feature flags / kill switches

- **`CODE_GRAPH_INTERVAL_MS`** — override incremental cadence (default 3_600_000 = 1 h). Set to 60_000 for local debugging; do not commit.
- **`CODE_GRAPH_INDEX_DISABLED=1`** — skip agent registration entirely. Bridge still boots; manual POST still works. Rollback knob.

### Rollback procedure

If the agent misbehaves in production:

1. Set `CODE_GRAPH_INDEX_DISABLED=1` in `.env`.
2. `lsof -ti :3132 | xargs kill -9; sleep 1; npm run web:bridge &` to restart cleanly.
3. Confirm `/api/agents/health` no longer lists `CodeGraphIndexer`.
4. The manual `POST /api/code-graph/index` endpoint continues to work — operators fall back to manual reindex.
5. File a bug under `.planning/ADR-REVIEW.md` referencing this PRD's AC that broke.

If the busy-flag wedges (manual POSTs return 409 indefinitely):

1. Restart the bridge (`lsof -ti :3132 | xargs kill -9; npm run web:bridge &`). The flag is module-scope, so it is reset on boot.
2. The 30-min watchdog (FR-13 / AC-10) makes this self-healing on the next heartbeat — confirm in stderr.

## Metrics & success criteria

| Metric | Source | Target |
|---|---|---|
| `code_graph` row count per `(repo, ref_type)` | `/api/system-health.codeGraph.rows` | non-zero per configured repo within 1 h of bridge boot |
| `last_synced_at` age in hours per repo | `/api/system-health.codeGraph.staleness_hours` | < 8 h on a workday; < 168 h enforced by smoke |
| Incremental `lastDurationMs` p95 (24 samples/day) | agent health snapshot | < 2_000 ms (steady state) |
| Full-sweep duration p95 | `last_full_sweep_duration_ms` | < 300_000 ms (5 min); hard cap 900_000 ms |
| `edgesAdded` per tick | `ingestion_log` row, `source='code-graph-<repo>-incremental'` | non-zero on at least one weekday tick per active repo |
| Agent crash count | `/api/agents/health.agents[].failures` for `CodeGraphIndexer` | `< 3` (3 trips `degraded`) |
| Busy-flag rejections | `/api/system-health.codeGraph.busy_rejections_24h` | spikes acceptable; sustained > 5/day suggests we need a "cancel + retry" UX |
| Files-walked count per incremental tick | stderr line | stable; sudden jump to ~8000 indicates rsync `--no-times` regression (FR-4 hash fallback fires) |
| `wi_blast_radius` non-empty rate | runtime telemetry | > 0% — the column-bug fix means this metric should leave 0 on day one |

The work is a success when: smoke is green, `staleness_hours` stays < 24 h on workdays for 14 consecutive days, no `database is locked` errors in logs, and `wi_blast_radius` / `wi_code_graph` queries from chat return non-empty results matching live filesystem state.

## Open questions

1. **Should the agent also index `web-intelligence-mcp` itself as a third repo?** Today not in `repos/`, but `web/src/**` and `src/**` would benefit from blast-radius too. → Defer to a follow-up phase to keep this PRD's scope tight.
2. **Should `wi_code_graph` (`src/tools/manifest.ts`) gain a `staleness_warning` field?** Cleaner than the in-summary hint but requires a manifest version bump. → Decide after first week of metrics.
3. **Is 1 h the right interval, or should it default to 30 min / 4 h?** 1 h was picked because (a) p95 over 24 h needs more than 6 samples to be meaningful, (b) the user-visible drift on workdays should be sub-half-day. → Pick after first week of `lastDurationMs` data.
4. **Should we cap the agent at running only when `wi_code_graph` has been called in the last 24 h (lazy mode)?** Adds complexity but reduces background noise. → Defer.
5. **How do we handle a third repo joining mid-week?** The first heartbeat after `ConfigManager.getRepos()` returns a new entry will see no `sync_state` row → run a full `indexRepo` (correct behaviour). → Confirm this matches expectations; documented in ADR-027.
6. **Sunday 03:17 in user-local time vs UTC?** Local matches the morning-brief cron convention; UTC is more reproducible. → Recommend local (matches morning brief), document in ADR.
7. **Naming collision check.** Is `CodeGraphIndexer` clear of `ChangeWatcher` (around `web-server.js:6249`)? → Confirmed: `ChangeWatcher` watches messages/topics, not code; names are unrelated.
8. **Content-hash sidecar storage.** New `code_graph_file_hash` table or piggyback on `sync_state` with sentinel topic_id? → Implementation detail, decide with the schema-touch commit.
9. **Should AC-13's regression test be in vitest or as part of `smoke-bridge.sh`?** vitest catches it earlier; smoke catches it on integration. → Both, smoke is the gate.

## References

- ADR: [ADR-027 — Code-Graph Indexer Scheduling](../adr/adr-027-code-graph-indexer-scheduling)
- Driving ledger entry: [`.planning/ADR-REVIEW.md` § graphify (declined 2026-05-30)](https://github.com/your-org/work-intelligence-mcp/blob/main/.planning/ADR-REVIEW.md) item 2 — *"Code-graph indexer never scheduled."*
- Pipeline-stage rule: CLAUDE.md *Four-Stage Pipeline (Architectural Constraint)*
- Agent pattern reference: `web-server.js:1864-1914` (`registerAgent` / `withAgentTick`); `web-server.js:6409-6418` (`ResearchCachePrune` — closest behavioral twin).
- Existing entry points: `web-server.js:5386-5407` (manual `POST /api/code-graph/index`); `src/tools/code-indexer.ts:37-97` (`indexRepo`, `syncAll`).
- Pain-evidence consumers receiving fixes: `src/intelligence/tools/call-graph-tracer.ts:108-109`, `src/tools/blast-radius-alert.ts:43-55` (column-name bug fixed in same commit).
- Smoke contract: `.claude/rules/smoke-tests.md`; new check lands in `scripts/smoke-bridge.sh`.
- Implementation worktree: `/tmp/wi-post-graphify` on branch `feat/post-graphify-action-plan`.

---

## v2 Implementation Status — 2026-05-30

All 5 items from ADR-027 § *Status Update* shipped on branch `feat/adr-027-v2`:

| Commit | AC closed | Notes |
|---|---|---|
| `aa5ae2a` | AC blast-radius non-zero | Phantom-column fix; smoke § 10b |
| `ee7b070` | AC scheduler / AC sync_state on full sweep | 60s heartbeat + UTC due_at; `indexRepo` writes checkpoint |
| `7d1ce1f` | AC concurrent POST | `(202, 409)` deterministic via `tryAcquireCodeGraphLock` |
| `65a0647` | AC observability | `/api/system-health.codeGraph` + smoke § 10d staleness gate |
| `c10c001` | AC kill-switch | `CODE_GRAPH_INDEX_DISABLED=1` |

Smoke harness now has 3 new code-graph sub-checks (10b, 10c, 10d) on top of the existing § 10. Bridge live-verification gated by Task 15 (merge + restart).

