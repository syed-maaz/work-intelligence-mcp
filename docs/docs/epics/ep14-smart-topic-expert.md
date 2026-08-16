---
title: "EP-14: Smart Topic Expert"
sidebar_label: "EP-14: Smart Topic Expert"
---

# EP-14: Smart Topic Expert

| | |
|---|---|
| **Status** | ✅ Done — EP-14-1 and EP-14-2 superseded by Topic Notebooks; EP-14-3, 4, 5 implemented |
| **Priority** | High |
| **Agent Role** | AI / Integration Engineer |
| **Depends On** | [EP-13](./ep13-topic-expert), [EP-2](./ep2-teams-scraper), [EP-3](./ep3-outlook-scraper) |
| **Blocks** | EP-15 |
| **File Scope** | `src/tools/topic-expert.ts` (edit), `src/connectors/browser-session.ts` (edit), `src/services/analyzer.ts` (edit), `src/services/sync.ts` (edit), `src/db/schema.ts` (edit), `src/server.ts` (edit) |

## Goal

Make `ask_topic_expert` self-aware about what it knows and doesn't know. When the local DB is sparse for a topic (e.g., it has never been synced, or a channel was just added), the tool should:

1. **Detect sparseness** — fewer than 5 DB results is a signal, not an answer
2. **Fall back to live fetch** — trigger an on-demand Teams/Outlook scrape, cache results, then answer
3. **Tell the user what context is missing** — return `context_needed` hints so the user knows what to configure
4. **Auto-discover new topics** — after every background sync, cluster new messages and suggest topics the user hasn't configured yet

This epic closes the biggest gap in Phase 1: the cold-start problem where a question about an unconfigured topic returns nothing useful.

---

## Architectural Decision: Topic Notebooks

### What we built instead of EP-14-1 and EP-14-2

EP-14-1 (live fallback) and EP-14-2 (context_needed hints) both address the **answer quality problem** — the one-shot FTS5 → summarize pattern doesn't build up knowledge over time.

Rather than patching the existing `ask_topic_expert` tool with a live-fetch fallback, we replaced the entire answer model with **Topic Notebooks** — Claude's persistent LLM memory per topic.

### The problem with the original approach

The original `ask_topic_expert` flow:
1. FTS5 search → raw message rows
2. Truncate to 50 → feed to Claude for one-shot summary
3. Return answer. Done. Everything forgotten.

Problems:
- Every question starts from scratch — no accumulated understanding
- Context window limited to ~50 messages per query
- Live fallback (EP-14-1) would open a browser mid-query — slow, disruptive, fragile
- `context_needed` hints (EP-14-2) tell the user what to do but don't solve the underlying sparseness

### Alternatives considered and rejected

| Approach | Why rejected |
|---|---|
| **EP-14-1 live fallback** | Superseded — notebooks maintain full history; live fetch during query is too slow and disruptive for interactive use |
| **EP-14-2 context_needed hints** | Superseded — notebooks always have context because they're built from all data, not query-time search |
| **NotebookLM (Google)** | Internal/private data concern; requires sending company data to Google's servers |
| **AnythingLLM** | File-only ingestion; no SQLite connector; would need an entire export pipeline for every sync |
| **Obsidian vault mirror** | Valuable as optional export, but not a replacement; still requires a separate app and doesn't integrate into the web UI |
| **n8n webhook triggers** | Useful for new data-source ingestion in Phase 2, but not a solution for the LLM memory problem |

### What Topic Notebooks are

A **Topic Notebook** is Claude's persistent, structured memory document for a topic — maintained incrementally as new data arrives.

```
┌─────────────────────────────────────────────────────┐
│  Topic Notebook: BDS                                │
├─────────────────────────────────────────────────────┤
│  ## Overview                                        │
│  BDS is the Backend Data Services team...           │
│                                                     │
│  ## Key People                                      │
│  - Alexander Gahr: KBA/Document Service lead        │
│  - ...                                              │
│                                                     │
│  ## Current Status                                  │
│  Sprint 24 active. Migration blocker resolved...    │
│                                                     │
│  ## Timeline                                        │
│  2026-04-10: Decision to drop Graph API             │
│  ...                                                │
│                                                     │
│  ## Decisions Made                                  │
│  ## Open Questions & Blockers                       │
│  ## Key Threads                                     │
└─────────────────────────────────────────────────────┘
```

### How it works

```
On first build:   all messages + meetings → Claude generates 7-section notebook
On each sync:     existing notebook + new messages → Claude merges/updates incrementally
On question:      notebook (as system context) + question → answer with full history
On multi-turn:    notebook + conversation history → persistent Q&A across sessions
```

The key insight: **the notebook IS Claude's memory**. On incremental updates, the existing notebook is passed as Claude's prior memory in the system prompt. Claude reads it plus new data and returns the merged version — it doesn't regenerate from scratch, it integrates new knowledge. This is the **incremental LLM memory update pattern**.

