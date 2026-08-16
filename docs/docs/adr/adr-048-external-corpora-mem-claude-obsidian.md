---
sidebar_label: "ADR-048: External Corpora — mem-claude retire, Obsidian federated"
sidebar_position: 48
title: "ADR-048: mem-claude ingest-once-retire + Obsidian vault as federated peer"
status: Proposed (2026-07-27)
date: 2026-07-27
---

# ADR-048: External Corpora — mem-claude retire, Obsidian federated peer

**Status:** 📝 **Proposed (2026-07-27)**

**Related:**
- [ADR-024](./adr-024-unified-brain.md) — Unified Brain (recall surface this ADR extends)
- [ADR-047](./adr-047-2nd-brain-recall-architecture.md) — companion: recall architecture (this ADR is the corpus half)
- [ADR-004](./adr-004-obsidian-smart-clusters.md) — original Obsidian export design (still in force; this ADR extends its read path)
- [ADR-015](./adr-015-mempalace-integration.md) — MemPalace (not affected by this ADR; separate measurement gate in ADR-047 §Q-4)

---

## Context

User statement (verbatim, 2026-07-27):

> "I have created or tried to create 2nd brain in WI... for this I have used so many tools mem-palace, memclaude, obsidian, embedding and memory files. I want to fix this situation, I don't want to continue with mem-claude because of memory issues."

Live substrate audit found:

**mem-claude on user's box:**
- DB at `~/.claude-mem/claude-mem.db`, **156 MB**, **20,248 observations** rows
- Rich schema: `project`, `type`, `title`, `subtitle`, `facts`, `narrative`, `concepts`, `files_read`, `files_modified`, `prompt_number`, `content_hash`, `generated_by_model`
- Project attribution: 6,488 rows from `work-intelligence-mcp` (WI's own history), 3,071 from `example-service`, 10,526 from `observer-sessions`
- Signal density on user's canonical failure query: **5,504 rows mention "search-provider"** vs. only 5 in WI's `brain_decisions` — a ~1,000× signal ratio.
- Recent activity: 210 observations on 2026-07-26 alone; corpus is hot, not archival.
- Reliability history: **5 disk-fill crises in 23 days** documented in the `claude-mem-disk-cleanup` skill. Upstream fix (PR #2904) not merged. User's "stop painting the fence" heuristic has fired.

**Obsidian vault on user's box:**
- Vault at `~/Desktop/projects/work-intelligence-mcp/Obsidiant/WorkIntelligence/` (symlinked as `~/Documents/Obsidian-Vault`)
- **112 markdown files, 824 KB**
- `BIS SimCat Alignment.md` updated **2026-07-27 07:38** with 268 messages — live, hot corpus
- Structured YAML frontmatter (`topic`, `last_updated`, `message_count`, `tags`)
- Wikilinks `[[Person Name]]` already extracted by `extractPeopleNames` (shipped)
- SEPARATOR `<!-- USER ANNOTATIONS BELOW — DO NOT EDIT ABOVE -->` split defined at `src/tools/obsidian-export.ts:9`
- Write path shipped (`exportNotebooksToVault`, `exportSingleNotebook`, `mirrorVaultAnnotationsToMemory` at `obsidian-export.ts:97,203,835`); read-back is partial (annotations-only via `mirrorVaultAnnotationsToMemory`); **recall lane over vault content: not implemented**

The gap in both cases is symmetric: **WI writes to these systems but does not read from them during recall.** The user's own annotations and Claude Code's captured observations are invisible to WI chat.

## Decision

Two coordinated changes, both under the ADR-047 recall architecture:

### D1. mem-claude: INGEST-ONCE-RETIRE

Ingest all 20,248 observations from `~/.claude-mem/claude-mem.db::observations` into a new `external_observations` table in WI's `data.db`, preserving full source-schema fidelity. After ingest verifies, retire mem-claude cleanly.

- **Migration:** `v82_external_observations` (schema in EXECUTION-PLAN.md Phase 7 Task 7.2)
- **Ingest script:** `scripts/ingest-mem-claude.ts` — idempotent (deduped by `content_hash`), chunked transactions of 1,000 rows
- **Retirement:** `claude-mem stop` + move `~/.claude/plugins/data/claude-mem-thedotmack` aside + disable any prune cron. Rollback: reverse the move.
- **7-day soak:** keep `~/.claude-mem/` on disk for one week as recovery insurance. Then delete.
- **Recall wiring:** `external_observations` participates as one lane in the RRF merge (ADR-047 D4). File-grounded rows (`files_read_json`, `files_modified_json`) additionally feed the code-memory pillar (ADR-047 Phase 6).

**Chosen over BOTH-VIA-PALACE:** routing mem-claude data through MemPalace would keep a retired corpus behind sidecar uptime.
**Chosen over SKIP:** 5,504 search-provider rows and 6,488 rows about WI itself are not noise.

### D2. Obsidian: FEDERATED-PEERS

The vault becomes a **read-and-write peer** of `topic_notebooks`. Authority is split by the shipped separator:

- **Above `<!-- USER ANNOTATIONS BELOW —- DO NOT EDIT ABOVE -->`:** WI-authoritative. Machine-generated body, machine frontmatter, compiled status. Overwritten on export.
- **Below the separator:** user-authoritative. Manual annotations, added `[[Wikilinks]]`, user tags. **Never overwritten by WI.**

Recall behavior:
- New `obsidian_notes` table + `obsidian_notes_fts` FTS5 shadow (migration `v83`)
- `vault-indexer.ts` scans the vault at boot; `chokidar` file watcher re-indexes on change (2-second debounce)
- New recall lane `queryObsidianNotes` participates in `recallMemory` alongside SQLite decisions and palace lanes
- **User-annotation hits get +25% RRF score boost** (user corrections outweigh machine-generated content by design)
- `[[Person Name]]` wikilinks expand recall: chat mentioning "George" JOINs `obsidian_notes WHERE wikilinks_json LIKE '%George%'`
- Embedding column added to `obsidian_notes` (via ADR-047 D4): vault content participates in HYBRID-RRF cosine

**Chosen over READ-LANE-ADD (Team A Round 4):** passive read-only would treat user annotations as low-weight recall. Not enough.
**Chosen over OBSIDIAN-AS-PRIMARY (Team C Round 4):** would require flipping the `topic_notebooks` authority model and retracting rounds 1-3 consensus. High-risk, no measurement to justify. Staged migration path from FEDERATED → PRIMARY remains open if measurement supports it.

Topic-expert write-back (ADR-047 D5) targets the vault above-separator, NOT `topic_notebooks` directly. chokidar re-indexes the write, closing the loop.

---

## Acceptance Criteria

### Phase 1 — User flows (the bar for ✅ Accepted)

| # | AC | Verification |
|---|----|--------------|
| AC-U1 | User's chat surfaces mem-claude observations about search-provider (which had 5,504 mem-claude rows vs. 5 WI-`brain_decisions` rows before). | `TEST-CASES.md` TC-07 (ingest count) + TC-01 (search-provider recall now returns richer result set) |
| AC-U3 | User asks about a topic; the vault file `BIS SimCat Alignment.md` (updated live 2026-07-27) participates in recall alongside `topic_notebooks` and `brain_decisions`. | TC-09 (topic-expert R/W loop uses vault as write target and reads it back) |
| AC-U4 | After mem-claude retirement (Task 7.8), user's chat continues to work using only WI-native corpora. No regression on search-provider query. | TC-01 re-run after Task 7.8 |

### Phase 2 — Substrate (the bar for 🚧 Substrate Accepted)

| # | AC | Verification |
|---|----|--------------|
| AC-S1 | Migration `v82_external_observations` runs clean on fresh DB AND on pre-Phase-79 DB. Row count post-ingest is within ±5 of source `observations` count. | TC-07 + `sqlite3 ~/.work-intelligence-mcp/data.db ".schema external_observations"` |
| AC-S2 | `scripts/ingest-mem-claude.ts` is idempotent — running twice produces the same row count (dedup on `(source, source_row_id)` UNIQUE). | Run script twice; row count unchanged |
| AC-S3 | Migration `v83_obsidian_notes` creates `obsidian_notes`, `obsidian_notes_fts`, and adds `embedding`, `embedding_model`, `embedded_at` columns via ADR-047 D4 amendment. | Schema check post-migration |
| AC-S4 | `src/services/obsidian/vault-indexer.ts` on boot populates `obsidian_notes` with a row per `.md` file, splitting content on `SEPARATOR` (line 9 of `obsidian-export.ts`). Row count matches `find $VAULT -name '*.md' -type f \| wc -l`. | Post-boot count check |
| AC-S5 | chokidar watcher fires on `.md` change with 2-second debounce; `obsidian_notes.wi_body` OR `user_annotations` updates. `[Vault indexer] re-indexed` log line appears in bridge log. | TC-04 setup (append annotation, sleep 3s, verify user_annotations length increased) |
| AC-S6 | `exportNotebooksToVault` preserves below-separator content on write. `readExistingAnnotations` at `obsidian-export.ts:600-611` is called before every overwrite. | Verified via TC-04 (annotation survives multiple exports); the primitive already exists per substrate audit — this AC verifies it stays wired in the new code paths |
| AC-S7 | `queryObsidianNotes` returns `{ id, snippet, score, created_at }` with user-annotation hits scored `rank * 1.25`. | Unit test in `tests/services/brain/recall-obsidian.test.ts` |
| AC-S8 | `queryVaultCosine` (from ADR-047 D4) uses `obsidian_notes.embedding` and participates in RRF merge. | Unit test with seeded embedding |
| AC-S9 | After mem-claude retirement (Task 7.8), plugin manifest is moved aside; `pgrep -fa 'claude-mem'` returns nothing; `~/.claude-mem/claude-mem.db` remains on disk for 7-day soak. | Live check + `execution-log.jsonl` entry |

### Phase 3 — Rollout safety

| # | AC | Verification |
|---|----|--------------|
| AC-R1 | Env-flag gate `WI_EXTERNAL_OBSERVATIONS_LANE_ENABLED=0` disables the `external_observations` recall lane without server restart. Same for `WI_OBSIDIAN_LANE_ENABLED=0`. | Toggle mid-stream smoke |
| AC-R2 | mem-claude retirement is fully reversible via Task 7.8's rollback (`mv` plugin manifest back + `claude-mem start`). | Rollback dry-run |
| AC-R3 | If the vault path in `OBSIDIAN_VAULT_PATH` doesn't exist, `vault-indexer.ts` logs a warning and exits cleanly; no bridge outage. | Rename vault dir temporarily, restart bridge, verify boot completes |
| AC-R4 | Chokidar watcher can be killed at runtime without breaking bridge health. `pkill -f chokidar` → bridge stays UP, only recall lane goes stale. | Live kill test |
| AC-R5 | Rollback procedure documented at top of `EXECUTOR-RUNBOOK.md` § 5 (Phase 7 and Phase 8 rows). Each phase includes explicit `sqlite3 ... "DELETE FROM ..."` for the tables it created. | grep of runbook |

---

## Operations

### Enable

Executed as Phase 7 (mem-claude, 1 session-day) and Phase 8 (Obsidian federated, 1.5 session-days) in `EXECUTION-PLAN.md`. Both depend on Phase 1 (wings fix) and Phase 5b (embeddings) being live. Full order: 0 → 1 → 2 → 3 → 4 → 5 → 5b → 6 → 7 → 8.

### Disable / rollback

**mem-claude ingest:**
```bash
sqlite3 ~/.work-intelligence-mcp/data.db "DELETE FROM external_observations WHERE source='mem-claude';"
git revert <phase-7-commits>
```

**mem-claude retirement rollback:**
```bash
mv ~/.claude/plugins/data/claude-mem-thedotmack.retired-* ~/.claude/plugins/data/claude-mem-thedotmack
claude-mem start
```

**Obsidian federated:**
```bash
pkill -f chokidar
sqlite3 ~/.work-intelligence-mcp/data.db "DELETE FROM obsidian_notes;"
git revert <phase-8-commits>
```

### Migration data touch

- `v82_external_observations` — INSERT-only, ~50 MB from mem-claude backfill.
- `v83_obsidian_notes` — INSERT-only, ~1 MB.
- Existing `topic_notebooks` rows untouched. Existing `messages` and `brain_decisions` untouched.

---

## Consequences

### Positive

- Direct honor of user intent: *"I don't want to continue with mem-claude"* — retired.
- Direct honor of user intent: *"Digital compressed but detail physical file of each topic. Embedded it and fetch."* — Obsidian `.md` files are literally the physical files, with embedding lane (ADR-047 D4).
- 20,248 observations become permanently queryable by WI; no future disk-fill dependency.
- User's manual annotations become first-class in recall — corrections outweigh auto-derived data (design intent, not accident).
- Wikilink graph adds structured people-relationship signal for meeting-prep queries.
- Vault stays human-editable via Obsidian's GUI; no coupling to WI's write cadence.

### Negative / cost

- ~50 MB DB growth from mem-claude ingest. `data.db` goes from 806 MB → ~856 MB. Negligible.
- Chokidar file watcher in the bridge process lifetime — one long-lived listener, ~5 MB RAM.
- ~10 seconds one-shot backfill from mem-claude on first execution.
- Vault re-embed on `.md` change: ~50-100 ms per file (Ollama local call). Batch bootstrap of 112 files: ~10 s. Acceptable.
- User must not delete `~/.claude-mem/` before the 7-day soak period completes.

### Neutral

- Original ADR-004 Obsidian export design (`exportNotebooksToVault`, `mirrorVaultAnnotationsToMemory`) stays in force. This ADR extends the read path, doesn't replace anything.
- MemPalace unaffected by this ADR (separate measurement gate under ADR-047 Q-4).

---

## Trade-offs explored

| Alternative | Why rejected |
|---|---|
| **Keep mem-claude live as a 5th recall lane** | Team B/A/C unanimous: 5 crises in 23 days is not stable enough for a live dependency. User explicit intent to retire. |
| **Route mem-claude data via MemPalace** (BOTH-VIA-PALACE) | Would keep a retired corpus behind sidecar uptime. Zero benefit vs. direct SQLite. |
| **SKIP mem-claude — 20,248 rows are noise** | 5,504 search-provider rows + 6,488 WI-project rows disprove noise claim. |
| **OBSIDIAN-AS-PRIMARY** (Team C Round 4) | Flips rounds 1-3 consensus that `topic_notebooks` is the primary topic primitive. High-risk retraction. Staged migration path stays open. |
| **READ-LANE-ADD only** (Team A Round 4) | Doesn't treat user annotations as authoritative. Users editing manual overrides get low-weight recall — violates the user-corrections-win invariant. |
| **DEPRECATE Obsidian export entirely** (from user's "rejected" list interpretation) | Vault is actively used (`BIS SimCat Alignment.md` updated today). Deprecation would kill a live workflow. User rejected the CONCEPT of "obsidian-only", not the tool. |
| **Ingest mem-claude but also KEEP it live for future observations** | Splits authority between two stores forever. Kicks the retirement can down the road. Team A/B/C conceded retirement is the honest end-state. |
| **New `wikilinks` normalized table** for the [[Name]] graph | Overkill at 112 files. `wikilinks_json TEXT` on `obsidian_notes` + `LIKE '%[[Name]]%'` handles the scale. |
| **Use `sqlite-vec` extension for vault embeddings** | 112 rows × 768d = 344 KB of vectors. Full scan in <1 ms. Extension overkill. |

---

## Open questions

1. **Q-1:** Does the `+25%` user-annotation score boost balance correctly against RRF score contributions from other lanes? — proposed answer: tune after 1 week of live use; make configurable via `WI_USER_ANNOTATION_BOOST=0.25` if needed. — gate: TC-04 recurring PASS + user feedback.

2. **Q-2:** When a mem-claude observation duplicates content already in WI (e.g., a message Claude Code observed being sent from WI's own logs), should we dedupe cross-source at ingest? — proposed answer: no dedupe at ingest; `content_hash` UNIQUE prevents duplicates WITHIN mem-claude. Cross-source overlap is fine — RRF handles the ranking. — gate: TC-01 hit-list inspection at Phase 7.

3. **Q-3:** When the user renames a vault `.md` file, chokidar sees delete-then-add. Does `obsidian_notes.file_path` UNIQUE handle this? — proposed answer: DELETE on rename event, INSERT on new-path event. May need atomic tombstone. — gate: manual rename test after Phase 8.

4. **Q-4:** After the 7-day soak, do we delete `~/.claude-mem/` or keep it read-only? — proposed answer: delete. `execution-log.jsonl` captures what was ingested; source is retrievable from the mem-claude source repo if ever needed. — gate: user confirms at day-7.

5. **Q-5:** Should the ingest script run on a cron to catch future mem-claude observations (before retirement)? — proposed answer: NO. Ingest is one-shot. Retirement happens at Task 7.8. Any observations mem-claude captures between ingest and retirement (~1-2 hours) are acceptable loss. — locked.

---

## Verification snapshot at acceptance time

Filled in when status changes to ✅ Accepted:

- Master HEAD: `<sha>`
- Schema version: `v83+`
- `external_observations` row count: `<N>` (target: within ±5 of mem-claude source)
- `obsidian_notes` row count: `<N>` (target: matches `.md` file count in vault)
- User-annotation TC-04 has passed in `test-log.jsonl` at least 3 times across separate boots
- mem-claude retirement date: `<YYYY-MM-DD>`; `~/.claude-mem/` deletion date: `<YYYY-MM-DD + 7 days>`

---

## Debate provenance

- Round 3 mem-claude debate: `TEAM-{A,B,C}-R3-MEMCLAUDE.md` — unanimous INGEST-ONCE-RETIRE
- Round 4 Obsidian debate: `TEAM-{A,B,C}-R4-OBSIDIAN.md` — spread (A: READ-LANE-ADD, B: FEDERATED-PEERS, C: OBSIDIAN-AS-PRIMARY); FEDERATED-PEERS chosen per honest split (no consensus tell)
- Substrate briefs: `00b-MEMCLAUDE-ADDENDUM.md`, `00c-OBSIDIAN-ADDENDUM.md`
- Consolidated: `98-CONSOLIDATED-TEAM-POSITIONS.md`
- Execution artifacts: `EXECUTION-PLAN.md` Phase 7 + Phase 8, `TEST-CASES.md` TC-04 + TC-07 + TC-09, `EXECUTOR-RUNBOOK.md` § 5
