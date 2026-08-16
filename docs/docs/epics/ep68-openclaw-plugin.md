---
id: ep68-openclaw-plugin
title: "EP-68 — OpenClaw Plugin"
---

# EP-68: OpenClaw work-intelligence Plugin

| Field | Value |
|-------|-------|
| Sprint | Sprint 17 |
| Status | ✅ Done |
| ADR | [ADR-023](../adr/adr-023-openclaw-plugin.md) |
| Schema | none (no new migrations) |
| Depends On | EP-58 ✅ (Universal Memory Writer) |
| Effort | 10 waves ~2 days |
| New Dependencies | none (devDependencies only) |

---

## Problem

Every `wi-*` skill and REST endpoint requires manual invocation. Investigation results sit in SQLite until the user polls the UI. Morning briefs require the user to open a browser. There is no mechanism to push findings proactively or close the loop autonomously — save notes to ticket, escalate uncertain investigations, re-run if root cause is unclear.

The work intelligence second brain is passive: it answers when asked but never acts on its own.

**Impact**: High-value signals (completed investigation, stuck ticket, morning brief) go unnoticed until the user remembers to check. The full Trigger → Act → Update Memory → Summarize → Observe → Report → Act → Loop cycle requires manual intervention at every step.

---

## Solution

An OpenClaw plugin turns the bridge into an always-on agent loop. The plugin is a thin TypeScript client — no new server logic, no schema changes — that wires the 50+ existing bridge endpoints into OpenClaw's five lifecycle hooks.

### Architecture

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
  │         └── GET :3132/api/action-items + /api/jira/stuck + /api/daily-summary
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

## Wave Plan

| File | Action | Lines | Purpose |
|------|--------|-------|---------|
| `src/openclaw/plugin/index.ts` | NEW | ~30 | Plugin entry point, exports all hooks (68-01) |
| `src/openclaw/plugin/types.ts` | NEW | ~60 | Shared interfaces: BridgeContext, InvestigationState, CircuitBreaker (68-01) |
| `src/openclaw/plugin/config.ts` | NEW | ~40 | Plugin config: bridge URL, channel IDs, TTLs, circuit-breaker thresholds (68-01) |
| `src/openclaw/plugin/bridge-client.ts` | NEW | ~120 | Typed fetch wrapper for all bridge endpoints; circuit breaker; retry logic (68-02) |
| `src/openclaw/plugin/intent-router.ts` | NEW | ~90 | Pattern-match incoming message → endpoint + params (68-03) |
| `src/openclaw/plugin/context-injector.ts` | NEW | ~80 | `before_prompt_build`: fetch + cache action items, stuck, sprint, palace (68-04) |
| `src/openclaw/plugin/channel.ts` | NEW | ~50 | `sendToChannel` wrapper — never throws, warn + no-op on error (68-04) |
| `src/openclaw/plugin/memory-writer.ts` | NEW | ~70 | `tool_result_persist`: save to claude-mem worker + ticket notes (68-05) |
| `src/openclaw/plugin/investigation-poller.ts` | NEW | ~80 | 30s interval poller per key; push report + save notes on completion (68-05) |
| `src/openclaw/plugin/session-closer.ts` | NEW | ~60 | `agent_end`: push summary, start poller if investigation triggered (68-06) |
| `src/openclaw/plugin/gateway-init.ts` | NEW | ~70 | `gateway_start`: cron, slash commands, state reset (68-06) |
| `src/openclaw/plugin/message-handler.ts` | NEW | ~50 | `message_received` hook — calls intent router, dispatches to bridge client (68-07) |
| `src/openclaw/tsconfig.json` | NEW | ~20 | Compile plugin to `dist/openclaw/` separate from main MCP bundle (68-07) |
| `src/openclaw/install.sh` | NEW | ~40 | Copy compiled plugin to `~/.openclaw/extensions/work-intelligence/` (68-08) |
| `tests/openclaw/plugin.test.ts` | NEW | ~200 | Vitest suite: all hooks, circuit breaker, intent router, poller lifecycle (68-09) |
| `docs/docs/adr/adr-023-openclaw-plugin.md` | NEW | ~130 | ADR for plugin architectural decision (68-10) |
| `docs/docs/epics/ep68-openclaw-plugin.md` | NEW | ~170 | This epic document (68-10) |
| `docs/docs/architecture/data-flow.md` | EDIT | +20 | OpenClaw Plugin Loop section (68-10) |
| `docs/sidebars.ts` | EDIT | +2 | ADR-023 + EP-68 sidebar entries (68-10) |

