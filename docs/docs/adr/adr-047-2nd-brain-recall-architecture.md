---
sidebar_label: "ADR-047: 2nd-Brain Recall Architecture"
sidebar_position: 47
title: "ADR-047: 2nd-Brain Recall — auto-recall on every message, hybrid-RRF over 8 lanes, no rewrite"
status: Proposed (2026-07-27)
date: 2026-07-27
---

# ADR-047: 2nd-Brain Recall Architecture

**Status:** 📝 **Proposed (2026-07-27)**

**Related:**
- [ADR-024](./adr-024-unified-brain.md) — Unified Brain API (this ADR extends its recall surface)
- [ADR-015](./adr-015-mempalace-integration.md) — MemPalace sidecar (still active; measurement gate below)
- [ADR-046](./adr-046-model-neutral-agent-contract.md) — precedence & non-negotiables observed during execution
- [ADR-048](./adr-048-external-corpora-mem-claude-obsidian.md) — mem-claude retirement + Obsidian federated peer (companion)

---

## Context

User statement (verbatim, 2026-07-27):

> "I had to ask multiple times to look into a particular task and it didn't have previous memory. For example search-provider proxy. My topic expert is based on this too but it's plain text, not empowering as 2nd brain. It summarizes extracted knowledge but doesn't help me in coding or daily tasks."

Live substrate audit found:
- `brain_decisions` has 5+ rows explicitly mentioning "search-provider proxy" (including *"Focus today on resuming the search-provider proxy/gateway investigation tied to PROJ-15222"*).
- `brain_action_clusters` has 300 rows mentioning search-provider.
- `messages` has 256 raw messages mentioning search-provider.
- `message_embeddings` (2,682 rows, 99.7% coverage of `messages`), `doc_embeddings` (146), `prompt_memory` (893, with Cypher goal→skill→outcome triples) are all populated with 768-dim `nomic-embed-text` vectors.

None of that data reached the user's chat when they asked about search-provider proxy. Two proximate causes were identified during the debate rounds:

1. **The wings-filter bug** (`src/services/brain/recall.ts:391-404` combined with `web-server.js:8026-27`): every work-mode `/api/chat` message passes a non-empty `wings` array, which caused `recallMemory` to intentionally drop `queryDecisions / queryClusters / queryVerifications`. The comment in the source explicitly states this: *"decisions + clusters do not carry a wing tag yet, so including them would leak cross-wing rows."* The safety was correct for wings-strict callers but crippled the everyday chat path.

2. **No pre-chat recall trigger.** The verb-router in `web-server.js` (routing `should I…` / `do I…` to `/api/brain/decide`) gates brain access behind a linguistic pattern. Any other question bypasses recall entirely. Team A caught this in Round 1.

Two additional gaps surfaced during the 5 debate rounds:

3. **Cache-freshness hole.** `brain_decisions.cache_key = sha256(question ‖ user ‖ utcDay)` returns stale same-day answers when new evidence (notebook update, verification, investigation) lands after the first answer. Team B caught this in Round 1.

4. **3,721 embedding rows sitting unused for chat.** `recall.ts` had zero vector code. Cypher's `prompt_memory` learning loop (893 goal→skill→outcome triples) implements exactly *"if I am doing similar work it will understand"* but is Cypher-scoped only.

## Decision

Extend the shipped Unified Brain (ADR-024) with three additions and one fix. Do NOT rewrite `recallMemory`. Do NOT retire MemPalace (measurement-gated separately).

### D1. Wings-filter fix (receiver-side decoupling)

Decouple SQLite-lane participation from the `wings` filter in `recallMemory`. Add `sqliteLanes?: boolean` param (default `true`). `wings` still scopes palace search; SQLite lanes participate independently.

**Chosen over caller-side workaround** (passing `wings: []` in `web-server.js`) because Team C's non-negotiable was correct: the caller-side hack papers over the real design flaw and preserves the trap for the next call site that hits the same pattern.

### D2. Unconditional preflight_recall in chat

Every `/api/chat` message triggers `buildPreflightContext(message, db, palace)` BEFORE the verb-router branch. Results inject into the system prompt as `## Prior context`. Verb-gate still decides whether to route to `/api/brain/decide` (expensive) vs. `chatWithContext` (cheap) — but recall runs unconditionally.

### D3. Cache-freshness guard on `/api/brain/decide`

