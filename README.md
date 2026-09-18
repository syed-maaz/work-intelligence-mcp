# Work Intelligence MCP


[![CI](https://img.shields.io/github/actions/workflow/status/syed-maaz/work-intelligence-mcp/ci.yml?branch=main&label=build&logo=github&style=flat-square)](https://github.com/syed-maaz/work-intelligence-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/syed-maaz/work-intelligence-mcp/pulls)

A local-first assistant that watches your Jira / Slack / GitHub and learns which tools actually solve which problems — an agentic loop that grades itself mechanically, no LLM-as-judge. Runs on your machine; your data never leaves it.


> **Watch it think:** the annotated loop trace lives at [`docs/docs/walkthroughs/loop-trace.md`](docs/docs/walkthroughs/loop-trace.md) — generated from the loop's own persisted audit rows (`npm run demo:trace`). A screen recording lands here after the first keyed run; nothing is hand-faked.

## The loop, annotated

One goal in, one verdict out — every step is a row in SQLite, so the loop can be graded mechanically. This is the shape of a run; regenerate it anytime with `npm run demo:trace`, or read the full annotated trace at [`docs/docs/walkthroughs/loop-trace.md`](docs/docs/walkthroughs/loop-trace.md):

```
goal    → "What happened with the PROJ-101 widget rollout on acme/widgets?"
pick    → wi-recall-lanes — eligible: catalog description matches the query
recall  → 9 lanes hit (memory, decisions, people): 3 notes + 2 prior verdicts
execute → 4 tool calls, status=success, 12.4s, ~21k tokens
verdict → success — recorded as a mechanical signal, not an opinion
priors  → (skill, task_class) α/β move only via learn.ts; the loop never grades itself
```

## 60-second quickstart

```bash
git clone <your-fork> work-intelligence-mcp && cd work-intelligence-mcp
npm run setup        # install deps, write .env, validate config
npm run demo         # seed demo data + exercise one recall lane (no credentials needed)
npm run web:bridge   # HTTP bridge on :3132
# Terminal 2:
npm run web:dev      # web UI → http://localhost:5175
```

A stranger goes from clone to a running UI in under 5 minutes — no API keys required (the demo runs fully offline).

## How it works — four systems, one idea

1. **An agentic tool-use loop.** A goal becomes tool calls, and every call is audited row-by-row, so any run is inspectable end-to-end — [see the annotated trace](docs/docs/walkthroughs/loop-trace.md).
2. **Nine-lane memory recall.** One query fans out over notes, decisions, projects, people and more, then fuses the hits into one ranked answer — [see it fire inside the trace](docs/docs/walkthroughs/loop-trace.md).
3. **Learning without an LLM-as-judge.** Outcomes are recorded as mechanical signals (success / failed / mixed), never as "the AI said so" — [see the enforced invariant in `outcomes.ts`](src/services/cypher/outcomes.ts).
4. **SCOPE → EXECUTE refinement.** Hard goals get a refine pass before any tool fires, so the loop plans before it acts — [see the flow](docs/docs/architecture/cypher-scope-phase-flow.md).

## Status — working, measured, local-first

- **Demo works end-to-end, offline:** `npm run setup && npm run demo && npm run web:bridge` — no API key, no Ollama (`WI_EMBED_STUB=1`).
- **Tests:** 1,400+ unit tests plus 500+ structural smoke checks in `scripts/smoke-bridge.sh`.
- **Schema:** v108 — 64 forward-only migrations in `src/db/migrations/`, every one applied in a ledger.
- **Four LLM systems ship today:** the tool-use loop, 9-lane recall, mechanical outcome learning, SCOPE→EXECUTE refinement.
- **Honest limits:** the paid trace run needs a real API key; connectors are off by default and need real credentials.
- **Provenance:** condensed from ~1,272 private commits over ~4 months of daily iteration; original history withheld for org-hygiene.

## Start here

**[`GETTING-STARTED.md`](GETTING-STARTED.md)** — install, run bridge + UI, smoke tests, mental model (read this first).

Want to contribute? Start with **[`CONTRIBUTING.md`](CONTRIBUTING.md)** and the [`good-first-issues`](docs/docs/good-first-issues.md) list.

| If you are… | Read |
|---|---|
| **New to the codebase** | `GETTING-STARTED.md` then `ARCHITECTURE.md` |
| **Adding a feature** | `ROADMAP.md` then `docs/docs/adr/` (the decision ledger) |
| **Fixing a bug** | `tests/` (reproduce first) then `docs/docs/architecture/known-gaps.md` |
| **Operating the system** | `docs/docs/getting-started/` |

The full Docusaurus site:

```bash
npm run docs:install && npm run docs:start
# → http://localhost:3000
```

## Run

```bash
# Terminal 1 — HTTP bridge (port 3132)
npm run web:bridge          # refuses to start if dist/ is older than src/

# Terminal 2 — React UI (port 5175)
npm run web:dev

# Or run the MCP stdio server directly:
npm run dev
```

## Verify before declaring done

```bash
npm run typecheck           # root + cd web && npx tsc --noEmit
npm run build               # refresh dist/ so the bridge picks up TS changes
npm run smoke:bridge        # end-to-end bridge smoke (~1.5 s)
npm run smoke:ui            # Playwright UI smoke (needs web:dev on :5175)
npm run smoke:all           # everything
```

Full protocol: [`CONTRIBUTING.md`](CONTRIBUTING.md#smoke--tests).

Required `.env` (demo defaults — the only mandatory key is Anthropic):

```
ANTHROPIC_API_KEY=sk-ant-...      # required
DATABASE_PATH=./data/intelligence.db   # local SQLite (schema v108)
WI_EMBED_STUB=1                   # demo mode: stub embeddings, no Ollama needed
WI_DEMO_MODE=1                    # UI shows "Demo data — not real" banner
```

The HTTP bridge defaults to port **3132** (`wi.config.json` → `bridge.port`). Full reference: [`docs/docs/getting-started/configuration.md`](docs/docs/getting-started/configuration.md).

## Claude Desktop / Cursor config

```json
{
  "mcpServers": {
    "work-intelligence": {
      "command": "node",
      "args": ["/path/to/work-intelligence-mcp/dist/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "your-key",
        "DATABASE_PATH": "/path/to/data.db"
      }
    }
  }
}
```

## Under the hood (jargon welcome here)

- **ADR-037** — the tool-use loop controller (`src/services/cypher/loop.ts`): posture-gated tool eligibility, per-tool-use audit rows (`cypher_steps`), token/step budgets.
- **RRF** — ranked fusion of the 9 recall lanes (`src/services/brain/recall.ts` + MemPalace), recency × confidence.
- **Beta priors** — `(skill, task_class)` α/β in `skill_priors`; success → α+0.5, failed → β+0.5, mixed → both; the router converges without manual tuning (`src/services/cypher/learn.ts`).
- Everything is forward-only: ADRs 1→54, schema migrations v45→v108, all in ledgers.

## License

MIT — see [LICENSE](LICENSE). No cloud sync, no telemetry, all data local.

<!-- topics: work-intelligence, mcp, llm-agents, rag, agentic-ai, local-first, sqlite, typescript, claude-code, personal-assistant -->