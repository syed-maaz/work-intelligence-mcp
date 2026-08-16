---
sidebar_position: 14
title: Non-TS code_graph coverage — why regex, not tree-sitter
---

# Non-TS `code_graph` coverage — why regex, not tree-sitter

> **Companion to [ADR-028](../adr/adr-028-defer-tree-sitter.md).** This doc walks through the reasoning end-to-end so a future Claude session reading either document doesn't have to re-derive it.

## TL;DR

1. The `code_graph` table is silently empty for `call`, `type`, and `api_call` rows even though the schema permits them. **Fix that first** — REFACTOR-002. (Open question: are `api_call` rows being produced and silently deduped by the existing 7-column `UNIQUE`, or never produced? Resolves with a 1-hour sqlite-instrumented spike.)
2. Then ship per-language regex helpers for Dockerfiles, Helm charts, and shell scripts — the only non-TS file types that actually exist in the indexed repos in any volume.
3. **Don't** add tree-sitter (directly or via graphify). The languages it would unlock that regex can't handle (SQL DDL, HCL, Go) aren't in the repo. The languages that *are* in the repo are line-oriented and regex-friendly.
4. Revisit when one of the kill criteria fires (see "Revisit when" at the bottom).

## Plain-English: what are we even talking about?

### tree-sitter

Tree-sitter is an open-source parser generator originally built by GitHub for syntax highlighting and code navigation. It turns source code in any supported language into a structured syntax tree — a precise, queryable map of every symbol, statement, and expression in a file. It ships as a small native C library plus per-language *grammars*, with bindings for Node.js, Python, Rust, and others. The big appeal: one common API works across 100+ languages (Go, Python, Rust, SQL, Bash, Dockerfile, YAML, HCL, …), each via its own grammar package. You write small "queries" in a Lisp-like S-expression syntax to extract the constructs you care about, e.g. *"all function calls"* or *"every imported module name"*.

### ts-morph (what we use today)

`ts-morph` is a thin, idiomatic TypeScript wrapper over the official TypeScript compiler API. It is excellent for `.ts` and `.tsx` files because it has the entire TypeScript type checker behind it — generics, inferred types, module resolution, the lot. But it cannot parse anything outside the TypeScript/JavaScript family. A Dockerfile, a Helm Chart, a Bash script, a SQL DDL — all opaque text from ts-morph's perspective.

### graphify

Graphify is a higher-level project (used by the `gsd-graphify` skill, PyPI: `graphifyy`) that wraps tree-sitter behind a friendlier *"give me the call graph for this repo"* interface. It bundles 33+ tree-sitter grammars, NetworkX for graph storage, Leiden community detection, and a vis.js HTML viewer. Adopting graphify means inheriting tree-sitter's grammars **plus** graphify's own conventions and storage. It was independently declined on 2026-05-30 (see `.planning/ADR-REVIEW.md` graphify entry).

### So the question reduces to:

Keep ts-morph for TS, regex for everything else? Or pull in tree-sitter (directly or via graphify) to cover the long tail of non-TS file types in one shot?

## What ts-morph does today

`src/tools/code-indexer.ts` instantiates a `ts-morph` `Project` per repo, walks `*.ts`/`*.tsx` files (excluding `node_modules`, `dist`, `build`, `.git`, `coverage`), and emits `code_graph` rows for:

- **Relative `import` declarations** — mapped to `ref_type='import'`, or `'test_covers'` if the importer's path contains `.test.` / `.spec.`
- **`process.env.X` property accesses** — `ref_type='env_var'`, `ref_file='.env'`, `ref_symbol=X`
- **`fetch('/api/...')` call expressions** — `ref_type='api_call'`, *only when* the literal identifier is `fetch` and the first argument is a string literal starting with `/api/`

A separate regex pass `extractConfigEdges()` (`src/tools/code-indexer.ts:166`) scans `.yaml`/`.yml`/`.json` for `${VAR}` / `$VAR` patterns and emits `config_ref` rows. (Earlier drafts of this doc said "operations only" — that was wrong. The function is called per-repo for any repo with those file extensions; operations is just the repo with 561 yaml files, so its rows dominate.)

The `code_graph` schema (v24, `src/db/schema.ts:704-723`) declares:

```sql
CREATE TABLE IF NOT EXISTS code_graph (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  file_path TEXT NOT NULL,
  symbol TEXT,
  ref_repo TEXT NOT NULL,
  ref_file TEXT NOT NULL,
  ref_symbol TEXT,
  ref_type TEXT NOT NULL CHECK(ref_type IN (
    'import', 'call', 'type', 'api_call', 'env_var',
    'test_covers', 'config_ref'
  )),
  line_number INTEGER,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type)
);
```

Two things in this declaration are load-bearing for the migration in §"Step 3" and easy to drop if you're skim-reading:

- **`indexed_at TEXT NOT NULL DEFAULT (datetime('now'))`** — every existing query that asks "how stale is this graph?" reads this column.
- **`UNIQUE(repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type)`** — silently dedupes inserts, which is also one explanation for why `api_call` rows might be missing (rather than an extractor gap).

The indexer covers 5 of the 7 enum values on paper. **Two of those five — `call` and `type` — are never emitted by any code path.** The third intended emission, `api_call`, doesn't appear in the live database at all (zero rows).

## The headline finding

```
$ sqlite3 ~/.work-intelligence-mcp/data.db \
    "SELECT ref_type, COUNT(*) FROM code_graph GROUP BY ref_type ORDER BY 2 DESC;"
import      | 3140
test_covers | 2198
config_ref  |  289
env_var     |  113
```

Total: **5,740 rows**. Zero rows for `call`, zero for `type`, zero for `api_call`. (A separate `SELECT COUNT(DISTINCT file_path) FROM code_graph` would give a file count; earlier drafts cited "2,603 files" without showing the query — treat that as approximate.)

The downstream consumers of `code_graph` are:

- **`src/intelligence/tools/call-graph-tracer.ts`** — BFS over edges, advertised directions `'callers'` / `'callees'` / `'both'`, returns `{ nodes, edges, externalDeps, crossRepoBoundaries }` for ReAct observations
- **`src/tools/blast-radius-alert.ts`** — dependent-files lookup for change-impact alerts (with a separate column-name bug — see ADR-027)

Both treat `code_graph` as the single source of truth. Both, today, are operating on an edge graph that is in practice an **import graph dressed up as a call graph**. The trace output's `summary` field even hard-codes the fallback string `"code_graph may not be indexed for this repo"` (`call-graph-tracer.ts:108-109`) — a false bottom that masks the real failure mode: the table **is** indexed, the producer just never emits the row types the consumer asks about.

This is the trap the graphify spike walked into: *"we lack multi-language coverage"* is the visible symptom. The real defect is one layer down — an under-emitting TypeScript extractor. Adding grammars on top of that would widen the funnel before fixing the leak.

## Open question (parked, but explicit)

**Why are there 0 `api_call` rows?** Two hypotheses:

- **A — extractor never emits.** The bare-identifier `fetch` + literal-`/api/`-prefix shape is rare; real call sites use `axios`, an `apiClient` wrapper, or template-literal URLs. The walker silently skips them.
- **B — extractor emits, UNIQUE silently drops.** The 7-column UNIQUE includes `ref_type` but also `symbol`/`ref_symbol`. If those are populated identically across many call sites (e.g. all `null`/`'fetch'`), `INSERT OR IGNORE` would mask 99% of the rows and we'd see only the first hit per file.

The 1-hour spike resolves which: instrument the insert path with a counter that logs `(attempted_inserts, ignored_inserts, succeeded_inserts)` per `ref_type` after a full reindex. The ADR's path forward is robust to either answer:

- If A: REFACTOR-002 widens the walker.
- If B: REFACTOR-002 either changes the UNIQUE columns or generates a more discriminating `symbol` value.

Either way, the regex non-TS pass (Step 2 below) is unaffected.

## Language inventory (counted 2026-05-30)

`repos/example-service` and `repos/operations`, what's actually on disk (file counts depend on exclude set; figures below use the same excludes the indexer applies — `node_modules`, `dist`, `build`, `.git`, `coverage`):

