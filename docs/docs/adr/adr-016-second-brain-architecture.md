---
id: adr-016-second-brain-architecture
title: ADR-016 — Second Brain Architecture (Obsidian + MemPalace Convergence)
---

# ADR-016 — Second Brain Architecture: Obsidian + MemPalace Convergence

| Field | Value |
|-------|-------|
| Status | Implemented (EP-58 ✅, EP-59 ✅, EP-60 ✅ — Sprints 14–16) |
| Sprint | 14–16 |
| Deciders | Maaz |
| Epic | EP-58, EP-59, EP-60 |
| Date | 2026-04-26 |
| Implemented | 2026-04-27 |
| Supersedes | ADR-015 (extends, does not replace) |

---

## Context

### What Exists Today — Four Disconnected Memory Systems

EP-57 (Sprint 13) delivered MemPalace as an additive sidecar to the investigation engine. But it exposed a fundamental architectural deficiency: the project now runs **four knowledge systems that don't talk to each other**.

| System | Storage | Query Model | Write Trigger | Data Volume |
|--------|---------|-------------|---------------|-------------|
| **SQLite** (`data.db`) | better-sqlite3 | FTS5 BM25 + SQL | Every sync cycle | 660 messages, 184 Jira issues, 151 calendar events |
| **Notebooks** (`topic_notebooks`) | SQLite TEXT column | AI-generated summaries | After sync, per topic | 5 topics, 3–14KB each |
| **Obsidian Vault** (`Obsidiant/`) | Markdown files | Wikilink graph + human browse | After notebook rebuild | 44 files: 5 topics, 19 people, 20 clusters |
| **MemPalace** (`~/.work-intelligence-mcp/palace/`) | ChromaDB vectors + SQLite KG | Cosine similarity + entity traversal | Only on investigation conclude | **0 drawers, 0 triples, 0 diary entries** |

The palace is starving. It only gets written to when an investigation completes — which happened zero times in production. Meanwhile, hundreds of messages, dozens of Jira transitions, and 5 rich AI-generated notebooks exist but never reach the semantic layer.

### Six Critical Deficiencies in the Current Architecture

**D1 — Subprocess-per-call model is catastrophically slow.**

`PalaceClient` spawns a new Python process for every operation via `execFileSync`. Measured latency:
- Cold start (first call after boot): **5,020ms** — Python interpreter load + ChromaDB init + onnxruntime embedding model load
- Warm (OS module cache): **594ms** — still a full Python startup + import chain per call

The palace seeder writes ~150 triples sequentially. At 594ms/call that's **89 seconds** of blocking I/O at startup. During investigation, `queryPalaceMemory()` runs 2 parallel calls = 594ms wall clock (tolerable), but `writeToPalace()` runs 3 sequential calls = **1,782ms** of `execFileSync` blocking the event loop.

`execFileSync` is synchronous — it blocks the Node.js event loop. During every palace call, the entire web server is frozen. No HTTP requests are served. The `async` signatures on `PalaceClient` methods are misleading; every call is blocking despite being declared `async`.

**D2 — Palace is write-only from investigation; every other data source is excluded.**

The sync loop (steps 1–4b in `runFullSync()`) processes Teams → Calendar → Jira → Notebooks → Obsidian vault. MemPalace is absent from this pipeline. Only `InvestigationOrchestrator.writeToPalace()` writes to the palace, and only after a conclude — which requires a human to trigger `POST /api/jira/investigation/:key`.

**D3 — Obsidian vault is one-directional and disconnected from palace.**

`exportNotebooksToVault()` reads from `topic_notebooks` → renders markdown → writes to `Obsidiant/`. It has no awareness of MemPalace. The Obsidian graph shows wikilink connections but cannot surface semantic similarity (BIS blank ↔ recommended links missing) or causal chains (FF_RM_11372 → PROJ-15257).

**D4 — No KG entity model beyond feature flags.**