### Implementation

| File | Change |
|---|---|
| `src/db/schema.ts` | Added `topic_notebooks` table (v8→v9 migration), `notebook_chat_history` table (v9→v10) |
| `src/db/queries.ts` | `getNotebook`, `saveNotebook`, `listNotebooks`, `deleteNotebook`, `saveNotebookChatEntry`, `getNotebookChatHistory` |
| `src/services/analyzer.ts` | `buildNotebook()` (first-time, `build_notebook` tool), `updateNotebook()` (incremental merge via system prompt) |
| `src/tools/notebook.ts` | `getOrBuildNotebook()` orchestrator: check → build/update → cache |
| `web-server.js` | 6 new endpoints: list, get/build, rebuild, delete, chat, history. Hook in `runFullSync()` |
| `web/src/lib/api.ts` | `TopicNotebook`, `NotebookChatEntry` types + 5 api methods |
| `web/src/pages/TopicExpertPage.tsx` | Full redesign: topic tabs + notebook panel (left) + chat panel (right) |

### DB schema

```sql
-- v9 migration
CREATE TABLE IF NOT EXISTS topic_notebooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_name TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  last_message_id INTEGER,
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_topic_notebooks_name ON topic_notebooks(topic_name);

-- v10 migration
CREATE TABLE IF NOT EXISTS notebook_chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_name TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  asked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notebook_chat_topic ON notebook_chat_history(topic_name);
```

---

## Tickets

### EP-14-1 — Live Fallback in `ask_topic_expert` ~~SUPERSEDED~~

> **Status: Superseded by Topic Notebooks**
>
> The live-fetch fallback was designed to fill sparse DB results by opening a browser mid-query. Topic Notebooks eliminate sparseness entirely: on first use Claude builds a complete notebook from all existing data, and every sync incrementally updates it. There is no cold-start problem to solve. The notebook chat endpoint (`POST /api/notebooks/:topicName/chat`) answers from full accumulated memory, not FTS5 keyword search.

**Original goal:** If FTS5 returns < 5 results, trigger an on-demand live fetch before answering.

~~**Acceptance criteria:**~~
- ~~`askTopicExpert` checks if `dbResults.length < LIVE_FALLBACK_THRESHOLD` (constant = 5)~~
- ~~If below threshold AND `BROWSER_PROFILE_PATH` is set AND `topicName` or `projectKey` is specified:~~
  - ~~Instantiate `BrowserSessionManager` + `TeamsChatScraper`~~
  - ~~Search for channels matching the topic/projectKey (fuzzy name match)~~
  - ~~Fetch last 7 days of messages from matching channels~~
  - ~~`upsertMessage()` results to DB~~
  - ~~Re-run `searchDb()` with the now-populated DB~~
- ~~Live fetch errors are caught and logged to `fetchNotes`; tool still returns DB results~~
- ~~Live fallback is only triggered once per `askTopicExpert` call (no recursion)~~
- ~~New env var `LIVE_FALLBACK_ENABLED=true` (default false) gates this behavior~~

---

### EP-14-2 — `context_needed` Hints in Answer ~~SUPERSEDED~~

> **Status: Superseded by Topic Notebooks**
>
> `context_needed` hints were a UX patch for answers that were sparse due to missing data. The notebook model inverts this: instead of answering from a sparse search and apologizing, Claude first builds a complete knowledge base from all available data and answers from that. The notebook content itself surfaces what's missing (e.g., "No meeting transcripts available for this period"). The `buildNotebook()` and `updateNotebook()` methods in `src/services/analyzer.ts` produce the 7-section structured notebook with explicit "Open Questions & Blockers" and "Key Threads" sections that serve the same purpose as `context_needed` hints, but as persistent, curated knowledge rather than query-time suggestions.

**Original goal:** When the answer is sparse, tell the user exactly how to add more context.

~~**Acceptance criteria:**~~
- ~~Add `context_needed: string[]` to `TopicExpertAnswer` interface in `analyzer.ts`~~
- ~~`answerQuestion()` populates `context_needed` when `context.length < 10`~~
- ~~`renderMarkdown()` renders `context_needed` as a "### To Improve This Answer" section~~
- ~~Section is styled as a tip block: `:::tip Getting better results`~~

---

### EP-14-3 — Auto-Topic Discovery

**Goal**: After each background sync, cluster new messages and surface topic suggestions.

**Acceptance criteria:**
- [x] New DB table `topic_suggestions` (migration 10→11 in `src/db/schema.ts`)
- [x] `SyncService.runSync()` calls `detectTopicCandidates(db, newMessages)` after each sync run
- [x] `detectTopicCandidates()`:
  - Groups new messages by top-2 keywords (tf-idf approximation using word frequency)
  - Clusters messages sharing the same top keyword
  - Emits a `topic_suggestions` row if cluster has ≥ 10 messages AND ≥ 3 distinct authors AND no existing topic with that name
