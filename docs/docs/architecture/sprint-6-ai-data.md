---
sidebar_position: 5
title: Sprint 6 — AI & Data Architecture Guide
---

# Sprint 6: AI & Data Architecture Guide

This document is the centralized implementation guide for Sprint 6. It contains:
- Dependency graph for parallel agent execution
- Per-epic agent-ready prompts with exact file paths, function signatures, SQL DDL, and acceptance criteria
- Schema migration plan (v16 → v21)

Multiple agents can work in parallel — see the wave plan below.

---

## Parallel Execution Plan

```
Wave 1 (start immediately, fully parallel):
  Agent A: EP-31 Architecture Hardening (any of 8 tickets independently)
  Agent B: EP-32 Token Usage Tracking
  Agent C: EP-40 AI Resilience & Model Hygiene

Wave 2 (start after Wave 1 kicks off, fully parallel):
  Agent D: EP-33 Data Quality & Observability
  Agent E: EP-34 Relevance-Ranked Context
  Agent F: EP-35 Action Item Confidence Triage
  Agent G: EP-36 Notebook Auto-Refresh

Wave 3 (after EP-32 schema v17 is merged):
  Agent H: EP-37 Semantic Search (needs token_usage table instrumented)
  Agent I: EP-38 Weekly Pattern Analysis (uses token stats)

Wave 4 (after EP-37 merged):
  Agent J: EP-39 Cross-Topic Relationship Detection
```

---

## Schema Migration Plan

| Version | Epic | Tables Added / Changed |
|---------|------|----------------------|
| v16 | EP-30 (done) | `teams_fav_keywords` |
| **v17** | EP-32 | `token_usage` |
| **v18** | EP-33 | `ingestion_log`, `data_quality`, `messages.subject` (FTS) |
| **v19** | EP-35 | `action_items.confidence`, `.confirmed`, `.confirmed_at`, status enum adds `pending_review`/`dismissed` |
| **v20** | EP-37 | `message_embeddings`, `messages_vec` (sqlite-vec virtual table) |
| **v21** | EP-39 | `topic_relationships` |

All migrations follow the existing pattern in `src/db/schema.ts`:
```typescript
if (currentVersion < N) {
  db.exec(`ALTER TABLE ... / CREATE TABLE ...`);
  db.prepare(`UPDATE schema_version SET version = N`).run();
}
```

---

## EP-31: Architecture Hardening

**Full doc**: [EP-31](../epics/ep31-architecture-hardening)  
**No schema change. All 8 tickets are independent — assign to separate agents.**

### EP-31-1: Zod Validation on POST Endpoints
**File**: `web-server.js` (all 16 POST/PUT handlers)  
**Pattern**:
```typescript
import { z } from 'zod';
const schema = z.object({ topicName: z.string().min(1), ... });
const parsed = schema.safeParse(req.body);
if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
```
**Acceptance**: all 16 POST/PUT handlers have Zod schemas; invalid input returns 400 (not 500); `npm run typecheck` passes.

### EP-31-2: ResourceCache Class
**New file**: `src/lib/resource-cache.ts`
```typescript
export class ResourceCache<T> {
  constructor(private ttlMs: number) {}
  get(key: string): T | null
  set(key: string, value: T): void
  invalidate(key: string): void
  invalidateAll(): void
}
```
Replace 5 hand-rolled cache objects in `web-server.js` (search for `let.*Cache =` / `Map<string`).

### EP-31-3: Structured JSON Logger
**New file**: `src/lib/logger.ts`
```typescript
export const logger = {
  info: (msg: string, meta?: object) => process.stderr.write(JSON.stringify({ level: 'info', msg, ...meta, ts: new Date().toISOString() }) + '\n'),
  warn: ...,
  error: ...,
}
```
Replace all `process.stderr.write(...)` and `console.error(...)` in `src/` with `logger.*`.

