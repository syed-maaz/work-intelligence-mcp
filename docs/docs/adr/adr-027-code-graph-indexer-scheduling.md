---
sidebar_position: 27
title: ADR-027 Code-Graph Indexer Scheduling
---

# ADR-027: Code-Graph Indexer Scheduling

| Field | Value |
|-------|-------|
| **Status** | ✅ **v2 fully complete** — load-bearing items shipped 2026-05-30 (commits `aa5ae2a`, `ee7b070`, `7d1ce1f`, `65a0647`, `c10c001`) + Path A honesty (`1e98af0`) + Path B follow-ups (`b489376`, `70ed8a9`, `8fbd07d`, `1a6eeb2`) + closeout (`dc39b5c`) shipped 2026-05-31 on branch `feat/adr-027-v2-finish`. Supersedes v1 (`e1d6f9e`). All five v2 acceptance criteria are now construct-deterministic and smoke-gated — see § *Path B closeout — 2026-05-31*. |
| **Date** | 2026-05-30 |
| **Deciders** | Maaz |
| **Drives** | `.planning/ADR-REVIEW.md` § *graphify (declined 2026-05-30)* — action item 2 ("Code-graph indexer never scheduled") |
| **Pipeline stage** | Process (per CLAUDE.md *Four-Stage Pipeline*) |
| **Related** | [ADR-017 — Always-On Agent Architecture](./adr-017-always-on-agent-architecture), [ADR-024 — Unified Brain API](./adr-024-unified-brain), [ADR-026 — Route Module Extraction](./adr-026-route-module-extraction) |
| **Companion PRD** | [`docs/prd/code-graph-indexer.md`](../prd/code-graph-indexer) |

## Context

The `code_graph` table (introduced at schema v24, current `CURRENT_SCHEMA_VERSION = 48` per `src/db/schema.ts:8`) is populated **only** by manual `POST /api/code-graph/index` calls handled in `web-server.js:5386-5407`. No background agent owns it. The live SQLite shows real data — verified 2026-05-30:

```
import      | 3140
test_covers | 2198
config_ref  |  289
env_var     |  113
```

Total: **5,740 rows**. Every row is import-shaped — zero rows for `call`, `type`, `api_call` even though the schema CHECK enum admits them. Most-recent `MAX(indexed_at)` per repo is **33–41 days old** on 2026-05-30. `sync_state` carries zero rows for code-graph; there is no checkpoint anywhere. The indexer has no concept of *"when did I last run"*.

Two downstream consumers already silently degrade:

- `src/intelligence/tools/call-graph-tracer.ts:108-109` returns the user-facing string `"No code graph entries found for this file. code_graph may not be indexed for this repo."` whenever the table is empty for the queried file. ReAct observation downstream takes this at face value — a stale graph is indistinguishable from an unindexed one.
- `src/tools/blast-radius-alert.ts:43-55` swallows every SQL error to `{ impactedCount: 0, files: [] }`. **Critical sub-finding:** the SQL inside that `try` references `dependent_file` and `file` — neither column exists in `code_graph` (real columns are `file_path` and `ref_file`). The catch is hiding a hard schema mismatch, not just a missing-table case. See ADR's "Co-required cleanup" below.

The existing agent pattern in `web-server.js:1864-1914` (`registerAgent` / `markAgentReady` / `withAgentTick`, with auto `flaky → degraded` escalation at 3 consecutive failures) is well-established — 8 agents already wired, including `ResearchCachePrune` at `web-server.js:6409-6418` as the closest behavioral twin. The bridge boot summary `[Agents] Boot complete: N agents — { ready: ..., crashed: ... }` is asserted by `scripts/smoke-bridge.sh` check #2, so any new agent is automatically observable.

Three operational hazards have already been paid for by other subsystems and we want to inherit those scars, not re-earn them:

1. **Serial-queue starvation.** `src/services/sync.ts:74` carries the comment *"Email before Teams — Teams holds the browser slot longest; Outlook must not starve."* This is the *Teams-blocks-Outlook* incident frozen as a code comment. A code-graph agent that joined that serial queue would re-introduce the same starvation shape on a different mutex.
2. **Concurrent-writer footgun.** `src/tools/code-indexer.ts:144` opens `indexRepo` with `DELETE FROM code_graph WHERE repo = ?`. The current `/api/code-graph/index` handler is fire-and-forget (`json(res, 202, ...)` then `.then/.catch`) with **no idempotency guard** — two operators clicking the button (or an agent firing while a manual call is in flight) run two simultaneous `DELETE` + full rescans on the same SQLite connection.
3. **rsync deletes mtime as a signal.** Per CLAUDE.md the live workspace is rsynced. `rsync -a` *preserves* source-mtime onto destination, which can also move destination mtime **backwards** when a file's source-mtime is older than the prior destination state — so a naïve `mtime > checkpoint` walk can miss content-refreshed files. We address this with a content-hash fallback (see Decision §FR-4 amendment).

Finally: `src/tools/code-indexer.ts:57-68` runs `git diff --name-only HEAD~1` inside `repo.localPath` to drive `indexChangedFiles`. Per CLAUDE.md the live workspace is rsynced with `--exclude='.git'`, so the command throws and the function falls through to the full-rescan branch on every call — defeating the very optimisation it claims.

The post-graphify ledger entry in `.planning/ADR-REVIEW.md` § *graphify (declined 2026-05-30)* names this as the second of four real WI gaps the spike surfaced. This ADR is the design contract for that fix.

## Decision

Add a **`CodeGraphIndexer` agent** to `web-server.js` that ticks every **60 minutes** (smaller than the 4 h originally drafted — see "Cadence" below), driven by a wall-clock-aligned scheduler so the **Sunday 03:17 local full sweep** actually fires. Re-entrancy is enforced by a process-level **busy-flag** set **synchronously** in the manual POST handler before the `202` write, shared with the agent tick. The agent runs on its own scheduler — it does **not** join the SyncService serial queue.

The work lives entirely in the **Process** stage of the four-stage pipeline (Fetch already happened — rsync delivered the files). The agent never calls Anthropic, never opens a Playwright session, never hits Jira/GitHub. It only reads the local filesystem and writes to SQLite.

### Cadence

We had drafted a 4-hour `setInterval`. Critique surfaced two killer flaws:

1. **`setInterval` does not align to wall-clock.** A 4 h interval starting at any non-03:00 boot lands on times like 02:17 / 06:17 / 10:17 — the Sunday 03:17 in-tick gate `now.getHours() === 3` would rarely (and on most boots, never) be true. **The headline schedule simply would not fire.**
2. **p95 over 24 h is degenerate** when only ~6 ticks fit. It's just the worst sample.

Both are fixed by switching to a **two-layer scheduler**:

- **Layer A — heartbeat.** A 60-second `setInterval` runs a tiny dispatcher. The dispatcher reads two persisted timestamps from `sync_state` (`code-graph:scheduler:incremental_due_at`, `code-graph:scheduler:full_due_at`) and decides which (if any) work to run.
- **Layer B — work classes.**
  - **Incremental:** runs when `now >= incremental_due_at`. Default cadence `Number(process.env.CODE_GRAPH_INTERVAL_MS) || 3_600_000` (1 h). On completion, advance `incremental_due_at = now + interval`.
  - **Full sweep:** runs when `now >= full_due_at`. `full_due_at` is a real wall-clock target — next Sunday 03:17 local — computed via a tiny helper `nextSunday0317Local(now)`. On completion, advance to the next Sunday.

