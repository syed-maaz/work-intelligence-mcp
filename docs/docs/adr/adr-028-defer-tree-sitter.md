---
sidebar_position: 28
title: ADR-028 Defer tree-sitter; fix TS extractor and ship regex non-TS pass first
---

# ADR-028: Defer tree-sitter; fix TS extractor and ship regex non-TS pass first

| Field | Value |
|-------|-------|
| **Status** | ✅ **v2 fully complete** — v1 shipped 2026-05-29 (commits `642d8b7` TS extractor fix, `a65c46c` regex non-TS pass), v2 closed 2026-05-31 via Phase 73 (`ac498ff` F1 smoke § 10 fail-on-empty gate, `617d90c` F2 SYNC INVARIANT cross-link + drift test, `5f47408` F3 call-edge sample-100 verdict + ignore-list, `3078b39` F4 `infra_ref` shell glue closed-deferred), doc-hygiene tail `c6dc0f6`. See [Status Update — 2026-05-30](#status-update--2026-05-30) for the original audit and the per-AC closure stamps. |
| **Date** | 2026-05-30 |
| **Deciders** | Maaz |
| **Drives** | Post-graphify steps 4–5 (`.planning/STATE.md`) — `code_graph` extractor under-emission and non-TS coverage. **Not** REFACTOR-002, which is Four-Stage Pipeline violations per `.planning/ADR-REVIEW.md:358` (broken cross-ref in original prose). |
| **Related** | [ADR-018 — Cross-Repo Knowledge Sync](./adr-018-cross-repo-knowledge-sync.md), [ADR-027 — Code-Graph Indexer Scheduling](./adr-027-code-graph-indexer-scheduling), [`/.planning/ADR-REVIEW.md` graphify entry (declined 2026-05-30)](https://github.com/your-org/work-intelligence-mcp/blob/main/.planning/ADR-REVIEW.md), [Companion design doc](../architecture/non-ts-code-graph-coverage.md) |

> **Numbering note.** Originally drafted as ADR-027 in parallel with the code-graph indexer ADR. Renumbered to ADR-028 on filing because the indexer ADR (filed first, addresses the more time-sensitive ledger item) took position 27.

## Context

The `code_graph` table (introduced for cross-repo blast-radius and call-graph tracing under ADR-018) is populated by `src/tools/code-indexer.ts`. The indexer uses [`ts-morph`](https://ts-morph.com/) — a thin idiomatic wrapper over the TypeScript compiler API — for `.ts`/`.tsx` files, plus a small regex pass (`extractConfigEdges`) that scans `.yaml`/`.yml`/`.json` for env-var references on **every** indexed repo (not operations-only — a clarification from the originally drafted text). The schema declares 7 valid `ref_type` enum values (`src/db/schema.ts:712-716`):

```sql
CHECK(ref_type IN ('import','call','type','api_call','env_var','test_covers','config_ref'))
```

The full v24 table also carries a defaulted `indexed_at TEXT` and a deduplicating `UNIQUE(repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type)` — both load-bearing for the migration SQL in §"Step 3" of the companion doc, and both preserved verbatim by this ADR (the prior draft silently dropped them — corrected here).

Two pressures motivated revisiting:

1. **The graphify spike** (declined 2026-05-30, see `.planning/ADR-REVIEW.md`) raised "we lack multi-language coverage" as a perceived gap and proposed a tree-sitter-based knowledge graph as the fix.
2. **A direct query of the live database** turned over a more uncomfortable finding (`~/.work-intelligence-mcp/data.db`, queried 2026-05-30):

   ```
   import      | 3140
   test_covers | 2198
   config_ref  |  289
   env_var     |  113
   ```

   Total: **5,740 rows**. Zero rows for `call`, `type`, or `api_call` — even though the schema allows them and `extractEdges()` in `src/tools/code-indexer.ts:150-161` clearly *attempts* to emit `api_call` whenever it sees `fetch('/api/…')`. The `CodeEdge` TypeScript union (line 22) lists `call` and `type` but no extractor code ever produces them.

   **One open question** (parked, addressed in companion doc): is `api_call` truly absent at extraction time, or are the rows being silently deduped by the existing `UNIQUE` constraint? A 1-hour sqlite-instrumented spike resolves this; the ADR's path forward is robust to either answer (REFACTOR-002 either implements emission or drops the enum value), so we do not gate this ADR's acceptance on the spike.

The downstream consumers — `traceCallGraph()` and `checkBlastRadius()` — advertise call-graph and dependency APIs but operate on a graph that is, in practice, an import graph. The trace output's `summary` even hard-codes the fallback string `"code_graph may not be indexed for this repo"` (`call-graph-tracer.ts:108-109`), which masks the real issue: the table **is** indexed, it just structurally cannot answer call-graph questions because the producer never emits those rows. (Note: the parallel `blast-radius-alert.ts` fix — its query references columns that do not exist — is owned by ADR-027, not this ADR. Cross-referenced here for situational awareness.)

The instinct on seeing "ts-morph misses Dockerfiles, Helm charts, and shell scripts" is to reach for tree-sitter (or graphify, which wraps tree-sitter). The instinct is wrong here. Tree-sitter would layer new grammars onto a pipeline whose primary defect is an under-emitting TypeScript extractor. The fix order is inverted from the instinct: **extractor first, language fan-out second**.

The repo mix on disk today (counted 2026-05-30 across `repos/example-service` and `repos/operations`, exclude set: `node_modules`, `dist`, `build`, `.git`, `coverage`):

- 18 Dockerfiles (example-service)
- 29 `Chart.yaml` Helm charts (operations)
- 40 `.sh` shell scripts (combined; figure depends on exclude set, see §"Inaccuracies" in the critique log)
- 561 YAML/YML files in operations (already partially covered by `extractConfigEdges`)
- 1 Python file (`example-service/docs/consolidate-blog-assets.py`)
- **0 SQL files**, **0 HCL/Terraform files**, **0 Go files**, **0 Rust files**

The only "missing" language families in volume are line-oriented and trivially regex-able. The languages that *would* benefit from a real parser (SQL DDL, HCL) **don't exist in the repo**.

## Decision

Four-part decision, sequenced. Parts 1 and 2 are work; parts 3 and 4 are deferrals/declines that lock in the rationale.

### 1. Fix the TS extractor's under-emission **first**

Before any language fan-out, `extractEdges()` in `src/tools/code-indexer.ts` must honestly populate the `ref_type` values it already declares:

- **`api_call`** — currently only matches the literal identifier `fetch` whose first string argument starts with `/api/`. Most real call sites use `axios`, an `apiClient` wrapper, or a template-literal URL — none of which match. **Spike first** (1 h): instrument the insert path to log every `INSERT OR IGNORE` with `ref_type='api_call'` and confirm whether rows are produced and dropped by `UNIQUE`, or never produced. Then either widen the regex / AST shape, **or** drop `api_call` from the enum to stop pretending the data exists.
- **`call`** — declared in the `CodeEdge` union and the schema CHECK, never emitted. Either implement a `CallExpression` walker that records caller→callee edges using ts-morph's symbol resolver, or remove `call` from the enum.
- **`type`** — same status as `call`. Either emit on `TypeReference` / `HeritageClause`, or remove from the enum.

Tracked as **REFACTOR-002** in `.planning/ADR-REVIEW.md`. Estimated 2–3 days including the spike.

### 2. Ship the regex non-TS pass **after** the extractor is honest

Add per-language helpers covering the actual present-on-disk gaps. The existing entry point `extractConfigEdges()` (`src/tools/code-indexer.ts:166`) is left in place, scoped to its current job (env-var refs in YAML/JSON). A new dispatcher `extractNonTsEdges()` is added alongside that calls into it plus the new helpers — so we don't take on a rename in the same commit:

```ts
private extractNonTsEdges(repo: RepoConfig): CodeEdge[] {
  const edges: CodeEdge[] = [];
  edges.push(...this.extractDockerfileEdges(repo));
  edges.push(...this.extractHelmEdges(repo));
  edges.push(...this.extractShellEdges(repo));
  edges.push(...this.extractConfigEdges(repo));  // existing env-var pass, unchanged
  return edges;
}
```

`indexRepo()` is amended to call `extractNonTsEdges()` instead of (or alongside) `extractConfigEdges()`. Because `indexRepo()` already opens with `DELETE FROM code_graph WHERE repo = ?` (line 144), the non-TS pass MUST be co-located in the same call — otherwise its rows get wiped on the next reindex. Stated as a constraint, not assumed.

The new helpers cover:

- **Dockerfile**: line-anchored `^FROM `, `^COPY `, `^ENTRYPOINT `, `^CMD ` patterns.
- **Helm `Chart.yaml`**: see Helm regex design below — explicit collision avoidance.
- **Shell scripts (`.sh`)**: `source ./foo.sh`, `. ./foo.sh`, `kubectl apply -f path.yaml`.

A schema migration (v49) widens the `ref_type` CHECK enum with three new values: `dockerfile_ref`, `helm_ref`, `infra_ref`. SQLite's CHECK constraints are immutable on existing tables — the migration uses the canonical CREATE-NEW-COPY-DROP-RENAME pattern documented in the companion doc, **and preserves the existing `indexed_at` column and `UNIQUE` constraint** (these were dropped in the prior draft — corrected; see companion doc §"Step 3").

#### Helm regex — the `name:` collision

Every `Chart.yaml` in `repos/operations` has a top-level `name:` key (e.g. `name: cluster-setup`) AND can have a `dependencies:` block whose entries are also `- name: <chart>`. A naïve `^name:` regex would emit the chart's own name as a dependency. The helper uses a **two-line state machine** instead of a single regex:

```ts
function extractHelmDeps(text: string): { name: string; line: number }[] {
  const lines = text.split('\n');
  const out: { name: string; line: number }[] = [];
  let inDeps = false;
  let depIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^dependencies:\s*$/.test(line)) { inDeps = true; depIndent = -1; continue; }
    if (!inDeps) continue;
    if (depIndent < 0 && /^\s+-/.test(line)) depIndent = line.match(/^(\s+)-/)![1].length;
    // leave the dependencies block when the next top-level key appears
    if (/^[A-Za-z]/.test(line)) { inDeps = false; continue; }
    const m = line.match(/^\s+- name:\s*(\S+)/);
    if (m) out.push({ name: m[1], line: i + 1 });
  }
  return out;
}
```

Same shape is used for `image:` keys — only inside known parent contexts (`spec.image`, `containers[].image`).

Effort: ≤1 day. Sequenced **after** part 1 so we never paper over the TS gap with non-TS noise.

### 3. Defer tree-sitter

No tree-sitter integration (direct grammar packages **or** via `web-tree-sitter` WASM **or** wrapped behind any third-party graph library). The justification today does not survive the data:

- The languages tree-sitter would unlock that we don't already cover with regex (SQL DDL, HCL/Terraform, Go) **are not present in either indexed repo**.
- The languages we *do* have (Dockerfile, Helm, shell, YAML) are line-oriented; the regex pass in part 2 captures the value at near-zero maintenance cost.
- The headline `code_graph` problem isn't language coverage — it's that the TS extractor we already have isn't producing the row types it claims to. Adding grammars without fixing extraction widens the funnel before fixing the leak.

Tree-sitter remains a **parked-but-tracked** option, revisited only when one or more of the kill criteria below fire.

### 4. graphify already declined separately

Graphify (the gsd-graphify skill / `graphifyy` PyPI package) was evaluated and declined on 2026-05-30 in `.planning/ADR-REVIEW.md` (graphify entry, ~line 501). The decline reasons are independent of this ADR's reasoning but reinforce it: hard-wired LLM client bypassing the Hai proxy, supply-chain irregularities (PyPI name `graphifyy` vs CLI `graphify`, inflated stars, unstable plugin API per RFC #1070), no connectors for WI's first-class entities (Jira keys, Teams chat IDs, message `source_id`), and the same coverage-gap-misdiagnosis this ADR addresses. This ADR does **not** re-relitigate graphify; it links to that record.

## Consequences

### Positive

- **`code_graph` finally tells the truth.** After REFACTOR-002, the schema CHECK enum and the producer agree. Consumers (`traceCallGraph`, `checkBlastRadius`) start operating on real call/type edges instead of imports-dressed-as-everything.
- **Real non-TS coverage in `<1 day`.** Dockerfile / Helm / shell edges land via ~80 LOC of additive regex. If a regex misses an exotic syntax, the result is a missing edge — not a startup crash, not a build failure, not a CI red.
- **Zero new native dependencies.** No `node-gyp`, no per-grammar ABI churn, no postinstall compile steps. Existing native surface (`better-sqlite3`, Playwright) is unchanged.
- **Reversible per layer.** The regex pass is small enough to delete, not refactor, when tree-sitter eventually lands. The TS extractor fixes are pure correctness work that any future parser swap inherits.
- **Migration preserves dedup + audit.** The v49 SQL keeps `indexed_at TEXT NOT NULL DEFAULT (datetime('now'))` and the seven-column `UNIQUE` — so existing queries that filter on `indexed_at` keep working, and the dedup that's likely been masking emission gaps continues to mask them honestly (or gets revealed by the spike, which is the point).
- **Decision is mechanically revisitable.** The kill criteria are specific row counts and file counts, not vibes — a future Claude session can run two SQL queries and a `find | wc -l` to know whether to reopen.

### Negative

- **Regex is fragile per-line.** Multi-line Dockerfile `RUN` heredocs with embedded `apt-get install` chains, Helm subcharts with templated `image:` values, or shell scripts using `eval`/`xargs` indirection will not be captured. Documented as known limitation; no consumer needs them today.
- **Three new `ref_type` values to maintain.** `dockerfile_ref`, `helm_ref`, `infra_ref` widen the schema enum. The migration uses SQLite's table-rebuild pattern, which is heavier than `ALTER TABLE` but standard for CHECK changes.
- **The deferral is load-bearing.** If a real consumer ships that needs cross-language call-graph traversal (e.g. Python → bash → TS service stitching), this ADR becomes a blocker for that consumer until tree-sitter is reopened. The kill criteria are written to make that reopening cheap.
- **v49 migration is one-way.** Rolling back to v48 with `dockerfile_ref`/`helm_ref`/`infra_ref` rows already present would fail the v24 CHECK on downgrade. Mitigation: a downgrade script that purges those `ref_type` values before reverting — listed as a future extension, not blocking for v1.

### Neutral

- **Real edge volume from non-TS pass is small.** ~18 Dockerfiles + ~29 Helm charts + ~40 shell scripts will likely produce a few hundred rows against the existing 5,740 — single-digit-percent coverage. Stated explicitly so success isn't measured by row count alone but by `wi_blast_radius` / `wi_code_graph` returning useful results for infra-touching changes.

## Alternatives Considered

| Option | Description | Effort | Risk | Verdict |
|---|---|---|---|---|
| **(a) Adopt graphify** | Pull in the gsd-graphify skill / `graphifyy` library; let it own multi-language extraction and write into `code_graph` (or its own store). | High (1–2 weeks: schema bridge, grammar bundling, eval) | High — ChromaDB-class storage assumptions, parallel graph competing with `code_graph`, third-party data-model drift; consumers would need rewriting. Hai-proxy bypass + supply-chain concerns (see graphify entry in `.planning/ADR-REVIEW.md`). | ❌ Rejected (declined 2026-05-30 separately) |
| **(b) Adopt tree-sitter directly** | Install `web-tree-sitter` or `node-tree-sitter` + per-language grammar npm packages; author S-expression queries that emit `CodeEdge` rows. | High (2–3 weeks: native build toolchain, grammar query authoring, CI matrix) | High — `node-gyp` build pain, native-binding ABI mismatches per Node version, single-maintainer grammars (bus factor 1 for `tree-sitter-dockerfile`, `tree-sitter-hcl`, `tree-sitter-sql`), no payback while SQL/HCL/Go aren't even in the repo. | ❌ Rejected |
| **(c) Regex extension for non-TS files** | Per-language helpers for Dockerfile, Helm `Chart.yaml` (with explicit `name:` collision avoidance via two-line state machine), shell `source` and `kubectl apply -f`. Reuses `CodeEdge` insert path; widens `ref_type` enum with `dockerfile_ref` / `helm_ref` / `infra_ref` in v49 (preserving `indexed_at` + `UNIQUE`). | Low (≤1 day; sequenced **after** option d) | Low — pure additive code, regex fragility limited to obvious cases, easy to delete if tree-sitter ever lands. | ✅ **Chosen — part 2 of the decision** |
| **(d) Defer everything until the TS extractor is fixed** | Halt language fan-out; first investigate why `code_graph` has 0 rows for `ref_type IN ('call','type','api_call')` (1 h spike → produced-but-deduped vs never-produced). Either implement real call/type/api_call extraction in ts-morph **or** drop those enum values. Only after that, revisit (c). | Medium (2–3 days investigation + fix; runs **before** option c) | Low — pure correctness work; nothing new to maintain. | ✅ **Chosen — part 1 of the decision** |

## Kill Criteria for Revisiting tree-sitter

Treat any **one** of the following as a trigger to reopen this ADR. They are concrete on purpose so the revisit is mechanical, not intuition-driven:

1. **`code_graph` carries real call/type/api_call data, AND a consumer needs an edge type the regex pass cannot produce.** Threshold: ≥100 rows for each of `ref_type IN ('call','type','api_call')` after REFACTOR-002 ships, **and** a documented requirement (call-graph-tracer or blast-radius-alert or a new consumer) that names a specific edge regex cannot emit.
2. **SQL DDL files land in example-service or a sibling indexed repo.** Threshold: ≥50 `.sql` files containing `CREATE TABLE` / `FOREIGN KEY` / trigger definitions, where callers want FK-traversal edges. Today: 0.
3. **HCL / Terraform appears in operations.** Threshold: ≥25 `.tf` / `.hcl` files where module-source / variable-binding edges are needed. Today: 0.
4. **A new indexed repo introduces Go or Rust as a primary language.** Threshold: ≥200 `.go` or `.rs` files. Per-language regex maintenance becomes untenable at that point.
5. **Regex extension hits a measurable false-positive/false-negative rate >10%** on a labelled sample of 200 Dockerfile + Helm + shell files. (Implies regex is no longer "obviously good enough.")
6. **A consumer ships that requires cross-language call-graph traversal** — e.g. Python script → bash → TS service stitching — where regex cannot reasonably stitch the trace.
7. **graphify (or an equivalent wrapper) matures** to where the supply-chain / proxy-bypass / connector-gap concerns documented in `.planning/ADR-REVIEW.md` are resolved, **and** swapping it in costs less than maintaining our regex pass for one quarter.

If a kill criterion fires, revisit by:
1. Re-running the live `code_graph` row-count query above.
2. `find repos/{example-service,operations} -name '*.sql' -o -name '*.tf' -o -name '*.go' | wc -l` to confirm the file-count trigger.
3. Open a follow-up ADR superseding this one if any criterion survives a sanity check.

## Implementation Status

| Component | File | Status |
|---|---|---|
| TS extractor under-emission spike (api_call: produced-and-deduped vs never-produced?) | `src/tools/code-indexer.ts` (instrumented) | 🔲 pending — 1 h spike, gates the rest |
| TS extractor under-emission fix (REFACTOR-002) | `src/tools/code-indexer.ts:150-161` | 🔲 pending — sequenced after spike |
| Decision on `call` / `type` / `api_call` enum values (implement or drop) | `src/db/schema.ts:712-716` + `src/tools/code-indexer.ts` | 🔲 pending — output of REFACTOR-002 spike |
| Regex non-TS pass — Dockerfile / Helm / shell helpers via `extractNonTsEdges()` dispatcher | `src/tools/code-indexer.ts` | 🔲 pending — sequenced after REFACTOR-002 |
| Schema v49 — widen `ref_type` enum, **preserving `indexed_at` + `UNIQUE`** | `src/db/migrations/v49_*.ts` | 🔲 pending — bundled with regex pass |
| Graph health smoke check | `scripts/smoke-bridge.sh` (with precondition to skip when `code_graph` row count is 0) | 🔲 proposed in companion doc |
| Companion design doc | `docs/docs/architecture/non-ts-code-graph-coverage.md` | ✅ shipped 2026-05-30 |

## References

- [Companion design doc — Non-TS code-graph coverage](../architecture/non-ts-code-graph-coverage.md) — plain-English explanation, language inventory, regex pass design, migration shape with full v24 column preservation, kill criteria
- [ADR-018 — Cross-Repo Knowledge Sync](./adr-018-cross-repo-knowledge-sync.md) — original `code_graph` design
- [ADR-027 — Code-Graph Indexer Scheduling](./adr-027-code-graph-indexer-scheduling) — sibling ADR; owns the `blast-radius-alert.ts` column-name fix
- [`/.planning/ADR-REVIEW.md` REFACTOR-002 entry](https://github.com/your-org/work-intelligence-mcp/blob/main/.planning/ADR-REVIEW.md) — live tracker for TS extractor fix
- [`/.planning/ADR-REVIEW.md` graphify entry (declined 2026-05-30)](https://github.com/your-org/work-intelligence-mcp/blob/main/.planning/ADR-REVIEW.md) — independent graphify decline
- `src/tools/code-indexer.ts` — current ts-morph + regex extractor
- `src/db/schema.ts:712-716` — `code_graph` CHECK enum + (line 718) `UNIQUE(...)` dedup
- `src/intelligence/tools/call-graph-tracer.ts:108-109` — current `code_graph` consumer summary

---

## Status Update — 2026-05-30

> The body above (§ Context through § References) is preserved verbatim as the original Accepted design. This section records what shipped vs what diverged, so a cold reader can tell the spec from reality without reading the commits.

### TL;DR

- **Both v1 work-items shipped on 2026-05-29**: TS extractor fix (`642d8b7`) and regex non-TS pass (`a65c46c`). The deferral of tree-sitter is in force and unchallenged.
- **Three names diverged from spec on the way to disk** — the schema, extractor, smoke, and `CodeEdge` union all use `docker_base_image` / `helm_chart_dep` / `shell_env_ref`. The original ADR text says `dockerfile_ref` / `helm_ref` / `infra_ref`. The companion doc has been updated to match shipped names; the ADR body above is preserved as-written and reconciled here.
- **Shell helper changed scope**: ADR promised `source ./foo.sh` / `kubectl apply -f path` cross-file infra glue (`infra_ref`); shipped helper extracts `$VAR` / `${VAR}` env refs (`shell_env_ref`). Different semantic, no `infra_ref` exists in the shipped schema.
- **Dockerfile helper is FROM-only.** ADR specified `^FROM`/`^COPY`/`^ENTRYPOINT`/`^CMD`; only `FROM` is implemented (`code-indexer.ts:691`).
- **The "spike first, gates the rest" sequencing did not happen.** The fix went directly to widened patterns (HTTP verbs + axios + template-literal fetch) without the planned 1-hour sqlite-instrumented spike on UNIQUE-dedup vs never-produced. Outcome verified by `tests/tools/code-indexer.test.ts`; process was skipped.
- **Schema is now v51**, not v49. v49 widened the enum as designed; v50 (reminders) and v51 (user_profile_observations) stacked on top. The v49 rollback story in §Negative is even more one-way than the ADR states.
- **REFACTOR-002 cross-reference is wrong.** REFACTOR-002 in `.planning/ADR-REVIEW.md:358` is "Four-Stage Pipeline violations (GAP-P1 through GAP-P5)", unrelated to the extractor work. Use post-graphify steps 4–5 in `.planning/STATE.md` as the tracker.
- **Co-required consumer fix from ADR-027 has now shipped.** `blast-radius-alert.ts` phantom-column query was fixed in commit `aa5ae2a` (2026-05-30); the consumer surface that this ADR's extractor work feeds is no longer broken.

### Deviations from spec (shipped behavior)

| Area | ADR spec | Shipped reality | Severity |
|---|---|---|---|
| Dockerfile ref_type | `dockerfile_ref` | `docker_base_image` | 🔴 Critical — wrong name in spec |
| Helm ref_type | `helm_ref` | `helm_chart_dep` | 🔴 Critical |
| Shell ref_type | `infra_ref` | `shell_env_ref` | 🔴 Critical (also different semantic) |
| Shell helper scope | `source ./foo.sh`, `. ./foo.sh`, `kubectl apply -f path` | `$VAR` / `${VAR}` env-var refs only | 🟠 Major — original cross-file glue intent unimplemented |
| Dockerfile pattern set | `^FROM`, `^COPY`, `^ENTRYPOINT`, `^CMD` | `^FROM` only (`code-indexer.ts:677` regex) | 🟠 Major |
| `extractConfigEdges()` | Survives as standalone method called by new dispatcher | Inlined inside `extractNonTsEdges()` with operations-only guard (`code-indexer.ts:362`) | 🟡 Minor |
| Sequencing | Spike first → fix → regex pass | Fix shipped without spike; regex pass followed | 🟡 Minor |
| Tracker ID | REFACTOR-002 | Post-graphify step 4/5 in `.planning/STATE.md` | 🟡 Minor — broken cross-ref |
| `extractEdges` line refs (`150–161`, `166`, `144`) | As cited in ADR | Method shifted: imports `~533`, calls `~596`, api_call `~648`, Docker `~691`, Helm `~736`, shell `~772`. Use symbol names. | 🟡 Minor |

The original Decision is sound; the Implementation Status table from before the work shipped is now misleading. Reading the ADR top-to-bottom without this section, a future operator would conclude (a) the work is unfinished and (b) the schema uses names that don't exist.

### Flow diagram — v1 shipped vs v2 follow-ups

```
┌──────────────────────────────────────────────────────────────────────┐
│              LIVE TODAY (v1: 642d8b7 + a65c46c, schema v51)          │
│                                                                      │
│   indexRepo(repo) — DELETE FROM code_graph WHERE repo=?              │
│         │                                                            │
│         ├─► scanRepo:                                                │
│         │     ├─ extractEdges (TS files)  ── ts-morph                │
│         │     │     emits: import, type, call, api_call, env_var     │
│         │     │            test_covers                               │
│         │     │     api_call: fetch + axios + .get/.post/.put/...    │
│         │     │              + template-literal URLs ── 642d8b7      │
│         │     │                                                      │
│         │     └─ extractNonTsEdges (regex pass) ── a65c46c           │
│         │           ├─ Dockerfile: FROM only       → docker_base_image│
│         │           ├─ Helm Chart.yaml deps        → helm_chart_dep  │
│         │           ├─ Shell .sh: $VAR / ${VAR}    → shell_env_ref   │
│         │           └─ YAML/JSON env refs (ops)    → config_ref      │
│         │                                                            │
│         └─► insertEdge — UNIQUE(repo,file_path,symbol,ref_repo,      │
│                                  ref_file,ref_symbol,ref_type)       │
│                                                                      │
│   incremental path (ADR-027 v2 agent): indexChangedSince — re-emits  │
│     non-TS edges only when the file is in the changed set            │
│                                                                      │
│   Schema v49 widened CHECK to include the three new ref_types        │
│     (preserving indexed_at + UNIQUE — verified against                │
│     v49_code_graph_non_ts_ref_types.ts)                              │
│                                                                      │
│   Smoke check §10c — warn-only:                                      │
│     SELECT ref_type, COUNT(*) FROM code_graph                        │
│      WHERE ref_type IN ('docker_base_image','helm_chart_dep',        │
│                         'shell_env_ref') GROUP BY ref_type           │
│                                                                      │
│   Consumer surface: ADR-027 v2 fixed blast-radius-alert.ts query     │
│     (aa5ae2a) — extractor improvements are now visible to consumers  │
└──────────────────────────────────────────────────────────────────────┘

                                  │
                       v2 follow-ups (proposed)
                                  ▼

┌──────────────────────────────────────────────────────────────────────┐
│                  v2 OPEN ITEMS (none blocking)                       │
│                                                                      │
│   1. Production verification of api_call rows                        │
│        After Sunday-sweep full reindex (ADR-027 v2 ee7b070):         │
│        SELECT ref_type, COUNT(*) FROM code_graph                     │
│         WHERE ref_type IN ('call','type','api_call')                 │
│         GROUP BY ref_type;                                           │
│        ──► smoke fails if call+type=0 on a populated DB              │
│        ──► api_call warn-only until reindex confirmed                │
│                                                                      │
│   2. Optional infra_ref shell glue (~20 LOC)                         │
│        Original ADR intent: source ./foo.sh, kubectl apply -f path   │
│        Either implement as a second shell pass with a new ref_type,  │
│        or explicitly drop from Decision §2.                          │
│        Closed: deferred (Phase 73 F4) — shell_env_ref already        │
│        shipped real value (568 rows); no consumer has asked for      │
│        cross-file glue; every new ref_type is maintenance debt.      │
│                                                                      │
│   3. Optional Dockerfile pattern expansion                           │
│        Add COPY/ENTRYPOINT/CMD if a consumer asks; otherwise         │
│        document the current FROM-only scope as intentional v1.       │
│        Closed: deferred (Phase 73 follow-up) — FROM-only ships       │
│        real value (448 rows); no consumer has asked for COPY /       │
│        ENTRYPOINT / CMD edges; every new pattern is maintenance      │
│        debt. FROM-only is the intentional v1 scope.                  │
└──────────────────────────────────────────────────────────────────────┘
```

### Refreshed Implementation Status (replaces table at L188–198)

| Component | Live location | Status as of 2026-05-30 |
|---|---|---|
| TS extractor under-emission spike | — | ❌ **Skipped** — went direct to fix; outcome verified by tests instead |
| TS extractor under-emission fix | `src/tools/code-indexer.ts:596–648` (call/api_call), `:583` (type) | ✅ **Shipped** in `642d8b7` (2026-05-29) |
| Decision on `call`/`type`/`api_call` enum values | `src/db/schema.ts` + `code-indexer.ts` `CodeEdge` union | ✅ **Implement** chosen — patterns widened to HTTP verbs + axios + template URLs |
| Tests pinning the fix | `tests/tools/code-indexer.test.ts` | ✅ **Shipped** — covers call/type/api_call (axios, template-literal fetch) |
| Regex non-TS pass dispatcher (`extractNonTsEdges`) | `src/tools/code-indexer.ts:305–373` | ✅ **Shipped** in `a65c46c` (2026-05-29) |
| Dockerfile helper (FROM only — narrower than spec) | `src/tools/code-indexer.ts:665–697` | ✅ **Shipped (partial)** — see deviations |
| Helm helper (state-machine for `name:` collision) | `src/tools/code-indexer.ts:709–743` | ✅ **Shipped** — matches ADR intent |
| Shell helper (env refs, not source/kubectl) | `src/tools/code-indexer.ts:744–778` | ✅ **Shipped (semantic shift)** — see deviations |
| Schema v49 widening (preserving `indexed_at` + 7-col UNIQUE) | `src/db/migrations/v49_code_graph_non_ts_ref_types.ts` | ✅ **Shipped** — verified verbatim against design |
| Graph health smoke check | `scripts/smoke-bridge.sh` § 10c | ✅ **Shipped (warn-only)** on shipped names; v2 should harden to fail |
| Companion design doc | `docs/docs/architecture/non-ts-code-graph-coverage.md` | ✅ **Updated to shipped names** in this commit |
| `CODE_GRAPH_INTERVAL_MS` documented | `CLAUDE.md` Environment block | ✅ **Shipped** (via ADR-027) |
| `blast-radius-alert.ts` consumer fix | `src/tools/blast-radius-alert.ts` | ✅ **Shipped** (`aa5ae2a`) — owned by ADR-027 v2 |

### v2 acceptance criteria

A v2 cleanup is "done" when:

1. The smoke check in `smoke-bridge.sh` § 10 (the `code_graph` row-count gate) is upgraded from warn-only to a hard gate **after** verifying via a populated DB that `call` and `type` produce ≥ 1 row each.
2. A `.planning/STATE.md` entry or post-graphify ledger row replaces every "REFACTOR-002" cross-reference in this ADR's body. (Done as of this Status Update for the header; body is preserved.)
3. Either: shell `source` / `kubectl apply -f` glue is implemented as a second pass with a new ref_type, OR Decision §2 is amended to explicitly scope the shell helper to env vars.

### Notes for the next reviewer

- **The deferral of tree-sitter remains correct.** All seven kill criteria are still cold (zero SQL/HCL/Go in repos, no false-positive measurement campaign yet, no consumer requiring cross-language traversal). The only criterion approaching warm is #1 — verification that `call` and `type` rows actually appear in production after the next Sunday full sweep.
- **The smoke check is the truth source for the enum names.** If the ADR or companion doc disagrees with `scripts/smoke-bridge.sh` § 10c, the smoke wins (it's run by CI and verified against the live schema).
- **Tracker hygiene lesson.** The original ADR cited REFACTOR-002 as the implementation tracker, but the actual work was tracked as "post-graphify step 4/5" in `.planning/STATE.md`. Future ADRs should cite the post-graphify ledger format used in ADR-029 / ADR-027b, not REFACTOR-NNN slots reserved for cross-cutting items.

---

## Audit Update — 2026-05-31

> One day post-Status-Update. Re-audited against the live codebase and production DB. Findings re-prioritise the v2 follow-ups and surface one previously-unflagged surface.

### Live row counts — kill criterion #1 has technically fired

```
$ sqlite3 ~/.work-intelligence-mcp/data.db \
    "SELECT ref_type, COUNT(*) FROM code_graph GROUP BY ref_type ORDER BY 2 DESC"
call             | 238780
import           |  15633
type             |  13823
test_covers      |  13774
api_call         |    908
env_var          |    860
shell_env_ref    |    568
docker_base_image|    448
config_ref       |    289
```

Compared to the ADR's authorship snapshot (`import 3140 / test_covers 2198 / config_ref 289 / env_var 113 / call/type/api_call=0`), every previously-zero ref_type has crossed the kill-criterion #1 threshold (≥100):

- `call`: 0 → **238,780** ✅ threshold met
- `type`: 0 → **13,823** ✅ threshold met
- `api_call`: 0 → **908** ✅ threshold met

**This satisfies only the first leg of kill criterion #1.** The criterion requires *both* `≥100 rows` *AND* "a consumer needs an edge type the regex pass cannot produce." That second leg has not fired — `traceCallGraph` and `checkBlastRadius` are both happy with the current ref_types. So tree-sitter remains correctly deferred. But the criterion is now one consumer-request away from triggering, not seven.

### Sanity check on the call-edge count

`call: 238,780` is ~15× the import count. That's high enough to wonder whether the walker is over-generous (e.g. emitting every CallExpression including JS std-lib calls and chained method calls), and ADR-028's Decision §1 has no documented filter rules for what counts as "a call worth recording." Worth a 30-minute follow-up to query a few rows and see whether the noise floor is acceptable. Not a blocker — wi_code_graph and wi_blast_radius haven't reported regressions — but if call-graph queries start returning unhelpfully wide neighbourhoods, this is the first place to look.

### Previously-unflagged surface: `extractNonTsEdgesForFile`

Yesterday's audit caught `extractNonTsEdges` (full-repo) but missed that there is a **second non-TS dispatcher** at `src/tools/code-indexer.ts:392–411` — `extractNonTsEdgesForFile()` — used by the incremental path (`indexChangedSince` via the ADR-027 v2 agent). It dispatches by basename: `Dockerfile*` → `extractDockerEdges`, `Chart.ya?ml` → `extractHelmChartEdges`, `.sh` → `extractShellEnvEdges`. **It does NOT call the operations-only `config_ref` env-var scan** — that branch only fires on full sweeps.

Implication for v2 follow-up #2 (optional `infra_ref` shell glue): if it lands, it must be added to **both** `extractNonTsEdges` (full-sweep path) AND `extractNonTsEdgesForFile` (incremental path), or new edges get dropped on every incremental tick and only reappear after Sunday's full sweep. Same constraint applies to v2 follow-up #3 (Dockerfile pattern expansion).

This is the same constraint the original ADR called out for `extractNonTsEdges` vs `indexRepo`'s `DELETE FROM code_graph WHERE repo = ?` — but the constraint surface widened when the incremental path shipped in ADR-027 v2.

### v2 acceptance criteria — status as of today

1. **Harden smoke § 10 (code_graph row-count gate) from warn-only to a hard gate** for `call` and `type` ≥ 1 row each. **Now unblocked** — production has 238,780 + 13,823 rows. Two-line change to `smoke-bridge.sh`. **Closed: shipped in `ac498ff` (Phase 73 plan 73-01) on 2026-05-31** — gate is `CODE_GRAPH_FAIL_THRESHOLD`-tunable (default 100); below threshold the warn-only path persists for cold-DB CI fixtures.
2. **Replace REFACTOR-002 cross-references in the body** with post-graphify ledger pointers. Header is fixed; body L71 still says "Tracked as **REFACTOR-002**." Per the index.md immutability rule the body stays as-written; this Audit Update is the reconciliation. No further action.
3. **Decide shell-helper scope**: implement `infra_ref` shell glue OR explicitly drop from Decision §2. **Closed: deferred (Phase 73 F4)** — see V2 OPEN ITEMS box above for rationale: shell_env_ref already shipped real value (568 rows); no consumer has asked for cross-file glue; every new ref_type is maintenance debt.

### Additional v2 candidates surfaced today

- **Audit `call`-edge noise floor.** Sample 100 rows, see if intra-file or std-lib calls dominate; consider an ignore-list (`Math.*`, `Array.prototype.*`, `console.*`) if so. ~30 min investigation, ~10 LOC fix if needed.
- **Cross-link `extractNonTsEdges` and `extractNonTsEdgesForFile`** with a comment in each pointing at the other, and add a unit test that fails if a new ref_type lands in one without the other. Prevents silent incremental-vs-full-sweep drift.

### F3 — call-edge noise verdict (sample-100)


### Notes for the next reviewer

- The "the only kill criterion approaching warm is #1" wording from yesterday's Status Update is now wrong: criterion #1's data leg has fired. Update mental model to "criterion #1 is one consumer-request away from triggering."
- **The smoke check is still the truth source for the enum names** (this hasn't changed). `smoke-bridge.sh` § 10c uses the shipped names — ADR body uses pre-shipped names — Audit Update is the bridge.
- The next ADR review should double-check that *both* non-TS surfaces (`extractNonTsEdges` for full sweep AND `extractNonTsEdgesForFile` for incremental) cover any newly-added ref_types. Yesterday's audit missed this.