### EP-31-4: Split queries.ts
**Current**: `src/db/queries.ts` (1047 lines, ~14 domains)  
**Target**: `src/db/queries/` directory with files:
- `messages.ts`, `meetings.ts`, `topics.ts`, `action-items.ts`, `digests.ts`
- `notebooks.ts`, `calendar.ts`, `group-chats.ts`, `jira.ts`
- `errors.ts`, `sync-state.ts`, `schema-version.ts`, `fav-keywords.ts`
- `index.ts` (re-exports everything)

### EP-31-5: AnalysisService
**New file**: `src/services/analysis-service.ts` wrapping `AIAnalyzer` with `max_tokens: 4096` on all calls.  
**Acceptance**: no Anthropic SDK call in `web-server.js` — all go through `AnalysisService`.

### EP-31-6: Split web-server.js into Routes
**Target**: `src/routes/` with:
- `digest.ts`, `notebooks.ts`, `jira.ts`, `teams.ts`
- `calendar.ts`, `sync.ts`, `topics.ts`, `errors.ts`
- `web-server.js` becomes ~150-line entry point registering routes.

### EP-31-7: withRetry + Exponential Backoff
**File**: `src/services/analysis-service.ts`
```typescript
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === maxAttempts - 1) throw err;
      await sleep(Math.pow(2, i) * 1000 + Math.random() * 500);
    }
  }
}
```
Wrap all `AIAnalyzer` method calls in `AnalysisService`.

### EP-31-8: Hono Router
Replace 31 `if (req.method === 'GET' && req.url.startsWith('/api/...')` blocks with Hono router.  
Add `prebridge` npm script: `"prebridge": "npm run build"` to ensure fresh build before web server.

---

## EP-32: Token Usage Tracking

**Full doc**: [EP-32](../epics/ep32-token-usage-tracking)  
**Schema**: v17 — adds `token_usage` table  
**Start here for Sprint 6 — other epics depend on this instrumentation.**

### Schema (add to `src/db/schema.ts` migration v17)
```sql
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  topic_name TEXT,
  called_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_token_usage_method ON token_usage(method);
CREATE INDEX IF NOT EXISTS idx_token_usage_called_at ON token_usage(called_at);
```

### Code changes — `src/services/analyzer.ts`
```typescript
// Cost rates per 1K tokens (USD)
const TOKEN_COSTS_PER_1K: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-haiku-latest':   { input: 0.00025, output: 0.00125, cacheRead: 0.00003, cacheWrite: 0.0003 },
  'claude-sonnet-latest':  { input: 0.003,   output: 0.015,   cacheRead: 0.0003,  cacheWrite: 0.00375 },
};

function computeCost(model: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  const rates = TOKEN_COSTS_PER_1K[model] ?? TOKEN_COSTS_PER_1K['claude-sonnet-latest'];
  return (
    (usage.inputTokens / 1000) * rates.input +
    (usage.outputTokens / 1000) * rates.output +
    (usage.cacheReadTokens / 1000) * rates.cacheRead +
    (usage.cacheWriteTokens / 1000) * rates.cacheWrite
  );
}

// Private method — call after every API response
private _track(db: Database, method: string, model: string, response: any, topicName?: string): void {
  const u = response.usage;
  const cost = computeCost(model, { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 });
  db.prepare(`INSERT INTO token_usage (method, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_cost_usd, topic_name) VALUES (?,?,?,?,?,?,?,?)`)
    .run(method, model, u.input_tokens, u.output_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, cost, topicName ?? null);
}
```

### New endpoints — `web-server.js`
- `GET /api/token-stats?since=7d` → `{ total_cost_usd, by_method: [...], by_model: [...], period_days }`
- `GET /api/token-stats/history?days=30` → daily breakdown for chart

### New UI component — `web/src/components/TokenStatsWidget.tsx`
- Total cost this week (large number)
- Bar chart: cost by method (digest / notebook / chat / extraction)
- Estimated monthly projection

---

## EP-33: Data Quality & Pipeline Observability

