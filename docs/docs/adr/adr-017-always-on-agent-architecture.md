---
sidebar_position: 17
status: Implemented
date: 2026-05-02
deciders: Syed Maaz
supersedes: ~
related: adr-016-second-brain-architecture.md
---

# ADR-017: Always-On Agent Architecture

**Status:** Implemented (EP-61–65 ✅, Sprint 17 — 2026-05-04)  
**Date:** 2026-05-02  
**Deciders:** Syed Maaz  
**Supersedes:** None  
**Related:** [ADR-016](./adr-016-second-brain-architecture.md)

---

## Context

As of Sprint 16, work-intelligence-mcp has a complete Second Brain (MemPalace), recall-augmented chat, and autonomous memory growth. The system is intelligent but entirely passive — it responds to requests on a 15-minute polling tick and never initiates.

Three gaps remain:

1. **Self-learning loop is broken**: `KnowledgeIndexer.extractAndSaveBugPattern()` is implemented but never called after investigations complete. Every investigation loses its learned pattern. (Missing wire-up after `completeInvestigation()` in `investigation-orchestrator.ts`.)
2. **No proactive agent**: System cannot initiate a meeting brief, score an incoming alert for severity, or surface correlations across topics without being asked.
3. **Sprint config is hardcoded**: `Saturn-93` sprint name and date range are hardcoded in `web-server.js`.

The architecture research session (2026-05-02) identified an event-driven managed agent sessions pattern as the right target: agents stay idle until a signal arrives, process it, and return to idle — no cold-start cost and persistent thread history.

---

## Decision

Evolve the system from request/response + 15-min polling to **event-driven agent sessions** in three waves.

### Agent Topology

```
OrchestratorAgent (coordinator, declares callable_agents at creation)
  └─ TopicRouterAgent     (Haiku)  — routes events to topic context
  └─ AlertScorerAgent     (Haiku)  — severity-scores new messages
  └─ MeetingPrepAgent     (Haiku)  — T-60min pre-meeting brief (Haiku for cost; upgrade to Sonnet if quality insufficient)
  └─ LearningAgent        (Haiku)  — calls extractAndSaveBugPattern() post-investigation
  └─ InvestigationAgent   (existing ReAct engine)
```

**Constraint**: All subagent calls route through OrchestratorAgent. One level of nesting only.

### New Infrastructure

#### `changes_log` table (CDC)

```sql
CREATE TABLE changes_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id     INTEGER NOT NULL,
  operation  TEXT NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

SQLite `AFTER INSERT` / `AFTER UPDATE` triggers on `messages`, `jira_issues`, and `calendar_events` write rows here. `ChangeWatcher` polls every 100ms.

#### `proactive_queue` table

```sql
CREATE TABLE proactive_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT NOT NULL,
  payload     TEXT NOT NULL,  -- JSON with {title, body, action_url?}
  source_id   TEXT,           -- dedup key (e.g. meeting event id)
  type        TEXT,           -- 'meeting-prep' | 'alert' | 'nightly_digest'
  read_at     DATETIME,       -- NULL = unread; set on SSE drain
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Agents write user notifications here. The HTTP bridge drains unread rows and pushes them to the chat SSE stream. All agent payloads must use `{title, body, action_url?}` shape — drain maps directly to this.

#### `sprint_config` table

```sql
CREATE TABLE sprint_config (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sprint_name TEXT NOT NULL,
  project_key TEXT NOT NULL,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  active      INTEGER DEFAULT 1
);
```

Replaces hardcoded sprint name and date range in `web-server.js`. New endpoint: `PUT /api/config/sprint`.

#### `GET /api/events` SSE endpoint

Replaces the 3-second polling interval in `ChatPanel`. The bridge opens an SSE stream, drains `proactive_queue` on a 2s tick (LIMIT 20/tick), and pushes agent notifications as server-sent events. On DB error during drain, the tick is skipped and the connection stays alive.

### Build Waves

#### Wave 1 — Quick Wins (EP-61, EP-62) — Days

No new external dependencies or services — all additions are in-process SQLite tables and endpoints:

- Wire `extractAndSaveBugPattern()` after `completeInvestigation()` (1-line fix — self-learning broken since Sprint 12)
- Add `proactive_queue` table + `GET /api/events` SSE endpoint
- `MeetingPrepAgent` as a scheduled check (reuses existing `/api/calendar/events/:id/context`)
- Move sprint boundary to `sprint_config` DB table + `PUT /api/config/sprint`
- Fix WR-01/02/03 from 58-REVIEW.md (MaxListenersExceededWarning, Python process leak, duplicate assistant message)

#### Wave 2 — CDC Pipeline (EP-63) — Week

- `changes_log` table + SQLite triggers on messages/jira/calendar writes
- `ChangeWatcher` service (`src/services/change-watcher.ts`) — 100ms poll, typed event dispatch
- `AlertScorerAgent` (Haiku) — subscribes to new-message events, scores severity, writes to `proactive_queue`

#### Wave 3 — Agent Sessions (EP-64, EP-65) — Weeks

Implement OrchestratorAgent using standard `tool_use` dispatch loop — Anthropic Managed Agent Sessions were not available in SDK v0.32.1 at implementation time. Sub-agents declared as tool definitions at class level achieve the same topology and cold-start elimination. Full migration to Managed Sessions deferred; revisit when SDK exposes the API.

