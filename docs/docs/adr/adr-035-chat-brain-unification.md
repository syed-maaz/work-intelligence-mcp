---
sidebar_label: "ADR-035: Chat Brain Unification"
sidebar_position: 35
title: "ADR-035: Chat Brain Unification — One Brain, Many Surfaces"
status: Draft (2026-06-15) — parked until prioritized
date: 2026-06-15
---

# ADR-035: Chat Brain Unification — One Brain, Many Surfaces

**Status:** Draft. **Parked** as of 2026-06-15 — `/api/chat` is not the current priority. This ADR captures the goal so the work is pickup-able later without re-deriving the rationale.

> **NOTE (2026-06-20):** Cypher's tool-use loop pattern in [ADR-037](./adr-037-cypher-tool-use-loop.md) provides the shape this ADR was reaching for — one controller, many tools, one audit trail. Re-examine this ADR after the v2.0 cutover (ADR-037 Phase 6) ships and earns evidence; the answer may be "fold into ADR-037" rather than ship a separate brain-unification.

**Cypher session:** `cyp_0bc448f80009`
**Bookmark / handoff:** [`.planning/phases/85-chat-brain-unification/BRAINSTORM.md`](../../../.planning/phases/85-chat-brain-unification/BRAINSTORM.md)
**Related:** [ADR-024](./adr-024-unified-brain.md), [ADR-033](./adr-033-cypher-framework.md), [ADR-034](./adr-034-cypher-learning-autonomy-engine.md)

---

## The principle (load-bearing)

**One brain. Many surfaces.**

The code that decides "what to do with this user goal" must be the same code on every surface — `/wi`, `/api/chat`, `/api/wi/dispatch`, the WI-MCP `wi_dispatch` tool, and any future Atlas/n8n caller. Surfaces differ only in how they render the brain's decision and what they do with it.

## What's broken today

`/api/chat` has its own bespoke pipeline:
- Heuristic mode detector (`src/services/chat/mode-detect.ts`)
- Always-on 7-source retrieval fan-out (FTS, embeddings, brain, palace search, KG, graph, code)
- Fusion ranker (`src/tools/context-ranker.ts`)
- `analyzer.chatWithContext()` LLM call

Cypher (`src/services/cypher/run.ts`) has its own — clarification, skill ranking via Beta priors, the 9-step contract, outcome capture. **The two pipelines share no code.**

The "what do I need to do tomorrow" bug on 2026-06-14 was a symptom: the heuristic detector returned a canned reply without ever calling the LLM. Commit `0b7c3e1` (`WORK_CONTEXT_WORDS`) fixed *that sentence* — the architecture split that produced the symptom is unchanged.

## Decision

**Deferred.** Will be filled in when this work is picked up. See BRAINSTORM bookmark for the open questions that need to land first.

## Consequences

**Deferred.** Anticipated shape: legacy `mode-detect.ts` retires; chat handler shrinks to a thin Cypher caller; persona injection stays orthogonal; retrieval sources get repurposed as Cypher-invokable skills; ChatPanel renders Cypher's structured response.

## When this gets picked up

The bookmark file (`.planning/phases/85-chat-brain-unification/BRAINSTORM.md`) is the single entry point. It lists the files to read first, the open questions to settle, and the rough first slice (shadow mode → cutover). When work begins:

1. Settle the open questions in BRAINSTORM → fill in this ADR's Decision section → promote Status: Draft → Proposed
2. Write `PLAN.md` for the phase → promote ADR Proposed → Accepted
3. Open a fresh Cypher session and execute

Until then, this doc exists only so the goal isn't lost.

## References

- `web-server.js` `/api/chat` handler (~lines 4838–5500)
- `src/services/chat/mode-detect.ts`
- `src/services/cypher/run.ts`
- Commit `0b7c3e1` — the work-context vocab band-aid that proved the split