**Full doc**: [EP-33](../epics/ep33-data-quality-observability)  
**Schema**: v18 — adds `ingestion_log`, `data_quality` tables; adds `messages.subject` for FTS

### Key tables (add to schema.ts migration v18)
```sql
-- Per-run stats
CREATE TABLE IF NOT EXISTS ingestion_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  run_at TEXT NOT NULL DEFAULT (datetime('now')),
  messages_fetched INTEGER NOT NULL DEFAULT 0,
  messages_inserted INTEGER NOT NULL DEFAULT 0,
  messages_duplicate INTEGER NOT NULL DEFAULT 0,
  messages_error INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error_message TEXT
);

-- Per-row anomalies
CREATE TABLE IF NOT EXISTS data_quality (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER REFERENCES messages(id),
  meeting_id INTEGER REFERENCES meetings(id),
  rule TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('warning','error')),
  detail TEXT,
  resolved_at TEXT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Add subject column to messages for richer FTS
ALTER TABLE messages ADD COLUMN subject TEXT;
```

### Quality rules — `src/lib/quality-checks.ts`
```typescript
export type QualityRule = 'content_truncated' | 'null_assignee' | 'short_transcript' | 'missing_source_id' | 'garbled_content';

export function checkMessage(msg: MessageRow): QualityIssue[] // checks content_truncated, garbled_content, missing_source_id
export function checkMeeting(meeting: MeetingRow): QualityIssue[] // checks short_transcript (< 200 chars), garbled_content
export function checkActionItem(item: ActionItemRow): QualityIssue[] // checks null_assignee
```

### Endpoints
- `GET /api/data-quality?status=open&limit=50` → list unresolved issues
- `POST /api/data-quality/:id/resolve` → mark resolved

---

## EP-34: Relevance-Ranked Context Injection

**Full doc**: [EP-34](../epics/ep34-relevance-ranked-context)  
**No schema change.**

### New file — `src/tools/context-ranker.ts`
```typescript
export interface ScoredItem {
  item: ContextItem;
  bm25Score: number;        // from FTS rank column (normalized 0–1)
  recencyScore: number;     // e^(-0.1 × days_old), range 0–1
  combinedScore: number;    // 0.7 × normalizedBm25 + 0.3 × recencyScore
}

export function rankAndTruncate(
  items: ContextItem[],
  query: string,
  opts: { maxTokens: number; semanticWeight?: number }
): ContextItem[]
```

### Integration points (update these callers)
- `src/tools/digest.ts` — replace `messages.slice(0, 100)` with `rankAndTruncate(messages, topic, { maxTokens: 8000 })`
- `web-server.js` `/api/notebooks/:topicName/chat` — replace `{ limit: 20 }` FTS with ranked context
- `src/tools/teams-updates.ts` — apply ranking before passing to AI summarizer

### BM25 score normalization
FTS5 rank values are negative (lower = better match). Normalize: `normalizedBm25 = 1 / (1 + Math.abs(rank))`.  
Recency: `recencyScore = Math.exp(-0.1 × daysOld)` where `daysOld = (now - message.timestamp) / 86400000`.

---

## EP-35: Action Item Confidence Triage

**Full doc**: [EP-35](../epics/ep35-action-item-triage)  
**Schema**: v19 — adds `confidence`, `confirmed`, `confirmed_at` columns; new status values

### Schema changes (migration v19)
```sql
ALTER TABLE action_items ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
ALTER TABLE action_items ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE action_items ADD COLUMN confirmed_at TEXT;
-- status CHECK constraint update: add 'pending_review', 'dismissed'
```

### AI changes — `src/services/analyzer.ts`
Update `detectActionItems()` tool definition to return `confidence: number` (0.0–1.0) per action item.  
Threshold: `confidence < 0.65` → insert with `status = 'pending_review'`.

### Auto-promote — `web-server.js`
```javascript
// In runFullSync(), after action item detection:
autoPromotePendingItems(db, 48); // promote items pending > 48h to 'open'
```

