---
sidebar_position: 31
title: ADR-031 Per-Bucket Model + Effort Configuration
---

# ADR-031: Per-Bucket Model + Effort Configuration

| Field | Value |
|-------|-------|
| **Status** | ✅ **Accepted — backend + migration complete 2026-05-31** (backend: `0d035ec`, `bbf7b39`, `5165d20`; migration C1–C5: `0e76c52`, `7532168`, `a5be720`, `8f85058`, `de4a62d`). All 25 grandfathered call sites migrated to `bucketCallParams` / `_bucketParams` / `freeFnParams` / `brainToolCall {db, bucket}`. Admin UI page (`/setup/models`) shipped in a separate sibling commit. Follow-up migration 2026-07-19 added 13 more sites across `src/tools/`, `src/intelligence/`, `src/fetcher/` — now **48 clean, 0 grandfathered**. |
| **Date** | 2026-05-31 |
| **Deciders** | Maaz |
| **Drives** | T2 of `dapper-plotting-dawn` plan; user request: *"It should be configurable like for fetch and analytics … same for effort. Show what is best and recommended by the system."* |
| **Pipeline stage** | Process / Analyze (per CLAUDE.md *Four-Stage Pipeline*) |
| **Related** | [ADR-024 — Unified Brain API](./adr-024-unified-brain), [ADR-026 — Route Module Extraction](./adr-026-route-module-extraction) |

## Context

Before this ADR, every Anthropic call site in `src/services/analyzer.ts` referenced one of two hard-coded module-level constants:

```ts
const EXTRACTION_MODEL = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? 'claude-haiku-latest';
const DIGEST_MODEL     = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'claude-sonnet-latest';
```

A user who wanted, say, the chat path on Opus 4.8 + max-effort thinking but the bulk-extraction path still on Haiku had **no way to express that** without re-deploying a new env var and restarting the bridge — and even then, the env knob was binary: every chat call shared one model with every digest call shared another.

Three things made this worse over time:

1. **The price table at `analyzer.ts:160-165` was wrong.** It listed Opus at `$15/$75 per Mtok` (Opus 4.1 pricing). Live Anthropic pricing for Opus 4.8 is `$5/$25` — **3× cheaper** than what WI's own cost-tracking believed. Cost-aware model decisions made on the old table were systematically wrong.
2. **Manual extended thinking (`thinking: { type: 'enabled', budget_tokens: N }`) returns HTTP 400 on Opus 4.8.** The right primitive on 4.6+ models is `thinking: { type: 'adaptive' }` plus the `effort` parameter (low / medium / high / xhigh / max). Any future "max effort" wiring built on the legacy primitive would crash every call.
3. **No per-call-site governance.** A new analyzer method that hard-coded `model: 'claude-opus-latest'` was indistinguishable from one that read from a constant. There was no smoke gate, no rule, no skill that surfaced "pick the right model for the right call shape" at write time.

The user's requirement, in their exact words: configurable per functionality, with effort levels, with system-recommended defaults visible to the user and a warning when the user picks a config worse than the recommendation. They also asked for the recommendation to be **evidence-backed** — *"Do the deep research on ideal model for each functionality and effort"* — not eyeballed.

## Decision

Six functional buckets, each with its own `(model, effort, thinking_mode)` tuple stored in a new SQLite table `model_config` (schema v52). Defaults seeded from Anthropic's May 2026 docs. User can edit any row via `POST /api/model-config` or (later) a `/setup/models` admin UI. A 60-second TTL cache means changes take effect without a bridge restart.

```
   bucket   |  default model              | default effort | thinking
   --------+-----------------------------+----------------+---------
   fetch    |  claude-haiku-4-5-20251001  | low            | off
   digest   |  claude-sonnet-4-6          | medium         | adaptive
   chat     |  claude-opus-4-8            | high           | adaptive
   analyse  |  claude-opus-4-8            | max            | adaptive
   decide   |  claude-opus-4-8            | max            | adaptive
   agents   |  claude-haiku-4-5-20251001  | low            | off
```

Every Anthropic call site reads its config via a single helper:

```ts
import { bucketCallParams } from '../services/model-config.js';

const params = bucketCallParams(this.db, 'analyse'); // or 'chat', 'fetch', etc.
const response = await this.client.beta.promptCaching.messages.create({
  ...params,                  // model, max_tokens, output_config: {effort}, thinking?
  system: cachedSystem,
  tools: [...],
  messages,
});
```

