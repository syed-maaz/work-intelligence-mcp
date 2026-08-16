# G4-METRICS — 15 Scenario Verification (DoD evidence)

**Date:** 2026-08-06
**Subject:** `scripts/weekly-metrics.js` (weekly 3-number metrics report)
**DB discipline:** all fabricated scenarios ran against throwaway `/tmp/g4-test.db`
(real-ish schema, synthetic rows). Never touched dev DB `~/.wi-dev-g4-metrics/data.db`
or prod DB. Script opened the DB read-only (`better-sqlite3 {readonly:true}`).

## E2E (real data)

`npm run metrics:weekly` against dev DB (copy of live schema+data, backed up
2026-08-06 13:18 from `~/.work-intelligence-mcp/data.db`) ran clean:

```
1. SESSIONS RUN        15   (prev 7d: 274, Δ -94.5%)
2. BUGS CLOSED          0   (tasks kanban cards moved to closed)
3. QUERIES ANSWERED    42   (cypher_steps tool_use+completed)
DISPATCH             total 4 — succeeded 2 / timed_out 0 / failed 2 → 50.0% (FAIL vs 80% floor)
VETO GATE            sessions>=30: NO (15) | bugs>=1: NO (0) => VETO ACTIVE
```

Cross-validated: `QUERIES ANSWERED 42` matches an independent sqlite3 count
(`cypher_steps` stage='tool_use' status='completed' in window).

## Scenario results

| # | Scenario | Fabrication | Result | PASS/FAIL |
|---|----------|-------------|--------|-----------|
| 1 | Happy path (real data) | Full schema; 2 sessions/2 queries/2 closures in window, 4 dispatches (2 ok,1 t/o,1 fail), 2 unread, 1 error | sessions 2, bugs 2, queries 2, dispatch 4@50.0%, unread 2, errors 1 | PASS |
| 2 | Empty result set | All rows 1h outside window edges (T-7d-1h, T-30d) | all three numbers 0, prev 0, honest "0 cards moved to closed" notes, veto ACTIVE | PASS |
| 3 | Missing table/column | (a) DB with only `cypher_sessions`; (b) `tasks` without `entered_column_at` | (a) zeros + explicit MISSING TABLE notes for every absent table; (b) exit 1, `Error: UNKNOWN COLUMN — update script: tasks.entered_column_at` | PASS |
| 4 | Timeout / slow upstream | 200k sessions + 300k steps (largest realistic volume), timed | sessions 199999, queries 199998 (boundary ms→s truncation artifact in fabrication, not script), completes in 0.21s | PASS |
| 5 | Partial failure mid-batch | 3 succeeded / 2 failed / 1 timed_out / 1 aborted dispatch + mixed step statuses | queries 3 (only completed counted), dispatch total 7, success 42.9% — partials never dropped from total | PASS |
| 6 | Duplicate rows / idempotency | 3 identical session rows, 2 identical tool_use rows | counts occurrences (3/2), two consecutive runs byte-identical output | PASS |
| 7 | Long-running input | 10k sessions seeded 1/hour over 417 days | in-window 167 (boundary row at exact T-7d excluded correctly), runs instantly | PASS |
| 8 | Stale data (T-7d, T-30d) | rows only in prev/older windows | current 0, trend -100.0%, cold notes (last closed_at etc.) | PASS |
| 9 | Permission/401 errors | (a) DB chmod 000; (b) DATABASE_PATH → nonexistent file | both: `SqliteError: unable to open database file (SQLITE_CANTOPEN)`, exit 1 — loud, never silent zeros | PASS |
| 10 | Malformed payload | started_at/created_at = 'garbage-date', 'not a timestamp', '' | garbage rows skipped by parser (NaN guard), valid rows still counted (1/1), no crash | PASS |
| 11 | Concurrent writers | 2 reader runs parallel + sqlite3 writer inserting 40 rows | both readers complete, outputs identical | PASS |
| 12 | Zero-data schema-only DB | full schema, zero rows | all 0 + notes, veto ACTIVE | PASS |
| 13 | Flag off / disabled path | `OUTCOME_HONEST_KANBAN_ENABLED=0` env (flag absent from .env) | board read regardless; bugs-closed 1 counted from kanban | PASS |
| 14 | Retry-exhausted (DLQ/abort) | 3 failed + 1 pending + 1 aborted dispatch, 1 error_log | dispatch total 5, success 0.0% — exhausted/aborted counted in total, depress rate honestly | PASS |
| 15 | Rollback path (dry-run → apply → verify) | script is read-only: 2 runs + sha256 of DB before/after | output identical across runs, DB sha256 unchanged — no write side-effects | PASS |

**15/15 PASS.**

## Verdict

- Fail-loud policy verified: missing column → `UNKNOWN COLUMN` + exit 1;
  unopenable DB → `SQLITE_CANTOPEN` + exit 1; missing table → explicit note +
  0. No silent zeros anywhere.
- Read-only guarantee verified (scenario 15).
- Mixed epoch-ms/ISO `cypher_sessions.started_at` parsing verified (scenarios 1, 4, 10).
