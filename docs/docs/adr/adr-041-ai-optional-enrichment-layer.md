---
title: "ADR-041: AI as Optional Enrichment Layer over Deterministic Data"
sidebar_label: "ADR-041: AI Enrichment Layer"
status: Proposed
date: 2026-07-06
---

# ADR-041: AI as Optional Enrichment Layer over Deterministic Data

> ⚠️ **MISCATEGORIZED (2026-07-15) — this is a BUG, not an architectural decision.**
> This ADR opens with an incident (a 502 error string rendered as Daily Summary content for ~1h) plus a fix — that's a bug report, not a "why we chose X over Y" decision. It never had a decision lifecycle, so it sat "Proposed" indefinitely. Now tracked as a board bug card **`tsk_676dfa687998`** on `/board`. Kept here for history; do not advance its ADR status. See the decision-vs-build/fix triage rule in `.claude/rules/adr-vs-ticket.md`.

## Status

**Proposed** — 2026-07-06.

Not yet Substrate Accepted; not yet Accepted. Awaiting spike branch + outcome AC verification.

## Context

On 2026-07-06 05:46 UTC the dashboard's Daily Summary rendered:

> _(AI summary unavailable: 502 Network error: you are offline or connection may have changed or been interrupted)_

The user saw this for ~1 hour before flagging it. Investigation revealed **three compounding failure modes** in the AI-generating tool stack (`src/tools/daily-summary.ts`, `src/tools/teams-updates.ts`, `src/tools/search-all.ts`):

### Failure mode 1 — Errors returned as content

Each of the three tools has this shape:

```typescript
async function generateSummaryWithClaude(...): Promise<string> {
  try {
    const response = await withRetry(() => client.beta.promptCaching.messages.create({...}));
    return response.content.find(b => b.type === 'text')?.text ?? '';
  } catch (err) {
    return `(AI summary unavailable: ${err instanceof Error ? err.message : String(err)})`;
  }
}
```

The error string is **structurally indistinguishable from valid AI output** — same type (`string`), same call site, same downstream handling. Callers cannot detect the failure without regex-matching the error prefix. This is the "in-band signaling" anti-pattern.

### Failure mode 2 — Error strings get cached


The user's manual "Refresh" button also hit the same cache path (unless `opts.refresh: true` is passed, which the current UI does not always do).

### Failure mode 3 — No deterministic fallback surface

`formatMarkdown` already contains a fallback branch (line 249, `if (aiSummary) ... else { plain rendering }`) that renders message-counts-by-source + full action-item checklist without AI. On 502 errors this branch is **never reached** because the AI helper returns a truthy string (`"(AI summary unavailable: …)"`), so `if (aiSummary)` evaluates true and we render the error instead of the perfectly-usable fallback.

The user has strictly less information after AI failure than they would have with no AI at all.



### Blast radius

Same anti-pattern present in three tools today:

| File | Line | Same three failure modes? |
|---|---|---|
| `src/tools/daily-summary.ts` | 226 | Yes — errors-as-content + caching + no fallback surface |
| `src/tools/teams-updates.ts` | 262 | Modes 1 + 3 (no caching layer in this tool) |
| `src/tools/search-all.ts` | 276 | Modes 1 + 3 (no caching layer in this tool) |

The pattern is likely to spread to future tools (`get_daily_digest`, `wi_digest`, `wi_teams`) that follow the same conventions unless the design principle is codified.

## Decision

**AI is an optional enrichment layer over deterministic data, never a hard dependency.**

Every WI tool that generates user-facing content will follow this three-tier contract:

### Tier 1 — Deterministic data ALWAYS renders

The endpoint's substrate (messages, action items, search hits, meetings, PRs) comes from SQLite and is guaranteed present as long as the DB is up. This tier renders regardless of AI availability. It uses tables and lists, not narrative prose.

### Tier 2 — AI adds interpretation ON TOP

When AI is available, the endpoint enriches Tier 1 with:
- Narrative summary of the raw data
- Ranked priority ordering (top 5 items)
- Cross-source correlation (this Teams thread relates to that Jira ticket)
- Predictions (this action item is stale)