### New UI widget — `web/src/components/PendingReviewWidget.tsx`
- Lists action items with `status = 'pending_review'` and their confidence scores
- ✓ Confirm button → `PATCH /api/action-items/:id` sets `confirmed=1`, `status='open'`
- ✗ Dismiss button → `PATCH /api/action-items/:id` sets `status='dismissed'`

---

## EP-36: Notebook Auto-Refresh & Pre-Brief Enhancement

**Full doc**: [EP-36](../epics/ep36-notebook-auto-refresh)  
**No schema change.**

### Change 1 — `web-server.js`: wire notebooks into `runFullSync()`
```javascript
// After Teams sync and calendar sync complete (step 5 of runFullSync):
const topics = db.prepare('SELECT name FROM topics').all();
await Promise.allSettled(
  topics.map(t => getOrBuildNotebook(db, t.name, analyzer))
);
```
`Promise.allSettled` — fire-and-forget; failures don't block sync completion.

### Change 2 — `web-server.js`: pass notebook to `generatePreBrief()`
```typescript
// Find notebook for calendar event topic, pass as context
async function generatePreBriefWithNotebook(db: Database, event: CalendarEvent, analyzer: AIAnalyzer): Promise<string> {
  const topicName = findTopicForEvent(db, event); // keyword-match event title → topics table
  const notebook = topicName ? getNotebook(db, topicName) : null;
  return analyzer.generatePreBrief(event, notebook?.content);
}
```

### Change 3 — `src/services/analyzer.ts`: update `generatePreBrief()` signature
```typescript
async generatePreBrief(event: CalendarEvent, notebookContent?: string): Promise<string>
```
When `notebookContent` provided, inject as first system block with `cache_control: ephemeral`.

---

## EP-37: Semantic Search via Embeddings

**Full doc**: [EP-37](../epics/ep37-semantic-search)  
**Schema**: v20 — adds `message_embeddings`, `messages_vec`  
**Requires**: `OPENAI_API_KEY` env var; sqlite-vec npm package  
**Depends on**: EP-32 (token tracking must be in place)

### Schema (migration v20)
```sql
CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,  -- float32[1536] little-endian
  model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- sqlite-vec virtual table for cosine distance queries
CREATE VIRTUAL TABLE IF NOT EXISTS messages_vec USING vec0(
  embedding float[1536]
);
```

### New file — `src/services/embedder.ts`
```typescript
import OpenAI from 'openai';

export class EmbeddingService {
  constructor(private openai: OpenAI) {}

  async embed(text: string): Promise<Float32Array>
  async embedBatch(texts: string[]): Promise<Float32Array[]>  // batches of 100

  // Store embeddings for messages that don't have one yet
  async syncEmbeddings(db: Database, batchSize = 100): Promise<{ embedded: number; skipped: number }>
}
```

### New file — `src/tools/semantic-search.ts`
```typescript
export async function hybridSearch(
  db: Database,
  embedder: EmbeddingService,
  query: string,
  opts: { limit?: number; semanticWeight?: number; ftsWeight?: number }
): Promise<MessageRow[]>
// Default: semanticWeight=0.6, ftsWeight=0.4
// Returns top `limit` results re-ranked by combined score
```

### Background embedding script — `scripts/embed-existing.ts`
```bash
npx tsx scripts/embed-existing.ts  # embed all un-embedded messages in batches
```

### Integration
- Wire `EmbeddingService` into `web-server.js` (instantiate with `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })`)
- In `runFullSync()`: call `embedder.syncEmbeddings(db)` at the end (after Teams/calendar sync)
- Replace FTS-only search in `GET /api/search-all` with `hybridSearch()` when `OPENAI_API_KEY` is set

---

## EP-38: Weekly Pattern Analysis

**Full doc**: [EP-38](../epics/ep38-weekly-pattern-analysis)  
**No schema change** (uses existing `digests` table for caching)  
**Depends on**: EP-32 (token tracking integrated; cost: ~$0.02/report)

