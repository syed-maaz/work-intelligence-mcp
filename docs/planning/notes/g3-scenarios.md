# G3 — 15 Real-World Scenarios (DoD) — 2026-08-06

Harness: `/tmp/g3-scenarios.sh` — throwaway DBs in `/tmp/g3-*.db`, real script `scripts/reap-2026-08.mjs`, real better-sqlite3. Result: **15/15 PASS**.

## Scenario matrix

| # | Scenario | Setup | Expected | Result |
|---|---|---|---|---|
| 1 | Happy path (real data) | 3 running rows: 25d, 22d, 20d old; 6 unread queue | 2 reaped (25d+22d), 20d row kept running, 6 unread→4 | **PASS** — `2` rows `failed` + `reaped-2026-08-06-stale-running`, 1 running, unread=4 |
| 2 | Empty result set | Tables exist, zero rows | dry-run + apply both 0 targeted/applied | **PASS** — `"targeted": 0` x2, `"applied": 0` x2 |
| 3 | Missing table | Only `proactive_queue` created | Graceful plan failure, exit 2 | **PASS** — `"ok": false` reason `missing column(s): id, status`, exit 2 |
| 4 | Missing column | `error_text` + `completed_at` dropped | Degrade: status-only update + loud warning | **PASS** — row terminated, warning `abort reason NOT recorded` emitted |
| 5 | No running rows | 6 unread, 0 running | Queue-only archive 6→4 | **PASS** — `"applied": 2`, unread=4 |
| 6 | All-running DB | 5 running, all stale | All 5 reaped, 0 remaining | **PASS** — running count 5→0 |
| 7 | Already-aborted (idempotency) | Re-apply after S6 | Second apply targets 0 | **PASS** — `"targeted": 0` both plans |
| 8 | Huge queue | 2000 unread rows (CTE insert) | 2000→4, 1996 archived | **PASS** — unread=4 after apply |
| 9 | Interrupted mid-batch | Poison trigger ABORTs on 3rd row UPDATE | Whole tx rolls back, 0 partial | **PASS** — exit 1, all 3 still `running` |
| 10 | --dry-run no-op | 1 stale row; `cmp` db before/after | Byte-identical file | **PASS** — `cmp -s` same |
| 11 | DATABASE_PATH unset | Env removed | Refuse, exit 1 | **PASS** — `DATABASE_PATH env var required`, exit 1 |
| 12 | Unopenable/missing DB | Path doesn't exist | Exit 1, no file created | **PASS** — exit 1, `! -f` confirmed (existsSync guard) |
| 13 | Queue exactly at KEEP_UNREAD | 4 unread | Archives 0 | **PASS** — unread=4, `"applied": 0` |
| 14 | Mixed time units + real status set | 1 row seconds-epoch 30d old, 1 ms 25d old, 1 `pending` 25d old | Both stale running reaped; pending untouched | **PASS** — f1/f2 → failed, f3 stays pending |
| 15 | Double-run deterministic | Post-apply dry-run | 0 targeted again | **PASS** — `"targeted": 0` x2 |

## Real-data validation (dev copy `~/.wi-dev-g3-reap/data.db`)

- Dry-run: `before {running:5, unread:14}`, targeted 5 reaps + 10 archives, applied 0, db unchanged.
- Apply: `after {running:0, unread:4}` — 5 reaped rows `failed` + `reaped-2026-08-06-stale-running` + `completed_at` set; 4 newest queue rows kept unread.
- Re-apply: targeted 0 (idempotent).
- Note: dev copy unread count is 282-family (pre-reap sandbox had 269; earlier session apply+reset on the sandbox drifted it — see g3-notes); prod behavior identical, prod before = 269.

## Schema-adaptation findings (script adapts, docs report)

1. `subagent_dispatches.status` CHECK constraint: `IN ('pending','running','succeeded','failed','timed_out')` — **rejects `'aborted'`**. Script detects via DDL regex → uses `failed` + reason in `error_text` + `completed_at` as reaped_at (no `reason`/`reaped_at` columns exist).
2. `proactive_queue` has **no `status`/`processed_at` columns** — archive = `read_at` NULL→now transition (no deletes). Script uses `status='archived'` + `processed_at` when present (future-proof).
3. `dispatched_at` is epoch **milliseconds** (>1e11) — unit-aware compare; seconds-epoch fallback proven in S14.
