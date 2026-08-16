# G0 scenarios — 15 real-world evidence scenarios

Each scenario = one query against real prod data (read-only). PASS = evidence obtained; FAIL = could not obtain.

| # | Scenario | Expected | Observed | PASS/FAIL |
|---|---|---|---|---|
| 1 | Sessions per day, ISO-format rows | readable dates | `2026-08-05/06 = 10`, Jul 29 = 152 | PASS |
| 2 | Sessions per day, epoch-ms rows | readable dates | bucketed as 1970 (format poison) | FAIL → fixed via CASE |
| 3 | Session id 4791 (Aug 5) | real timestamp | `1785911860581.0` epoch-ms float | PASS |
| 4 | Loop sessions (engine=loop) alive today | smoke vs real split | all Aug 6 = smoke/canary | PASS |
| 5 | Last sustained auto-loop session | found | Jul 29 20:04 id 4784 | PASS |
| 6 | Death window zero-count | Jul 30–Aug 2 = 0 | confirmed 0 sessions | PASS |
| 7 | Error logs end date | found | max=2026-08-06 12:54 (opus 429, ongoing); death window Jul 30–Aug 5 itself empty | PASS |
| 8 | Workers heartbeat freshness | recent | last_active Aug 6 12:5x | PASS (heartbeat ≠ loop) |
| 9 | Smoke last green | stale | Jul 14 | PASS |
| 10 | Subagent dispatch latest | found | Aug 4 18:37 blast-radius succeeded | PASS |
| 11 | Board gate behavior on stale smoke | blocked advance | code path confirmed (195–230) | PASS |
| 12 | Git commits Jul 29–Aug 5 | none landing on loop | none | PASS |
| 13 | GC alive | current | Aug 6 12:57 run; ~12 entries Jul 29 | PASS |
| 14 | 429 rate-limit cause check | opus bucket | `anthropic--claude-4.8-opus` PROVIDER_RATE_LIMIT — ongoing through Aug 6 | PASS |
| 15 | Which timestamps formats exist | 2 formats | ISO text (~1417) + epoch-ms float-as-text (~434); no epoch-sec, no real integer typeof | PASS |

**Result: 15/15 evidence scenarios executed. 1 formatting FAIL surfaced a metrics bug (scenario 2) — not a loop failure.**

Root cause stands: smoke-stale gate → BoardWorkerAgent refuses advance → no auto session spawn → zero loop work since Jul 29 20:04.
