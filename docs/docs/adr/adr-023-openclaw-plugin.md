---
sidebar_label: "ADR-023: OpenClaw Plugin"
sidebar_position: 23
---

# ADR-023: OpenClaw work-intelligence Plugin

**Date**: 2026-05-17
**Deciders**: Maaz
**Epics**: EP-68
**Supersedes**: —

---

## Context

The work-intelligence-mcp bridge (port 3132) exposes 50+ REST endpoints covering Jira investigation, Teams search, daily digest, action items, and MemPalace knowledge. These are accessible from the web UI and Claude Code skills, but require the user to manually invoke them. There is no always-on loop that autonomously triggers investigation, pushes summaries, or monitors ongoing work without user initiation.

OpenClaw is a personal AI agent gateway that runs as a persistent daemon, routes messages from Telegram/Slack/Discord through lifecycle hooks, and supports TypeScript plugins. A plugin can intercept every agent turn (`before_prompt_build`), every tool result (`tool_result_persist`), every message received (`message_received`), and every session end (`agent_end`). This creates a natural bridge for an autonomous Trigger → Act → Update Memory → Summarize → Observe → Report → Act → Loop.

The combination of an always-on gateway (OpenClaw) with a persistent intelligence store (work-intelligence bridge) enables proactive delivery of investigation results, morning briefs, and sprint context — without modifying any existing server code.

---

## Decision

Build a `work-intelligence` OpenClaw plugin at `src/openclaw/plugin/` that wires the bridge REST API into OpenClaw's five lifecycle hooks. The plugin is a pure TypeScript client — no new server-side logic, no schema changes. All intelligence remains in the existing bridge endpoints.

---

## Architecture

```
Messaging Channel (Telegram/Slack/Discord)
        │  user message
        ▼
OpenClaw Gateway
  ├── message_received → WI Intent Router
  │         ├── "investigate PROJ-123" → POST :3132/api/jira/investigate (202)
  │         ├── "morning brief"       → GET  :3132/api/daily-summary
  │         ├── "search <query>"      → POST :3132/api/search-all
  │         └── "status"              → GET  :3132/api/status
  │
  ├── before_prompt_build → Context Injector
  │         └── GET :3132/api/action-items + /api/jira/stuck + /api/config/sprint
  │             (60s TTL cache, appendSystemContext)
  │
  ├── tool_result_persist → Memory Writer
  │         ├── POST :37777/api/sessions/observations   (claude-mem worker)
  │         └── PUT  :3132/api/jira/analysis/:key/notes (if Jira key detected)
  │
  ├── agent_end → Investigation Poller Starter + Summarizer
  │         └── if investigationTriggered: start 30s poll loop on
  │             GET :3132/api/jira/investigation/:key
  │             → when status=completed: sendToChannel(report)
  │             → PUT :3132/api/jira/analysis/:key/notes
  │
  └── gateway_start → Cron Scheduler + Command Registration
            ├── setInterval(08:00 daily) → GET :3132/api/daily-summary → sendToChannel
            └── registerCommand × 4: /wi-status, /wi-investigate, /wi-brief, /wi-search
```

---

## Implementation

Five hooks + one poller implement the full always-on loop:

1. **`before_prompt_build`** (`context-injector.ts`) — Fires before every agent LLM turn. Calls `GET /api/action-items`, `GET /api/jira/stuck`, and `GET /api/config/sprint` in parallel, serializes results as markdown, and calls `appendSystemContext`. A 60s TTL cache ensures at most one batch of bridge calls per minute across a multi-turn conversation.

2. **`tool_result_persist`** (`memory-writer.ts`) — Fires after every tool result. Extracts any Jira key from the result text; if found, calls `PUT /api/jira/analysis/:key/notes` to save the observation as ticket notes. Always forwards the raw tool result to the claude-mem worker at port 37777.

3. **`message_received`** (`message-handler.ts` + `intent-router.ts`) — Fires for every incoming message. Intent router pattern-matches: `investigate` + Jira key → `POST /api/jira/investigate`; `brief`/`morning` → `GET /api/daily-summary`; `search`/`find` → `POST /api/search-all`; `status` → `GET /api/status`. Slash commands (starts with `/`) are skipped — handled by `registerCommand`.

4. **`agent_end`** (`session-closer.ts`) — Fires when the agent session completes. If an investigation was triggered during the session, starts the investigation poller. Pushes a session summary to the configured channel.

5. **`gateway_start`** (`gateway-init.ts`) — Fires once on daemon start/restart. Resets all module state (circuit breakers, caches, active poller handles). Registers the 08:00 morning brief cron. Registers four slash commands.

