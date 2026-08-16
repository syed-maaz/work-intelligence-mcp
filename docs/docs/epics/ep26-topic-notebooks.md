---
title: "EP-26: Topic Notebooks (LLM Memory)"
sidebar_label: "EP-26: Topic Notebooks"
---

# EP-26: Topic Notebooks — Living LLM Memory per Topic

| | |
|---|---|
| **Status** | ✅ Done |
| **Priority** | High |
| **Depends On** | [EP-13](./ep13-topic-expert) |
| **Blocks** | EP-15 |
| **DB Schema** | v16 current (notebooks + chat history added in earlier migrations) |
| **File Scope** | `src/db/schema.ts`, `src/db/queries.ts`, `src/services/analyzer.ts`, `src/tools/notebook.ts` (new), `web-server.js`, `web/src/lib/api.ts`, `web/src/pages/TopicExpertPage.tsx` |

## Goal

Replace the one-shot FTS5 → summarize pattern in Topic Expert with a **persistent LLM memory** per topic. Each topic gets a structured "notebook" document that Claude maintains incrementally — building up knowledge over time rather than starting from scratch on every query.

The notebook is Claude's memory. Questions are answered against it, not against raw keyword search results.

---

## Problem with the original Topic Expert

The original `ask_topic_expert` flow:
1. FTS5 search → top-N message rows (capped ~50)
2. Feed raw rows to Claude → one-shot summary
3. Return answer. Context discarded.

**Issues:**
- Every question re-derives the same context from scratch
- Context window limited to ~50 messages per query regardless of how much data exists
- No accumulated understanding of people, decisions, or ongoing threads
- Cold-start: new topic = FTS5 returns nothing = useless answer

---

## Architecture: Incremental LLM Memory

```
First build:
  all messages + meetings
       ↓
  buildNotebook() → Claude generates 7-section structured notebook
       ↓
  saved to topic_notebooks table

Each sync:
  existing notebook (system prompt) + new messages since last_message_id
       ↓
  updateNotebook() → Claude merges new info into existing memory
       ↓
  update topic_notebooks row

Each question:
  notebook content (system context) + question
       ↓
  analyzer.chatWithContext() → answer grounded in accumulated knowledge

Multi-turn chat:
  notebook + conversation history + new question
       ↓
  persistent Q&A across sessions (saved to notebook_chat_history)
```

The critical insight: **`updateNotebook()` passes the existing notebook as Claude's prior memory in the system prompt.** Claude reads it, reads the new messages, and returns a merged version that integrates the new knowledge without losing what came before. This is the incremental LLM memory update pattern — no regeneration from scratch.

---

## Notebook Structure

Each notebook has 7 fixed sections so Claude knows what to maintain:

```markdown
## Overview
What this topic/project is, one paragraph.

## Key People
Who's involved and their roles.

## Current Status
Latest developments — always reflects most recent state.

## Timeline
Chronological log of significant events (append-only by Claude).

## Decisions Made
Persisted decisions — Claude never removes these.

## Open Questions & Blockers
Resolved ones are removed by Claude, new ones are added.

## Key Threads
Important ongoing discussions worth tracking.
```

---

## Alternatives Considered and Rejected

| Approach | Decision | Reason |
|---|---|---|
| **EP-14-1 live fallback** | Superseded | Notebooks eliminate cold-start; live fetch during query is too slow and disruptive |
| **EP-14-2 context_needed hints** | Superseded | Notebooks always have context built from all data; notebook sections serve same purpose persistently |
| **NotebookLM (Google)** | Rejected | Internal/private data concern; sending company comms to Google's servers is not acceptable |
| **AnythingLLM** | Rejected | File-only ingestion; no SQLite connector; requires full export pipeline on every sync |
| **Obsidian vault mirror** | Deferred to Phase 2 | Valuable as optional export format but not a replacement; requires separate app outside the web UI |
| **n8n webhook triggers** | Deferred to Phase 2 | Useful for new data sources but doesn't solve the LLM memory problem |

---

## DB Schema

### Migration v8 → v9: `topic_notebooks`

```sql
CREATE TABLE IF NOT EXISTS topic_notebooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_name TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,           -- full notebook markdown (Claude's memory)
  last_message_id INTEGER,         -- highest message.id seen at last update
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_topic_notebooks_name ON topic_notebooks(topic_name);
```

