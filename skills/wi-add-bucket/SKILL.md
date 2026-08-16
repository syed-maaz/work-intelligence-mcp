---
name: wi-add-bucket
description: "Guides the agent through wiring a new Anthropic API call site into the per-bucket model+effort registry (`src/services/model-config.ts`, schema v52). MUST be invoked anytime new code calls `messages.create`/`messages.stream` so the user's `/setup/models` admin UI can control behavior."
trigger_phrases:
  - "add a new anthropic call site"
  - "wire a new bucket"
  - "register model+effort for"
  - "add a new prompt bucket"
allowed-tools:
  - Read
  - Edit
  - Write
  - Bash
  - Grep
  - Glob
---

<objective>
You are about to add an Anthropic API call from new code (analyzer method, agent
tick, route handler, skill, anything that calls
`client.beta.promptCaching.messages.create` or `messages.stream`). This skill
walks you through the right way: pick the right bucket, use `bucketCallParams`,
make sure the user can configure your call site via the admin UI.

Skipping this skill means your call site silently ignores the user's `/setup/models`
config — it's the load-bearing wire-up for Tier 2 bucket configurability.
</objective>

<process>

## Step 1 — Decide which bucket your call belongs to

Read `.claude/rules/model-config.md` for the full bucket table. Quick decision:

| If your call is… | Use bucket |
|---|---|
| Bulk extraction during sync (action items, summaries, calendar parse) | `fetch` |
| Daily/weekly synthesis (digest, notebook, member profile) | `digest` |
| UI chat panel reply | `chat` |
| Jira analyse / PR review (user-clicks-button reasoning) | `analyse` |
| Brain decision engine (`runDecision`) | `decide` |
| Background continuous agent (correlation, orchestrator, alert scoring) | `agents` |

If NONE of these fit cleanly → STOP. Ask the user before adding a new
bucket. Adding a bucket has migration, UI, smoke, and doc consequences
(see § Step 4 below).

## Step 2 — Use `bucketCallParams` at the call site

```ts
// Inside an AIAnalyzer method (has this.db)
const params = bucketCallParams(this.db, 'analyse');
const response = await this.client.beta.promptCaching.messages.create({
  ...params,
  system: cachedSystem,
  tools: [...],
  tool_choice: { type: 'tool', name: '...' },
  messages,
});
this._track('myMethod', params.model, response.usage);

// Inside a route handler / agent / standalone function
import { bucketCallParams } from '../services/model-config.js';
const params = bucketCallParams(ctx.db, 'agents');
const response = await client.beta.promptCaching.messages.create({
  ...params,
  ...
});
```

The `...params` spread expands to: `model`, `max_tokens`, `output_config: {effort}`,
and (if the bucket is configured for adaptive thinking) `thinking: {type:
'adaptive'}`. You should not add any of those fields manually.

**Per-call override** (when one specific call needs a bigger output ceiling):
```ts
const params = bucketCallParams(db, 'analyse', /* maxTokensOverride */ 64000);
```

## Step 3 — Forbidden patterns — DO NOT use these

- ❌ `model: 'claude-opus-latest'` (or any string literal). Bypasses the
  bucket config; the user can never override your hard-code.
- ❌ `model: EXTRACTION_MODEL` / `DIGEST_MODEL`. Existing analyzer call
  sites use these (legacy grandfather list); new code must not.
- ❌ `thinking: { type: 'enabled', budget_tokens: 8192 }`. Manual extended
  thinking returns HTTP 400 on Opus 4.8. `bucketCallParams` emits the
  right shape (`{type: 'adaptive'}`) automatically.
- ❌ Calling `messages.create` from a context with no `db` access. Either
  add `db` to the context OR move the call to a place that already has it.

## Step 4 — Adding a NEW bucket (only if Step 1 turned up nothing)

If the user confirmed they want a new bucket:

1. **Type definition.** Add the bucket name to the `Bucket` union in
   `src/services/model-config.ts:Bucket`.

2. **Capabilities.** Add a `RECOMMENDED` entry with:
   - `model` — the recommended model (one of the three current models)
   - `effort` — the recommended effort tier
   - `thinking_mode` — `'off'` for haiku/bulk; `'adaptive'` for sonnet/opus
   - `reason` — one-sentence justification (why THIS model+effort for THIS bucket)
   - `doc_url` — link to the Anthropic doc passage that backs the recommendation

3. **Registry.** Add the bucket name to `ALL_BUCKETS` so the registry counts it.

4. **Migration.** Write a new schema migration that does:
   ```sql
   INSERT OR IGNORE INTO model_config (bucket, model, effort, thinking_mode)
   VALUES ('<new-bucket>', '<model>', '<effort>', '<thinking_mode>');
   ```
   This seeds existing DBs with the new bucket on next bridge boot. Bump
   `CURRENT_SCHEMA_VERSION`.

5. **Rule update.** Add a row to the bucket table in
   `.claude/rules/model-config.md`.

6. **Smoke gate.** Smoke § 15 asserts `buckets.length === 6`. Bump to the
   new count.

7. **UI.** `web/src/pages/ModelConfigPage.tsx` reads buckets from the API
   response, so a new bucket will auto-appear in the admin UI. No frontend
   change needed unless the UI hard-codes a bucket order or label.

## Step 5 — Verify

Run smoke § 15 to confirm the new call site is recognized:

```bash
SKIP_BRAIN_LIVE_CALL=1 npm run smoke:bridge
# § 15 checks /api/model-config returns the right bucket count and that
# POST validation rejects invalid combinations.

# § 16 (the bucket scanner — see scripts/smoke-bridge.sh) will fail loudly
# if your new call site doesn't use bucketCallParams.
```

If smoke § 16 fails on your call site, re-read § 2 and § 3 above — most
failures are "I forgot the spread `...params`" or "I left a literal
`model: '...'` in there".

## When NOT to use this skill

- Pure helper code that doesn't call Anthropic at all.
- Tests / fixtures (smoke § 16 only scans `src/services/`, `src/routes/`,
  `web-server.js` — tests are exempt).
- Migration of an existing legacy call site — those are tracked on the
  grandfather list in `scripts/smoke-bridge.sh` and migrated incrementally
  by separate commits, not by this skill.

</process>