- [x] New MCP tool `get_topic_suggestions`:
  - Returns undismissed rows from `topic_suggestions`
  - Includes sample messages per suggestion
  - User can call `configure_topic` with the suggestion, or dismiss it
- [x] `dismiss_topic_suggestion(id)` tool — sets `dismissed = 1`
- [x] REST endpoints: `GET /api/topic-suggestions`, `POST /api/topic-suggestions/:id/dismiss`
- [x] UI widget on TopicsPage showing suggestions with Configure + Dismiss actions

**New schema:**
```sql
CREATE TABLE topic_suggestions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword       TEXT NOT NULL UNIQUE,
  message_count INTEGER NOT NULL,
  author_count  INTEGER NOT NULL,
  sample_msgs   TEXT,          -- JSON: first 3 message subjects
  suggested_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  dismissed     INTEGER DEFAULT 0
);
```

**Files:** `src/db/schema.ts`, `src/services/sync.ts`, `src/tools/` (new `topic-suggestions.ts`), `src/server.ts`

---

### EP-14-4 — Configurable Lookback Window Per Topic

**Goal**: Some topics need 90-day history; others only 7 days. The default 30-day window is wrong for both.

**Acceptance criteria:**
- [x] Add `lookback_days` column to `topics` table (default: 30, migration 10→11)
- [x] `configure_topic` tool accepts optional `lookbackDays` parameter
- [x] `askTopicExpert` uses `topic.lookback_days` as default `since` when no explicit `since` arg is passed
- [x] `AskTopicExpertArgs.since` explicit parameter still overrides the topic default
- [x] Schema migration: `ALTER TABLE topics ADD COLUMN lookback_days INTEGER DEFAULT 30`

**Files:** `src/db/schema.ts`, `src/tools/configure-topic.ts`, `src/tools/topic-expert.ts`

---

### EP-14-5 — Browser Session Pool (2-slot)

**Goal**: Allow Teams scraping and Jira scraping to run in parallel during background sync.

**Acceptance criteria:**
- [x] `BrowserSessionManager` becomes a pool with a configurable `maxSlots` (default: 2)
- [x] `getPage(url)` acquires a slot (waits if both are busy), returns page
- [x] `releasePage(page)` returns the slot to the pool
- [x] Pool slots tracked with `_poolSlot` tag on page; released via try/finally in callers
- [x] `SyncService` can run Jira sync + Teams sync concurrently when 2 topics are queued
- [x] Slots are created lazily (first request creates the browser, not at startup)
- [x] `BROWSER_MAX_SLOTS=2` env var controls pool size

**Files:** `src/connectors/browser-session.ts`, `src/services/sync.ts`

---

## Definition of Done

- [x] `npm run typecheck` passes with zero errors
- [x] `npm run build` passes
- [x] After `npm run teams-sync`, `get_topic_suggestions` returns at least one candidate if messages > 100 (EP-14-3)
- [x] `configure_topic({ lookbackDays: 90 })` persists and is used by `ask_topic_expert` (EP-14-4)
- [x] Background sync of 2 topics completes faster with browser pool than sequential (EP-14-5)
- [x] ~~`ask_topic_expert` returns live-fetched results for a brand-new topic (EP-14-1)~~ — superseded by notebooks
- [x] ~~Sparse answer includes `context_needed` section with actionable hints (EP-14-2)~~ — superseded by notebooks

---

## Agent Prompt

```
Implement EP-14 remaining tickets: EP-14-3, EP-14-4, EP-14-5.
(EP-14-1 and EP-14-2 are superseded by Topic Notebooks — do not implement them.)

EP-14-3: Auto-topic discovery.
  - Edit src/db/schema.ts: add topic_suggestions table (migration guarded by IF NOT EXISTS)
  - Edit src/services/sync.ts: call detectTopicCandidates() after each sync run
  - Create src/tools/topic-suggestions.ts: get_topic_suggestions + dismiss_topic_suggestion tools
  - Edit src/server.ts: register both new tools

EP-14-4: Configurable lookback_days per topic.
  - Edit src/db/schema.ts: ALTER TABLE topics ADD COLUMN lookback_days INTEGER DEFAULT 30
  - Edit src/tools/configure-topic.ts: add optional lookbackDays param
  - Edit src/tools/topic-expert.ts: use topic.lookback_days as default since

EP-14-5: Browser session pool.
  - Edit src/connectors/browser-session.ts: convert to 2-slot pool (BROWSER_MAX_SLOTS env var)
  - Pool slots lazy-created, released via try/finally
  - Edit src/services/sync.ts: run Jira + Teams topics concurrently up to pool size

TypeScript rules: strict mode, .js extensions on local imports, no unused vars.
After each ticket: npm run typecheck. Final: npm run build.
```