| Language | Count | Currently extracted? | Pattern complexity | Regex sufficient? |
|---|---:|---|---|---|
| TypeScript / TSX | thousands | ✅ via ts-morph | Nested | No (ts-morph is correct here) |
| JavaScript / JSX | dozens | ✅ via ts-morph | Nested | No |
| YAML / YML (operations) | 561 | ⚠️ env-var refs only | Moderate | ✅ yes (already done) |
| Helm `Chart.yaml` | 29 | ❌ | Moderate (collision: `name:` at top level **and** in `dependencies:` block — needs state machine, not a single regex) | ✅ yes |
| Dockerfile (example-service) | 18 | ❌ | Trivial (line-anchored `FROM` / `COPY` / `ENTRYPOINT`) | ✅ yes |
| Bash / shell `.sh` | ~40 | ❌ | Moderate (`source ./foo.sh`, `kubectl apply -f path.yaml`) | ✅ yes |
| JSON config | many | ⚠️ env-var refs only | Trivial | ✅ yes |
| Markdown (cross-doc links) | many | ❌ | Trivial | ✅ yes |
| Python | **1** | ❌ | Nested | ✅ yes (one file isn't a problem) |
| **SQL DDL** | **0** | n/a | Nested (FK, triggers) | No — but **no files exist** |
| **HCL / Terraform** | **0** | n/a | Nested | No — but **no files exist** |
| **Go** | **0** | n/a | Nested | No — but **no files exist** |
| **Rust** | **0** | n/a | Nested | No — but **no files exist** |

The pattern is clear: **every language present in volume is regex-sufficient. Every language that would justify a real parser is absent.**

## Why regex catches 99% of the value

The non-TS file types we care about are line-oriented configuration files:

- **Dockerfile** instructions (`FROM`, `COPY`, `RUN`, `ENTRYPOINT`, `CMD`) start at column zero on a single line. There is no nesting, no precedence, no scope — the grammar that matters fits in five regexes.
- **Helm `Chart.yaml`** has a fixed schema (`apiVersion`, `name`, `version`, `dependencies:`, `image:`). The structural variability is bounded; a YAML parse is overkill when the meaningful keys are known a priori — but a single `^name:` regex would emit the chart's own name as a "dependency", because every chart has both a top-level `name:` AND `dependencies: - name: ...` entries. The fix is a tiny two-line state machine (shown in §"Proposed regex pass design").
- **Shell scripts** present a real edge-case surface (heredocs, `eval`, command substitution), but the references we care about — `source ./foo.sh`, `. ./foo.sh`, `kubectl apply -f path.yaml` — are written as line-anchored literals in 95%+ of real scripts. A regex that misses an `eval $(generate_command)` indirect reference produces a missing edge, not a wrong edge.

Tree-sitter buys us *correctness on edge cases that don't exist in our corpus*. Regex buys us *coverage on the common case for ~80 LOC and zero new dependencies*. Until edge cases exist, the trade is one-sided.

## Proposed regex pass design

### Step 1: introduce a dispatcher (no rename)

`extractConfigEdges()` keeps its current name and current scope (env-var refs in YAML/JSON). A new `extractNonTsEdges()` is added alongside it as the single dispatcher called from `indexRepo()`:

```ts
private extractNonTsEdges(repo: RepoConfig): CodeEdge[] {
  const edges: CodeEdge[] = [];
  edges.push(...this.extractDockerfileEdges(repo));
  edges.push(...this.extractHelmEdges(repo));
  edges.push(...this.extractShellEdges(repo));
  edges.push(...this.extractConfigEdges(repo));   // existing env-var pass, unchanged
  return edges;
}
```

`indexRepo()` (`src/tools/code-indexer.ts:144` — currently calls `extractConfigEdges` directly) is amended to call `extractNonTsEdges()` instead. Crucially, this MUST happen inside the same `indexRepo()` invocation as the TS pass, because the function opens with `DELETE FROM code_graph WHERE repo = ?` — running the non-TS pass separately would have its rows wiped on the next reindex.

The "no rename" choice is deliberate. The earlier draft of this doc proposed renaming `extractConfigEdges → extractNonTsEdges`, then in the same paragraph showed `extractNonTsEdges` calling a different function `extractEnvVarEdges` that didn't exist. That triangle is removed: the existing function keeps its name, the new function is purely additive.

### Step 2: Helm regex with collision avoidance

Naïve `^name:` matching is wrong. The state-machine-shaped helper:

```ts
private extractHelmEdges(repo: RepoConfig): CodeEdge[] {
  const edges: CodeEdge[] = [];
  for (const file of this.findFilesByName(repo.localPath, 'Chart.yaml')) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    let inDeps = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^dependencies:\s*$/.test(line)) { inDeps = true; continue; }
      if (inDeps && /^[A-Za-z]/.test(line)) inDeps = false;     // left the deps block
      if (!inDeps) continue;
      const m = line.match(/^\s+- name:\s*(\S+)/);
      if (m) edges.push({
        repo: repo.name,
        file_path: relative(repo.localPath, file),
        ref_repo: 'helm',
        ref_file: m[1],
        ref_type: 'helm_chart_dep',
        line_number: i + 1,
      });
    }
  }
  return edges;
}
```

The same shape is used for `image:` keys, only emitting when nested under a known parent context (`spec.image`, `containers[].image`).

### Step 3: three new `ref_type` values + the v49 migration

Schema v49 widens the CHECK enum **while preserving the existing `indexed_at` column and the seven-column `UNIQUE`**. The earlier draft of this doc shipped a migration that silently dropped both — the corrected SQL is below:

```sql
-- src/db/migrations/v49_widen_code_graph_ref_type.ts
PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE code_graph_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  file_path TEXT NOT NULL,
  symbol TEXT,
  ref_repo TEXT NOT NULL,
  ref_file TEXT NOT NULL,
  ref_symbol TEXT,
  ref_type TEXT NOT NULL CHECK(ref_type IN (
    'import','call','type','api_call','env_var','test_covers','config_ref',
    'docker_base_image','helm_chart_dep','shell_env_ref'
  )),
  line_number INTEGER,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo, file_path, symbol, ref_repo, ref_file, ref_symbol, ref_type)
);

INSERT INTO code_graph_new (
  id, repo, file_path, symbol, ref_repo, ref_file, ref_symbol,
  ref_type, line_number, indexed_at
)
SELECT
  id, repo, file_path, symbol, ref_repo, ref_file, ref_symbol,
  ref_type, line_number, indexed_at
FROM code_graph;

DROP TABLE code_graph;
ALTER TABLE code_graph_new RENAME TO code_graph;

CREATE INDEX IF NOT EXISTS idx_code_graph_source ON code_graph(repo, file_path);
CREATE INDEX IF NOT EXISTS idx_code_graph_ref    ON code_graph(ref_repo, ref_file);
CREATE INDEX IF NOT EXISTS idx_code_graph_type   ON code_graph(ref_type);

COMMIT;
PRAGMA foreign_keys = ON;
```

Two corrections from the original draft:

1. **`indexed_at` is preserved** — same type (`TEXT`), same `NOT NULL DEFAULT (datetime('now'))`, same name. Existing queries against `code_graph.indexed_at` keep working.
2. **`UNIQUE(...)` is preserved** — silently dedupes inserts, same as v24. If the api_call open question turns out to be UNIQUE-collision (hypothesis B above), we still see that behavior post-migration; the spike's job is to surface it, not to bypass it.

The explicit column list in the `INSERT INTO ... SELECT ...` is also a correction. `INSERT INTO code_graph_new SELECT * FROM code_graph` is convenient but order-of-columns dependent; explicit lists survive future column reordering.

| New `ref_type` | What it represents | Example |
|---|---|---|
| `docker_base_image` | Base image referenced by a `FROM` line in a Dockerfile (v1 scope: `FROM` only — `COPY` / `ENTRYPOINT` / `CMD` deferred) | `FROM node:20-alpine` → `(ref_file='node:20-alpine', ref_type='docker_base_image')` |
| `helm_chart_dep` | Helm chart dependency declared under `dependencies:` in `Chart.yaml` | `dependencies: - name: postgresql` → `(ref_file='postgresql', ref_type='helm_chart_dep')` |
| `shell_env_ref` | Environment variable referenced inside a `.sh` script as `$VAR` or `${VAR}`, deduped per-file | `aws --region "$AWS_REGION"` → `(ref_file='.env', ref_symbol='AWS_REGION', ref_type='shell_env_ref')` |

> **Naming history.** Earlier drafts of this doc used `dockerfile_ref` / `helm_ref` / `infra_ref`. The shipped names are `docker_base_image` / `helm_chart_dep` / `shell_env_ref` (verified against `src/db/migrations/v49_code_graph_non_ts_ref_types.ts` and `src/tools/code-indexer.ts`). The shell helper also shipped with a different semantic — env-var references rather than the `source ./foo.sh` / `kubectl apply -f` cross-file glue the original draft promised. See ADR-028's "Status Update — 2026-05-30" for the full deviation log.

### Step 4: don't backfill existing `config_ref` rows

The 289 existing `config_ref` rows are env-var references in YAML/JSON. They are **not** Dockerfile or Helm refs, and the regex pass does not produce them. Leave them as `config_ref`. Future ref-type questions ("show me everything that touches the postgres image") select on `ref_type IN ('helm_chart_dep','docker_base_image')` rather than trying to bucket history.

### Realistic row-count expectations

Worth stating explicitly: the new regex pass will likely add **a few hundred rows** against the existing 5,740 — single-digit-percent coverage. Success isn't measured by row count alone. It's measured by:

- **`wi_blast_radius` returning useful results** for changes to a `Chart.yaml` or a referenced shell script.
- **Smoke-check failure** if any declared `ref_type` (after REFACTOR-002 settles which ones are declared) reports zero rows.
- **No regression** in the `import` / `test_covers` row counts (the regex pass is purely additive).

## Why this order matters

The decision in ADR-028 is **sequenced**, not parallel. Doing them out of order produces a worse outcome than doing either alone:

- **Regex pass first, TS fix later** → adds non-TS rows on top of an extractor that's still hiding the absence of `call` / `type` / `api_call`. Consumers get more data of the wrong shape; the diagnostic surface gets noisier.
- **TS fix only, no regex pass** → leaves the genuine non-TS gap unaddressed even though it's a 1-day fix.
- **Both in one PR** → couples a 2–3 day correctness investigation to a 1-day additive feature; doubles the review surface; one rollback drags the other.

So: ship part 1 (with the spike to resolve the api_call open question), verify the row counts move (or that an enum value is dropped), then ship part 2.

## Proposed graph-health smoke check

To prevent the next under-emission regression from sitting in the database for months, add to `scripts/smoke-bridge.sh` — with a precondition so CI doesn't false-fail when `repos/` isn't populated:

```bash
# Smoke check: every declared ref_type produces ≥1 row — only when graph is populated
total=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM code_graph;")
if [ "$total" -lt 100 ]; then
  echo "[smoke] code_graph has $total rows; skipping per-ref_type coverage check (run a reindex first)"
else
  for rt in import call type api_call env_var test_covers config_ref \
            docker_base_image helm_chart_dep shell_env_ref; do
    n=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM code_graph WHERE ref_type = '$rt';")
    if [ "$n" -eq 0 ]; then
      fail "code_graph has 0 rows for ref_type='$rt' (extractor may be silently broken — or this enum value should be dropped)"
    fi
  done
fi
```

This is intentionally strict once the precondition is met. If a `ref_type` is in the CHECK enum AND the graph is populated AND that ref_type produces zero rows, *something* is wrong — either (a) the language genuinely doesn't appear (drop the enum value) or (b) the extractor is broken (fix it). Either action is preferable to silent zero. The precondition exists so this same check can run in CI and on a freshly-cloned dev box without blowing up.

This smoke check would have caught the original under-emission the day it shipped instead of months later.

## Migration reversibility

SQLite CHECK widening via table-rebuild is **one-way** in practice. If v49 ships and needs reverting:

1. Any rows with `ref_type IN ('docker_base_image','helm_chart_dep','shell_env_ref')` would fail the v24 CHECK on downgrade.
2. The downgrade migration (v49 → v48) would need to either (a) `DELETE FROM code_graph WHERE ref_type IN (...)` before rebuilding the v24 table, or (b) refuse to downgrade if any such rows exist.

Option (a) is the easier path; the migration framework should support a downgrade variant. Listed as a future extension in ADR-028, not blocking for v1.

## Revisit when

Treat any **one** of these as a trigger to reopen ADR-028 and re-evaluate tree-sitter:

1. **`code_graph` carries real call/type/api_call data, AND a consumer needs an edge type the regex pass cannot produce.** Threshold: ≥100 rows for each of `ref_type IN ('call','type','api_call')` after REFACTOR-002 ships, **and** a documented requirement naming a specific edge regex cannot emit.
2. **SQL DDL files land in example-service or a sibling indexed repo.** Threshold: ≥50 `.sql` files containing FK or trigger definitions. Today: 0.
3. **HCL / Terraform appears in operations.** Threshold: ≥25 `.tf` / `.hcl` files where module-source / variable-binding edges are needed. Today: 0.
4. **A new indexed repo introduces Go or Rust as a primary language.** Threshold: ≥200 `.go` or `.rs` files.
5. **Regex extension hits a measurable false-positive/false-negative rate >10%** on a labelled sample of 200 Dockerfile + Helm + shell files.
6. **A consumer ships that requires cross-language call-graph traversal** — Python script → bash → TS service stitching — where regex cannot reasonably stitch the trace.
7. **graphify (or an equivalent wrapper) matures** to where the supply-chain / proxy-bypass / connector-gap concerns documented in `.planning/ADR-REVIEW.md` are resolved.

To revisit mechanically:

```bash
# 1. Re-run the live row-count query
sqlite3 ~/.work-intelligence-mcp/data.db \
  "SELECT ref_type, COUNT(*) FROM code_graph GROUP BY ref_type ORDER BY 2 DESC;"

# 2. Recount the file mix
find repos/{example-service,operations} \
  \( -name '*.sql' -o -name '*.tf' -o -name '*.hcl' -o -name '*.go' -o -name '*.rs' \) \
  | wc -l
```

If any threshold trips, open a follow-up ADR superseding ADR-028.

## Open questions (parked)

These came out of the spike but don't need answers to land the decision. Captured here so they aren't re-discovered:

1. **Why is `code_graph` empty for `api_call`?** Hypothesis A vs B above. 1-hour instrumented spike resolves it. The ADR's path forward is robust to either answer.
2. **Should the v24 CHECK enum be tightened to remove `call` and `type` until they're actually emitted**, to stop consumers from coding against ghost columns? Or should the extractor be expanded to populate them? REFACTOR-002 will pick one based on consumer demand.
3. **Does call-graph-tracer's `'callers'` / `'callees'` API have any real consumer today**, or is it only invoked from ReAct traces where an empty result is silently absorbed into the LLM context? If no consumer exists, the cheaper fix is to drop the enum values.
4. **Are there any consumers of `code_graph` outside the two reviewed** (call-graph-tracer, blast-radius-alert) that would break if the `ref_type` enum changed? Grep before the v49 migration ships.
5. **Does graphify already write to a sqlite-compatible schema we could mirror**, or would adoption force a new storage layer (ChromaDB / its own DB file)? Parked — graphify is declined for separate reasons (`.planning/ADR-REVIEW.md`).

## References

- [ADR-028 — Defer tree-sitter; fix TS extractor and ship regex non-TS pass first](../adr/adr-028-defer-tree-sitter.md) — the decision this doc supports
- [ADR-027 — Code-Graph Indexer Scheduling](../adr/adr-027-code-graph-indexer-scheduling) — sibling ADR; owns scheduling + the `blast-radius-alert.ts` column-name fix
- [ADR-018 — Cross-Repo Knowledge Sync](../adr/adr-018-cross-repo-knowledge-sync.md) — original `code_graph` design
- [`/.planning/ADR-REVIEW.md` graphify entry (declined 2026-05-30)](https://github.com/your-org/work-intelligence-mcp/blob/main/.planning/ADR-REVIEW.md) — independent graphify decline; supply-chain + Hai-proxy + connector-gap reasoning
- [`/.planning/ADR-REVIEW.md` REFACTOR-002 entry](https://github.com/your-org/work-intelligence-mcp/blob/main/.planning/ADR-REVIEW.md) — live tracker for TS extractor under-emission fix
- `src/tools/code-indexer.ts` — current ts-morph + regex extractor
- `src/db/schema.ts:704-723` — full `code_graph` table including `indexed_at` and `UNIQUE`
- `src/intelligence/tools/call-graph-tracer.ts:108-109` — the misleading `"code_graph may not be indexed"` summary string
- `src/tools/blast-radius-alert.ts` — second `code_graph` consumer (column-name fix in ADR-027)