6. **Investigation poller** (`investigation-poller.ts`) — 30s interval per active investigation key. Calls `GET /api/jira/investigation/:key`. On `status=completed`: pushes formatted report to channel and calls `PUT /api/jira/analysis/:key/notes`. Treats 404 as "not yet visible" (up to 3 consecutive 404s before giving up).

---

## Implementation Status

All 13 components shipped as part of EP-68 (Sprint 18, 2026-05-17). The plugin is a pure TypeScript client — 10 source files under `src/openclaw/plugin/src/` — with no server-side changes; all intelligence lives in the existing bridge endpoints.

| Component | Status | Notes |
|-----------|--------|-------|
| `before_prompt_build` hook | ✅ Shipped | `context-cache.ts`, 60s TTL cache, calls `/api/brain/context` (unified) |
| `tool_result_persist` hook | ✅ Shipped | `memory-writer.ts`, PUT notes + worker POST to port 37777 |
| `message_received` hook | ✅ Shipped | `intent-router.ts`, pattern-match dispatch for 4 intent types |
| `agent_end` hook | ✅ Shipped | `investigation-poller.ts`, starts 30s poll loop per active key |
| `gateway_start` hook | ✅ Shipped | `gateway.ts`, cron + slash commands + module state reset |
| Circuit breaker (bridge) | ✅ Shipped | 3 failures → 30s open window, module-level state in `bridge-client.ts` |
| Circuit breaker (worker) | ✅ Shipped | Separate breaker state from bridge circuit in `memory-writer.ts` |
| Investigation poller | ✅ Shipped | `investigation-poller.ts`, 30s interval, dedup by key, 10min max (20 cycles) |
| Morning brief cron | ✅ Shipped | 08:00 daily, handle stored as `_morningBriefTimer` in `gateway.ts` |
| `/wi-status` command | ✅ Shipped | Bridge health + palace status via `wi-tools.ts` |
| `/wi-investigate` command | ✅ Shipped | Trigger investigation + start poller |
| `/wi-brief` command | ✅ Shipped | On-demand morning brief |
| `/wi-search` command | ✅ Shipped | Cross-source search + push top results |

### EP-68 — What was built

The plugin registers itself via the standard OpenClaw `register(api)` entry point (`src/index.ts`) and wires five lifecycle hooks plus four slash commands. At daemon start, `gateway.ts` resets all module-level state (circuit breakers, caches, active poller handles), schedules the 08:00 morning brief cron, and registers slash commands with OpenClaw's command registry.

The **context injector** (`context-cache.ts`) fires on every agent LLM turn. It calls `GET /api/brain/context` (the unified Unified Brain endpoint, consolidated from the original three-endpoint fan-out), serializes the response as markdown, and injects it via `appendSystemContext`. A 60s TTL cache keyed by session ID limits bridge calls to at most one per minute across multi-turn conversations.

The **memory writer** (`memory-writer.ts`) fires after every tool result. It extracts any Jira issue key from the result text via regex; if found, calls `PUT /api/jira/analysis/:key/notes` to persist the observation as ticket notes. Every tool result is also forwarded to the claude-mem worker at port 37777. Two independent circuit breakers prevent a downed bridge or worker from cascading into hook failures.

The **intent router** (`intent-router.ts`) fires for every incoming message. It pattern-matches four intents: `investigate` + Jira key → `POST /api/jira/investigate`; `brief`/`morning` → `GET /api/daily-summary`; `search`/`find` → `POST /api/search-all`; `status` → `GET /api/status`. Messages starting with `/` are skipped — they are handled by the registered slash command chain.

The **investigation poller** (`investigation-poller.ts`) is started by the `agent_end` hook when an investigation was triggered during the session. It polls `GET /api/jira/investigation/:key` every 30s. On `status=completed`, it pushes the formatted report to the channel and writes notes back to the ticket. Three consecutive 404s are treated as "investigation not yet visible" before giving up. Maximum duration is 10 minutes (20 × 30s cycles).

**Deviation:** Phase 69 (Unified Brain API) later consolidated the three `before_prompt_build` endpoint calls (`/api/action-items`, `/api/jira/stuck`, `/api/config/sprint`) into a single `GET /api/brain/context` call. `context-cache.ts` was updated to use the unified endpoint. The architecture diagram in this ADR still shows the three-endpoint fan-out as originally specced; the `GET /api/brain/context` consolidation is documented in ADR-024.

### Known Gaps

- **MemPalace drawer injection unimplemented** — The Consequences section notes that `before_prompt_build` can inject MemPalace drawer content when `connected: true`. This enrichment path (`GET /api/palace/context`) is not implemented in `context-cache.ts`. The hook currently only injects bridge context. Tracked for a follow-on epic.
- **Slash command CLI vs. gateway dispatch** — `openclaw agent --message` (one-shot CLI mode) is stateless and may not resolve slash commands through `handlePluginCommand`. The gateway dispatch path (Web UI / TUI) reliably matches commands. Users running one-shot CLI mode should use natural-language intent phrasing instead of slash commands.
- **No slash command for `tool_result_persist` bypass** — There is no way to disable memory writing per-session without restarting the daemon. Tracked for v1.1.