### New AI method — `src/services/analyzer.ts`
```typescript
export interface WeeklyStats {
  weekOf: string;              // ISO date, Monday of the week
  openQuestions: ActionItemRow[];
  overdueItems: ActionItemRow[];
  emptyMeetings: MeetingRow[];
  messageVolume: { date: string; source: string; count: number }[];
  tokenCostThisWeek?: number;  // from token_usage table (EP-32)
}

async generateWeeklyReport(stats: WeeklyStats): Promise<string>
// Model: DIGEST_MODEL (Sonnet), ~$0.02/call
// Returns: structured markdown report with patterns + recommendations
```

### SQL aggregations (run in parallel)
```sql
-- open_questions
SELECT * FROM action_items WHERE status = 'open' AND due_date IS NOT NULL ORDER BY due_date ASC LIMIT 20;
-- overdue_items
SELECT * FROM action_items WHERE status = 'open' AND due_date < datetime('now') LIMIT 20;
-- empty_meetings
SELECT * FROM meetings WHERE (transcript IS NULL OR length(transcript) < 100) AND date >= date('now', '-7 days');
-- message_volume
SELECT date(timestamp) as date, source, COUNT(*) as count FROM messages WHERE timestamp >= date('now', '-7 days') GROUP BY date, source ORDER BY date;
```

### New endpoint — `web-server.js`
```javascript
GET /api/weekly-report?weekOf=YYYY-MM-DD
// → withStaleFallback(() => generateReport(), () => getCachedDigest(db, '__weekly_report__', weekOf))
// Cache TTL: 7 days (auto-regenerated in runFullSync every Monday)
```

### New page — `web/src/pages/WeeklyReportPage.tsx`
- Route: `/weekly-report`
- Shows: weekly summary markdown + `TokenStatsWidget` (if EP-32 done)
- Add to sidebar nav

---

## EP-39: Cross-Topic Relationship Detection

**Full doc**: [EP-39](../epics/ep39-cross-topic-relationships)  
**Schema**: v21 — adds `topic_relationships`  
**Depends on**: EP-37 (semantic embeddings)

### Schema (migration v21)
```sql
CREATE TABLE IF NOT EXISTS topic_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_a TEXT NOT NULL,
  topic_b TEXT NOT NULL,
  relationship_type TEXT NOT NULL CHECK(relationship_type IN ('jira_overlap', 'semantic_similarity', 'shared_people')),
  strength REAL NOT NULL CHECK(strength BETWEEN 0 AND 1),
  evidence TEXT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(topic_a, topic_b, relationship_type)
);
CREATE INDEX IF NOT EXISTS idx_topic_rel_a ON topic_relationships(topic_a);
CREATE INDEX IF NOT EXISTS idx_topic_rel_b ON topic_relationships(topic_b);
```

### Detection methods — `src/tools/relationship-detector.ts`
```typescript
// Method 1: Jira key overlap
export function detectJiraOverlaps(db: Database): TopicRelationship[]
// For each pair of topics, extract Jira keys via regex /[A-Z]+-\d+/ from messages
// Strength = |intersection| / |union| (Jaccard similarity)

// Method 2: Semantic similarity (requires EP-37)
export async function detectSemanticRelationships(
  db: Database, embedder: EmbeddingService, threshold = 0.75
): Promise<TopicRelationship[]>
// Compare average notebook embeddings between topics
// Keep pairs with cosine similarity >= threshold
```

### UI — `web/src/pages/TopicExpertPage.tsx`
Add "Related Topics" panel below the notebook (left panel):
```
Related Topics
──────────────
● BDS (jira overlap: 12 shared issues, strength 0.8)
● Platform (semantic similarity: 0.82)
```

---

## EP-40: AI Resilience & Model Hygiene

**Full doc**: [EP-40](../epics/ep40-ai-resilience-model-hygiene)  
**No schema change. Can start immediately — no dependencies.**