This is what `node-cron` would give us; we don't take the dependency because the helper is ten lines. The dispatcher itself is gated by the busy-flag and only dispatches one work-class at a time.

p95 of `lastDurationMs` is now meaningful (24 samples/day at the 1 h cadence on idle, more on changes).

### Incremental strategy: mtime-driven diff with content-hash fallback

Each incremental run reads its checkpoint from `sync_state` using sentinel rows `(topic_id='0', source IN ('code-graph:example-service', 'code-graph:operations'))`, parses `last_synced_at`, walks `repo.localPath` using a public `findTsFiles` helper exported from `src/tools/code-indexer.ts` (the helper is currently `private` at line 198 — this access-modifier change is part of REFACTOR-002 and listed in Implementation Status). It collects every file whose `statSync(path).mtime > last_synced_at` **OR** whose stored `sha256(file)` differs from the previous indexed hash. The hash fallback closes the rsync-mtime-goes-backwards case.

For each candidate file the agent runs a new `indexer.indexSingleFile(repo, relPath)` method that performs the per-file body of `indexChangedFiles` — `DELETE FROM code_graph WHERE repo = ? AND file_path = ?`, add the source file to a fresh `ts-morph` Project, push edges through the existing `insertEdge` prepared statement, then update the file's hash in a small new `code_graph_file_hash` table (or as a sibling key in `sync_state` if we want to avoid a schema change — TBD in Implementation).

After all changed files are processed (or if there are zero), the agent calls `updateSyncState(db, '0', 'code-graph:<repo>', new Date().toISOString(), edgesAdded)` so the next tick advances forward.

This **replaces** the broken `git diff HEAD~1` path in `indexChangedFiles` with a filesystem-native check that works for any source provenance (rsync, git checkout, manual paste) without coupling to a specific one. `indexChangedFiles` itself is kept for backward compatibility but is no longer the agent's path.

### Sunday full sweep — and the missing `syncAll(repo)` signature

`CodeIndexer.syncAll()` takes **zero arguments** today (`src/tools/code-indexer.ts:95-97`) and iterates every configured repo. The agent's per-repo full-sweep needs a per-repo signature. Two options:

- **Option α (chosen):** add `syncAll(repoName?: string)` overload — `repoName` undefined keeps existing behavior; passing a name calls `indexRepo(repoName)`.
- **Option β (rejected):** call `indexRepo(repoName)` directly from the agent. Works today, but `indexRepo` does not record the per-repo "I ran a full sweep" timestamp the agent needs; tying that bookkeeping into `syncAll` keeps it co-located with the existing full-sweep entry point.

The full sweep calls `indexer.syncAll(repo)` for every configured repo, then writes a fresh `last_synced_at`. This is the **only path that catches deletions** — a file removed in the source rsync target leaves no mtime to compare against, so the incremental pass cannot detect it. We name this trade-off explicitly: deletions trail by at most 7 days, which is acceptable for hint-grade blast-radius.

### Re-entrancy: shared busy-flag, set **synchronously**

Declare at module scope in `web-server.js`, adjacent to the existing `agentHealth` Map (around line 1855):

```js
let codeGraphBusy = false;
let codeGraphBusyStartedAt = null;
```

The manual `POST /api/code-graph/index` handler at `web-server.js:5386-5407` is amended so the flag is set **before** the `json(res, 202, ...)` write. Otherwise an agent dispatch that fires between the 202 response and the `.then` callback's first SQL call reads `busy=false` and starts a parallel `DELETE` + rescan — the exact race the busy-flag is supposed to prevent.

```js
// before json(res, 202, ...)
if (codeGraphBusy) {
  json(res, 409, { status: 'busy', startedAt: codeGraphBusyStartedAt });
  return;
}
codeGraphBusy = true;
codeGraphBusyStartedAt = new Date().toISOString();
json(res, 202, { status: 'indexing', repo });
// then run in background, releasing in finally
(repo === 'all' ? indexer.syncAll() : indexer.indexRepo(repo))
  .then(...)
  .catch(err => persistError('code-graph-index', err.message, { repo }))
  .finally(() => { codeGraphBusy = false; codeGraphBusyStartedAt = null; });
```

The agent dispatcher does the same check-and-set inside `try { ... } finally { codeGraphBusy = false }` so any thrown error still releases it.

**Watchdog:** the 60-second dispatcher also runs the watchdog. If `codeGraphBusyStartedAt` is older than 30 minutes on any heartbeat, it logs `[CodeGraphIndexer] busy-flag stuck — force release` and resets to `false`. The 30-minute SLA holds because the dispatcher fires every minute, not every interval — the 4h watchdog asymmetry from the original draft is gone.

### Hard cap on the Sunday sweep — honestly

Original draft promised a 15-minute hard cap that "aborts the ts-morph Project". `ts-morph` parsing is synchronous and not cancellable from outside the call. We don't pretend otherwise. The hard cap is implemented as:

- A `worker_threads` worker that does the sweep; the parent posts a `terminate()` after 15 minutes.
- On terminate: the agent marks itself `degraded`, writes a row to `ingestion_log` with `error_message='sweep-timeout'`, releases the busy-flag, and the next Sunday's full-due-at advances normally so we don't ban sweeps forever.

If introducing a worker is too heavy for v1, the alternative is to **drop the hard cap** and rely on `withAgentTick`'s `flaky → degraded` escalation when sweeps stack up. That is the documented v1 fallback; the worker version is listed in "Future extensions".

### Crash isolation and observability

- The dispatcher body runs inside `withAgentTick('CodeGraphIndexer', ...)`, which already gives us the `flaky → degraded` escalation, the `lastTickAt` / `lastSuccessAt` health fields, and a stderr line per tick error.
- The agent registration block is wrapped in `try { setInterval(...); markAgentReady(...) } catch (err) { markAgentCrashed('CodeGraphIndexer', err) }` so an init failure shows up as `crashed` rather than blocking bridge boot.
- Each work-run emits **one** stderr line: `[CodeGraphIndexer] tick: example-service=+12 operations=+0 (842 ms)` for incremental, `[CodeGraphIndexer] sweep: example-service=full operations=full (123456 ms)` for the Sunday sweep.
- A new `codeGraph` block is added to `/api/system-health` exposing `lastIndexedAt`, `staleness_hours`, `row_count_per_repo`, `last_full_sweep_at`, `last_full_sweep_duration_ms`, and `busy_rejections_24h`.

### Consumer hint surfacing & co-required cleanup

`src/intelligence/tools/call-graph-tracer.ts:108-109` is amended: when the empty-result branch fires AND `agentHealth.get('CodeGraphIndexer')?.lastSuccessAt` is missing, the summary becomes `"… (indexer has not run yet — see /api/system-health.codeGraph for status)"`. Users see *why* the data is empty instead of the misleading "may not be indexed for this repo".

`src/tools/blast-radius-alert.ts:43-55` is **rewritten**, not just narrowed. The current code does:

```ts
db.prepare(
  `SELECT DISTINCT dependent_file FROM code_graph WHERE file IN (${placeholders}) LIMIT 50`,
).all(...filePaths) as { dependent_file: string }[];
```

