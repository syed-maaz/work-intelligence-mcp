---
sidebar_position: 2
title: Held-out evaluation (gold labels)
---

# Held-out evaluation (gold labels)

> Numbers on this page are **placeholders until the human runs the eval with a real
> `ANTHROPIC_API_KEY`**: `DATABASE_PATH=./data/demo.db ANTHROPIC_API_KEY=$KEY npm run demo:eval`
> (`scripts/demo-eval.mjs`). The script fills the score and the mechanical-facts table below;
> until then `0/10` means "not yet run", not "scored zero".

## Method

**Held-out, human-labeled.** We authored a small held-out set (`docs/eval/gold.json`, 10 tasks,
all in the fictional `acme/widgets` / `PROJ-###` demo domain). For each task the correct outcome
was defined **by a human, before the run** — either a tool the loop must fire
(`"tool:cypher_record_outcome"`) or a fact the final answer must contain (e.g. `"40%"`).

The loop is scored **against those gold labels, not against its own verdict row**. The loop
writes its own `verdict` to `cypher_outcomes` (via `persistOutcome`); grading the loop by that
row would be grading its own homework — a self-reported accuracy that a senior reviewer reads
as "doesn't know what a benchmark is". The gold labels are independent of the loop's
self-assessment by construction: they live in `docs/eval/gold.json`, authored separately.

Each task runs `runLoop` directly (in-process, same harness as the [loop trace](walkthroughs/loop-trace),
not the smoke harness) against the demo database. PASS = the loop's chosen tool / answer
matches the gold label. FAIL = it did not — no partial credit, no self-reporting.

## Score

<!-- score line is updated in place by scripts/demo-eval.mjs after a real run -->

**Score (held-out, human-labeled):** picked the right tool **0/10**

## Mechanical facts

Not self-scored — directly measured from the run. Safe to state without the loop's opinion.

| Metric | Value |
| --- | --- |
| Mean iterations per task | — |
| Total tool calls (all tasks) | — |
| Total tokens (input/output/cache-read/cache-write) | — |
| Est. API cost (USD, per analyzer.ts pricing) | — |

## Failure analysis

Honest misses beat a shiny percentage. After the run, list every FAIL here: the goal, the gold
label, what the loop actually did, and the likely cause. A miss where the model picked a
different-but-reasonable tool is a **coverage limitation of the label set**, not necessarily a
loop bug — say so. A miss where the loop hallucinated or stopped early is a **loop defect** —
flag it for triage.

### Misses (filled after the run)

| # | Goal | Gold label | Loop's actual choice | Likely cause | Verdict |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — |

### Known limitations of this eval

- **Small set** — 10 tasks is a smoke-sized benchmark, not a statistical claim. Directional
  signal only.
- **Demo-domain only** — every task is answerable from the fictional `acme/widgets` seed
  corpus; real-domain behavior is out of scope for this page.
- **Substring matching for answer labels** — a PASS means the gold fact appears in the final
  surface; wording quality, citations, and wrong-but-plausible context are not scored.
- **Non-determinism** — model sampling makes a rerun non-identical; the score reflects one run.

## How to reproduce

```bash
npm run demo                     # seed ./data/demo.db with the fictional corpus
DATABASE_PATH=./data/demo.db ANTHROPIC_API_KEY=$KEY npm run demo:eval
```

## Related

- [`docs/eval/gold.json`](../../eval/gold.json) — the held-out label set
- [`scripts/demo-eval.mjs`](../../scripts/demo-eval.mjs) — the runner
- [Cypher loop trace — demo run](walkthroughs/loop-trace) — the annotated per-turn trace the
  same harness produces