### Migration v9 → v10: `notebook_chat_history`

```sql
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

## Key Implementation Details

### `src/services/analyzer.ts`

Two new methods added, both use `DIGEST_MODEL` (Sonnet):

**`buildNotebook(topicName, messages, meetings)`**  
Tool: `build_notebook`. Structured output (tool_choice). Input: up to 100 most recent messages (300 chars each) + 20 meetings. Produces all 7 sections.

**`updateNotebook(topicName, existingNotebook, newMessages, newMeetings)`**  
Passes existing notebook as Claude's prior memory in the system prompt with explicit instruction: *"This is your current knowledge about this topic. Update it with the new information below, preserving existing knowledge and integrating new findings."* Returns merged notebook — never starts from scratch.

Type adapters to avoid cross-module type coupling:
```typescript
export interface NotebookMessage { source: string; content: string; author: string; timestamp: Date | string; }
export interface NotebookMeeting { title?: string; date?: string; summary?: string; decisions?: string; topics?: string; }
```

### `src/tools/notebook.ts`

`getOrBuildNotebook(db, topicName, analyzer, opts?)` orchestrator:
1. Check `topic_notebooks` for existing entry
2. If `forceRebuild` or no entry → fetch all messages + meetings → `buildNotebook()` → `saveNotebook()`
3. If entry exists → fetch messages with `id > last_message_id` → if any → `updateNotebook()` → `saveNotebook()`
4. If entry exists and no new messages → return cached content as-is
5. Returns `{ notebook: string, fresh: boolean }`

Topic resolution: looks up in `topics` table first, falls back to FTS search for ad-hoc queries.

### `web-server.js` endpoints

| Endpoint | Description |
|---|---|
| `GET /api/notebooks` | List all notebooks (name, last_updated, message_count) |
| `GET /api/notebooks/:topicName` | Get (or build lazily) notebook for a topic |
| `POST /api/notebooks/:topicName/rebuild` | Force full rebuild |
| `DELETE /api/notebooks/:topicName` | Delete notebook |
| `POST /api/notebooks/:topicName/chat` | Multi-turn chat against notebook |
| `GET /api/notebooks/:topicName/history` | Saved Q&A history for a topic |

**Auto-update on sync**: `runFullSync()` iterates all topics after Teams + calendar sync and calls `getOrBuildNotebook()` for each, keeping notebooks fresh automatically.

---

## UI: Redesigned Topic Expert Page

`web/src/pages/TopicExpertPage.tsx` — full redesign:

```
┌─────────────────────────────────────────────────────────────┐
│  [Topic tabs: BDS | MIGRATION | INFRA | ...]                │
├──────────────────────────┬──────────────────────────────────┤
│  NOTEBOOK (memory)       │  CHAT                            │
│                          │                                  │
│  Overview                │  [message bubbles]               │
│  Key People              │                                  │
│  Current Status          │  [textarea + Send]               │
│  Timeline                │                                  │
│  Decisions               │  Suggested follow-ups:           │
│  Open Items              │  • chip  • chip                  │
│  Key Threads             │                                  │
│                          │  ── Previous questions ──        │
│  [Rebuild] · fresh badge │  ▶ What are the blockers? (2d)   │
└──────────────────────────┴──────────────────────────────────┘
```

- Left: `MarkdownPanel` rendering notebook. "fresh" badge when just built. Rebuild button.
- Right: multi-turn chat. Local `chatHistory` state. `notebookChat()` mutation. Suggested follow-up chips from last response.
- Bottom: expandable `HistoryItem` list of saved Q&A entries with "Ask again" reuse.
- Switching topic resets chat history, loads new notebook.

---

## Definition of Done

- [x] `npm run typecheck` passes with zero errors
- [x] `npm run build` passes
- [x] `GET /api/notebooks/BDS` returns notebook content (built lazily on first request)
- [x] `POST /api/notebooks/BDS/chat` answers questions from notebook memory
- [x] After `POST /api/sync/all`, notebooks auto-update for all topics
- [x] Topic Expert page shows notebook panel + chat panel side-by-side
- [x] Multi-turn chat preserves context across questions within a session
- [x] Chat history persisted and shown in "Previous questions" list
