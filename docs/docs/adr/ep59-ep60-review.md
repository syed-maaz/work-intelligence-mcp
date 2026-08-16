---
id: ep59-ep60-review
title: EP-59 & EP-60 Multi-Expert Review — Recall-Augmented Chat & Autonomous Memory Growth
---

# EP-59 & EP-60 — Multi-Expert Architectural Review

| Field | Value |
|-------|-------|
| Epics Under Review | EP-59 (Recall-Augmented Chat), EP-60 (Autonomous Memory Growth) |
| Date | 2026-04-26 |
| Reviewers | 4 expert agents (Senior Architect, Data/ML Engineer, Database Manager, Senior Developer) |
| Prerequisite | EP-58 (Universal Memory Writer) must be complete and validated |
| EP-59 Final Verdict | **APPROVE WITH CONDITIONS** (unanimous) |
| EP-60 Final Verdict | **APPROVE WITH REDUCED SCOPE** (unanimous — cut 60-03, deprioritize 60-04) |

---

## Review Process

Four independent expert agents reviewed EP-59 and EP-60 from their specialist perspectives. Each had full access to ADR-016, the ADR-016 review, current codebase (`palace-client.ts`, `sync.ts`, `analyzer.ts`, `web-server.js`, `embedder.ts`), and project context. This document synthesizes their findings.

---

## EP-59 — Recall-Augmented Chat + Semantic Search

### Unanimous Agreement

**1. The wave sequence is logical.** NER (59-01) → palace integration (59-02) → KG traversal (59-03) → provenance UI (59-04). Each wave builds on the previous.

**2. Palace context must NOT modify `chatWithContext()` signature.**

> **Developer**: "Do not add palace calls inside `chatWithContext()`. That method is Analyze-stage. Palace results should be fetched in web-server.js (Fetch stage), converted to `ContextItem[]`, and merged into existing `contextItems` before `rankContextItems()`."
>
> **Architect**: "59-02 acceptance criteria must include graceful degradation when palace is unavailable."

All reviewers agreed: palace results enter as `ContextItem` objects with `source: 'palace-search'` and `source: 'palace-kg'`. No `chatWithContext()` API change.

**3. Retrieval fusion (RRF) is required, not optional.**

> **Data/ML Engineer**: "Your `embedder.ts` `hybridSearch()` already implements RRF with `k=60`. This is not a new invention — extend it to include palace search and KG results as additional rank lists."
>
> **Architect**: "RRF is absent as a distinct deliverable — split 59-02 into 59-02a (palace integration) and 59-02b (RRF fusion + retrieval instrumentation)."

### Debate Points

#### Debate A: NER approach — LLM vs Regex

| Reviewer | Position |
|----------|----------|
| **Architect** | REGEX — "With ~100 drawers, LLM NER is overkill. Regex for Jira keys, `team_members` names, flags covers 90%. Defer LLM NER to >500 drawers." |
| **Data/ML Engineer** | BOTH — "Sync-time NER (Haiku) populates KG. Query-time NER routes retrieval. Complementary, not competing." |
| **Developer** | PARALLEL — "NER must `Promise.all` with FTS5. Replace existing naive keyword extraction (words >= 4 chars) with structured entities." |
| **DB Manager** | EPHEMERAL — "No new SQLite table. Keep entity extraction per-request." |

**Resolution**: **Tiered approach.** Query-time: regex/dictionary extraction for Jira keys, known people, flags (zero latency). Sync-time: Haiku tool-use NER for `message_entities` population in MemoryEnricher (amortized cost). LLM query-time NER deferred until palace exceeds 500 drawers.

#### Debate B: Traversal depth — 1, 2, or 3 hops

| Reviewer | Position |
|----------|----------|
| **Architect** | 1 HOP — "Cap at 1-hop, configuration flag for future." |
| **Data/ML Engineer** | 2 HOPS — "Jira key → flag → deployment is exactly 2 hops. 3 hops returns 60%+ of graph." |
| **Developer** | FORMAT CONCERN — "Results must be natural language, not JSON. Cap at 15 paths." |
| **DB Manager** | CACHE — "Cache `build_graph()` with TTL, not per-request rebuild." |

**Resolution**: **2-hop default with safety cap.** `maxHops=2`, `maxNodes=15`. Cache `build_graph()` result (TTL = 5 minutes or on sync completion). Format as natural language paths, not JSON. Parameterize for future increase.

#### Debate C: Provenance UI pattern

| Reviewer | Position |
|----------|----------|
| **Data/ML Engineer** | INLINE CITATIONS — "Bracketed references like `[Teams:KBA Chat, Apr 22]`. No footnotes." |
| **Developer** | REUSE EXISTING — "ChatPanel already has `addAssistantMessage` with `sources` array. Wire it up, don't build new components." |

**Resolution**: Inline superscript references in reply text, with expandable source section below the message. Reuse existing `sources` flow.

### EP-59 Consolidated Conditions

