# Architecture

Work Intelligence MCP is one loop with four LLM systems inside it. Read §1–§4 first — that is
the whole idea. Pipeline, schema, and connectors (§5–§7) are the plumbing that feeds it.

Diagram: [`docs/diagrams/wi-dispatch-flow-v2.drawio`](docs/diagrams/wi-dispatch-flow-v2.drawio)
(goal → loop → tools → recall → verdict → prior update).

## §1 Agentic tool-use loop

The loop turns one goal into tool calls. Every call is persisted as a row in `cypher_steps`
(stage, status, payload, tokens, duration, reasoning trace), so any run is replayable and
auditable end-to-end. Tool eligibility is **posture-gated**: the catalog
(`src/services/cypher/skills.ts`) exposes only the tools the current posture allows, and the
model picks from that surface. Entry point: `src/services/cypher/loop.ts`. See the annotated
walkthrough at `docs/docs/walkthroughs/loop-trace.md`.

## §2 Nine-lane memory recall

Before the loop acts it can ask memory. One query fans out over nine lanes (notes, decisions,
projects, people, bugs, prompts, skills, external observations, tasks) in parallel and fuses
the hits with ranked fusion — recency × confidence — into a single answer. Implementation:
`src/services/brain/recall.ts` plus the MemPalace child process (ChromaDB + SQLite knowledge
graph, spawned by `src/intelligence/palace-client.ts`). Offline, recall degrades to SQL LIKE
and never throws.

## §3 Learning without an LLM-as-judge

The loop grades itself **mechanically, or not at all**. Outcomes are written as
success/failed/mixed signals to `cypher_outcomes`; `(skill, task_class)` priors in
`skill_priors` move only in `src/services/cypher/learn.ts` — the loop never writes its own
score, and no model is ever asked "did I do well?". This is the enforced no-LLM invariant;
see `src/services/cypher/outcomes.ts`.

## §4 SCOPE → EXECUTE refinement

Hard goals get a refinement pass (SCOPE) before any tool fires: the goal is decomposed into
an executable plan, then the loop executes it tool-by-tool (EXECUTE). Easy goals skip the
pass and go straight to execute. Flow: `docs/docs/architecture/cypher-scope-phase-flow.md`.

## §5 Data pipeline (the hard contracts)

Every piece of work data flows through exactly four stages, and no stage may be merged or
skipped:

```
FETCH ──► PROCESS ──► ANALYZE ──► PROPOSE
 pull raw  normalize   interpret   surface via
 from      dedupe,     stored      tool / UI /
 connectors upsert,    data        SSE
            embed
```

Each stage forbids one abuse: FETCH cannot call the model API or write the DB; PROCESS cannot
call external APIs; ANALYZE cannot fetch; PROPOSE cannot re-analyze. One direction keeps bugs
inside one stage and keeps cost bounded. See `src/fetcher/` and `src/services/analyzer.ts`.

## §6 Schema

SQLite, forward-only, **v108** — 64 migrations in `src/db/migrations/` (v45→v108), every one
applied in a ledger with recorded timestamps. `CURRENT_SCHEMA_VERSION` in
`src/db/schema.ts`. The bridge refuses to run a schema it doesn't understand.

## §7 Connectors

Connectors are self-describing `ConnectorAdapter` objects (`src/fetcher/sources/adapter.ts`).
The registry dispatches purely off the `ADAPTERS` array — no switch statements. Each adapter
declares its modes, capabilities, required env vars, and the data it ingests; manifest parity
with `capabilities.json` is enforced by `tests/connectors/registry.test.ts`. Jira, GitHub,
Slack, Linear, Teams, Outlook are declared; all are off by default until configured in
`wi.config.json` + `.env`.

## What is deliberately not here

- No cloud, no telemetry, no multi-operator mode — one operator, one laptop.
- No secrets in the repo: every credential is an env var, resolved via the three config
  layers (defaults → `.env` → MCP client env), see `src/services/config.ts`.