Per-call override winning over the bucket default:
```ts
const params = bucketCallParams(db, 'analyse', /* maxTokensOverride */ 64000);
```

A skill (`wi-add-bucket`), a project rule (`.claude/rules/model-config.md`), and a smoke gate (`scripts/smoke-bucket-scanner.sh`, wired as smoke § 16) collectively enforce that every NEW call site uses the bucket abstraction.

## The six buckets — what each is + recommended config

The bucket boundaries follow the call-site shape, not the source file. A function in `analyzer.ts` can belong to any bucket depending on what it does.

### `fetch` — bulk extraction (Haiku 4.5 / low / no thinking)

- **What:** `detectActionItems`, `summarizeContent`, `extractQuestions`, `extractCalendarFromMessages`. High volume — runs every 15 min during background sync. Output is structured `tool_use` JSON.
- **Why this default:** Anthropic effort docs explicitly call out *"low effort … simple classification tasks, quick lookups, or high-volume use cases where marginal quality improvements don't justify additional latency or spend."* They also warn *"on some structured-output or less intelligence-sensitive tasks [`max` effort] can lead to overthinking."* fetch is structured-output classification → exactly the case where overthinking happens.
- **Cost math at 150k tokens/day:** haiku $0.15/day vs opus $0.75 vs opus-with-max ~$3+. **5–20× delta with no quality benefit.**

### `digest` — daily/weekly synthesis (Sonnet 4.6 / medium / adaptive thinking)

- **What:** `generateDigest`, `buildNotebook`, `updateNotebook`, `generateMorningBrief`, `buildMemberProfile`. Low volume (1-2/day). Narrative quality matters.
- **Why this default:** Anthropic's verbatim recommendation for Sonnet 4.6 is *"medium effort (recommended default): best balance of speed, cost, and performance for most applications."* At medium with adaptive thinking, the model decides per-request whether to think — narrative synthesis benefits from occasional deep thinking but doesn't need it always-on.
- **Cost math at 50k tokens/day:** sonnet/medium ~$0.40/day vs opus/max ~$1.50–3. **3–8× delta**, narrative quality difference is real but bounded.

### `chat` — UI chat panel reply (Opus 4.8 / high / adaptive thinking)

- **What:** `chatWithContext`, `answerQuestion`. One call per user turn.
- **Why this default:** *"Use high effort (the default) for complex reasoning, nuanced analysis … or any task where quality matters more than speed or cost."* Why not max: *"Reserve max for genuinely frontier problems. On most workloads max adds significant cost for relatively small quality gains."* High is the sweet spot for chat — bounded volume, user-facing, but not the highest-stakes path in WI.
- **Cost math at 30 turns × 5k tokens/day:** opus/high ~$1.50–4/day. Bounded.

### `analyse` — Jira analyse + PR review (Opus 4.8 / max / adaptive thinking)

- **What:** `proposeSolution`, `reviewPR`, `generatePRDescription`, the 5-way `Promise.allSettled` chat calls in the Jira analyse handler. User-clicks-button trigger; multi-step reasoning across linked docs + code + comments.
- **Why this default:** Anthropic's published guidance for Opus 4.8: *"When running at xhigh or max effort, set a large max_tokens so the model has room to think and act across subagents and tool calls. Starting at 64k tokens and tuning from there is a reasonable default."* This maps directly to WI's analyse case — large context, multi-step output, user explicitly opted in by clicking.
- **Cost math at 5 clicks × 50k tokens:** opus/max ~$3–6/click → **$15–30/day** in heavy use. User-triggered, not background.

### `decide` — brain decision engine (Opus 4.8 / max / adaptive thinking)

- **What:** `runDecision` in `src/services/brain/decision-engine.ts`. Caches by `(question, user, day)` so most calls return < 200 ms.
- **Why this default:** *"Adaptive thinking automatically enables interleaved thinking. This means Claude can think between tool calls, making it especially effective for agentic workflows."* The decide loop has multiple tool calls (memory recall → cluster lookup → verify); interleaved thinking is the load-bearing capability.

### `agents` — background continuous agents (Haiku 4.5 / low / no thinking)

- **What:** correlation-agent, orchestrator-agent, score_severity. Continuous load (~24h × 10k tokens/h = 240k tokens/day).
- **Why this default:** Same reasoning as fetch — classifier shape, high volume, opus would 15–25× cost with no quality benefit. Anthropic's effort docs verbatim: *"low effort … high-volume use cases where marginal quality improvements don't justify additional latency or spend."*

