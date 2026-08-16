---
paths:
  - "src/services/analyzer.ts"
  - "src/services/correlation-agent.ts"
  - "src/services/orchestrator-agent.ts"
  - "src/services/brain/decision-engine.ts"
  - "src/services/model-config.ts"
  - "src/routes/model-config.ts"
  - "web-server.js"
---

## model-config — every Anthropic call site must declare its bucket

WI runs a per-bucket model + effort registry (`src/services/model-config.ts`,
schema v52). Every Anthropic call (`client.beta.promptCaching.messages.create`,
`messages.create`, `messages.stream`) must read its model + effort + thinking
config from `bucketCallParams(db, '<bucket>')` — never hard-code the model.
Without this, the user's `/setup/models` admin UI cannot control behavior of
your call site.

## The six buckets — pick the right one

| Bucket | Use when | Default model |
|---|---|---|
| `fetch` | Bulk extraction during sync (action items, summaries, Q-extract, calendar parse). High volume, structured output. | Haiku 4.5 / low |
| `digest` | Daily/weekly synthesis: digest, notebook build, member profile, morning brief. Low volume, narrative quality matters. | Sonnet 4.6 / medium |
| `chat` | UI chat panel reply (`chatWithContext`, `answerQuestion`). User-facing reasoning, one call per turn. | Opus 4.8 / high |
| `analyse` | Jira analyse + PR review (proposeSolution, reviewPR, generatePRDescription). User-clicks-button, multi-step reasoning. | Opus 4.8 / max |
| `decide` | Brain decision engine (`runDecision`). Agentic recall+cluster+verify loop with interleaved thinking. | Opus 4.8 / max |
| `agents` | Background continuous agents (correlation, orchestrator, score_severity). Cadence-sensitive classifier work. | Haiku 4.5 / low |

If your call doesn't cleanly fit one of these → STOP, ask the user, and add a
new bucket via the migration pattern (see § Adding a new bucket below).

## The pattern (verbatim, copy this)

**Inside an `AIAnalyzer` method** (which has `this.db`):
```ts
const params = bucketCallParams(this.db, 'analyse', maxTokensOverride);
const response = await this.client.beta.promptCaching.messages.create({
  ...params,                      // model, max_tokens, output_config.effort, optional thinking
  system: cachedSystem,
  tools: [...],
  tool_choice: { type: 'tool', name: '...' },
  messages,
});
this._track('myMethod', params.model, response.usage);
```

**Inside a route handler / agent / standalone function** (`db` injected explicitly):
```ts
import { bucketCallParams } from '../services/model-config.js';
const params = bucketCallParams(ctx.db, 'agents');
const response = await client.beta.promptCaching.messages.create({
  ...params,
  ...
});
```

**Per-call override** — when a specific call needs a bigger output ceiling
than the bucket's effort default (e.g. an unbounded-output skill):
```ts
const params = bucketCallParams(db, 'analyse', /* maxTokensOverride */ 64000);
```
The override wins over the bucket's `EFFORT_MAX_TOKENS[effort]` value.

## What you MUST NOT do

- ❌ `model: 'claude-opus-latest'` literal — bypasses the bucket config.
- ❌ `model: EXTRACTION_MODEL` / `DIGEST_MODEL` direct references in new code.
  Existing call sites still use these (grandfather list); new code does not.
- ❌ `thinking: { type: 'enabled', budget_tokens: 8192 }` — manual extended
  thinking is REJECTED by Opus 4.8 with HTTP 400. Only `thinking: { type:
  'adaptive' }` is supported on 4.6+ models, and `bucketCallParams` emits the
  right shape automatically.
- ❌ Calling `messages.create` from a context that doesn't have `db` access.
  If you don't have `db`, you can't call `bucketCallParams`. Either add `db`
  to your context or move the call to a place that has it.

## Adding a new bucket

If your work introduces a fundamentally new kind of Anthropic call that
doesn't fit any of the six existing buckets:

1. Add the bucket name to the `Bucket` union type in `src/services/model-config.ts`.
2. Add a `MODEL_CAPS` entry covering the recommended model + valid efforts.
3. Add a `RECOMMENDED` entry with `reason` (one sentence on why this
   recommendation) and `doc_url` (link to the Anthropic doc passage that
   backs the recommendation).
4. Update `ALL_BUCKETS` so the registry counts it.
5. Add a migration row — write a new migration that does
   `INSERT OR IGNORE INTO model_config VALUES (...)` for the new bucket so
   existing DBs pick up the seed.
6. Update `.claude/rules/model-config.md` (this file) with a row in the
   bucket table.
7. Update `web/src/pages/ModelConfigPage.tsx` so the admin UI shows the
   new row (the page reads from `/api/model-config` so it auto-includes
   the bucket; only update if the UI hard-codes a bucket order or labels).
8. Smoke § 15 already counts `buckets === 6` as a pass — bump that to
   the new count.

## Smoke gate (§ 16)

`scripts/smoke-bridge.sh` § 16 scans the codebase for `messages.create({` /
`messages.stream({` calls and asserts every one either uses
`bucketCallParams(...)` OR is on the grandfather exemption list at the top
of the script. New analyzer methods will fail § 16 if they don't read
`bucketCallParams`. To add a new exemption you need to justify it in the
PR — usually the right move is to pick a bucket and use it, not to grow
the exemption list.

## Why this matters

Without bucket discipline:
- The `/setup/models` admin UI silently can't control your call site.
- A user pinning chat to Sonnet/medium for cost reasons would be ignored.
- Cost-tracking by bucket (planned next phase) breaks.

The smoke gate is intentionally strict because this is the kind of
property that's invisible until it's broken — and at that point the
fix is "find every call site and migrate", which is much more work than
"use bucketCallParams at write time".
