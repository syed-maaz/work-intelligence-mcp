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

**Score (held-out, human-labeled):** picked the right tool **9/10** (latest run)

> **Run variance, stated up front:** two consecutive runs scored **7/10** and **9/10** on the
> same task set. The loop samples — reruns are not identical. Treat this as a directional
> existence proof, not a benchmark number.

## Mechanical facts

Not self-scored — directly measured from the run. Safe to state without the loop's opinion.

| Metric | Value |
| --- | --- |
| Mean iterations per task | 6.9 |
| Total tool calls (all tasks) | 69 |
| Total tokens (input/output/cache-read/cache-write) | 49078/18535/572036/1976 |
| Est. API cost (USD, per analyzer.ts pricing) | 1.0071 |

## Failure analysis

Honest misses beat a shiny percentage. After the run, list every FAIL here: the goal, the gold
label, what the loop actually did, and the likely cause. A miss where the model picked a
different-but-reasonable tool is a **coverage limitation of the label set**, not necessarily a
loop bug — say so. A miss where the loop hallucinated or stopped early is a **loop defect** —
flag it for triage.

### Misses (filled after the run)

| # | Goal | Gold label | Loop's actual choice | Likely cause | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | Who owns the widget dashboard migration tracked in PROJ-103 on acme/widgets? | `alex` | "I can't give you an owner — I can't confirm the thing exists"; search returns the corpus row but surfaces content, not message authorship | The gold label requires inferring **owner = message author**; the search tool returns content snippets and the loop doesn't attribute authorship to ownership. Present in BOTH runs. | Loop limitation (attribution gap), label arguably strict |
| 2 | Who drafted the rollback plan for the acme/widgets v2 release? | `cara` | "couldn't definitively identify who drafted the rollback plan" | Same attribution gap: the corpus line is passive ("rollback plan ... drafted"); author `cara` never appears in searchable content. Observed in the 7/10 run. | Loop limitation (same class) |

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