`code_graph` has no `dependent_file` column and no `file` column. The columns are `file_path` (the importer) and `ref_file` (the imported). The corrected query — to find files that depend on a given set — is:

```ts
db.prepare(
  `SELECT DISTINCT file_path FROM code_graph
   WHERE ref_file IN (${placeholders})
     AND ref_type IN ('import','test_covers')
   LIMIT 50`
).all(...filePaths) as { file_path: string }[];
return { impactedCount: rows.length, files: rows.map(r => relative(cwd, r.file_path)) };
```

**Then** the catch is narrowed: `catch (err) { if (/no such table/.test(err.message)) return { impactedCount: 0, files: [] }; throw err; }`. Without this rewrite, narrowing the catch alone would convert a silent miss into a hard `SQLITE_ERROR: no such column: dependent_file` and break every caller of `analyzeBlastRadius`. The two changes ship in the same commit.

## Why these choices

### Why not naive interval cron (full reindex every N hours)

Trivial to write, but a `~6,000-row DELETE+INSERT` every interval hammers WAL and FTS triggers, wastes ~5 min of CPU per tick on a steady-state repo, and holds the SQLite write lock during the rescan — blocking `wi_code_graph` reads. Same single-mutex shape that caused the Teams-blocks-Outlook starvation.

### Why not `fs.watch` / chokidar (push-based)

rsync rewrites every file mtime on every refresh, generating a thundering herd of FS events (~8,000 files per repo). Cross-platform behaviour (Linux inotify limits, FSEvents on case-insensitive HFS) is fragile. Adds a runtime dependency. Doesn't help on cold start — process death loses the watch state, so we'd need a sync on agent (re)start anyway. Additive at best, not a replacement.

### Why not post-rsync / post-commit hook (push from source)

The repos at `./repos/` are populated by `rsync` (per CLAUDE.md), not git checkouts — there is no commit event. Requires editing the user's local rsync command and/or installing a hook in a sister repository the agent doesn't control. Easy to forget on a new machine; silent staleness when missing. Conflicts with the project's stated "self-contained" design.

### Why not a single `setInterval` with in-tick day/hour gate

Drafted, then killed: a coarse `setInterval` does not phase-align to wall-clock, so the Sunday 03:17 sweep would rarely (and on most boots, never) fire. The two-layer dispatcher (60 s heartbeat, persistent `due_at` timestamps) gives us cron-shaped semantics for ten lines of code without a new dependency.

## Consequences

### Positive

- **Staleness becomes a first-class metric.** `sync_state.last_synced_at` for `code-graph:<repo>` gives `/api/system-health.codeGraph.staleness_hours` a real value; smoke check asserts it stays < 168 h (1 week).
- **Incremental tick is O(changed-files), not O(repo).** Steady-state cost is a filesystem walk + zero edges to upsert, projected p95 < 2 s for current corpus (24 samples/day at 1 h cadence makes p95 meaningful).
- **mtime + content-hash fallback works for both rsync targets and any future git checkout.** Survives `rsync -a --no-times` and the destination-mtime-goes-backwards case.
- **Re-uses existing `withAgentTick` machinery.** No new agent framework; reviewers have a precedent (`ResearchCachePrune`) to compare against.
- **Sunday sweep actually fires** because the dispatcher uses a persisted wall-clock `due_at`, not an in-tick day/hour gate against a setInterval that never lands on 03:00.
- **Busy-flag prevents the documented two-runs-at-once footgun** for both agent-vs-manual and manual-vs-manual races, with the flag set **synchronously** before `res.write` so there's no 202-vs-`.then` race window.
- **`blast-radius-alert.ts` query is finally correct.** The phantom-column bug that has been silently returning `impactedCount: 0` for every call is fixed in the same commit as the catch narrowing.
- **Pipeline-clean.** Pure Process stage; satisfies REFACTOR-002 instead of compounding it.
- **Backward compatible.** Existing `POST /api/code-graph/index` keeps its `202` + fire-and-forget contract on idle. Only new behavior is the `409` when busy.

### Negative

- **Deletions trail by up to 7 days.** Files removed in source aren't garbage-collected until Sunday's full sweep. Acceptable for a hint-grade signal; documented.
- **Two indexer code paths during the migration window** (`indexChangedFiles` legacy + `indexSingleFile` new). Once consumers stop calling `indexChangedFiles` directly we can delete the broken `git diff` branch. Not blocking for v1.
- **Bridge boot adds one more agent** that can crash and surface as `degraded` — operators have one more health field to track.
- **Sweep hard-cap is documented honestly.** v1 ships without an in-flight abort mechanism (relies on `withAgentTick` escalation when sweeps stack up). Worker-thread version listed in "Future extensions".

### Neutral

- **Small schema touch.** A new `code_graph_file_hash` table (or `sync_state` sibling rows) for the content-hash fallback. Not a CHECK-widening migration; uses `CREATE TABLE IF NOT EXISTS`.

## Alternatives Considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Naive 4 h `setInterval` with in-tick `getDay()===0 && getHours()===3` gate** | Trivially small. | `setInterval` does not phase-align to wall-clock; Sunday gate rarely (or never) fires. p95 over 24 h is degenerate at 6 samples. | **Rejected** — headline schedule does not fire. |
| **Naive interval cron — full reindex every N hours** | Catches deletions/renames automatically. No mtime/git assumptions. | ~6,000-row DELETE+INSERT every N h hammers WAL and FTS triggers. ~5 min CPU per tick. SQLite write lock blocks `wi_code_graph` reads. Same single-mutex shape as Teams-blocks-Outlook. | **Rejected** — write amplification + read-blocking. |
| **`fs.watch` / chokidar** | Lowest possible staleness. | rsync mtime rewrites cause thundering herds. Cross-platform fragility. New native dep. Process death loses watch state. | **Rejected** — additive complexity for marginal latency win. |
| **Post-commit / post-rsync hook** | Zero polling. | repos populated by rsync, not git → no commit event. Requires editing user's rsync command. Silent staleness when missing. | **Rejected** — fragile cross-repo coupling. |
| **`node-cron` dependency** | Idiomatic cron expressions. | One more npm dep for a problem solved in ten lines. | **Rejected** — unwarranted dep. |
| **60 s heartbeat + persisted `due_at` + mtime+hash incremental + Sunday full sweep + sync-set busy-flag** | Wall-clock-aligned, so Sunday 03:17 actually fires. Incremental tick O(changed). 30-min watchdog has SLA matching its name (heartbeat is 60 s). Busy-flag has no 202-vs-`.then` race. `blast-radius-alert` query bug fixed in same commit. | Slightly more code. Hash sibling table or `sync_state` extension. Sweep hard-cap is documented as v1 fallback. | **Chosen** ✅ |

## Implementation Status

Implementation is in flight on branch `feat/post-graphify-action-plan` in worktree `/tmp/wi-post-graphify` (parallel to the rrfFuse semantic-search rollout shipped as `fb0d70e`). Status as of 2026-05-30:

| Component | File | Status |
|---|---|---|
| Action-plan ledger entry | `.planning/ADR-REVIEW.md` § *graphify (declined 2026-05-30)* item 2 | ✅ shipped 2026-05-30 (`fc372e2`) |
| Companion PRD | `docs/docs/prd/code-graph-indexer.md` | 🟡 this commit |
| `findTsFiles` access modifier `private → public` (or `export`) | `src/tools/code-indexer.ts:198` | 🔲 pending |
| `CodeIndexer.syncAll(repoName?: string)` overload | `src/tools/code-indexer.ts:95-97` | 🔲 pending |
| `CodeIndexer.indexSingleFile(repo, relPath)` | `src/tools/code-indexer.ts` | 🔲 pending — extract per-file body from `indexChangedFiles` lines 77-83 |
| Content-hash sidecar (table or `sync_state` rows) | `src/db/schema.ts` (additive `CREATE TABLE IF NOT EXISTS`) | 🔲 pending |
| `CodeGraphIndexer` agent registration (60 s heartbeat dispatcher + `nextSunday0317Local`) | `web-server.js` (insert after `ResearchCachePrune` at ~line 6418) | 🔲 pending |
| Module-scope `codeGraphBusy` / `codeGraphBusyStartedAt` | `web-server.js` (~ line 1855) | 🔲 pending |
| Manual POST: synchronous busy-set BEFORE `res.write`, 409-when-busy, `.finally(release)` | `web-server.js:5386-5407` | 🔲 pending |
| `sync_state` sentinel rows for `code-graph:<repo>` and `code-graph:scheduler:*_due_at` | runtime (no migration) | 🔲 written by first tick |
| `/api/system-health.codeGraph` block | `web-server.js` system-health handler | 🔲 pending |
| Consumer hint in `call-graph-tracer.ts:108-109` | `src/intelligence/tools/call-graph-tracer.ts` | 🔲 pending |
| **`blast-radius-alert.ts` query rewrite** (`dependent_file`/`file` → `file_path`/`ref_file`) **then** narrowed catch | `src/tools/blast-radius-alert.ts:43-55` | 🔲 pending |
| Smoke check — agent listed + staleness < 168 h | `scripts/smoke-bridge.sh` | 🔲 pending |
| `CODE_GRAPH_INTERVAL_MS` env var documented | `CLAUDE.md` Environment block | 🔲 pending |
| `CODE_GRAPH_INDEX_DISABLED=1` kill-switch | `web-server.js` agent registration block | 🔲 pending |

### Deviations from the design

- **2026-05-30 — `nextSunday0317Local` renamed to `nextSunday0317UTC`** during v2 implementation. The Decision section above still names the helper `nextSunday0317Local(now)` because ADR bodies are immutable per the index.md maintenance rule. Rationale for the rename: avoid local-TZ DST footguns in scheduling (the helper now uses only `getUTCFullYear/Month/Date/Day/Hours`, `setUTCDate`, `Date.UTC(...)` — see `src/services/code-graph/scheduler.ts:40-55`; DST-spring-forward case is regression-tested at `tests/code-graph/scheduler.test.ts:11`). Persisted `due_at` rows in `sync_state` store UTC ISO strings.
- **2026-05-31 — Consumer-hint scope clarified.** Path B item #4 ("consumer hint annotation in `call-graph-tracer.ts`") ships a *read-side* annotation only: when `nodes.length === 0` or `edges.length === 0`, the tracer appends a hint string to its summary indicating the indexer hasn't run yet or the graph may be stale (`src/intelligence/tools/call-graph-tracer.ts:138-148`). It does NOT exclude phantom or stale rows from `code_graph` writes — write-side filtering is ADR-028's domain (the F1 fail-on-empty gate at smoke § 10 + the F3 `NOISY_CALLEES` ignore-list).

### Future extensions

1. **Worker-thread sweep with hard-cap abort.** v1 ships without it; uses `withAgentTick` escalation. Worker version makes the 15-min cap actually enforceable.
2. **Index `web-intelligence-mcp` itself** as a third repo, so `web/src/**` and `src/**` get blast-radius too. Deferred to keep this ADR's scope tight.
3. **`wi_code_graph` `staleness_warning` field** — surface a banner-grade signal in the manifest response when `last_synced_at > 24 h`. Cleaner than the in-summary hint but requires a manifest version bump.
4. **Lazy mode** — only run the agent when `wi_code_graph` has been called in the last 24 h, to avoid pointless work on machines where nobody is using blast-radius. Defer until first-week metrics show the cost is non-trivial.
5. **`code_graph_runs` table** for full-sweep history. Out of scope for v1 — `ingestion_log` rows tagged `code-graph-<repo>-incremental` vs `-sweep` cover the immediate need.

## References

