---
sidebar_position: 40
title: EP-40 AI Resilience & Model Hygiene
---

# EP-40: AI Resilience & Model Hygiene

| Field | Value |
|-------|-------|
| **Status** | ✅ Done |
| **Priority** | High |
| **Complexity** | Small (1–2 days) |
| **Blocked By** | None |
| **Schema version** | No change |
| **Completed** | 2026-04-18 |

## Summary

Three gaps identified in the ML engineering review that are unaddressed by any other epic:

1. **`chatWithContext()` is stateless** — the topic chat endpoint retrieves fresh FTS context per query but never passes the topic notebook as system context. The notebook is Claude's accumulated memory of the project — ignoring it means every chat answer is grounded only in keyword-matched recent messages, not in the full project understanding Claude has already built.

2. **No fallback on AI failure** — when any Claude API call fails (network error, rate limit, overload), the endpoint returns HTTP 500 and the user sees an error. No stale cached response is returned. For digests, morning briefs, and notebooks this is particularly bad — a cached version from an hour ago is almost always better than nothing.

3. **Model versions hardcoded** — `EXTRACTION_MODEL = 'claude-haiku-4-5-20251001'` is a pinned version that will not auto-upgrade when Anthropic releases a better Haiku. Using `claude-haiku-latest` / `claude-sonnet-latest` aliases ensures the tool always runs the best current model in each tier.

## Decisions Made

- **Notebook as system context for chat** — pass `topic_notebooks.content` as the first system block (with `cache_control: ephemeral`) before the FTS context. This makes the notebook Claude's persistent memory; FTS results are additional evidence.
- **Stale-on-error for read-only endpoints only** — digests, morning brief, weekly report, notebooks. NOT for write operations (configure-topic, sync) — those must fail explicitly.
- **`stale: true` flag in response** — when serving a cached response due to AI failure, include `stale: true` and `stale_reason: 'ai_error'` so the UI can show a soft warning.
- **Use `latest` aliases** — `claude-haiku-latest` and `claude-sonnet-latest` in `EXTRACTION_MODEL` and `DIGEST_MODEL`. Pinned versions only if a specific model regression is observed.
- **Log all AI failures to `error_logs`** — existing `persistError()` call; just make sure it fires on every Claude API exception.

---

## EP-40-1: Wire Notebook into `chatWithContext()`

### Problem

`POST /api/notebooks/:topicName/chat` in `web-server.js`:

```javascript
// Current — FTS context only
const ftsResults = searchMessages(db, message, { limit: 20 });
const reply = await analyzer.chatWithContext(message, history, ftsResults);
```

The notebook content is fetched and displayed in the UI but **never passed to the AI call**.

### Fix — `src/services/analyzer.ts`

Update `chatWithContext()` signature:

```typescript
async chatWithContext(
  message: string,
  history: ChatTurn[],
  contextItems: ContextItem[],
  notebookContent?: string  // NEW — topic's accumulated knowledge
): Promise<{ reply: string; suggestedFollowUps: string[] }>
```

When `notebookContent` is provided, inject as first system block:

```typescript
const systemBlocks: PromptCachingBetaTextBlockParam[] = [];

if (notebookContent) {
  systemBlocks.push({
    type: 'text',
    text: `## Project Knowledge Base\n\nThe following is a structured, up-to-date summary of this topic. Use it as your primary reference when answering questions:\n\n${notebookContent}`,
    cache_control: { type: 'ephemeral' },
  });
}