Before returning a same-day cache hit, `hasNewerRelatedEvidence(db, cachedRow)` checks whether any related `topic_notebooks.last_updated` or `brain_verifications.created_at` is newer than `brain_decisions.created_at`. If so, bypass the cache and re-compute. `cache_key` contract stays locked.

### D4. HYBRID-RRF embedding lanes

Add cosine similarity over `message_embeddings` (2,682 rows), `prompt_memory` (893, promoted from Cypher-only), `doc_embeddings` (146), and (via ADR-048) `obsidian_notes.embedding`. Merge all 8 lanes (palace + brain_decisions + brain_clusters + brain_verifications + notebook_LIKE + message_cosine + prompt_memory_cosine + doc_cosine) via Reciprocal Rank Fusion `k=60`.

- Cosine implementation: pure SQLite UDF via `db.function('cosine_similarity', ...)`. ~3 ms per full 3,721-row scan on M4. No `sqlite-vec` at this scale.
- Query embedded once per preflight; reused across lanes.
- Non-fatal on embedder outage: LIKE/FTS lanes still fire when Ollama is down.

### D5. Topic-expert read-first + write-back

`askTopicExpert` reads from `topic_notebooks` + `recallMemory` BEFORE FTS5/GitHub. Writes condensed synthesis back to the vault `.md` file (above-separator only — user annotations preserved; see ADR-048). chokidar picks up the write and re-indexes.

### D6. Auto-populate topic notebooks from `/api/brain/learn`

When a decision outcome is recorded, if the decision's keywords match any `topics.name`, append a condensed snippet into the matching `topic_notebooks` row. Additive to existing `MemoryEnricher.decisions` fan-out.

---

## Acceptance Criteria

### Phase 1 — User flows (the bar for ✅ Accepted)