- [`/.planning/ADR-REVIEW.md`](https://github.com/your-org/work-intelligence-mcp/blob/main/.planning/ADR-REVIEW.md) § *graphify (declined 2026-05-30)* — driving entry; this ADR is the design contract for action item 2.
- [`/.planning/ADR-REVIEW.md`](https://github.com/your-org/work-intelligence-mcp/blob/main/.planning/ADR-REVIEW.md) § REFACTOR-002 — Four-Stage Pipeline violations; this ADR explicitly cites Process-stage placement to avoid adding a sixth.
- Companion PRD: [`docs/prd/code-graph-indexer.md`](../prd/code-graph-indexer)
- [ADR-017 — Always-On Agent Architecture](./adr-017-always-on-agent-architecture) — agent registration / `withAgentTick` pattern reused here.
- [ADR-024 — Unified Brain API](./adr-024-unified-brain) — downstream consumer of `code_graph` via blast-radius and call-graph-tracer evidence.
- [ADR-026 — Route Module Extraction](./adr-026-route-module-extraction) — when the `code-graph` family is extracted, the busy-flag moves with it onto `RouteContext`.
- `src/tools/code-indexer.ts` — module the agent drives.
- `src/intelligence/tools/call-graph-tracer.ts:108-109` and `src/tools/blast-radius-alert.ts:43-55` — pain-evidence consumers receiving hint upgrades alongside this work.
- claude-mem session: post-graphify action plan, 2026-05-30 (workflow run `wf_db87e4a6-ab8`).

---

## Status Update — 2026-05-30

> The body of this ADR (§ Context through § References) is preserved as the original Proposed design. This section records what actually shipped vs what is still open, so a cold reader can tell decided / shipped / planned apart in one place.

### TL;DR

- **v1 of the indexer shipped** on `main` (commit `e1d6f9e`) with the `CodeGraphIndexer` agent, `indexChangedSince` incremental path, per-repo `Map`-based busy lock, and `smoke-bridge.sh` check #10.
- **v1 implements the alternative the original Decision rejected** — a 4 h `setInterval` with an in-tick `getDay()===0 && getHours()===3` Sunday gate. The "60 s heartbeat + persisted `due_at`" two-layer scheduler is **not yet built**.
- **The blast-radius phantom-column bug is still live.** `src/tools/blast-radius-alert.ts:46` still queries non-existent columns `dependent_file` / `file`; every call returns `{ impactedCount: 0, files: [] }`. This is independent of the scheduler work and should ship as a standalone commit.
- **`/api/system-health.codeGraph` block is not shipped.** The handler at `web-server.js:5340` returns no codeGraph key.
- **POST /api/code-graph/index race is not closed.** `web-server.js:5512` writes the `202` *before* `withCodeGraphLock` is acquired at `:5524`; two concurrent POSTs can both pass the busy check.
- **Schema version is now 51** (was `48` when the ADR was drafted; see `src/db/schema.ts:11`).

### What v1 actually shipped (verified against `main` 2026-05-30)

| Component | Live location | Notes |
|---|---|---|
| `CodeGraphIndexer` agent registration | `web-server.js:6556` | `registerAgent`, `markAgentReady`, `markAgentCrashed` all wired. |
| Tick body | `web-server.js:6561–6604` | Iterates configured repos, picks full-sweep vs incremental per repo. |
| Cadence | `web-server.js:6558` | `Number(process.env.CODE_GRAPH_INTERVAL_MS) \|\| 4 * 60 * 60 * 1000` (4 h, not the 1 h in the original Decision). |
| Sunday gate | `web-server.js:6566` | `now.getDay() === 0 && now.getHours() === 3 && now.getMinutes() < 30` — local time, in-tick, not wall-clock-aligned. |
| Per-repo busy lock | `web-server.js:1944–1958` | `Map<string, true>` (better than the global boolean originally drafted) plus `withCodeGraphLock(repo, fn)`. |
| `indexChangedSince` + checkpoint | `src/tools/code-indexer.ts:150` and `:240–249` | Writes `sync_state` with `topic_id='0'`, `source='code-graph-<repo>'` (hyphen, not the colon some prose used). |
| Manual POST handler | `web-server.js:5503–5537` | Per-repo busy check + `withCodeGraphLock`; race window between `:5512` (`202`) and `:5524` (lock acquire) remains open. |
| Smoke check | `scripts/smoke-bridge.sh` § 10 | Asserts agent registered + row counts > 0 (warn-only on staleness). |
| `git diff HEAD~1` failure path | `src/tools/code-indexer.ts:101–106` | Catches the throw on rsynced repos and falls through to `indexRepo`, as the original Context predicted. |

### What v1 deliberately did *not* ship (still in v2 scope)

| Item | Why it matters | File |
|---|---|---|
| **`blast-radius-alert.ts` query rewrite** | Live silent-zero bug; every blast-radius call returns 0 impact, regardless of `code_graph` content. | `src/tools/blast-radius-alert.ts:46–53` |
| **Two-layer scheduler** (60 s heartbeat + persisted `due_at`) | The headline Sunday 03:00–03:30 sweep depends on a `setInterval` happening to fire inside that 30-minute window on a Sunday — most boots will never hit it. | `web-server.js:6561–6604` |
| **POST race fix** (sync busy-set *before* `202`) | Two concurrent POSTs can both pass `isCodeGraphBusy` before either calls `withCodeGraphLock`, leading to two parallel full rescans on the same repo. | `web-server.js:5512–5524` |
| **`indexRepo` updates `sync_state`** | Full sweep does not write the checkpoint, so any future `staleness_hours` metric will lie until the next incremental tick. | `src/tools/code-indexer.ts:75` |
| **`/api/system-health.codeGraph` block** | No way to observe staleness from the bridge surface; smoke can't gate on it. | `web-server.js:5340–5361` |
| **`CODE_GRAPH_INDEX_DISABLED=1` kill-switch** | Promised in original Implementation Status; not in code. | `web-server.js` agent reg block |
| **DST / timezone for full-sweep target** | The Sunday gate uses local `getDay()/getHours()`. CorrelationAgent was already moved to UTC after a DST incident (`web-server.js:6469–6472`); CodeGraphIndexer will hit the same shape if not aligned. | `web-server.js:6566` |
| **Content-hash sidecar / `indexSingleFile` / `findTsFiles` export** | Original Implementation Status entries; superseded by the `indexChangedSince` per-file inline implementation. **Recommend dropping from v2 unless `indexChangedSince` proves inadequate** (extract optional, not required). | `src/tools/code-indexer.ts` |
| **Worker-thread sweep cap** | Original Decision admitted this was a "v1 fallback"; correctly absent. Keep in "Future extensions". | — |

### Flow diagram — what's live today (v1) vs what v2 changes

```
┌──────────────────────────────────────────────────────────────────────┐
│                       LIVE TODAY (v1, e1d6f9e)                       │
│                                                                      │
│   bridge boot ─► registerAgent('CodeGraphIndexer')                   │
│                       │                                              │
│                       ▼                                              │
│            setInterval(4h, codeGraphTick)         ← phase-unaligned  │
│                       │                                              │
│                       ▼                                              │
│   per repo:  if (now.day=Sun && now.hour=3 && now.min<30)            │
│                       │                ── usually false; sweep       │
│                       │                   never fires on most boots  │
│              ┌────────┴────────┐                                     │
│              ▼                 ▼                                     │
│     indexer.indexRepo()   indexer.indexChangedSince(sinceMs)         │
│     (full sweep)          (mtime-diff incremental)                   │
│           │                       │                                  │
│           │                       └─► writes sync_state              │
│           └─► NO sync_state write ◄── staleness metric will lie      │
│                                                                      │
│   manual POST /api/code-graph/index:                                 │
│     isCodeGraphBusy()? ─no─► json(202) ─► withCodeGraphLock(...)     │
│                                  ▲                ▲                  │
│                                  │                └─ acquired here   │
│                                  └─ RACE: second POST arriving       │
│                                     between these two reads          │
│                                     also passes the busy check       │
│                                                                      │
│   blast-radius-alert.ts:                                             │
│     SELECT dependent_file FROM code_graph WHERE file IN (...)        │
│       ──► SQLITE_ERROR (phantom columns) ──► catch-all returns       │
│           { impactedCount: 0 }   ← every call, every time            │
└──────────────────────────────────────────────────────────────────────┘

                                  │
                          v2 changes (proposed)
                                  ▼

┌──────────────────────────────────────────────────────────────────────┐
│                       v2 PROPOSED (ADR-027b)                         │
│                                                                      │
│   bridge boot ─► registerAgent('CodeGraphIndexer')                   │
│                       │                                              │
│                       ▼                                              │
│            setInterval(60s, dispatcher)            ← heartbeat       │
│                       │                                              │
│              read sync_state:                                        │
│                code-graph:scheduler:incremental_due_at               │
│                code-graph:scheduler:full_due_at  (stored UTC ISO)    │
│                       │                                              │
│              ┌────────┴────────┐                                     │
│              ▼                 ▼                                     │
│   now ≥ full_due_at?   now ≥ incremental_due_at?                     │
│       │                       │                                      │
│       ▼                       ▼                                      │
│   indexRepo() per repo   indexChangedSince(sinceMs) per repo         │
│       │                       │                                      │
│       └─► BOTH paths upsert sync_state   (fixes staleness lie)       │
│       └─► advance the corresponding due_at to the next target        │
│                                                                      │
│   manual POST /api/code-graph/index:                                 │
│     setBusy(repo) ─synchronously─► json(202) ─► run under lock       │
│                       (no race window: busy is set before res.write) │
│                                                                      │
│   blast-radius-alert.ts:                                             │
│     SELECT DISTINCT file_path FROM code_graph                        │
│      WHERE ref_file IN (...) AND ref_type IN ('import','test_covers')│
│       ──► returns real dependents                                    │
│     catch narrowed to /no such table/ only                           │
│                                                                      │
│   /api/system-health.codeGraph block:                                │
│     { lastIndexedAt, staleness_hours, row_count_per_repo,            │
│       last_full_sweep_at, busy_rejections_24h, agent_status }        │
└──────────────────────────────────────────────────────────────────────┘
```

### v2 acceptance criteria

A v2 implementation is "done" when:

1. `scripts/smoke-bridge.sh` § 10 asserts staleness_hours < 168 (1 week) using the new `/api/system-health.codeGraph` block — currently warn-only on row counts.
2. The Sunday-sweep semantics are verifiable from a unit-shaped test that fast-forwards `Date.now`: simulate booting at 02:55, 04:10, 11:00, 19:30 on six different days; the dispatcher must fire the full sweep exactly once for the Sunday in the simulated window, regardless of boot time.
3. A concurrent-POST smoke step (two `curl` calls fired in parallel against `/api/code-graph/index`) results in exactly one `202` and one `409`.
4. `blast-radius-alert.ts` returns non-zero `impactedCount` for a known importer in the populated `code_graph` (verified by querying `SELECT * FROM code_graph WHERE ref_type='import' LIMIT 1` and feeding the `ref_file` value into `analyzeBlastRadius`).
5. `indexRepo` writes `sync_state` after a full sweep — `last_synced_at` advances on Sunday paths, not just incremental ones.

### Recommended sequencing for v2

These are independent and should ship as separate commits:

1. **Standalone, ship first** — `blast-radius-alert.ts` rewrite. ~15 LOC. Zero scheduler dependency. Fixes a live silent-zero bug. Same commit narrows the catch to `/no such table/` only.
2. **Scheduler v2 minimal** — replace 4 h `setInterval` + in-tick gate with 60 s heartbeat + persisted UTC `due_at` rows in `sync_state` (sentinel keys `code-graph:scheduler:incremental_due_at`, `code-graph:scheduler:full_due_at`). Add `sync_state` upsert at the end of `indexRepo`. ~30–50 LOC.
3. **POST race fix** — move the busy-set above `json(res, 202, ...)`; release in `.finally`. ~10 LOC. Add the concurrent-POST smoke step.
4. **`/api/system-health.codeGraph`** + smoke gate on staleness. ~30 LOC plus smoke check.
5. **Kill-switch** `CODE_GRAPH_INDEX_DISABLED=1` — short-circuit the agent registration block. ~5 LOC.

### Status of original Implementation Status table rows

The "Implementation Status" table earlier in this document was written before v1 shipped. Refreshed mapping:

| Original row | Truth as of 2026-05-30 |
|---|---|
| `findTsFiles` access modifier | **Skip** — `indexChangedSince` made this unnecessary; the helper remains private. |
| `CodeIndexer.syncAll(repoName?)` overload | **Skip** — agent calls `indexRepo(repoName)` directly. |
| `CodeIndexer.indexSingleFile` | **Skip** — `indexChangedSince` does the per-file work inline. |
| Content-hash sidecar | **Defer to Future Extensions** — not needed until rsync-mtime-backwards is observed in production. |
| `CodeGraphIndexer` agent registration | ✅ **shipped** at `web-server.js:6556`. |
| Module-scope busy flag | ✅ **shipped** at `web-server.js:1944–1958` (per-repo `Map`, not single boolean — better shape). |
| Manual POST sync busy-set | ❌ **not shipped** — race window remains. v2 item. |
| `sync_state` sentinel rows | 🟡 **partially shipped** — `code-graph-<repo>` row written by `indexChangedSince`; `code-graph:scheduler:*_due_at` not yet. Note hyphen vs colon: live code uses `code-graph-<repo>`. |
| `/api/system-health.codeGraph` block | ❌ **not shipped**. v2 item. |
| Consumer hint in `call-graph-tracer.ts` | ❌ **not shipped**. Low cost; pull into v2. |
| `blast-radius-alert.ts` rewrite | ❌ **not shipped**. **Highest priority — standalone commit.** |
| Smoke check (agent listed + staleness) | 🟡 **partially shipped** — agent listed asserted; staleness is warn-only. v2 tightens to a hard gate. |
| `CODE_GRAPH_INTERVAL_MS` documented | ✅ **shipped** in `CLAUDE.md` Environment block. |
| `CODE_GRAPH_INDEX_DISABLED=1` kill-switch | ❌ **not shipped**. v2 item. |

### Notes for the next reviewer

- **The ADR's own Alternatives table flags v1's pattern as "Rejected — headline schedule does not fire."** That's still true — but it shipped. Don't read v1 as a green-light on the rejected design; read it as an interim step that traded scheduler quality for getting the agent live with a per-repo lock. v2 is the design contract.
- **Path nit corrected from review:** `blast-radius-alert.ts` lives at `src/tools/blast-radius-alert.ts`, not `src/services/`.
- **Schema-version pin avoidance going forward:** future ADRs should reference `src/db/schema.ts` rather than pinning a number that goes stale on the next migration.

---

## v2 — explained simply (with diagram)

> This section is for someone who isn't going to read 400 lines of ADR. It tells the story of what was broken in v1, what v2 does, and why.

### What does the code-graph indexer actually do?

WI lives next to two big code repos: `example-service` and `operations`. The **code-graph indexer** reads the source files in those repos and writes one row per dependency into a SQLite table called `code_graph`. Think of it as a phone book for "if I change file X, who else cares?" When a developer asks **wi_code_graph blast-radius** "show me everyone who imports this file," the bridge reads `code_graph` to answer.

For that phone book to be useful it has to be **fresh** (re-read after files change) and **trustworthy** (the answer to "who imports X?" matches reality).

### What broke in v1

Three pieces all looked right but had a hidden flaw each. Imagine the indexer is a librarian who's supposed to keep a card catalog up to date.

| What v1 did | What was wrong |
|---|---|
| The librarian set an alarm clock to wake up every 4 hours and check whether it was Sunday morning at 3 AM. If yes, do the deep clean. | The alarm only rings every 4 hours — it almost never rings exactly during the 30-minute Sunday-morning window. So the deep clean never happened. |
| When you asked "who imports `auth.ts`?" the librarian looked in a column called `dependent_file`. | That column doesn't exist. The librarian quietly returned "nobody imports it" every single time, because the error was caught and silenced. |
| Two people could press the "rebuild now" button at the same time. The first one started; the librarian put up a "busy" sign. | The "busy" sign went up *after* the second person had already been told "okay, started." Both rebuilds ran at once, fighting over the same shelf. |

None of these would crash — they'd just lie. The blast-radius answer was always "0 imports." Sunday's deep clean was a no-op. The catalog was stale by 33+ days when v1 was inspected.

### What v2 changes — the picture

```
┌─────────────────────────────────────────────────────────────────────┐
│                            v1 (broken)                              │
│                                                                     │
│   alarm clock ──tick every 4h──► is it Sunday 3:00–3:30?            │
│                                       │                             │
│                                  almost always NO                   │
│                                       │                             │
│                                  do nothing today                   │
│                                                                     │
│   "who imports X?" ──► look in `dependent_file` ──► error caught    │
│                                                  ──► silently lie   │
│                                                       "nobody!"     │
│                                                                     │
│   button #1 pressed ──► librarian says OK, starts                   │
│   button #2 pressed ──► librarian ALSO says OK (race!)              │
│                  ──► two rebuilds collide over same shelf           │
└─────────────────────────────────────────────────────────────────────┘

                            ▼  v2 fixes  ▼

┌─────────────────────────────────────────────────────────────────────┐
│                           v2 (corrected)                            │
│                                                                     │
│   heartbeat ── every 60s ──►  read sticky note: "next deep clean    │
│                              due Sunday 03:17 UTC"                  │
│                                       │                             │
│                              now past that time? ──► YES, run it    │
│                                                  ──► move sticky to │
│                                                      next Sunday    │
│                                                                     │
│   "who imports X?" ──► look in `ref_file` (real column) ──►         │
│                              return everyone in `file_path` who     │
│                              has that as a ref. Real answer.        │
│                                                                     │
│   button #1 pressed ──► librarian flips "busy" sign FIRST,          │
│                         then says OK                                │
│   button #2 pressed ──► sees "busy" sign ──► rejects (HTTP 409)     │
│                  ──► no collision, deterministic single rebuild     │
│                                                                     │
│   /api/system-health.codeGraph (new):                               │
│     "agent_status: ready, staleness_hours: 0,                       │
│      busy_rejections_24h: 0, last_full_sweep_at: 2026-05-25T03:17"  │
│   ── now anyone (smoke, dashboard, you) can SEE the truth.          │
│                                                                     │
│   CODE_GRAPH_INDEX_DISABLED=1 ── opt-out for inspection runs.       │
└─────────────────────────────────────────────────────────────────────┘
```

### What each fix does, in one sentence

1. **Heartbeat scheduler.** Replace the 4-hour alarm with a 60-second poll that reads a "next due" sticky note. The deep clean now actually fires every Sunday because the sticky note is a real wall-clock target, not a "happens to land in the right window" hope.
2. **Real columns.** Look up `ref_file` and `file_path` (which exist) instead of `dependent_file` and `file` (which don't). Blast-radius now returns real answers.
3. **Lock first, respond second.** When the rebuild button is pressed, the librarian claims the lock *before* saying "OK." Two simultaneous presses get exactly one "OK" and one "busy."
4. **Health visibility.** A new `codeGraph` block in `/api/system-health` exposes when the indexer last ran, how many busy-rejections happened, and how stale the catalog is. Smoke fails if it's more than a week old.
5. **Kill-switch.** Set `CODE_GRAPH_INDEX_DISABLED=1` and the agent doesn't register at all — useful when you want to inspect the catalog without the indexer modifying it.

### How you'd notice v2 is working

- Run the bridge → `[Agents] Boot complete: 9 agents` (CodeGraphIndexer is one of them, status `ready`).
- `curl /api/system-health | jq .codeGraph` → real numbers, not nulls.
- `curl /api/code-graph/blast-radius?repo=example-service&file=<some-actual-file>` → non-zero `impactedCount`.
- Press the rebuild button twice in parallel → exactly one HTTP 202 + one HTTP 409.
- Wait until next Sunday 03:17 UTC → look at `last_full_sweep_at` in `/api/system-health.codeGraph` — it advanced.

The smoke harness checks all five of these. If any one regresses, smoke fails before the bridge would serve a wrong answer to a real user.

---

## v2 Shipped — 2026-05-30 (final)

All five v2 acceptance criteria from § *Status Update — 2026-05-30* are now closed. Branch `feat/adr-027-v2`, five atomic commits:

| # | Commit | What |
|---|---|---|
| 1 | `aa5ae2a` | **blast-radius phantom-column fix** — `dependent_file`/`file` → `file_path`/`ref_file`; catch narrowed to `/no such table/`; smoke § 10b queries highest-imported file and asserts `impactedCount > 0` |
| 2 | `ee7b070` | **two-layer scheduler** — 60s heartbeat dispatcher + `code-graph:scheduler:{incremental,full}_due_at` UTC sentinels in `sync_state`; `nextSunday0317UTC(now)`; `indexRepo` now writes `sync_state` on completion |
| 3 | `7d1ce1f` | **POST race fix** — `tryAcquireCodeGraphLock(repos)` synchronous all-or-none claim before `json(202, ...)`; release in `.finally`; smoke § 10c fires two parallel POSTs and asserts `(202, 409)` |
| 4 | `65a0647` | **`/api/system-health.codeGraph` block** — `agent_status`, `last_indexed_at`, `last_full_sweep_at`, `staleness_hours`, `busy_rejections_24h`, `per_repo`; smoke § 10d gates `staleness_hours < 168` |
| 5 | `c10c001` | **`CODE_GRAPH_INDEX_DISABLED=1` kill-switch** + CLAUDE.md docs |

### v2 acceptance criteria — final status

1. ✅ Smoke § 10d asserts `staleness_hours < 168` using the new `codeGraph` block.
2. 🟡 `nextSunday0317UTC(now)` covered by inline reasoning; a unit-shaped fast-forward test deferred (the helper is ten lines and the boot-time write-if-absent invariant is the load-bearing piece).
3. ✅ Smoke § 10c — concurrent POST → exactly one `202` + one `409`.
4. ✅ Smoke § 10b — blast-radius returns non-zero `impactedCount` for a known importer.
5. ✅ `indexRepo` writes `sync_state` after a full sweep (`src/tools/code-indexer.ts:91`).

### What v2 explicitly does NOT prove

> **Update 2026-05-31:** All four items below are now CLOSED by the Path B commits. Section retained as a record of what the audit found and where each fix landed — see § *Path B closeout — 2026-05-31* below for the closing-side detail.

The badge above ~~is honest about scope: load-bearing behaviour ships and is smoke-gated, but four items remain open~~ now reads as fully complete. Original audit findings, with the commit that closed each:

| # | Open item | Severity | Why it matters | Closed by |
|---|---|---|---|---|
| 1 | **AC #2 — cron-style fast-forward unit test for `nextSunday0317UTC`** | 🟡 MEDIUM | The AC text demanded "simulate booting at 02:55, 04:10, 11:00, 19:30 on six different days; the dispatcher must fire the full sweep exactly once." We shipped inline reasoning only — Sunday-sweep semantics are unproven by construction. A clock-shift refactor could break wall-clock alignment without smoke noticing. | ✅ `8fbd07d` — `tests/code-graph/scheduler.test.ts` (11 tests) |
| 2 | **AC #3 — race closure is probabilistic, not deterministic** | 🔴 HIGH | Smoke § 10c treats `(202, 202)` as a *warn-only* "smoke timing miss" (`b00fd6b` tightened the timing but did not change the verdict). A regression that re-opens the lock-acquire race — e.g. removing the synchronous `tryAcquireCodeGraphLock` and reverting to the old `.then` shape — would NOT fail smoke. Live runs on master HEAD return `(202, 202)` often enough that the gate is decorative. The lock invariant is the load-bearing safety property of v2; "probably holds" is the wrong floor for it. | ✅ `1a6eeb2` — `tests/code-graph/lock.test.ts` (13 tests) + smoke § 10e (vitest gate) |
| 3 | **`CODE_GRAPH_INDEX_DISABLED=1` kill-switch smoke coverage** | 🟡 MEDIUM | The code at `web-server.js:6647` is fine today, but a refactor that breaks the `if (process.env.CODE_GRAPH_INDEX_DISABLED)` guard would ship silently. The kill-switch exists *because* the indexer can wedge — losing it during a wedge is exactly the moment we need it. | ✅ `b489376` — `scripts/smoke-killswitch.sh` (4 checks) |
| 4 | **Consumer-hint string in `call-graph-tracer.ts`** | 🟢 LOW | Originally pulled into v2 (line 422 above), then quietly de-scoped to "deferred" (line 562) without a recorded re-scoping decision. Low-cost item: 5 LOC to look up `sync_state.last_synced_at` for `code-graph-<repo>` and append `"(indexer has not run yet — see /api/system-health.codeGraph for status)"` when stale or missing. | ✅ `70ed8a9` — `src/intelligence/tools/call-graph-tracer.ts:138` + `tests/intelligence/call-graph-tracer-hint.test.ts` (6 tests) |

The execution order ran as planned: kill-switch smoke (cheapest, lowest blast radius) → consumer hint → cron unit test → deterministic race (last, so a hard-fail smoke regression is easy to bisect against the surrounding work).

### Status of original Implementation Status table rows — refreshed

| Original row | Truth as of 2026-05-30 (v2) |
|---|---|
| `findTsFiles` access modifier | **Skipped** — `indexChangedSince` made it unnecessary. |
| `CodeIndexer.syncAll(repoName?)` overload | **Skipped** — agent calls `indexRepo` / `indexChangedSince` directly. |
| `CodeIndexer.indexSingleFile` | **Skipped** — per-file work inlined in `indexChangedSince`. |
| Content-hash sidecar | **Future Extensions** — defer until rsync-mtime-backwards is observed. |
| `CodeGraphIndexer` agent registration | ✅ shipped (v1 `e1d6f9e`, retained in v2). |
| Module-scope busy flag | ✅ shipped (v1) — extended in v2 with `tryAcquireCodeGraphLock` for atomic claim. |
| Manual POST sync busy-set | ✅ **shipped** (v2 `7d1ce1f`). |
| `sync_state` sentinel rows | ✅ **shipped** (v2 `ee7b070`) — `code-graph-<repo>` (incremental + full) + `code-graph:scheduler:{incremental,full}_due_at`. |
| `/api/system-health.codeGraph` block | ✅ **shipped** (v2 `65a0647`). |
| Consumer hint in `call-graph-tracer.ts` | 🟡 **deferred** — low cost; small follow-up, not load-bearing. |
| `blast-radius-alert.ts` rewrite | ✅ **shipped** (v2 `aa5ae2a`). |
| Smoke check (agent listed + staleness) | ✅ **shipped** — staleness now hard-gated at `< 168h`. |
| `CODE_GRAPH_INTERVAL_MS` documented | ✅ shipped; updated in v2 to reflect 1h default + 60s heartbeat. |

### What did not ship in v2

- **Cron-style scheduler unit test** (criterion #2 partial). The helper is small enough that a future test pass can land it without architectural change. Tracked as a future extension. *Closed by Path B item #2 — see § Path B closeout below.*
- **`call-graph-tracer.ts` consumer hint** — the "indexer has not run yet" string. Easy follow-up. *Closed by Path B item #4 — see § Path B closeout below.*

---

## Path B closeout — 2026-05-31

The four open items from § *What v2 explicitly does NOT prove* are now closed. Branch `feat/adr-027-v2-finish`, four atomic commits (each smoke-tested on commit):

| # | Commit | What | How verified |
|---|---|---|---|
| 1 | `b489376` | **Kill-switch smoke coverage** — `scripts/smoke-killswitch.sh` spawns a child bridge on `:3133` with `CODE_GRAPH_INDEX_DISABLED=1`, hermetic temp DB, palace disabled. Asserts `CodeGraphIndexer` not registered + agent count drops to 8. Wired into `npm run smoke:all`. PORT in `web-server.js` is now `Number(process.env.PORT) \|\| 3132` so the smoke can run a child bridge without conflicting with the main one. | `npm run smoke:killswitch` → 4/4 pass. A refactor that flattens the kill-switch `if/else` would now fail this check loudly. |
| 2 | `70ed8a9` | **Consumer-hint string in `call-graph-tracer.ts`** — `formatTraceSummary` now appends an indexer-status hint to empty-result summaries. No `sync_state` row → `"indexer has not run yet for this repo"`. `last_synced_at > 24h` → `"indexer last ran Nh ago — graph may be stale"`. Both append `"see /api/system-health.codeGraph for status"`. | `tests/intelligence/call-graph-tracer-hint.test.ts` — 6 tests, ~7ms. Covers both branches plus repo-isolation, unparseable timestamp, and fresh-row-no-hint negative case. |
| 3 | `8fbd07d` | **Cron-style fast-forward unit test for `nextSunday0317UTC`** — helper extracted to `src/services/code-graph/scheduler.ts` (pure, no DB, no agent, `now` always passed in). `tests/code-graph/scheduler.test.ts` simulates 4 boot times × 6 weekdays + Sunday-edge cases + month/year boundary + spring-DST transition. The load-bearing test is a 60s-heartbeat dispatcher simulation that ticks for a full 7-day window and asserts exactly one Sunday-03:17-UTC fire. | `tests/code-graph/scheduler.test.ts` — 11 tests, ~7ms. Covers the AC contract: every boot → exactly one fire per week, regardless of when we boot. |
| 4 | `1a6eeb2` | **Deterministic race-closure test + smoke § 10e gate** — lock state extracted to `src/services/code-graph/lock.ts` (single shared Map; `tryAcquireCodeGraphLock`, `releaseCodeGraphLock`, `isCodeGraphBusy`, `withCodeGraphLock`, `recordCodeGraphBusyRejection`, `getCodeGraphBusyRejections`). `tests/code-graph/lock.test.ts` calls the lock function twice synchronously inside one event-loop turn and asserts the (ok, busy) contract — 100-way contention, multi-repo atomicity, partial-overlap rejection without claiming new repos, ring-buffer FIFO eviction at 1000, defensive-copy contract. Smoke § 10e is a HARD gate that runs this test via `npx vitest`; § 10c stays soft (HTTP race is genuinely timing-dependent). | `tests/code-graph/lock.test.ts` — 13 tests, ~4ms. `npm run smoke:bridge` 47/47 pass. |

### Path B acceptance criteria — final

1. ✅ **Cron-style fast-forward unit test exists** — `tests/code-graph/scheduler.test.ts:11`. Sunday-sweep semantics are now construct-deterministic.
2. ✅ **Race closure is deterministic** — `tests/code-graph/lock.test.ts:13`. Smoke § 10e is the hard gate; § 10c is intentionally retained as a soft HTTP-level smoke.
3. ✅ **Kill-switch has smoke coverage** — `scripts/smoke-killswitch.sh:4`. Child bridge proves agent absence + count delta.
4. ✅ **Consumer hint shipped** — `src/intelligence/tools/call-graph-tracer.ts:138`. `tests/intelligence/call-graph-tracer-hint.test.ts:6` verifies all three branches (no row, stale, fresh).

### Test totals after Path B

| Suite | Tests | Time | Closes |
|---|---|---|---|
| `tests/code-graph/scheduler.test.ts` | 11 | ~7ms | AC #2 |
| `tests/code-graph/lock.test.ts` | 13 | ~4ms | AC #3 |
| `tests/intelligence/call-graph-tracer-hint.test.ts` | 6 | ~7ms | Item #4 |
| **Total new** | **30** | **~18ms** | |

Smoke totals after Path B:
- `npm run smoke:bridge` — **47** passed (was 46; § 10e added)
- `npm run smoke:killswitch` — **4** passed (new script)
- Both run in `npm run smoke:all`.