systemBlocks.push({
  type: 'text',
  text: `## Recent Context\n\n${formatContextItems(contextItems)}`,
  cache_control: { type: 'ephemeral' },
});
```

### Fix — `web-server.js`

```javascript
// Updated — notebook as system context
const notebook = getNotebook(db, topicName);
const ftsResults = searchMessages(db, message, { limit: 20 });
const reply = await analyzer.chatWithContext(
  message,
  history,
  ftsResults,
  notebook?.content  // passes notebook if exists
);
```

**Impact**: Chat answers become grounded in project history (decisions, blockers, key people, current status) rather than just recent messages matching keywords.

---

## EP-40-2: Stale-on-Error Fallback for Read-Only Endpoints

### Problem

Any `analyzer.*()` call that throws returns HTTP 500 with no useful content. For cached endpoints (digests, morning-brief, notebooks, weekly-report) a stale version is far more useful than an error.

### Fix pattern — wrap AI calls in stale fallback

```typescript
async function withStaleFallback<T>(
  freshFn: () => Promise<T>,
  getCached: () => T | null,
  label: string
): Promise<{ data: T; stale: boolean; stale_reason?: string }> {
  try {
    const data = await freshFn();
    return { data, stale: false };
  } catch (err) {
    console.error(`[${label}] AI call failed, attempting stale fallback:`, err.message);
    const cached = getCached();
    if (cached) {
      return { data: cached, stale: true, stale_reason: 'ai_error' };
    }
    throw err;  // no cache available — propagate error
  }
}
```

### Apply to these endpoints in `web-server.js`

| Endpoint | `getCached` | Stale TTL |
|----------|------------|-----------|
| `GET /api/digest` | `getCachedDigest(db, topicName, date)` | previous day's digest |
| `GET /api/morning-brief` | `getCachedDigest(db, '__morning_brief__', today)` | yesterday's brief |
| `GET /api/weekly-report` | `getCachedDigest(db, '__weekly_report__', weekOf)` | last week's report |
| `GET /api/notebooks/:topicName` | `getNotebook(db, topicName)` | last built notebook |

### UI response shape change

When `stale: true`, the endpoint returns:

```json
{
  "markdown": "...(cached content)...",
  "stale": true,
  "stale_reason": "ai_error",
  "cached_at": "2026-04-17T09:00:00Z"
}
```

UI shows a subtle `⚠ Showing cached version — AI unavailable` banner at top of the content, using `var(--muted)` color. Not a blocking error.

---

## EP-40-3: Use Model Aliases Instead of Pinned Versions

### Problem

```typescript
// src/services/analyzer.ts — current
const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';
const DIGEST_MODEL = 'claude-sonnet-4-6';
```

`claude-haiku-4-5-20251001` is a pinned version. When `claude-haiku-4-6` ships, this tool stays on the old model forever unless manually updated. `claude-sonnet-4-6` is already effectively an alias-like name but will also need bumping.

### Fix

```typescript
// src/services/analyzer.ts — updated
const EXTRACTION_MODEL = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? 'claude-haiku-latest';
const DIGEST_MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'claude-sonnet-latest';
```

The `ANTHROPIC_DEFAULT_HAIKU_MODEL` and `ANTHROPIC_DEFAULT_SONNET_MODEL` env vars are already set in `~/.claude/settings.json` (they point to `claude-haiku-latest` and `claude-sonnet-latest`). Reading them means the proxy configuration already controls model routing — no code change needed if the env is already set correctly.

Fallback to `claude-haiku-latest` / `claude-sonnet-latest` as the default ensures auto-upgrade without any env var configuration.

**Note**: If a model regression is observed, pin to a specific version via env var. Don't re-hardcode in source.

---

## Key Code Locations

| File | Change |
|------|--------|
| `src/services/analyzer.ts` | Add `notebookContent?` to `chatWithContext()`; change model constants to use env vars with `latest` fallback |
| `web-server.js` | Wire notebook into `/api/notebooks/:topicName/chat`; wrap digest/brief/notebook endpoints with `withStaleFallback` |
| `web/src/pages/TopicExpertPage.tsx` | Show `⚠ Showing cached version` banner when response has `stale: true` |
| `web/src/lib/api.ts` | Add `stale?: boolean; stale_reason?: string; cached_at?: string` to relevant response types |

## Implementation Notes

**EP-40-1 — actual signature** (`src/services/analyzer.ts`):
```typescript
async chatWithContext(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  message: string,
  context: ContextItem[],
  notebookContent?: string   // injected as first system block with cache_control: ephemeral
): Promise<{ reply: string; suggestedFollowUps: string[] }>
```
Notebook is the FIRST system block (highest cache priority), followed by the base system prompt, then FTS context — all three have `cache_control: ephemeral`.

**EP-40-2 — `withStaleFallback` in `web-server.js`**:
```javascript
async function withStaleFallback(freshFn, getCached, label) {
  try {
    const data = await freshFn();
    return { data, stale: false };
  } catch (err) {
    const cached = getCached();
    if (cached) return { data: cached, stale: true, stale_reason: 'ai_error' };
    throw err;
  }
}
```
Applied to: `GET /api/digest` and `GET /api/morning-brief`. Deferred for `/api/weekly-report` (EP-38 not yet built).

**EP-40-3 — model constants**:
```typescript
const EXTRACTION_MODEL = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? 'claude-haiku-latest';
const DIGEST_MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'claude-sonnet-latest';
```

## Acceptance Criteria

- [x] `chatWithContext()` accepts optional `notebookContent` parameter
- [x] `/api/notebooks/:topicName/chat` passes notebook content to `chatWithContext()`
- [x] Chat response for a topic with a notebook references project-level context (decisions, blockers, current status)
- [x] `withStaleFallback()` helper implemented and used in digest + morning-brief endpoints
- [x] When AI fails and cached content exists, endpoint returns `stale: true` with cached content (not 500)
- [x] When AI fails and no cache exists, endpoint still returns 500 (no false success)
- [x] UI shows `⚠ Showing cached version — AI unavailable` banner on stale responses (`TopicExpertPage.tsx`)
- [x] `EXTRACTION_MODEL` reads from `ANTHROPIC_DEFAULT_HAIKU_MODEL` env var, falls back to `claude-haiku-latest`
- [x] `DIGEST_MODEL` reads from `ANTHROPIC_DEFAULT_SONNET_MODEL` env var, falls back to `claude-sonnet-latest`
- [x] TypeScript builds clean
- [ ] `withStaleFallback()` wired to `/api/weekly-report` — deferred to EP-38 (endpoint not yet built)

---

## Implementation Gaps & Recommendations

> Post-completion analysis from senior-architect, senior-ml-engineer, senior-prompt-engineer, and senior-data-scientist lenses. These are improvement tickets for future sprints — EP-40 core is ✅ Done.

---

### GAP-40-A: Circuit Breaker Missing from `withStaleFallback`

**Problem**: `withStaleFallback` still waits for the full request timeout (30–60s) before serving stale. If Claude is experiencing a sustained outage, every request burns a full timeout before falling back. With 4 wrapped endpoints, a single bad minute generates 4× timeout waste.

**Recommended fix** (future sprint):

```typescript
// src/lib/circuit-breaker.ts
export class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private readonly threshold = 3,      // failures before opening
    private readonly resetMs = 60_000    // try again after 60s
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetMs) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit open — AI unavailable');
      }
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.state = 'closed';
      return result;
    } catch (err) {
      this.failures++;
      this.lastFailure = Date.now();
      if (this.failures >= this.threshold) this.state = 'open';
      throw err;
    }
  }
}
```

Wrap `withStaleFallback`'s `freshFn` call with a module-level `const aiCircuitBreaker = new CircuitBreaker()`. Once open, stale is served instantly with no timeout wait. `stale_reason: 'circuit_open'` distinguishes from `'ai_error'`.

**Why this matters for cost/performance**: A 30s timeout × 4 endpoints × N concurrent users = significant latency during outages. Circuit breaker converts this to sub-millisecond stale reads.

---

### GAP-40-B: Stale Banner Only on `TopicExpertPage` — Other Pages Unprotected

**Problem**: `DigestPage.tsx` and `DashboardPage.tsx` (morning brief) also consume stale-capable endpoints but have no stale banner logic. The API already returns `stale: true` — these pages silently display stale content with no visual indicator.

**Recommended fix**: Extract banner to a shared component and add to all three pages.

```typescript
// web/src/components/shared/StaleBanner.tsx
export function StaleBanner({ stale, cachedAt }: { stale?: boolean; cachedAt?: string }) {
  if (!stale) return null;
  const age = cachedAt ? formatDistanceToNow(new Date(cachedAt)) : 'unknown time';
  return (
    <div className="px-3 py-1.5 text-xs rounded border flex items-center gap-2"
      style={{ background: 'var(--warning-bg)', color: 'var(--warning-fg)', borderColor: 'var(--warning-border)' }}>
      <span>⚠</span>
      <span>Showing cached version from {age} ago — AI temporarily unavailable</span>
    </div>
  );
}
```

Pages needing update: `DigestPage.tsx`, `DashboardPage.tsx` (morning-brief section), `WeeklyReportPage.tsx` (once EP-38 ships).

---

### GAP-40-C: Token Budget Cap Missing from `chatWithContext()`

**Problem**: With `notebookContent` (~3k tokens) + unbounded conversation `history` + FTS context items (20 × ~300 tokens = 6k tokens), a long chat session can push the prompt to 12k+ tokens. No truncation guard exists.

**Recommended fix** — add truncation in `chatWithContext()` before building the prompt:

```typescript
// src/services/analyzer.ts
const MAX_HISTORY_TURNS = 10;          // keep last 10 turns (5 exchanges)
const MAX_CONTEXT_ITEMS = 15;          // down from 20 when notebook present
const MAX_NOTEBOOK_CHARS = 4_000;      // truncate long notebooks at 4k chars

