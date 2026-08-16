# BugInvestigatorAgent — Architecture (Phase B)

**Status:** Phase B shipped 2026-05-31 (Phase 75 / milestone v1.2)
**Source ADR:** [ADR-030 — Self-Healing Bug Loop](../adr/adr-030-self-healing-bug-loop.md) § Phase B
**Source files:** `src/intelligence/bug-investigator-agent.ts`, `src/services/bugs/evidence.ts`
**Depends on:** schema v54, `src/routes/bugs.ts` (Phase A), `src/services/brain/decision-engine.ts`, ADR-027 v2 blast-radius query, MemPalace recall
**Scope fence:** Triage only — no PR generation (Phase C), no auto-merge (Phase D)

## What this agent does

`BugInvestigatorAgent` is the first AI in the bug loop. It polls the `bugs` table for `status='new'` rows that aren't its own self-noise, gathers structured evidence (stack frame → git log → ADR-027 v2 blast-radius → brain recall of similar past investigations), calls the brain's `runDecision()` through a dedicated `bug-investigator` brain-budget bucket, and writes a structured `bug_investigations` row + flips `bugs.status` to `'proposed'`. The user opens `/bugs`, clicks a row, and sees a real Investigation tab with root cause, files-to-change, confidence, and a collapsed suggested patch.

Phase B does not generate or open a PR. It only writes investigations.

## The polling SELECT (with the recursion guard called out)

`tick()` runs every `BUG_INVESTIGATOR_INTERVAL_MS` (default `300000` = 5 min):

```sql
SELECT * FROM bugs
 WHERE status = 'new'
   AND source != 'bug-investigator'   -- recursion guard (Phase A schema CHECK)
   AND investigation_attempts < 3     -- attempt cap
 ORDER BY severity DESC, last_seen_at DESC
 LIMIT 1
```

The recursion guard relies on Phase A having seeded the `bug-investigator` value into the `bugs.source` CHECK enum. If the agent itself throws and `withAgentTick` captures the bug, the row will have `source='bug-investigator'` and the next poll will skip it — no schema change needed.

The agent picks one bug per tick. Concurrency-of-one is intentional: the brain budget is small (`BUG_INVESTIGATOR_MAX_PER_HOUR=10`), and serializing keeps the budget ledger query simple.

## State machine

```
                       ┌────────────┐
              ┌────────│   'new'    │◀──────────┐
              │        └────────────┘           │
              │              │ pick             │ (re-investigate
              │              ▼                  │  endpoint resets
              │     increment attempts          │  status + clears
              │     ┌────────────────┐          │  last_investigation_id)
              │     │ 'investigating'│          │
              │     └────────────────┘          │
              │              │                  │
              │   ┌──────────┴──────────┐       │
              │   │                     │       │
              │   ▼ brain ok            ▼ brain throw
              │ ┌──────────┐         ┌─────────────────┐
              │ │'proposed'│         │ attempts < 3 ?  │
              │ └──────────┘         └─────────────────┘
              │                            │ yes  │ no
              │                            │      ▼
              │                            │  ┌──────────┐
              │                            │  │'wont-fix'│
              │                            │  └──────────┘
              │                            ▼
              └────────────────────────────┘   reset to 'new' for next tick
```

`investigation_attempts` increments **before** the brain call so a brain crash that wedges retries can't loop forever — we always burn one attempt per call, even for failures.

`bugs.last_investigation_id` is updated atomically with the `bug_investigations` insert (single transaction).

## Evidence sources

Source: `src/services/bugs/evidence.ts::gatherEvidence(args)`. Best-effort: every source is wrapped in try/catch and any failure returns `null` / `[]`. The agent must still be able to call the brain even if every external source is offline.

| Source | Type | What it produces | Failure mode |
|---|---|---|---|
| Stack | `string \| null` | Top 20 lines of `bug.stack` | `null` if no stack |
| Top frame | `string \| null` | Mirrors `bug.top_frame` for the brain prompt | `null` if no app frame |
| Git log | `BugGitLogEntry[]` | `git log --follow --max-count=10` on the file extracted from `top_frame` | `[]` on any git/fs error |
| Blast radius | `BugBlastRadius \| null` | `GET /api/code-graph/blast-radius?repo=…&file=…` (ADR-027 v2) | `null` if HTTP fails |
| Recall | `BugRecallHit[]` | Top 5 brain-recall hits across palace + decisions + cluster, deduped, ranked by score | `[]` if palace disabled |

The merged `BugEvidence` blob feeds into `buildPrompt(bug, evidence)` which produces the user-facing prompt for the `propose_investigation` tool call.

## Brain budget — the `bug-investigator` bucket

Schema v54 added a new row to `model_config`:

```sql
INSERT OR IGNORE INTO model_config (bucket, model, effort, thinking_mode)
  VALUES ('bug-investigator', 'claude-opus-4-8', 'max', 'adaptive');
```

