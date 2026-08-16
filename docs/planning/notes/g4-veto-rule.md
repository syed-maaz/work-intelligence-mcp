# G4 — Weekly Metrics Veto Rule (measure before build)

**Owner:** G4-METRICS
**Source of truth:** `scripts/weekly-metrics.js` (run `npm run metrics:weekly`)
**Date:** 2026-08-06

---

## 1. Purpose

The weekly 3-number report is the "measure before build" guard for the WI loop.
The loop earns the right to new build work only when it measurably operates:
sessions run, bugs closed, queries answered. If the loop is not operating, the
correct response is maintenance/ops — not new construction.

## 2. The three numbers

| # | Metric | Definition (script) |
|---|--------|---------------------|
| 1 | SESSIONS RUN | `cypher_sessions.started_at` rows in the trailing 7-day window (mixed epoch-ms/ISO handled; window is UTC) |
| 2 | BUGS CLOSED | `tasks` (kanban) cards moved to closed in the window: `status='closed'` with `closed_at` in window, OR `kanban_column='done'` with `entered_column_at` in window (max, avoids reconcile-lag double count). Cross-checks: `jira_transitions.to_status`, `bug_resolutions.outcome`, `bugs.status` |
| 3 | QUERIES ANSWERED | `cypher_steps` `stage='tool_use'` + `status='completed'` in window (the tool-call log; there is no `tool_invocations`/`tool_calls`/`animate_stats`/`message_stats` table in the schema) |

Plus: dispatch 4-number (total / succeeded / timed_out / failed + success-rate),
proactive_queue unread, error_logs in window, session trend vs previous 7 days.

## 3. Weekly gate

```
IF sessions_run < 30/week AND bugs_closed < 1/week THEN
    VETO ACTIVE for that week
    → no new build work. Maintenance/ops only:
      bug fixes on broken paths, DB hygiene, skill fixes, doc updates, tooling
      that keeps the loop operating. No new features, no new subsystems.
```

The gate is evaluated from the report script's numbers only — never
hand-entered, never argued around.

## 4. Two-consecutive-week veto → mandatory stand-down

```
IF veto active for 2 consecutive weeks THEN
    mandatory stand-down: orchestration re-plan required.
    Stop all build work. Orchestrator must re-plan (goal shape, skill wiring,
    loop configuration) before ANY build resumes.
```

A single bad week is noise. Two bad weeks in a row is a system signal: the
current orchestration is not producing sessions or closures, and building more
on top of it is substrate-done masquerading as outcome-done (ADR-050's core
discipline).

## 5. ADR-050 tie-in

ADR-050 (fault-proof `/WI` measurement gate) defines the executor floor
(M2): **dispatch success ≥ 80%**. The weekly report must surface this gate
every week:

- `subagent_dispatches` in window → success-rate % vs the 80% floor.
- If the floor is not met, the executor is the bottleneck — executor-fix work
  is the legitimate workstream (per ADR-050 §2.2), not new orchestration build.

### 5.1 Reaped-vs-genuine `failed` separation (accepted-risk until `'aborted'` migration)

The reap script (G3) marks stale-`running` dispatches as `status='failed'` +
`error_text='reaped-…'` because the `subagent_dispatches.status` CHECK
constraint rejects `'aborted'`. Until a `'aborted'` migration lands (tracked
pre-G2), reaped rows are indistinguishable from genuine failures at the status
layer.

**Mitigation (live in script, Reviewer-5 option b):** when `error_text` is
present, `collectDispatch` breaks `failed` out into `failedReaped` (matches
`error_text LIKE 'reaped-%'`) and `failedGenuine` (= `failed - failedReaped`).
The ADR-050 floor is computed on **genuine** only:

```
total_for_floor = succeeded + timed_out + failedGenuine + other
success_rate    = succeeded / total_for_floor
```

Both `failed` (gross) and `failedReaped` are printed so the gross stays
auditable. Once the `'aborted'` status migration lands, the reaped bucket
becomes its own status and this filter becomes a no-op.

**Historical-window caveat:** reaped rows past-dated by their `dispatched_at`
(outside the rolling 7-day window) are not counted this week regardless. The
conflation only bites if the window key is ever re-pivoted to `completed_at`
— the script windows on `dispatched_at`, so the trap is currently inert.

## 6. Metrics source rule

- All numbers in this rule are read from `scripts/weekly-metrics.js` output.
- No hand-entered numbers. If the script cannot compute a metric it prints
  `NO TRACKING — <table> lacks status timestamps` (or a MISSING TABLE note)
  loudly; the report is still honest and usable.
- The script fails loudly (`UNKNOWN COLUMN — update script`) if a schema
  assumption breaks — no silent zeros, ever.

## 7. What counts as "bugs closed" when tracking is incomplete

The `bugs` table carries 943 `status='resolved'` rows but **no status-change
timestamp column** — those rows cannot be window-tagged. The script therefore
counts kanban card closures (`tasks`) as the weekly number and surfaces the
`bugs` count as an untagged cross-check note. This is the honest signal: the
finding is "closed-tracking is timestamped on the kanban board, not on the bugs
table". Never fabricate a weekly closed number from untagged rows.

## 8. Escalation

- Weekly report lands as part of the Monday planning cycle.
- Veto state is recorded in the report output (`VETO GATE ... => VETO ACTIVE`).
- Consecutive-week state is tracked by the orchestrator against the Monday
  report archive; this document records the rule, not the history.
