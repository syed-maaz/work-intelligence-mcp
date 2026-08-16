---
sidebar_position: 10
title: MemPalace — Second Brain Architecture
---

# MemPalace — Second Brain Architecture

> **Purpose of this document**: A comprehensive reference covering what MemPalace is, how it works today, what we have built, the full integration roadmap, and how persistent memory transforms Work Intelligence MCP from a search tool into a second brain.

> **Operational wiring (context + decide):** see [Second Brain — Recall Integration](./second-brain-recall.md) for how `recallMemory()` feeds `memory_relevant` on `GET /api/brain/context` and `POST /api/brain/decide`.

---

## Table of Contents

1. [What is MemPalace](#1-what-is-mempalace)
2. [Why We Chose It](#2-why-we-chose-it)
3. [What We Built in EP-57](#3-what-we-built-in-ep-57)
4. [How It Works Today — Detailed Flow](#4-how-it-works-today--detailed-flow)
5. [The Second Brain Vision](#5-the-second-brain-vision)
6. [Integration Roadmap — EP-58 through EP-60](#6-integration-roadmap--ep-58-through-ep-60)
7. [How It Helps Us Grow](#7-how-it-helps-us-grow)
8. [Architecture Diagrams](#8-architecture-diagrams)
9. [Knowledge Graph Design](#9-knowledge-graph-design)
10. [Decision Log](#10-decision-log)

---

## 1. What is MemPalace

MemPalace is a **local, persistent, structured memory system** for AI agents. It provides three primitives:

| Primitive | What it stores | How it's queried |
|-----------|---------------|-----------------|
| **Drawers** | Rich structured documents (JSON, markdown) organized into wings → rooms | Full-text keyword search |
| **Knowledge Graph (KG)** | Typed triples: `(subject, predicate, object, date?)` | Entity lookup by subject or predicate |
| **Diary** | Timestamped narrative entries per agent | Recency-ranked log read |

The palace lives at `~/.work-intelligence-mcp/palace` — a local directory. No cloud, no external API, no cost per query. It is installed as a Python package and exposed both as a CLI (`python -m mempalace.cli`) and as an MCP server registered in `~/.claude/settings.json`.

**Key properties**:
- **Persistent across restarts** — the palace survives process restarts, re-deploys, and session clears
- **Idempotent writes** — calling `kgAdd` twice with the same triple is a no-op
- **Offline-safe** — `PalaceClient` degrades gracefully if the palace path is missing; all methods return `''`/`void`
- **Free to query** — unlike vector databases, KG traversal has zero API cost

---

## 2. Why We Chose It

### The Problem It Solves

Before MemPalace, every investigation started from zero. The Bug Investigation Engine (EP-55) could recall similar past investigations via BM25 keyword matching in SQLite (`findSimilarInvestigation()`), but this had a critical failure mode: **vocabulary mismatch**.

A future ticket titled "BIS panel shows nothing" would not match the prior investigation stored as "recommended links blank" — even though they describe the same bug. BM25 needs overlapping keywords. Real bugs rarely use the same words twice.

More fundamentally: the engine had **no knowledge of infrastructure state**. It could read git history but it had no awareness of feature flags, their current status, or when they were promoted across clusters. PROJ-15257 — our first real test — exposed this blind spot directly.

### Why MemPalace Over Alternatives

| Alternative | Why Rejected |
|-------------|-------------|
| `sqlite-vec` (vector extension) | Requires arch-specific native binary compilation; no KG equivalent; adds a build dependency with no fallback |
| `claude-mem` plugin | Claude Code tool — not callable from Node.js async context inside `web-server.js` |
| Pinecone / Qdrant | External managed services — cost, latency, privacy concerns for internal bug data |
| Redis with RediSearch | Operational overhead; no KG primitive; another process to manage |
| Raw SQLite FTS5 | Already have it; the problem is semantic similarity, not text search |

MemPalace is already installed globally. The marginal cost of integration was two methods added to `InvestigationOrchestrator`. The marginal benefit is semantic memory that grows with every investigation.

---

## 3. What We Built in EP-57

EP-57 (Sprint 13, 2026-04-24) shipped five waves of work. Here is exactly what exists in the codebase today.

### 3.1 `PalaceClient` — `src/intelligence/palace-client.ts`

A TypeScript wrapper around the MemPalace Python CLI. Calls `python -m mempalace.mcp_server` tool functions via `python -c` subprocess with `MEMPALACE_PALACE_PATH` env override.

**Six public methods:**

```typescript
class PalaceClient {
  // Search drawers by keyword — returns formatted text or '' if unavailable
  async search(query: string, wing?: string, limit = 5): Promise<string>

  // Look up all triples where subject matches entity
  async kgQuery(entity: string, predicate?: string): Promise<string>

  // Add a triple to the knowledge graph (idempotent)
  async kgAdd(subject: string, predicate: string, object: string, start?: string): Promise<void>

  // Write a structured document to a drawer (wing → room)
  async addDrawer(wing: string, room: string, content: string, label?: string): Promise<void>

  // Write a timestamped diary entry for an agent
  async diaryWrite(agent: string, entry: string, topic: string): Promise<void>

  // Read recent diary entries for an agent
  async diaryRead(agent: string, n = 10): Promise<string>
}
```

**Resilience design**: `this.available` is checked at the top of every method. If `MEMPALACE_PATH` is unset or the Python binary is missing, all methods return immediately with `''`/`void` — no error thrown, no log spam. The investigation engine is completely unaffected.

### 3.2 `palace-seeder.ts` — `src/intelligence/palace-seeder.ts`

Runs once at `web-server.js` startup when `MEMPALACE_PATH` is set. Parses `repos/operations/cluster-setup/feature-flags.yaml` using a line-by-line state machine (no YAML parser dependency) and writes KG triples for every feature flag.

**What it writes per flag:**
```
(knowledge-api-migration-flag, "has-status",        "Approved for Activation")
(knowledge-api-migration-flag, "activated-on",      "2026-04-17")
(knowledge-api-migration-flag, "active-in-cluster", "feat-test")
(knowledge-api-migration-flag, "active-in-cluster", "canary")
```

The seeder processed **46 flags** and wrote **~180 triples** on first run. Idempotent — safe to re-run on every restart.

### 3.3 `queryPalaceMemory()` — Pre-Loop Semantic Recall

Added to `InvestigationOrchestrator`. Runs **before the ReAct loop starts**, after `findSimilarInvestigation()`.

```typescript
private async queryPalaceMemory(
  input: InvestigationInput,
  regDate: RegressionDateResult
): Promise<{ similarInvestigations: string; kgContext: string }>
```

Runs two palace calls in `Promise.all()`:
1. `palace.search(title + description[:300], wing='investigations', limit=5)` — finds semantically similar past investigations
2. `palace.kgQuery("changes near <regressionDate>")` — finds KG entities with temporal proximity to the regression

Results are injected into the system prompt as a `## Memory Palace Context` section — only when non-empty. When palace returns empty strings, the section is omitted entirely and the prompt is identical to EP-55.

### 3.4 `writeToPalace()` — Post-Conclude Memory Write

Fire-and-forget method called after `completeInvestigation()`. Never blocks the HTTP response.

**Three writes per completed investigation:**

1. **Drawer**: Full investigation report serialized as JSON, stored in `wing=investigations, room=<rootCauseType>`
2. **Diary**: One entry for agent `"investigator"` — includes productive tools, dead-end tools, fix owner, root cause type
3. **KG Triple** (conditional): `(causalEntity, "caused-regression", issueKey, regressionDate)` — only written when `extractCausalEntity()` finds a match

`extractCausalEntity()` identifies the causal entity from `report.rootCause` text using three regex patterns:
- Feature flags: `/\bFF_KMIG_\w+/` → `"knowledge-api-migration-flag"`
- npm packages: `/@?[\w-]+\/[\w-]+@[\d.]+/` → `"@types/openui5@1.146.0"`
- PRs: `/PR\s*#(\d+)/i` → `"PR-6107"`

### 3.5 `get_flag_diff` Tool — Feature Flag Visibility

New investigation tool added to `INVESTIGATION_TOOLS`. Calls `git log` on `repos/operations` to find commits touching `cluster-setup/feature-flags.yaml` in a date window, then diffs `Status:` fields before/after each commit using `getFlagStatusDiff()`.

**Example output:**
```
  Subject: promote knowledge-api-migration-flag to approved
  Flag changes:
    knowledge-api-migration-flag: "In Progress" → "Approved for Activation"
```

### 3.6 Conclude Gate — Operations Check Enforcement

A runtime gate inside the ReAct loop. After any `conclude` tool call:

```
if rootCauseType ∈ {config-change, dep-upgrade, external-service}
AND trace has no git_log_window(repo=operations) AND no get_flag_diff
→ reject conclude
→ inject GATE message: "Call get_flag_diff first"
→ continue loop (not break)
→ record conclude-gate entry in reactTrace
```

The gate fires **at most once per investigation** — after the forced `get_flag_diff` call, the gate passes on the next `conclude`. `MAX_ITERATIONS` cap still applies; the gate cannot cause an infinite loop.

The updated system prompt rule 1 now says: *"Run git_log_window on BOTH repos in parallel."* Rule 7 explains the operations check requirement. The gate is a runtime safety net for the rare case where the model ignores the rule.

---

## 4. How It Works Today — Detailed Flow

### Investigation Flow with MemPalace Active

```
POST /api/jira/investigate
  { issueKey: "PROJ-15257", title: "BIS recommended links not showing", ... }

Step 1 — Regression date extraction
  extractRegressionDate() → { date: "2026-04-17", confidence: "high" }

Step 2 — Architecture + ownership context
  getArchitectureKnowledge(db) → example-service architecture summary
  buildOwnershipSummary() → team ownership map

Step 3 — SQLite keyword recall
  findSimilarInvestigation(db, keywords) → null (first time)

Step 4 — Palace semantic recall [NEW EP-57]
  Promise.all([
    palace.search("BIS recommended links not showing...", "investigations")
      → "" (empty palace on first run)
    palace.kgQuery("changes near 2026-04-17")
      → "knowledge-api-migration-flag: activated-on=2026-04-17, active-in-cluster=feat-test"
  ])

Step 5 — Create investigation session
  createInvestigationSession(db, "PROJ-15257", "2026-04-17", "high")

Step 6 — Build system prompt
  buildSystemPrompt(archCtx, ownershipSummary, input, regDate, palaceContext)
  → Includes: "## Memory Palace Context"
               "### Infrastructure Changes Near Regression Date"
               "knowledge-api-migration-flag was activated on 2026-04-17"

Step 7 — ReAct loop
  Iteration 1 (parallel — rule 1 enforced):
    git_log_window(repo="example-service", since="2026-04-14", until="2026-04-20")
    git_log_window(repo="operations", since="2026-04-14", until="2026-04-20")
    get_flag_diff(since="2026-04-14", until="2026-04-20")
      → knowledge-api-migration-flag: "In Progress" → "Approved for Activation"

  Iteration 2:
    read_file(repo="operations", file="cluster-setup/feature-flags.yaml")
      → confirms knowledge-api-migration-flag is the knowledge APIs migration flag

  Iteration 3:
    conclude(
      rootCauseType: "config-change",
      rootCause: "knowledge-api-migration-flag promoted 2026-04-17",
      confidence: 0.92
    )
    Gate check: config-change + get_flag_diff ∈ trace → PASSES

Step 8 — Post-conclude writes
  completeInvestigation(db, "PROJ-15257", report)

  writeToPalace(input, report, reactTrace) [fire-and-forget]
    palace.addDrawer("investigations", "config-change", reportJSON, "PROJ-15257")
    palace.diaryWrite("investigator",
      "PROJ-15257 | config-change | confidence: 0.92\n
       Root cause: knowledge-api-migration-flag... \n
       Productive: git_log_window, get_flag_diff, read_file\n
       Dead ends: grep_code, trace_call_graph",
      "PROJ-15257")
    palace.kgAdd("knowledge-api-migration-flag",
      "caused-regression", "PROJ-15257", "2026-04-17")

  extractAndSaveBugPattern(db, report)   [EP-55]
  recordConcludeSignals(db, session, ...) [EP-56]
```

### What the Palace Knows After One Investigation

```
KG triples added:
  (knowledge-api-migration-flag, caused-regression, PROJ-15257, 2026-04-17)

Drawer added:
  wing=investigations / room=config-change / label=PROJ-15257
  content: full JSON report

Diary entry added (agent=investigator):
  "PROJ-15257 | config-change | confidence: 0.92
   Root cause: knowledge-api-migration-flag...
   Productive: git_log_window, get_flag_diff, read_file
   Dead ends: grep_code, trace_call_graph"
```

The next investigation that asks about the knowledge APIs migration will find this context in Step 4 — without any code change.

---

## 5. The Second Brain Vision

### What "Second Brain" Means Here

A second brain is not a search index. It is a system that:
1. **Remembers** — every signal that flows through the system leaves a trace
2. **Connects** — relates entities across signals (email ↔ Jira ↔ Teams ↔ investigation)
3. **Recalls** — when a new signal arrives, retrieves what it already knows about the topic
4. **Grows** — gets smarter with every interaction, not just with every code change

Today (EP-57): the palace learns only from investigations. The brain has one sense organ.

Future (EP-58–60): the palace learns from every connector. The brain sees everything.

### The Core Loop

```
Signal arrives (email / Teams / Jira / meeting)
        │
        ▼
┌───────────────────┐
│   Memory Recall   │  ← "What do we already know about this?"
│   palace.search() │     KG traversal: topic → related entities → prior context
│   kgTraverse()    │
└────────┬──────────┘
         │  context injected
         ▼
┌───────────────────┐
│   AI Response     │  ← Answers with full historical context
│   (Haiku/Sonnet)  │     "We investigated this on Apr 21. Root cause was knowledge-api-migration-flag."
└────────┬──────────┘
         │  new facts extracted
         ▼
┌───────────────────┐
│   Memory Write    │  ← "What new facts did this signal add?"
│   kgAdd()         │     Entities, decisions, references written back
│   addDrawer()     │
│   diaryWrite()    │
└───────────────────┘
```

This loop runs on **every signal** — not just investigations. Email, Teams messages, Jira ticket updates, meeting transcripts. Every connector is both a reader and a writer.

### Cross-Reference Example

Someone emails: *"Hey, why are the BIS links not showing in the platform?"*

Without second brain:
```
Claude searches SQLite FTS → no match → generic response
```

With second brain (EP-58+):
```
email.topic → "BIS links not showing"
palace.search("BIS links") → PROJ-15257 investigation (Apr 21)
palace.kgQuery("PROJ-15257") → related-to knowledge-api-migration-flag
palace.kgQuery("knowledge-api-migration-flag") → caused-regression PROJ-15257, activated-on 2026-04-17
palace.search("knowledge-api-migration-flag") → diary entry: "fix owner = Platform/Knowledge team"

Response: "We investigated this on April 21. Root cause was knowledge-api-migration-flag
promoted in operations PR #6107 on April 17. Fix owner is the Platform/Knowledge team
```

This is 3 hops through the knowledge graph — all from data already in the palace.

---

## 6. Integration Roadmap — EP-58 through EP-60

### EP-58 — Universal Memory Writer

**Goal**: Every connector writes to MemPalace. The palace gains coverage across all data sources.

**Architecture**: A `MemoryEnricher` service that runs in the **Analyze stage** of the four-stage pipeline, after data is stored in SQLite, before it is surfaced to the user. It is fire-and-forget on every sync — never blocks the sync path.

```
Fetch → Process (SQLite) → Analyze → MemoryEnricher [NEW] → Propose
```

**Entity extraction model**: Claude Haiku (`claude-haiku-4-5-20251001`). Fast, cheap, fits the pattern of `AIAnalyzer`'s extraction methods. Single tool-use call per signal:

```typescript
extract_memory_entities(text: string, source: string) → {
  entities: Array<{ name: string; type: string }>,
  triples:  Array<{ subject: string; predicate: string; object: string; date?: string }>,
  summary:  string  // one-line diary entry
}
```

**Per-source write targets:**

| Source | Entities extracted | KG triples | Drawer | Diary |
|--------|--------------------|-----------|--------|-------|
| **Jira ticket update** | issueKey, status, assignee, component, mentioned flags | `BDS-X has-status In Progress`, `BDS-X owned-by Team`, `BDS-X related-to FF_*` | No | No |
| **Email received** | sender, subject, topics, questions, referenced tickets | `sender asked-about topic`, `topic referenced-in email-id` | `wing=emails, room=questions` | Yes — per sender |
| **Teams message** | mentioned people, mentioned tickets, decisions, action items | `person decided X on date`, `team discussed topic` | No | Yes — per channel |
| **Meeting transcript** | decisions, action items, attendees, topics | `topic decided-in meeting-id`, `person owns action-item` | `wing=meetings, room=decisions` | Yes — per meeting |
| **Investigation result** | already wired (EP-57) | ✓ | ✓ | ✓ |

**Trigger points** in existing code:
- After `sync.ts` processes a batch of messages → `MemoryEnricher.enrichMessages(messages)`
- After `jira-browser.ts` / `jira-adapter.ts` fetches ticket data → `MemoryEnricher.enrichJiraTicket(ticket)`
- After `teams-meetings.ts` completes a transcript → `MemoryEnricher.enrichMeeting(transcript)`
- After `outlook-browser.ts` processes email → `MemoryEnricher.enrichEmail(email)`

All calls are `.catch(err => stderr)` — identical pattern to `writeToPalace()`.

**What we do NOT write**: Raw message text. We extract entities and decisions only. The palace is a knowledge graph, not a message archive (SQLite already serves that role).

---

### EP-59 — Semantic Recall + KG Traversal

**Goal**: Replace keyword matching with semantic similarity. Add graph traversal so related entities surface automatically.

**Two components:**

#### Component A — Embedding-Based Search

Current `PalaceClient.search()` uses MemPalace's built-in keyword search. For "second brain" quality recall, we need **semantic similarity** — finding relevant past context even when words don't match.

**Implementation**: `sqlite-vec` extension for SQLite (binary is distributed with the package — no compilation). Each palace write also writes an embedding row.

```
palace.addDrawer(wing, room, content, label)
  → also: embed(summary_line) → vector → sqlite-vec INSERT

palace.search(query)
  → embed(query) → ANN search → top-k candidates
  → re-rank by recency + relevance score
  → return formatted context
```

**Embedding model**: `text-embedding-3-small` via Anthropic-compatible endpoint. $0.02/1M tokens — negligible cost for short summary lines.

**What gets embedded**: Not the full drawer content. The **summary line** per entity (one sentence). Short, dense, retrievable. Examples:
- `"PROJ-15257: BIS recommended links blank since 2026-04-17, config-change, knowledge-api-migration-flag"`
- `"knowledge-api-migration-flag: knowledge APIs migration flag, activated in feat-test cluster on 2026-04-17"`
- `"email from john@.com: asked why BIS links are missing in platform UI"`

#### Component B — KG Traversal

```typescript
async traverseKnowledgeGraph(
  seed: string,
  maxHops: number = 3,
  relevanceThreshold: number = 0.5
): Promise<{ entities: string[]; context: string }>
```

BFS over KG triples starting from `seed`. At each hop, calls `kgQuery(entity)` and follows all predicates. Prunes branches where relevance (semantic similarity to original query) drops below threshold. Max 3 hops. Returns a flattened context string.

**Example traversal for "BIS links":**
```
Hop 0: kgQuery("BIS-links") → PROJ-15257
Hop 2: kgQuery("knowledge-api-migration-flag") → PROJ-15257 (cycle — stop), feat-test cluster, 2026-04-17
```

**Where wired**: `RecallService` class that wraps traversal + semantic search. Called from:
- Investigation pre-loop (`queryPalaceMemory()` — already exists, upgrade in place)
- Email response generation
- Chat (`/api/chat` endpoint)
- `ask_topic_expert` MCP tool

---

### EP-60 — Recall-Augmented Chat + Provenance

**Goal**: Every user-facing response in the chat panel and MCP tools includes provenance — where did this answer come from?

**Current chat flow** (`/api/chat`):
```
User question → SQLite FTS search → context → Claude → response
```

**Future flow with recall:**
```
User question
  → RecallService.recall(question)
      → semantic search + KG traversal
      → returns: { context, sources: [{ type, id, summary, date }] }
  → SQLite FTS search (existing — kept for recency)
  → merge contexts
  → Claude response
  → attach sources to response
```

**UI change**: Chat responses show a collapsible "Sources" section:
```
📎 Based on:
  • PROJ-15257 investigation (Apr 21, 2026) — config-change
  • Teams message from John (Apr 23, 2026) — "BIS panel blank since update"
```

This is the moment Work Intelligence MCP becomes a **knowledge assistant** rather than a search tool. The user doesn't need to know where to look — the system connects the dots.

---

## 7. How It Helps Us Grow

### Near-Term (EP-58 — Universal Writer)

**Time to answer drops from minutes to seconds.** Right now, answering "what's the status of PROJ-15257?" requires navigating to Jira. With EP-58, the palace has the current status as a KG triple — answerable instantly from memory, without a Jira fetch.

**Context carries across sessions.** Today, every Claude conversation starts cold. With a populated palace, the system "remembers" decisions made in past meetings, the status of ongoing bugs, and who owns what — without any user re-explaining.

**Investigation accuracy improves automatically.** Every completed investigation enriches the palace. The second time a similar bug is investigated, the pre-loop context already contains the prior root cause type, the productive tools, and the dead-end tools. Investigation time shrinks.

### Medium-Term (EP-59 — Semantic Recall)

**Cross-source connections surface automatically.** An email about "slow API responses" connects to the Jira ticket `PROJ-14901` connects to the Teams decision "we agreed to defer the caching fix until Sprint 14" connects to the investigation "root cause: uncached KG query hitting prod". The user asks one question; the brain traverses the graph.

**The palace becomes the single source of truth for decisions.** Meeting decisions, email commitments, Jira resolutions — all stored as KG triples with timestamps and linked to participants. "What did we decide about the knowledge API migration?" becomes a single palace query, not a search through three systems.

**Investigation false negatives approach zero.** Vocabulary mismatch — the BM25 failure mode — is eliminated by embedding-based recall. "Slow BIS panel" matches "recommended links blank" because they share semantic similarity, not keywords.

### Long-Term (EP-60 — Recall-Augmented Chat)

**The system answers questions it was never explicitly taught.** The knowledge graph enables multi-hop reasoning: a question about a symptom leads to a root cause leads to a fix owner leads to a resolution. The system derives answers from connected facts, not from stored Q&A pairs.

**Onboarding new team members becomes instant.** The palace accumulates institutional knowledge — decisions, the reasoning behind them, who owns what, what was tried and failed. A new engineer can ask "why does the BIS panel sometimes show nothing?" and get a complete answer with provenance from six months of system activity.

**The investigation engine becomes proactive.** With a rich enough KG, the system can detect potential regressions before tickets are filed: "knowledge-api-migration-flag was just promoted to production. We have a KG triple: knowledge-api-migration-flag caused-regression PROJ-15257 in feat-test. Shall I run a pre-emptive investigation?"

---

## 8. Architecture Diagrams

### Current State (EP-57)

```
web-server.js
  │
  ├─ Startup: runPalaceSeeder()
  │     └─ features-flags.yaml → KG triples (46 flags)
  │
  └─ POST /api/jira/investigate
        │
        └─ InvestigationOrchestrator
              │
              ├─ queryPalaceMemory()   ← READ  (pre-loop)
              │     palace.search()
              │     palace.kgQuery()
              │
              ├─ ReAct Loop
              │     get_flag_diff tool (NEW)
              │     conclude gate (NEW)
              │
              └─ writeToPalace()       ← WRITE (post-conclude, fire-and-forget)
                    palace.addDrawer()
                    palace.diaryWrite()
                    palace.kgAdd()
```

### Future State (EP-58–60)

```
                    ┌─────────────────────────────────────────┐
                    │            MemPalace Palace              │
                    │   wings: investigations, emails,         │
                    │          meetings, decisions, flags      │
                    │   kg:    millions of typed triples       │
                    │   diary: per-agent narrative logs        │
                    │   vectors: embedding index (EP-59)       │
                    └──────────────┬──────────────────────────┘
                                   │ read/write
              ┌────────────────────┼──────────────────────┐
              │                    │                       │
        RecallService         MemoryEnricher          PalaceClient
        (EP-59)               (EP-58)                 (EP-57, done)
              │                    │                       │
    ┌─────────┴──┐      ┌──────────┴──────┐      ┌────────┴────────┐
    │            │      │                 │      │                 │
  Chat         MCP    Jira sync      Teams sync  Investigation    Email
  Panel       Tools   email sync     meeting     Orchestrator     response
  (EP-60)             (EP-58)        (EP-58)     (EP-57, done)    (EP-60)
```

---

## 9. Knowledge Graph Design

### Wings and Rooms

```
Palace
├── wing: investigations
│   ├── room: config-change      ← drawers for config-change root cause investigations
│   ├── room: dep-upgrade
│   ├── room: code-regression
│   ├── room: external-service
│   └── room: unknown
│
├── wing: emails                  [EP-58]
│   └── room: questions           ← emails containing questions we answered
│
├── wing: meetings                [EP-58]
│   └── room: decisions           ← meeting transcripts with decisions
│
└── wing: flags                   [EP-58, optional]
    └── room: promotions          ← flag promotion events with context
```

### KG Predicate Vocabulary

```
# Feature flag predicates (EP-57, seeder)
(FF_RM_*, "has-status",        "Approved for Activation" | "In Progress" | ...)
(FF_RM_*, "activated-on",      "YYYY-MM-DD")
(FF_RM_*, "active-in-cluster", "feat-test" | "canary" | "prod")

# Investigation predicates (EP-57, writeToPalace)
(entity,  "caused-regression", "BDS-NNNNN", regressionDate)
(package, "dep-upgrade-in",    "example-service" | "operations")

# Jira predicates (EP-58)
("BDS-NNNNN", "has-status",    "In Progress" | "Resolved" | ...)
("BDS-NNNNN", "owned-by",      "team-name")
("BDS-NNNNN", "related-to",    "FF_RM_*" | "PR-NNNN")
("BDS-NNNNN", "resolved-by",   "person-id")

# Communication predicates (EP-58)
("person-id", "asked-about",   "topic")
("topic",     "decided-in",    "meeting-id")
("person-id", "owns-action",   "action description")
```

### Diary Agents

| Agent name | Writes | Reads |
|------------|--------|-------|
| `investigator` | Per investigation: tools used, root cause, confidence | Pre-loop: tool effectiveness by root cause type |
| `jira-tracker` | Per Jira status change | Current status of any issue |
| `teams-recorder` | Per Teams decision/action item | Recent decisions by channel |
| `email-handler` | Per email question/answer | Prior questions from same sender |

---

## 10. Decision Log

| Decision | Rationale |
|----------|-----------|
| MemPalace as additive sidecar, not replacement | Zero regression risk — `MEMPALACE_PATH` unset = EP-55 behavior exactly |
| Python subprocess (not MCP client in process) | MCP client cannot run inside Node.js async IIFE in web-server.js context |
| Fire-and-forget for all palace writes | Palace I/O should never add latency to the HTTP response path |
| Haiku for entity extraction (EP-58) | Runs on every sync — cost matters; Haiku is sufficient for entity/triple extraction |
| BFS traversal max 3 hops (EP-59) | Beyond 3 hops, relevance drops and token cost climbs exponentially |
| Summary lines for embeddings, not full content (EP-59) | Short, dense sentences embed better; full content adds noise and cost |
| SQLite-vec for vector storage (EP-59) | Zero new infrastructure; fits the existing better-sqlite3 stack |
| Provenance in chat responses (EP-60) | Transparency builds trust; users need to know if the answer came from a 6-month-old investigation |

---

---

## 11. Palace observability — known gotchas

> **Added 2026-05-30** (graphify follow-up). If `tripleCount` ever looks "wrong"
> in the dashboard, read this section before opening a new investigation.

### TL;DR

**`/api/palace/status` is the source of truth** for palace counts. It calls
`mempalace_kg_stats` (and `mempalace_status` for drawers), which are the
designed observability surface and report the real numbers.

**`/api/palace/health/detailed` historically lied.** It used to call
`mempalace_kg_query` with `{ entity: '*' }`. The `*` is **not** a valid
wildcard for `kg_query` — the tool returned `[]`, so the dashboard reported
`totalTriples: 0` even when the KG had hundreds of triples. As of
2026-05-30 the endpoint now also calls `kg_stats`, matching `/api/palace/status`.

### Why this mattered

Multiple debug sessions concluded "palace is empty" or "memory enricher isn't
writing" purely because the broken endpoint said `totalTriples: 0`. Each
investigation re-derived the same false gap. Trust the smoke guard now, not
your eyes on a stale dashboard tile.

### Smoke regression guard

`scripts/smoke-bridge.sh` (section 9, "Palace health endpoint divergence")
fails the bridge smoke if:

```
/api/palace/status  → tripleCount > 0
   AND
/api/palace/health/detailed → totalTriples == 0
```

If that combination ever shows up again, treat it as a regression of the
wildcard bug — not as a real "empty palace" event.

### Why the health endpoint can't compute everything

`kg_stats` returns aggregate counts (`total_triples`, `total_entities`) but
**does not enumerate triples**. That means `staleFacts` and `orphanRate` —
which require per-triple `valid_from` / `valid_to` and per-entity edge fan-out
— are no longer computed; they report `0` (unknown). If we ever need those
metrics back, we need a streaming `kg_enumerate` tool on the palace side, not
a fake wildcard.

---

*Last updated: 2026-05-30 — palace observability cheat-sheet added (graphify follow-up)*