Defaults match the `decide` bucket because the work shape is identical: multi-step structured output with `propose_investigation` returning `{root_cause, files_to_change, lines_changed, confidence, suggested_patch}`. Quality + reliability matter more than cost — failure cascades into the `investigation_attempts` retry loop.

Per-hour cap: `BUG_INVESTIGATOR_MAX_PER_HOUR=10` (default). The agent queries `brain_user_budget_ledger WHERE bucket='bug-investigator' AND created_at > now-1h` and skips its tick when the cap is reached. Per-hour, not per-day, so a wedged retry storm can't burn the entire daily budget in 90 seconds.

The agent calls the brain via `createBucketAwareDecideFn(client, db, bucketCallParams)` — same factory used by every other always-on agent. The bucket parameters are spread into the `messages.create` call so manual model overrides via the `/setup/models` admin UI take effect on the next tick.

## Killswitch + boot pattern

The bridge boot block in `web-server.js` gates registration on `BUG_INVESTIGATOR_ENABLED`:

```ts
if (process.env.BUG_INVESTIGATOR_ENABLED !== '0') {
  if (!analyzer) {
    console.warn('[Bugs] BugInvestigatorAgent skipped — no Anthropic API key');
  } else {
    const agent = new BugInvestigatorAgent(...);
    // setTimeout(30s) for first tick; setInterval(intervalMs) thereafter
  }
} else {
  console.warn('[Bugs] BugInvestigatorAgent disabled via BUG_INVESTIGATOR_ENABLED=0');
}
```

`BUG_INVESTIGATOR_ENABLED=0` skips registration entirely — the agent is absent from `/api/agents/health`, not just `'disabled'`. Verified by `scripts/smoke-bug-killswitch.sh` (port `:3134`, fresh DB).

## Failure modes

The 12 test scenarios from `tests/intelligence/bug-investigator-agent.test.ts`, with the user-visible behaviour they cover:

| Scenario | Behaviour |
|---|---|
| No bugs match the SELECT | Tick is a no-op; no DB writes |
| Bug picked, brain returns valid output | `bug_investigations` row written; `bugs.status='proposed'`; `last_investigation_id` updated |
| Bug picked, brain throws | `investigation_attempts` already incremented; row resets to `status='new'` for next tick |
| Brain throws on attempt 3 | Row flips to `status='wont-fix'` — investigator gives up |
| Recursion: agent's own throw is captured | Next tick skips the row (`source='bug-investigator'` filter) |
| Brain budget exhausted (per-hour) | Tick skipped; warning logged; next tick re-evaluates the cap |
| Evidence gather: git log fails | Empty array; brain still called |
| Evidence gather: blast-radius HTTP 500 | `null`; brain still called |
| Evidence gather: palace disabled | Empty recall; brain still called |
| `top_frame` is null (library-only stack) | No file inferred; git log + blast-radius skipped; brain receives `topFrame: null` |
| `BUG_INVESTIGATOR_ENABLED=0` | Agent never registers |
| `analyzer` is null (no API key) | Agent skipped at boot with stderr warning |

## Operational tuning

| Knob | Default | When to change |
|---|---|---|
| `BUG_INVESTIGATOR_INTERVAL_MS` | `300000` (5 min) | Lower to `60000` in dev to see ticks faster; raise to `1800000` once tuning settles in production |
| `BUG_INVESTIGATOR_MAX_PER_HOUR` | `10` | Lower if budget incidents surface; raise after a sprint of clean signal |
| `BUG_INVESTIGATOR_ENABLED` | `1` | `0` to disable the agent globally without restarting the bridge against a different binary |
| `model_config.bug-investigator.model` | `claude-opus-4-8` | Override via `/setup/models` to test cheaper models |
| `model_config.bug-investigator.effort` | `max` | Lower if the brain consistently produces low-confidence patches |

Severity ordering in the polling SELECT means high-severity bugs get triaged first — useful when a crash-loop captures 50 occurrences of one bug while 3 distinct medium-severity bugs sit waiting.

## References

- [ADR-030 — Self-Healing Bug Loop](../adr/adr-030-self-healing-bug-loop.md) § Phase B
- [Self-Healing Bug Loop — Architecture](./self-healing-bug-loop.md) — Phase A foundation
- [Bugs API reference](../api-reference/bugs.md) — endpoint shapes including `POST /api/bugs/:id/reinvestigate`
- [Bugs page UI reference](../web-ui/bugs-page.md) — `/bugs` page Investigation tab
- [database-schema.md § v54](./database-schema.md#self-healing-bug-capture-v53) — schema v54 (`bugs.last_investigation_id` column + `bug-investigator` bucket)
- `.planning/phases/75-adr-030-phase-b-bug-investigator/PLAN.md` — full plan + acceptance criteria
- `memory/project_adr030_phase_b.md` — auto-memory; commit list + lessons
