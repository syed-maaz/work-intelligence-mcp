# Post-Graphify Implementation — Consolidated Runbook

> **Status:** shipped 2026-05-30 on branch `feat/post-graphify-action-plan`
> **Scope:** the four real WI gaps surfaced by the graphify spike, plus one observability fix.
> **Source of truth for the decline:** [`.planning/ADR-REVIEW.md` § "Tools evaluated and declined" → graphify (declined 2026-05-30)](../../../.planning/ADR-REVIEW.md).

---

## 1. Context

A two-workflow deep-research evaluation of [`graphify`](https://github.com/safishamsi/graphify) (≈11 agents, ≈947 k tokens) concluded **PASS** — zero of six fit lenses survived adversarial critique above `WEAK_FIT`. The verdict, the seven-risk register, the per-lens verdicts, and the five kill-criteria for re-evaluation are frozen in `.planning/ADR-REVIEW.md` so future sessions don't re-spike on the same tool.

What the spike did surface, however, was four real gaps in our own stack — none of which need a Python sidecar. This document is the runbook for the five commits that closed those gaps. Each step was implemented and shipped independently; nothing in this delta depends on graphify itself.

---

## 2. What shipped (per step)

All commits on branch `feat/post-graphify-action-plan`. Aggregate diff: **10 files changed, +1,228 / -114**.

### Step 2 — `message_embeddings` wired as 5th `rrfFuse` lane

- **Commit:** `fb0d70e` — `feat(retrieval): wire message_embeddings as 5th rrfFuse lane via pure semanticSearch`
- **Files:** `src/services/embedder.ts` (+56), `src/db/migrations/v48_embedding_model_label.ts` (+38, new), `src/db/schema.ts` (+13/-1), `web-server.js` (+121/-8) — total +218 / -18
- **What it does:** Adds a pure-semantic `semanticSearch(query, db, limit)` (brute-force cosine over `message_embeddings`, 500 ms internal timeout, returns `[]` on any failure) and injects it as the 5th lane at both chat-handler `rrfFuse` call sites (notebook-chat ~3250, general-chat ~4724), folded into the existing `Promise.all` block to keep the latency budget intact. Migration v48 relabels ~1,208 existing rows from the (incorrect) `text-embedding-3-small` label to `nomic-embed-text` (the bytes were always 768-dim nomic; the column DEFAULT is also flipped). A fire-and-forget `embed('warmup')` runs in the boot IIFE so Ollama's 2–5 s cold start can't truncate the first chat's 500 ms timeout race. Retrieval log lines now include `embeddingHits`.
- **Verify:** `curl -sS -X POST localhost:3132/api/chat -H 'content-type: application/json' -d '{"message":"who owns the proxy fix"}' >/dev/null && tail -50 /tmp/bridge.out | grep -E '\[retrieval\].*embeddingHits='` — `embeddingHits` should be > 0 on a paraphrase query.

### Step 2.5 — Palace health endpoint divergence fix

- **Commit:** `f496dac` — `fix(palace): use kg_stats (not entity:'*' kg_query) in health endpoint; add smoke divergence guard`
- **Files:** `web-server.js` (+21/-29), `scripts/smoke-bridge.sh` (+19), `docs/docs/architecture/mempalace-second-brain.md` (+52/-1) — total +93 / -29
- **What it does:** `/api/palace/health/detailed` was calling `mempalace_kg_query { entity: '*' }`, which returns `[]` because `'*'` is not a valid wildcard. Result: the dashboard reported `totalTriples: 0` while `/api/palace/status` (kg_stats-backed) correctly reported 226 — every debug session re-derived "palace is empty" from the broken endpoint. Fixed by routing `computeHealthMetrics` through `kg_stats` (matching `/api/palace/status`) and documenting the historical gotcha in the cheat-sheet so it stops getting re-investigated as a real gap.
- **Verify:** `curl -sS localhost:3132/api/palace/status | jq .stats.totalTriples` and `curl -sS localhost:3132/api/palace/health/detailed | jq .totalTriples` must agree (or both be 0). Smoke check 9 enforces `status > 0 ⇒ health > 0`.

### Step 3 — `CodeGraphIndexer` agent (mtime-diff every 4 h + Sunday full sweep)

- **Commit:** `e1d6f9e` — `feat(code-graph): add CodeGraphIndexer agent — mtime-diff every 4h + Sunday full sweep`
- **Files:** `src/tools/code-indexer.ts` (+94), `web-server.js` (+98/-4), `scripts/smoke-bridge.sh` (+47), `CLAUDE.md` (+3) — total +242 / -4
- **What it does:** New `indexChangedSince(repo, sinceMs)` reads/writes a `sync_state` row (`topic_id=0`, `source='code-graph-<repo>'`), filters `findTsFiles` by `mtimeMs`, and per-file does `DELETE FROM code_graph WHERE file=?` + re-extract via the existing ts-morph extractor. The boot IIFE registers a `CodeGraphIndexer` agent: 30 s post-boot first run, then `setInterval` at `CODE_GRAPH_INTERVAL_MS || 4h`. Sunday 03:00–03:30 → full sweep (catches deletions the mtime-diff lane misses). Runs against both `example-service` and `operations`. A module-level `busy[repo]` flag wraps **both** the agent tick and the manual `POST /api/code-graph/index` handler — explicit re-entrancy guard, mtime-diff and force-refresh cannot race. Pure ts-morph + SQLite, so the Teams-blocks-Outlook sync queue hang cannot starve it.
- **Verify:** `curl -sS localhost:3132/api/agents/health | jq '.agents[] | select(.name=="CodeGraphIndexer")'` — must be present, status not `crashed`. Then `sqlite3 ~/.work-intelligence-mcp/data.db "SELECT repo, COUNT(*) FROM code_graph GROUP BY repo;"` — should show non-zero per repo within 30 s of boot.

### Step 4 — TS-extractor under-emission fix (call / type / api_call edges)

- **Commit:** `642d8b7` — `fix(code-indexer): emit call/type/api_call edges that ts-morph extractor was silently dropping`
- **Files:** `src/tools/code-indexer.ts` (+170/-52), `tests/tools/code-indexer.test.ts` (+114, new) — total +285 / -51
- **What it does:** `code_graph` had 5,740 rows but **zero** entries for `ref_type IN ('call','type','api_call')` despite all three being in the schema enum — the extractors didn't exist. Three new extractors:
  - `extractCallEdges` walks every `CallExpression`, dedupes by callee name per file, skips a noise-list (`console.*`, `expect/it/describe`, Array methods, `then/catch`), emits `ref_type='call'` with `ref_symbol = last identifier of the callee`.
  - `extractTypeEdges` classifies `import` declarations with `isTypeOnly()` (and `import { type X }` all-type-only forms) as `ref_type='type'`, plus walks `TypeReference` descendants resolving the head identifier against the file's import-binding map and emits a deduped type edge per `(file, imported-symbol)` pair.
  - `api_call` regex broadened from `expr === 'fetch' || expr.endsWith('.fetch')` (literal-fetch only) to HTTP-verb method calls on any object, `axios.*` expressions, and an arg-shape switch covering string literals, no-substitution templates, template expressions (regex extracts the path-shaped fragment from the head text), and object-literal `{ url: ... }`. Soundness preserved: still requires HTTP-shaped callee **and** URL-shaped arg — `board.post('hello world')` is correctly **not** classified.
  - 6 vitest assertions in `tests/tools/code-indexer.test.ts` cover all the new shapes plus a regression for literal `fetch('/api/...')` and a negative test for non-HTTP `.post()` with non-URL arg.
- **Verify:** `npm run test:run -- tests/tools/code-indexer.test.ts` and after a force-refresh: `sqlite3 ~/.work-intelligence-mcp/data.db "SELECT ref_type, COUNT(*) FROM code_graph GROUP BY ref_type;"` — `call`, `type`, and `api_call` rows should all be > 0.

### Step 5 — Regex extractors for Dockerfile / Helm / shell (defer tree-sitter)

- **Commit:** `a65c46c` — `feat(code-indexer): regex extractors for Dockerfile/Helm/shell — defer tree-sitter`
- **Files:** `src/tools/code-indexer.ts` (+322/-12), `src/db/migrations/v49_code_graph_non_ts_ref_types.ts` (+57, new), `src/db/schema.ts` (+13/-1), `scripts/smoke-bridge.sh` (+9) — total +396 / -18
- **What it does:** Renames `extractConfigEdges → extractNonTsEdges` and runs it across all repos. Three new line-anchored regexes — `Dockerfile ^FROM` → `ref_type='docker_base_image'`; Helm `Chart.yaml dependencies - name:` → `ref_type='helm_chart_dep'`; shell `.sh $ENV` references → `ref_type='shell_env_ref'`. Migration v49 widens the `code_graph` `CHECK` enum to include the three new ref_types via SQLite's CREATE-NEW-COPY-DROP-RENAME pattern (CHECK constraints can't be altered in place). Zero new npm dependencies, zero native bindings, zero schema rebuild risk beyond the enum widening. Tree-sitter and graphify are explicitly deferred until SQL DDL files actually land in `example-service`.
- **Verify:** `sqlite3 ~/.work-intelligence-mcp/data.db "SELECT ref_type, COUNT(*) FROM code_graph WHERE ref_type IN ('docker_base_image','helm_chart_dep','shell_env_ref') GROUP BY ref_type;"` — at least one row total after a full sweep.