| # | AC | Verification |
|---|----|--------------|
| AC-U1 | User asks *"what happened with search-provider proxy?"* via `/api/chat` and gets a response citing specific `brain_decisions` (PROJ-15222, PR3, Maaz's investigation) WITHOUT the user needing to re-state history. | `TEST-CASES.md` TC-01 + TC-06 |
| AC-U2 | User asks *"what's happening with the search engine gateway?"* (no keyword overlap with "search-provider") and the response includes search-provider hits via semantic similarity. | TC-02 |
| AC-U3 | User asks *"help me investigate a stuck Jira ticket with proxy 401 errors"* and the response cites prior sessions from `prompt_memory` with `goal → chosen_skill → outcome` context. | TC-03 |
| AC-U4 | Same-day repeated question to `/api/brain/decide` returns a re-computed decision after newer notebook/verification evidence lands. | TC-05 |
| AC-U5 | MemPalace sidecar is offline; user's chat continues to work, returning SQLite-lane and embedding-lane hits. HTTP 200, ≥1 result. | TC-10 (invariant across all phases) |

### Phase 2 — Substrate (the bar for 🚧 Substrate Accepted)

| # | AC | Verification |
|---|----|--------------|
| AC-S1 | `RecallMemoryArgs.sqliteLanes` exists (default `true`) in `src/services/brain/recall.ts`. Passing non-empty `wings` no longer drops SQLite lanes. | `tests/services/brain/recall-wings.test.ts` updated per Phase 1 Task 1.3; `npx vitest run tests/services/brain/recall-wings.test.ts` |
| AC-S2 | `buildPreflightContext(message, db, palace)` exists in `src/services/brain/preflight-recall.ts` and is called from `/api/chat` in `web-server.js` BEFORE the verb-router branch. | grep `buildPreflightContext` in `web-server.js`; smoke test on `/api/chat` returns `## Prior context` in system prompt echoes |
| AC-S3 | `hasNewerRelatedEvidence` exists in `src/services/brain/decision-engine.ts`; cache-return path branches on its result. | `tests/services/brain/decision-engine-freshness.test.ts` (2 cases: newer evidence → bypass; older evidence → cache hit) |
| AC-S4 | `cosine_similarity(blob1, blob2)` SQLite UDF is registered at server boot. `SELECT cosine_similarity(embedding, embedding) FROM message_embeddings LIMIT 3` returns 1.0 for all rows. | Manual SQL check in TC-02 setup |
| AC-S5 | `rrfMerge([...lanes], 60, limit)` in `src/services/brain/rrf-merge.ts` is called from `recallMemory` in place of the current `merged.sort(...)`. Unit test with 3 mocked lanes returns expected order. | New unit test `tests/services/brain/rrf-merge.test.ts` |
| AC-S6 | Migration `v82_external_observations` and `v83_obsidian_notes` (+ v83 amendment adding `embedding` column) run clean on a fresh DB AND on the pre-Phase-79 DB. | `sqlite3` schema check after each migration; `PRAGMA integrity_check;` returns `ok` |
| AC-S7 | `queryVaultCosine`, `queryMessageCosine`, `queryPromptMemoryCosine`, `queryDocCosine` in `src/services/brain/recall-embeddings.ts` all return `{ id, snippet, score, created_at }` shape. | Unit tests seeded with known vectors |

### Phase 3 — Rollout safety

| # | AC | Verification |
|---|----|--------------|
| AC-R1 | If `nomic-embed-text` on Ollama is unreachable, `buildPreflightContext` returns non-empty context from LIKE/FTS lanes without throwing. `queryBlob === null` path is exercised. | TC-10 + a variant that stops Ollama |
| AC-R2 | Env-flag gate `WI_2ND_BRAIN_PHASE_79_ENABLED=0` reverts preflight_recall to a no-op without server restart. | smoke section that toggles the flag mid-stream |
| AC-R3 | Rollback procedure per phase documented in `EXECUTOR-RUNBOOK.md` § 5. Each phase reverts cleanly via `git revert HEAD` (+ optional SQL cleanup for phases that added tables). | grep of runbook |
| AC-R4 | All 10 test cases in `TEST-CASES.md` (TC-01…TC-10) pass in the test-log JSONL. Global invariant TC-10 remains PASS at every phase boundary. | `test-log.jsonl` audit |

---

## Operations

### Enable

Phase-by-phase rollout as described in `EXECUTION-PLAN.md`. Phases 1-6 land the recall changes; Phases 7-8 land external-corpus integration (ADR-048). Phase 9 is a 2-4 week measurement gate for MemPalace fate.

### Disable / rollback

- **Global kill-switch:** `WI_2ND_BRAIN_PHASE_79_ENABLED=0` on the bridge process reverts `buildPreflightContext` to a no-op returning `""`. Everything else in the pipeline degrades gracefully because SQLite lanes and palace already existed.
- **Per-phase rollback:** see `EXECUTOR-RUNBOOK.md` § 5.
- **Full plan rollback:** `git checkout master && git branch -D phase-79-2nd-brain-loop`; drop new tables via each migration's `down()`.

### Migration data touch

- `v82_external_observations` — INSERT-only (adds ~20,248 rows from mem-claude backfill, ~50 MB).
- `v83_obsidian_notes` — INSERT-only (adds ~112 rows plus FTS + embeddings, ~1 MB).
- Neither migration modifies existing rows.

---

## Consequences

### Positive

- User's original complaint ("had to ask multiple times") resolves at Phase 1 alone (~30 min of work).
- 3,721 previously-unused embedding rows serve every chat message.
- `prompt_memory` learning loop generalizes from Cypher-only to any chat, directly implementing user's *"if I am doing similar work it will understand"* requirement.
- Non-fatal degradation across every added lane — no new outage vector.
- No rewrites. All shipped modules (Unified Brain, MemPalace client, topic_notebooks, brain_decisions schema) survive intact.
- User's Obsidian annotations become authoritative in recall (ADR-048).

### Negative / cost

- Preflight latency: +50-100 ms per chat message (one Ollama embed call + parallel cosine scans + RRF merge). Below noticeable threshold on M4 hardware.
- Ollama dependency in the hot path (mitigated by AC-R1 non-fatal fallback).
- One chokidar file watcher lifecycled with the bridge process (added by ADR-048 companion; low overhead).
- ~50 MB DB growth from mem-claude ingest (ADR-048).
- Reasoning-model reasoning budget on GPT-5-family callers unaffected (this is a backend change).

### Neutral

- No new external dependencies beyond `chokidar` (already in `package.json` per earlier phases).
- No embedding model change — `nomic-embed-text` v1 stays. 3,721 existing vectors remain valid.
- MemPalace still runs; Phase 9 measurement gate decides its fate separately.

---

## Trade-offs explored

| Alternative | Why rejected |
|---|---|
| **Caller-side wings fix** (`wings: []` in `web-server.js:8027`) | Papers over the real design flaw. Preserves the trap for the next caller. Team C non-negotiable was correct. |
| **Full `recall.ts` rewrite as "Unified Recall Engine"** (Team C Round 1) | The wings-bug proved the shipped design worked but was mis-wired. Rewriting untested a working invariant. Team C conceded (C-R1) in Round 2. |
| **Replace LIKE with cosine everywhere** (Team C Round 5) | `LIKE '%PROJ-15222%'` beats cosine for exact ticket IDs and named entities. HYBRID-RRF gets both wins. |
| **Retire MemPalace now** (Team C Round 1) | Unmeasured. Team B/A pushed back. Deferred to Phase 9 measurement gate. |
| **Introduce sqlite-vec extension** for vector search | ~11 MB of vectors at 3,721 rows scans in ~3 ms via pure JS UDF. Extension overkill; portability rule prefers stdlib. |
| **Change embedding model to a bigger one** (e.g. bge-large, e5-large) | Requires re-embedding 3,721 rows. Deferred to a separate ADR if measurement shows nomic-embed-text v1 is a bottleneck. |
| **Introduce a new memory sidecar** (letta, cognee, custom) | User rejected this shape in the original brief ("mem-palace, memclaude, obsidian, embedding and memory files"). All 3 teams agreed: no new stores. |
| **Web UI update to show injected "Prior context" block** | Backend-first ships without it. UI enhancement deferred. |

---

## Open questions

1. **Q-1:** Does LIKE search on `topic_notebooks` reach recall@5 > 0.60 for topic-shaped queries after wings fix and preflight are live? — proposed answer: measure at Phase 5b bootstrap using 20 real historical queries. — gate: TC-02, TC-03 pass rates.

2. **Q-2:** Is the `prompt_memory` filter `outcome IN ('success','completed')` too restrictive? — proposed answer: measure after Phase 5b; if similar-work hits are sparse, include `outcome IS NULL` (in-flight sessions). — gate: TC-03 hit-rate over 30 days.

3. **Q-3:** Does the `+25%` user-annotation score boost (ADR-048) balance correctly against RRF score contributions from other lanes? — proposed answer: tune after 1 week of live use; make it env-configurable if needed. — gate: user feedback + TC-04 recurring pass.

4. **Q-4:** Should Phase 9 measurement gate trigger MemPalace retirement, hardening, or permanent keep? — proposed answer: 2-4 weeks of `palace_unique_top5_hit_rate` logging decides. — gate: separate ADR after measurement lands.

---

## Verification snapshot at acceptance time

Filled in when status changes to ✅ Accepted:

- Master HEAD: `<sha>`
- Schema version: `v83+` (v82 + v83 + v83-amend embedding column)
- Smoke counts: substrate `N/N`, outcome `N/N`
- Cypher session that closed this work: `cyp_<id>`
- Dogfood evidence: `.planning/wi-2nd-brain/test-log.jsonl` + user-reported *"asked about search-provider, got the answer without re-stating history"*

---

## Debate provenance


- `00-SUBSTRATE-BRIEF.md` — round-1 shared substrate
- `00b-MEMCLAUDE-ADDENDUM.md`, `00c-OBSIDIAN-ADDENDUM.md`, `00d-EMBEDDINGS-ADDENDUM.md` — targeted round substrates
- `TEAM-{A,B,C}-PROPOSAL.md` — round-1 (Claude, GPT-5.4, Gemini)
- `TEAM-{A,B,C}-REBUTTAL.md` — round-2 cross-team rebuttals
- `TEAM-{A,B,C}-R3-MEMCLAUDE.md` — round-3 (unanimous INGEST-ONCE-RETIRE)
- `TEAM-{A,B,C}-R4-OBSIDIAN.md` — round-4 (spread: READ-LANE-ADD / FEDERATED-PEERS / OBSIDIAN-AS-PRIMARY)
- `TEAM-{A,B,C}-R5-EMBEDDINGS.md` — round-5 (unanimous HYBRID-RRF k=60)
- `98-CONSOLIDATED-TEAM-POSITIONS.md`, `99-RECONCILIATION.md`

Companion execution artifacts under `~/Desktop/projects/work-intelligence-mcp/.planning/wi-2nd-brain/`:

- `EXECUTION-PLAN.md` (1,833 lines, 9 phases + measurement gate)
- `EXECUTOR-RUNBOOK.md`
- `TEST-CASES.md` (TC-01…TC-10)