`palace-seeder.ts` only seeds feature flags from `feature-flags.yaml`. People (19 in Obsidian), Jira tickets (184), Teams chats (20 clusters), calendar events (151), and meeting decisions are invisible to the knowledge graph. The KG cannot answer "who works on KBA?" or "what decisions were made in the BiS Peter Weekly Sync?"

**D5 — Hardcoded Python path breaks portability.**


**D6 — No deduplication or staleness management.**

`palace-seeder.ts` writes triples on every startup without checking if they already exist in the KG (relies on MemPalace's `kgAdd` being "idempotent" — but the Python side creates a new triple ID each time via SHA hash of `subject+predicate+object`, which may or may not match). Notebooks are re-exported to Obsidian fully on every sync — no diffing, no incremental updates. There is no mechanism to invalidate stale KG triples when a flag status changes or a Jira ticket transitions.

---

## Decision

### Architecture: Three-Layer Memory Stack with Persistent Palace Process

Replace the subprocess-per-call model with a **long-running MemPalace MCP server process** and unify all four systems into a coherent three-layer memory stack.

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: Human Interface                                     │
│ ┌────────────────────┐  ┌────────────────────────────────┐  │
│ │ Obsidian Vault     │  │ Web UI (Dashboard, Chat, etc.) │  │
│ │ Browse, annotate,  │  │ Recall-augmented responses      │  │
│ │ visual graph       │  │ Provenance links                │  │
│ └─────────┬──────────┘  └──────────────┬─────────────────┘  │
├───────────┼────────────────────────────┼────────────────────┤
│ Layer 2: Intelligence                  │                     │
│ ┌─────────▼──────────────────────────▼─────────────────┐   │
│ │ AIAnalyzer (Notebooks, Digests, Chat, Investigation)  │   │
│ │ Reads from L1 + Palace. Writes summaries to L1.       │   │
│ └─────────┬────────────────────────────────────────────┘   │
├───────────┼─────────────────────────────────────────────────┤
│ Layer 1: Storage                                             │
│ ┌──────────────────┐  ┌──────────────────────────────────┐  │
│ │ SQLite (data.db)  │  │ MemPalace (palace/)              │  │
│ │ Structured facts  │  │ Semantic vectors + Temporal KG    │  │
│ │ FTS5 keyword      │  │ Cosine similarity + BFS traverse  │  │
│ │ Source of truth    │  │ Cross-domain connections          │  │
│ └──────────────────┘  └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Key Decisions

#### KD-1: Replace `execFileSync` with persistent MCP client connection

**Current**: Each `PalaceClient` method spawns `python -c "..."` via `execFileSync`. 594ms–5s per call. Blocks event loop.

**New**: Start MemPalace MCP server as a child process at web server boot (`python -m mempalace.mcp_server --palace <path>`). `PalaceClient` communicates via stdio JSON-RPC (the MCP protocol) using `@modelcontextprotocol/sdk`'s `StdioClientTransport`. One process, persistent connection, ~5–20ms per call after init.

**Fallback**: If spawn fails or process dies, all methods return `''`/`void` (existing graceful degradation). Auto-restart with exponential backoff (1s → 2s → 4s → max 30s).

**Impact**: Seeder goes from 89 seconds to ~3 seconds. Investigation `writeToPalace()` goes from 1,782ms blocking to ~60ms non-blocking. Event loop never frozen.

#### KD-2: Universal Memory Writer — MemPalace is updated in the sync loop

Add step 4c to `runFullSync()` after notebook rebuild and Obsidian export:

```
4c. Palace enrichment (EP-58)
    For each topic notebook:
      → palace.addDrawer(wing='topics', room=topicName, content=notebookMarkdown)
    For each Jira issue with status change since last sync:
      → palace.kgAdd(issueKey, 'has-status', newStatus, valid_from=transitionDate)
      → palace.kgInvalidate(issueKey, 'has-status', oldStatus, ended=transitionDate)
      → palace.kgAdd(issueKey, 'assigned-to', assignee)
      → palace.kgAdd(issueKey, 'component', component)
    For each new message cluster:
      → palace.addDrawer(wing='conversations', room=chatSlug, content=summary)
      → palace.kgAdd(personName, 'discussed', topicTag, valid_from=messageDate)
    For each calendar meeting with transcript:
      → palace.addDrawer(wing='meetings', room=meetingSlug, content=transcript)
      → palace.kgAdd(meetingTitle, 'decided', decision, valid_from=meetingDate)
```

All palace writes are fire-and-forget with error logging. Sync does not block on palace failures.

#### KD-3: Obsidian export enriched with palace context

`exportNotebooksToVault()` gets an optional `PalaceClient` parameter. For each topic note, inject a `## Deep Memory` section:

1. `palace.search(topicName, limit=3)` — semantically related drawers from other wings
2. `palace.kgQuery(topicName)` — entity relationships (people, decisions, blockers)

This surfaces cross-domain connections in Obsidian's graph that wikilinks alone cannot express.

#### KD-4: Recall-augmented chat

`chatWithContext()` currently uses FTS5 + notebook content. Add palace queries before AI generation:

1. `palace.search(userQuestion, limit=5)` — semantic matches across all wings
2. Extract named entities from question → `palace.kgQuery(entity)` for each
3. Inject results as a `## Memory Context` block in the system prompt

The chat then has access to causal chains, temporal facts, and semantic connections beyond what keyword search provides.

#### KD-5: Wing/room taxonomy for the universal writer

```
Wings (domains):
  topics          — AI-generated notebook summaries
  conversations   — Teams/email thread summaries
  meetings        — Calendar meeting transcripts + decisions
  investigations  — Bug investigation reports (existing EP-57)
  jira            — Jira issue analysis reports

Rooms (categories within wings):
  topics/teams, topics/KBA, topics/BDS, ...
  conversations/<chat-slug>
  meetings/<meeting-slug>
  investigations/config-change, .../code-regression, ...
  jira/<component>

KG Predicate Vocabulary:
  has-status, assigned-to, component, caused-regression,
  discussed, decided, blocked-by, depends-on, active-in-cluster,
  has-status (temporal: valid_from/valid_to), activated-on, description
```

#### KD-6: Portable Python path resolution

Replace the hardcoded path with resolution order:
1. `MEMPALACE_PYTHON` env var (explicit override)
2. `which mempalace` → derive Python from the shebang or venv
3. `python3 -m mempalace.mcp_server` as a last resort
4. Mark `available = false` if none resolve

---

## Alternatives Considered

### A1: Embed ChromaDB directly in Node.js (chromadb npm package)

Use the official `chromadb` npm client talking to a local ChromaDB server.

**Rejected**: ChromaDB's Node.js client requires a running Chroma server (separate process) or their serverless client (cloud dependency). MemPalace bundles its own ChromaDB `PersistentClient` in-process — no server needed. Replacing it with raw ChromaDB loses the KG, diary, AAAK dialect, graph traversal, tunnels, and all 29 MCP tools.

### A2: sqlite-vec for vector search + keep SQLite KG in data.db

Add `sqlite-vec` native extension to `data.db` for vector search. Keep the temporal KG as new tables in `data.db`.

**Rejected**: `sqlite-vec` requires OS-specific native binaries (macOS arm64, macOS x86, Linux) — a build/distribution problem for a local dev tool. Also means maintaining our own embedding pipeline (which model? batching? reindexing?). MemPalace handles all of this with ChromaDB's built-in `onnxruntime` embedding.

### A3: Keep subprocess model, batch calls

Modify `PalaceClient` to batch multiple operations into a single `python -c` script.

**Rejected as a half-measure**: Even with batching, each call still pays the 594ms Python startup. The seeder would go from 150 calls to ~5 batched calls (3 seconds) — but every runtime query still pays 594ms. The persistent MCP process model eliminates startup cost entirely and aligns with how MemPalace is designed to be used.

### A4: Replace Obsidian with MemPalace entirely

Stop generating Obsidian vault files. Use MemPalace search for everything.

**Rejected**: Obsidian provides a **visual, browsable, human-editable** interface that no API can replace. The Obsidian graph view, the `<!-- USER ANNOTATIONS BELOW -->` pattern, and the ability to open a note in your editor are irreplaceable for human cognition. The two systems serve different audiences: Obsidian is for the human, MemPalace is for the machine.

---

## Implementation Roadmap

### EP-58 — Universal Memory Writer + Persistent Palace Process

| Wave | Deliverable | Effort |
|------|-------------|--------|
| 58-01 | `PalaceClient` v2: persistent MCP child process with stdio transport, auto-restart, portable path | Medium |
| 58-02 | `MemoryEnricher` service: notebook → drawer, Jira transitions → KG triples, entity extraction | Medium |
| 58-03 | Wire `MemoryEnricher` into `runFullSync()` step 4c; palace seeder uses persistent client | Small |
| 58-04 | Obsidian export enrichment: `## Deep Memory` section with palace search + KG query | Small |
| 58-05 | Smoke test + performance benchmark (seeder < 5s, per-query < 50ms) | Small |

### EP-59 — Recall-Augmented Chat + Semantic Search

| Wave | Deliverable | Effort |
|------|-------------|--------|
| 59-01 | Entity extraction from chat questions (NER via LLM tool-use) | Medium |
| 59-02 | `chatWithContext()` palace integration: search + kgQuery before generation | Medium |
| 59-03 | KG traversal for multi-hop answers: `palace.traverse()` up to 3 hops | Medium |
| 59-04 | Provenance in chat responses: source drawer IDs → clickable links in UI | Small |

### EP-60 — Autonomous Memory Growth

| Wave | Deliverable | Effort |
|------|-------------|--------|
| 60-01 | `kg_invalidate` on Jira status transitions (temporal fact lifecycle) | Small |
| 60-02 | Obsidian annotations → palace drawers (human knowledge feedback loop) | Medium |
| 60-03 | Cross-wing tunnel auto-discovery: shared entities across wings | Medium |
| 60-04 | Memory health dashboard: stale facts, orphan entities, coverage gaps | Medium |

---

## Consequences

### Positive

- **90× faster palace startup**: Seeder drops from 89s to &lt;5s. Runtime queries from 594ms to &lt;50ms.
- **Event loop never blocked**: Stdio MCP transport is async. No more `execFileSync`.
- **Palace populates itself**: Every sync cycle enriches the palace. After 1 week of daily syncs: ~5 topic drawers, ~50+ KG triples from Jira, ~20 conversation drawers, ~10 meeting drawers. The semantic search becomes useful immediately.
- **Obsidian becomes smarter**: `## Deep Memory` section surfaces connections invisible to wikilinks. A person note for "Gahr, Alexander" would show semantically related investigation reports and meeting decisions, not just message counts.
- **Chat answers improve**: Palace recall adds causal chains and temporal context that FTS5 keyword search cannot provide. "What happened with recommended links?" gets FF_RM_11372 context injected before the LLM generates its response.
- **Knowledge compounds**: Every data source writes to both SQLite (structured) and palace (semantic). Over months, the KG builds a dense entity graph spanning people → tickets → decisions → meetings → investigations. `traverse()` discovers connections that no single query could find.

### Negative / Trade-offs

- **Two persistent processes**: Web server now manages a MemPalace child process. If it crashes, palace calls degrade gracefully but must auto-restart. Adds operational complexity.
- **Dual-write consistency**: SQLite and palace can drift. Palace writes are fire-and-forget — a failed palace write means SQLite has data the palace doesn't. Acceptable because palace is enrichment, not source of truth. SQLite remains authoritative.
- **ChromaDB embedding model size**: onnxruntime + all-MiniLM-L6-v2 ≈ 90MB in memory for the palace process. On a developer laptop with 16GB+ RAM this is negligible; on constrained environments it matters.
- **AAAK dialect concern**: MemPalace compresses diary entries using AAAK (a compressed text dialect). This degrades embedding quality for diary entries because cosine similarity operates on the compressed form. MemPalace's own TODO notes this: "Future versions should expand AAAK before embedding." For now, diary entries have lower recall precision than drawers.

---

## Verification Criteria

- [ ] `PalaceClient` v2 connects via MCP stdio; `tool_status` returns within 50ms after init
- [ ] Palace child process auto-restarts after SIGKILL within 5 seconds
- [ ] Seeder completes in &lt;5 seconds (was 89s)
- [ ] `runFullSync()` step 4c writes topic drawers + Jira KG triples without blocking sync
- [ ] Obsidian topic notes include `## Deep Memory` section when palace has content
- [ ] `chatWithContext()` includes palace results in system prompt
- [ ] `MEMPALACE_PATH` unset → all palace behavior is no-op (zero regression)
- [ ] No hardcoded paths in `PalaceClient`

---

## Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Persistent MCP process over subprocess-per-call | 594ms→&lt;50ms per call; unblocks event loop |
| 2 | Palace is enrichment layer, not source of truth | SQLite remains authoritative; palace can rebuild from SQLite |
| 3 | Fire-and-forget writes | Palace failures must not break sync or investigation |
| 4 | Wing/room taxonomy mirrors data sources | Enables `find_tunnels(jira, conversations)` for cross-domain discovery |
| 5 | Obsidian + Palace coexist | Human visual interface + machine semantic interface serve different needs |
| 6 | Entity extraction at write time, not query time | Amortizes NER cost; KG is pre-built when queries arrive |
| 7 | `kg_invalidate` for temporal facts | Jira statuses, flag statuses change — old facts must be end-dated, not deleted |

---

## Dependency Risk — Exit Strategy

**Risk:** MemPalace is a single-maintainer Python library. If abandoned:

**Degradation path:**
1. **Immediate:** Palace client degrades to no-op (already built-in). All core features continue via SQLite. The `palace:rebuild` command means no data is locked in the palace — SQLite is the source of truth.
2. **Short-term migration (1-2 days):** Replace ChromaDB vector store with `sqlite-vec` extension for embeddings. KG triples migrate to a new SQLite `kg_triples` table (`subject TEXT, predicate TEXT, object TEXT, valid_from TEXT, valid_to TEXT`).
3. **Long-term alternative:** Replace MemPalace entirely with Ollama local embeddings + sqlite-vec for vector search + SQLite KG tables. Zero external Python dependency.

**Mitigation already in place:**
- All sync data persisted to SQLite first, then written to palace (palace is a derived cache)
- `investigation_sessions.palace_payload` ensures investigation memory survives palace loss
- `npm run palace:rebuild` replays all SQLite data into a fresh palace
- `MEMPALACE_PATH` unset → all palace behavior is no-op (zero regression)
- Health endpoint monitors palace connectivity

---

## Scope Fence — EP-59/EP-60 Gate Criteria

EP-58 establishes the palace as a populated, persistent memory layer. Subsequent phases are gated on:

| Metric | Threshold | How Measured |
|--------|-----------|-------------|
| Palace drawers | >50 after 1 week of syncs | `GET /api/palace/status` → `drawerCount` |
| KG triples | >50 after 1 week of syncs | `GET /api/palace/status` → `tripleCount` |
| Topic recall rate | >80% of topics return non-empty `palace.search(topicName)` | Manual spot check |
| Per-query latency | \<50ms | PalaceClient.stats timing |
| Seeder time | \<5s | Measured at boot |

**EP-59 (Recall-Augmented Chat)** requires: drawers >50, recall rate >80%.
**EP-60 (Autonomous Memory Growth)** requires: EP-59 complete, retrieval instrumentation for health metrics.

Do NOT begin EP-59 planning until these thresholds are met in production.