| # | Condition | Source | Priority |
|---|-----------|--------|----------|
| **59-C1** | Query-time NER via regex/dictionary (Jira keys, `team_members`, flags). Defer LLM NER to >500 drawers. | Architect | Blocking |
| **59-C2** | Add sync-time Haiku NER in MemoryEnricher to populate entity index in palace KG. | Data/ML | Required |
| **59-C3** | Split 59-02 into 59-02a (palace search integration) and 59-02b (RRF fusion + retrieval recall instrumentation). | Architect, Data/ML | Blocking |
| **59-C4** | Palace results enter as `ContextItem[]` in web-server.js, no `chatWithContext()` signature change. | Developer | Blocking |
| **59-C5** | 59-03: `maxHops=2`, `maxNodes=15`. Cache `build_graph()` with 5-min TTL. Format as natural language paths. | Data/ML, DB Manager | Required |
| **59-C6** | Every palace call: timeout + graceful fallback. Chat must work without MemPalace. | Developer, Architect | Blocking |
| **59-C7** | Provenance via existing `addAssistantMessage` sources flow. Inline citations, expandable source cards below message. | Developer, Data/ML | Required |
| **59-C8** | Injected palace context capped at ~2000 tokens to avoid diluting signal. | Data/ML | Required |
| **59-C9** | Gate: EP-58 must deliver >50 drawers and >80% non-empty recall before 59-02 begins. | Architect (ADR-016 review) | Blocking |
| **59-C10** | Minimum 5 unit tests for 59-01 NER extraction logic. | Developer | Required |

### EP-59 Verdict: APPROVE WITH CONDITIONS

---

## EP-60 — Autonomous Memory Growth

### Unanimous Agreement

**1. 60-01 (`kg_invalidate`) is a prerequisite for EP-59, not an EP-60 deliverable.**

> **Architect**: "If palace returns a KG triple saying 'PROJ-15257 is IN_PROGRESS' when it was resolved two weeks ago, recall-augmented chat produces wrong answers. Move 60-01 to EP-58 or EP-59 wave 0."
>
> **Data/ML Engineer**: "End-date the KG triple only. Do not re-embed drawers. Write a new transition triple to preserve the temporal chain."
>
> **DB Manager**: "MemPalace already implements `invalidate()` and `tool_kg_invalidate`. PalaceClient just needs `kgInvalidate()` method."

All four agreed: **60-01 must ship before EP-59 goes live.**

**2. 60-03 (cross-wing tunnels) is premature and should be cut.**

> **Architect**: "With 5 wings and ~20 drawers per wing, shared entities are trivially discoverable by a single `kgQuery` hop."
>
> **Data/ML Engineer**: "Cut entirely. KG traversal in 59-03 already surfaces cross-wing connections implicitly. Revisit at 300+ drawers."
>
> **DB Manager**: "`find_tunnels()` calls `build_graph()` which does a full ChromaDB scan. Acceptable as background job, not real-time."
>
> **Developer**: "Daily cadence or batched post-sync, not every cycle. Circuit breaker if >10s."

**Resolution**: **Cut 60-03.** Revisit when palace exceeds 300 drawers. The implicit cross-wing discovery via KG traversal in 59-03 is sufficient.

**3. 60-04 (health dashboard) is nice-to-have, not must-have.**

All reviewers agreed it should be deprioritized. Ship only if 60-01 and 60-02 complete ahead of schedule.

### Debate Points

#### Debate D: Obsidian annotation extraction — Real-time vs On-sync

| Reviewer | Position |
|----------|----------|
| **Data/ML Engineer** | ON-SYNC — "Scan during `runFullSync()`. 15-min cadence is fine for human annotation rate. Use frontmatter YAML, not comment markers." |
| **Developer** | `fs.watch` — "Node 20 supports recursive watch on macOS. Debounce 2s per path. Do NOT add chokidar." |
| **DB Manager** | DEBOUNCE + HASH — "Content SHA-256 comparison. Annotation-only parsing scope. Try/catch for atomic-rename conflicts." |

**Resolution**: **Hybrid approach.** Primary: on-sync extraction (every 15 min, reliable). Optional: `fs.watch` with 2s debounce + content hash for faster feedback when user is actively annotating. Extract below `<!-- USER ANNOTATIONS BELOW -->` marker (existing pattern). No chokidar dependency.

#### Debate E: Health dashboard metrics

| Reviewer | Recommended Metrics |
|----------|-------------------|
| **Data/ML Engineer** | 4 metrics: stale facts, orphan rate, topic coverage, retrieval hit rate |
| **DB Manager** | Same 4 + backup status |
| **Developer** | Single endpoint `GET /api/palace/health`, reuse dashboard card pattern |

**Resolution**: Ship with exactly 4 metrics. The retrieval hit rate requires instrumentation from EP-59-02b — so 60-04 is gated on EP-59.

#### Debate F: Conflict resolution for human annotations

> **Architect**: "If a user annotates 'this person left the team' against an active KG relationship, which wins? Specify in acceptance criteria."

**Resolution**: Human annotations override palace data. Write an audit trail via `palace.diaryWrite()` when an annotation contradicts existing KG state.

### EP-60 Revised Scope