When AI is unavailable, Tier 2 is silently omitted. The user still sees Tier 1.

### Tier 3 — Visible banner declares degraded mode

When Tier 2 is omitted due to AI failure, the response includes a machine-readable field `enrichment_status: "unavailable" | "partial" | "full"` AND a visible banner in the rendered markdown:

```markdown
> _AI enrichment temporarily unavailable — showing raw data. Retrying automatically._
```

The banner is visually distinct from the error prefix `(AI summary unavailable: …)` we ship today — it does not embed the underlying error message (that goes to `stderr` and observability), it just declares the mode.

### Contract rules

1. **AI helpers throw, never return error strings.** `generateSummaryWithClaude` and equivalents propagate the error to the caller. In-band signaling is banned.
2. **Callers catch and fall through.** The endpoint wraps the AI helper in `try/catch`, logs to `stderr` once, and renders Tier 1 + banner on failure.
3. **Cache TTL scales with confidence.** Full AI success → 1h TTL. Fallback-only → 5min TTL (retries soon). Errors are NEVER cached with any TTL — an error is not a cacheable value.
4. **`enrichment_status` is exposed in the API response.** The UI can render its own banner shape if it prefers, or scale confidence indicators.
5. **Same pattern for all three current tools + all future tools.** Codified as a shared helper `runWithAIEnrichment(deterministic: () => T, enrich: (T) => Promise<string>)` in `src/lib/ai-enrichment.ts`.

## Consequences

### Positive

- **User always gets useful data.** 502 → still see message counts, action items, search results. Never a blank error page.
- **Cache-poisoning is structurally impossible.** Errors throw; only successful outputs enter the cache path.
- **Robust to error-message text changes.** No regex-matching on strings; uses TypeScript's control flow.
- **Applies to future tools uniformly.** The `runWithAIEnrichment` helper is the enforcement point — new tools that don't use it fail code review.
- **Observability improves.** Errors flow to `stderr` + can be routed to a `ai_enrichment_failures` counter. Today they're buried in cached markdown users see once and forget.

### Negative

