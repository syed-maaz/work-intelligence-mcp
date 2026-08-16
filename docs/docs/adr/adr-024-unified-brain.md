---
sidebar_label: "ADR-024: Unified Brain API"
sidebar_position: 24
---

# ADR-024: Unified Brain API

**Status**: Accepted
**Date**: 2026-05-18
**Deciders**: Maaz
**Epics**: EP-69, EP-70, EP-71
**Supersedes**: —

**Traceability**:
- Branch: [`PROJ-15257-fix-context-links-knowledge-migration`](https://github.com/) — current planning branch
- Driving incident: [PROJ-15257](https://jira.example.com/browse/PROJ-15257) — BIS recommended-links regression that exposed cross-consumer drift between UI / Atlas / MCP
- Phase plans: `.planning/phases/69-foundation-brain/`, `70-brain-consumers/`, `71-brain-learning/` (16 PLAN.md files)
- Design source: `.planning/phases/69-71-unified-brain/INTENT.md`
- Epic docs: [EP-69 / EP-70 / EP-71 in docs/docs/epics/](../epics/)
- Predecessor ADRs: [ADR-016](./adr-016-second-brain-architecture.md), [ADR-017](./adr-017-always-on-agent-architecture.md), [ADR-022](./adr-022-dual-engine-investigation.md), [ADR-023](./adr-023-openclaw-plugin.md)

---

## Context

Three consumers of the work-intelligence-mcp bridge currently re-implement the same intelligence behaviors — context injection, decision routing, memory recall, and action verification:

1. **Web UI Chat** — `web/src/components/shell/ChatPanel.tsx` and `InvestigatePanel.tsx` build their own context payloads and call multiple bridge endpoints in sequence to compose answers.
2. **Atlas / OpenClaw plugin** — `~/.openclaw/extensions/work-intelligence/` injects context via its own `context-cache.ts`, runs slash command handlers that re-aggregate `/api/action-items + /api/jira/stuck + /api/config/sprint` per turn.
3. **MCP server tools** — `src/server.ts` exposes WI tools to Claude Code, each constructing its own request body and aggregating results.

Without unification, every change to the intelligence model (new context field, new evidence type, new decision shape) must be replicated three times and drifts inevitably appear. As Atlas phrased it 2026-05-18: *"Right now I'm flying half-blind. WI gives me a summary in my context, but I can't query JIRA, can't read GitHub PRs, can't pull build logs. I can theorize but not verify."*

The bridge already centralizes Fetch → Process → Analyze → Propose for raw data sources. What it lacks is a single decision/context surface that all three consumers share so they remain in lockstep.

---

## Decision

Introduce a `/api/brain/*` namespace in `web-server.js` that consolidates four intelligence pillars behind one stable HTTP contract. UI / Atlas / MCP all become **thin clients** of the same brain. No consumer reaches into raw bridge endpoints for decision composition — they call `/api/brain/*` and render the structured response.

The brain is implemented as a thin orchestration layer over existing services (AIAnalyzer, MemoryEnricher, McpClient, investigation-orchestrator). It is not a new model, nor a new database — it is a unifying API that fans out to existing surface and persists decisions/verifications for learning.

---

## The Four Pillars

### Pillar 1 — Decision Engine (`POST /api/brain/decide`)

Takes a question + caller context, returns a structured decision with rationale, evidence, confidence, and next-action recommendations.

**Input**:
```json
```

**Output**:
```json
{
  "decision_id": "dec_01HXY...",
  "decision": "Fix Checkmarx GitHub token first",
  "rationale": "100 of 200 open actions are duplicate 401s — single root cause",
  "confidence": 0.92,
  "evidence": [
    { "source": "actions_cluster", "id": "checkmarx-401", "count": 103 },
    { "source": "memory", "id": "obs-6783", "note": "similar pattern Apr 2026" }
  ],
  "next_actions": [
    { "type": "fix", "tool": "rotate_token", "args": "checkmarx-github" }
  ],
  "alternatives": [{ "decision": "Drive ADR-0058 stuck Jiras", "score": 0.74 }]
}
```

**Internals**: Claude Sonnet 4.6 with `tool_use` for structured output, prompt-cached system block, runs after Pillar 2 context fetch.

**LLM call boundary** (locked — Phase 69-05 must use this contract):

`/api/brain/decide` does **not** call `AIAnalyzer` and does **not** add new methods to `src/services/analyzer.ts`. AIAnalyzer remains a low-level Anthropic SDK wrapper for the four-stage pipeline (extraction, summarization, digest, detection); coupling decision orchestration into it would break that boundary. Instead, Phase 69-05 introduces a new decoupled wrapper used **only** by the brain layer:

**File**: `src/services/brain/anthropic-tool-use.ts`

**Function signature**:

```ts
import type Anthropic from '@anthropic-ai/sdk';

export interface BrainToolUseRequest {
  systemPrompt: string;                 // cached via cache_control: 'ephemeral'
  userMessage: string;                  // composed by /api/brain/decide from question + Pillar 2 context
  toolName: string;                     // e.g. 'emit_decision'
  toolSchema: Anthropic.Tool['input_schema'];
  model?: string;                       // default: 'claude-sonnet-4-6'
  maxTokens?: number;                   // default: 2048
}

export interface BrainToolUseResponse<T = unknown> {
  input: T;                             // parsed tool_use input — the structured decision
  raw: Anthropic.Beta.PromptCaching.PromptCachingBetaMessage;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export async function brainToolCall<T = unknown>(
  client: Anthropic,
  req: BrainToolUseRequest,
): Promise<BrainToolUseResponse<T>>;
```

**Implementation contract**:

- Calls `client.beta.promptCaching.messages.create(...)` (same beta namespace AIAnalyzer uses — kept here only because it's the only namespace exposing `cache_control` in SDK 0.32.1)
- System prompt passed as `PromptCachingBetaTextBlockParam[]` with `cache_control: { type: 'ephemeral' }` on the first block
- `tool_choice: { type: 'tool', name: req.toolName }` forces structured output
- Reads `response.content.find(b => b.type === 'tool_use').input` and returns it as `input: T`
- Throws if no `tool_use` block is present (does not fall back to text parsing)
- Returns token usage so 69-05 can enforce the per-user daily budget from T-69-01

**Why a separate wrapper**: AIAnalyzer's caller methods (`detect`, `extract`, `summarize`, `digest`) carry pipeline-specific defaults (chunking at 50 messages, EXTRACTION_MODEL vs DIGEST_MODEL routing). The brain's decision call is a single-shot tool use with its own budget, model selection, and caching strategy — composing it via AIAnalyzer would force AIAnalyzer to absorb concerns it doesn't own. Plan 69-05 may import `brainToolCall` directly; it must not import or extend AIAnalyzer.

### Pillar 2 — Context Injector (`GET /api/brain/context`)

The before-LLM-turn context every consumer needs. TTL-cached (~50 ms warm).

**Output shape**:
```json
{
  "sprint": { "name": "Saturn-94", "ends": "2026-05-30", "fresh": true },
  "stuck_jiras": [{ "key": "PROJ-13863", "days_stuck": 23, "cluster": "ADR-0058" }],
  "noise_clusters": [
    { "signature": "Checkmarx 401", "count": 103, "actionable_root": "rotate-token" }
  ],
  "calendar_today": [{ "time": "14:00", "title": "ADR-0058 sync", "with": "X" }],
  "open_investigations": [{ "key": "PROJ-15257", "status": "running" }],
  "memory_relevant": ["obs-6783: FF_RM_11372 pattern"],
  "stale_warnings": []
}
```

**Replaces**: scattered logic in `web/src/pages/Dashboard.tsx`, OpenClaw plugin's `context-cache.ts` inline calls, MCP tool body builders.

### Pillar 3 — Verification Layer (`POST /api/brain/verify`)

Turns claims into verified facts. Atlas's biggest gap today: theorizing without verification.

**Input**: `{ "claim": "checkmarx-github-token-401", "evidence_needed": ["github_api_check"] }`
**Output**: `{ "verified": true, "evidence": "...", "confidence": 0.99, "checked_at": "..." }`

**Adapters**: GitHub MCP (`gh_api`), Jira MCP (`jira`), code grep (in `./repos/`), build logs.

### Pillar 4 — Memory Decision Loop (`POST /api/brain/recall` + `POST /api/brain/learn`)

- **Recall**: "Have we seen this pattern before?" → palace query + SQLite history of past decisions.
- **Learn**: Records outcome (`success` / `failed` / `abandoned`), updates palace, adjusts future confidence.

This closes the loop today's Atlas can't close — it forgets every conversation.

---

## Architecture

```
                       ┌──────────────────┐
   Web UI ChatPanel ──►│                  │
                       │                  │
   OpenClaw Atlas   ──►│  /api/brain/*    │
   (plugin tools)      │  in web-server.js│
                       │                  │
   MCP Tools        ──►│                  │
   (src/server.ts)     └────────┬─────────┘
                                │
        ┌───────────────────────┼─────────────────────────┐
        ▼                       ▼                         ▼
  Pillar 2 Context       Pillar 1 Decide            Pillar 3 Verify
  (TTL cache)            (Claude Sonnet 4.6,        (GitHub / Jira MCP,
        │                 tool_use, cached)          code grep, logs)
        │                       │                         │
        ├─ /api/action-items    ├─ persists to            ├─ adapters use
        ├─ /api/jira/stuck      │  brain_decisions        │  existing
        ├─ /api/config/sprint   │                         │  mcp_oauth_tokens
        ├─ /api/calendar/today  └─ logs to consumer       │
        ├─ palace recall                                  └─ persists to
        └─ open investigations                              brain_verifications

                                                  Pillar 4 Recall + Learn
                                                  (palace + brain_decisions
                                                   outcome write-back via
                                                   MemoryEnricher)
```

---

## Schema v45

One migration, covers all four pillars. No existing tables modified.

```sql
CREATE TABLE brain_decisions (
  id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,  -- sha256(question_norm \x1f user \x1f day_iso_utc) — see "Cache Key Contract" below
  question TEXT NOT NULL,
  day_iso TEXT NOT NULL,           -- 'YYYY-MM-DD' in UTC (NOT caller-local) — used in cache_key derivation
  decision TEXT NOT NULL,
  rationale TEXT,
  confidence REAL,
  evidence_json TEXT,        -- JSON array
  next_actions_json TEXT,    -- JSON array
  outcome TEXT,              -- 'pending' | 'success' | 'failed' | 'abandoned'
  outcome_recorded_at INTEGER,
  consumer TEXT,             -- 'ui' | 'atlas' | 'mcp'
  created_at INTEGER NOT NULL
);

CREATE TABLE brain_action_clusters (
  signature TEXT PRIMARY KEY,    -- e.g. 'checkmarx-401'
  count INTEGER,
  first_seen INTEGER,
  last_seen INTEGER,
  root_cause TEXT,
  resolution TEXT
);

CREATE TABLE brain_verifications (
  id TEXT PRIMARY KEY,
  claim TEXT NOT NULL,
  verified INTEGER,              -- 0/1
  evidence_json TEXT,
  confidence REAL,
  checked_at INTEGER NOT NULL
);

CREATE INDEX idx_brain_decisions_outcome ON brain_decisions(outcome);
CREATE INDEX idx_brain_decisions_created ON brain_decisions(created_at DESC);
CREATE INDEX idx_brain_decisions_user_day ON brain_decisions(user, day_iso);
CREATE INDEX idx_brain_clusters_count ON brain_action_clusters(count DESC);
```

### Cache Key Contract (locked — Phase 69-05 must cite verbatim)

`cache_key` is the deduplication primitive for `POST /api/brain/decide`. It collapses identical (question, user, day) triplets onto a single decision row and prevents two users from colliding on the same `decision_id`.

**Derivation** (deterministic, no salt, **UTC day** to avoid timezone-driven cache splits):

```ts
import { createHash } from 'node:crypto';

const SEP = '\x1f'; // ASCII unit separator — guaranteed not to appear in normalized question, user, or day_iso

function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

function utcDayIso(now: Date = new Date()): string {
  // 'YYYY-MM-DD' in UTC — NOT caller-local. Cross-timezone callers asking the
  // same question on the same UTC day share one decision row.
  return now.toISOString().slice(0, 10);
}

function brainCacheKey(question: string, user: string, dayIso: string): string {
  return createHash('sha256')
    .update(`${normalizeQuestion(question)}${SEP}${user}${SEP}${dayIso}`)
    .digest('hex');
}
```

**Why `\x1f` (unit separator) and not `|`**: a pipe character can appear inside a question (e.g. *"compare A | B"*); `"foo|bar" + "baz"` would hash identically to `"foo" + "bar|baz"`. The unit separator is non-printable, never appears after `normalizeQuestion`, and gives schema-level guarantee that the three components are unambiguously delimited.

**Why UTC day**: a caller in Berlin and a caller in San Francisco asking the same question minutes apart should hit the same cache row even if their local calendar dates differ. Locking to UTC removes that drift. The user's local timezone is still useful for *presenting* the day in the UI; it must not enter `cache_key`.

**Lookup shape** (the only path Phase 69-05 may use to read existing decisions before invoking Claude):

```sql
SELECT id, decision, rationale, confidence, evidence_json, next_actions_json, outcome, created_at
FROM brain_decisions
WHERE cache_key = ?
LIMIT 1;
```

**Insert shape**:

```sql
INSERT INTO brain_decisions (
  id, cache_key, question, user, day_iso, decision, rationale, confidence,
  evidence_json, next_actions_json, outcome, consumer, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?);
```

**Why this is locked**: Without the `(user, day_iso)` qualification, two engineers asking *"what should I work on today?"* on the same day would collide on the same `decision_id` — a privacy bug (User B sees User A's evidence) and a cost bug (the cache hit returns the wrong user's plan). The `UNIQUE` constraint on `cache_key` is the schema-level guarantee; plans must not bypass it.

---

## Implementation

Three phases, each independently mergeable, each with its own smoke-test exit criteria.

### Phase 69 — Foundation (week 1, 6 plans)

Ship the single source of truth and prove it with curl smoke tests.

| Plan | Title | Key ACs |
|------|-------|---------|
| 69-01 | Schema v45 migration | Tables created, indexes present, idempotent re-run, rollback safe |
| 69-02 | `GET /api/brain/context` endpoint | TTL cache (60 s), all 7 fields populated, &lt; 100 ms warm, smoke test passes |
| 69-03 | Action-cluster detector service | Groups action_items by error signature, top-N noise clusters, persisted to `brain_action_clusters` |
| 69-04 | Sprint-freshness + stuck-Jira detectors | Reuses `/api/config/sprint` + `/api/jira/stuck`, surfaces `stale_warnings` |
| 69-05 | `POST /api/brain/decide` endpoint | Claude Sonnet + tool_use, prompt-cached, persists to `brain_decisions`, returns `decision_id` |
| 69-06 | Smoke test suite + single-consumer baseline | curl tests for all endpoints, fixture decisions, latency budget proven, **single-consumer** (`consumer='ui'`) baseline asserts schema + cache_key behavior. **Does NOT** assert cross-consumer parity — that is owned by 70-05 once Atlas + MCP are wired in Phase 70. |

### Phase 70 — Consumer Wiring (week 2, 5 plans)

Eliminate duplication — make UI / Atlas / MCP all thin clients of `/api/brain/*`.

| Plan | Title | Key ACs |
|------|-------|---------|
| 70-01 | Atlas plugin: replace `context-cache.ts` with `/api/brain/context` call | Identical context output, kept TTL cache, hook timing unchanged |
| 70-02 | Atlas plugin: add `wi_decide` / `wi_verify` / `wi_recall` tools | 3 new tools registered, schemas validated, smoke test in OpenClaw chat |
| 70-03 | Web UI: `ChatPanel.tsx` migrated to `/api/brain/decide` | Structured decision cards rendered (rationale, evidence, next-actions buttons), backwards compat for pure chat |
| 70-04 | MCP server: 5 new tools (`get_decision`, `get_context`, `verify_claim`, `recall_memory`, `record_outcome`) | Exposed in `src/server.ts`, callable from Claude Code, tool definitions match Pillar contracts |
| 70-05 | Cross-consumer parity test | Same `(question, user, day_iso)` → identical `decision_id` across UI / Atlas / MCP, asserted in CI. **Owns the full parity matrix** (69-06 only proves single-consumer baseline). |

### Phase 71 — Learning Loop (week 3, 5 plans)

Make it learn — close the Trigger → Act → Memory → Summarize → Observe → Report → Act loop.

| Plan | Title | Key ACs |
|------|-------|---------|
| 71-01 | `POST /api/brain/learn` endpoint | Records outcome on existing `decision_id`, writes to palace via MemoryEnricher |
| 71-02 | `POST /api/brain/verify` with real adapters | GitHub MCP + Jira MCP + code grep + build log adapters wired, `brain_verifications` populated |
| 71-03 | Proactive scan cron | Every 30 min: scan for high-confidence decisions, push to `proactive_queue` for SSE delivery |
| 71-04 | Recurring-pattern badges in UI | "this decision worked last time" rendered on cluster matches |
| 71-05 | `POST /api/brain/recall` (palace + SQLite) | Combined recall path, ranked by recency × confidence |

---

## Existing Surface Mapped (Do Not Duplicate)

| Concern | Existing | Action |
|---------|----------|--------|
| Action items query | `GET /api/action-items` | Reuse inside `/api/brain/context` |
| Stuck Jiras | `GET /api/jira/stuck` | Reuse inside `/api/brain/context` |
| Sprint config | `GET /api/config/sprint` | Reuse inside `/api/brain/context` |
| Daily summary | `GET /api/daily-summary` | Could become Pillar 1 caller, NOT replaced |
| MCP OAuth tokens | `mcp_oauth_tokens` table | Reuse for verification adapters |
| Palace writer | `MemoryEnricher` (5-wing) | Add 6th wing: `decisions` |
| Context cache pattern | OpenClaw plugin `context-cache.ts` | Move logic server-side; keep client-side TTL only |
| AI Analyzer with caching | `src/services/analyzer.ts` | Reuse for `/api/brain/decide` |
| Investigation orchestrator | `src/intelligence/investigation-orchestrator.ts` | Decisions can call it as a "next_action" |

---

## Threats

| ID | Threat | Mitigation |
|----|--------|-----------|
| T-69-01 | Decision endpoint runs Claude calls without rate limit → cost runaway; same-day duplicate questions collide between users | Cache by `cache_key = sha256(question_norm \x1f user \x1f day_iso_utc)` enforced as `UNIQUE` on `brain_decisions.cache_key` (see "Cache Key Contract"); daily per-user budget cap enforced in 69-05 |
| T-69-02 | Action-cluster detector misgroups distinct errors | Signature must include error type + source system, manual override on `brain_action_clusters.root_cause` |
| T-70-01 | UI / Atlas / MCP drift if any bypasses `/api/brain/*` | Plan 70-05 owns the cross-consumer CI parity test (asserts identical `decision_id` across all three consumers for the same `cache_key`); 69-06 ships the single-consumer baseline only |
| T-71-01 | Verification adapters call external APIs without auth handling | Reuse existing `McpClient` token store; circuit breaker per adapter |
| T-71-02 | Proactive scan spams alert feed | Confidence threshold (≥ 0.85) + per-cluster cooldown (24 h) |

---

## Alternatives Considered

**Keep separate per-consumer logic** — Continue letting each consumer compose context and decisions itself. Rejected: drift is already visible (Atlas's `context-cache.ts` ≠ Dashboard's parallel calls ≠ MCP tool bodies); every new field requires three edits, and the UI/Atlas already disagree on stuck-Jira freshness thresholds.

**Build a separate "brain" microservice** — Stand up a new Node service alongside the bridge. Rejected: violates the four-stage pipeline constraint, doubles deployment surface, and forces every consumer to learn a second base URL. The bridge already owns Propose; `/api/brain/*` is a Propose sub-namespace.

**Push decision logic into AIAnalyzer** — Add `analyzeDecision()` directly to `src/services/analyzer.ts`. Rejected: AIAnalyzer is a low-level wrapper around Anthropic SDK calls; mixing decision orchestration into it would couple LLM-call concerns to context aggregation, prompt caching, and persistence. The brain layer composes AIAnalyzer + MemoryEnricher + McpClient — it does not replace any of them.

**Unified Brain chosen** because it preserves the four-stage pipeline (decisions are Analyze + Propose, fed by existing Fetch + Process), reuses every existing service without modification, and gives consumers one stable contract that can evolve independently of the underlying surface.

---

## Consequences

**Good**
- Single source of truth for context + decisions; one schema migration covers all four pillars.
- Three new MCP tools and three new Atlas tools become thin wrappers — no new intelligence logic in any consumer.
- Decisions persist with outcomes; future calls can recall past success/failure for the same cluster (closes the learning loop).
- Verification layer lets Atlas turn claims into facts via existing MCP clients (no new auth surface).
- Parity test in CI prevents drift between UI, Atlas, and MCP behavior.
- Existing endpoints unchanged; nothing in the four-stage pipeline is rewritten.

**Trade-offs**
- One more network hop for consumers that previously called raw bridge endpoints directly (offset by TTL cache for context, sub-100 ms warm).
- Decision endpoint runs Claude calls — must be rate-limited and cached or it can run up cost.
- Action-cluster signatures need careful design; bad clustering produces noisy `noise_clusters` output.
- Schema v45 adds three tables; if a consumer reads `brain_decisions` directly bypassing the API, it tightly couples to the schema.
- Proactive scan (Phase 71) introduces a new cron — must obey the per-cluster cooldown to avoid spamming the alert feed.

---

## Implementation Status

Shipped in v1.1 across three phases (Phases 69–71), all merged to `PROJ-15257-fix-context-links-knowledge-migration` on 2026-05-18. Phase 69 verified by gsd-verifier subagent (6/6 plans, 6/6 ADR-024 locked contracts). Phases 70–71 verified inline.

| Pillar | Phase | Status | Shipped |
|--------|-------|--------|---------|
| Pillar 2 — Context Injector | 69 (Foundation) | ✅ Shipped | 2026-05-18 |
| Pillar 1 — Decision Engine | 69 (Foundation) → 70 (Wiring) | ✅ Shipped | 2026-05-18 |
| Pillar 3 — Verification Layer | 71 (Learning Loop) | ✅ Shipped | 2026-05-18 |
| Pillar 4 — Memory Decision Loop | 71 (Learning Loop) | ✅ Shipped | 2026-05-18 |

### Pillar 1 — Decision Engine

**Plans**: 69-05 (endpoint), 70-03 (UI client), 70-04 (MCP tools), 70-02 (Atlas tools)

| Item | Plan | Status | Notes |
|------|------|--------|-------|
| `POST /api/brain/decide` endpoint | 69-05 | ✅ Shipped | `web-server.js:2041`; cache hit on `brain_decisions.cache_key` short-circuits the LLM call; 429 with `Retry-After` on budget exceeded |
| `src/services/brain/anthropic-tool-use.ts` wrapper | 69-05 | ✅ Shipped | Decoupled from AIAnalyzer per "LLM call boundary" contract; signature locked in this ADR |
| Web UI `ChatPanel.tsx` decision cards | 70-03 | ✅ Shipped | `DecisionCard` component renders rationale + evidence + next-action buttons; `ChatPanel.tsx:382-385` routes brain responses to `DecisionCard` |
| Atlas plugin `wi_decide` tool | 70-02 | ✅ Shipped | `src/openclaw/plugin/src/wi-tools.ts:25–140`; thin wrapper around `POST /api/brain/decide` |
| MCP tool `get_decision` | 70-04 | ✅ Shipped | `src/tools/brain-get-decision.ts`; exposed via `src/server.ts` |

**Built**: 5 items &nbsp; **Pending**: — &nbsp; **Deviations**: none

### Pillar 2 — Context Injector

**Plans**: 69-02 (endpoint), 69-03 (cluster detector), 69-04 (sprint/stuck detectors), 70-01 (Atlas swap-in)

| Item | Plan | Status | Notes |
|------|------|--------|-------|
| `GET /api/brain/context` endpoint | 69-02 | ✅ Shipped | `web-server.js:2001`; TTL 60 s, all 7 fields populated; `src/services/brain/context-builder.ts` |
| Action-cluster detector service | 69-03 | ✅ Shipped | `src/services/brain/action-cluster-detector.ts`; persists to `brain_action_clusters` |
| Sprint-freshness + stuck-Jira detectors | 69-04 | ✅ Shipped | `src/services/brain/staleness-detectors.ts` (single file, not subdirectory — functionally identical); surfaces `stale_warnings` |
| Atlas plugin: `/api/brain/context` swap-in | 70-01 | ✅ Shipped | `src/openclaw/plugin/src/context-cache.ts` updated to call `/api/brain/context`; hook timing unchanged |
| MCP tool `get_context` | 70-04 | ✅ Shipped | `src/tools/brain-get-context.ts`; exposed via `src/server.ts` |

**Built**: 5 items &nbsp; **Pending**: — &nbsp; **Deviations**: 69-04 staleness detectors landed as `staleness-detectors.ts` (single file) instead of `staleness/*.ts` subdirectory — functionally equivalent, not a contract violation

### Pillar 3 — Verification Layer

**Plans**: 71-02 (real adapters), 70-02 (Atlas tool), 70-04 (MCP tool)

| Item | Plan | Status | Notes |
|------|------|--------|-------|
| `POST /api/brain/verify` with real adapters | 71-02 | ✅ Shipped | `web-server.js:2219`; `src/services/brain/verifiers/`: `github-verifier.ts`, `jira-verifier.ts`, `code-grep-verifier.ts`; circuit breaker at `circuit-breaker.ts`; persists to `brain_verifications`; evidence_needed format: `"adapter:target"` colon-separated pairs |
| Atlas plugin `wi_verify` tool | 70-02 | ✅ Shipped | `src/openclaw/plugin/src/wi-tools.ts:145–220`; thin wrapper around `POST /api/brain/verify` |
| MCP tool `verify_claim` | 70-04 | ✅ Shipped | `src/tools/brain-verify-claim.ts`; exposed via `src/server.ts` |

**Built**: 3 items &nbsp; **Pending**: — &nbsp; **Deviations**: build-log adapter deferred (no GitHub Actions integration yet); `evidence_needed` entries must be `"adapter:target"` format (bare adapter names cause parse error)

### Pillar 4 — Memory Decision Loop

**Plans**: 71-01 (learn endpoint), 71-05 (recall endpoint), 71-03 (proactive scan), 71-04 (UI badges), 70-02 (Atlas tools), 70-04 (MCP tools)

| Item | Plan | Status | Notes |
|------|------|--------|-------|
| `POST /api/brain/learn` endpoint | 71-01 | ✅ Shipped | `web-server.js:2160`; `src/services/brain/learn.ts`; records outcome on existing `decision_id`; 404 on unknown id; 400 on invalid outcome; `MemoryEnricher.enrichDecision()` adds 6th palace wing |
| `POST /api/brain/recall` endpoint | 71-05 | ✅ Shipped | `web-server.js:2269`; `src/services/brain/recall.ts`; aggregates palace + `brain_decisions` + `brain_action_clusters`, ranked by recency × confidence; live smoke returned 3 results with `source='palace'` |
| Proactive scan cron | 71-03 | ✅ Shipped | `src/services/brain/proactive-scan.ts`; `startProactiveScan` registered at `web-server.js:5646–5647`; 30-min interval, ≥ 0.85 confidence threshold, 24h per-cluster cooldown; SIGTERM-safe shutdown |
| Recurring-pattern badges in UI | 71-04 | ✅ Shipped (dormant) | `web/src/components/brain/RecurringPatternBadge.tsx`; integrated into `DecisionCard.tsx:68`; SQL JOIN on `brain_decisions` in `web-server.js:2064–2120`; dormant until `decision-engine.ts` attaches cluster signatures to evidence entries |
| Atlas plugin `wi_recall` tool | 70-02 | ✅ Shipped | `src/openclaw/plugin/src/wi-tools.ts:222+`; thin wrapper around `POST /api/brain/recall` |
| MCP tools `recall_memory` + `record_outcome` | 70-04 | ✅ Shipped | `src/tools/brain-recall-memory.ts` + `src/tools/brain-record-outcome.ts`; exposed via `src/server.ts` |

**Built**: 6 items &nbsp; **Pending**: — &nbsp; **Deviations**: `RecurringPatternBadge` is wired but dormant — activates once `decision-engine.ts` attaches cluster `.signature` to evidence entries and `/api/brain/learn` is called with real outcomes

### Foundation (cross-pillar)

| Item | Plan | Status | Notes |
|------|------|--------|-------|
| Schema v45 migration | 69-01 | ✅ Shipped | `src/db/migrations/v45_brain_tables.ts`; `brain_decisions` (with `cache_key UNIQUE`, `user`, `day_iso`), `brain_action_clusters`, `brain_verifications`, `brain_user_budget_ledger`; idempotent + rollback safe |
| Smoke test suite + single-consumer baseline | 69-06 | ✅ Shipped | `tests/brain/smoke.test.ts` + `tests/brain/fixtures.ts`; curl tests, latency budget, `consumer='ui'` baseline only — cross-consumer parity in 70-05 |
| Cross-consumer parity test | 70-05 | ✅ Shipped | `tests/brain/parity.test.ts`; 3 test cases (P1: identical `decision_id` across UI/Atlas/MCP; P2: single DB row confirms cache deduplication; P3: distinct questions → distinct `decision_id`s); graceful skip when bridge unreachable |

**Built**: 3 items &nbsp; **Pending**: — &nbsp; **Deviations**: none

### Future Extensions (post-v1.1)

- 6th palace wing (`decisions`) becomes the seed for cross-session decision recall in chat
- Verification adapters could grow a 5th source (CI build logs from GitHub Actions) once EP-43 lands
- `brain_action_clusters.root_cause` could be auto-populated by the OrchestratorAgent (ADR-017) when it encounters a high-count signature

---

## Related

- [ADR-016: Second Brain Architecture](./adr-016-second-brain-architecture.md)
- [ADR-017: Always-On Agent Architecture](./adr-017-always-on-agent-architecture.md)
- [ADR-022: Dual-Engine Investigation](./adr-022-dual-engine-investigation.md)
- [ADR-023: OpenClaw Plugin](./adr-023-openclaw-plugin.md)