---

## 3. Operational runbook

All commands assume bridge running on `:3132` and `DB_PATH=~/.work-intelligence-mcp/data.db`.

### 3.1 Verify the embeddings lane fires

```bash
# One-shot chat call, then scrape the retrieval log line
curl -sS -X POST localhost:3132/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"how did we fix the proxy 401 loop"}' >/dev/null

# Bridge stderr should show: [retrieval] ... embeddingHits=N (N>0 expected on paraphrase)
tail -100 /tmp/bridge.out | grep -E '\[retrieval\].*embeddingHits='

# Sanity-check the table label migration ran
sqlite3 ~/.work-intelligence-mcp/data.db \
  "SELECT model, COUNT(*) FROM message_embeddings GROUP BY model;"
# expect: nomic-embed-text | 1208 (no rows for text-embedding-3-small)
```

### 3.2 Verify palace health endpoint no longer diverges

```bash
status=$(curl -sS localhost:3132/api/palace/status | jq .stats.totalTriples)
health=$(curl -sS localhost:3132/api/palace/health/detailed | jq .totalTriples)
echo "status=$status health=$health"
# Must agree (both 0 OR status>0 AND health>0). Divergence = wildcard bug regressed.
```

### 3.3 Verify the `CodeGraphIndexer` agent is alive