| Wave | Original | Revised | Status |
|------|----------|---------|--------|
| 60-01 | `kg_invalidate` on Jira transitions | **Moved to EP-58 scope or EP-59 wave 0** | Prerequisite |
| 60-02 | Obsidian annotations → palace | **Keep** — on-sync primary, optional fs.watch | Approved |
| 60-03 | Cross-wing tunnel auto-discovery | **CUT** — implicit via 59-03 traversal | Deferred (300+ drawers) |
| 60-04 | Memory health dashboard | **Deprioritized** — execute opportunistically | Conditional |

### EP-60 Consolidated Conditions

| # | Condition | Source | Priority |
|---|-----------|--------|----------|
| **60-C1** | Move 60-01 (`kg_invalidate`) to EP-58 sync loop or EP-59 wave 0. Must ship before recall-augmented chat. | All 4 reviewers | Blocking |
| **60-C2** | Cut 60-03 (cross-wing tunnels). Revisit at 300+ drawers. | All 4 reviewers | Blocking |
| **60-C3** | 60-02: on-sync extraction primary. Debounce 2s, content hash dedup, annotation-only parsing. | DB Manager, Developer | Required |
| **60-C4** | 60-02: human annotations override palace data with `diaryWrite()` audit trail. | Architect | Required |
| **60-C5** | 60-04: exactly 4 metrics (stale facts, orphan rate, topic coverage, retrieval hit rate). Gated on EP-59 instrumentation. | Data/ML, Developer | Required |
| **60-C6** | Document that `~/.work-intelligence-mcp/palace/` is now backup-critical after EP-60-02 (human annotations not rebuildable). | DB Manager | Required |
| **60-C7** | `kgInvalidate()` must be idempotent — calling twice for same transition must not corrupt state. | Developer | Required |
| **60-C8** | Deprioritize 60-04 — execute only if 60-01+60-02 complete ahead of schedule. | Architect | Recommended |

### EP-60 Verdict: APPROVE WITH REDUCED SCOPE

---

## Cross-Epic Execution Order (Recommended)

All four reviewers converged on this optimal ordering:

```
Phase 1: EP-58 (all 5 waves) + 60-01 (kg_invalidate — moved up)
  ├── 58-01: PalaceClient v2 persistent MCP process
  ├── 58-02: MemoryEnricher service + kgInvalidate() method
  ├── 58-03: Wire into sync loop + palace seeder fix
  ├── 58-04: Obsidian Deep Memory enrichment
  ├── 58-05: Smoke test + benchmark
  └── 60-01: kg_invalidate wired to Jira transitions in sync loop

  ── GATE: >50 drawers, >80% non-empty recall after 1 week ──

Phase 2: EP-59 (5 waves, revised)
  ├── 59-01:  Query-time regex NER + sync-time Haiku NER in MemoryEnricher
  ├── 59-02a: Palace search integration as ContextItem[] in web-server.js
  ├── 59-02b: RRF fusion (extend hybridSearch pattern) + retrieval instrumentation
  ├── 59-03:  KG traversal (2-hop, maxNodes=15, cached graph, NL format)
  └── 59-04:  Provenance UI (inline citations, existing sources flow)

Phase 3: EP-60 (2 waves, reduced)
  ├── 60-02: Obsidian annotations → palace (on-sync + optional fs.watch)
  └── 60-04: Memory health dashboard (4 metrics, gated on 59-02b instrumentation)
```

### Missing Pieces Identified (Not Covered by EP-59/60)

| Gap | Identified By | Recommendation |
|-----|--------------|----------------|
| **Embedding model alignment**: Palace uses MiniLM-L6-v2, EP-37 uses Ollama nomic-embed-text (768-dim). Different embedding spaces. | Architect | Document as known limitation. RRF papers over quality gaps but doesn't fix them. |
| **Chat latency budget**: Palace recall must complete in &lt;500ms or be skipped. | Architect | Add as acceptance criterion for 59-02a. |
| **Palace capacity planning**: No wave addresses growth past ChromaDB single-node limit (~1M vectors). | Architect | Documented assumption — not urgent at current scale. |
| **EP-37 hybridSearch interaction**: Existing `hybridSearch()` uses Ollama embeddings. Palace search uses MiniLM. Two vector searches from different models. | Data/ML | RRF handles rank fusion across different scoring systems. Acceptable. |

---

## Appendix: Individual Reviewer Verdicts

| Reviewer | EP-59 | EP-60 | Key Unique Contribution |
|----------|-------|-------|------------------------|
| **Architect** | Approve w/ 4 conditions | Approve reduced scope | Scope fence, dependency reordering (60-01 → EP-58), tunnel deferral |
| **Data/ML Engineer** | Approve w/ 4 conditions | Approve reduced (cut 60-03) | RRF design, 2-hop cap, 4 health metrics, dual NER strategy |
| **Database Manager** | Approve w/ 3 conditions | Approve w/ 4 conditions | Graph cache TTL, debounce+hash for file watch, backup criticality |
| **Developer** | Approve w/ 5 conditions | Approve w/ 4 conditions | Pipeline integration (web-server.js not chatWithContext), no chokidar, test mandate |