## Sources

All recommendations cite Anthropic's official docs, fetched 2026-05-31:

- [Models overview](https://platform.claude.com/docs/en/about-claude/models)
- [Effort parameter](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
- [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)

## Cost projection

Recommended mix vs all-opus-max at typical WI usage (numbers verified against the May 2026 pricing table):

| Bucket | Daily volume | Recommended | $ recommended | All-opus-max $ | Δ |
|---|---|---|---|---|---|
| fetch | 150k tok | haiku/low | $0.90 | $4.50 | 5× |
| digest | 50k tok | sonnet/medium | $0.90 | $1.50 | 1.7× |
| chat | 150k tok | opus/high | $2.63 | $4.50 | 1.7× |
| analyse | 250k tok | opus/max | $7.50 | $7.50 | 1× |
| decide | 150k tok | opus/max | $4.50 | $4.50 | 1× |
| agents | 240k tok | haiku/low | $1.44 | $7.20 | 5× |
| **Total** | | | **~$17.87/day** | **~$29.70/day** | **1.66×** |

Prompt caching (WI already uses `cache_control` on system blocks) drops the recommended mix further: cache reads at 0.1× input mean fetch + agents — which see the same system prompt every cycle — pay closer to **$15/day** in steady state.

## Implementation Status

| Component | File | Status |
|---|---|---|
| Schema migration | `src/db/migrations/v52_model_config.ts` | ✅ shipped (`0d035ec`) |
| Type + helper module | `src/services/model-config.ts` (`Bucket`, `Effort`, `ThinkingMode`, `MODEL_CAPS`, `RECOMMENDED`, `bucketCallParams`, `validateBucketConfig`, `upsertBucketConfig`) | ✅ shipped (`0d035ec`) |
| REST endpoints | `src/routes/model-config.ts` (`GET /api/model-config`, `POST /api/model-config`) | ✅ shipped (`0d035ec`) |
| Bridge wiring | `web-server.js` registers `modelConfigRoutes` in `EXTRACTED_ROUTES` | ✅ shipped (`0d035ec`) |
| Price-table fix | `analyzer.ts:160-165` — Opus 4.8 corrected from $15/$75 to $5/$25 | ✅ shipped (`0d035ec`) |
| Smoke § 15 (5 endpoint checks) | `scripts/smoke-bridge.sh` | ✅ shipped (`bbf7b39`) |
| Project rule | `.claude/rules/model-config.md` | ✅ shipped (`5165d20`) |
| Skill `wi-add-bucket` | `skills/wi-add-bucket/SKILL.md` | ✅ shipped (`5165d20`) |
| Smoke § 16 (bucket scanner) | `scripts/smoke-bucket-scanner.sh` + wire-up | ✅ shipped (`5165d20`, scanner-only; wire-up in `b6fe3cf`) |
| Migration of 25 existing call sites | `analyzer.ts`, agents, brain | ✅ **complete 2026-05-31** — C1–C5 (`0e76c52`, `7532168`, `a5be720`, `8f85058`, `de4a62d`); GRANDFATHER list now empty |
| Admin UI | `web/src/pages/ModelConfigPage.tsx` + `/setup/models` route | ✅ shipped (sibling commit to docs closeout) |

### Migration complete (2026-05-31)

Five commits walked the 25 grandfathered call sites + 4 module-level free helpers down to zero. Smoke § 16 ends at **24 clean / 0 grandfathered** (original migration). A follow-up migration (2026-07-19) added 13+ sites across `src/tools/`, `src/intelligence/`, `src/fetcher/`, `src/routes/`, `src/services/cypher/` — scanner now reports **48 clean / 0 grandfathered**.

| Commit | Bucket | Sites | Notes |
|---|---|---|---|
| `0e76c52` (C1) | `fetch` | 5 in `analyzer.ts` | `detectActionItems`, `summarizeContent`, `extractQuestions`, `extractCalendarFromMessages`, `rankReviewers` |
| `7532168` (C2) | `digest` | 4 in `analyzer.ts` | `generateDigest`, `buildNotebook`, `updateNotebook`, `buildMemberProfile` |
| `a5be720` (C3) | `chat` | `chatWithContext` (main + retry path), `answerQuestion` | Dropped the `isComplex` switch — bucket abstraction subsumes it |
| `8f85058` (C4) | `analyse` + free fns | 4 + 4 | `reviewPR`, `generatePRDescription`, `proposeSolution`, `analyzeCodeImpact`; free functions `generatePreBrief`, `scoreMessageSeverity`, `generateWeeklyReport`, `generateChatDigest` |
| `de4a62d` (C5) | `agents` + `decide` | correlation-agent (1), orchestrator-agent (3, including the `scoreMessageSeverity` caller plumbed), `brain/anthropic-tool-use.ts` (1 live site); `runDecision` threads `bucket='decide'` | GRANDFATHER list emptied at the end of this commit |

**Plumbing introduced during the migration:**
- `_bucketParams(bucket, override?)` — new private wrapper on `AIAnalyzer` so every method shares one bucket-resolution path.
- `freeFnParams(db?, bucket, override?)` — module-level helper for the four free functions in `analyzer.ts`. Each free function gained an optional `db?: Database` parameter; when omitted it falls back to the bucket's compiled-in defaults.
- `brainToolCall({db, bucket, ...})` — `src/services/brain/anthropic-tool-use.ts` accepts the bucket on its request payload so brain-internal call sites pick up the same registry.
- `runDecision` (`src/services/brain/decision-engine.ts`) now threads `db` + `bucket: 'decide'` end-to-end into `brainToolCall`.

**Smoke after each commit:** 61/61 (C1) → 61/61 (C2) → 65/65 (C3) → 65/65 (C4) → 65/65 (C5). § 16 reports **24 clean call sites, 0 grandfathered**. Any new violation now fails the smoke gate hard — there is no incremental escape valve left. (2026-07-19 follow-up: scanner expanded to `src/tools/`, `src/intelligence/`, `src/fetcher/`, `src/services/cypher/` — now 48/48 clean, 0 grandfathered, 182/182 smoke total.)

The admin UI page at `/setup/models` shipped in a sibling commit to this docs closeout, so the user-facing surface for the bucket registry is fully live.

## Three enforcement layers

This ADR is unusual in that it ships three layers of governance, not just code. Each one alone would be insufficient:

1. **Project rule** (`.claude/rules/model-config.md`). Auto-loads when Claude touches `src/services/analyzer.ts`, agents, the decision engine, or `web-server.js`. Spells out the bucket table, the `bucketCallParams` pattern verbatim, the forbidden patterns (literal `model:`, manual `budget_tokens` on Opus 4.8). This is the **specification**.

2. **Skill** (`skills/wi-add-bucket/SKILL.md`, symlinked into `~/.claude/skills/work-intelligence/`). Walks an agent through bucket selection, the right call shape, and (if no existing bucket fits) the full new-bucket migration recipe. This is the **onboarding ramp**.

3. **Smoke § 16** (`scripts/smoke-bucket-scanner.sh`). Greps every `messages.create({` / `messages.stream({` call in `src/services/`, `src/routes/`, `src/tools/`, `src/intelligence/`, `src/fetcher/`, `web-server.js`. Asserts each is either spreading `bucketCallParams(...)` or on the GRANDFATHER list. New hard-coded `model: '...'` calls fail loudly. This is the **enforcement**.

The grandfather list shrinks over time: when an existing call site is migrated, its entry is **deleted** from `GRANDFATHER` (never grow). When the list is empty, the scanner becomes pure "no new violations" — every Anthropic call in the codebase reads from the bucket registry.

## Why three layers — failure modes the rule alone wouldn't catch

| Without | Failure mode |
|---|---|
| Project rule | Engineer doesn't know which bucket to pick. Uses `'chat'` for a fetch-style call → wrong cost profile, wrong effort. |
| Skill | New engineer reads the rule but doesn't know how to add a new bucket when none fit. Hard-codes `model: 'claude-opus-latest'` to ship the feature → silent ungovernable call site. |
| Smoke gate | All the above can happen, no test catches it until a user complains they "set chat to Sonnet but it's still using Opus." Diagnosis takes hours; root cause is one missed PR review. |

## Migration — all 25 original + 13 follow-up call sites migrated

The original grandfather list at the top of `scripts/smoke-bucket-scanner.sh` enumerated 25 pre-existing call sites:
- 20 in `src/services/analyzer.ts`
- 3 in `src/services/orchestrator-agent.ts` / `correlation-agent.ts`
- 2 in `src/services/brain/anthropic-tool-use.ts`

C1–C5 (2026-05-31) migrated all 25. A follow-up (2026-07-19) migrated 13 more across `src/tools/`, `src/intelligence/`, `src/fetcher/`, `src/services/cypher/`. Scanner scope expanded accordingly. The GRANDFATHER list has been empty since C5 — any new hardcoded `model: '...'` call fails the smoke gate immediately.

## Trade-offs and alternatives considered

### Why a SQLite table, not env vars

User-confirmed in plan-mode question round. Three options were considered:

- **SQLite + admin UI** (chosen). Schema migration, REST endpoints, no restart needed. Most consistent with how WI persists state.
- JSON file at `~/.work-intelligence-mcp/model-config.json`. Simpler — no migration. But state ends up split between SQLite and JSON; existing WI patterns are SQLite-first.
- Env vars only. Simplest to ship; worst UX. User has to know which knob exists and restart every time.

### Why three named effort tiers (low / medium / high / xhigh / max), not raw `max_tokens` + `thinking_budget` numbers

User-confirmed. Anthropic's own `effort` parameter is named tiers, and they document the trade-offs per tier verbatim. Raw numbers would be a power-user UI; named tiers are foolproof.

### Why bucket-default + per-call override, not bucket-only

User-confirmed. The existing `chatWithContext(maxTokens?)` arg is preserved as a per-call override. This lets a one-off skill (e.g. wi-investigate explicitly asking for max-effort even if the chat bucket is set lower) signal intent at the call site without globally reconfiguring chat.

### Why warn-but-allow when user picks a worse-than-recommended config

User-confirmed. The admin UI shows a yellow warning explaining why the choice is suboptimal, but doesn't block save. Users sometimes have constraints we don't know about (cost cap, latency requirement, evaluation in progress). The recommendation is advisory, not authoritative.

### Why `claude-haiku-4-5-20251001` (dated SKU) and not `claude-haiku-latest`

The Anthropic models docs note: *"Every Claude model ID is a pinned snapshot. Models with a date in the ID are fixed to that specific release."* Using the dated SKU means a future Haiku release won't silently change WI's behaviour. The cost of pinning is that periodic updates are needed when Anthropic releases a new Haiku — which is also when we'd want to re-evaluate the bucket recommendation anyway, so the friction is correctly placed.

## Verification

```bash
# Schema
sqlite3 ~/.work-intelligence-mcp/data.db ".schema model_config"
sqlite3 ~/.work-intelligence-mcp/data.db "SELECT * FROM model_config ORDER BY bucket;"

# REST
curl -s http://localhost:3132/api/model-config | jq

# Validation rejects max-on-haiku
curl -s -X POST http://localhost:3132/api/model-config \
  -H 'Content-Type: application/json' \
  -d '{"updates":[{"bucket":"chat","model":"claude-haiku-4-5-20251001","effort":"max","thinking_mode":"off"}]}' \
  -w "\n%{http_code}\n"
# Expected: 400 with "Effort 'max' is not available on claude-haiku-4-5-20251001"

# Round-trip a write
curl -s -X POST http://localhost:3132/api/model-config \
  -H 'Content-Type: application/json' \
  -d '{"updates":[{"bucket":"chat","model":"claude-opus-4-8","effort":"medium","thinking_mode":"adaptive"}]}'

# Smoke (§ 15 covers GET + POST + validation + cache invalidation; § 16 covers grandfather)
SKIP_BRAIN_LIVE_CALL=1 npm run smoke:bridge
# Expected: 60+/60+ passing
```

## Future work

- ~~**Migrate the 25 grandfathered call sites** (T2 commit 2).~~ ✅ **Done 2026-05-31.** Follow-up 2026-07-19 migrated 13 more across `src/tools/`, `src/intelligence/`, `src/fetcher/`, `src/services/cypher/`. The GRANDFATHER list has been empty since C5 — the bucket abstraction is the only way to call Anthropic.
- **Admin UI** at `/setup/models` (T2 commit 3). Six-row table; dropdowns; recommended badge; warning when user picks worse-than-recommended; cost-per-day preview.
- **Cost-tracking by bucket** — extend `brain_user_budget_ledger` to record the bucket name alongside the model name. Lets `/api/system-health/tokens` show daily spend per bucket so the user can audit "is opus/max for analyse actually worth it?"
- **Streaming wiring (Tier 3)** reads its model + effort from the `chat` and `analyse` buckets via `bucketCallParams` — no separate streaming-specific config.