**Verification**: `ls docs/docs/adr/adr-023-openclaw-plugin.md && grep "adr-023-openclaw-plugin\|ep68-openclaw-plugin" docs/sidebars.ts`

---

## Acceptance Criteria

### REQ-68-01: Plugin Installation
- [ ] AC-1: `install.sh` copies `dist/index.js` and `openclaw.plugin.json` to `~/.openclaw/extensions/work-intelligence/`
- [ ] AC-2: `openclaw plugins list` shows `work-intelligence` as enabled after running `install.sh`

### REQ-68-02: Context Injection
- [ ] AC-3: `before_prompt_build` calls `GET /api/action-items`, `GET /api/jira/stuck`, `GET /api/config/sprint` and appends result as system context
- [ ] AC-4: Repeated calls within 60s return cached context without hitting the bridge again

### REQ-68-03: Memory Write
- [ ] AC-5: `tool_result_persist` calls `POST :37777/api/sessions/observations` with tool name, input, and response
- [ ] AC-6: When a Jira key (e.g. PROJ-123) is detected in the tool result, `PUT /api/jira/analysis/:key/notes` is called with the observation

### REQ-68-04: Intent Routing
- [ ] AC-7: Message containing a Jira key + "investigate" routes to `POST /api/jira/investigate`
- [ ] AC-8: Message containing "brief" or "morning" routes to `GET /api/daily-summary`
- [ ] AC-9: Message containing "search" or "find" routes to `POST /api/search-all`
- [ ] AC-10: Message starting with `/` (slash command) is skipped by intent router

### REQ-68-05: Investigation Poller Start
- [ ] AC-11: `agent_end` starts an investigation poller when `investigationTriggeredKey` is set during the session
- [ ] AC-12: Sending a duplicate "investigate PROJ-123" does not create a second poller for the same key

### REQ-68-06: Poller Completion
- [ ] AC-13: Poller pushes formatted investigation report to channel when `status=completed`
- [ ] AC-14: Poller calls `PUT /api/jira/analysis/:key/notes` with root cause on completion

### REQ-68-07: Morning Brief Cron
- [ ] AC-15: `gateway_start` schedules a daily 08:00 cron that calls `GET /api/daily-summary` and pushes to channel
- [ ] AC-16: Second `gateway_start` call cancels the previous cron before registering a new one (no duplicates)

### REQ-68-08: Slash Commands
- [ ] AC-17: `/wi-status` command returns bridge health + palace status
- [ ] AC-18: `/wi-investigate <key>` triggers investigation and starts poller
- [ ] AC-19: `/wi-brief` returns on-demand daily summary
- [ ] AC-20: `/wi-search <query>` runs cross-source search and returns results

### REQ-68-09: Circuit Breaker
- [ ] AC-21: After 3 consecutive bridge call failures, circuit opens and subsequent calls return `null` immediately
- [ ] AC-22: After 30s cooldown, circuit transitions to HALF_OPEN and allows one probe
- [ ] AC-23: Successful probe closes the circuit; failed probe re-opens it for another 30s

### REQ-68-10: Documentation
- [ ] AC-24: `docs/docs/adr/adr-023-openclaw-plugin.md` exists with `sidebar_label`, `Status: Implemented`, architecture diagram
- [ ] AC-25: `docs/docs/epics/ep68-openclaw-plugin.md` exists with `id: ep68-openclaw-plugin`, metadata table, wave plan, acceptance criteria
- [ ] AC-26: `docs/sidebars.ts` contains `adr/adr-023-openclaw-plugin` and `epics/ep68-openclaw-plugin` entries
- [ ] AC-27: `docs/docs/architecture/data-flow.md` contains `## OpenClaw Plugin Layer` section with ASCII diagram