- `CorrelationAgent` — nightly KG traversal, cross-topic co-mention scoring, proactive digest generation
- Full `OrchestratorAgent` with AlertScorer + TopicRouter as tool definitions

---

## Consequences

### Positive

- Self-learning loop restored immediately (Wave 1, 1-line fix)
- System initiates pre-meeting briefs, alert scoring, and cross-topic correlation without user prompting
- Sprint config becomes runtime-configurable — no more code changes for new sprints
- SSE replaces polling — lower latency, lower server load
- Cost is bounded: Haiku for always-on (~$0.001/event), Sonnet only for event-triggered briefs (~$0.01–0.02/event)

### Negative / Risks

- Wave 3 (OrchestratorAgent) was built without Managed Sessions — if SDK adds the API, a migration will be needed to get persistent thread history
- `ChangeWatcher` 100ms SQLite poll adds constant low-level DB load — acceptable with WAL mode, monitor if DB grows past 500MB
- `proactive_queue` can fill if the bridge is down — 24h eviction policy on drain tick prevents unbounded growth

### Neutral

- Existing request/response tools remain unchanged — agents are additive
- Palace integration (EP-58/59/60) is unaffected

---

## Alternatives Considered

### Keep 15-min polling, add more alert rules

Rejected. Pure-SQL alert rules (`generateAlerts()` GAP-P1) cannot learn from investigations or weigh context. Fixing the symptom without fixing the architecture.

### n8n external scheduler

Rejected. Already rejected in EP-16. Adds external dependency and operational overhead for what is now achievable in-process.

### Full real-time SQLite CDC via `sqlite-diff`

Deferred. 100ms polling of `changes_log` provides near-real-time with no native module dependency. Revisit if latency becomes a problem.

---

## Known Gaps

These gaps were identified at ship time and carried to v1.1:

- **CDC events 2/3 unsubscribed** — Only `new-message` has a handler. `jira-update` and `calendar-change` events are emitted by `ChangeWatcher` but no agent subscribes to them. Tracked for EP-66+.
- **TopicRouterAgent not implemented** — mentioned in the Agent Topology but deprioritized; events go directly to AlertScorer. Tracked for EP-66+.
- **LearningAgent inlined** — learning happens inside investigation conclude handler (`recordConcludeSignals`), not as a separate agent process. Acceptable for now; promote to agent when volume warrants.

---

## Implementation Status

All five epics shipped 2026-05-03 as part of Sprint 17.

| Wave | Epics | Status | Shipped |
|------|-------|--------|---------|
| Wave 1 — Quick Wins | EP-61, EP-62 | ✅ Complete | 2026-05-03 |
| Wave 2 — CDC Pipeline | EP-63 | ✅ Complete | 2026-05-03 |
| Wave 3 — Agent Sessions | EP-64, EP-65 | ✅ Complete | 2026-05-03 |

### EP-61 — What was built

- **Schema v38** — `proactive_queue` table with partial index `(read_at, id) WHERE read_at IS NULL` for O(unread) drain performance
- **`GET /api/events`** — SSE drain endpoint: 2s drain tick (LIMIT 20/tick), 30s keep-alive, timer-leak protection per browser tab
- **`MeetingPrepAgent`** — 5-minute poll, 50–70 min window, 90-min dedup guard, Haiku model via `generatePreBrief` optional 6th param
- **Frontend** — `ChatPanel.tsx` opens `EventSource` on mount, `ChatMessage.tsx` renders "Proactive" badge for `isProactive` messages

**Deviation:** The `proactive_queue` schema shipped with `read_at` column instead of the `status` enum originally specced — drain marks rows read by setting `read_at` rather than transitioning `status` through `pending→sent`. Simpler and avoids a state machine for one-shot delivery. `source_id` and `type` columns were also added (dedup + event routing).

### EP-62 — What was built

- **Schema v39** — `sprint_config` DB table replaces hardcoded sprint name + date range
- **`GET /api/config/sprint`** + **`PUT /api/config/sprint`** — runtime sprint configuration endpoints
- **`proactive_queue` 24h eviction** — DELETE on drain tick before SELECT
- **`embeddingsAvailable: boolean`** field added to `GET /api/status`

### EP-63 — What was built

- **Schema v40** — `changes_log` table + 4 SQLite AFTER INSERT/UPDATE triggers on `messages`, `jira_issues`, `calendar_events`
- **`ChangeWatcher`** (`src/services/change-watcher.ts`) — 100ms poll, typed event dispatch (`new-message`, `jira-update`, `calendar-change`), pause/resume support
- **`AlertScorerAgent`** (Haiku) — subscribes to `new-message` events, scores severity (low/medium/high), writes medium/high to `proactive_queue`

### EP-64 — What was built

- **`OrchestratorAgent`** — persistent in-memory agent with tool_use dispatch loop (AlertScorer + TopicRouter as tool definitions)
- **Sub-agent dispatch** — EventEmitter subscription to ChangeWatcher, processes events on demand

**Deviation:** Anthropic SDK v0.32.1 does not expose a Managed Agent Sessions API. Architectural intent (agent topology, sub-agent dispatch, cold-start elimination) was achieved via standard `tool_use` loops with agents declared as tool definitions at class level. See Wave 3 in Decision section.

### EP-65 — What was built

- **`CorrelationAgent`** — nightly KG traversal, cross-topic co-mention scoring, proactive digest generation
- **Digest output** — written to `proactive_queue` for SSE delivery with `{title, body, pairs, generated_at}` payload shape