### Change 1 — `src/services/analyzer.ts`: notebook context in `chatWithContext()`
```typescript
async chatWithContext(
  message: string,
  history: ChatTurn[],
  contextItems: ContextItem[],
  notebookContent?: string  // NEW
): Promise<{ reply: string; suggestedFollowUps: string[] }>
```
When `notebookContent` provided:
```typescript
const systemBlocks: PromptCachingBetaTextBlockParam[] = [];
if (notebookContent) {
  systemBlocks.push({ type: 'text', text: `## Project Knowledge Base\n\n${notebookContent}`, cache_control: { type: 'ephemeral' } });
}
systemBlocks.push({ type: 'text', text: `## Recent Context\n\n${formatContextItems(contextItems)}`, cache_control: { type: 'ephemeral' } });
```

### Change 2 — `web-server.js`: stale-on-error fallback
```javascript
async function withStaleFallback(freshFn, getCached, label) {
  try {
    const data = await freshFn();
    return { data, stale: false };
  } catch (err) {
    logger.error(`[${label}] AI failed, trying stale fallback`, { error: err.message });
    const cached = getCached();
    if (cached) return { data: cached, stale: true, stale_reason: 'ai_error' };
    throw err;
  }
}
```
Apply to: `GET /api/digest`, `GET /api/morning-brief`, `GET /api/weekly-report`, `GET /api/notebooks/:topicName`.

### Change 3 — `src/services/analyzer.ts`: use model aliases
```typescript
const EXTRACTION_MODEL = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? 'claude-haiku-latest';
const DIGEST_MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'claude-sonnet-latest';
```

### Change 4 — `web/src/pages/TopicExpertPage.tsx`: stale banner
```tsx
{response.stale && (
  <div style={{ color: 'var(--muted)', fontSize: '0.75rem', padding: '4px 8px' }}>
    ⚠ Showing cached version — AI unavailable
  </div>
)}
```

### Change 5 — `web/src/lib/api.ts`: extend response types
```typescript
// Add to TopicNotebook, DigestResponse, MorningBriefResponse:
stale?: boolean;
stale_reason?: string;
cached_at?: string;
```

---

## Environment Variables Required for Sprint 6

| Variable | Used By | Required? |
|----------|---------|-----------|
| `ANTHROPIC_API_KEY` | All AI calls | ✅ Already set |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | EP-40 model routing | Optional (fallback: `claude-haiku-latest`) |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | EP-40 model routing | Optional (fallback: `claude-sonnet-latest`) |
| `OPENAI_API_KEY` | EP-37 embeddings only | Required for EP-37 |
| `DATABASE_PATH` | All DB operations | ✅ Already set |

---

## Connected Repositories (Sprint 7 prerequisite)

Before starting Sprint 7 (EP-43+), set up the `./repos/` workspace:

```bash
# One-time setup (copy, don't checkout)
cp -r ~/Desktop/projects/acme/example-service repos/example-service
cp -r ~/Desktop/projects/acme/operations repos/operations

# Refresh when needed
cd repos/example-service && git pull && cd ../..
cd repos/operations && git pull && cd ../..
```

The `repos/` folder is gitignored — MCP owns it as a local workspace. All branches, test runs, and PR creation happen inside `repos/`, never touching your active working copies.

Add to `.env` when starting Sprint 7:
```
example-service_PATH=./repos/example-service
OPERATIONS_PATH=./repos/operations
GITHUB_TOKEN=ghp_...
example-service_GITHUB=org/example-service
OPERATIONS_GITHUB=org/operations
```

---

## Definition of Done for Sprint 6

Each epic ticket is **Done** when:

1. `npm run typecheck` passes with zero errors
2. `npm run lint` passes (oxlint)
3. Schema migration runs cleanly on existing DB (no data loss)
4. All acceptance criteria checkboxes in the epic doc are checked
5. No untyped `any` without explanatory comment
6. `UnifiedMessage` shape and `DataSource` interface unchanged
7. New endpoints documented in `api-reference/index.md`