- **UI needs a new visual state.** The `enrichment_status: "unavailable"` banner is a new component. The `partial` mode (some sections got AI, others didn't) adds a third state to design for.
- **Cache TTL becomes non-uniform.** Two TTLs (`1h`, `5min`) is more state to reason about than one. Mitigation: encapsulate in `cacheDigest(db, key, markdown, ttlSeconds)`.
- **Migration touches three files.** All three current tools need refactoring. Coordinated PR with per-file typecheck + smoke.
- **The `runWithAIEnrichment` helper is one more abstraction.** Callers must adopt it; grep-checkable in code review.

### Neutral

- The retry logic in `src/lib/retry.ts` doesn't change. It stays the inner layer; the enrichment helper wraps it.

## Alternatives considered

### A1. Keep error strings, longer retries

**Rejected.** Retry alone doesn't help — the fundamental issue is that a returned string can't be distinguished from real output. Longer retries also make each failed request take longer, blocking the request handler (violates "bridge must never block" rule).

### A2. Cache-on-failure with short TTL

**Rejected.** This is the band-aid I applied today (skip cache when markdown contains the error prefix). Structurally still fragile — someone edits the error message → cache-poisoning returns. Doesn't address failure mode 3 (no fallback surface).

### A3. Fail loud (HTTP 502 to the client)


### A4. Silent fallback with no banner

**Rejected.** The user should know when the summary they're reading is deterministic vs. AI-enhanced — otherwise they can't calibrate trust. Silent fallback breaks the mental model.

## Acceptance criteria

Per `.claude/rules/outcome-honesty.md`, outcome ACs are listed FIRST, substrate ACs below.

### Outcome ACs (verified via `smoke:outcome` or user_observed)

| AC | Description | Verification |
|---|---|---|
| **AC-U3** | The `enrichment_status` field in the JSON response is one of `"full" \| "partial" \| "unavailable"` and matches the rendered content: `full` when AI narrative rendered, `unavailable` when only Tier 1 rendered, `partial` when some AI sections rendered and others did not. | `scripts/smoke-outcome.sh` § adr-041-2: hit the endpoint in each of the three states, assert JSON schema + content agreement. |
| **AC-U4** | Same three properties (AC-U1..3) hold for `POST /api/teams-updates` and `POST /api/search-all` after the migration. | `scripts/smoke-outcome.sh` § adr-041-3, -4: same 502-injection test per endpoint. |

### Substrate ACs (verified via `smoke:bridge` + unit tests)

| AC | Description | Verification |
|---|---|---|
| **AC-S1** | `src/lib/ai-enrichment.ts` exports `runWithAIEnrichment<T>(deterministic, enrich, opts)` with the signature specified in § Implementation Plan. | `tests/lib/ai-enrichment.test.ts` — unit tests for success / throw / timeout / cache-decision paths. |
| **AC-S2** | `generateSummaryWithClaude` in `src/tools/daily-summary.ts` throws on error, does NOT return `"(AI summary unavailable: …)"`. | grep gate in `scripts/smoke-bridge.sh` new § adr-041 asserts `git grep -n 'AI summary unavailable:' src/tools/` returns 0 lines after the refactor. |
| **AC-S3** | `cacheDigest` accepts a `ttlSeconds` parameter (default `3600`); callers pass `300` for fallback mode. | Unit test in `tests/tools/daily-summary.test.ts`: assert `SELECT expires_at FROM digests` yields `< 6 * 60 * 1000` ms in fallback-mode fixture. |
| **AC-S4** | The three refactored tools (`daily-summary`, `teams-updates`, `search-all`) all import from `src/lib/ai-enrichment.ts` and do NOT contain their own try/catch around Anthropic calls. | grep gate in smoke: `git grep -n 'runWithAIEnrichment' src/tools/{daily-summary,teams-updates,search-all}.ts` returns exactly 3 lines. |
| **AC-S5** | Schema unchanged. No new tables, no migration. `CURRENT_SCHEMA_VERSION` unchanged after this ADR ships. | `pragma user_version` check in smoke. |
| **AC-S6** | Bridge smoke passes: `npm run smoke:bridge` reports `PASS` for all pre-existing sections + new § adr-041. | `npm run smoke:bridge` exit 0. |
| **AC-S7** | Typecheck + lint + tests green post-refactor. | `npm run typecheck`, `npm run lint`, `npm run test:run` all exit 0. |

## Implementation plan (spike scope)

**Do NOT bundle this into one PR.** Split by tool for reversibility.

### Slice 1 — Shared helper + tests (no callers changed)

Ship `src/lib/ai-enrichment.ts`:

```typescript
export interface EnrichmentResult<T> {
  data: T;
  markdown: string;
  status: 'full' | 'partial' | 'unavailable';
  aiError?: string;
}

export interface EnrichmentOpts {
  timeoutMs?: number;  // Hard deadline on the AI call (default: 30000)
}

export async function runWithAIEnrichment<T>(
  deterministic: () => T | Promise<T>,
  enrich: (data: T) => Promise<string>,
  opts: EnrichmentOpts = {},
): Promise<EnrichmentResult<T>> {
  const data = await deterministic();
  const { timeoutMs = 30_000 } = opts;

  try {
    const markdown = await Promise.race([
      enrich(data),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ai enrichment timeout')), timeoutMs)),
    ]);
    return { data, markdown, status: 'full' };
  } catch (err) {
    const aiError = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ai-enrichment] falling back to deterministic: ${aiError}\n`);
    return { data, markdown: '', status: 'unavailable', aiError };
  }
}
```

Plus `tests/lib/ai-enrichment.test.ts`:
- Success path: enrich returns → `status='full'`.
- AI throws → `status='unavailable'`, `data` still present.
- AI timeout → `status='unavailable'`.
- `aiError` populated correctly.

Ship as a standalone PR — no behavioral change until slice 2.

### Slice 2 — daily-summary refactor

Rewrite `src/tools/daily-summary.ts`:

1. Delete the try/catch in `generateSummaryWithClaude` — let it throw.
2. Extract deterministic tier into `computeDailySummaryData(db, today, yesterday): { messages, actionItems, yesterday }`.
3. Extract AI enrichment tier into `enrichDailySummary(data, apiKey): Promise<string>`.
4. Refactor `generateDailySummary`:
   ```typescript
   const cached = getCachedDigest(db, today);
   if (cached && !opts.refresh) return { markdown: cached.markdown, cached: true, generatedAt: cached.generated_at, status: cached.status };

   const result = await runWithAIEnrichment(
     () => computeDailySummaryData(db, today, yesterday),
     (data) => enrichDailySummary(data, anthropicApiKey),
   );

   const markdown = formatMarkdown(today, yesterday, result.data.messages, result.data.actionItems, result.markdown, result.status);
   const ttl = result.status === 'full' ? 3600 : 300;
   cacheDigest(db, today, markdown, ttl, result.status);
   return { markdown, cached: false, generatedAt: new Date().toISOString(), status: result.status };
   ```
5. `formatMarkdown` gains a `status` parameter. When `status !== 'full'`, prepend the banner `> _AI enrichment temporarily unavailable — showing raw data. Retrying automatically._`
6. `cacheDigest` schema unchanged; add `status` as a new column via schema bump (or store inline in a JSON blob to avoid migration — decide during spike).
7. Update `web/src/pages/Dashboard.tsx` to render the banner element differently from a normal summary (subtle amber tint, no scary red).

### Slice 3 — teams-updates refactor

Same shape as slice 2. No cache layer in this tool today; the migration is smaller.

### Slice 4 — search-all refactor

Same shape. No cache layer.

### Slice 5 — smoke sections

Add `scripts/smoke-bridge.sh § adr-041` for substrate ACs (grep gates + endpoint shape check).

Add `scripts/smoke-outcome.sh § adr-041-1..4` for outcome ACs (mock Anthropic throw + assert content). This is a new script if it doesn't exist; check first.

### Slice 6 — ADR promotion

After slices 1–5 all merged + soaked for one week under real traffic:
- Update this ADR's Status: `Proposed` → `Substrate Accepted` (substrate ACs pass) → `Accepted` (outcome ACs verified + user_observed AC-U2).
- Add entry to ADR index.

## Rollback

Each slice is independently revertible:
- Slice 1 (helper) — pure addition, no callers; revert with `git revert`.
- Slice 2–4 (per-tool) — feature-flagged behind `AI_ENRICHMENT_FALLBACK_ENABLED=1` for the first week. Default `1` in dev, `0` in prod during soak. Flip to `0` restores today's behavior instantly.
- Slice 5–6 — pure additions.

The env flag is deleted after soak (~2 weeks).

## Cross-references

- `.claude/rules/outcome-honesty.md` — the rule this ADR follows (outcome ACs first).
- `.claude/rules/smoke-tests.md` — smoke discipline for the substrate ACs.
- `src/lib/retry.ts` — the inner retry layer (unchanged by this ADR).
- `src/tools/daily-summary.ts:226` — the primary anti-pattern site.
- `src/tools/teams-updates.ts:262`, `src/tools/search-all.ts:276` — sibling sites.
- Session 2026-07-06 05:46 UTC — the outage that triggered this ADR.
- [[project_bridge_oom_and_event_loop_rule]] — related "bridge stays responsive" architectural rule.
- ADR-040 (outcome-honest delivery kanban) — companion; this ADR is a concrete application of the two-state done model.

## Open questions (resolve during spike)

1. **Cache schema:** add a `status` column to `digests` (migration), or serialize status into the existing `markdown` column as a leading HTML comment? Prefer no-migration if the comment approach is clean enough.
2. **Banner in JSON API:** is the banner rendered in Tier 1 markdown, or as a separate JSON field the UI composes? Probably both — markdown for MCP/CLI consumers, JSON field for the web UI to style richly.
3. **`enrichment_status: "partial"`:** when does this fire? A daily summary either has AI or doesn't. But search-all with multiple result groups could plausibly enrich some groups and not others. Defer to slice 4 to decide if partial is real.
4. **Metric surface:** add `ai_enrichment_status_counter` to `/api/system-health`? Yes — one Prometheus-style counter partitioned by tool + status. Ship in slice 5 or as a follow-up.