```bash
curl -sS localhost:3132/api/agents/health \
  | jq '.agents[] | select(.name=="CodeGraphIndexer")'
# expect status != "crashed", lastTickAt within last CODE_GRAPH_INTERVAL_MS (default 4h)
```

### 3.4 Verify `code_graph` is being populated

```bash
sqlite3 ~/.work-intelligence-mcp/data.db <<'SQL'
SELECT repo, COUNT(*) AS rows FROM code_graph GROUP BY repo;
SELECT ref_type, COUNT(*) AS rows FROM code_graph GROUP BY ref_type ORDER BY rows DESC;
SQL
# expect non-zero for both example-service+operations, and non-zero for call/type/api_call
# (steps 3+4) plus docker_base_image/helm_chart_dep/shell_env_ref (step 5).
```

### 3.5 Force-refresh after rsync

```bash
# Manual full re-extract (bypasses mtime-diff) after refreshing repos/example-service or repos/operations
curl -sS -X POST localhost:3132/api/code-graph/index \
  -H 'content-type: application/json' \
  -d '{"repo":"example-service"}'
# Returns 202 immediately; busy-flag re-entrancy guard is shared with the agent
# tick, so concurrent agent + manual refresh cannot race.
```

Override the agent cadence at boot via `CODE_GRAPH_INTERVAL_MS` (ms; default 4 h).

---

## 4. Failure modes added to `smoke-bridge.sh`

Three new sections, all gating with non-zero exit on regression:

| Section | What it catches |
|---|---|
| **9. Palace health endpoint divergence** | `/api/palace/status` and `/api/palace/health/detailed` cannot disagree. Asserts `status > 0 ⇒ health > 0`. Catches a regression of the `entity: '*'` wildcard bug — the original symptom that made every debug session conclude "palace is empty". |
| **10a. `CodeGraphIndexer` registered + not crashed** | The agent must appear in `/api/agents/health` and not be in `crashed` state. Catches the boot block being removed, a syntax error in `dist/`, or the agent throwing during its first tick. |
| **10b. `code_graph` row counts per repo** | `code_graph` non-empty for both `example-service` and `operations` after the agent's first run (warn-only on a fresh install where the 30 s post-boot tick hasn't fired yet). |
| **10c. `code_graph` non-TS ref_types** | At least one of `docker_base_image / helm_chart_dep / shell_env_ref` present (warn-only on first run). Catches a regression of the regex extractors or the v49 enum migration. |

The new checks add ~80 lines to `scripts/smoke-bridge.sh` (lines 331–410) and run inside the existing `npm run smoke:bridge` invocation — no new commands to remember.

---

## 5. Deferred / known follow-ups

- **Dedupe-key alignment between FTS and embedding lanes (step 2).** The FTS lane aggregates messages into snippet blocks (`title = "Cross-topic messages matching: ..."`) while the embedding lane emits per-message `ContextItem`s (`title = "message:<id>"`). The two lanes diverge by design — aggregate vs per-row granularity. RRF gives each lane equal voice without a consensus boost. Acceptable for now; revisit if duplicate-looking items in chat context degrade the answer quality (no signal yet).
- **Tree-sitter and graphify itself.** Explicitly deferred until SQL DDL files actually land in `example-service`. Line-anchored literals (Dockerfile, Helm, shell) don't justify a tree-sitter dependency. Re-evaluation conditions are the five kill-criteria in `.planning/ADR-REVIEW.md` — all five must hold simultaneously.
- **Palace topic-keyed wings replay.** The graphify decline write-up notes that `MemoryEnricher.enrichFromSync()` only fires inside the 15-min auto-sync loop; there's no startup sync. The action-plan recommendation was `npm run palace:rebuild` to replay SQLite into palace; this was **not** wired into the boot block in this delta because the health endpoint fix alone removed the misleading "palace is empty" UI signal that motivated it. Track separately if a replay-on-boot becomes load-bearing.
- **Sunday full-sweep window.** The agent's full sweep is hard-coded to Sunday 03:00–03:30 local time. No env override yet — add one only if a multi-region deployment ever needs it.

Nothing in the five commits was marked `PARTIAL` by the executors. All five returned `SHIPPED`.

---

## 6. References

- **Decline ledger:** [`.planning/ADR-REVIEW.md` § "Tools evaluated and declined" → graphify](../../../.planning/ADR-REVIEW.md) — seven-risk register, per-lens verdicts, five kill-criteria, four real gaps.
- **State log:** [`.planning/STATE.md`](../../../.planning/STATE.md) — sprint-level entry for this delta.
- **Palace cheat-sheet (extended in step 2.5):** [`docs/docs/architecture/mempalace-second-brain.md`](./mempalace-second-brain.md) — historical wildcard-bug gotcha.
- **claude-mem sessions:**
  - `2026-05-29` — graphify deep-research (recon + 6 lenses + adversarial critique).
  - `2026-05-30` — post-graphify action plan (this delta).
- **Workflow runs:**
  - `wf_9bdc3096-a79` — risk register source (recon + 6 fit lenses).
  - `wf_db87e4a6-ab8` — action-plan source (5-step sequencing).

### Commit map

| Step | SHA | Title |
|---|---|---|
| 2 | `fb0d70e` | `feat(retrieval): wire message_embeddings as 5th rrfFuse lane via pure semanticSearch` |
| 2.5 | `f496dac` | `fix(palace): use kg_stats (not entity:'*' kg_query) in health endpoint; add smoke divergence guard` |
| 3 | `e1d6f9e` | `feat(code-graph): add CodeGraphIndexer agent — mtime-diff every 4h + Sunday full sweep` |
| 4 | `642d8b7` | `fix(code-indexer): emit call/type/api_call edges that ts-morph extractor was silently dropping` |
| 5 | `a65c46c` | `feat(code-indexer): regex extractors for Dockerfile/Helm/shell — defer tree-sitter` |
