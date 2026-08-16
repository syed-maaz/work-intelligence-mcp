---
id: ep64-orchestrator-agent
title: EP-64 — OrchestratorAgent (Multi-Step Reasoning)
---

# EP-64 — OrchestratorAgent (Multi-Step Reasoning)

| Field | Value |
|-------|-------|
| Sprint | Sprint 17 |
| Status | ✅ Done (2026-05-04) |
| ADR | [ADR-017](../adr/adr-017-always-on-agent-architecture) |
| Schema | None |
| Depends On | EP-63 ✅ |
| Effort | 1 wave |

## Problem

Future agents (CorrelationAgent, investigation agents) need multi-step reasoning with tool use. The Anthropic Managed Agent Sessions SDK was not available in the pinned SDK v0.32.1, so a reusable agent pattern was needed.

## Solution

Build OrchestratorAgent — a generic tool_use loop agent that takes a goal + available tools, runs Claude in a loop (max 10 iterations), and returns structured results. TDD test suite written first.

## Success Criteria

- [x] OrchestratorAgent class with configurable goal and tools
- [x] Tool_use loop with max 10 iterations safety guard
- [x] Token usage tracked via `recordTokenUsage()`
- [x] System prompt cached with `cache_control: { type: 'ephemeral' }`
- [x] TDD test suite (RED phase committed separately)
- [x] Tests cover: tool dispatch, multi-step reasoning, max-iteration guard, error handling, token tracking
- [x] Model defaults to Haiku for cost efficiency
- [x] Reusable as building block for CorrelationAgent

## Delivery Notes

**Completed**: Sprint 17 (2026-05-04)

### Key Implementations

| File | What was delivered |
|------|-------------------|
| `src/intelligence/orchestrator-agent.ts` | Generic agent class: takes goal + `PromptCachingBetaTool[]`, runs `client.beta.promptCaching.messages.create()` in a loop until `stop_reason !== 'tool_use'` or max iterations (10). Dispatches tool calls to registered handlers. Returns structured results. |
| `tests/orchestrator-agent.test.ts` | Full TDD suite — tool dispatch, multi-step chains, iteration guard, error propagation, token accounting. |
| `src/services/analyzer.ts` | AIAnalyzer proxy pattern — OrchestratorAgent wraps existing SDK client. Token usage flows through `recordTokenUsage()`. |

### Design Decisions

1. **Tool_use loop pattern** — matches Anthropic's recommended agentic architecture
2. **Max 10 iterations** — safety guard prevents runaway loops
3. **Haiku default model** — cost-efficient for autonomous background processing
4. **TDD approach** — tests written before implementation, RED committed separately
5. **`PromptCachingBetaTool` type** — uses SDK 0.32.1 beta namespace for cache support