async chatWithContext(
  history: ChatTurn[],
  message: string,
  context: ContextItem[],
  notebookContent?: string
) {
  const trimmedHistory = history.slice(-MAX_HISTORY_TURNS);
  const trimmedContext = notebookContent
    ? context.slice(0, MAX_CONTEXT_ITEMS)    // reduce FTS when notebook present
    : context.slice(0, 20);
  const trimmedNotebook = notebookContent?.slice(0, MAX_NOTEBOOK_CHARS * 4); // chars → bytes approx
  // ... rest of implementation
}
```

**Why**: Prevents silent cost overruns on long sessions. A 15k token chat call costs ~$0.045 vs ~$0.012 for a bounded 4k call. Over 100 chats/day this is $3.30/day vs $1.20/day.

---

### GAP-40-D: Notebook Injection Missing Freshness Timestamp

**Problem**: The notebook is injected as a static block with no timestamp. When the notebook is 3 days old and new events have happened since, Claude has no way to know the knowledge base may be stale. This leads to confidently wrong answers about recent status.

**Recommended fix** — prepend freshness header to the notebook injection:

```typescript
// src/services/analyzer.ts
if (notebookContent) {
  const notebookAge = notebook?.last_updated
    ? `Last updated: ${notebook.last_updated} (${formatDistanceToNow(new Date(notebook.last_updated))} ago)`
    : 'Age unknown';

  systemBlocks.push({
    type: 'text',
    text: `## Project Knowledge Base\n\n> ${notebookAge}. If the user asks about very recent events, note that your knowledge of this topic may not reflect the last few days.\n\n${notebookContent}`,
    cache_control: { type: 'ephemeral' },
  });
}
```

**Why this matters for prompt quality**: Without freshness signal, Claude presents stale knowledge as current fact. With it, Claude appropriately hedges on recent events and directs the user to refresh the notebook.

---

### GAP-40-E: No `served_stale` Tracking in `token_usage`

**Problem**: When `withStaleFallback` serves a cached response, `token_usage` records nothing (no AI call was made). This is correct for cost tracking but means there's no visibility into how often the fallback fires. A sustained AI outage would be invisible in the dashboard.

**Recommended fix** — add `served_stale` event type to `ingestion_log` (EP-33's table):

```sql
-- Re-use existing ingestion_log table from EP-33 (schema v19)
-- When stale fallback fires, insert:
INSERT INTO ingestion_log (source, operation, items_processed, error_message)
VALUES ('ai_resilience', 'stale_fallback', 1, 'endpoint:' || :endpoint || ' reason:' || :stale_reason)
```

No schema change needed. `GET /api/data-quality` already surfaces `ingestion_log` data — stale fallback events appear automatically. If stale events appear > 5 times in an hour, the data quality widget flags it.

---

### GAP-40-F: `suggestedFollowUps` Are Not Grounded in Notebook

**Problem**: The current `suggestedFollowUps` in the chat response are generic AI completions ("What else can I help you with?"). They don't reference actual open items, blockers, or decisions from the notebook.

**Recommended fix** — add explicit grounding rule to `chatWithContext()` system prompt:

```typescript
const CHAT_SYSTEM_PROMPT = `You are a helpful assistant answering questions about a specific work topic.

FOLLOW-UP GENERATION RULES:
- Suggested follow-ups MUST reference specific items from the Project Knowledge Base (open questions, blockers, decisions)
- Format: "What's the status of [specific open item from notebook]?" or "Who owns [specific task from notebook]?"
- Never generate generic follow-ups ("Tell me more", "What else?")
- If no open items exist in the notebook, suggest "Refresh this notebook to get the latest status"
- Maximum 3 follow-ups`;
```

**Why**: Generic follow-ups are useless noise. Notebook-grounded follow-ups guide the user through actual open work items, increasing the utility of each chat session.

---

### GAP-40-G: Silent Model Regression Risk

**Problem**: `claude-haiku-latest` alias silently flips to a new model version on Anthropic's release schedule. If the new Haiku has a regression in extraction quality (worse JSON tool-use compliance, different token usage patterns), there's no alerting.

**`token_usage.model` already records the resolved model name** (e.g., `claude-haiku-4-6-20260101`) — this is the correct mitigation already in place via EP-32.

**Recommended monitoring query** — add to `GET /api/data-quality` response or as a periodic check:

```sql
-- Detect model flip (different model name from previous day)
SELECT
  DATE(recorded_at) as day,
  model,
  COUNT(*) as calls,
  AVG(output_tokens) as avg_output_tokens
FROM token_usage
WHERE method LIKE '%extract%' OR method LIKE '%analyze%'
GROUP BY day, model
ORDER BY day DESC
LIMIT 14;
```

If `model` changes between consecutive days, surface in data quality dashboard as an informational alert. No action required — just visibility. Cost tracking already in `TokenStatsWidget`; this adds model-flip awareness.