### Runtime Verification (2026-05-17)

UAT executed end-to-end against running OpenClaw gateway (port 18789) and bridge (port 3132). All 10 UAT tests pass.

**Provider configuration:**
- Default model: `anthropic/claude-opus-4-7`
- Fallback: `anthropic/claude-opus-4-6`

**Resolved blocker:** OpenClaw's OpenAI provider hard-requires the **Responses API** (`POST /v1/responses`), which the  AI Core / Hai proxy does **not** support (`"Subpath 'responses' is not allowed for model 'gpt-4.1'"`). The Anthropic Messages API (`POST /v1/messages`) is fully supported by the same proxy at `/anthropic`, so we configured the `anthropic` provider in `~/.openclaw/openclaw.json` and switched the default model. No plugin code changes required.

**Verified slash command results:**
- `/wi-status` → renders bridge + palace status with metrics
- `/wi-investigate PROJ-15257` → Jira fields, root cause, timeline; poller starts
- `/wi-brief` → daily summary markdown
- `/wi-search <query>` → cross-source results

CLI one-shot (`openclaw agent --message`) is stateless and may treat slash commands as text; the **gateway dispatch path** (Web UI / TUI) reliably matches commands via `handlePluginCommand` (first in chain).

---

## Synthesis Rules / Dispatch Table

| Hook | Trigger | Action | Bridge Endpoint |
|------|---------|--------|----------------|
| `message_received` | Incoming message with Jira key + "investigate" | POST investigation, store key for agent_end | `POST /api/jira/investigate` |
| `before_prompt_build` | Every agent turn | Inject action items + stuck issues + sprint state | `GET /api/action-items`, `GET /api/jira/stuck`, `GET /api/config/sprint` |
| `tool_result_persist` | After every tool result | Save observation + ticket notes if Jira key in result | `POST :37777/api/sessions/observations`, `PUT /api/jira/analysis/:key/notes` |
| `agent_end` | Session ends | Push summary, start investigation poller | `GET /api/jira/investigation/:key` (poller) |
| `gateway_start` | Daemon start/restart | Reset state, register cron + slash commands | `GET /api/daily-summary` (cron), none for registration |

---

## Alternatives Considered

**Native Claude Code skill loop** — Claude Code skills can call bridge endpoints directly, but require user initiation per invocation. No persistent daemon means no proactive delivery (morning briefs, investigation push). Rejected: no always-on capability.

**Webhook + cron server** — A standalone Node.js cron service could call the bridge on a schedule and POST to a messaging channel. Viable for scheduled briefs but has no access to agent lifecycle hooks (`before_prompt_build`, `tool_result_persist`). Rejected: cannot inject sprint context into every LLM turn.

**Modifying web-server.js to push notifications** — Adding push logic directly to the bridge would couple transport concerns (Telegram/Slack delivery) to the intelligence layer. Rejected: violates the four-stage pipeline constraint; bridge is Propose-only.

**OpenClaw chosen** because it provides both lifecycle hooks and persistent daemon semantics in a single install, with no required changes to existing server code.

---

## Consequences

**Good**
- Always-on loop without modifying any existing server code or schema
- Graceful degradation: circuit breaker drops calls silently after 3 failures; bridge outage does not crash OpenClaw
- Morning brief delivered proactively at 08:00 without user action
- Investigation results pushed to channel automatically when complete — no need to poll the UI
- Slash commands provide escape hatch for manual invocation from any connected channel
- MemPalace drawer injection is conditional on `connected: true` — runs cleanly when palace is absent. **Note:** the `GET /api/palace/context` enrichment path is not yet implemented in `context-cache.ts`; see Known Gaps in Implementation Status above.

**Trade-offs**
- Bridge must be running for any hook to function — if the bridge is down, all hooks are no-ops
- OpenClaw must be installed (`npm install -g openclaw`) before plugin registration — additional setup step
- 30s investigation poller creates a background handle per active investigation — long investigations accumulate handles until completion or timeout
- Two circuit breakers (bridge + worker) add module state that must be explicitly reset on `gateway_start`

---

## Related

- [EP-68: OpenClaw work-intelligence Plugin](../epics/ep68-openclaw-plugin.md)
- [ADR-017: Always-On Agent Architecture](./adr-017-always-on-agent-architecture.md)
- [ADR-022: Dual-Engine Investigation](./adr-022-dual-engine-investigation.md)
