---
id: ep61-quick-wins-wave1a
title: EP-61 — Quick Wins Wave 1a (Event-Driven Agents)
---

# EP-61 — Quick Wins Wave 1a (Event-Driven Agents)

| Field | Value |
|-------|-------|
| Sprint | Sprint 17 |
| Status | ✅ Done (2026-05-03) |
| ADR | [ADR-017](../adr/adr-017-always-on-agent-architecture) |
| Schema | v38 (`proactive_queue` table + partial index) |
| Depends On | EP-60 ✅ |
| Effort | 1 wave |

## Problem

The system was entirely request-driven — users had to open the UI and ask questions to get value. No background processing surfaced insights proactively. Pre-meeting context (EP-51) existed but required manual triggering.

## Solution

Introduce an event-driven agent layer: a `proactive_queue` table, SSE endpoint for real-time delivery, and a MeetingPrepAgent that autonomously generates pre-meeting briefs.

## Success Criteria

- [x] `proactive_queue` table created with partial index on unread rows
- [x] `GET /api/events` SSE endpoint streams unread items to browser
- [x] MeetingPrepAgent generates briefs T-60min before meetings
- [x] 90-minute dedup guard prevents duplicate briefs
- [x] Frontend `EventSource` subscription in ChatPanel
- [x] Proactive badge rendered on agent-initiated messages
- [x] SSE cleanup: intervals cleared on connection close (no timer leaks)
- [x] Agent errors caught and logged, never crash the server

## Delivery Notes

**Completed**: Sprint 17 (2026-05-03)

### Key Implementations

| File | What was delivered |
|------|-------------------|
| `src/db/schema.ts` | Schema v38 — `proactive_queue` table with partial index `(read_at, id) WHERE read_at IS NULL` and covering index `(agent, source_id, created_at)` for dedup. |
| `web-server.js` | `GET /api/events` SSE drain endpoint. 2s poll interval drains unread rows as JSON events. Keep-alive comments prevent proxy timeouts. Both intervals cleared on `req.on('close')`. |
| `web-server.js` | MeetingPrepAgent — 5-min `setInterval` querying `calendar_events` for T-50 to T-70min meetings. Calls `generatePreBrief` with `claude-haiku-latest`. 90-min dedup guard. Fire-and-forget error handling. |
| `web/src/components/shell/ChatPanel.tsx` | `EventSource('/api/events')` on mount, close on unmount. Events injected as assistant messages with `isProactive: true`. |
| `web/src/components/shell/ChatMessage.tsx` | "Proactive" badge (accent color) before message body when `isProactive` is set. |

### Design Decisions

1. **Haiku for always-on processing** — ~$0.001/event cost constraint
2. **SSE over WebSocket** — simpler, no library needed, sufficient for low-frequency push
3. **Fire-and-forget agents** — errors logged, never propagated to server
4. **90-min dedup window** — prevents re-briefing if meeting time shifts slightly
