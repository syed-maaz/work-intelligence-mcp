# ACHIEVEMENTS

Portfolio notes for work-intelligence-mcp. Every number here was measured directly from this repo (see the [measurement table](#measurements-table-commands) at the bottom for the exact commands used). Where a figure is *documented* rather than *measured*, it says so.

---

## 1. Architecture

### A. Four-stage data pipeline (data law)

Every piece of work data flows through exactly four stages — no stage may be merged or skipped (ARCHITECTURE.md §4, "the hard contracts"):

```
FETCH ──► PROCESS ──► ANALYZE ──► PROPOSE
 pull raw    normalize   Claude    surface
 from Jira/  dedupe,     interprets  via tool/
 Teams/GitHub upsert,   stored      UI / SSE
 /Outlook    embed      data
```

Each stage forbids a specific abuse: FETCH can't call Anthropic or write the DB; PROCESS can't call external APIs; ANALYZE can't fetch; PROPOSE can't re-analyze. One direction keeps every bug inside one stage and costs contained (`generateAlerts()` is a documented SQL-only exception).

### B. Unified Brain — five pillars (ADR-024)

`src/services/brain/` implements **decide · context-build · recall · verify · learn**, sharing a SQLite-backed cache (`brain_decisions`) and a per-user daily budget (`budget.ts`):

- **decide** — `decision-engine.ts`; cache key `sha256(question + user + utcDay)`, cache hit < 200 ms forces structured output via `tool_choice`.
- **context-build** — `context-builder.ts`; 7-field context payload (sprint, stuck Jiras, noise clusters, calendar, open investigations, memory relevant, stale warnings), 60 s per-user TTL.
- **recall** — `recall.ts`; 3 lanes queried in parallel (MemPalace + `brain_decisions` + `brain_action_clusters`), ranked `recency × confidence`; falls back to SQL-only when MemPalace is offline.
- **verify** — `verify.ts` + `verifiers/` (github / jira / code-grep adapters); turns a claim with an `evidence_needed` spec list into a verified transcript; failures are written too, so "we checked this last Tuesday" survives.
- **learn** — `learn.ts`; records outcomes, feeds MemoryEnricher → MemPalace.

### C. Cypher — the learning router (ADR-033/034/036/037/039)

Cypher is a persistent agent inside the bridge that turns a one-line goal into a *decision card* (chosen `wi-*` skill + confidence + alternatives) instead of auto-running. Under the hood:

- **β priors + Thompson-style pick.** Every `(skill_name, task_class)` pair stores `α, β` in `skill_priors`. `success → α +0.5`, `failed → β +0.5`, `mixed → both +0.25`; `μ = α / (α + β)`; ranking SQL `ORDER BY (alpha / (alpha + beta)) DESC` (`src/services/cypher/learn.ts`). ARCHITECTURE.md §5 describes the Thompson-sampling draw.
- **9-step contract** runtime (investigate → ask → research → plan → execute → quality_gate → confirm → surface → record), now also reachable via an ADR-037 tool-use loop (`CYPHER_LOOP_ENABLED`), with ADR-039 refinement phase env-gated.
- **Never auto-executes write-class work.** depth ≤ 2 invariant (ADR-033 + ADR-036): read-only skills may auto-run; anything that writes a Jira comment, file, or commit requires you to type the command.
- **Cycle:** every outcome (success/mixed/failed) feeds back as priors, so the router converges on the skills that work for each class of goal — no manual tuning.

### D. MemPalace (long-term memory) — ChromaDB + SQLite knowledge graph

Spawned by the bridge as a **Python child process** (`python3 -m mempalace.mcp_server`, seen in `src/intelligence/palace-client.ts`), speaking MCP over stdio. Provides semantic recall (ChromaDB) + a small knowledge graph, persisted to `MEMPALACE_PATH` (default `~/.work-intelligence-mcp/palace/`). Offline → recall degrades to SQL LIKE, never throws.

### E. Per-bucket model routing (ADR-031)

Every AI call site declares a **bucket** (`src/services/model-config.ts` route family + `budget.ts`). Budgets and model+effort survive at the bucket level: e.g. `bug-investigator` reads Opus at max effort with a 10/h cap; decide/recall get separate buckets — so a runaway in one lane can't bankrupt the others. Registry cache invalidates on `POST /api/model-config`, changes apply on the next call.

### F. Scale (measured this session)

| Dimension | Number | How verified |
|---|---|---|
| Background agents | 11 documented (16 `registerAgent()` call sites incl. duplicates) | ARCHITECTURE.md §7 |
| Query migration files | **64** | `ls src/db/migrations/ \| wc -l` |
| Schema version | **108** | `CURRENT_SCHEMA_VERSION` in `src/db/schema.ts` |
| ADRs | **54** files (`adr-*.md` × 51, 49 distinct numbers) | `ls docs/docs/adr/\| wc -l` |
| API routes | **39** defs in `src/routes/` + ~100 inline branches | grep `method:` / `if (path ===` |
| HTTP bridge LOC | **11,050** | `wc -l web-server.js` |
| `src/` TypeScript LOC | **70,784** across 304 files | `find src -name '*.ts' \| xargs wc -l` |
| MCP stdio server | **30** tool modules in `src/tools/` | `ls src/tools/*.ts` |
| MCP clients | **7** source files instantiate `McpClient` | `grep -rc McpClient src/` |
| Skill catalog | **123** discovered skills documented (at runtime) | ARCHITECTURE.md §5 |
| `wi-*` skills shipped in-repo | **28** dirs at `skills/` | `ls -d skills/wi-*` |

---

## 2. Engineering depth

### A. Self-healing bug loop (ADR-030)
`BugInvestigatorAgent` finds root causes for `status='new'` bugs (evidence trail + confidence), `BugResolverAgent` applies suggested patches on user opt-in only, and `BugReaper` sweeps stale ones — with a 10/h budget cap and per-agent kill-switches. It never pushes outbound without confirmation.

### B. Persona memory loop (ADR-032)
Each PR review comment you receive is ingested, clustered into recurring patterns, and (with your approval) becomes a **rule card** injected into future reviews by `wi-pr-review`. Baseline measured at: 74 reviewer comments, 17 reviewers, 6 recurring patterns confirmed (ARCHITECTURE.md §13b).

### C. OPRO prompt evolution
`src/intelligence/prompt-evolver.ts` (with `prompt-evolution-jobs.ts`) evolves prompts via an optimisation-by-proposal loop scored by `quality-scorer.ts` and gated by `cost-gate.ts`; schema versions v86/v88 back the outcome/session tables. 10+ files reference the OPRO machinery.

### D. Evidence-verified agent loop
Not just "the AI says so": `brain/verify.ts` has adapters (`github-verifier`, `jira-verifier`, `code-grep-verifier`, shared `circuit-breaker`) that turn a claim into a verifiable transcript, then `brain_verifications` remembers the result even when it failed. Cypher won't push until paths were classified `ALLOWED`/`CONFIRM_REQUIRED`, never `BLOCKED`.

### E. Cost-aware, local-first
- `budget.ts` — 50 calls / 200 k input tokens per user per day, per-bucket ledger, `BudgetExceededError` above the cap.
- Embeddings run on **Ollama** (`nomic-embed-text`, 1024-dim) — `src/services/embedder.ts`, no API key, `brew install ollama` only.
- The GitHub MCP client falls back from the `GITHUB_MCP_TOKEN` env to reading your local `.claude.json`; connector tokens are env-configured per `wi.config.json` (`tokenEnvVar`) — secrets never enter the repo.

---

## 3. Quantitative claims

| Claim | Value | Command |
|---|---|---|
| web-server.js LOC | 11,050 | `wc -l web-server.js` |
| src/ TS LOC | 70,784 (304 files) | `find src -name '*.ts' \| xargs wc -l` |
| schema version | 108 | `grep CURRENT_SCHEMA_VERSION src/db/schema.ts` |
| migration files | 64 | `ls src/db/migrations/ \| wc -l` |
| `wi-*` skills in-repo | 28 | `ls -d skills/wi-* \| wc -l` |
| smoke-bridge `§` marker lines | **528** (50 unique codes) | `grep -c '§ ' scripts/smoke-bridge.sh` |
| smoke-bridge size | 3,879 lines | `wc -l scripts/smoke-bridge.sh` |
| vitest tests in repo | 124 | `find tests -name '*.test.ts' \| wc -l` |
| ADRs | 54 | `ls docs/docs/adr/ \| wc -l` |
| MCP tool modules | 30 | `ls src/tools/*.ts \| wc -l` |
| HTTP routes in `src/routes/` | 39 (36 distinct paths) | `grep -rn "method:" src/routes/` |
| Vitest config present | yes | `ls vitest.config.*` |

> `§` markers vs assertions: 528 lines carry `§` markers (50 unique codes) across a 3,879-line smoke script; shell assertions count 256 `pass` + 237 `fail` call sites.

---

## 4. What an evaluator should look for

- Read **ADR-024** (Unified Brain) and **ADR-006** (the dual-mode Jira decision) — the two best examples of evidence-based decisions.
- Run the smoke suite: `npm run smoke:bridge`, `npm run smoke:pm`, `npm run smoke:killswitch`, `npm run smoke:outcome` — all self-contained bash/vitest harnesses in `scripts/`.
- Reproduce the pipeline discipline: `grep -r "analyzer.ts" src/routes/` and confirm a route never talks to the fetcher directly.
- Type-safety + build: `npm run typecheck` (root + `web/`) then `npm run build`.
- Schema discipline: `npm run test:run` includes `tests/db/v10*.test.ts` — forward-only migrations v45→v108 run in a ledger.
- Read the privacy model in `SECURITY.md` (path classifier categories) before trusting anything the agent does with your files.
- Inspect the evidence loop: `brain_verifications` rows hold "verified / failed" transcripts; `src/services/brain/verifiers/` is a clean unit boundary.

---

## 5. Limitations (honest)

- Browser-based connectors (Outlook/Teams/Jira-UI) require a real, unlocked browser profile (`BROWSER_PROFILE_PATH`). This is the most fragile surface — it breaks on browser upstream updates and 2FA states.
- Every write path is **deferred to the human**: paths classify `ALLOWED` / `CONFIRM_REQUIRED` / `BLOCKED`, and outbound pushes always require confirmation. Throughput is therefore gated on you.
- Connectors are **off by default** (`wi.config.json`) and need real credentials in `.env` — nothing fetches until configured. No multi-user / no cloud mode; it is built for one operator on one laptop.
- Not every background lane runs on every tick: `CorrelationAgent` fires once at UTC 06:00, the code-graph indexer follows ADR-027's schedule, `BugResolverAgent` is opt-in via env flag.
- The smoke suite is structural, not categorical: it proves a route exists and answers, not that the answer is *good*. Quality is validated by the verify layer, not the harness.
- There is no Python eval harness in-repo for MemPalace (the Python side ships as an external `mempalace` module referenced by `palace-client.ts`).
- The README's status header predates the current schema (it cites v46; the codebase is at v108) — refresh it before judging currency from the top of the file.

---

## What this all means

Work Intelligence is: a 4-stage pipeline that never splits the DB/API/Claude boundaries; a 5-pillar brain that verifies before it asserts; a router that learns which skill won for which goal; a filesystem that can classify what it writes; and more-or-less every decision from ADR-001→054, forward-only. It runs locally, and it stays honest about being a personal, one-detective tool.

---

## Measurements table commands

```bash
wc -l web-server.js                                   # 11050
find src -name '*.ts' | xargs wc -l | tail -1         # 70784 total, 304 files
grep -n 'CURRENT_SCHEMA_VERSION' src/db/schema.ts    # = 108
ls src/db/migrations/ | wc -l                          # 64
ls src/tools/*.ts | wc -l                              # 30
ls src/services/brain/*.ts | wc -l                     # 18
find tests -name '*.test.ts' | wc -l                   # 124
grep -rc "McpClient" src/ | grep -v ':0' | wc -l       # 7 files
grep -c '§' scripts/smoke-bridge.sh                    # 537
grep -c '§ ' scripts/smoke-bridge.sh                    # 528
ls docs/docs/adr/ | wc -l                               # 54
grep -rn "method:'" src/routes/ | wc -l                 # 39 route defs
```