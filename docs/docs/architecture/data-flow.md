---
sidebar_position: 2
title: Data Flow
---

# Data Flow

> Companion to [`architecture/index.md`](./index) — focuses on **sequence flows**: how data moves through the four stages (Fetch → Process → Analyze → Propose) for each major path.

Quick links to flows on this page:
1. [Teams sync](#teams-sync-flow-npm-run-teams-sync) · [Teams query](#query-flow--get_teams_updates)
2. [Jira report](#query-flow--get_jira_report) · [Dedup](#deduplication) · [FTS5](#fts5-search)
3. [Missing transcript detection](#missing-transcript-detection)
4. [Topic notebook build](#topic-notebook-build--update-flow-ep-26--ep-36) · [Topic chat](#topic-chat-flow-ep-26--ep-40)
5. [Semantic search](#semantic-search-flow-ep-37) · [Weekly pattern](#weekly-pattern-analysis-flow-ep-38) · [Stale fallback](#stale-on-error-fallback-flow-ep-40)
6. [Cross-repo knowledge sync](#cross-repo-knowledge-sync-flow) · [CDC pipeline](#cdc-pipeline-flow-ep-63) · [Agent orchestration](#agent-orchestration-flow-ep-6465)
7. [OpenClaw plugin](#openclaw-plugin-layer) · [Unified Brain decide](#unified-brain-decide-flow-adr-024)

---

## Teams Sync Flow (`npm run teams-sync`)

Triggered manually or on a schedule. Opens Teams in a browser session and scrapes all (or unread) group chats.

```mermaid
sequenceDiagram
    participant CLI as teams-sync CLI
    participant CS as TeamsChatScraper
    participant MS as TeamsMeetingsScraper
    participant AI as Claude Haiku
    participant DB as SQLite v46

    CLI->>CS: scrapeChats({ unreadOnly, sinceDays })
    CS->>CS: Open teams.microsoft.com/v2/
    CS->>CS: Scroll sidebar to load all chats
    loop For each chat
        CS->>CS: Click chat, scroll-up to load messages
        CS->>CS: Check for Recap tab (3s timeout)
        alt Recap tab present
            CS->>MS: scrapeRecapTab(page, chatName)
            MS->>MS: Click Transcript / Notes / Speakers pills
            MS->>AI: analyzeMeeting(transcript)
            AI-->>MS: { summary, topics, decisions, actionItems }
        end
        CS-->>CLI: ScrapedChat { messages[], meeting? }
    end
    CLI->>DB: upsertGroupChat()
    CLI->>DB: upsertMessage() per message
    CLI->>DB: upsertMeeting() if recap scraped
    CLI->>DB: markInactiveChats()
```

## Query Flow — `get_teams_updates`

All queries run against the local SQLite cache. No live fetching on query.

```mermaid
sequenceDiagram
    participant U as User
    participant CD as Claude Desktop
    participant MCP as MCP Server
    participant DB as SQLite FTS5
    participant AI as Claude Sonnet

    U->>CD: "What happened in the KBA handling meeting?"
    CD->>MCP: get_teams_updates({ query: "KBA handling meeting" })
    MCP->>DB: FTS5 MATCH on messages_fts + meetings_fts
    alt No FTS results
        MCP->>DB: LIKE fallback on messages + meetings
    end
    DB-->>MCP: MessageRow[], MeetingRow[]
    MCP->>MCP: Check for chats with meeting signals but no transcript
    MCP->>AI: Summarize results for query
    AI-->>MCP: Structured summary
    MCP-->>CD: Markdown response (summary + messages + meetings + missing transcript prompts)
    CD-->>U: "Here are the relevant updates..."
```

## Query Flow — `get_jira_report`

Live-fetches from Jira, persists to DB, then generates report.

```mermaid
sequenceDiagram
    participant U as User
    participant MCP as MCP Server
    participant JC as JiraBrowserConnector
    participant DB as SQLite
    participant AI as Claude Sonnet

    U->>MCP: get_jira_report({ projectKey, boardUrl })
    MCP->>JC: fetchMessages(boardUrl, since)
    JC->>JC: Playwright → Jira board page
    JC-->>MCP: UnifiedMessage[] (issues)
    loop For each issue
        MCP->>DB: upsertMessage() — INSERT OR IGNORE on source_id
    end
    MCP->>AI: Analyze issues for team health summary
    AI-->>MCP: Summary text
    MCP-->>U: Full markdown report (8 sections)
```

## Deduplication

Messages are deduplicated at the DB layer using a `UNIQUE(source, source_id)` constraint:

- **Teams messages**: `source_id` = `sha256(chat|sender|timestamp|contentPrefix).slice(0,16)`
- **Teams meetings**: `source_id` = `chatName|datetime`
- **Jira**: `source_id` = Jira issue key (e.g. `PROJ-123`)
- **Outlook**: `source_id` = internet message ID or hash of sender+subject+date

`upsertMessage()` / `upsertMeeting()` use `INSERT OR IGNORE` — duplicates are silently skipped.

## FTS5 Search

After each insert, triggers keep the FTS5 virtual tables in sync:

```mermaid
graph LR
    A[INSERT INTO messages] --> B[AFTER INSERT trigger]
    B --> C[INSERT INTO messages_fts]
    D[UPDATE messages] --> E[AFTER UPDATE trigger]
    E --> F[UPDATE messages_fts]

    style C fill:#374151,color:#fff
    style F fill:#374151,color:#fff
```

Search uses BM25 ranking; falls back to LIKE when FTS returns zero results (e.g. very short queries).

## Missing Transcript Detection

There are two complementary mechanisms for detecting meetings without transcripts.

### Proactive: Alert Feed (Rule 5)

After every sync, `generateAlerts()` runs Rule 5 — a scan of `calendar_events` for meetings that have already ended:

```mermaid
sequenceDiagram
    participant Sync as runFullSync()
    participant GA as generateAlerts()
    participant DB as SQLite
    participant UI as Dashboard AlertFeed

    Sync->>GA: called at step 6 of every sync
    GA->>DB: SELECT past calendar_events (end_time < now, within 7 days)
    loop For each past event
        GA->>DB: SELECT meetings WHERE chat_name/title LIKE keyword AND transcript > 100 chars
        alt No matching transcript
            GA->>GA: add to missingTranscripts list
        end
    end
    GA-->>UI: { type: 'missing_transcript', severity: 'warning',\n  title: '3 meetings missing transcript',\n  body: 'KBA planning, Sprint review… +1 more',\n  link: '/teams-updates' }
```

The alert appears in the `AlertFeed` on the dashboard as a yellow warning. Clicking it navigates to `/teams-updates`.

**Matching logic**: takes the first keyword (> 3 chars) from the calendar event title and does a `LIKE` check against `meetings.chat_name` and `meetings.title`. A transcript is considered present when `length(transcript) > 100`.

---

### Reactive: In-query detection (`get_teams_updates`)

When `get_teams_updates` is called, it also checks the matched messages for meeting signals:

1. Collects unique chat names from FTS-matched messages
2. Checks if each chat has a `meetings` row with `length(transcript) > 100`
3. If not, scans the chat's last 50 messages for meeting keywords: `transcript`, `recording`, `recap`, `meeting notes`, `action item`, `follow-up`, `attendees`, `agenda`, `minutes`, `presentation`, `shared screen`
4. Surfaces a prompt in the MCP response:

```
## Missing Transcripts

- **KBA handling in BiS technical setup**: Open Teams → Recap tab → copy transcript → paste here.
```

This lets the user provide transcripts for chats where Teams Premium is required for automatic recording, or where the Recap tab did not appear during the sync. The pasted transcript is available in the current conversation context but is not automatically saved to the DB.

---

## Topic Notebook Build & Update Flow (EP-26 / EP-36)

Notebooks are Claude's persistent memory per topic — built once, updated incrementally on every sync.

```mermaid
sequenceDiagram
    participant Sync as runFullSync()
    participant NB as getOrBuildNotebook()
    participant DB as SQLite
    participant AI as Claude Sonnet
    participant UI as TopicExpertPage

    Sync->>NB: for each topic (Promise.allSettled — fire-and-forget)
    NB->>DB: getNotebook(topicName)
    alt No notebook exists
        NB->>DB: SELECT all messages + meetings for topic
        NB->>AI: buildNotebook(topicName, messages, meetings)
        AI-->>NB: full notebook markdown (7 sections)
        NB->>DB: saveNotebook(topicName, content, lastMessageId, count)
    else Notebook exists
        NB->>DB: SELECT messages WHERE id > last_message_id
        alt New messages found
            NB->>AI: updateNotebook(topicName, existingNotebook, newMessages)
            AI-->>NB: merged/updated notebook markdown
            NB->>DB: saveNotebook(topicName, updatedContent, newLastId, newCount)
        else No new messages
            NB-->>Sync: return cached notebook (no AI call)
        end
    end
    UI->>DB: GET /api/notebooks/:topicName
    DB-->>UI: { content, last_updated, message_count, fresh }
    UI->>UI: render left panel (MarkdownPanel)
```

**Key property**: Claude reads its previous notebook + new data and writes a merged version. It does not regenerate from scratch — this is the **incremental LLM memory update** pattern.

**Pre-brief integration (EP-36)**: after notebook refresh, `generatePreBrief(event, notebookContent?)` uses the notebook as additional context when generating calendar event pre-briefs.

---

## Topic Chat Flow (EP-26 / EP-40)

```mermaid
sequenceDiagram
    participant U as User
    participant UI as TopicExpertPage (Chat panel)
    participant API as POST /api/notebooks/:topicName/chat
    participant DB as SQLite FTS5
    participant AI as Claude Sonnet

    U->>UI: types message in chat panel
    UI->>API: { message, history: ChatTurn[] }
    API->>DB: getNotebook(topicName) — notebook as system context
    API->>DB: searchMessages(message, { limit: 20 }) — FTS5 recent context
    API->>AI: chatWithContext(message, history, ftsResults, notebookContent)
    Note over AI: System block 1: notebook (cache_control: ephemeral)<br/>System block 2: FTS context (cache_control: ephemeral)<br/>Human: message + conversation history
    AI-->>API: { reply, suggestedFollowUps }
    API-->>UI: { reply, suggestedFollowUps }
    UI->>UI: append to conversation, show follow-up chips
```

**Impact**: Chat answers are grounded in project history (decisions, blockers, key people) rather than just keyword-matched recent messages.

---

## Semantic Search Flow (EP-37)

Shipped Sprint 6. Requires Ollama (local embedder) and `sqlite-vec` extension. When unavailable, `embeddingsAvailable: false` on `/api/status` and FTS5 takes over.

```mermaid
sequenceDiagram
    participant Q as Query (any search endpoint)
    participant ES as EmbeddingService
    participant DB as SQLite (messages_vec)
    participant FTS as SQLite FTS5
    participant RE as hybridSearch()

    Q->>RE: hybridSearch(query, { semanticWeight: 0.6, ftsWeight: 0.4, limit: 20 })
    RE->>ES: embed(query) → float32[1536]
    ES-->>RE: queryVector
    par Semantic search
        RE->>DB: SELECT id, distance FROM messages_vec<br/>WHERE embedding MATCH queryVector LIMIT 40
    and FTS5 search
        RE->>FTS: SELECT id, rank FROM messages_fts<br/>WHERE messages_fts MATCH query LIMIT 40
    end
    RE->>RE: normalize scores, combine:<br/>combinedScore = 0.6 × semanticScore + 0.4 × bm25Score
    RE->>DB: SELECT full message rows WHERE id IN (top 20 by combined score)
    RE-->>Q: ranked MessageRow[]
```

**Embedding pipeline**: new messages are embedded in the background by `EmbeddingService.embedBatch()` during sync. The `message_embeddings` table stores raw blobs; `messages_vec` is the sqlite-vec virtual table for cosine distance queries.

---

## Weekly Pattern Analysis Flow (EP-38)

Shipped Sprint 6.

```mermaid
sequenceDiagram
    participant UI as WeeklyReportPage
    participant API as GET /api/weekly-report
    participant DB as SQLite
    participant AI as Claude Sonnet
    participant Cache as digests table

    UI->>API: GET /api/weekly-report?weekOf=2026-04-14
    API->>Cache: getCachedDigest(db, '__weekly_report__', weekOf)
    alt Cached (within 7 days)
        Cache-->>API: cached markdown
        API-->>UI: { markdown, cached_at }
    else Not cached
        API->>DB: 4 aggregation queries (parallel)
        Note over DB: 1. open_questions: action_items WHERE status='open'<br/>2. overdue_items: due_date < now<br/>3. empty_meetings: meetings WHERE transcript IS NULL<br/>4. message_volume: COUNT grouped by date + source
        DB-->>API: WeeklyStats object
        API->>AI: generateWeeklyReport(stats)
        AI-->>API: structured report markdown
        API->>Cache: saveDigest(db, '__weekly_report__', weekOf, markdown)
        API-->>UI: { markdown }
    end
```

**Cost**: ~$0.02/report (cached 7 days, auto-regenerated weekly in `runFullSync`).

---

## Stale-on-Error Fallback Flow (EP-40)

Shipped Sprint 6. Applies to all read-only AI endpoints (digest, morning-brief, notebooks, weekly-report). Tracked gap (`GAP-P5` in `known-gaps`) — application is inconsistent: chat endpoint does not yet use it.

```mermaid
sequenceDiagram
    participant UI as Any page
    participant API as Read-only endpoint
    participant AI as Claude API
    participant Cache as SQLite digests/notebooks

    UI->>API: GET /api/digest | /api/morning-brief | /api/notebooks/:name
    API->>AI: freshFn() — generate new content
    alt AI succeeds
        AI-->>API: fresh content
        API-->>UI: { markdown, stale: false }
    else AI fails (network / rate limit / overload)
        API->>Cache: getCached() — look up last stored version
        alt Cache exists
            Cache-->>API: cached content
            API-->>UI: { markdown, stale: true, stale_reason: 'ai_error', cached_at }
            UI->>UI: show ⚠ "Showing cached version — AI unavailable" banner (var(--muted))
        else No cache
            API-->>UI: HTTP 500 — propagate error
        end
    end
```

**Rule**: stale fallback ONLY for read-only endpoints (digest, morning-brief, notebooks, weekly-report). Write operations (sync, configure-topic) must fail explicitly.

---

## Cross-Repo Knowledge Sync Flow

When Claude edits files in example-service or operations repos, a PostToolUse hook captures the event and pushes it to the bridge.

```mermaid
sequenceDiagram
    participant Claude as Claude Code Session
    participant Hook as PostToolUse Hook<br/>(knowledge-ingest.sh)
    participant Bridge as web-server.js :3132
    participant DB as SQLite (knowledge_events)
    participant KG as MemPalace KG

    Claude->>Claude: Edit/Write file in example-service/operations
    Claude->>Hook: PostToolUse fires (Edit|Write matcher)
    Hook->>Hook: Detect repo from file path
    Hook->>Bridge: POST /api/knowledge/ingest<br/>{repo, file, event, timestamp}
    Bridge->>DB: INSERT INTO knowledge_events
    Bridge->>KG: kgAdd(repo, 'file-edited', file, timestamp)
    Note over KG: Fire-and-forget — errors swallowed
    Bridge-->>Hook: 201 {ok: true}
```

## CDC Pipeline Flow (EP-63)

The Change Data Capture pipeline enables agents to react to data changes without polling external sources.

```mermaid
sequenceDiagram
    participant Sync as SyncService
    participant DB as SQLite
    participant CDC as changes_log (triggers)
    participant CW as ChangeWatcher (100ms)
    participant ASA as AlertScorerAgent
    participant AI as Claude Haiku
    participant PQ as proactive_queue
    participant SSE as GET /api/events

    Sync->>DB: INSERT INTO messages / jira_issues
    DB->>CDC: AFTER INSERT trigger fires
    Note over CDC: {table_name, row_id, operation, created_at}

    CW->>CDC: SELECT WHERE id > lastSeenId
    CDC-->>CW: ChangeEvent[]
    CW->>ASA: batch of changes by table

    ASA->>AI: Score severity (0–1)
    AI-->>ASA: severity score
    alt score >= 0.7
        ASA->>PQ: INSERT INTO proactive_queue
        PQ-->>SSE: Next SSE drain picks it up
        SSE-->>SSE: Push to connected browser tabs
    end
```

## Agent Orchestration Flow (EP-64/65)

The OrchestratorAgent provides multi-step reasoning via tool_use loops. CorrelationAgent uses it nightly to find cross-topic signals.

```mermaid
sequenceDiagram
    participant Timer as Nightly Timer (24h)
    participant CA as CorrelationAgent
    participant OA as OrchestratorAgent
    participant AI as Claude Haiku
    participant KG as MemPalace KG
    participant DB as SQLite
    participant PQ as proactive_queue

    Timer->>CA: fire (first run: T+5min, then every 24h)
    CA->>OA: execute(goal, tools)

    loop tool_use loop (max 10 iterations)
        OA->>AI: messages + available tools
        AI-->>OA: tool_use response
        OA->>OA: dispatch tool call
        alt tool = kg_query
            OA->>KG: query entities appearing in multiple topics (7d)
            KG-->>OA: shared entities
        else tool = cross_reference
            OA->>DB: SELECT related messages/issues
            DB-->>OA: context rows
        end
    end

    OA-->>CA: structured correlation results
    CA->>AI: Generate convergence digest
    AI-->>CA: "Here's what's converging" summary
    CA->>PQ: INSERT digest into proactive_queue
```

---

## OpenClaw Plugin Layer

The OpenClaw plugin sits as an external gateway layer on top of the bridge. It runs as a TypeScript plugin inside the OpenClaw daemon — no changes to the bridge server are required.

```
Messaging Channel (Telegram / Slack / Discord)
        ↓
OpenClaw Gateway (persistent daemon)
        ↓  ↑
  ┌─────────────────────────────────────┐
  │         Plugin Hooks                │
  │  message_received                   │  ← classify + route incoming messages
  │  before_prompt_build (60s TTL cache)│  ← inject action items + sprint context
  │  tool_result_persist                │  ← save to memory + ticket notes
  │  agent_end                          │  ← push summary; start poller if needed
  │  gateway_start                      │  ← register cron + slash commands
  └─────────────────────────────────────┘
        ↓  ↑  (fetch — circuit-breaker protected)
work-intelligence Bridge (port 3132)
        ↓
     SQLite + MemPalace
```

All plugin calls to the bridge are protected by a circuit breaker (3 failures → 30s open). The plugin is a pure client — it adds no server-side logic and requires no schema changes. See [ADR-023](../adr/adr-023-openclaw-plugin.md) for the full design.

After Phase 72 (ADR-025), the plugin's tool registration imports `TOOL_MANIFEST` directly from `src/tools/manifest.ts` — the same array consumed by `src/server.ts`. There is no string drift between MCP and Atlas: both register byte-identical descriptions, schemas, and endpoints.

---

## Unified Brain Decide Flow (ADR-024)

The primary query path post-Phase 71. Atlas and MCP clients both go through this flow when they need a decision rather than a lookup.

```mermaid
sequenceDiagram
    participant Client as Atlas / Claude Code
    participant API as get_decision / wi_brain_context
    participant DE as decision-engine.ts
    participant CB as context-builder.ts (TTL cache)
    participant Recall as recall.ts (palace + DB RRF)
    participant Verify as verify.ts (adapters)
    participant AI as Claude Sonnet (tool_use)
    participant Bud as brain_user_budget_ledger
    participant DB as brain_decisions + MemoryEnricher

    Client->>API: { question, user, context? }
    API->>DE: getDecision()

    Note over DE: cache_key = sha256(normalize(q) ‖ user ‖ utcDay)
    DE->>DB: SELECT FROM brain_decisions WHERE cache_key = ?
    alt cache hit (TTL valid)
        DB-->>DE: cached decision
        DE-->>API: { decision, cached: true }
        API-->>Client: < 200 ms
    else cache miss
        DE->>CB: buildContext() (sprint, stuck, noise, calendar, investigations)
        CB-->>DE: BrainContext (TTL-cached < 100 ms)
        DE->>Recall: recall(question, topK)
        Recall-->>DE: ranked memory + past decisions (RRF over 4 lists)
        DE->>AI: messages + tools (forced tool_use schema)
        AI-->>DE: structured decision (rationale, evidence, confidence, alternatives)
        DE->>Verify: verify(claims, evidence_needed)
        Verify-->>DE: per-adapter verification results
        DE->>Bud: recordSpend(user, day, $tokens)
        DE->>DB: INSERT brain_decisions (cache_key, decision, …)
        DE-->>API: { decision, cached: false }
        API-->>Client: ~ 5–25 s first call
    end

    Note over Client,DB: Later: record_outcome closes the loop\nlearn.ts → MemoryEnricher.decisions wing\n→ confidence delta on next similar query
```

**Cache key invariants** (after BUG-004 fix in `ADR-REVIEW.md`):
- `cache_key TEXT NOT NULL UNIQUE` on `brain_decisions`
- Derivation: `sha256(normalizeQuestion(question) ‖ user ‖ utcDayIso())`
- Two users asking the same question on the same day get **separate** decisions
- Same user asking the same question on the same day (within TTL) gets a **cached** decision
